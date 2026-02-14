# mlb-pipeline/src/gamelogs.py
"""
MLB Game Logs Pipeline:
Generates one row per game with pre-game rolling features.
Individual player rolling stats → weighted team features.

Modes:
- full:    backfill 2020 to present (delete + full insert)
- current: games from last 3 days (delta upsert), 120-day history window

Rolling features:
- Batting: weighted average of lineup's 1-9 individual rolling stats
  (linear weights: batter 1 = 9/45, ..., batter 9 = 1/45)
- Starting Pitcher: individual rolling stats for the SP
- Bullpen: average rolling stats across bullpen pitchers
- Team: WIN_RATE and GAMES count

All data from Supabase (no MLB API calls). No data leakage (shift(1)).
"""

import sys
from pathlib import Path
from datetime import datetime, timedelta, timezone

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT))

import os
import logging
import pandas as pd
import numpy as np
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

PAGE_SIZE = 1000
UPSERT_BATCH_SIZE = 400

# Batting stats for rolling averages
BATTING_ROLLING_STATS = ["BA", "OBP", "SLG", "OPS", "R", "HR", "RBI", "BB", "SO", "SB"]

# Pitching stats for rolling averages
# Keys = source columns in playerstats, values = output names for gamelogs
PITCHING_STAT_MAP = {"ERA": "ERA", "WHIP": "WHIP", "SO_P": "SO", "BB_P": "BB", "HR_P": "HR", "IP": "IP"}
PITCHING_ROLLING_STATS = list(PITCHING_STAT_MAP.keys())  # source columns
PITCHING_OUTPUT_STATS = list(PITCHING_STAT_MAP.values())  # gamelog column names

# Rolling windows
WINDOWS = [10, 50]

# Lineup weights: batter 1 = 9, batter 2 = 8, ..., batter 9 = 1
LINEUP_WEIGHTS = np.array([9, 8, 7, 6, 5, 4, 3, 2, 1], dtype=float)
LINEUP_WEIGHTS_NORM = LINEUP_WEIGHTS / LINEUP_WEIGHTS.sum()  # sum to 1.0


# ---------------------------------------------------------------------------
# Paginated Supabase fetch
# ---------------------------------------------------------------------------
def fetch_paginated(table, select, filters=None, order_col=None):
    """Paginated Supabase fetch. order_col ensures stable pagination —
    without it, rows can shift between pages causing data loss."""
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


# ---------------------------------------------------------------------------
# 1. Fetch games and playerstats from Supabase
# ---------------------------------------------------------------------------
def fetch_games(date_from=None, date_to=None, season_ids=None):
    filters = []
    if date_from:
        filters.append(("gte", "GAME_DATE", date_from.isoformat()))
    if date_to:
        filters.append(("lte", "GAME_DATE", date_to.isoformat()))
    if season_ids:
        filters.append(("in_", "SEASON_ID", season_ids))

    rows = fetch_paginated("mlb_games", "*", filters, order_col="GAME_ID")
    if not rows:
        return pd.DataFrame()

    df = pd.DataFrame(rows)
    for col in ["GAME_ID", "SEASON_ID", "AWAY_ID", "HOME_ID", "GAME_STATUS",
                 "GAME_OUTCOME", "AWAY_RUNS", "HOME_RUNS", "TOTAL_RUNS",
                 "HOME_SP", "AWAY_SP"]:
        if col in df.columns:
            df[col] = pd.to_numeric(df[col], errors="coerce").astype("Int64")
    df["GAME_DATE"] = pd.to_datetime(df["GAME_DATE"], utc=True)
    return df


