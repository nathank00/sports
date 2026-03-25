"""Main async orchestrator loop.

Polls live game data, runs the win probability model on state changes,
evaluates trading signals, and writes results to autopilot_signals.

Does NOT execute trades — that's handled by the web frontend.
"""

import asyncio
import logging
import time
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

import aiohttp

from autopilot.src.model.winprob import WinProbModel
from autopilot.src.loop.game_tracker import TrackedGame
from autopilot.src.features.constants import REGULATION_SECONDS
from autopilot.src.trading.decision import (
    TradingConfig,
    evaluate_signal,
    ABBR_TO_TEAM,
)
from autopilot.src.ingest.espn_live import (
    fetch_live_scoreboard,
    fetch_live_game_detail,
)
from autopilot.src.ingest.nba_api_live import (
    fetch_cdn_scoreboard,
    fetch_cdn_boxscore,
)
from autopilot.src.db import supabase, write_log, fetch_active_users

logger = logging.getLogger(__name__)

# How often to poll (seconds)
POLL_INTERVAL = 3.0

# How often to refresh Kalshi market prices (seconds)
KALSHI_REFRESH_INTERVAL = 15.0

# Stop running if no active games for this long (seconds)
NO_GAMES_TIMEOUT = 900  # 15 minutes

# Minimum time between signals for the same game (seconds)
SIGNAL_COOLDOWN = 15.0

# How often to write heartbeat to Supabase (seconds)
HEARTBEAT_INTERVAL = 30.0


