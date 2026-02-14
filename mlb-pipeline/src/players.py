# mlb-pipeline/src/players.py
"""
MLB Players Pipeline:
Modes:
- full: backfill all players 2020 to present
- current: current season only, delta upsert

Data source: MLB Stats API /sports/1/players endpoint
"""

import sys
from pathlib import Path
from datetime import datetime

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT))

from shared.mlb.mlb_constants import TEAM_ID_TO_NAME

import os
import logging
import pandas as pd
import requests
from supabase import create_client, Client
from dotenv import load_dotenv
from tqdm import tqdm

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

MLB_PLAYERS_URL = "https://statsapi.mlb.com/api/v1/sports/1/players"

PITCHER_POSITIONS = {"P", "SP", "RP"}
TWP_POSITION = "TWP"


def fetch_players_for_season(season):
    """Fetch all players for a given season from MLB API."""
    try:
        resp = requests.get(MLB_PLAYERS_URL, params={"season": season}, timeout=30)
        resp.raise_for_status()
        people = resp.json().get("people", [])
        logger.info(f"  {len(people)} players from MLB API for {season}")

        players = []
        for p in people:
            player_id = p.get("id")
            full_name = p.get("fullName")
            position = p.get("primaryPosition", {}).get("abbreviation", "UNK")
            team = p.get("currentTeam", {})
            team_id = team.get("id")
            team_name = TEAM_ID_TO_NAME.get(team_id, team.get("name"))

            if position in PITCHER_POSITIONS:
                player_type = "pitcher"
            elif position == TWP_POSITION:
                player_type = "two_way"
            else:
                player_type = "batter"

            players.append({
                "PLAYER_ID": player_id,
                "FULL_NAME": full_name,
                "TEAM_ID": team_id,
                "TEAM_NAME": team_name,
                "POSITION": position,
                "PLAYER_TYPE": player_type,
            })

        return players
    except Exception as e:
        logger.error(f"Failed to fetch players for {season}: {e}")
        return []


def fetch_db_players():
    """Fetch all existing players from Supabase."""
    try:
        all_data = []
        offset = 0
        page_size = 1000
        while True:
            resp = supabase.table("mlb_players").select("*").range(offset, offset + page_size - 1).execute()
            batch = resp.data or []
            all_data.extend(batch)
            if len(batch) < page_size:
                break
            offset += page_size
        return all_data
    except Exception as e:
        logger.error(f"Failed to fetch DB players: {e}")
        return []


def find_deltas(new_players, db_players):
    """Find players that are new or changed."""
    if not db_players:
        return new_players

    db_map = {p["PLAYER_ID"]: p for p in db_players}
    deltas = []

    for p in new_players:
        db_p = db_map.get(p["PLAYER_ID"])
        if db_p is None:
            deltas.append(p)
            continue

        changed = False
        for field in ["FULL_NAME", "TEAM_ID", "TEAM_NAME", "POSITION", "PLAYER_TYPE"]:
            if p.get(field) != db_p.get(field):
                changed = True
                break

        if changed:
            deltas.append(p)

    return deltas


def upsert_players(players_list):
    """Upsert players to Supabase in batches."""
    if not players_list:
        logger.info("No players to upsert")
        return

    payloads = []
    for p in players_list:
        payloads.append({
            "PLAYER_ID": int(p["PLAYER_ID"]),
            "FULL_NAME": p.get("FULL_NAME"),
            "TEAM_ID": int(p["TEAM_ID"]) if p.get("TEAM_ID") else None,
            "TEAM_NAME": p.get("TEAM_NAME"),
            "POSITION": p.get("POSITION"),
            "PLAYER_TYPE": p.get("PLAYER_TYPE"),
        })

    success = 0
    batch_size = 500

    with tqdm(total=len(payloads), desc="Upserting players") as pbar:
        for i in range(0, len(payloads), batch_size):
            batch = payloads[i:i + batch_size]
            try:
                supabase.table("mlb_players").upsert(batch, on_conflict="PLAYER_ID").execute()
                success += len(batch)
            except Exception as e:
                logger.warning(f"Batch upsert failed: {e}")
                for payload in batch:
                    try:
                        supabase.table("mlb_players").upsert(payload, on_conflict="PLAYER_ID").execute()
                        success += 1
                    except Exception as row_err:
                        logger.error(f"Row failed PLAYER_ID={payload['PLAYER_ID']}: {row_err}")
            pbar.update(len(batch))

    logger.info(f"Upserted {success}/{len(payloads)} players")


def run_full_mode():
    """Full backfill: 2020 to present."""
    current_year = datetime.now().year
    all_players = {}

    logger.info("Fetching players for all seasons...")
    for year in range(2020, current_year + 1):
        players = fetch_players_for_season(year)
        for p in players:
            # Keep latest version per player
            all_players[p["PLAYER_ID"]] = p

    players_list = list(all_players.values())
    logger.info(f"  {len(players_list)} unique players across all seasons")

    logger.info("Upserting all players...")
    upsert_players(players_list)


def run_current_mode():
    """Current season only, delta upsert."""
    current_year = datetime.now().year

    logger.info(f"Fetching players for {current_year}...")
    new_players = fetch_players_for_season(current_year)

    if not new_players:
        logger.info("No players found")
        return

    logger.info("Fetching existing players from DB...")
    db_players = fetch_db_players()
    logger.info(f"  {len(db_players)} players in DB")

    deltas = find_deltas(new_players, db_players)
    logger.info(f"  {len(deltas)} deltas found")

    if deltas:
        upsert_players(deltas)
    else:
        logger.info("No changes to upsert")


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "current"

    if mode == "full":
        print("\n=== FULL MODE: backfill 2020 to present ===")
        run_full_mode()
    elif mode == "current":
        print("\n=== CURRENT MODE: current season (delta) ===")
        run_current_mode()
    else:
        print(f"Unknown mode: {mode}. Use 'full' or 'current'.")
        sys.exit(1)


if __name__ == "__main__":
    main()