def fetch_batting_stats(date_from=None, date_to=None, season_ids=None):
    """Fetch batting playerstats."""
    filters = [("eq", "STAT_TYPE", "batting")]
    if date_from:
        filters.append(("gte", "GAME_DATE", date_from.isoformat()))
    if date_to:
        filters.append(("lte", "GAME_DATE", date_to.isoformat()))
    if season_ids:
        filters.append(("in_", "SEASON_ID", season_ids))

    select = ",".join([
        "GAME_ID", "PLAYER_ID", "GAME_DATE", "TEAM_ID", "OPPONENT_ID", "IS_HOME",
        "AB", "H", "R", "HR", "RBI", "BB", "SO", "SB", "PA",
        "BA", "OBP", "SLG", "OPS",
    ])
    rows = fetch_paginated("mlb_playerstats", select + ",id", filters, order_col="id")
    if not rows:
        return pd.DataFrame()
    df = pd.DataFrame(rows)
    df["GAME_DATE"] = pd.to_datetime(df["GAME_DATE"], utc=True)
    for col in ["GAME_ID", "PLAYER_ID", "TEAM_ID"]:
        if col in df.columns:
            df[col] = pd.to_numeric(df[col], errors="coerce").astype("Int64")
    for col in BATTING_ROLLING_STATS:
        if col in df.columns:
            df[col] = pd.to_numeric(df[col], errors="coerce")
    return df


def fetch_pitching_stats(date_from=None, date_to=None, season_ids=None):
    """Fetch pitching playerstats."""
    filters = [("eq", "STAT_TYPE", "pitching")]
    if date_from:
        filters.append(("gte", "GAME_DATE", date_from.isoformat()))
    if date_to:
        filters.append(("lte", "GAME_DATE", date_to.isoformat()))
    if season_ids:
        filters.append(("in_", "SEASON_ID", season_ids))

    select = ",".join([
        "GAME_ID", "PLAYER_ID", "GAME_DATE", "TEAM_ID", "OPPONENT_ID", "IS_HOME",
        "IP", "H_P", "R_P", "ER", "BB_P", "SO_P", "HR_P", "BF", "PIT",
        "ERA", "WHIP",
    ])
    rows = fetch_paginated("mlb_playerstats", select + ",id", filters, order_col="id")
    if not rows:
        return pd.DataFrame()
    df = pd.DataFrame(rows)
    df["GAME_DATE"] = pd.to_datetime(df["GAME_DATE"], utc=True)
    for col in ["GAME_ID", "PLAYER_ID", "TEAM_ID"]:
        if col in df.columns:
            df[col] = pd.to_numeric(df[col], errors="coerce").astype("Int64")
    for col in PITCHING_ROLLING_STATS:
        if col in df.columns:
            df[col] = pd.to_numeric(df[col], errors="coerce")
    return df


# ---------------------------------------------------------------------------
# 2. Compute individual player rolling stats
# ---------------------------------------------------------------------------
def compute_player_batting_rolling(batting_df):
    """Compute per-player rolling batting averages. shift(1) = no leakage."""
    if batting_df.empty:
        return {}

    batting_df = batting_df.sort_values(["PLAYER_ID", "GAME_DATE", "GAME_ID"]).reset_index(drop=True)

    player_rolling = {}  # {player_id: {game_id: {stat_window: value}}}

    for pid, group in batting_df.groupby("PLAYER_ID"):
        player_rolling[int(pid)] = {}
        for _, row in group.iterrows():
            gid = int(row["GAME_ID"])
            player_rolling[int(pid)][gid] = {}

        for window in WINDOWS:
            for stat in BATTING_ROLLING_STATS:
                if stat not in group.columns:
                    continue
                rolled = group[stat].shift(1).rolling(window, min_periods=1).mean()
                for i, (_, row) in enumerate(group.iterrows()):
                    gid = int(row["GAME_ID"])
                    val = rolled.iloc[i]
                    player_rolling[int(pid)][gid][f"{stat}_{window}"] = val if pd.notna(val) else None

    return player_rolling


def compute_player_pitching_rolling(pitching_df):
    """Compute per-player rolling pitching averages. shift(1) = no leakage."""
    if pitching_df.empty:
        return {}

    pitching_df = pitching_df.sort_values(["PLAYER_ID", "GAME_DATE", "GAME_ID"]).reset_index(drop=True)

    player_rolling = {}

    for pid, group in pitching_df.groupby("PLAYER_ID"):
        player_rolling[int(pid)] = {}
        for _, row in group.iterrows():
            gid = int(row["GAME_ID"])
            player_rolling[int(pid)][gid] = {}

        for window in WINDOWS:
            for src_stat, out_stat in PITCHING_STAT_MAP.items():
                if src_stat not in group.columns:
                    continue
                rolled = group[src_stat].shift(1).rolling(window, min_periods=1).mean()
                for i, (_, row) in enumerate(group.iterrows()):
                    gid = int(row["GAME_ID"])
                    val = rolled.iloc[i]
                    player_rolling[int(pid)][gid][f"{out_stat}_{window}"] = val if pd.notna(val) else None

    return player_rolling


