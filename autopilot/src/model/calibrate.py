"""Model calibration: fit logistic regression on historical snapshots.

Trains the win probability model using game-state snapshots from
autopilot_training_snapshots, evaluates calibration quality, and
exports coefficients to a JSON file.
"""

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT))

import json
import logging
from datetime import datetime, timezone

import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import (
    brier_score_loss,
    log_loss,
    roc_auc_score,
    accuracy_score,
)

from autopilot.src.features.constants import FEATURE_NAMES, NUM_FEATURES
from autopilot.src.features.snapshot import GameState, game_state_to_feature_vector
from autopilot.src.db import fetch_paginated

logger = logging.getLogger(__name__)


def fetch_training_data(min_season: int = 2014) -> pd.DataFrame:
    """Fetch all training snapshots from the database.

    Returns DataFrame with all columns from autopilot_training_snapshots.
    """
    logger.info(f"Fetching training snapshots (season >= {min_season})...")

    rows = fetch_paginated(
        "autopilot_training_snapshots",
        "*",
        filters=[("gte", "season", min_season)],
        order_col="id",
    )

    df = pd.DataFrame(rows)
    logger.info(f"Fetched {len(df)} snapshots")
    return df


def snapshots_to_features(df: pd.DataFrame) -> tuple[np.ndarray, np.ndarray]:
    """Convert snapshot DataFrame to feature matrix X and target vector y.

    Uses game_state_to_feature_vector() so the feature engineering is
    identical between training and live inference.
    """
    X_list = []
    y_list = []

    for _, row in df.iterrows():
        state = GameState(
            home_score=int(row["home_score"]),
            away_score=int(row["away_score"]),
            period=int(row["period"]),
            seconds_remaining=float(row["seconds_remaining"]),
            home_has_possession=row.get("home_has_possession") if not pd.isna(row.get("home_has_possession")) else None,
            pregame_spread=_safe_float(row.get("pregame_spread")),
            pregame_home_ml_prob=_safe_float(row.get("pregame_home_ml_prob")),
            home_off_rating=_safe_float(row.get("home_off_rating")),
            away_off_rating=_safe_float(row.get("away_off_rating")),
            home_def_rating=_safe_float(row.get("home_def_rating")),
            away_def_rating=_safe_float(row.get("away_def_rating")),
            pace=_safe_float(row.get("pace")),
            home_possessions=_safe_int(row.get("home_possessions")),
            away_possessions=_safe_int(row.get("away_possessions")),
            home_timeouts=_safe_int(row.get("home_timeouts")),
            away_timeouts=_safe_int(row.get("away_timeouts")),
            home_team_fouls=_safe_int(row.get("home_team_fouls")),
            away_team_fouls=_safe_int(row.get("away_team_fouls")),
        )
        X_list.append(game_state_to_feature_vector(state))
        y_list.append(1 if row["home_win"] else 0)

    return np.array(X_list), np.array(y_list)


def _safe_int(val) -> int | None:
    """Safely convert to int, returning None for NaN/None."""
    if val is None or (isinstance(val, float) and np.isnan(val)):
        return None
    return int(val)


def _safe_float(val) -> float | None:
    """Safely convert to float, returning None for NaN/None."""
    if val is None:
        return None
    try:
        f = float(val)
        if np.isnan(f):
            return None
        return f
    except (ValueError, TypeError):
        return None


def train_model(
    X_train: np.ndarray,
    y_train: np.ndarray,
) -> LogisticRegression:
    """Fit logistic regression with L2 regularization."""
    logger.info(f"Training on {X_train.shape[0]} samples, {X_train.shape[1]} features")

    model = LogisticRegression(
        C=1.0,
        max_iter=1000,
        solver="lbfgs",
        random_state=42,
    )
    model.fit(X_train, y_train)

    logger.info("Model training complete")
    return model


