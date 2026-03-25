"""Signal evaluation and trading decision logic.

Compares model probability against Kalshi market prices and generates
trade signals. Applies friction, spread, underdog, and timing filters.
Pure functions with no side effects or I/O.
"""

from dataclasses import dataclass

# Kalshi ticker abbreviations for NBA teams.
# Ported from web/src/lib/matcher.ts TEAM_ABBR_MAP
TEAM_ABBR_MAP: dict[str, str] = {
    "Atlanta Hawks": "ATL",
    "Boston Celtics": "BOS",
    "Brooklyn Nets": "BKN",
    "Charlotte Hornets": "CHA",
    "Chicago Bulls": "CHI",
    "Cleveland Cavaliers": "CLE",
    "Dallas Mavericks": "DAL",
    "Denver Nuggets": "DEN",
    "Detroit Pistons": "DET",
    "Golden State Warriors": "GSW",
    "Houston Rockets": "HOU",
    "Indiana Pacers": "IND",
    "Los Angeles Clippers": "LAC",
    "Los Angeles Lakers": "LAL",
    "Memphis Grizzlies": "MEM",
    "Miami Heat": "MIA",
    "Milwaukee Bucks": "MIL",
    "Minnesota Timberwolves": "MIN",
    "New Orleans Pelicans": "NOP",
    "New York Knicks": "NYK",
    "Oklahoma City Thunder": "OKC",
    "Orlando Magic": "ORL",
    "Philadelphia 76ers": "PHI",
    "Phoenix Suns": "PHX",
    "Portland Trail Blazers": "POR",
    "Sacramento Kings": "SAC",
    "San Antonio Spurs": "SAS",
    "Toronto Raptors": "TOR",
    "Utah Jazz": "UTA",
    "Washington Wizards": "WAS",
}

# Reverse lookup: abbreviation -> full name
ABBR_TO_TEAM: dict[str, str] = {v: k for k, v in TEAM_ABBR_MAP.items()}


@dataclass
class TradingConfig:
    """Trading parameters for signal evaluation.

    Edge threshold and underdog rules are user-configured in the frontend.
    The backend recommends a BUY for any positive edge (after friction) and
    lets the frontend apply per-user thresholds before firing orders.
    """

    min_seconds_remaining: float = 300.0  # don't trade in final 5 minutes of Q4/OT
    blowout_margin: int = 15              # don't trade if score margin > this in Q4+
    friction_cents: float = 2.0           # Kalshi fee per contract (cents), subtracted from edge
    max_spread_width: float = 0.10        # block entry if bid-ask spread > this (dollars, 0-1)


@dataclass
class TradeSignal:
    """Output of the signal evaluation engine."""

    recommended_action: str    # "BUY_HOME", "BUY_AWAY", "NO_TRADE"
    reason: str
    reason_code: str | None = None          # structured reason code for logging
    recommended_ticker: str | None = None
    recommended_side: str | None = None     # always "yes" (YES-only strategy)
    edge_vs_kalshi: float | None = None     # edge after friction (percentage points)
    kalshi_home_price: float | None = None  # home YES ask
    kalshi_away_price: float | None = None  # away YES ask
    kalshi_home_bid: float | None = None    # home YES bid (for spread visibility)
    kalshi_away_bid: float | None = None    # away YES bid
    kalshi_ticker_home: str | None = None   # full home ticker (e.g. KXMLBGAME-25MAR25SFNYY-SF)
    kalshi_ticker_away: str | None = None   # full away ticker


def _today_kalshi_date() -> str:
    """Return today's date as a Kalshi ticker date fragment, e.g. '25MAR25'.

    Uses US Eastern time since that's when Kalshi game dates roll over.
    """
    from datetime import datetime, timezone, timedelta
    et = timezone(timedelta(hours=-4))  # EDT
    now = datetime.now(et)
    months = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"]
    return f"{now.day:02d}{months[now.month - 1]}{now.year % 100:02d}"


def match_markets(
    home_team: str,
    away_team: str,
    markets: list[dict],
    date_str: str | None = None,
) -> tuple[dict | None, dict | None]:
    """Find Kalshi markets for a given game matchup.

    Returns (home_market, away_market) where each is a market dict or None.
    Ported from web/src/lib/matcher.ts matchPredictionsToMarkets().

    date_str: Kalshi date fragment (e.g. "25MAR25") to filter by. If None,
    defaults to today's date in ET. This prevents matching tomorrow's game
    when the same teams play on consecutive days.
    """
    home_abbr = TEAM_ABBR_MAP.get(home_team)
    away_abbr = TEAM_ABBR_MAP.get(away_team)

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