def get_latest_player_rolling(player_rolling_dict):
    """Get the most recent rolling values for each player (for future games).
    Returns {player_id: {stat_window: value}}."""
    latest = {}
    for pid, games in player_rolling_dict.items():
        if not games:
            continue
        # Get the last game_id (highest)
        last_gid = max(games.keys())
        latest[pid] = games[last_gid]
    return latest


# ---------------------------------------------------------------------------
# 3. Compute team-level win rate rolling
# ---------------------------------------------------------------------------
def compute_team_win_rolling(games_df):
    """Compute per-team rolling win rate from completed games.
    Returns {team_id: {game_id: {WIN_RATE_W: val, GAMES_W: val}}}."""
    completed = games_df[games_df["GAME_STATUS"].isin([3, 4])].copy()
    if completed.empty:
        return {}, {}

    # Build team-game records (one per team per game)
    records = []
    for _, row in completed.iterrows():
        gid = row["GAME_ID"]
        gdate = row["GAME_DATE"]
        outcome = row["GAME_OUTCOME"]

        if pd.isna(outcome):
            continue

        outcome_int = int(outcome)
        if pd.notna(row["HOME_ID"]):
            records.append({
                "TEAM_ID": int(row["HOME_ID"]),
                "GAME_ID": int(gid),
                "GAME_DATE": gdate,
                "WIN": 1 if outcome_int == 1 else 0,
            })
        if pd.notna(row["AWAY_ID"]):
            records.append({
                "TEAM_ID": int(row["AWAY_ID"]),
                "GAME_ID": int(gid),
                "GAME_DATE": gdate,
                "WIN": 1 if outcome_int == 0 else 0,
            })

    if not records:
        return {}, {}

    tdf = pd.DataFrame(records).sort_values(["TEAM_ID", "GAME_DATE", "GAME_ID"]).reset_index(drop=True)

    team_rolling = {}  # {team_id: {game_id: {stat: val}}}
    team_latest = {}   # {team_id: {stat: val}}

    for tid, group in tdf.groupby("TEAM_ID"):
        team_rolling[int(tid)] = {}
        for _, row in group.iterrows():
            gid = int(row["GAME_ID"])
            team_rolling[int(tid)][gid] = {}

        for window in WINDOWS:
            wr = group["WIN"].shift(1).rolling(window, min_periods=1).mean()
            gc = group["WIN"].shift(1).rolling(window, min_periods=1).count()

            for i, (_, row) in enumerate(group.iterrows()):
                gid = int(row["GAME_ID"])
                team_rolling[int(tid)][gid][f"WIN_RATE_{window}"] = wr.iloc[i] if pd.notna(wr.iloc[i]) else None
                team_rolling[int(tid)][gid][f"GAMES_{window}"] = int(gc.iloc[i]) if pd.notna(gc.iloc[i]) else None

        # Latest values for future games
        last_gid = max(team_rolling[int(tid)].keys())
        team_latest[int(tid)] = team_rolling[int(tid)][last_gid]

    return team_rolling, team_latest


