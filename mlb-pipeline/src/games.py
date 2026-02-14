# mlb-pipeline/src/games.py
"""
MLB Games Pipeline:
Modes:
- full: backfill all regular season games 2020 to present (full upsert)
- current: games from 3 days ago to today + tomorrow (delta upsert)
  Designed to run many times per day to capture newly posted lineups.

Data sources:
- MLB Schedule API: game metadata, scores, statuses
- MLB Live Feed API: lineups (1-9 batting order), SP, bullpen per game
"""

import sys
from pathlib import Path
from datetime import datetime, timedelta, timezone

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT))

from shared.mlb.mlb_constants import TEAM_ID_TO_NAME

import os
import logging
import pandas as pd
import numpy as np
import requests
from supabase import create_client, Client
from dotenv import load_dotenv
from tqdm import tqdm
from concurrent.futures import ThreadPoolExecutor, as_completed
from time import sleep
import random
from urllib3.util.retry import Retry
from requests.adapters import HTTPAdapter
import functools

load_dotenv()

logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)
logging.getLogger("supabase").setLevel(logging.WARNING)
logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_KEY")
if not SUPABASE_URL or not SUPABASE_KEY:
    raise ValueError("Missing Supabase env vars")

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

MLB_SCHEDULE_URL = "https://statsapi.mlb.com/api/v1/schedule"
MLB_GAME_FEED_URL = "https://statsapi.mlb.com/api/v1.1/game/{gamePk}/feed/live"

GAME_STATUS_SCHEDULED = 1
GAME_STATUS_LIVE = 2
GAME_STATUS_FINAL = 3
GAME_STATUS_POSTPONED = 4

UPSERT_BATCH_SIZE = 500


# ---------------------------------------------------------------------------
# Rate-limit-safe HTTP session
# ---------------------------------------------------------------------------
def create_session():
    session = requests.Session()
    retry_strategy = Retry(
        total=3,
        backoff_factor=2,
        status_forcelist=[429, 500, 502, 503, 504],
        allowed_methods=["GET"],
    )
    adapter = HTTPAdapter(max_retries=retry_strategy)
    session.mount("https://", adapter)
    return session

SESSION = create_session()


# ---------------------------------------------------------------------------
# 1. Fetch schedule from MLB API
# ---------------------------------------------------------------------------
def fetch_schedule(start_date, end_date):
    """Fetch all games from MLB schedule API for a date range.
    Returns list of game dicts with basic metadata."""
    games = []
    try:
        resp = SESSION.get(MLB_SCHEDULE_URL, params={
            "sportId": 1,
            "startDate": start_date,
            "endDate": end_date,
            "gameType": "R",  # Regular season only
            "hydrate": "linescore",
        }, timeout=30)
        resp.raise_for_status()
        data = resp.json()

        for date_entry in data.get("dates", []):
            for game in date_entry.get("games", []):
                game_pk = game.get("gamePk")
                status = game.get("status", {})
                detailed_state = status.get("detailedState", "")
                abstract_state = status.get("abstractGameState", "")

                # Map status
                if detailed_state in ("Postponed", "Suspended", "Cancelled"):
                    game_status = GAME_STATUS_POSTPONED
                elif abstract_state == "Final":
                    game_status = GAME_STATUS_FINAL
                elif abstract_state == "Live":
                    game_status = GAME_STATUS_LIVE
                else:
                    game_status = GAME_STATUS_SCHEDULED

                away_team = game.get("teams", {}).get("away", {}).get("team", {})
                home_team = game.get("teams", {}).get("home", {}).get("team", {})

                # Scores from linescore
                linescore = game.get("linescore", {})
                home_runs = linescore.get("teams", {}).get("home", {}).get("runs")
                away_runs = linescore.get("teams", {}).get("away", {}).get("runs")

                # Fallback to teams score
                if home_runs is None:
                    home_runs = game.get("teams", {}).get("home", {}).get("score")
                if away_runs is None:
                    away_runs = game.get("teams", {}).get("away", {}).get("score")

                game_outcome = None
                if game_status == GAME_STATUS_FINAL and home_runs is not None and away_runs is not None:
                    if home_runs > away_runs:
                        game_outcome = 1  # home win
                    elif away_runs > home_runs:
                        game_outcome = 0  # away win

                total_runs = None
                if home_runs is not None and away_runs is not None:
                    total_runs = home_runs + away_runs

                game_date = game.get("officialDate") or game.get("gameDate", "")[:10]
                season = int(game_date[:4]) if game_date else None

                games.append({
                    "GAME_ID": game_pk,
                    "SEASON_ID": season,
                    "GAME_DATE": game_date,
                    "AWAY_NAME": TEAM_ID_TO_NAME.get(away_team.get("id"), away_team.get("name")),
                    "HOME_NAME": TEAM_ID_TO_NAME.get(home_team.get("id"), home_team.get("name")),
                    "AWAY_ID": away_team.get("id"),
                    "HOME_ID": home_team.get("id"),
                    "GAME_STATUS": game_status,
                    "GAME_OUTCOME": game_outcome,
                    "AWAY_RUNS": away_runs,
                    "HOME_RUNS": home_runs,
                    "TOTAL_RUNS": total_runs,
                })

    except Exception as e:
        logger.error(f"Schedule fetch failed for {start_date} to {end_date}: {e}")

    logger.info(f"  {len(games)} games from schedule {start_date} to {end_date}")
    return games


