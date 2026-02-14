# nba-pipeline/src/gamelogs.py
"""
NBA Game Logs Pipeline:
Generates one row per game with pre-game rolling team stats (last 10 / 30 games).
No current-game team aggregates → inference safe.

Modes:
- full:     backfill 2020-21 to present (delete + full insert)
- current:  process games from last 3 days to now+12h (delta upsert)

Computes rolling features from playerstats → team level → no leakage.
All data from Supabase (no NBA API calls).

Strategy:
1. Fetch all games + playerstats into memory (paginated reads).
2. Use HOME_TEAM_PLAYERS / AWAY_TEAM_PLAYERS arrays from games table to
   assign each player's stats to the correct side (home/away) per game.
3. Aggregate player stats → team-game level, compute rolling windows.
4. Merge rolling features with game metadata → one row per game.
5. Batch upsert to Supabase gamelogs table.
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
from shared.nba.nba_constants import TEAM_ABBR_TO_FULL, TEAM_NAME_TO_ID

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

COUNTING_STATS = ["FGM", "FGA", "FG3M", "FG3A", "FTM", "FTA",
                  "OREB", "DREB", "REB", "AST", "STL", "BLK",
                  "TOV", "PF", "PTS", "PLUS_MINUS"]

ROLLING_STATS = ["PTS", "REB", "AST", "STL", "BLK", "TOV", "PF",
                 "FG_PCT", "FG3_PCT", "FT_PCT", "PLUS_MINUS"]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def get_current_season_year():
    today = datetime.now(timezone.utc)
    return today.year - 1 if today.month < 7 else today.year


# ---------------------------------------------------------------------------
# 1. Paginated Supabase fetch
# ---------------------------------------------------------------------------
def fetch_paginated(table, select, filters=None, order_col=None):
    """Fetch all rows from a Supabase table using offset pagination.

    Args:
        table: table name
        select: column selection string
        filters: list of (method, column, value) tuples
                 e.g. [("gte", "GAME_DATE", "2024-01-01"), ("in_", "SEASON_ID", [2023, 2024])]
        order_col: column to ORDER BY for stable pagination (prevents row
                   skipping/duplication between pages)
    Returns:
        list of dicts (all rows)
    """
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
# 2. Fetch games and playerstats into DataFrames
# ---------------------------------------------------------------------------
def fetch_games(date_from=None, date_to=None, season_ids=None):
    """Fetch games with metadata and player roster arrays."""
    filters = []
    if date_from:
        filters.append(("gte", "GAME_DATE", date_from.isoformat()))
    if date_to:
        filters.append(("lte", "GAME_DATE", date_to.isoformat()))
    if season_ids:
        filters.append(("in_", "SEASON_ID", season_ids))

    rows = fetch_paginated("games", "*", filters, order_col="GAME_ID")
    if not rows:
        return pd.DataFrame()

    df = pd.DataFrame(rows)
    int_cols = ["GAME_ID", "SEASON_ID", "AWAY_ID", "HOME_ID",
                "GAME_STATUS", "GAME_OUTCOME", "AWAY_PTS", "HOME_PTS", "TOTAL_PTS"]
    for col in int_cols:
        if col in df.columns:
            df[col] = pd.to_numeric(df[col], errors="coerce").astype("Int64")
    df["GAME_DATE"] = pd.to_datetime(df["GAME_DATE"], utc=True)
    return df


def fetch_playerstats(date_from=None, date_to=None, season_ids=None):
    """Fetch all playerstats rows into a single DataFrame (paginated)."""
    select = ",".join([
        "GAME_ID", "GAME_DATE", "SEASON_ID", "PLAYER_ID", "MATCHUP",
        "FGM", "FGA", "FG3M", "FG3A", "FTM", "FTA",
        "OREB", "DREB", "REB", "AST", "STL", "BLK",
        "TOV", "PF", "PTS", "PLUS_MINUS", "WL",
    ])

    filters = []
    if date_from:
        filters.append(("gte", "GAME_DATE", date_from.isoformat()))
    if date_to:
        filters.append(("lte", "GAME_DATE", date_to.isoformat()))
    if season_ids:
        filters.append(("in_", "SEASON_ID", season_ids))

    logger.info("  Paginating playerstats from Supabase...")
    rows = fetch_paginated("playerstats", select, filters, order_col="GAME_ID")
    if not rows:
        return pd.DataFrame()

    logger.info(f"  Fetched {len(rows)} playerstats rows")
    df = pd.DataFrame(rows)

    int_cols = ["GAME_ID", "PLAYER_ID", "SEASON_ID"] + COUNTING_STATS
    for col in int_cols:
        if col in df.columns:
            df[col] = pd.to_numeric(df[col], errors="coerce").astype("Int64")

    df["GAME_DATE"] = pd.to_datetime(df["GAME_DATE"], utc=True)
    return df


# ---------------------------------------------------------------------------
# 3. Aggregate player stats → team-game level
# ---------------------------------------------------------------------------
def _extract_team_abbr(matchup):
    """Extract the player's team abbreviation from MATCHUP (e.g. 'LAL @ GSW' → 'LAL')."""
    if not isinstance(matchup, str):
        return None
    for sep in (" @ ", " vs. "):
        if sep in matchup:
            return matchup.split(sep)[0].strip()
    return None


