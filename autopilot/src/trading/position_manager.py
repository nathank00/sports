"""Position Manager — per-user position state management.

Evaluates trade intents for each active user on every signal cycle.
Enforces one-position-per-game, entry guards, edge persistence,
and cooldown logic. Writes PENDING_ENTRY state to Supabase for the
frontend to execute.

Does NOT execute trades — the frontend handles that with browser-stored
Kalshi keys.
"""

import logging
import math
from datetime import datetime, timezone, timedelta
from dataclasses import dataclass

from autopilot.src.db import (
    fetch_active_users,
    fetch_position,
    upsert_position,
    fetch_stale_pending_intents,
    write_log,
)
from autopilot.src.trading.decision import TradeSignal

logger = logging.getLogger(__name__)

# Number of consecutive cycles edge must persist before entry
EDGE_PERSISTENCE_REQUIRED = 2


@dataclass
class UserSettings:
    """Parsed user settings from autopilot_settings row."""

    user_id: str
    edge_threshold: float
    take_profit: float
    stop_loss: float
    sizing_mode: str  # "dollars" or "contracts"
    bet_amount: float
    cooldown_seconds: int
    max_contracts_per_bet: int
    max_exposure_per_game: float

    @classmethod
    def from_row(cls, row: dict) -> "UserSettings":
        return cls(
            user_id=row["user_id"],
            edge_threshold=row.get("edge_threshold", 8.0),
            take_profit=row.get("take_profit", 0.08),
            stop_loss=row.get("stop_loss", 0.05),
            sizing_mode=row.get("sizing_mode", "dollars"),
            bet_amount=row.get("bet_amount", 10),
            cooldown_seconds=row.get("cooldown_seconds", 60),
            max_contracts_per_bet=row.get("max_contracts_per_bet", 20),
            max_exposure_per_game=row.get("max_exposure_per_game", 50),
        )