# ---------------------------------------------------------------------------
# 2. Fetch lineups from live feed API (per game)
# ---------------------------------------------------------------------------
def fetch_lineup(game_pk):
    """Fetch lineup data for a single game from the live feed API.
    Returns dict with HOME_LINEUP, AWAY_LINEUP, HOME_SP, AWAY_SP, HOME_BULLPEN, AWAY_BULLPEN."""
    result = {
        "HOME_LINEUP": [],
        "AWAY_LINEUP": [],
        "HOME_SP": None,
        "AWAY_SP": None,
        "HOME_BULLPEN": [],
        "AWAY_BULLPEN": [],
    }

    try:
        sleep(random.uniform(0.05, 0.15))
        url = MLB_GAME_FEED_URL.format(gamePk=game_pk)
        resp = SESSION.get(url, timeout=15)
        resp.raise_for_status()
        data = resp.json()

        boxscore = data.get("liveData", {}).get("boxscore", {}).get("teams", {})

        for side, prefix in [("home", "HOME"), ("away", "AWAY")]:
            team_data = boxscore.get(side, {})
            players = team_data.get("players", {})

            # Extract batting lineup (battingOrder 100-900)
            lineup = {}
            for player_key, player_info in players.items():
                batting_order = player_info.get("battingOrder")
                if batting_order is not None:
                    try:
                        order_int = int(batting_order)
                        if order_int % 100 == 0 and 100 <= order_int <= 900:
                            order_pos = order_int // 100
                            lineup[order_pos] = player_info["person"]["id"]
                    except (ValueError, KeyError):
                        pass

            # Build ordered lineup array (positions 1-9)
            result[f"{prefix}_LINEUP"] = [lineup.get(i) for i in range(1, 10)]

            # Starting pitcher (first in pitchers list)
            pitchers_list = team_data.get("pitchers", [])
            if pitchers_list:
                result[f"{prefix}_SP"] = pitchers_list[0]

            # Bullpen
            bullpen_ids = team_data.get("bullpen", [])
            # Also add relief pitchers (all pitchers except SP)
            relief = pitchers_list[1:] if len(pitchers_list) > 1 else []
            all_bp = list(set(bullpen_ids + relief))
            result[f"{prefix}_BULLPEN"] = all_bp

    except Exception as e:
        logger.debug(f"Lineup fetch failed for game {game_pk}: {e}")

    return result


def fetch_lineups_parallel(game_pks):
    """Fetch lineups for multiple games in parallel."""
    lineups = {}
    with ThreadPoolExecutor(max_workers=8) as executor:
        futures = {executor.submit(fetch_lineup, pk): pk for pk in game_pks}
        for future in tqdm(as_completed(futures), total=len(futures), desc="Fetching lineups", unit="game"):
            pk = futures[future]
            try:
                lineups[pk] = future.result()
            except Exception as e:
                logger.error(f"Lineup future failed for {pk}: {e}")
                lineups[pk] = {}
    return lineups