class Orchestrator:
    """Main live loop. Manages all active games concurrently."""

    def __init__(
        self,
        model: WinProbModel,
        config: TradingConfig | None = None,
    ):
        self.model = model
        self.config = config or TradingConfig()
        self.games: dict[str, TrackedGame] = {}  # espn_game_id -> TrackedGame
        self.running = False
        self.last_active_time = time.monotonic()
        self.last_heartbeat_time = 0.0

    async def run(self) -> None:
        """Main loop. Runs until stopped or no games are active."""
        self.running = True
        logger.info("Autopilot orchestrator starting...")
        logger.info(f"  Model: {self.model.version}")
        logger.info(f"  Friction: {self.config.friction_cents}c per contract")

        async with aiohttp.ClientSession() as session:
            while self.running:
                try:
                    had_active = await self._tick(session)
                    if had_active:
                        self.last_active_time = time.monotonic()
                except Exception as e:
                    logger.error(f"Tick error: {e}", exc_info=True)

                # Write heartbeat (throttled to ~30s intervals)
                self._maybe_write_heartbeat()

                # Check no-games timeout
                idle_time = time.monotonic() - self.last_active_time
                if idle_time > NO_GAMES_TIMEOUT:
                    logger.info(
                        f"No active games for {idle_time:.0f}s — shutting down"
                    )
                    break

                await asyncio.sleep(POLL_INTERVAL)

        logger.info("Autopilot orchestrator stopped")

    async def _tick(self, session: aiohttp.ClientSession) -> bool:
        """Single iteration of the loop.

        Returns True if there are active (in-progress) games.
        """
        # 1. Fetch scoreboard
        scoreboard = await fetch_live_scoreboard(session)

        if not scoreboard:
            # Fallback to cdn.nba.com
            cdn_games = await fetch_cdn_scoreboard(session)
            scoreboard = _convert_cdn_to_espn_format(cdn_games)

        # Filter to in-progress games
        active = [g for g in scoreboard if g.get("status") == "in"]

        if not active:
            return False

        # 2. Process each active game
        tasks = [self._process_game(session, game) for game in active]
        await asyncio.gather(*tasks, return_exceptions=True)

        # 4. Remove finished games
        active_ids = {g["espn_game_id"] for g in active}
        finished = [gid for gid in self.games if gid not in active_ids]
        for gid in finished:
            logger.info(f"Game {gid} finished — removing from tracker")
            del self.games[gid]

        return True

    async def _process_game(
        self,
        session: aiohttp.ClientSession,
        scoreboard_game: dict,
    ) -> None:
        """Process a single game: fetch detail, infer, signal."""
        espn_id = scoreboard_game["espn_game_id"]
        home_team = scoreboard_game["home_team"]
        away_team = scoreboard_game["away_team"]

        # Initialize tracker for new games
        if espn_id not in self.games:
            self.games[espn_id] = TrackedGame(
                nba_game_id="",  # will be filled if we can map it
                espn_game_id=espn_id,
                home_team=home_team,
                away_team=away_team,
            )
            logger.info(f"New game: {away_team} @ {home_team} (ESPN ID: {espn_id})")

        tracker = self.games[espn_id]

        # Fetch game detail (includes pregame odds from ESPN pickcenter)
        detail = await fetch_live_game_detail(session, espn_id)
        if not detail:
            # Use scoreboard data as fallback
            detail = _scoreboard_to_detail(scoreboard_game)

        # Extract pregame odds from ESPN (once per game, free)
        if not tracker.pregame_odds_fetched:
            tracker.pregame_spread = detail.get("pregame_spread")
            tracker.pregame_home_ml_prob = detail.get("pregame_home_ml_prob")
            tracker.pregame_odds_fetched = True
            logger.info(
                f"  Pregame odds for {away_team}@{home_team}: "
                f"spread={tracker.pregame_spread}, ml_prob={tracker.pregame_home_ml_prob}"
            )

        home_score = detail["home_score"]
        away_score = detail["away_score"]
        period = detail["period"]
        seconds_remaining = detail.get("seconds_remaining", 0)
        possession_home = None

        poss_team = detail.get("possession_team")
        if poss_team == home_team:
            possession_home = True
        elif poss_team == away_team:
            possession_home = False

        # Check for state change
        if not tracker.has_state_changed(
            home_score, away_score, period, seconds_remaining, possession_home
        ):
            return  # No meaningful change — skip this tick

        # Update tracker state
        tracker.update_state(
            home_score=home_score,
            away_score=away_score,
            period=period,
            seconds_remaining=seconds_remaining,
            possession_home=possession_home,
            home_stats=detail.get("home_stats"),
            away_stats=detail.get("away_stats"),
            home_timeouts=detail.get("home_timeouts"),
            away_timeouts=detail.get("away_timeouts"),
            home_fouls=detail.get("home_stats", {}).get("pf"),
            away_fouls=detail.get("away_stats", {}).get("pf"),
        )

        now = time.monotonic()

        # Refresh Kalshi markets if stale (needed by signal evaluation)
        if now - tracker.kalshi_markets_updated > KALSHI_REFRESH_INTERVAL:
            tracker.kalshi_markets = await self._fetch_kalshi_markets(session)
            tracker.kalshi_markets_updated = now

        # Enforce signal cooldown
        if now - tracker.last_signal_time < SIGNAL_COOLDOWN:
            return

        # Run model
        game_state = tracker.build_game_state()
        model_prob = self.model.predict(game_state)

        # Apply smoothing + pregame blending
        time_fraction = game_state.seconds_remaining / REGULATION_SECONDS
        blended_prob = tracker.blender.update(
            raw_model_prob=model_prob,
            pregame_home_ml_prob=tracker.pregame_home_ml_prob,
            time_fraction=time_fraction,
        )
        tracker.last_raw_model_prob = model_prob
        tracker.last_blended_prob = blended_prob

        # Evaluate signal
        home_full = ABBR_TO_TEAM.get(home_team, home_team)
        away_full = ABBR_TO_TEAM.get(away_team, away_team)

        signal = evaluate_signal(
            model_home_prob=blended_prob,
            home_team=home_full,
            away_team=away_full,
            seconds_remaining=seconds_remaining,
            period=period,
            markets=tracker.kalshi_markets,
            config=self.config,
            home_score=home_score,
            away_score=away_score,
        )

        # Write signal to database
        await self._write_signal(
            tracker=tracker,
            model_prob=model_prob,
            blended_prob=blended_prob,
            signal=signal,
            period=period,
            seconds_remaining=seconds_remaining,
            home_score=home_score,
            away_score=away_score,
        )

        tracker.last_signal_time = now

        # Log
        action = signal.recommended_action
        edge = signal.edge_vs_kalshi
        edge_str = f"{edge:+.1f}%" if edge else "N/A"
        reason_str = f" ({signal.reason})" if action == "NO_TRADE" else ""
        logger.info(
            f"  {away_team} {away_score} @ {home_team} {home_score} "
            f"Q{period} {seconds_remaining:.0f}s | "
            f"P(home) raw={model_prob:.1%} blended={blended_prob:.1%} | "
            f"edge={edge_str} | {action}{reason_str}"
        )

        # Write BLOCKED log for NO_TRADE signals with a block reason (no-trade window, blowout)
        game_label = f"{away_team}@{home_team}"
        if (
            signal.recommended_action == "NO_TRADE"
            and getattr(signal, "reason_code", None)
            and signal.reason_code.startswith("BLOCKED_")
        ):
            active_users = fetch_active_users()
            for user_row in active_users:
                try:
                    write_log(
                        user_id=user_row["user_id"],
                        level="BLOCKED",
                        message=f"{game_label}: {signal.reason}",
                        metadata={"reason_code": signal.reason_code},
                    )
                except Exception:
                    pass

    async def _fetch_kalshi_markets(self, session: aiohttp.ClientSession) -> list[dict]:
        """Fetch open NBA markets from Kalshi.

        Uses the public markets endpoint (no auth needed for market data).
        """
        url = "https://api.elections.kalshi.com/trade-api/v2/markets"
        params = {
            "series_ticker": "KXNBAGAME",
            "status": "open",
            "limit": "200",
        }

        try:
            async with session.get(
                url, params=params, timeout=aiohttp.ClientTimeout(total=10)
            ) as resp:
                if resp.status != 200:
                    logger.warning(f"Kalshi markets returned {resp.status}")
                    return []
                data = await resp.json()
                return data.get("markets", [])
        except Exception as e:
            logger.warning(f"Kalshi markets fetch failed: {e}")
            return []

    async def _write_signal(
        self,
        tracker: TrackedGame,
        model_prob: float,
        blended_prob: float,
        signal,
        period: int,
        seconds_remaining: float,
        home_score: int,
        away_score: int,
    ) -> None:
        """Write a signal row to autopilot_signals."""
        record = {
            "game_id": tracker.espn_game_id or tracker.nba_game_id,
            "home_team": tracker.home_team,
            "away_team": tracker.away_team,
            "period": period,
            "seconds_remaining": round(seconds_remaining, 1),
            "home_score": home_score,
            "away_score": away_score,
            "model_home_win_prob": round(model_prob, 4),
            "blended_home_win_prob": round(blended_prob, 4),
            "kalshi_ticker_home": getattr(signal, "kalshi_ticker_home", None),
            "kalshi_ticker_away": getattr(signal, "kalshi_ticker_away", None),
            "kalshi_home_price": signal.kalshi_home_price,
            "kalshi_away_price": signal.kalshi_away_price,
            "pregame_spread": tracker.pregame_spread,
            "pregame_home_ml_prob": tracker.pregame_home_ml_prob,
            "edge_vs_kalshi": round(signal.edge_vs_kalshi, 2) if signal.edge_vs_kalshi else None,
            "recommended_action": signal.recommended_action,
            "recommended_side": signal.recommended_side,
            "recommended_ticker": signal.recommended_ticker,
            "reason": signal.reason,
            "reason_code": getattr(signal, "reason_code", None),
        }

        try:
            supabase.table("autopilot_signals").insert(record).execute()
        except Exception as e:
            logger.error(f"Failed to write signal: {e}")

    def _maybe_write_heartbeat(self) -> None:
        """Write heartbeat to Supabase, throttled to ~30s intervals."""
        now = time.monotonic()
        if now - self.last_heartbeat_time < HEARTBEAT_INTERVAL:
            return

        try:
            supabase.table("autopilot_heartbeat").upsert(
                {"id": 1, "last_heartbeat": datetime.now(timezone.utc).isoformat()},
                on_conflict="id",
            ).execute()
            self.last_heartbeat_time = now
        except Exception as e:
            logger.warning(f"Heartbeat write failed: {e}")

    def stop(self) -> None:
        """Signal the loop to stop."""
        self.running = False