class PositionManager:
    """Per-user position management.

    Called by the orchestrator for each active user on each signal.
    Manages the lifecycle: FLAT -> PENDING_ENTRY (backend writes).
    Frontend handles: PENDING_ENTRY -> LONG_* -> EXITING -> LOCKED.
    """

    def __init__(self):
        # In-memory edge persistence tracking: {game_id: [recent_edge_values]}
        # Per game (not per user) since the edge is the same for all users
        self.edge_history: dict[str, list[float]] = {}

        # Cache active users per tick to avoid repeated DB queries
        self._cached_users: list[dict] | None = None

    def get_active_users(self) -> list[dict]:
        """Fetch and cache active users for this tick."""
        if self._cached_users is None:
            self._cached_users = fetch_active_users()
        return self._cached_users

    def clear_user_cache(self) -> None:
        """Clear user cache at the start of each tick."""
        self._cached_users = None

    def process_signal(
        self,
        user_settings: UserSettings,
        signal: TradeSignal,
        game_id: str,
        event_id: str,
        home_team: str,
        away_team: str,
        period: int,
        seconds_remaining: float,
        home_score: int,
        away_score: int,
    ) -> None:
        """Evaluate whether to create a PENDING_ENTRY for this user+game.

        Steps:
        1. Fetch current position for (user_id, event_id)
        2. Create FLAT row if none exists
        3. If state != FLAT → skip (log BLOCKED)
        4. Check cooldown_until
        5. Check entry guards (last 3 min Q4/OT, blowout)
        6. Check edge >= user's threshold
        7. Check edge persistence (2+ consecutive cycles)
        8. All pass → set state = PENDING_ENTRY with intent fields
        """
        user_id = user_settings.user_id

        # Skip NO_TRADE signals entirely (no logging needed)
        if signal.recommended_action == "NO_TRADE":
            return

        edge = signal.edge_vs_kalshi
        if edge is None:
            return

        # 1. Fetch current position
        position = fetch_position(user_id, event_id)

        # 2. Create FLAT row if none exists
        if position is None:
            upsert_position(user_id, event_id, {
                "game_id": game_id,
                "state": "FLAT",
                "side": None,
                "ticker": None,
                "home_team": home_team,
                "away_team": away_team,
            })
            position = {"state": "FLAT", "cooldown_until": None}

        # 3. If state != FLAT → skip (but unlock LOCKED positions with expired cooldowns)
        state = position.get("state", "FLAT")
        if state == "LOCKED":
            cooldown_until_val = position.get("cooldown_until")
            cooldown_expired = True
            if cooldown_until_val:
                try:
                    cooldown_dt = datetime.fromisoformat(cooldown_until_val)
                    cooldown_expired = datetime.now(timezone.utc) >= cooldown_dt
                except (ValueError, TypeError):
                    pass
            if cooldown_expired:
                upsert_position(user_id, event_id, {
                    "game_id": game_id,
                    "state": "FLAT",
                    "side": None,
                    "ticker": None,
                    "home_team": home_team,
                    "away_team": away_team,
                    "entry_price": None,
                    "quantity": None,
                    "entry_timestamp": None,
                    "exit_price": None,
                    "exit_timestamp": None,
                    "realized_pnl": None,
                    "cooldown_until": None,
                    "intent_price": None,
                    "intent_contracts": None,
                    "intent_side": None,
                    "intent_created_at": None,
                })
                state = "FLAT"
                position = {"state": "FLAT", "cooldown_until": None}
                logger.info(f"  Reset LOCKED position to FLAT for user {user_id[:8]}... on {event_id}")

        if state != "FLAT":
            write_log(
                user_id=user_id,
                level="BLOCKED",
                message=f"Position exists ({state}) — signal ignored",
                event_id=event_id,
            )
            return

        # 4. Check cooldown
        cooldown_until = position.get("cooldown_until")
        if cooldown_until:
            try:
                cooldown_dt = datetime.fromisoformat(cooldown_until)
                if datetime.now(timezone.utc) < cooldown_dt:
                    remaining = (cooldown_dt - datetime.now(timezone.utc)).seconds
                    write_log(
                        user_id=user_id,
                        level="BLOCKED",
                        message=f"Cooldown active ({remaining}s remaining)",
                        event_id=event_id,
                    )
                    return
            except (ValueError, TypeError):
                pass

        # 5. Check entry guards
        block_reason = self._check_entry_guards(
            period, seconds_remaining, home_score, away_score
        )
        if block_reason:
            write_log(
                user_id=user_id,
                level="BLOCKED",
                message=block_reason,
                event_id=event_id,
            )
            return

        # 6. Check edge >= user's threshold
        if edge < user_settings.edge_threshold:
            # Don't log this — it's the normal case and would be noisy
            return

        # 7. Check edge persistence
        if not self._check_edge_persistence(game_id, edge, user_settings.edge_threshold):
            write_log(
                user_id=user_id,
                level="INFO",
                message=f"Edge {edge:.1f}% detected but not yet persistent "
                        f"({len(self.edge_history.get(game_id, []))}/"
                        f"{EDGE_PERSISTENCE_REQUIRED} cycles)",
                event_id=event_id,
            )
            return

        # 8. All pass → compute contract count and create PENDING_ENTRY
        intent_price = self._get_intent_price(signal)
        if not intent_price or intent_price <= 0 or intent_price >= 1:
            return

        contracts = self._compute_contracts(user_settings, intent_price)
        side = "HOME" if signal.recommended_action == "BUY_HOME" else "AWAY"
        now = datetime.now(timezone.utc).isoformat()

        upsert_position(user_id, event_id, {
            "game_id": game_id,
            "state": "PENDING_ENTRY",
            "side": side,
            "ticker": signal.recommended_ticker,
            "home_team": home_team,
            "away_team": away_team,
            "intent_price": round(intent_price, 4),
            "intent_contracts": contracts,
            "intent_side": "yes",
            "intent_created_at": now,
        })

        write_log(
            user_id=user_id,
            level="TRADE",
            message=(
                f"ENTRY INTENT: {signal.recommended_action} "
                f"{signal.recommended_ticker} x{contracts} @ "
                f"{intent_price * 100:.0f}c (edge={edge:.1f}%)"
            ),
            event_id=event_id,
            metadata={
                "action": signal.recommended_action,
                "ticker": signal.recommended_ticker,
                "contracts": contracts,
                "price": intent_price,
                "edge": edge,
            },
        )

        logger.info(
            f"  PENDING_ENTRY for user {user_id[:8]}...: "
            f"{signal.recommended_action} x{contracts} @ {intent_price * 100:.0f}c "
            f"(edge={edge:.1f}%)"
        )

    def expire_stale_intents(self) -> None:
        """Find PENDING_ENTRY positions older than 35 seconds and reset to FLAT.

        Called once per tick (not per user).
        """
        stale = fetch_stale_pending_intents(max_age_seconds=35)
        for pos in stale:
            user_id = pos["user_id"]
            event_id = pos["event_id"]

            upsert_position(user_id, event_id, {
                "game_id": pos["game_id"],
                "state": "FLAT",
                "side": None,
                "ticker": None,
                "home_team": pos["home_team"],
                "away_team": pos["away_team"],
                "intent_price": None,
                "intent_contracts": None,
                "intent_side": None,
                "intent_created_at": None,
            })

            write_log(
                user_id=user_id,
                level="INFO",
                message="PENDING_ENTRY expired (35s timeout) — reset to FLAT",
                event_id=event_id,
            )

            logger.info(
                f"  Expired stale PENDING_ENTRY for user {user_id[:8]}... "
                f"on event {event_id}"
            )

    def _check_entry_guards(
        self,
        period: int,
        seconds_remaining: float,
        home_score: int,
        away_score: int,
    ) -> str | None:
        """Return block reason string, or None if all guards pass.

        Guards (entry blockers only, never force exit):
        - Last 3 minutes of Q4/OT (period >= 4 and seconds_remaining < 180)
        - Blowout (margin > 15 in Q4+)
        """
        # Last 3 minutes of Q4 or OT
        if period >= 4 and seconds_remaining < 180:
            period_label = "OT" if period > 4 else "Q4"
            return f"Final 3 minutes of {period_label} ({seconds_remaining:.0f}s left)"

        # Blowout
        margin = abs(home_score - away_score)
        if period >= 4 and margin > 15:
            return f"Blowout — {margin} pt margin in Q4+"

        return None

    def _check_edge_persistence(
        self, game_id: str, edge: float, threshold: float
    ) -> bool:
        """Track edge values and return True if edge has persisted 2+ cycles.

        Maintains a list of recent edges per game_id.
        Resets if edge drops below threshold.
        """
        if game_id not in self.edge_history:
            self.edge_history[game_id] = []

        history = self.edge_history[game_id]

        if edge >= threshold:
            history.append(edge)
            # Keep only the last few entries
            if len(history) > 10:
                self.edge_history[game_id] = history[-10:]
        else:
            # Edge dropped below threshold — reset
            self.edge_history[game_id] = []
            return False

        return len(history) >= EDGE_PERSISTENCE_REQUIRED

    def _get_intent_price(self, signal: TradeSignal) -> float | None:
        """Get the appropriate price for the trade intent."""
        if signal.recommended_action == "BUY_HOME":
            return signal.kalshi_home_price
        elif signal.recommended_action == "BUY_AWAY":
            return signal.kalshi_away_price
        return None

    def _compute_contracts(
        self, settings: UserSettings, price: float
    ) -> int:
        """Compute contract count based on user settings."""
        if settings.sizing_mode == "contracts":
            return min(int(settings.bet_amount), settings.max_contracts_per_bet)

        # Dollars mode
        if price <= 0 or price >= 1:
            return 1
        count = math.floor(settings.bet_amount / price)
        return min(max(count, 1), settings.max_contracts_per_bet)
