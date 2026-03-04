"""Historical odds data ingestion for calibration.

Loads pregame spread and moneyline data from a Kaggle CSV and matches
it to games in the database. Backfills odds into training snapshots.

Expected CSV format (Kaggle NBA Betting Data):
  Columns include: Date, Home Team, Away Team, Home Spread, Home ML, Away ML, etc.
  Exact column names vary by dataset — this module handles common formats.
"""

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT))

import logging
import pandas as pd
import numpy as np
from tqdm import tqdm

from shared.nba.nba_constants import TEAM_ABBR_TO_FULL

logger = logging.getLogger(__name__)

# Common team name variations found in odds datasets
TEAM_NAME_ALIASES: dict[str, str] = {
    # Standard names
    **{v: v for v in TEAM_ABBR_TO_FULL.values()},
    # Common abbreviation styles
    **{k: v for k, v in TEAM_ABBR_TO_FULL.items()},
    # Common variations
    "LA Lakers": "Los Angeles Lakers",
    "LA Clippers": "Los Angeles Clippers",
    "GS Warriors": "Golden State Warriors",
    "Golden State": "Golden State Warriors",
    "NY Knicks": "New York Knicks",
    "New York": "New York Knicks",
    "SA Spurs": "San Antonio Spurs",
    "San Antonio": "San Antonio Spurs",
    "NO Pelicans": "New Orleans Pelicans",
    "New Orleans": "New Orleans Pelicans",
    "OKC Thunder": "Oklahoma City Thunder",
    "Oklahoma City": "Oklahoma City Thunder",
    "Portland": "Portland Trail Blazers",
    "Trail Blazers": "Portland Trail Blazers",
    "Timberwolves": "Minnesota Timberwolves",
    "Minnesota": "Minnesota Timberwolves",
    "76ers": "Philadelphia 76ers",
    "Sixers": "Philadelphia 76ers",
    "Philadelphia": "Philadelphia 76ers",
}


def moneyline_to_implied_prob(ml: float) -> float:
    """Convert American moneyline odds to implied probability.

    e.g., -150 -> 0.6, +200 -> 0.333
    """
    if ml < 0:
        return abs(ml) / (abs(ml) + 100)
    elif ml > 0:
        return 100 / (ml + 100)
    else:
        return 0.5


def normalize_team_name(name: str) -> str | None:
    """Normalize a team name to the canonical full name."""
    name = name.strip()
    if name in TEAM_NAME_ALIASES:
        return TEAM_NAME_ALIASES[name]

    # Try case-insensitive match
    lower = name.lower()
    for alias, canonical in TEAM_NAME_ALIASES.items():
        if alias.lower() == lower:
            return canonical

    # Try partial match (team city or mascot)
    for canonical in TEAM_ABBR_TO_FULL.values():
        if lower in canonical.lower() or canonical.lower() in lower:
            return canonical

    logger.warning(f"Could not normalize team name: '{name}'")
    return None


