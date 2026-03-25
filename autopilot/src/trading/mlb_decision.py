"""MLB signal evaluation and trading decision logic.

Compares model probability against Kalshi market prices and generates
trade signals. Applies friction, spread, underdog, and timing filters.
Pure functions with no side effects or I/O.
"""

from dataclasses import dataclass

# Import shared types from NBA decision module
from autopilot.src.trading.decision import (
    TradingConfig as _BaseTradingConfig,
    TradeSignal,
    _extract_yes_ask,
    _extract_yes_bid,
    _today_kalshi_date,
)

# MLB team full name → Kalshi ticker abbreviation.
# These MUST match what Kalshi uses in their tickers (verified against API).
MLB_TEAM_ABBR_MAP: dict[str, str] = {
    "Los Angeles Angels": "LAA",
    "Arizona Diamondbacks": "AZ",       # Kalshi uses AZ (not ARI)
    "Baltimore Orioles": "BAL",
    "Boston Red Sox": "BOS",
    "Chicago Cubs": "CHC",
    "Cincinnati Reds": "CIN",
    "Cleveland Guardians": "CLE",
    "Colorado Rockies": "COL",
    "Detroit Tigers": "DET",
    "Houston Astros": "HOU",
    "Kansas City Royals": "KC",
    "Los Angeles Dodgers": "LAD",
    "Washington Nationals": "WSH",       # Kalshi uses WSH
    "New York Mets": "NYM",
    "Oakland Athletics": "ATH",          # Kalshi uses ATH (not OAK)
    "Pittsburgh Pirates": "PIT",
    "San Diego Padres": "SD",
    "Seattle Mariners": "SEA",
    "San Francisco Giants": "SF",
    "St. Louis Cardinals": "STL",
    "Tampa Bay Rays": "TB",
    "Texas Rangers": "TEX",
    "Toronto Blue Jays": "TOR",
    "Minnesota Twins": "MIN",
    "Philadelphia Phillies": "PHI",
    "Atlanta Braves": "ATL",
    "Chicago White Sox": "CWS",
    "Miami Marlins": "MIA",
    "New York Yankees": "NYY",
    "Milwaukee Brewers": "MIL",
}

# Reverse lookup: abbreviation → full name
MLB_ABBR_TO_TEAM: dict[str, str] = {v: k for k, v in MLB_TEAM_ABBR_MAP.items()}


@dataclass
class MLBTradingConfig:
    """Trading parameters for MLB signal evaluation."""

    min_outs_remaining: int = 6        # don't trade in final inning (6 outs = 1 full inning)
    blowout_margin: int = 8            # don't trade if run margin > this in 7th+
    blowout_inning: int = 7            # inning at which blowout filter kicks in
    friction_cents: float = 2.0        # Kalshi fee per contract (cents)
    max_spread_width: float = 0.10     # block entry if bid-ask spread > this (dollars)


def mlb_match_markets(
    home_team: str,
    away_team: str,
    markets: list[dict],
    date_str: str | None = None,
) -> tuple[dict | None, dict | None]:
    """Find Kalshi markets for a given MLB game matchup.

    Returns (home_market, away_market) where each is a market dict or None.

    date_str: Kalshi date fragment (e.g. "25MAR25") to filter by. If None,
    defaults to today's date in ET.
    """
    home_abbr = MLB_TEAM_ABBR_MAP.get(home_team)
    away_abbr = MLB_TEAM_ABBR_MAP.get(away_team)

    if not home_abbr or not away_abbr:
        return None, None

    if date_str is None:
        date_str = _today_kalshi_date()

    home_market = None
    away_market = None

    for market in markets:
        event_ticker = market.get("event_ticker") or market.get("eventTicker", "")
        ticker = market.get("ticker", "")

        # Event must involve both teams AND match today's date
        if home_abbr not in event_ticker or away_abbr not in event_ticker:
            continue
        if date_str not in event_ticker:
            continue

        # Identify which team this market's YES side represents
        suffix = ticker.split("-")[-1] if "-" in ticker else ""
        if suffix == home_abbr:
            home_market = market
        elif suffix == away_abbr:
            away_market = market

        if home_market and away_market:
            break

    return home_market, away_market