# ---------------------------------------------------------------------------
# 4. Build gamelogs with features
# ---------------------------------------------------------------------------
def build_gamelogs(games_df, batting_rolling, pitching_rolling, team_win_rolling,
                   batting_latest, pitching_latest, team_win_latest):
    """Build final gamelogs DataFrame with all rolling features."""
    records = []

    for _, game in games_df.iterrows():
        gid = int(game["GAME_ID"])
        # Convert lineup/bullpen arrays to plain Python lists of ints
        def to_int_list(arr):
            if arr is None:
                return None
            lst = list(arr) if not isinstance(arr, list) else arr
            if not lst:
                return None
            return [int(x) for x in lst if x is not None and not (isinstance(x, float) and np.isnan(x))] or None

        rec = {
            "GAME_ID": gid,
            "SEASON_ID": int(game["SEASON_ID"]) if pd.notna(game.get("SEASON_ID")) else None,
            "GAME_DATE": game["GAME_DATE"].isoformat() if pd.notna(game.get("GAME_DATE")) else None,
            "AWAY_NAME": game.get("AWAY_NAME"),
            "HOME_NAME": game.get("HOME_NAME"),
            "AWAY_ID": int(game["AWAY_ID"]) if pd.notna(game.get("AWAY_ID")) else None,
            "HOME_ID": int(game["HOME_ID"]) if pd.notna(game.get("HOME_ID")) else None,
            "GAME_STATUS": int(game["GAME_STATUS"]) if pd.notna(game.get("GAME_STATUS")) else 1,
            "GAME_OUTCOME": int(game["GAME_OUTCOME"]) if pd.notna(game.get("GAME_OUTCOME")) else None,
            "AWAY_RUNS": int(game["AWAY_RUNS"]) if pd.notna(game.get("AWAY_RUNS")) else None,
            "HOME_RUNS": int(game["HOME_RUNS"]) if pd.notna(game.get("HOME_RUNS")) else None,
            "TOTAL_RUNS": int(game["TOTAL_RUNS"]) if pd.notna(game.get("TOTAL_RUNS")) else None,
            "HOME_SP": int(game["HOME_SP"]) if pd.notna(game.get("HOME_SP")) else None,
            "AWAY_SP": int(game["AWAY_SP"]) if pd.notna(game.get("AWAY_SP")) else None,
            "HOME_LINEUP": to_int_list(game.get("HOME_LINEUP")),
            "AWAY_LINEUP": to_int_list(game.get("AWAY_LINEUP")),
            "HOME_BULLPEN": to_int_list(game.get("HOME_BULLPEN")),
            "AWAY_BULLPEN": to_int_list(game.get("AWAY_BULLPEN")),
        }

        for side in ["HOME", "AWAY"]:
            lineup = game.get(f"{side}_LINEUP", []) or []
            sp_id = game.get(f"{side}_SP")
            bullpen = game.get(f"{side}_BULLPEN", []) or []
            team_id = int(game[f"{side}_ID"]) if pd.notna(game.get(f"{side}_ID")) else None

            # --- Batting features: weighted average of lineup's rolling stats ---
            for window in WINDOWS:
                for stat in BATTING_ROLLING_STATS:
                    col = f"{side}_{stat}_{window}"
                    values = []
                    weights = []

                    for i, pid in enumerate(lineup[:9]):
                        if pid is None or (isinstance(pid, float) and np.isnan(pid)):
                            continue
                        pid = int(pid)
                        # Try game-specific rolling, fall back to latest
                        player_games = batting_rolling.get(pid, {})
                        player_vals = player_games.get(gid) or batting_latest.get(pid, {})
                        val = player_vals.get(f"{stat}_{window}")
                        if val is not None:
                            values.append(val)
                            weights.append(LINEUP_WEIGHTS_NORM[i])

                    if values:
                        w = np.array(weights)
                        v = np.array(values)
                        w_norm = w / w.sum()  # re-normalize for available batters
                        rec[col] = round(float(np.dot(w_norm, v)), 3)
                    else:
                        rec[col] = None

            # --- SP features: individual rolling stats ---
            if pd.notna(sp_id):
                sp_id = int(sp_id)
                sp_games = pitching_rolling.get(sp_id, {})
                sp_vals = sp_games.get(gid) or pitching_latest.get(sp_id, {})

                for window in WINDOWS:
                    for stat in PITCHING_OUTPUT_STATS:
                        col = f"{side}_SP_{stat}_{window}"
                        rec[col] = sp_vals.get(f"{stat}_{window}")
                        if rec[col] is not None:
                            rec[col] = round(float(rec[col]), 3)
            else:
                for window in WINDOWS:
                    for stat in PITCHING_OUTPUT_STATS:
                        rec[f"{side}_SP_{stat}_{window}"] = None

            # --- Bullpen features: average across bullpen pitchers ---
            for window in WINDOWS:
                for stat in PITCHING_OUTPUT_STATS:
                    col = f"{side}_BP_{stat}_{window}"
                    values = []

                    for pid in (bullpen or []):
                        if pid is None or (isinstance(pid, float) and np.isnan(pid)):
                            continue
                        pid = int(pid)
                        p_games = pitching_rolling.get(pid, {})
                        p_vals = p_games.get(gid) or pitching_latest.get(pid, {})
                        val = p_vals.get(f"{stat}_{window}")
                        if val is not None:
                            values.append(val)

                    if values:
                        rec[col] = round(float(np.mean(values)), 3)
                    else:
                        rec[col] = None

            # --- Team win rate ---
            if team_id:
                team_games = team_win_rolling.get(team_id, {})
                team_vals = team_games.get(gid) or team_win_latest.get(team_id, {})

                for window in WINDOWS:
                    wr_col = f"{side}_WIN_RATE_{window}"
                    gc_col = f"{side}_GAMES_{window}"
                    rec[wr_col] = team_vals.get(f"WIN_RATE_{window}")
                    rec[gc_col] = team_vals.get(f"GAMES_{window}")
                    if rec[wr_col] is not None:
                        rec[wr_col] = round(float(rec[wr_col]), 3)
            else:
                for window in WINDOWS:
                    rec[f"{side}_WIN_RATE_{window}"] = None
                    rec[f"{side}_GAMES_{window}"] = None

        records.append(rec)

    return records