def evaluate_signal(
    model_home_prob: float,
    home_team: str,
    away_team: str,
    seconds_remaining: float,
    period: int,
    markets: list[dict],
    config: TradingConfig | None = None,
    home_score: int = 0,
    away_score: int = 0,
) -> TradeSignal:
    """Evaluate whether a trade signal should be generated.

    Pure function. Compares model probability (typically blended) against
    Kalshi market prices, applies friction/spread/underdog filters, and
    returns a TradeSignal with a structured reason code.
    """
    if config is None:
        config = TradingConfig()

    model_away_prob = 1.0 - model_home_prob

    # ── Filter 1: No-trade window (5 minutes in Q4/OT) ──
    if period >= 4 and seconds_remaining < config.min_seconds_remaining:
        period_label = "OT" if period > 4 else "Q4"
        return TradeSignal(
            recommended_action="NO_TRADE",
            reason=f"No-trade window ({seconds_remaining:.0f}s left in {period_label})",
            reason_code="BLOCKED_NO_TRADE_WINDOW",
        )

    # ── Filter 2: Blowout ──
    score_margin = abs(home_score - away_score)
    if period >= 4 and score_margin > config.blowout_margin:
        return TradeSignal(
            recommended_action="NO_TRADE",
            reason=f"Blowout ({score_margin} pts in Q4+)",
            reason_code="BLOCKED_BLOWOUT",
        )

    # ── Find matching Kalshi markets ──
    home_market, away_market = match_markets(home_team, away_team, markets)

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

    # Zero out edges for sides blocked by spread
    if not home_spread_ok:
        home_edge = None
    if not away_spread_ok:
        away_edge = None

    # ── Pick best side with positive edge ──
    # Any positive edge (after friction) qualifies as a BUY signal.
    # User-configured thresholds (edge_threshold, underdog rule) are
    # applied by the frontend before firing orders.
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
        # Determine the most informative reason
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
            # Edge was non-positive after friction
            valid_edges = [e for e in [home_edge, away_edge] if e is not None]
            valid_raw = [e for e in [home_edge_raw, away_edge_raw] if e is not None]
            max_edge = max(valid_edges) if valid_edges else 0.0
            max_raw = max(valid_raw) if valid_raw else 0.0

            # Check if friction specifically killed a positive raw edge
            if max_raw > 0 and max_edge <= 0:
                reason = f"Edge {max_raw:.1f}% wiped out by {config.friction_cents:.0f}c friction ({max_edge:.1f}% net)"
                reason_code = "BLOCKED_FRICTION_GATE"
            else:
                reason = f"Negative edge {max_edge:.1f}%"
                reason_code = "BLOCKED_NEGATIVE_EDGE"
    else:
        reason = f"Edge: {best_edge:.1f}% (after friction)"

    # Compute a display edge even for NO_TRADE (for signal table)
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


def _extract_yes_ask(market: dict) -> float | None:
    """Extract the yes_ask price from a market dict.

    Handles both camelCase (from our live fetcher) and snake_case (from Kalshi API).
    Returns price in dollars (0-1 range) or None.

    The public Kalshi API returns prices as cents integers (e.g., 47 for $0.47),
    while the authenticated API returns dollar strings (e.g., "0.47").
    """
    # Try dollar string fields first (authenticated Kalshi API format)
    ask_str = market.get("yes_ask_dollars") or market.get("yesAskDollars")
    if ask_str:
        try:
            val = float(ask_str)
            if 0 < val < 1:
                return val
        except (ValueError, TypeError):
            pass

    # Try direct numeric fields (could be dollars 0-1 or cents 1-99)
    for key in ("yes_ask", "yesAsk"):
        val = market.get(key)
        if val is not None:
            try:
                val = float(val)
                if 0 < val < 1:
                    return val
                # Handle cents format from public API (e.g., 47 → 0.47)
                if 1 <= val <= 99:
                    return val / 100
            except (ValueError, TypeError):
                pass

    return None


def _extract_yes_bid(market: dict) -> float | None:
    """Extract the yes_bid price from a market dict.

    Mirror of _extract_yes_ask but for bid prices. Used for spread
    calculation and exit price estimation.
    """
    # Try dollar string fields first
    bid_str = market.get("yes_bid_dollars") or market.get("yesBidDollars")
    if bid_str:
        try:
            val = float(bid_str)
            if 0 < val < 1:
                return val
        except (ValueError, TypeError):
            pass

    # Try direct numeric fields
    for key in ("yes_bid", "yesBid"):
        val = market.get(key)
        if val is not None:
            try:
                val = float(val)
                if 0 < val < 1:
                    return val
                if 1 <= val <= 99:
                    return val / 100
            except (ValueError, TypeError):
                pass

    return None