def compute_team_games(games_df, playerstats_df):
    """Determine each player's side (home/away) from MATCHUP,
    then aggregate to team-level stats per game.

    Strategy for side assignment (vectorized):
    - Primary: parse team abbreviation from MATCHUP (e.g. 'LAL @ GSW' → player is on LAL).
      The MATCHUP string is per-player and always reflects the team they actually played for.
      Match the abbreviation against the game's HOME_ID/AWAY_ID to determine home/away side.
    - Fallback: WL + GAME_OUTCOME for any rows where MATCHUP parsing fails.

    Returns a DataFrame with columns:
        GAME_ID, TEAM_ID, GAME_DATE, SIDE, + aggregated stat columns + WIN
    Two rows per completed game (one home, one away).
    """
    if playerstats_df.empty or games_df.empty:
        return pd.DataFrame()

    # Build abbreviation → team ID lookup
    abbr_to_id = {}
    for abbr, full_name in TEAM_ABBR_TO_FULL.items():
        tid = TEAM_NAME_TO_ID.get(full_name)
        if tid:
            abbr_to_id[abbr] = int(tid)

    # Join playerstats with game-level HOME_ID, AWAY_ID, GAME_OUTCOME
    ps = playerstats_df.merge(
        games_df[["GAME_ID", "HOME_ID", "AWAY_ID", "GAME_OUTCOME"]],
        on="GAME_ID",
        how="inner",
    )

    if ps.empty:
        logger.warning("No playerstats matched any games")
        return pd.DataFrame()

    # --- Primary method: MATCHUP → team abbreviation → HOME/AWAY (vectorized) ---
    ps["_ABBR"] = ps["MATCHUP"].apply(_extract_team_abbr)
    ps["_ABBR_TID"] = ps["_ABBR"].map(abbr_to_id).astype("Int64")

    ps["SIDE"] = None
    ps["TEAM_ID"] = pd.array([pd.NA] * len(ps), dtype="Int64")

    mask_home = ps["_ABBR_TID"] == ps["HOME_ID"]
    mask_away = ps["_ABBR_TID"] == ps["AWAY_ID"]

    ps.loc[mask_home, "SIDE"] = "HOME"
    ps.loc[mask_home, "TEAM_ID"] = ps.loc[mask_home, "HOME_ID"]
    ps.loc[mask_away, "SIDE"] = "AWAY"
    ps.loc[mask_away, "TEAM_ID"] = ps.loc[mask_away, "AWAY_ID"]

    # --- Fallback: WL + GAME_OUTCOME for rows still unassigned ---
    unassigned = ps["SIDE"].isna()
    if unassigned.any():
        has_outcome = unassigned & ps["GAME_OUTCOME"].notna() & ps["WL"].isin(["W", "L"])
        home_win = ps["GAME_OUTCOME"] == 1

        fb_home = has_outcome & ((home_win & (ps["WL"] == "W")) | (~home_win & (ps["WL"] == "L")))
        fb_away = has_outcome & ((home_win & (ps["WL"] == "L")) | (~home_win & (ps["WL"] == "W")))

        ps.loc[fb_home, "SIDE"] = "HOME"
        ps.loc[fb_home, "TEAM_ID"] = ps.loc[fb_home, "HOME_ID"]
        ps.loc[fb_away, "SIDE"] = "AWAY"
        ps.loc[fb_away, "TEAM_ID"] = ps.loc[fb_away, "AWAY_ID"]

    ps.drop(columns=["_ABBR", "_ABBR_TID"], inplace=True)

    # Drop rows where we couldn't determine the side
    before = len(ps)
    ps = ps.dropna(subset=["SIDE"])
    dropped = before - len(ps)
    if dropped > 0:
        logger.warning(f"Dropped {dropped} playerstats rows — could not determine home/away side")

    if ps.empty:
        logger.warning("No playerstats could be assigned to home/away — check data consistency")
        return pd.DataFrame()

    ps["TEAM_ID"] = ps["TEAM_ID"].astype("Int64")
    ps.drop(columns=["HOME_ID", "AWAY_ID", "GAME_OUTCOME"], inplace=True)

    # Aggregate per (GAME_ID, SIDE, TEAM_ID)
    agg_dict = {stat: "sum" for stat in COUNTING_STATS}
    agg_dict["GAME_DATE"] = "first"
    agg_dict["WL"] = "first"

    team_df = ps.groupby(["GAME_ID", "SIDE", "TEAM_ID"]).agg(agg_dict).reset_index()

    # Shooting percentages from totals (not averaged per-player)
    team_df["FG_PCT"] = np.where(team_df["FGA"] > 0, team_df["FGM"] / team_df["FGA"], np.nan)
    team_df["FG3_PCT"] = np.where(team_df["FG3A"] > 0, team_df["FG3M"] / team_df["FG3A"], np.nan)
    team_df["FT_PCT"] = np.where(team_df["FTA"] > 0, team_df["FTM"] / team_df["FTA"], np.nan)

    # Win indicator from WL column
    team_df["WIN"] = (team_df["WL"] == "W").astype(int)

    return team_df


