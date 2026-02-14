# mlb-pipeline/src/predict.py
"""
MLB Game Outcome Model — Prediction Script

Loads a trained XGBoost model and predicts outcomes for today's scheduled games.
- Reads scheduled gamelogs (GAME_STATUS=1) for today from Supabase
- Skips games that already have a prediction (PREDICTION is not null)
- Skips games missing rolling features (lineups not yet posted)
- Writes PREDICTION (1=home, 0=away) and PREDICTION_PCT (home win prob) to mlb_gamelogs
- Prints a formatted table of ALL today's predictions (new + existing)

Usage: python predict.py
"""

import sys
from pathlib import Path
from datetime import datetime
from zoneinfo import ZoneInfo

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT))
sys.path.insert(0, str(REPO_ROOT / "mlb-pipeline" / "src"))

import os
import logging
import pandas as pd
import numpy as np
import xgboost as xgb
from dotenv import load_dotenv

load_dotenv()

logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)
logging.getLogger("supabase").setLevel(logging.WARNING)
logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)

from gamelogs import fetch_paginated, supabase

MODEL_DIR = REPO_ROOT / "mlb-pipeline" / "models"
MODEL_PATH = MODEL_DIR / "mlb_winner.json"

# ---------------------------------------------------------------------------
# Feature definitions (must match train.py exactly)
# ---------------------------------------------------------------------------
BATTING_STATS = ["BA", "OBP", "SLG", "OPS", "R", "HR", "RBI", "BB", "SO", "SB"]
SP_STATS = ["ERA", "WHIP", "SO", "BB", "HR", "IP"]
BP_STATS = ["ERA", "WHIP", "SO", "BB", "HR", "IP"]
WINDOWS = [10, 50]

FEATURE_COLS = []
for side in ["HOME", "AWAY"]:
    for stat in BATTING_STATS:
        for w in WINDOWS:
            FEATURE_COLS.append(f"{side}_{stat}_{w}")
    for stat in SP_STATS:
        for w in WINDOWS:
            FEATURE_COLS.append(f"{side}_SP_{stat}_{w}")
    for stat in BP_STATS:
        for w in WINDOWS:
            FEATURE_COLS.append(f"{side}_BP_{stat}_{w}")
    for w in WINDOWS:
        FEATURE_COLS.append(f"{side}_WIN_RATE_{w}")
        FEATURE_COLS.append(f"{side}_GAMES_{w}")

DIFF_FEATURES = {
    "DIFF_OPS_10": ("HOME_OPS_10", "AWAY_OPS_10"),
    "DIFF_OPS_50": ("HOME_OPS_50", "AWAY_OPS_50"),
    "DIFF_BA_10": ("HOME_BA_10", "AWAY_BA_10"),
    "DIFF_BA_50": ("HOME_BA_50", "AWAY_BA_50"),
    "DIFF_SP_ERA_10": ("HOME_SP_ERA_10", "AWAY_SP_ERA_10"),
    "DIFF_SP_ERA_50": ("HOME_SP_ERA_50", "AWAY_SP_ERA_50"),
    "DIFF_SP_WHIP_10": ("HOME_SP_WHIP_10", "AWAY_SP_WHIP_10"),
    "DIFF_SP_WHIP_50": ("HOME_SP_WHIP_50", "AWAY_SP_WHIP_50"),
    "DIFF_BP_ERA_10": ("HOME_BP_ERA_10", "AWAY_BP_ERA_10"),
    "DIFF_BP_ERA_50": ("HOME_BP_ERA_50", "AWAY_BP_ERA_50"),
    "DIFF_WIN_RATE_10": ("HOME_WIN_RATE_10", "AWAY_WIN_RATE_10"),
    "DIFF_WIN_RATE_50": ("HOME_WIN_RATE_50", "AWAY_WIN_RATE_50"),
}

ALL_FEATURES = FEATURE_COLS + list(DIFF_FEATURES.keys())


# ---------------------------------------------------------------------------
# 1. Load model
# ---------------------------------------------------------------------------
def load_model(path):
    """Load XGBoost model from JSON file."""
    if not path.exists():
        logger.error(f"Model not found: {path}")
        logger.error("Run train.py first to generate the model.")
        sys.exit(1)

    model = xgb.XGBClassifier()
    model.load_model(str(path))
    logger.info(f"Model loaded from {path}")
    return model


