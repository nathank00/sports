"""Backfill pregame odds from ESPN's pickcenter for historical games.

ESPN's game summary endpoint includes a 'pickcenter' section with
opening/closing spreads and moneylines. Available for seasons ~2020-2023
and the current season (2025-26). Not available for 2023-24 and 2024-25.

This script iterates through game dates, fetches ESPN summaries, and
updates training snapshots with the extracted odds data.

Usage:
    python run_calibrate.py backfill-espn-odds --start-season 2020 --end-season 2023
"""

import json
import logging
import time
import urllib.request
from datetime import datetime, timedelta

from autopilot.src.db import supabase
from autopilot.src.ingest.espn_live import (
    ESPN_SCOREBOARD_URL,
    normalize_espn_abbr,
    _moneyline_to_prob,
)

logger = logging.getLogger(__name__)

# Throttle: seconds between ESPN API requests
REQUEST_DELAY = 0.5


def _fetch_json(url: str) -> dict | None:
    """Fetch JSON from a URL with throttling."""
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read())
    except Exception as e:
        logger.warning(f"Fetch failed: {url} — {e}")
        return None


def _season_date_range(season: int) -> tuple[datetime, datetime]:
    """Get approximate start/end dates for an NBA season.

    Season 2020 = 2020-21 season (Dec 2020 - Jul 2021, COVID adjusted)
    Season 2021 = 2021-22 season (Oct 2021 - Jun 2022)
    """
    if season == 2020:
        return datetime(2020, 12, 20), datetime(2021, 7, 25)
    else:
        return datetime(season, 10, 15), datetime(season + 1, 6, 25)


def backfill_espn_odds(start_season: int = 2020, end_season: int = 2023) -> int:
    """Backfill pregame odds from ESPN for historical games.

    Iterates through dates, fetches ESPN summaries, extracts pickcenter
    odds, and updates training snapshots.

    Returns number of games updated.
    """
    total_updated = 0

    for season in range(start_season, end_season + 1):
        start_date, end_date = _season_date_range(season)
        logger.info(f"Backfilling season {season}-{season+1} ({start_date.date()} to {end_date.date()})")

        current = start_date
        season_updated = 0
        season_games = 0

        while current <= end_date:
            date_str = current.strftime("%Y%m%d")

            # Fetch scoreboard for this date
            scoreboard_url = f"{ESPN_SCOREBOARD_URL}?dates={date_str}"
            data = _fetch_json(scoreboard_url)
            time.sleep(REQUEST_DELAY)

            if not data:
                current += timedelta(days=1)
                continue

            events = data.get("events", [])
            completed = [e for e in events if e.get("status", {}).get("type", {}).get("state") == "post"]
            if not completed:
                current += timedelta(days=1)
                continue

            logger.info(f"  {current.strftime('%Y-%m-%d')}: {len(completed)} completed games")

            for event in events:
                # Only process completed games
                status = event.get("status", {}).get("type", {}).get("state", "pre")
                if status != "post":
                    continue

                espn_id = event.get("id", "")
                competition = (event.get("competitions") or [{}])[0]
                competitors = competition.get("competitors", [])
                home = next((c for c in competitors if c.get("homeAway") == "home"), {})
                away = next((c for c in competitors if c.get("homeAway") == "away"), {})
                home_team = normalize_espn_abbr(home.get("team", {}).get("abbreviation", ""))
                away_team = normalize_espn_abbr(away.get("team", {}).get("abbreviation", ""))

                if not home_team or not away_team:
                    continue

                season_games += 1

                # Fetch game summary for pickcenter
                summary_url = f"https://site.web.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event={espn_id}"
                summary = _fetch_json(summary_url)
                time.sleep(REQUEST_DELAY)

                if not summary:
                    continue

                pickcenter = summary.get("pickcenter", [])
                if not pickcenter:
                    continue

                pick = pickcenter[0]

                # Extract spread (home team perspective)
                spread = None
                try:
                    # Try opening spread first
                    open_line = pick.get("pointSpread", {}).get("open", {}).get("line")
                    if open_line is not None:
                        spread = float(str(open_line))
                except (ValueError, TypeError):
                    pass

                if spread is None:
                    try:
                        s = pick.get("spread")
                        if s is not None:
                            spread = float(s)
                    except (ValueError, TypeError):
                        pass

                # Extract home moneyline → implied probability
                home_ml_prob = None
                try:
                    home_ml = pick.get("homeTeamOdds", {}).get("moneyLine")
                    if home_ml is not None:
                        home_ml_prob = round(_moneyline_to_prob(float(home_ml)), 4)
                except (ValueError, TypeError):
                    pass

                if spread is None and home_ml_prob is None:
                    continue

                # Update training snapshots for this game (match by date + teams)
                game_date = current.strftime("%Y-%m-%d")
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
                    logger.error(f"Update failed for {away_team}@{home_team} {game_date}: {e}")

            current += timedelta(days=1)

        logger.info(f"  Season {season}: {season_updated}/{season_games} games updated")
        total_updated += season_updated

    logger.info(f"Total: {total_updated} games updated with ESPN odds")
    return total_updated