def load_kaggle_odds(csv_path: Path) -> pd.DataFrame:
    """Load and normalize a Kaggle NBA betting dataset.

    Handles common column naming conventions. Returns DataFrame with:
    - game_date (date string YYYY-MM-DD)
    - home_team (canonical full name)
    - away_team (canonical full name)
    - spread (home team spread, negative = home favored)
    - home_ml_prob (implied probability from moneyline)
    """
    df = pd.read_csv(csv_path)
    logger.info(f"Loaded {len(df)} rows from {csv_path}")
    logger.info(f"Columns: {list(df.columns)}")

    # Normalize column names to lowercase for matching
    col_map = {c: c.lower().strip() for c in df.columns}
    df = df.rename(columns=col_map)

    # Find date column
    date_col = _find_column(df, ["date", "game_date", "gamedate"])
    if not date_col:
        raise ValueError(f"Could not find date column. Available: {list(df.columns)}")

    # Find team columns
    home_col = _find_column(df, ["home team", "home_team", "hometeam", "home"])
    away_col = _find_column(df, ["away team", "away_team", "awayteam", "away", "visitor", "visitor team"])
    if not home_col or not away_col:
        raise ValueError(f"Could not find team columns. Available: {list(df.columns)}")

    # Find spread column
    spread_col = _find_column(df, ["home spread", "home_spread", "spread", "home_line", "homespread"])

    # Find moneyline columns
    home_ml_col = _find_column(df, ["home ml", "home_ml", "homeml", "home moneyline", "home_moneyline"])
    away_ml_col = _find_column(df, ["away ml", "away_ml", "awayml", "away moneyline", "away_moneyline", "visitor ml"])

    result_rows = []
    for _, row in df.iterrows():
        # Parse date
        date_str = str(row[date_col])
        try:
            # Try common date formats
            for fmt in ["%Y-%m-%d", "%m/%d/%Y", "%m/%d/%y", "%Y%m%d"]:
                try:
                    game_date = pd.to_datetime(date_str, format=fmt).strftime("%Y-%m-%d")
                    break
                except ValueError:
                    continue
            else:
                game_date = pd.to_datetime(date_str).strftime("%Y-%m-%d")
        except Exception:
            continue

        # Normalize team names
        home = normalize_team_name(str(row[home_col]))
        away = normalize_team_name(str(row[away_col]))
        if not home or not away:
            continue

        # Parse spread
        spread = None
        if spread_col:
            try:
                spread = float(row[spread_col])
            except (ValueError, TypeError):
                pass

        # Parse moneyline
        home_ml_prob = None
        if home_ml_col:
            try:
                ml = float(row[home_ml_col])
                home_ml_prob = moneyline_to_implied_prob(ml)
            except (ValueError, TypeError):
                pass

        result_rows.append({
            "game_date": game_date,
            "home_team": home,
            "away_team": away,
            "spread": spread,
            "home_ml_prob": home_ml_prob,
        })

    result_df = pd.DataFrame(result_rows)
    logger.info(f"Parsed {len(result_df)} odds records")
    return result_df


def _find_column(df: pd.DataFrame, candidates: list[str]) -> str | None:
    """Find a column in a DataFrame by trying multiple possible names."""
    cols = list(df.columns)
    for candidate in candidates:
        if candidate in cols:
            return candidate
        # Try partial match
        for col in cols:
            if candidate in col:
                return col
    return None


def match_odds_to_game_ids(
    odds_df: pd.DataFrame,
    outcomes: dict[str, dict],
) -> dict[str, dict]:
    """Match historical odds to game IDs using date + team name matching.

    Args:
        odds_df: DataFrame from load_kaggle_odds()
        outcomes: dict of game_id -> {home_team, away_team, home_win, game_date}

    Returns:
        dict of game_id -> {spread, home_ml_prob}
    """
    from shared.nba.nba_constants import TEAM_ABBR_TO_FULL

    # Reverse map: full name -> abbreviation
    name_to_abbr = {v: k for k, v in TEAM_ABBR_TO_FULL.items()}

    # Build lookup: (date, home_abbr, away_abbr) -> game_id
    game_lookup: dict[tuple, str] = {}
    for game_id, info in outcomes.items():
        date_str = str(info.get("game_date", "")).split("T")[0]
        game_lookup[(date_str, info["home_team"], info["away_team"])] = game_id

    matched: dict[str, dict] = {}
    match_count = 0

    for _, row in odds_df.iterrows():
        home_abbr = name_to_abbr.get(row["home_team"])
        away_abbr = name_to_abbr.get(row["away_team"])
        if not home_abbr or not away_abbr:
            continue

        key = (row["game_date"], home_abbr, away_abbr)
        game_id = game_lookup.get(key)
        if game_id:
            matched[game_id] = {
                "spread": row.get("spread"),
                "home_ml_prob": row.get("home_ml_prob"),
            }
            match_count += 1

    logger.info(f"Matched {match_count} / {len(odds_df)} odds records to game IDs")
    return matched


def backfill_snapshot_odds(odds: dict[str, dict]) -> int:
    """Update training snapshots with pregame odds data.

    Args:
        odds: dict of game_id -> {spread, home_ml_prob}

    Returns:
        Number of games updated.
    """
    from autopilot.src.db import supabase

    updated = 0
    for game_id, game_odds in tqdm(odds.items(), desc="Backfilling odds"):
        update_data = {}
        if game_odds.get("spread") is not None:
            update_data["pregame_spread"] = game_odds["spread"]
        if game_odds.get("home_ml_prob") is not None:
            update_data["pregame_home_ml_prob"] = game_odds["home_ml_prob"]

        if update_data:
            try:
                supabase.table("autopilot_training_snapshots").update(
                    update_data
                ).eq("game_id", game_id).execute()
                updated += 1
            except Exception as e:
                logger.error(f"Failed to update odds for {game_id}: {e}")

    logger.info(f"Updated odds for {updated} games")
    return updated
