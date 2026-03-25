"""Main async orchestrator loop for MLB autopilot.

Polls live MLB game data, runs the win probability model on state changes,
evaluates trading signals, and writes results to autopilot_signals.

Does NOT execute trades — that's handled by the web frontend.
"""

import asyncio
import logging
import time
from datetime import datetime, timezone

import aiohttp

from autopilot.src.model.mlb_winprob import MLBWinProbModel
from autopilot.src.loop.mlb_game_tracker import MLBTrackedGame
from autopilot.src.features.mlb_constants import MLB_TOTAL_REGULATION_OUTS
from autopilot.src.trading.mlb_decision import (
    MLBTradingConfig,
    mlb_evaluate_signal,
    MLB_ABBR_TO_TEAM,
)
from autopilot.src.ingest.espn_mlb_live import (
    fetch_mlb_live_scoreboard,
    fetch_mlb_live_game_detail,
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

# Heartbeat row ID for MLB (NBA uses id=1)
MLB_HEARTBEAT_ID = 2


class MLBOrchestrator:
    """Main live loop for MLB. Manages all active games concurrently."""

    def __init__(
        self,
        model: MLBWinProbModel,
        config: MLBTradingConfig | None = None,
    ):
        self.model = model
        self.config = config or MLBTradingConfig()
        self.games: dict[str, MLBTrackedGame] = {}  # espn_game_id -> MLBTrackedGame
        self.running = False
        self.last_active_time = time.monotonic()
        self.last_heartbeat_time = 0.0

    async def run(self) -> None:
        """Main loop. Runs until stopped or no games are active."""
        self.running = True
        logger.info("MLB Autopilot orchestrator starting...")
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
                        f"No active MLB games for {idle_time:.0f}s — shutting down"
                    )
                    break

                await asyncio.sleep(POLL_INTERVAL)

        logger.info("MLB Autopilot orchestrator stopped")

    async def _tick(self, session: aiohttp.ClientSession) -> bool:
        """Single iteration of the loop.

        Returns True if there are active (in-progress) games.
        """
        # 1. Fetch scoreboard
        scoreboard = await fetch_mlb_live_scoreboard(session)

        if not scoreboard:
            return False

        # Filter to in-progress games
        active = [g for g in scoreboard if g.get("status") == "in"]

        if not active:
            return False

        # 2. Process each active game
        tasks = [self._process_game(session, game) for game in active]
        await asyncio.gather(*tasks, return_exceptions=True)

        # 3. Remove finished games
        active_ids = {g["espn_game_id"] for g in active}
        finished = [gid for gid in self.games if gid not in active_ids]
        for gid in finished:
            logger.info(f"MLB game {gid} finished — removing from tracker")
            del self.games[gid]

        return True

    async def _process_game(
        self,
        session: aiohttp.ClientSession,
        scoreboard_game: dict,
    ) -> None:
        """Process a single MLB game: fetch detail, infer, signal."""
        espn_id = scoreboard_game["espn_game_id"]
        home_team = scoreboard_game["home_team"]
        away_team = scoreboard_game["away_team"]

        # Initialize tracker for new games
        if espn_id not in self.games:
            self.games[espn_id] = MLBTrackedGame(
                espn_game_id=espn_id,
                home_team=home_team,
                away_team=away_team,
            )
            logger.info(f"New MLB game: {away_team} @ {home_team} (ESPN ID: {espn_id})")

        tracker = self.games[espn_id]

        # Fetch game detail (includes pregame odds from ESPN pickcenter)
        detail = await fetch_mlb_live_game_detail(session, espn_id)
        if not detail:
            # Use scoreboard data as fallback
            detail = _scoreboard_to_detail(scoreboard_game)

        # Extract pregame odds from ESPN (once per game)
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
        inning = detail["inning"]
        inning_half = detail.get("inning_half", "top")
        outs = detail.get("outs", 0)
        runners = detail.get("runners_on_base", 0)

        # Check for state change
        if not tracker.has_state_changed(
            home_score, away_score, inning, inning_half, outs
        ):
            return  # No meaningful change — skip this tick

        # Update tracker state
        tracker.update_state(
            home_score=home_score,
            away_score=away_score,
            inning=inning,
            inning_half=inning_half,
            outs=outs,
            runners=runners,
            home_hits=detail.get("home_hits"),
            away_hits=detail.get("away_hits"),
            home_errors=detail.get("home_errors"),
            away_errors=detail.get("away_errors"),
        )

        now = time.monotonic()

        # Refresh Kalshi markets if stale
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
        outs_remaining = tracker.get_outs_remaining()
        outs_fraction = 1.0 - (outs_remaining / MLB_TOTAL_REGULATION_OUTS)
        time_fraction = max(0.0, 1.0 - outs_fraction)  # for blender compatibility

        blended_prob = tracker.blender.update(
            raw_model_prob=model_prob,
            pregame_home_ml_prob=tracker.pregame_home_ml_prob,
            time_fraction=time_fraction,
        )
        tracker.last_raw_model_prob = model_prob
        tracker.last_blended_prob = blended_prob

        # Evaluate signal
        home_full = MLB_ABBR_TO_TEAM.get(home_team, home_team)
        away_full = MLB_ABBR_TO_TEAM.get(away_team, away_team)

        signal = mlb_evaluate_signal(
            model_home_prob=blended_prob,
            home_team=home_full,
            away_team=away_full,
            outs_remaining=outs_remaining,
            inning=inning,
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
            inning=inning,
            inning_half=inning_half,
            outs=outs,
            outs_remaining=outs_remaining,
            home_score=home_score,
            away_score=away_score,
        )

        tracker.last_signal_time = now

        # Log
        action = signal.recommended_action
        edge = signal.edge_vs_kalshi
        edge_str = f"{edge:+.1f}%" if edge else "N/A"
        reason_str = f" ({signal.reason})" if action == "NO_TRADE" else ""
        half_label = "T" if inning_half == "top" else "B"
        logger.info(
            f"  {away_team} {away_score} @ {home_team} {home_score} "
            f"{half_label}{inning} {outs}out | "
            f"P(home) raw={model_prob:.1%} blended={blended_prob:.1%} | "
            f"edge={edge_str} | {action}{reason_str}"
        )

        # Write BLOCKED log for NO_TRADE signals with a block reason
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
        """Fetch open MLB markets from Kalshi."""
        url = "https://api.elections.kalshi.com/trade-api/v2/markets"
        params = {
            "series_ticker": "KXMLBGAME",
            "status": "open",
            "limit": "200",
        }

        try:
            async with session.get(
                url, params=params, timeout=aiohttp.ClientTimeout(total=10)
            ) as resp:
                if resp.status != 200:
                    logger.warning(f"Kalshi MLB markets returned {resp.status}")
                    return []
                data = await resp.json()
                return data.get("markets", [])
        except Exception as e:
            logger.warning(f"Kalshi MLB markets fetch failed: {e}")
            return []

    async def _write_signal(
        self,
        tracker: MLBTrackedGame,
        model_prob: float,
        blended_prob: float,
        signal,
        inning: int,
        inning_half: str,
        outs: int,
        outs_remaining: int,
        home_score: int,
        away_score: int,
    ) -> None:
        """Write a signal row to autopilot_signals."""
        record = {
            "game_id": tracker.espn_game_id,
            "home_team": tracker.home_team,
            "away_team": tracker.away_team,
            "period": inning,
            "seconds_remaining": float(outs_remaining),  # repurpose: outs remaining
            "home_score": home_score,
            "away_score": away_score,
            "model_home_win_prob": round(model_prob, 4),
            "blended_home_win_prob": round(blended_prob, 4),
            "kalshi_ticker_home": None,
            "kalshi_ticker_away": None,
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
            "sport": "mlb",
            "inning_half": inning_half,
            "outs_in_inning": outs,
        }

        try:
            supabase.table("autopilot_signals").insert(record).execute()
        except Exception as e:
            logger.error(f"Failed to write MLB signal: {e}")

    def _maybe_write_heartbeat(self) -> None:
        """Write heartbeat to Supabase, throttled to ~30s intervals."""
        now = time.monotonic()
        if now - self.last_heartbeat_time < HEARTBEAT_INTERVAL:
            return

        try:
            supabase.table("autopilot_heartbeat").upsert(
                {"id": MLB_HEARTBEAT_ID, "last_heartbeat": datetime.now(timezone.utc).isoformat()},
                on_conflict="id",
            ).execute()
            self.last_heartbeat_time = now
        except Exception as e:
            logger.warning(f"MLB heartbeat write failed: {e}")

    def stop(self) -> None:
        """Signal the loop to stop."""
        self.running = False


def _scoreboard_to_detail(scoreboard_game: dict) -> dict:
    """Convert scoreboard data to game detail format when detail fetch fails."""
    return {
        "home_team": scoreboard_game["home_team"],
        "away_team": scoreboard_game["away_team"],
        "home_score": scoreboard_game["home_score"],
        "away_score": scoreboard_game["away_score"],
        "inning": scoreboard_game.get("inning", 0),
        "inning_half": scoreboard_game.get("inning_half", "top"),
        "outs": scoreboard_game.get("outs", 0),
        "runners_on_base": 0,
        "home_hits": 0,
        "away_hits": 0,
        "home_errors": 0,
        "away_errors": 0,
    }