# ---------------------------------------------------------------------------
# 4. Compute rolling features (no leakage)
# ---------------------------------------------------------------------------
def add_rolling_features(team_df):
    """Compute rolling 10-game and 30-game averages per team.
    Uses shift(1) to exclude the current game → no leakage."""
    if team_df.empty:
        return team_df

    team_df = team_df.sort_values(["TEAM_ID", "GAME_DATE"]).reset_index(drop=True)

    for window in [10, 30]:
        for stat in ROLLING_STATS:
            col = f"{stat}_{window}"
            team_df[col] = (
                team_df.groupby("TEAM_ID")[stat]
                .transform(lambda x: x.shift(1).rolling(window, min_periods=1).mean())
            )

        team_df[f"WIN_RATE_{window}"] = (
            team_df.groupby("TEAM_ID")["WIN"]
            .transform(lambda x: x.shift(1).rolling(window, min_periods=1).mean())
        )

        team_df[f"GAMES_{window}"] = (
            team_df.groupby("TEAM_ID")["WIN"]
            .transform(lambda x: x.shift(1).rolling(window, min_periods=1).count())
            .astype("Int64")
        )

    return team_df


# ---------------------------------------------------------------------------
# 5. Build final gamelogs DataFrame
# ---------------------------------------------------------------------------
ROLLING_COLS = []
for _stat in ROLLING_STATS + ["WIN_RATE", "GAMES"]:
    for _w in [10, 30]:
        ROLLING_COLS.append(f"{_stat}_{_w}")