# ---------------------------------------------------------------------------
# 2. Fetch today's scheduled games
# ---------------------------------------------------------------------------
def fetch_todays_games():
    """Fetch gamelogs for today's date with GAME_STATUS=1 (scheduled).

    "Today" is defined in US/Eastern time since MLB games are scheduled in ET.
    We fetch all scheduled games and filter to today's date.
    """
    eastern = ZoneInfo("America/New_York")
    now_et = datetime.now(eastern)
    today_date = now_et.date()

    # Fetch all scheduled games
    filters = [("eq", "GAME_STATUS", 1)]
    rows = fetch_paginated("mlb_gamelogs", "*", filters)
    if not rows:
        return pd.DataFrame()

    df = pd.DataFrame(rows)
    df["GAME_DATE"] = pd.to_datetime(df["GAME_DATE"], utc=True)
    df["GAME_ID"] = pd.to_numeric(df["GAME_ID"], errors="coerce").astype("Int64")
    df["PREDICTION"] = pd.to_numeric(df.get("PREDICTION"), errors="coerce")
    df["PREDICTION_PCT"] = pd.to_numeric(df.get("PREDICTION_PCT"), errors="coerce")

    # Filter to today's date
    df = df[df["GAME_DATE"].dt.date == today_date].copy()

    for col in FEATURE_COLS:
        if col in df.columns:
            df[col] = pd.to_numeric(df[col], errors="coerce")

    return df


# ---------------------------------------------------------------------------
# 3. Add derived features
# ---------------------------------------------------------------------------
def add_diff_features(df):
    """Add derived difference features (home minus away)."""
    for name, (home_col, away_col) in DIFF_FEATURES.items():
        if home_col in df.columns and away_col in df.columns:
            df[name] = df[home_col] - df[away_col]
        else:
            df[name] = np.nan
    return df


# ---------------------------------------------------------------------------
# 4. Predict and write back
# ---------------------------------------------------------------------------
def predict_and_write(model, games_df):
    """Predict outcomes for new games and write to Supabase.

    Returns:
        tuple: (new_predictions_df, skipped_count)
    """
    already_predicted = games_df[games_df["PREDICTION"].notna()].copy()
    new_games = games_df[games_df["PREDICTION"].isna()].copy()

    logger.info(f"  {len(already_predicted)} games already predicted")
    logger.info(f"  {len(new_games)} games need prediction")

    if new_games.empty:
        return pd.DataFrame(), 0

    new_games = add_diff_features(new_games)

    # Skip games missing roster data — both lineups (HOME_LINEUP, AWAY_LINEUP)
    # and both starting pitchers (HOME_SP, AWAY_SP) must be present. Without
    # these the key features are empty and we'd be making blind predictions.
    def has_roster_data(row):
        home_lu = row.get("HOME_LINEUP")
        away_lu = row.get("AWAY_LINEUP")
        home_sp = row.get("HOME_SP")
        away_sp = row.get("AWAY_SP")
        has_lineups = (home_lu is not None and isinstance(home_lu, list) and len(home_lu) > 0 and
                       away_lu is not None and isinstance(away_lu, list) and len(away_lu) > 0)
        has_sps = pd.notna(home_sp) and pd.notna(away_sp)
        return has_lineups and has_sps

    roster_mask = new_games.apply(has_roster_data, axis=1)
    skipped = new_games[~roster_mask]
    predictable = new_games[roster_mask].copy()

    if len(skipped) > 0:
        logger.warning(f"  Skipping {len(skipped)} games with incomplete roster data (lineups/SPs not posted):")
        for _, row in skipped.iterrows():
            missing = []
            home_lu = row.get("HOME_LINEUP")
            away_lu = row.get("AWAY_LINEUP")
            if not (home_lu is not None and isinstance(home_lu, list) and len(home_lu) > 0):
                missing.append("HOME_LINEUP")
            if not (away_lu is not None and isinstance(away_lu, list) and len(away_lu) > 0):
                missing.append("AWAY_LINEUP")
            if not pd.notna(row.get("HOME_SP")):
                missing.append("HOME_SP")
            if not pd.notna(row.get("AWAY_SP")):
                missing.append("AWAY_SP")
            logger.warning(f"    GAME_ID={row['GAME_ID']}: {row.get('AWAY_NAME', '?')} @ {row.get('HOME_NAME', '?')} — missing: {', '.join(missing)}")

    if predictable.empty:
        return pd.DataFrame(), len(skipped)

    X = predictable[ALL_FEATURES].astype(float)
    probs = model.predict_proba(X)[:, 1]

    predictable["PREDICTION_PCT"] = probs
    predictable["PREDICTION"] = (probs >= 0.5).astype(int)

    logger.info(f"  Writing {len(predictable)} predictions to Supabase...")
    for _, row in predictable.iterrows():
        game_id = int(row["GAME_ID"])
        pred = int(row["PREDICTION"])
        prob = round(float(row["PREDICTION_PCT"]), 3)

        try:
            supabase.table("mlb_gamelogs").update({
                "PREDICTION": pred,
                "PREDICTION_PCT": prob,
            }).eq("GAME_ID", game_id).execute()
        except Exception as e:
            logger.error(f"  Failed to write GAME_ID={game_id}: {e}")

    return predictable, len(skipped)


