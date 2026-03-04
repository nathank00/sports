"""Backfill pregame odds from OddsShark's scores API for historical games.

OddsShark's internal API returns game scores with pregame spreads and
moneylines for any historical date. This script iterates through game dates,
fetches the OddsShark scores endpoint, and updates training snapshots.

Coverage: All NBA seasons with data on OddsShark (2007+).
Primary use: Seasons 2023-24 and 2024-25 where ESPN pickcenter is unavailable.

Usage:
    python run_calibrate.py backfill-oddsshark-odds --start-season 2023 --end-season 2024
"""

import json
import logging
import time
import urllib.request
from datetime import datetime, timedelta

from autopilot.src.db import supabase

logger = logging.getLogger(__name__)

# Throttle: seconds between OddsShark API requests
REQUEST_DELAY = 0.6

ODDSSHARK_API_URL = "https://www.oddsshark.com/api/scores/nba"

# OddsShark uses slightly different abbreviations than our standard.
# Only need to map the ones that differ.
ODDSSHARK_ABBR_MAP: dict[str, str] = {
    "CHR": "CHA",   # Charlotte Hornets
    "GS": "GSW",    # Golden State Warriors
    "SAN": "SAS",   # San Antonio Spurs
    "NY": "NYK",    # New York Knicks
    "PHO": "PHX",   # Phoenix Suns
}


def _normalize_oddsshark_abbr(abbr: str) -> str:
    """Normalize OddsShark team abbreviation to our standard format."""
    if not abbr:
        return ""
    abbr = abbr.upper()
    return ODDSSHARK_ABBR_MAP.get(abbr, abbr)


def _moneyline_to_prob(ml: float) -> float:
    """Convert American moneyline to implied probability."""
    if ml < 0:
        return abs(ml) / (abs(ml) + 100)
    elif ml > 0:
        return 100 / (ml + 100)
    return 0.5


def _fetch_oddsshark_scores(date_str: str) -> dict | None:
    """Fetch scores/odds from OddsShark API for a given date.

    Args:
        date_str: Date in YYYY-MM-DD format.

    Returns:
        Parsed JSON response or None on failure.
    """
    url = f"{ODDSSHARK_API_URL}/{date_str}?_format=json"
    try:
        req = urllib.request.Request(
            url,
            headers={
                "User-Agent": (
                    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) "
                    "Chrome/131.0.0.0 Safari/537.36"
                ),
                "Accept": "application/json",
                "Accept-Encoding": "gzip, deflate",
                "Referer": "https://www.oddsshark.com/nba/scores",
            },
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            import gzip

            data = resp.read()
            # Decompress if gzipped
            if data[:2] == b"\x1f\x8b":
                data = gzip.decompress(data)
            return json.loads(data)
    except Exception as e:
        logger.warning(f"OddsShark fetch failed for {date_str}: {e}")
        return None


def _season_date_range(season: int) -> tuple[datetime, datetime]:
    """Get approximate start/end dates for an NBA season.

    Season 2023 = 2023-24 season (Oct 2023 - Jun 2024)
    Season 2024 = 2024-25 season (Oct 2024 - Jun 2025)
    """
    if season == 2020:
        return datetime(2020, 12, 20), datetime(2021, 7, 25)
    else:
        return datetime(season, 10, 15), datetime(season + 1, 6, 25)


def backfill_oddsshark_odds(
    start_season: int = 2023,
    end_season: int = 2024,
) -> int:
    """Backfill pregame odds from OddsShark for historical games.

    Iterates through dates, fetches OddsShark scores API, extracts
    spreads and moneylines, and updates training snapshots.

    Returns number of games updated.
    """
    total_updated = 0

    for season in range(start_season, end_season + 1):
        start_date, end_date = _season_date_range(season)
        logger.info(
            f"Backfilling season {season}-{season+1} "
            f"({start_date.date()} to {end_date.date()})"
        )

        current = start_date
        season_updated = 0
        season_games = 0
        season_skipped = 0

        while current <= end_date:
            date_str = current.strftime("%Y-%m-%d")

            data = _fetch_oddsshark_scores(date_str)
            time.sleep(REQUEST_DELAY)

            if not data:
                current += timedelta(days=1)
                continue

            scores = data.get("scores", [])
            if not scores:
                current += timedelta(days=1)
                continue

            # Only process completed games
            completed = [
                s for s in scores
                if s.get("status", "").upper() in ("FINAL", "COMPLETE")
                or s.get("eventStatus", "").lower() == "complete"
            ]

            if not completed:
                current += timedelta(days=1)
                continue

            logger.info(
                f"  {date_str}: {len(completed)} completed games"
            )

            for game in completed:
                teams = game.get("teams", {})
                home_data = teams.get("home", {})
                away_data = teams.get("away", {})

                home_names = home_data.get("names", {})
                away_names = away_data.get("names", {})

                home_team = _normalize_oddsshark_abbr(
                    home_names.get("abbreviation", "")
                )
                away_team = _normalize_oddsshark_abbr(
                    away_names.get("abbreviation", "")
                )

                if not home_team or not away_team:
                    continue

                season_games += 1

                # Extract spread (home team perspective, negative = favored)
                spread = home_data.get("spread")
                if spread is not None:
                    try:
                        spread = float(spread)
                    except (ValueError, TypeError):
                        spread = None

                # Extract moneyline → implied probability
                home_ml = home_data.get("moneyLine")
                home_ml_prob = None
                if home_ml is not None:
                    try:
                        home_ml_prob = round(
                            _moneyline_to_prob(float(home_ml)), 4
                        )
                    except (ValueError, TypeError):
                        pass

                if spread is None and home_ml_prob is None:
                    season_skipped += 1
                    continue

                # Update training snapshots for this game
                game_date = date_str
                update_data = {}
                if spread is not None:
                    update_data["pregame_spread"] = spread
                if home_ml_prob is not None:
                    update_data["pregame_home_ml_prob"] = home_ml_prob

                try:
                    result = (
                        supabase.table("autopilot_training_snapshots")
                        .update(update_data)
                        .eq("game_date", game_date)
                        .eq("home_team", home_team)
                        .eq("away_team", away_team)
                        .execute()
                    )
                    if result.data:
                        season_updated += 1
                except Exception as e:
                    logger.error(
                        f"Update failed for {away_team}@{home_team} "
                        f"{game_date}: {e}"
                    )

            current += timedelta(days=1)

        logger.info(
            f"  Season {season}: {season_updated}/{season_games} games "
            f"updated ({season_skipped} skipped - no odds)"
        )
        total_updated += season_updated

    logger.info(f"Total: {total_updated} games updated with OddsShark odds")
    return total_updated