def mlb_evaluate_signal(
    model_home_prob: float,
    home_team: str,
    away_team: str,
    outs_remaining: int,
    inning: int,
    markets: list[dict],
    config: MLBTradingConfig | None = None,
    home_score: int = 0,
    away_score: int = 0,
) -> TradeSignal:
    """Evaluate whether an MLB trade signal should be generated.

    Pure function. Compares model probability against Kalshi market prices,
    applies friction/spread/underdog filters, and returns a TradeSignal.
    """
    if config is None:
        config = MLBTradingConfig()

    model_away_prob = 1.0 - model_home_prob

    # ── Filter 1: No-trade window (final inning) ──
    if outs_remaining <= config.min_outs_remaining:
        return TradeSignal(
            recommended_action="NO_TRADE",
            reason=f"No-trade window ({outs_remaining} outs remaining)",
            reason_code="BLOCKED_NO_TRADE_WINDOW",
        )

    # ── Filter 2: Blowout ──
    score_margin = abs(home_score - away_score)
    if inning >= config.blowout_inning and score_margin > config.blowout_margin:
        return TradeSignal(
            recommended_action="NO_TRADE",
            reason=f"Blowout ({score_margin} runs in inning {inning}+)",
            reason_code="BLOCKED_BLOWOUT",
        )

    # ── Find matching Kalshi markets ──
    home_market, away_market = mlb_match_markets(home_team, away_team, markets)

    if not home_market and not away_market:
        return TradeSignal(
            recommended_action="NO_TRADE",
            reason="No matching Kalshi markets found",
            reason_code="BLOCKED_NO_MARKET",
        )

    # ── Extract prices (ask and bid) ──
    home_ask = _extract_yes_ask(home_market) if home_market else None
    away_ask = _extract_yes_ask(away_market) if away_market else None
    home_bid = _extract_yes_bid(home_market) if home_market else None
    away_bid = _extract_yes_bid(away_market) if away_market else None

    # ── Filter 3: Bid-ask spread filter ──
    home_spread_ok = True
    away_spread_ok = True

    if home_ask is not None and home_bid is not None:
        if (home_ask - home_bid) > config.max_spread_width:
            home_spread_ok = False

    if away_ask is not None and away_bid is not None:
        if (away_ask - away_bid) > config.max_spread_width:
            away_spread_ok = False

    # ── Compute edges with friction deduction ──
    home_edge_raw = (model_home_prob - home_ask) * 100 if home_ask else None
    away_edge_raw = (model_away_prob - away_ask) * 100 if away_ask else None

    home_edge = (home_edge_raw - config.friction_cents) if home_edge_raw is not None else None
    away_edge = (away_edge_raw - config.friction_cents) if away_edge_raw is not None else None

    if not home_spread_ok:
        home_edge = None
    if not away_spread_ok:
        away_edge = None

    # ── Pick best side with positive edge ──
    best_action = "NO_TRADE"
    best_edge = 0.0
    best_ticker = None
    reason_code = "BLOCKED_NEGATIVE_EDGE"

    if home_edge is not None and home_edge > 0 and home_edge > best_edge:
        best_edge = home_edge
        best_action = "BUY_HOME"
        best_ticker = home_market["ticker"] if home_market else None
        reason_code = None

    if away_edge is not None and away_edge > 0 and away_edge > best_edge:
        best_edge = away_edge
        best_action = "BUY_AWAY"
        best_ticker = away_market["ticker"] if away_market else None
        reason_code = None

    # ── Build reason string ──
    if best_action == "NO_TRADE":
        if not home_spread_ok and not away_spread_ok:
            reason = "Spread too wide on both sides"
            reason_code = "BLOCKED_SPREAD_TOO_WIDE"
        elif home_edge is None and away_edge is None:
            if not home_spread_ok or not away_spread_ok:
                reason = "Spread too wide"
                reason_code = "BLOCKED_SPREAD_TOO_WIDE"
            else:
                reason = "No price data available"
                reason_code = "BLOCKED_NO_MARKET"
        else:
            valid_edges = [e for e in [home_edge, away_edge] if e is not None]
            valid_raw = [e for e in [home_edge_raw, away_edge_raw] if e is not None]
            max_edge = max(valid_edges) if valid_edges else 0.0
            max_raw = max(valid_raw) if valid_raw else 0.0

            if max_raw > 0 and max_edge <= 0:
                reason = f"Edge {max_raw:.1f}% wiped out by {config.friction_cents:.0f}c friction ({max_edge:.1f}% net)"
                reason_code = "BLOCKED_FRICTION_GATE"
            else:
                reason = f"Negative edge {max_edge:.1f}%"
                reason_code = "BLOCKED_NEGATIVE_EDGE"
    else:
        reason = f"Edge: {best_edge:.1f}% (after friction)"

    display_edge = None
    if best_action != "NO_TRADE":
        display_edge = best_edge
    else:
        valid_edges = [e for e in [home_edge, away_edge] if e is not None]
        if valid_edges:
            display_edge = max(valid_edges)

    # Extract full tickers for frontend position matching
    home_ticker = home_market.get("ticker") if home_market else None
    away_ticker = away_market.get("ticker") if away_market else None

    return TradeSignal(
        recommended_action=best_action,
        reason=reason,
        reason_code=reason_code,
        recommended_ticker=best_ticker,
        recommended_side="yes" if best_action != "NO_TRADE" else None,
        edge_vs_kalshi=display_edge,
        kalshi_home_price=home_ask,
        kalshi_away_price=away_ask,
        kalshi_home_bid=home_bid,
        kalshi_away_bid=away_bid,
        kalshi_ticker_home=home_ticker,
        kalshi_ticker_away=away_ticker,
    )
