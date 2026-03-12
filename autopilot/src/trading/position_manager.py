"""Position Manager — per-user position state management.

Evaluates trade intents for each active user on every signal cycle.
Enforces one-directional-position-per-game, anti-hedging, entry guards,
edge persistence, and cooldown logic. Writes PENDING_ENTRY state to
Supabase for the frontend to execute.

Also monitors open positions for take-profit, stop-loss, and late-game
auto-exit conditions, writing PENDING_EXIT intents.

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
    fetch_long_positions_for_event,
    fetch_user_settings,
    write_log,
)
from autopilot.src.trading.decision import (
    TradeSignal,
    match_markets,
    _extract_yes_bid,
    ABBR_TO_TEAM,
)

logger = logging.getLogger(__name__)

# Number of consecutive cycles edge must persist before entry
EDGE_PERSISTENCE_REQUIRED = 2

# No-trade window — must match decision.py TradingConfig default
NO_TRADE_SECONDS = 240.0


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

    Also monitors open positions for auto-exit via monitor_exits().
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
        1. Skip NO_TRADE signals
        2. Fetch current position for (user_id, event_id)
        3. Create FLAT row if none exists
        4. State guard with anti-hedging (only enter when FLAT)
        5. Check cooldown_until
        6. Check entry guards (no-trade window, blowout)
        7. Check edge >= user's threshold
        8. Check edge persistence (2+ consecutive cycles)
        9. All pass → set state = PENDING_ENTRY with intent fields
        """
        user_id = user_settings.user_id

        # 1. Skip NO_TRADE signals entirely (no logging needed)
        if signal.recommended_action == "NO_TRADE":
            return

        edge = signal.edge_vs_kalshi
        if edge is None:
            return

        # 2. Fetch current position
        position = fetch_position(user_id, event_id)

        # 3. Create FLAT row if none exists
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

        # 4. State guard with anti-hedging enforcement
        state = position.get("state", "FLAT")

        # Handle expired LOCKED positions → reset to FLAT
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

        # Block if pending order exists
        if state == "PENDING_ENTRY":
            write_log(
                user_id=user_id,
                level="BLOCKED",
                message="Pending entry order exists — signal ignored",
                event_id=event_id,
                metadata={"reason_code": "BLOCKED_PENDING_ORDER_EXISTS"},
            )
            return

        # Block if pending exit
        if state == "PENDING_EXIT":
            write_log(
                user_id=user_id,
                level="BLOCKED",
                message="Pending exit order exists — signal ignored",
                event_id=event_id,
                metadata={"reason_code": "BLOCKED_EVENT_NOT_FLAT"},
            )
            return

        # Block if exiting
        if state == "EXITING":
            write_log(
                user_id=user_id,
                level="BLOCKED",
                message="Position is exiting — signal ignored",
                event_id=event_id,
                metadata={"reason_code": "BLOCKED_EVENT_NOT_FLAT"},
            )
            return

        # Anti-hedging: if already holding a position, block new entries
        if state in ("LONG_HOME", "LONG_AWAY"):
            existing_side = "HOME" if state == "LONG_HOME" else "AWAY"
            signal_side = "HOME" if signal.recommended_action == "BUY_HOME" else "AWAY"

            if signal_side != existing_side:
                write_log(
                    user_id=user_id,
                    level="BLOCKED",
                    message=f"Anti-hedge: already {state}, cannot {signal.recommended_action}",
                    event_id=event_id,
                    metadata={"reason_code": "BLOCKED_OPPOSITE_SIDE_POSITION_EXISTS"},
                )
            else:
                write_log(
                    user_id=user_id,
                    level="BLOCKED",
                    message=f"Already {state} — cannot add to position",
                    event_id=event_id,
                    metadata={"reason_code": "BLOCKED_EVENT_NOT_FLAT"},
                )
            return

        # Block any other non-FLAT state
        if state != "FLAT":
            write_log(
                user_id=user_id,
                level="BLOCKED",
                message=f"Position state {state} — signal ignored",
                event_id=event_id,
                metadata={"reason_code": "BLOCKED_EVENT_NOT_FLAT"},
            )
            return

        # 5. Check cooldown
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
                        metadata={"reason_code": "BLOCKED_COOLDOWN_ACTIVE"},
                    )
                    return
            except (ValueError, TypeError):
                pass

        # 6. Check entry guards
        guard_result = self._check_entry_guards(
            period, seconds_remaining, home_score, away_score
        )
        if guard_result:
            block_message, reason_code = guard_result
            write_log(
                user_id=user_id,
                level="BLOCKED",
                message=block_message,
                event_id=event_id,
                metadata={"reason_code": reason_code},
            )
            return

        # 7. Check edge >= user's threshold
        if edge < user_settings.edge_threshold:
            # Don't log this — it's the normal case and would be noisy
            return

        # 8. Check edge persistence
        if not self._check_edge_persistence(game_id, edge, user_settings.edge_threshold):
            write_log(
                user_id=user_id,
                level="INFO",
                message=f"Edge {edge:.1f}% detected but not yet persistent "
                        f"({len(self.edge_history.get(game_id, []))}/"
                        f"{EDGE_PERSISTENCE_REQUIRED} cycles)",
                event_id=event_id,
                metadata={"reason_code": "BLOCKED_EDGE_NOT_PERSISTENT"},
            )
            return

        # 9. All pass → compute contract count and create PENDING_ENTRY
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
                "reason_code": "ENTRY_INTENT_CREATED",
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

    def monitor_exits(
        self,
        kalshi_markets: list[dict],
        period: int,
        seconds_remaining: float,
        home_team: str,
        away_team: str,
    ) -> None:
        """Check all active positions for take-profit, stop-loss, or late-game exit.

        Called once per tick per game by the orchestrator. Does not depend on
        signal evaluation — runs independently against current market prices.
        """
        home_full = ABBR_TO_TEAM.get(home_team, home_team)
        away_full = ABBR_TO_TEAM.get(away_team, away_team)

        home_market, away_market = match_markets(home_full, away_full, kalshi_markets)

        # Get current bid prices (we exit at bid, not ask)
        home_bid = _extract_yes_bid(home_market) if home_market else None
        away_bid = _extract_yes_bid(away_market) if away_market else None

        if not home_bid and not away_bid:
            return  # Can't evaluate exits without prices

        # Determine event_id from market tickers
        event_id = None
        for m in [home_market, away_market]:
            if m:
                ticker = m.get("ticker", "")
                parts = ticker.rsplit("-", 1)
                if len(parts) == 2:
                    event_id = parts[0]
                    break
        if not event_id:
            return

        # Fetch all LONG positions for this event
        long_positions = fetch_long_positions_for_event(event_id)

        for pos in long_positions:
            user_id = pos["user_id"]
            state = pos["state"]
            entry_price = pos.get("entry_price")
            quantity = pos.get("quantity")
            side = pos.get("side")  # "HOME" or "AWAY"
            ticker = pos.get("ticker")

            if not entry_price or not quantity or not side or not ticker:
                continue

            current_bid = home_bid if side == "HOME" else away_bid
            if current_bid is None:
                continue

            # Compute unrealized P&L per contract
            pnl_per_contract = current_bid - entry_price

            # Fetch user settings for TP/SL thresholds
            user_settings_row = self._get_user_settings(user_id)
            if not user_settings_row:
                continue
            settings = UserSettings.from_row(user_settings_row)

            exit_reason = None
            exit_reason_code = None

            # Take-profit check
            if pnl_per_contract >= settings.take_profit:
                exit_reason = (
                    f"TAKE PROFIT: +{pnl_per_contract:.2f}/contract "
                    f"(entry={entry_price:.2f}, bid={current_bid:.2f})"
                )
                exit_reason_code = "EXIT_TP_TRIGGERED"

            # Stop-loss check
            elif pnl_per_contract <= -settings.stop_loss:
                exit_reason = (
                    f"STOP LOSS: {pnl_per_contract:.2f}/contract "
                    f"(entry={entry_price:.2f}, bid={current_bid:.2f})"
                )
                exit_reason_code = "EXIT_SL_TRIGGERED"

            # Late-game forced exit: if game enters no-trade window while holding
            elif period >= 4 and seconds_remaining < NO_TRADE_SECONDS:
                exit_reason = (
                    f"LATE GAME EXIT: {seconds_remaining:.0f}s remaining in "
                    f"{'OT' if period > 4 else 'Q4'}"
                )
                exit_reason_code = "EXIT_LATE_GAME"

            if exit_reason:
                # Create PENDING_EXIT intent
                now = datetime.now(timezone.utc).isoformat()
                upsert_position(user_id, event_id, {
                    "state": "PENDING_EXIT",
                    "intent_price": round(current_bid, 4),
                    "intent_contracts": quantity,
                    "intent_side": "yes",
                    "intent_created_at": now,
                })

                write_log(
                    user_id=user_id,
                    level="EXIT",
                    message=exit_reason,
                    event_id=event_id,
                    metadata={
                        "reason_code": exit_reason_code,
                        "entry_price": entry_price,
                        "current_bid": current_bid,
                        "pnl_per_contract": round(pnl_per_contract, 4),
                        "quantity": quantity,
                        "ticker": ticker,
                    },
                )

                logger.info(
                    f"  PENDING_EXIT for {user_id[:8]}...: {exit_reason}"
                )

    def expire_stale_intents(self) -> None:
        """Find PENDING_ENTRY and PENDING_EXIT positions older than 35s and reset.

        Called once per tick (not per user).
        - Expired PENDING_ENTRY → reset to FLAT
        - Expired PENDING_EXIT → restore to LONG_* (backend will retry next tick)
        """
        stale = fetch_stale_pending_intents(max_age_seconds=35)
        for pos in stale:
            user_id = pos["user_id"]
            event_id = pos["event_id"]
            was_exit = pos.get("state") == "PENDING_EXIT"

            if was_exit:
                # Failed exit attempt — restore to LONG state so we retry
                side = pos.get("side")
                restore_state = f"LONG_{side}" if side in ("HOME", "AWAY") else "LONG_HOME"
                upsert_position(user_id, event_id, {
                    "state": restore_state,
                    "intent_price": None,
                    "intent_contracts": None,
                    "intent_side": None,
                    "intent_created_at": None,
                })
                write_log(
                    user_id=user_id,
                    level="INFO",
                    message="PENDING_EXIT expired (35s timeout) — restored to LONG",
                    event_id=event_id,
                    metadata={"reason_code": "EXIT_INTENT_EXPIRED"},
                )
                logger.info(
                    f"  Expired stale PENDING_EXIT for user {user_id[:8]}... "
                    f"on event {event_id} — restored to {restore_state}"
                )
            else:
                # Expired entry intent — reset to FLAT
                upsert_position(user_id, event_id, {
                    "game_id": pos.get("game_id"),
                    "state": "FLAT",
                    "side": None,
                    "ticker": None,
                    "home_team": pos.get("home_team"),
                    "away_team": pos.get("away_team"),
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
                    metadata={"reason_code": "ENTRY_INTENT_EXPIRED"},
                )
                logger.info(
                    f"  Expired stale PENDING_ENTRY for user {user_id[:8]}... "
                    f"on event {event_id}"
                )

    def _get_user_settings(self, user_id: str) -> dict | None:
        """Fetch a single user's settings. Uses the cached user list if available."""
        if self._cached_users:
            for u in self._cached_users:
                if u.get("user_id") == user_id:
                    return u
        # Fallback: direct DB query
        return fetch_user_settings(user_id)

    def _check_entry_guards(
        self,
        period: int,
        seconds_remaining: float,
        home_score: int,
        away_score: int,
    ) -> tuple[str, str] | None:
        """Return (block_message, reason_code) or None if all guards pass.

        Guards (entry blockers only, never force exit):
        - Last 4 minutes of Q4/OT (period >= 4 and seconds_remaining < 240)
        - Blowout (margin > 15 in Q4+)
        """
        # No-trade window: 4 minutes
        if period >= 4 and seconds_remaining < NO_TRADE_SECONDS:
            period_label = "OT" if period > 4 else "Q4"
            return (
                f"No-trade window ({seconds_remaining:.0f}s left in {period_label})",
                "BLOCKED_NO_TRADE_WINDOW",
            )

        # Blowout
        margin = abs(home_score - away_score)
        if period >= 4 and margin > 15:
            return (
                f"Blowout — {margin} pt margin in Q4+",
                "BLOCKED_BLOWOUT",
            )

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
