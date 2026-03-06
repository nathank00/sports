"""Signal evaluation and trading decision logic.

Compares model probability against Kalshi market prices and generates
trade signals. Pure functions with no side effects or I/O.
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
    """Trading parameters for signal evaluation."""

    min_edge_pct: float = 2.0             # minimum edge to recommend a trade (percentage points)
    min_seconds_remaining: float = 180.0  # don't trade in final 3 minutes of Q4/OT
    blowout_margin: int = 15              # don't trade if score margin > this in Q4+


@dataclass
class TradeSignal:
    """Output of the signal evaluation engine."""

    recommended_action: str    # "BUY_HOME", "BUY_AWAY", "NO_TRADE"
    reason: str
    recommended_ticker: str | None = None
    recommended_side: str | None = None    # always "yes" (YES-only strategy)
    edge_vs_kalshi: float | None = None
    kalshi_home_price: float | None = None
    kalshi_away_price: float | None = None


def match_markets(
    home_team: str,
    away_team: str,
    markets: list[dict],
) -> tuple[dict | None, dict | None]:
    """Find Kalshi markets for a given game matchup.

    Returns (home_market, away_market) where each is a market dict or None.
    Ported from web/src/lib/matcher.ts matchPredictionsToMarkets().
    """
    home_abbr = TEAM_ABBR_MAP.get(home_team)
    away_abbr = TEAM_ABBR_MAP.get(away_team)

    if not home_abbr or not away_abbr:
        return None, None

    home_market = None
    away_market = None

    for market in markets:
        event_ticker = market.get("event_ticker") or market.get("eventTicker", "")
        ticker = market.get("ticker", "")

        # Event must involve both teams
        if home_abbr not in event_ticker or away_abbr not in event_ticker:
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

    Pure function. Compares model probability against Kalshi market prices
    and returns a TradeSignal.
    """
    if config is None:
        config = TradingConfig()

    model_away_prob = 1.0 - model_home_prob

    # Filter: don't trade in final 3 minutes of Q4 or overtime
    if period >= 4 and seconds_remaining < config.min_seconds_remaining:
        return TradeSignal(
            recommended_action="NO_TRADE",
            reason=f"Too close to end of {'OT' if period > 4 else 'Q4'} ({seconds_remaining:.0f}s remaining)",
        )

    # Filter: don't trade blowouts (score margin > threshold in Q4+)
    score_margin = abs(home_score - away_score)
    if period >= 4 and score_margin > config.blowout_margin:
        return TradeSignal(
            recommended_action="NO_TRADE",
            reason=f"Blowout — margin {score_margin} pts in {'OT' if period > 4 else 'Q4'} exceeds {config.blowout_margin} pt limit",
        )

    # Find matching Kalshi markets
    home_market, away_market = match_markets(home_team, away_team, markets)

    if not home_market and not away_market:
        return TradeSignal(
            recommended_action="NO_TRADE",
            reason="No matching Kalshi markets found",
        )

    # Extract prices (yes_ask in dollars, 0-1 range)
    home_price = _extract_yes_ask(home_market) if home_market else None
    away_price = _extract_yes_ask(away_market) if away_market else None

    # Compute edges
    home_edge = (model_home_prob - home_price) * 100 if home_price else None
    away_edge = (model_away_prob - away_price) * 100 if away_price else None

    # Pick the best side
    best_action = "NO_TRADE"
    best_edge = 0.0
    best_ticker = None
    reason = "Edge below threshold"

    if home_edge is not None and home_edge > best_edge:
        best_edge = home_edge
        best_action = "BUY_HOME"
        best_ticker = home_market["ticker"] if home_market else None

    if away_edge is not None and away_edge > best_edge:
        best_edge = away_edge
        best_action = "BUY_AWAY"
        best_ticker = away_market["ticker"] if away_market else None

    if best_edge < config.min_edge_pct:
        best_action = "NO_TRADE"
        reason = f"Best edge {best_edge:.1f}% < threshold {config.min_edge_pct}%"
    else:
        reason = f"Edge: {best_edge:.1f}%"

    return TradeSignal(
        recommended_action=best_action,
        reason=reason,
        recommended_ticker=best_ticker,
        recommended_side="yes" if best_action != "NO_TRADE" else None,
        edge_vs_kalshi=best_edge if best_action != "NO_TRADE" else None,
        kalshi_home_price=home_price,
        kalshi_away_price=away_price,
    )


def _extract_yes_ask(market: dict) -> float | None:
    """Extract the yes_ask price from a market dict.

    Handles both camelCase (from our live fetcher) and snake_case (from Kalshi API).
    Returns price in dollars (0-1 range) or None.
    """
    # Try dollar string fields first (Kalshi API format)
    ask_str = market.get("yes_ask_dollars") or market.get("yesAskDollars")
    if ask_str:
        try:
            val = float(ask_str)
            if 0 < val < 1:
                return val
        except (ValueError, TypeError):
            pass

    # Try direct numeric fields
    for key in ("yes_ask", "yesAsk"):
        val = market.get(key)
        if val is not None:
            try:
                val = float(val)
                if 0 < val < 1:
                    return val
            except (ValueError, TypeError):
                pass

    return None