def evaluate_model(
    model: LogisticRegression,
    X_test: np.ndarray,
    y_test: np.ndarray,
) -> dict:
    """Compute evaluation metrics."""
    probs = model.predict_proba(X_test)[:, 1]
    preds = model.predict(X_test)

    metrics = {
        "test_samples": int(len(y_test)),
        "brier_score": round(float(brier_score_loss(y_test, probs)), 4),
        "log_loss": round(float(log_loss(y_test, probs)), 4),
        "roc_auc": round(float(roc_auc_score(y_test, probs)), 4),
        "accuracy": round(float(accuracy_score(y_test, preds)), 4),
        "home_win_rate_actual": round(float(y_test.mean()), 4),
        "home_win_rate_predicted": round(float(probs.mean()), 4),
    }

    # Calibration bins: predicted probability vs actual win rate
    bins = np.linspace(0, 1, 11)
    bin_indices = np.digitize(probs, bins) - 1
    calibration = {}
    for i in range(len(bins) - 1):
        mask = bin_indices == i
        if mask.sum() > 0:
            bin_label = f"{bins[i]:.1f}-{bins[i+1]:.1f}"
            calibration[bin_label] = {
                "predicted_mean": round(float(probs[mask].mean()), 4),
                "actual_mean": round(float(y_test[mask].mean()), 4),
                "count": int(mask.sum()),
            }
    metrics["calibration"] = calibration

    logger.info(f"Evaluation: Brier={metrics['brier_score']}, "
                f"AUC={metrics['roc_auc']}, Accuracy={metrics['accuracy']}")
    return metrics


def export_coefficients(
    model: LogisticRegression,
    output_path: Path,
    evaluation: dict,
) -> None:
    """Export model coefficients to JSON.

    Format compatible with WinProbModel.
    """
    data = {
        "version": "nba_winprob_v1",
        "trained_at": datetime.now(timezone.utc).isoformat(),
        "features": FEATURE_NAMES,
        "intercept": round(float(model.intercept_[0]), 6),
        "coefficients": [round(float(c), 6) for c in model.coef_[0]],
        "evaluation": evaluation,
    }

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w") as f:
        json.dump(data, f, indent=2)

    logger.info(f"Coefficients exported to {output_path}")


def run_calibration(
    min_season: int = 2014,
    test_fraction: float = 0.2,
    output_path: Path | None = None,
) -> dict:
    """Full calibration pipeline: fetch data, train, evaluate, export.

    Args:
        min_season: earliest season to include in training
        test_fraction: fraction of data to hold out for testing (chronological split)
        output_path: where to save coefficients JSON

    Returns:
        Evaluation metrics dict.
    """
    if output_path is None:
        output_path = Path(__file__).resolve().parents[2] / "coefficients" / "nba_winprob_v1.json"

    # Fetch and prepare data
    df = fetch_training_data(min_season)
    if df.empty:
        raise ValueError("No training data found. Run ingestion first.")

    # Sort by game_date + seconds_remaining descending (chronological within games)
    df = df.sort_values(["game_date", "game_id", "seconds_remaining"], ascending=[True, True, False])

    X, y = snapshots_to_features(df)
    logger.info(f"Feature matrix: {X.shape}, Target: {y.shape}")

    # Chronological split
    split_idx = int(len(X) * (1 - test_fraction))
    X_train, X_test = X[:split_idx], X[split_idx:]
    y_train, y_test = y[:split_idx], y[split_idx:]
    logger.info(f"Train: {len(X_train)}, Test: {len(X_test)}")

    # Train
    model = train_model(X_train, y_train)

    # Evaluate
    evaluation = evaluate_model(model, X_test, y_test)

    # Export
    export_coefficients(model, output_path, evaluation)

    # Log feature importances
    logger.info("Feature coefficients:")
    for name, coef in sorted(
        zip(FEATURE_NAMES, model.coef_[0]),
        key=lambda x: abs(x[1]),
        reverse=True,
    ):
        logger.info(f"  {name:30s} {coef:+.4f}")

    return evaluation