GAME_META_COLS = [
    "GAME_ID", "SEASON_ID", "GAME_DATE", "AWAY_NAME", "HOME_NAME",
    "AWAY_ID", "HOME_ID", "GAME_STATUS", "GAME_OUTCOME",
    "AWAY_PTS", "HOME_PTS", "TOTAL_PTS",
]


def _get_latest_rolling_by_team(team_df):
    """For each TEAM_ID, get the most recent rolling feature values.

    Used to fill in rolling stats for scheduled/upcoming games that have no
    playerstats yet. Returns dict: {team_id: {rolling_col: value, ...}}.
    """
    latest = {}
    sorted_df = team_df.sort_values("GAME_DATE")
    for team_id, group in sorted_df.groupby("TEAM_ID"):
        last_row = group.iloc[-1]
        # The rolling columns on the last row were computed with shift(1),
        # so they represent "rolling avg heading INTO that game" — they don't
        # include that game's stats. For a future game, we want the rolling
        # avg AFTER the last completed game, which means we need to re-compute
        # without the shift. Instead, we can just take the rolling values from
        # the last row and note that they exclude the last game. To include it,
        # we'd need the non-shifted rolling. But the simplest correct approach:
        # the last row's actual stats should be included in the rolling for
        # future games. So we build the "current" rolling from the raw data.
        #
        # Actually, the cleanest way: compute a non-shifted rolling on the last
        # N games. But that's complex. The pragmatic approach: for each rolling
        # column, take the value from the last row's rolling (which excludes
        # the last game) and blend in the last game's actual stat.
        #
        # Even simpler and correct: just compute the rolling on all rows without
        # shift, and take the last value. Let's do that here.
        vals = {}
        for window in [10, 30]:
            for stat in ROLLING_STATS:
                col = f"{stat}_{window}"
                # Compute rolling mean on the raw stat over the last N games
                raw = group[stat].tail(window)
                vals[col] = raw.mean() if len(raw) > 0 else None

            win_raw = group["WIN"].tail(window)
            vals[f"WIN_RATE_{window}"] = win_raw.mean() if len(win_raw) > 0 else None
            vals[f"GAMES_{window}"] = len(win_raw)

        latest[int(team_id)] = vals

    return latest


def build_gamelogs(games_df, team_df):
    """Merge rolling team features with game metadata.
    Produces one row per game with HOME_ and AWAY_ prefixed rolling columns.

    For scheduled/upcoming games without playerstats, carries forward each
    team's most recent rolling values (including their last completed game)."""
    if games_df.empty:
        return pd.DataFrame()

    if team_df.empty:
        # No team stats at all — return games with null rolling columns
        return games_df[GAME_META_COLS].copy()

    # Split team stats into home and away subsets
    home_stats = team_df[team_df["SIDE"] == "HOME"].copy()
    away_stats = team_df[team_df["SIDE"] == "AWAY"].copy()

    # Rename rolling columns with side prefix
    home_rename = {col: f"HOME_{col}" for col in ROLLING_COLS if col in home_stats.columns}
    away_rename = {col: f"AWAY_{col}" for col in ROLLING_COLS if col in away_stats.columns}

    home_stats = home_stats.rename(columns=home_rename)
    away_stats = away_stats.rename(columns=away_rename)

    # Keep only GAME_ID + renamed rolling columns for the merge
    home_keep = ["GAME_ID"] + list(home_rename.values())
    away_keep = ["GAME_ID"] + list(away_rename.values())

    home_stats = home_stats[[c for c in home_keep if c in home_stats.columns]]
    away_stats = away_stats[[c for c in away_keep if c in away_stats.columns]]

    # Merge: games ← home rolling ← away rolling
    result = games_df[GAME_META_COLS].merge(home_stats, on="GAME_ID", how="left")
    result = result.merge(away_stats, on="GAME_ID", how="left")

    # --- Fill scheduled/upcoming games with latest rolling values ---
    # These games have no playerstats, so the merge left their rolling cols null.
    # Use each team's most recent rolling stats (including their last game).
    home_rolling_cols = list(home_rename.values())
    away_rolling_cols = list(away_rename.values())
    any_rolling_col = home_rolling_cols[0] if home_rolling_cols else None

    if any_rolling_col:
        missing_mask = result[any_rolling_col].isna()
        if missing_mask.any():
            latest = _get_latest_rolling_by_team(team_df)
            for idx in result[missing_mask].index:
                home_id = result.loc[idx, "HOME_ID"]
                away_id = result.loc[idx, "AWAY_ID"]

                if pd.notna(home_id):
                    home_vals = latest.get(int(home_id), {})
                    for col in ROLLING_COLS:
                        prefixed = f"HOME_{col}"
                        if prefixed in result.columns and col in home_vals:
                            result.loc[idx, prefixed] = home_vals[col]

                if pd.notna(away_id):
                    away_vals = latest.get(int(away_id), {})
                    for col in ROLLING_COLS:
                        prefixed = f"AWAY_{col}"
                        if prefixed in result.columns and col in away_vals:
                            result.loc[idx, prefixed] = away_vals[col]

    return result