# ---------------------------------------------------------------------------
# 5. Format and print output
# ---------------------------------------------------------------------------
def print_predictions(games_df, new_predictions_df):
    """Print formatted table of ALL today's predictions."""
    today_str = datetime.now(ZoneInfo("America/New_York")).strftime("%Y-%m-%d")

    new_ids = set(new_predictions_df["GAME_ID"].tolist()) if not new_predictions_df.empty else set()

    display = games_df.copy()
    if not new_predictions_df.empty:
        for _, row in new_predictions_df.iterrows():
            mask = display["GAME_ID"] == row["GAME_ID"]
            display.loc[mask, "PREDICTION"] = row["PREDICTION"]
            display.loc[mask, "PREDICTION_PCT"] = row["PREDICTION_PCT"]

    display = display[display["PREDICTION"].notna()].copy()

    if display.empty:
        print(f"\n  No predictions available for {today_str}\n")
        return

    print(f"\n{'=' * 90}")
    print(f"  MLB PREDICTIONS FOR {today_str}")
    print(f"{'=' * 90}")
    print(f"  {'Away Team':<26s}    {'Home Team':<26s} {'Pick':<8s} {'Prob':>7s}  {'Status'}")
    print(f"  {'-' * 84}")

    for _, row in display.sort_values("GAME_DATE").iterrows():
        away = row.get("AWAY_NAME", "???")
        home = row.get("HOME_NAME", "???")
        pred = int(row["PREDICTION"])
        prob = float(row["PREDICTION_PCT"])
        game_id = row["GAME_ID"]

        pick = home if pred == 1 else away
        pick_prob = prob if pred == 1 else (1 - prob)
        status = "NEW" if game_id in new_ids else "EXISTING"

        away_disp = away[:25] if isinstance(away, str) else "???"
        home_disp = home[:25] if isinstance(home, str) else "???"
        pick_disp = pick[:7] if isinstance(pick, str) else "???"

        print(f"  {away_disp:<26s} @  {home_disp:<26s} {pick_disp:<8s} {pick_prob:>6.1%}  {status}")

    new_count = len(new_ids & set(display["GAME_ID"].tolist()))
    existing_count = len(display) - new_count
    print(f"\n  {len(display)} games | {new_count} new, {existing_count} existing | Model: {MODEL_PATH.name}")
    print()


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    logger.info("=== MLB GAME OUTCOME MODEL — PREDICTIONS ===")

    model = load_model(MODEL_PATH)

    logger.info("Fetching today's scheduled games...")
    games_df = fetch_todays_games()

    if games_df.empty:
        print("\n  No scheduled games found for today.\n")
        return

    logger.info(f"  {len(games_df)} scheduled games found")

    new_predictions, skipped = predict_and_write(model, games_df)

    print_predictions(games_df, new_predictions)

    if skipped > 0:
        print(f"  {skipped} games skipped (missing lineups/SPs — run games.py current + gamelogs.py current after rosters are posted)\n")


if __name__ == "__main__":
    main()
