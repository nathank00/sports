"""Position Manager — exit monitoring only.

Backend's role:
1. Generate signals → write to autopilot_signals (done by orchestrator)
2. Monitor open positions for TP/SL/late-game → set sell_signal on position row

Frontend's role:
- Read signals → fire buy orders → verify via Kalshi
- Poll positions for sell_signal → fire sell orders → verify via Kalshi

No state machine. Kalshi is the source of truth for what the user owns.
"""

import logging
from dataclasses import dataclass

from autopilot.src.db import (
    fetch_active_users,
    upsert_position,
    fetch_positions_with_entry_price,
    fetch_user_settings,
    write_log,
)
from autopilot.src.trading.decision import (
    match_markets,
    _extract_yes_bid,
    ABBR_TO_TEAM,
)

logger = logging.getLogger(__name__)

# No-trade window — must match decision.py TradingConfig default
NO_TRADE_SECONDS = 300.0


@dataclass
class UserSettings:
    """Parsed user settings from autopilot_settings row.

    Backend only needs edge_threshold (for logging), take_profit, and stop_loss.
    Sizing/execution fields are frontend-only.
    """

    user_id: str
    edge_threshold: float
    take_profit: float
    stop_loss: float

    @classmethod
    def from_row(cls, row: dict) -> "UserSettings":
        return cls(
            user_id=row["user_id"],
            edge_threshold=row.get("edge_threshold", 8.0),
            take_profit=row.get("take_profit", 0.08),
            stop_loss=row.get("stop_loss", 0.05),
        )


class PositionManager:
    """Exit monitoring only.

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

    def monitor_exits(
        self,
        kalshi_markets: list[dict],
        period: int,
        seconds_remaining: float,
        home_team: str,
        away_team: str,
    ) -> None:
        """Check positions for take-profit, stop-loss, or late-game exit.

        Sets sell_signal on the position row.
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

    def _get_user_settings(self, user_id: str) -> dict | None:
        """Fetch a single user's settings. Uses the cached user list if available."""
        if self._cached_users:
            for u in self._cached_users:
                if u.get("user_id") == user_id:
                    return u
        # Fallback: direct DB query
        return fetch_user_settings(user_id)
