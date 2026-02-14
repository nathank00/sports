# mlb-pipeline/src/playerstats.py
"""
MLB Player Stats Pipeline:
Modes:
- full: backfill all player game logs 2020 to present (delete + insert)
- current: stats for players in games from last 3 days (delta upsert)

Data source: MLB Stats API per-player gameLog endpoint
Each row = one player's batting OR pitching statline in one game.
Composite key: id = "{GAME_ID}_{PLAYER_ID}_{STAT_TYPE}"
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

MLB_PLAYER_STATS_URL = "https://statsapi.mlb.com/api/v1/people/{player_id}/stats"
MLB_SCHEDULE_URL = "https://statsapi.mlb.com/api/v1/schedule"

UPSERT_BATCH_SIZE = 500
PAGE_SIZE = 1000

# Stat field mappings
BATTING_FIELDS = {
    "atBats": "AB", "hits": "H", "runs": "R", "doubles": "DOUBLES",
    "triples": "TRIPLES", "homeRuns": "HR", "rbi": "RBI",
    "baseOnBalls": "BB", "strikeOuts": "SO", "stolenBases": "SB",
    "caughtStealing": "CS", "hitByPitch": "HBP", "sacFlies": "SF",
    "plateAppearances": "PA", "avg": "BA", "obp": "OBP",
    "slg": "SLG", "ops": "OPS",
}

PITCHING_FIELDS = {
    "inningsPitched": "IP", "hits": "H_P", "runs": "R_P",
    "earnedRuns": "ER", "baseOnBalls": "BB_P", "strikeOuts": "SO_P",
    "homeRuns": "HR_P", "battersFaced": "BF", "pitchesThrown": "PIT",
    "era": "ERA",
}


def create_session():
    session = requests.Session()
    retry_strategy = Retry(
        total=3, backoff_factor=2,
        status_forcelist=[429, 500, 502, 503, 504],
        allowed_methods=["GET"],
    )
    adapter = HTTPAdapter(max_retries=retry_strategy)
    session.mount("https://", adapter)
    return session

SESSION = create_session()


def make_id(game_id, player_id, stat_type):
    return f"{game_id}_{player_id}_{stat_type}"


# ---------------------------------------------------------------------------
# 1. Fetch player gamelogs from MLB API
# ---------------------------------------------------------------------------
def fetch_player_gamelog(player_id, group, seasons):
    """Fetch game log for a single player for given seasons.
    group: 'hitting' or 'pitching'
    Returns list of normalized stat dicts."""
    rows = []

    for season in seasons:
        try:
            sleep(random.uniform(0.05, 0.15))
            resp = SESSION.get(
                MLB_PLAYER_STATS_URL.format(player_id=player_id),
                params={"stats": "gameLog", "group": group, "season": season},
                timeout=15,
            )
            resp.raise_for_status()
            data = resp.json()

            stats_list = data.get("stats", [])
            if not stats_list or not stats_list[0].get("splits"):
                continue

            field_map = BATTING_FIELDS if group == "hitting" else PITCHING_FIELDS
            stat_type = "batting" if group == "hitting" else "pitching"

            for split in stats_list[0]["splits"]:
                raw = split.get("stat", {})
                game_info = split.get("game", {})
                team_info = split.get("team", {})
                opponent_info = split.get("opponent", {})

                game_pk = game_info.get("gamePk")
                if not game_pk:
                    continue

                row = {
                    "GAME_ID": game_pk,
                    "PLAYER_ID": player_id,
                    "GAME_DATE": split.get("date"),
                    "SEASON_ID": season,
                    "TEAM_ID": team_info.get("id"),
                    "OPPONENT_ID": opponent_info.get("id"),
                    "IS_HOME": split.get("isHome", None),
                    "STAT_TYPE": stat_type,
                }

                # Map stat fields
                for api_key, col_name in field_map.items():
                    val = raw.get(api_key)
                    row[col_name] = val

                # Compute WHIP for pitching
                if stat_type == "pitching":
                    ip = raw.get("inningsPitched")
                    h = raw.get("hits", 0)
                    bb = raw.get("baseOnBalls", 0)
                    if ip and float(ip) > 0:
                        row["WHIP"] = round((h + bb) / float(ip), 3)

                row["id"] = make_id(game_pk, player_id, stat_type)
                rows.append(row)

        except Exception as e:
            logger.debug(f"GameLog failed player={player_id} group={group} season={season}: {e}")

    return rows


def fetch_player_all_stats(player_id, player_type, seasons):
    """Fetch all relevant stats for a player based on their type."""
    rows = []

    if player_type in ("batter", "two_way"):
        rows.extend(fetch_player_gamelog(player_id, "hitting", seasons))

    if player_type in ("pitcher", "two_way"):
        rows.extend(fetch_player_gamelog(player_id, "pitching", seasons))

    return rows


# ---------------------------------------------------------------------------
# 2. Supabase helpers
# ---------------------------------------------------------------------------
def fetch_paginated(table, select, filters=None, order_col=None):
    all_rows = []
    offset = 0
    while True:
        query = supabase.table(table).select(select)
        for method, col, val in (filters or []):
            query = getattr(query, method)(col, val)
        if order_col:
            query = query.order(order_col)
        query = query.range(offset, offset + PAGE_SIZE - 1)
        response = query.execute()
        batch = response.data or []
        all_rows.extend(batch)
        if len(batch) < PAGE_SIZE:
            break
        offset += PAGE_SIZE
    return all_rows


def fetch_db_playerstats(game_ids=None):
    """Fetch existing playerstats from DB for given game IDs."""
    if game_ids:
        all_data = []
        batch_size = 200
        for i in range(0, len(game_ids), batch_size):
            batch = game_ids[i:i + batch_size]
            resp = supabase.table("mlb_playerstats").select("id,GAME_ID,PLAYER_ID,STAT_TYPE").in_("GAME_ID", batch).execute()
            if resp.data:
                all_data.extend(resp.data)
        return all_data
    return []


def _clean_payload(row):
    """Convert stat row to Supabase-safe payload."""
    def safe_int(val):
        if val is None or (isinstance(val, float) and np.isnan(val)):
            return None
        try:
            return int(val)
        except (ValueError, TypeError):
            return None

    def safe_float(val):
        if val is None or (isinstance(val, float) and np.isnan(val)):
            return None
        try:
            v = float(val)
            if np.isinf(v):
                return None
            return round(v, 3)
        except (ValueError, TypeError):
            return None

    return {
        "id": row["id"],
        "GAME_ID": safe_int(row.get("GAME_ID")),
        "PLAYER_ID": safe_int(row.get("PLAYER_ID")),
        "GAME_DATE": row.get("GAME_DATE"),
        "SEASON_ID": safe_int(row.get("SEASON_ID")),
        "TEAM_ID": safe_int(row.get("TEAM_ID")),
        "OPPONENT_ID": safe_int(row.get("OPPONENT_ID")),
        "IS_HOME": row.get("IS_HOME"),
        "STAT_TYPE": row.get("STAT_TYPE"),
        "AB": safe_int(row.get("AB")),
        "H": safe_int(row.get("H")),
        "R": safe_int(row.get("R")),
        "DOUBLES": safe_int(row.get("DOUBLES")),
        "TRIPLES": safe_int(row.get("TRIPLES")),
        "HR": safe_int(row.get("HR")),
        "RBI": safe_int(row.get("RBI")),
        "BB": safe_int(row.get("BB")),
        "SO": safe_int(row.get("SO")),
        "SB": safe_int(row.get("SB")),
        "CS": safe_int(row.get("CS")),
        "HBP": safe_int(row.get("HBP")),
        "SF": safe_int(row.get("SF")),
        "PA": safe_int(row.get("PA")),
        "BA": safe_float(row.get("BA")),
        "OBP": safe_float(row.get("OBP")),
        "SLG": safe_float(row.get("SLG")),
        "OPS": safe_float(row.get("OPS")),
        "IP": safe_float(row.get("IP")),
        "H_P": safe_int(row.get("H_P")),
        "R_P": safe_int(row.get("R_P")),
        "ER": safe_int(row.get("ER")),
        "BB_P": safe_int(row.get("BB_P")),
        "SO_P": safe_int(row.get("SO_P")),
        "HR_P": safe_int(row.get("HR_P")),
        "BF": safe_int(row.get("BF")),
        "PIT": safe_int(row.get("PIT")),
        "ERA": safe_float(row.get("ERA")),
        "WHIP": safe_float(row.get("WHIP")),
    }


def upsert_playerstats(rows):
    """Upsert playerstats to Supabase in batches."""
    if not rows:
        logger.info("No playerstats to upsert")
        return

    payloads = [_clean_payload(r) for r in rows]
    success = 0

    with tqdm(total=len(payloads), desc="Upserting playerstats") as pbar:
        for i in range(0, len(payloads), UPSERT_BATCH_SIZE):
            batch = payloads[i:i + UPSERT_BATCH_SIZE]
            try:
                supabase.table("mlb_playerstats").upsert(batch, on_conflict="id").execute()
                success += len(batch)
            except Exception as e:
                logger.warning(f"Batch upsert failed: {e}")
                for payload in batch:
                    try:
                        supabase.table("mlb_playerstats").upsert(payload, on_conflict="id").execute()
                        success += 1
                    except Exception as row_err:
                        logger.error(f"Row failed id={payload.get('id')}: {row_err}")
            pbar.update(len(batch))

    logger.info(f"Upserted {success}/{len(payloads)} playerstats rows")


# ---------------------------------------------------------------------------
# 3. Mode implementations
# ---------------------------------------------------------------------------
def run_full_mode():
    """Full backfill: all players x all seasons 2020 to present."""
    current_year = datetime.now().year
    seasons = list(range(2020, current_year + 1))

    logger.info("Loading all players from DB...")
    players = fetch_paginated("mlb_players", "PLAYER_ID,PLAYER_TYPE", order_col="PLAYER_ID")
    if not players:
        logger.error("No players in DB. Run players.py full first.")
        return
    logger.info(f"  {len(players)} players to process")

    # No pre-delete needed — upsert with on_conflict="id" will overwrite existing rows.
    # Deleting 400k+ rows often times out on Supabase's default statement timeout.
    logger.info("Skipping pre-delete (upsert handles conflicts)...")

    all_rows = []
    errors = []

    def process_player(player):
        pid = player["PLAYER_ID"]
        ptype = player.get("PLAYER_TYPE", "batter")
        try:
            return fetch_player_all_stats(pid, ptype, seasons)
        except Exception as e:
            return f"Error player {pid}: {e}"

    with ThreadPoolExecutor(max_workers=8) as executor:
        futures = {executor.submit(process_player, p): p for p in players}
        for future in tqdm(as_completed(futures), total=len(futures), desc="Fetching player stats", unit="player"):
            result = future.result()
            if isinstance(result, str):
                errors.append(result)
            elif result:
                all_rows.extend(result)

    if errors:
        logger.warning(f"  {len(errors)} errors during fetch")

    # Deduplicate by id
    seen = set()
    unique_rows = []
    for r in all_rows:
        if r["id"] not in seen:
            seen.add(r["id"])
            unique_rows.append(r)

    logger.info(f"  {len(unique_rows)} unique stat rows to insert")
    upsert_playerstats(unique_rows)


def run_current_mode():
    """Stats for players in games from last 3 days. Delta upsert."""
    now = datetime.now(timezone.utc)
    date_from = (now - timedelta(days=3)).strftime("%Y-%m-%d")
    date_to = (now + timedelta(days=1)).strftime("%Y-%m-%d")
    current_year = datetime.now().year
    seasons = [current_year]

    logger.info(f"Current mode: {date_from} to {date_to}")

    # Get recent games from mlb_games to find player IDs
    logger.info("Fetching recent games from DB...")
    games = fetch_paginated("mlb_games",
        "GAME_ID,HOME_LINEUP,AWAY_LINEUP,HOME_SP,AWAY_SP,HOME_BULLPEN,AWAY_BULLPEN",
        [("gte", "GAME_DATE", date_from), ("lte", "GAME_DATE", date_to)],
        order_col="GAME_ID")

    if not games:
        logger.info("No recent games found")
        return

    # Collect all player IDs from lineups
    player_ids = set()
    for g in games:
        for field in ["HOME_LINEUP", "AWAY_LINEUP", "HOME_BULLPEN", "AWAY_BULLPEN"]:
            for pid in (g.get(field) or []):
                if pid:
                    player_ids.add(int(pid))
        for field in ["HOME_SP", "AWAY_SP"]:
            pid = g.get(field)
            if pid:
                player_ids.add(int(pid))

    if not player_ids:
        logger.info("No player IDs found in recent games")
        return

    logger.info(f"  {len(player_ids)} unique players from recent games")

    # Load player types from DB
    players_db = fetch_paginated("mlb_players", "PLAYER_ID,PLAYER_TYPE", order_col="PLAYER_ID")
    type_map = {p["PLAYER_ID"]: p.get("PLAYER_TYPE", "batter") for p in players_db}

    all_rows = []

    def process_player(pid):
        ptype = type_map.get(pid, "batter")
        try:
            return fetch_player_all_stats(pid, ptype, seasons)
        except Exception as e:
            return f"Error player {pid}: {e}"

    with ThreadPoolExecutor(max_workers=8) as executor:
        futures = {executor.submit(process_player, pid): pid for pid in player_ids}
        for future in tqdm(as_completed(futures), total=len(futures), desc="Fetching player stats", unit="player"):
            result = future.result()
            if isinstance(result, list):
                all_rows.extend(result)

    # Deduplicate
    seen = set()
    unique_rows = []
    for r in all_rows:
        if r["id"] not in seen:
            seen.add(r["id"])
            unique_rows.append(r)

    logger.info(f"  {len(unique_rows)} stat rows fetched")

    # Delta check
    game_ids = list(set(r["GAME_ID"] for r in unique_rows))
    existing = fetch_db_playerstats(game_ids)
    existing_ids = set(r["id"] for r in existing)

    deltas = [r for r in unique_rows if r["id"] not in existing_ids]
    logger.info(f"  {len(deltas)} new rows to upsert")

    if deltas:
        upsert_playerstats(deltas)
    else:
        logger.info("No changes to upsert")


def run_backfill_mode():
    """Find players who appear in games but have no playerstats rows, and fetch them."""
    current_year = datetime.now().year
    seasons = list(range(2020, current_year + 1))

    logger.info("=== BACKFILL MODE: fetching missing player stats ===")

    # Get all player IDs from games (lineups, SPs, bullpens)
    logger.info("Loading game rosters from DB...")
    games = fetch_paginated("mlb_games",
        "GAME_ID,HOME_LINEUP,AWAY_LINEUP,HOME_SP,AWAY_SP,HOME_BULLPEN,AWAY_BULLPEN", None,
        order_col="GAME_ID")

    game_pids = set()
    for g in games:
        for field in ["HOME_LINEUP", "AWAY_LINEUP", "HOME_BULLPEN", "AWAY_BULLPEN"]:
            for pid in (g.get(field) or []):
                if pid:
                    game_pids.add(int(pid))
        for field in ["HOME_SP", "AWAY_SP"]:
            pid = g.get(field)
            if pid:
                game_pids.add(int(pid))

    logger.info(f"  {len(game_pids)} unique players in game rosters")

    # Get all player IDs already in playerstats
    logger.info("Loading existing playerstats player IDs...")
    existing_rows = fetch_paginated("mlb_playerstats", "PLAYER_ID", None, order_col="PLAYER_ID")
    existing_pids = set(int(r["PLAYER_ID"]) for r in existing_rows)
    logger.info(f"  {len(existing_pids)} players already have stats")

    missing_pids = game_pids - existing_pids
    if not missing_pids:
        logger.info("All game roster players have stats — nothing to backfill")
        return

    logger.info(f"  {len(missing_pids)} players missing stats — fetching...")

    # Get player types
    players_db = fetch_paginated("mlb_players", "PLAYER_ID,PLAYER_TYPE", order_col="PLAYER_ID")
    type_map = {int(p["PLAYER_ID"]): p.get("PLAYER_TYPE", "batter") for p in players_db}

    all_rows = []
    errors = []

    def process_player(pid):
        ptype = type_map.get(pid, "batter")
        try:
            return fetch_player_all_stats(pid, ptype, seasons)
        except Exception as e:
            return f"Error player {pid}: {e}"

    with ThreadPoolExecutor(max_workers=8) as executor:
        futures = {executor.submit(process_player, pid): pid for pid in missing_pids}
        for future in tqdm(as_completed(futures), total=len(futures), desc="Backfilling player stats", unit="player"):
            result = future.result()
            if isinstance(result, str):
                errors.append(result)
            elif result:
                all_rows.extend(result)

    if errors:
        logger.warning(f"  {len(errors)} errors during fetch:")
        for err in errors[:20]:
            logger.warning(f"    {err}")

    # Deduplicate
    seen = set()
    unique_rows = []
    for r in all_rows:
        if r["id"] not in seen:
            seen.add(r["id"])
            unique_rows.append(r)

    logger.info(f"  {len(unique_rows)} new stat rows to upsert")
    if unique_rows:
        upsert_playerstats(unique_rows)
    logger.info("=== BACKFILL COMPLETE ===")


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "current"

    if mode == "full":
        print("\n=== FULL MODE: backfill 2020 to present ===")
        run_full_mode()
    elif mode == "current":
        print("\n=== CURRENT MODE: last 3 days (delta) ===")
        run_current_mode()
    elif mode == "backfill":
        run_backfill_mode()
    else:
        print(f"Unknown mode: {mode}. Use 'full', 'current', or 'backfill'.")
        sys.exit(1)


if __name__ == "__main__":
    main()