# ---------------------------------------------------------------------------
# 5. Upsert gamelogs
# ---------------------------------------------------------------------------
def upsert_gamelogs(records):
    if not records:
        logger.info("No gamelogs to upsert")
        return

    # Clean NaN/NA values
    for rec in records:
        for key, val in rec.items():
            if isinstance(val, float) and (np.isnan(val) or np.isinf(val)):
                rec[key] = None
            elif val is pd.NA or val is pd.NaT:
                rec[key] = None
            elif isinstance(val, (np.integer,)):
                rec[key] = int(val)
            elif isinstance(val, (np.floating,)):
                rec[key] = round(float(val), 3) if not np.isnan(val) else None

    success = 0
    with tqdm(total=len(records), desc="Upserting gamelogs") as pbar:
        for i in range(0, len(records), UPSERT_BATCH_SIZE):
            batch = records[i:i + UPSERT_BATCH_SIZE]
            try:
                supabase.table("mlb_gamelogs").upsert(batch, on_conflict="GAME_ID").execute()
                success += len(batch)
            except Exception as e:
                logger.error(f"Batch upsert failed: {e}")
                for row in batch:
                    try:
                        supabase.table("mlb_gamelogs").upsert(row, on_conflict="GAME_ID").execute()
                        success += 1
                    except Exception as re:
                        logger.error(f"Row failed GAME_ID={row.get('GAME_ID')}: {re}")
            pbar.update(len(batch))

    logger.info(f"Upserted {success}/{len(records)} gamelog rows")