def _scoreboard_to_detail(scoreboard_game: dict) -> dict:
    """Convert scoreboard data to game detail format when detail fetch fails."""
    clock = scoreboard_game.get("clock", "0:00")
    period = scoreboard_game.get("period", 0)

    # Parse clock to seconds remaining
    try:
        parts = clock.split(":")
        minutes = int(parts[0])
        seconds = int(float(parts[1])) if len(parts) > 1 else 0
        clock_seconds = minutes * 60 + seconds
    except (ValueError, IndexError):
        clock_seconds = 0

    if period <= 4:
        seconds_remaining = (4 - period) * 720 + clock_seconds
    else:
        seconds_remaining = clock_seconds

    return {
        "home_team": scoreboard_game["home_team"],
        "away_team": scoreboard_game["away_team"],
        "home_score": scoreboard_game["home_score"],
        "away_score": scoreboard_game["away_score"],
        "period": period,
        "clock": clock,
        "seconds_remaining": seconds_remaining,
        "possession_team": scoreboard_game.get("possession_team"),
        "home_stats": None,
        "away_stats": None,
        "home_timeouts": None,
        "away_timeouts": None,
    }


def _convert_cdn_to_espn_format(cdn_games: list[dict]) -> list[dict]:
    """Convert cdn.nba.com scoreboard format to ESPN format for uniform processing."""
    result = []
    for g in cdn_games:
        status = "pre"
        if g.get("status") == 2:
            status = "in"
        elif g.get("status") == 3:
            status = "post"

        result.append({
            "espn_game_id": g.get("nba_game_id", ""),
            "status": status,
            "home_team": g["home_team"],
            "away_team": g["away_team"],
            "home_score": g["home_score"],
            "away_score": g["away_score"],
            "period": g.get("period", 0),
            "clock": g.get("clock", "0:00"),
            "possession_team": None,
        })

    return result