# ---------------------------------------------------------------------------
# 6. Prepare records for upsert (clean types for JSON serialization)
# ---------------------------------------------------------------------------
def prepare_records(df):
    """Convert DataFrame to list of dicts safe for Supabase JSON upsert."""
    df = df.copy()

    # GAME_DATE → ISO string
    if "GAME_DATE" in df.columns:
        df["GAME_DATE"] = df["GAME_DATE"].dt.strftime("%Y-%m-%dT%H:%M:%S+00:00")

    # Convert to Python-native dicts, then clean NaN/NA values
    records = df.to_dict(orient="records")
    for rec in records:
        for key, val in rec.items():
            if val is pd.NA or (isinstance(val, float) and np.isnan(val)):
                rec[key] = None
            elif isinstance(val, (np.integer,)):
                rec[key] = int(val)
            elif isinstance(val, (np.floating,)):
                rec[key] = round(float(val), 3)

    return records


# ---------------------------------------------------------------------------
# 7. Batch upsert
# ---------------------------------------------------------------------------
def upsert_gamelogs(records):
    if not records:
        logger.info("No gamelogs to upsert")
        return

    success = 0
    total = len(records)

    with tqdm(total=total, desc="Upserting gamelogs") as pbar:
        for i in range(0, total, UPSERT_BATCH_SIZE):
            batch = records[i:i + UPSERT_BATCH_SIZE]
            try:
                supabase.table("gamelogs").upsert(
                    batch, on_conflict="GAME_ID"
                ).execute()
                success += len(batch)
            except Exception as e:
                logger.error(f"Batch upsert failed: {e}")
                for row in batch:
                    try:
                        supabase.table("gamelogs").upsert(
                            row, on_conflict="GAME_ID"
                        ).execute()
                        success += 1
                    except Exception as re:
                        logger.error(f"Row failed GAME_ID={row.get('GAME_ID')}: {re}")
            pbar.update(len(batch))

    logger.info(f"Upserted {success}/{total} gamelogs rows")


