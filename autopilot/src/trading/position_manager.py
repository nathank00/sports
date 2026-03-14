"""Position Manager — simplified.

Backend's role:
1. Generate signals → write to autopilot_signals (unchanged, done by orchestrator)
2. Monitor open positions for TP/SL/late-game → set sell_signal on position row
3. Expire stale sell_signals

Frontend's role:
- Read signals → fire buy orders → verify via Kalshi
- Poll positions for sell_signal → fire sell orders → verify via Kalshi

No state machine. No PENDING_ENTRY/PENDING_EXIT. No edge persistence.
Kalshi is the source of truth for what the user owns.
"""

import logging
import math
from datetime import datetime, timezone
from dataclasses import dataclass

from autopilot.src.db import (
    fetch_active_users,
    fetch_position,
    upsert_position,
    fetch_positions_with_entry_price,
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
    """Simplified position management.

    process_signal() — no longer creates PENDING_ENTRY. The frontend reads
    autopilot_signals directly and fires buys. Backend just logs.

    monitor_exits() — sets sell_signal on position rows when TP/SL/late-game
    triggers. Frontend polls for sell_signal and fires sells.
    """

    def __init__(self):
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
        """Log qualifying signals. Frontend reads autopilot_signals and acts.

        The backend no longer creates PENDING_ENTRY — the frontend reads
        signals directly and fires orders when edge >= threshold.

        We still log here for visibility into what the backend is seeing.
        """
        user_id = user_settings.user_id
        game_label = f"{away_team}@{home_team}"

        # Skip NO_TRADE signals
        if signal.recommended_action == "NO_TRADE":
            return

        edge = signal.edge_vs_kalshi
        if edge is None:
            return

        # Check edge >= user's threshold (just for logging — frontend enforces too)
        if edge < user_settings.edge_threshold:
            return

        # Check entry guards (no-trade window, blowout)
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

        # Check if user already has a position (DB row with entry_price)
        position = fetch_position(user_id, event_id)
        if position and position.get("entry_price") is not None:
            # Already holding — don't log every tick
            return

        # Signal qualifies — log it (frontend will act on the signal directly)
        side = "HOME" if signal.recommended_action == "BUY_HOME" else "AWAY"
        logger.info(
            f"  Signal qualifies for {user_id[:8]}...: "
            f"{signal.recommended_action} (edge={edge:.1f}%)"
        )

    def monitor_exits(
        self,
        kalshi_markets: list[dict],
        period: int,
        seconds_remaining: float,
        home_team: str,
        away_team: str,
    ) -> None:
        """Check positions for take-profit, stop-loss, or late-game exit.

        Instead of creating PENDING_EXIT, sets sell_signal on the position row.
        Frontend polls for sell_signal and fires sell orders.
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

        # Fetch all positions with entry_price for this event
        positions = fetch_positions_with_entry_price(event_id)

        for pos in positions:
            user_id = pos["user_id"]
            entry_price = pos.get("entry_price")
            side = pos.get("side")  # "HOME" or "AWAY"
            ticker = pos.get("ticker")

            if not entry_price or not side or not ticker:
                continue

            # Skip if sell_signal already set (frontend hasn't acted yet)
            if pos.get("sell_signal") is not None:
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
            game_label = f"{away_team}@{home_team}"

            # Take-profit check
            if pnl_per_contract >= settings.take_profit:
                exit_reason = (
                    f"{game_label}: TAKE PROFIT: +{pnl_per_contract:.2f}/contract "
                    f"(entry={entry_price:.2f}, bid={current_bid:.2f})"
                )
                exit_reason_code = "EXIT_TP_TRIGGERED"

            # Stop-loss check
            elif pnl_per_contract <= -settings.stop_loss:
                exit_reason = (
                    f"{game_label}: STOP LOSS: {pnl_per_contract:.2f}/contract "
                    f"(entry={entry_price:.2f}, bid={current_bid:.2f})"
                )
                exit_reason_code = "EXIT_SL_TRIGGERED"

            # Late-game forced exit: if game enters no-trade window while holding
            elif period >= 4 and seconds_remaining < NO_TRADE_SECONDS:
                exit_reason = (
                    f"{game_label}: LATE GAME EXIT: {seconds_remaining:.0f}s remaining in "
                    f"{'OT' if period > 4 else 'Q4'}"
                )
                exit_reason_code = "EXIT_LATE_GAME"

            if exit_reason:
                # Set sell_signal on position row — frontend will fire the sell
                upsert_position(user_id, event_id, {
                    "sell_signal": round(current_bid, 4),
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
                        "ticker": ticker,
                    },
                )

                logger.info(
                    f"  sell_signal set for {user_id[:8]}...: {exit_reason}"
                )

    def expire_stale_intents(self) -> None:
        """Clear sell_signal if it's been set for too long (frontend didn't act).

        This is a simple cleanup — if the sell_signal was set but the frontend
        didn't fire within 60s, clear it so the backend can re-trigger on the
        next tick if conditions still warrant an exit.
        """
        # For now this is a no-op — sell_signal doesn't have a timestamp.
        # The frontend clears it immediately when it fires a sell, and the
        # backend will re-set it on the next tick if TP/SL still triggers.
        pass

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