# ---------------------------------------------------------------------------
# 3. Merge games + lineups
# ---------------------------------------------------------------------------
def merge_games_and_lineups(games_list, lineups_dict):
    """Merge schedule data with lineup data into final records."""
    for game in games_list:
        pk = game["GAME_ID"]
        lineup = lineups_dict.get(pk, {})
        game["HOME_LINEUP"] = lineup.get("HOME_LINEUP", [])
        game["AWAY_LINEUP"] = lineup.get("AWAY_LINEUP", [])
        game["HOME_SP"] = lineup.get("HOME_SP")
        game["AWAY_SP"] = lineup.get("AWAY_SP")
        game["HOME_BULLPEN"] = lineup.get("HOME_BULLPEN", [])
        game["AWAY_BULLPEN"] = lineup.get("AWAY_BULLPEN", [])
    return games_list


# ---------------------------------------------------------------------------
# 4. Supabase interaction
# ---------------------------------------------------------------------------
def fetch_db_games(game_ids=None, season_ids=None):
    """Fetch existing games from Supabase."""
    try:
        query = supabase.table("mlb_games").select("*")
        if game_ids:
            batch_size = 200
            all_data = []
            for i in range(0, len(game_ids), batch_size):
                batch = game_ids[i:i + batch_size]
                resp = supabase.table("mlb_games").select("*").in_("GAME_ID", batch).execute()
                if resp.data:
                    all_data.extend(resp.data)
            return all_data
        elif season_ids:
            query = query.in_("SEASON_ID", season_ids)
        response = query.execute()
        return response.data or []
    except Exception as e:
        logger.error(f"Failed to fetch DB games: {e}")
        return []


def find_deltas(new_games, db_games):
    """Find games that are new or changed compared to DB."""
    if not db_games:
        return new_games

    db_map = {g["GAME_ID"]: g for g in db_games}
    deltas = []

    compare_fields = [
        "GAME_STATUS", "GAME_OUTCOME", "HOME_RUNS", "AWAY_RUNS", "TOTAL_RUNS",
        "HOME_SP", "AWAY_SP",
    ]
    list_fields = ["HOME_LINEUP", "AWAY_LINEUP", "HOME_BULLPEN", "AWAY_BULLPEN"]

    for game in new_games:
        pk = game["GAME_ID"]
        db_game = db_map.get(pk)

        if db_game is None:
            deltas.append(game)
            continue

        changed = False
        for field in compare_fields:
            new_val = game.get(field)
            db_val = db_game.get(field)
            if new_val != db_val and (new_val is not None or db_val is not None):
                changed = True
                break

        if not changed:
            for field in list_fields:
                new_val = game.get(field, [])
                db_val = db_game.get(field, [])
                # Filter out Nones for comparison
                new_clean = [x for x in (new_val or []) if x is not None]
                db_clean = [x for x in (db_val or []) if x is not None]
                if new_clean != db_clean:
                    changed = True
                    break

        if changed:
            deltas.append(game)

    return deltas


def _clean_payload(game):
    """Convert game dict to a Supabase-safe payload."""
    payload = {
        "GAME_ID": int(game["GAME_ID"]),
        "SEASON_ID": int(game["SEASON_ID"]) if game.get("SEASON_ID") else None,
        "GAME_DATE": game.get("GAME_DATE"),
        "AWAY_NAME": game.get("AWAY_NAME"),
        "HOME_NAME": game.get("HOME_NAME"),
        "AWAY_ID": int(game["AWAY_ID"]) if game.get("AWAY_ID") else None,
        "HOME_ID": int(game["HOME_ID"]) if game.get("HOME_ID") else None,
        "GAME_STATUS": int(game["GAME_STATUS"]) if game.get("GAME_STATUS") is not None else GAME_STATUS_SCHEDULED,
        "GAME_OUTCOME": int(game["GAME_OUTCOME"]) if game.get("GAME_OUTCOME") is not None else None,
        "AWAY_RUNS": int(game["AWAY_RUNS"]) if game.get("AWAY_RUNS") is not None else None,
        "HOME_RUNS": int(game["HOME_RUNS"]) if game.get("HOME_RUNS") is not None else None,
        "TOTAL_RUNS": int(game["TOTAL_RUNS"]) if game.get("TOTAL_RUNS") is not None else None,
        "HOME_LINEUP": [int(x) for x in game.get("HOME_LINEUP", []) if x is not None] or [],
        "AWAY_LINEUP": [int(x) for x in game.get("AWAY_LINEUP", []) if x is not None] or [],
        "HOME_SP": int(game["HOME_SP"]) if game.get("HOME_SP") else None,
        "AWAY_SP": int(game["AWAY_SP"]) if game.get("AWAY_SP") else None,
        "HOME_BULLPEN": [int(x) for x in game.get("HOME_BULLPEN", []) if x is not None] or [],
        "AWAY_BULLPEN": [int(x) for x in game.get("AWAY_BULLPEN", []) if x is not None] or [],
    }
    return payload