# ---------------------------------------------------------------------------
# Modes
# ---------------------------------------------------------------------------
def run_full_mode():
    logger.info("=== FULL MODE: backfill 2020–present ===")
    current_year = get_current_season_year()
    season_years = list(range(2020, current_year + 1))

    # --- Step 1: Fetch all data into memory ---
    logger.info(f"Fetching games for seasons {season_years}...")
    games_df = fetch_games(season_ids=season_years)
    if games_df.empty:
        logger.info("No games found")
        return
    logger.info(f"  {len(games_df)} games loaded")

    logger.info("Fetching playerstats...")
    playerstats_df = fetch_playerstats(season_ids=season_years)
    if playerstats_df.empty:
        logger.info("No playerstats found")
        return
    logger.info(f"  {len(playerstats_df)} playerstats rows loaded")

    # --- Step 2: Compute in memory ---
    logger.info("Aggregating player stats → team-game level...")
    team_df = compute_team_games(games_df, playerstats_df)
    if team_df.empty:
        logger.info("No team-game data produced")
        return
    logger.info(f"  {len(team_df)} team-game rows")

    logger.info("Computing rolling features (10g / 30g)...")
    team_df = add_rolling_features(team_df)

    logger.info("Building gamelogs...")
    gamelogs_df = build_gamelogs(games_df, team_df)
    logger.info(f"  {len(gamelogs_df)} gamelog rows built")

    records = prepare_records(gamelogs_df)

    # --- Step 3: Delete + insert ---
    logger.info("Deleting all existing gamelogs...")
    supabase.table("gamelogs").delete().neq("GAME_ID", 0).execute()

    logger.info("Upserting...")
    upsert_gamelogs(records)
    logger.info("=== FULL MODE COMPLETE ===")


def run_current_mode():
    now = datetime.now(timezone.utc)
    date_from = now - timedelta(days=3)
    date_to = now + timedelta(hours=12)

    # Need ~90 days of history for the 30-game rolling window.
    # NBA teams play ~every other day, but All-Star break + schedule gaps
    # mean 65 days could yield <30 games. 90 days ≈ 45 games, safe margin.
    hist_from = now - timedelta(days=90)

    logger.info(f"=== CURRENT MODE: games {date_from.date()} to {date_to.date()} ===")

    # --- Step 1: Fetch target games ---
    games_df = fetch_games(date_from=date_from, date_to=date_to)
    if games_df.empty:
        logger.info("No games in date range")
        return
    logger.info(f"  {len(games_df)} target games")

    # --- Step 2: Fetch historical playerstats for rolling windows ---
    # We need playerstats going back 65 days so the rolling windows have data.
    # But we also need to know which teams are involved to scope the history.
    # Since we need team-level rolling, fetch ALL playerstats in the 65-day window
    # (all teams play within that window, and it's only ~15k rows).
    logger.info(f"Fetching playerstats from {hist_from.date()} to {date_to.date()}...")
    playerstats_df = fetch_playerstats(date_from=hist_from, date_to=date_to)
    if playerstats_df.empty:
        logger.info("No playerstats found in history window")
        return
    logger.info(f"  {len(playerstats_df)} playerstats rows loaded")

    # We also need the historical games so compute_team_games can match
    # playerstats to HOME_ID/AWAY_ID for side assignment.
    logger.info("Fetching historical games for side assignment...")
    all_games_df = fetch_games(date_from=hist_from, date_to=date_to)
    logger.info(f"  {len(all_games_df)} games (including history)")

    # --- Step 3: Compute in memory ---
    logger.info("Aggregating player stats → team-game level...")
    team_df = compute_team_games(all_games_df, playerstats_df)
    if team_df.empty:
        logger.info("No team-game data produced")
        return

    logger.info("Computing rolling features (10g / 30g)...")
    team_df = add_rolling_features(team_df)

    # Build gamelogs only for target games (not the full history)
    logger.info("Building gamelogs for target games...")
    gamelogs_df = build_gamelogs(games_df, team_df)
    logger.info(f"  {len(gamelogs_df)} gamelog rows built")

    records = prepare_records(gamelogs_df)

    # --- Step 4: Upsert (overwrite existing, insert new) ---
    logger.info("Upserting...")
    upsert_gamelogs(records)
    logger.info("=== CURRENT MODE COMPLETE ===")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    if len(sys.argv) < 2:
        mode = "current"
    else:
        mode = sys.argv[1].lower()

    if mode == "full":
        run_full_mode()
    elif mode == "current":
        run_current_mode()
    else:
        print("Usage: python gamelogs.py [full|current]")
        sys.exit(1)


if __name__ == "__main__":
    main()
