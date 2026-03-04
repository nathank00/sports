"""Pregame odds fetcher using The Odds API (free tier).

Fetches moneyline and spread odds once per game at tip-off.
Free tier: 500 requests/month — plenty for ~15 games/day.

https://the-odds-api.com/
"""

import logging
import aiohttp

logger = logging.getLogger(__name__)

ODDS_API_URL = "https://api.the-odds-api.com/v4/sports/basketball_nba/odds"


def moneyline_to_prob(ml: float) -> float:
    """Convert American moneyline to implied probability."""
    if ml < 0:
        return abs(ml) / (abs(ml) + 100)
    elif ml > 0:
        return 100 / (ml + 100)
    return 0.5


async def fetch_pregame_odds(
    session: aiohttp.ClientSession,
    api_key: str | None,
    home_team_abbr: str,
    away_team_abbr: str,
) -> dict:
    """Fetch pregame odds for a specific game.

    Args:
        session: aiohttp client session
        api_key: The Odds API key (None to skip)
        home_team_abbr: 3-letter home team abbreviation
        away_team_abbr: 3-letter away team abbreviation

    Returns:
        {
            "spread": float | None (home spread, negative = favored),
            "home_ml_prob": float | None (implied probability),
        }
    """
    if not api_key:
        logger.debug("No ODDS_API_KEY — skipping pregame odds fetch")
        return {"spread": None, "home_ml_prob": None}

    try:
        params = {
            "apiKey": api_key,
            "regions": "us",
            "markets": "h2h,spreads",
            "oddsFormat": "american",
            "bookmakers": "fanduel,draftkings",
        }

        async with session.get(
            ODDS_API_URL,
            params=params,
            timeout=aiohttp.ClientTimeout(total=15),
        ) as resp:
            if resp.status != 200:
                logger.warning(f"Odds API returned {resp.status}")
                return {"spread": None, "home_ml_prob": None}

            data = await resp.json()

    except Exception as e:
        logger.warning(f"Odds API fetch failed: {e}")
        return {"spread": None, "home_ml_prob": None}

    # Find the matching game
    for event in data:
        teams = [t.get("abbreviation", "") for t in (event.get("teams") or [])]

        # The Odds API uses full team names, not abbreviations
        # Match by checking if home/away teams appear in the event
        home_name = _abbr_to_odds_api_name(home_team_abbr)
        away_name = _abbr_to_odds_api_name(away_team_abbr)

        event_home = event.get("home_team", "")
        event_away = event.get("away_team", "")

        if not (_name_matches(event_home, home_name) and _name_matches(event_away, away_name)):
            continue

        # Found the game — extract odds from first bookmaker
        spread = None
        home_ml_prob = None

        for bookmaker in event.get("bookmakers", []):
            for market in bookmaker.get("markets", []):
                if market.get("key") == "h2h":
                    for outcome in market.get("outcomes", []):
                        if _name_matches(outcome.get("name", ""), home_name):
                            price = outcome.get("price", 0)
                            home_ml_prob = moneyline_to_prob(price)

                elif market.get("key") == "spreads":
                    for outcome in market.get("outcomes", []):
                        if _name_matches(outcome.get("name", ""), home_name):
                            spread = outcome.get("point")

            if home_ml_prob is not None:
                break  # Use first bookmaker with data

        return {"spread": spread, "home_ml_prob": home_ml_prob}

    logger.debug(f"No odds found for {away_team_abbr} @ {home_team_abbr}")
    return {"spread": None, "home_ml_prob": None}


# Mapping from standard abbreviations to The Odds API team names
_ODDS_API_NAMES: dict[str, str] = {
    "ATL": "Atlanta Hawks",
    "BOS": "Boston Celtics",
    "BKN": "Brooklyn Nets",
    "CHA": "Charlotte Hornets",
    "CHI": "Chicago Bulls",
    "CLE": "Cleveland Cavaliers",
    "DAL": "Dallas Mavericks",
    "DEN": "Denver Nuggets",
    "DET": "Detroit Pistons",
    "GSW": "Golden State Warriors",
    "HOU": "Houston Rockets",
    "IND": "Indiana Pacers",
    "LAC": "Los Angeles Clippers",
    "LAL": "Los Angeles Lakers",
    "MEM": "Memphis Grizzlies",
    "MIA": "Miami Heat",
    "MIL": "Milwaukee Bucks",
    "MIN": "Minnesota Timberwolves",
    "NOP": "New Orleans Pelicans",
    "NYK": "New York Knicks",
    "OKC": "Oklahoma City Thunder",
    "ORL": "Orlando Magic",
    "PHI": "Philadelphia 76ers",
    "PHX": "Phoenix Suns",
    "POR": "Portland Trail Blazers",
    "SAC": "Sacramento Kings",
    "SAS": "San Antonio Spurs",
    "TOR": "Toronto Raptors",
    "UTA": "Utah Jazz",
    "WAS": "Washington Wizards",
}


def _abbr_to_odds_api_name(abbr: str) -> str:
    """Convert standard abbreviation to The Odds API team name."""
    return _ODDS_API_NAMES.get(abbr, abbr)


def _name_matches(name1: str, name2: str) -> bool:
    """Check if two team names refer to the same team (case-insensitive)."""
    return name1.lower().strip() == name2.lower().strip()