def upsert_games(games_list):
    """Upsert games to Supabase in batches."""
    if not games_list:
        logger.info("No games to upsert")
        return

    payloads = [_clean_payload(g) for g in games_list]
    success = 0

    with tqdm(total=len(payloads), desc="Upserting games") as pbar:
        for i in range(0, len(payloads), UPSERT_BATCH_SIZE):
            batch = payloads[i:i + UPSERT_BATCH_SIZE]
            try:
                supabase.table("mlb_games").upsert(batch, on_conflict="GAME_ID").execute()
                success += len(batch)
            except Exception as e:
                logger.warning(f"Batch upsert failed: {e}")
                for payload in batch:
                    try:
                        supabase.table("mlb_games").upsert(payload, on_conflict="GAME_ID").execute()
                        success += 1
                    except Exception as row_err:
                        logger.error(f"Row upsert failed GAME_ID={payload['GAME_ID']}: {row_err}")
            pbar.update(len(batch))

    logger.info(f"Upserted {success}/{len(payloads)} games")


# ---------------------------------------------------------------------------
# 5. Mode implementations
# ---------------------------------------------------------------------------
def run_full_mode():
    """Full backfill: 2020 to present."""
    current_year = datetime.now().year
    all_games = []

    logger.info("Step 1: Fetching schedule for all seasons...")
    for year in range(2020, current_year + 1):
        start = f"{year}-01-01"
        end = f"{year}-12-31" if year < current_year else datetime.now().strftime("%Y-%m-%d")
        games = fetch_schedule(start, end)
        all_games.extend(games)

    if not all_games:
        logger.info("No games found")
        return

    # Deduplicate by GAME_ID
    seen = set()
    unique_games = []
    for g in all_games:
        if g["GAME_ID"] not in seen:
            seen.add(g["GAME_ID"])
            unique_games.append(g)
    all_games = unique_games
    logger.info(f"  {len(all_games)} unique games across all seasons")

    logger.info("Step 2: Fetching lineups for all games...")
    game_pks = [g["GAME_ID"] for g in all_games]
    lineups = fetch_lineups_parallel(game_pks)

    logger.info("Step 3: Merging games + lineups...")
    all_games = merge_games_and_lineups(all_games, lineups)

    logger.info(f"Step 4: Upserting {len(all_games)} games...")
    upsert_games(all_games)


def run_current_mode():
    """Games from 3 days ago to tomorrow. Delta upsert."""
    now = datetime.now(timezone.utc)
    date_from = (now - timedelta(days=3)).strftime("%Y-%m-%d")
    date_to = (now + timedelta(days=1)).strftime("%Y-%m-%d")
    logger.info(f"Current mode: {date_from} to {date_to}")

    logger.info("Step 1: Fetching schedule...")
    games = fetch_schedule(date_from, date_to)

    if not games:
        logger.info("No games in range")
        return

    logger.info("Step 2: Fetching lineups...")
    game_pks = [g["GAME_ID"] for g in games]
    lineups = fetch_lineups_parallel(game_pks)

    logger.info("Step 3: Merging games + lineups...")
    games = merge_games_and_lineups(games, lineups)

    logger.info("Step 4: Finding deltas...")
    db_games = fetch_db_games(game_ids=game_pks)
    deltas = find_deltas(games, db_games)
    logger.info(f"  {len(deltas)} deltas found")

    if deltas:
        logger.info(f"Step 5: Upserting {len(deltas)} changed games...")
        upsert_games(deltas)
    else:
        logger.info("No changes to upsert")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "current"

    if mode == "full":
        print("\n=== FULL MODE: backfill 2020 to present ===")
        run_full_mode()
    elif mode == "current":
        print("\n=== CURRENT MODE: last 3 days + today (delta) ===")
        run_current_mode()
    else:
        print(f"Unknown mode: {mode}. Use 'full' or 'current'.")
        sys.exit(1)


if __name__ == "__main__":
    main()