# ---------------------------------------------------------------------------
# Modes
# ---------------------------------------------------------------------------
def run_full_mode():
    logger.info("=== FULL MODE: backfill 2020 to present ===")
    current_year = datetime.now().year
    season_ids = list(range(2020, current_year + 1))

    logger.info("Fetching all games...")
    games_df = fetch_games(season_ids=season_ids)
    if games_df.empty:
        logger.info("No games found")
        return
    logger.info(f"  {len(games_df)} games loaded")

    logger.info("Fetching batting stats...")
    batting_df = fetch_batting_stats(season_ids=season_ids)
    logger.info(f"  {len(batting_df)} batting rows")

    logger.info("Fetching pitching stats...")
    pitching_df = fetch_pitching_stats(season_ids=season_ids)
    logger.info(f"  {len(pitching_df)} pitching rows")

    logger.info("Computing individual batting rolling stats...")
    batting_rolling = compute_player_batting_rolling(batting_df)
    batting_latest = get_latest_player_rolling(batting_rolling)
    logger.info(f"  {len(batting_rolling)} batters with rolling stats")

    logger.info("Computing individual pitching rolling stats...")
    pitching_rolling = compute_player_pitching_rolling(pitching_df)
    pitching_latest = get_latest_player_rolling(pitching_rolling)
    logger.info(f"  {len(pitching_rolling)} pitchers with rolling stats")

    logger.info("Computing team win rolling stats...")
    team_win_rolling, team_win_latest = compute_team_win_rolling(games_df)
    logger.info(f"  {len(team_win_rolling)} teams with win rolling stats")

    logger.info("Building gamelogs...")
    records = build_gamelogs(
        games_df, batting_rolling, pitching_rolling, team_win_rolling,
        batting_latest, pitching_latest, team_win_latest
    )
    logger.info(f"  {len(records)} gamelog records built")

    # Preserve existing predictions before rebuilding.
    # In full mode we do delete + insert, which would destroy predictions.
    # Read them first and carry them over into the new records.
    logger.info("Reading existing predictions to preserve...")
    pred_rows = []
    offset = 0
    while True:
        resp = (supabase.table("mlb_gamelogs")
                .select("GAME_ID,PREDICTION,PREDICTION_PCT")
                .filter("PREDICTION", "not.is", "null")
                .range(offset, offset + PAGE_SIZE - 1)
                .execute())
        batch = resp.data or []
        pred_rows.extend(batch)
        if len(batch) < PAGE_SIZE:
            break
        offset += PAGE_SIZE
    pred_map = {}
    for pr in pred_rows:
        gid = pr.get("GAME_ID")
        if gid is not None:
            pred_map[int(gid)] = {
                "PREDICTION": pr.get("PREDICTION"),
                "PREDICTION_PCT": pr.get("PREDICTION_PCT"),
            }
    logger.info(f"  {len(pred_map)} existing predictions to preserve")

    # Carry predictions into new records
    for rec in records:
        gid = rec.get("GAME_ID")
        if gid in pred_map:
            rec["PREDICTION"] = pred_map[gid]["PREDICTION"]
            rec["PREDICTION_PCT"] = pred_map[gid]["PREDICTION_PCT"]

    logger.info("Deleting existing gamelogs...")
    try:
        supabase.table("mlb_gamelogs").delete().neq("GAME_ID", 0).execute()
    except Exception as e:
        logger.error(f"Delete failed: {e}")

    logger.info("Upserting gamelogs...")
    upsert_gamelogs(records)
    logger.info("=== FULL MODE COMPLETE ===")


def run_current_mode():
    now = datetime.now(timezone.utc)
    date_from = now - timedelta(days=3)
    date_to = now + timedelta(days=1)

    # Need 120 days of history for 50-game rolling window
    hist_from = now - timedelta(days=120)

    logger.info(f"=== CURRENT MODE: games {date_from.date()} to {date_to.date()} ===")

    logger.info("Fetching target games...")
    games_df = fetch_games(date_from=date_from, date_to=date_to)
    if games_df.empty:
        logger.info("No games in date range")
        return
    logger.info(f"  {len(games_df)} target games")

    logger.info("Fetching all historical games for win rate...")
    all_games_df = fetch_games(date_from=hist_from, date_to=date_to)
    logger.info(f"  {len(all_games_df)} games (including history)")

    logger.info("Fetching batting stats (history window)...")
    batting_df = fetch_batting_stats(date_from=hist_from, date_to=date_to)
    logger.info(f"  {len(batting_df)} batting rows")

    logger.info("Fetching pitching stats (history window)...")
    pitching_df = fetch_pitching_stats(date_from=hist_from, date_to=date_to)
    logger.info(f"  {len(pitching_df)} pitching rows")

    logger.info("Computing individual batting rolling stats...")
    batting_rolling = compute_player_batting_rolling(batting_df)
    batting_latest = get_latest_player_rolling(batting_rolling)

    logger.info("Computing individual pitching rolling stats...")
    pitching_rolling = compute_player_pitching_rolling(pitching_df)
    pitching_latest = get_latest_player_rolling(pitching_rolling)

    logger.info("Computing team win rolling stats...")
    team_win_rolling, team_win_latest = compute_team_win_rolling(all_games_df)

    logger.info("Building gamelogs for target games...")
    records = build_gamelogs(
        games_df, batting_rolling, pitching_rolling, team_win_rolling,
        batting_latest, pitching_latest, team_win_latest
    )
    logger.info(f"  {len(records)} gamelog records built")

    logger.info("Upserting gamelogs...")
    upsert_gamelogs(records)
    logger.info("=== CURRENT MODE COMPLETE ===")


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "current"
    if mode == "full":
        run_full_mode()
    elif mode == "current":
        run_current_mode()
    else:
        print(f"Unknown mode: {mode}. Use 'full' or 'current'.")
        sys.exit(1)


if __name__ == "__main__":
    main()
