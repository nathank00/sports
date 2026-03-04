#!/usr/bin/env python3
"""Nightly model retraining with guard rails.

Trains a candidate model on the latest training data and only
promotes it to production if its Brier score improves over the
existing model.  Designed to run after the daily cleanup job
(which converts yesterday's signals into training snapshots).

Usage:
    python autopilot/run_retrain.py
"""

import json
import logging
import shutil
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

from autopilot.src.model.calibrate import run_calibration

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)

COEFFICIENTS_DIR = Path(__file__).parent / "coefficients"
PROD_MODEL = COEFFICIENTS_DIR / "nba_winprob_v1.json"
CANDIDATE_MODEL = COEFFICIENTS_DIR / "nba_winprob_candidate.json"


def load_existing_brier() -> float | None:
    """Load Brier score from the current production model."""
    if not PROD_MODEL.exists():
        return None
    try:
        with open(PROD_MODEL) as f:
            data = json.load(f)
        return data.get("evaluation", {}).get("brier_score")
    except Exception as e:
        logger.warning(f"Could not load existing model metrics: {e}")
        return None


def main():
    # 1. Load existing model's Brier score
    existing_brier = load_existing_brier()
    if existing_brier is not None:
        logger.info(f"Existing model Brier score: {existing_brier}")
    else:
        logger.info("No existing model found — will train from scratch")

    # 2. Train candidate model
    logger.info("Training candidate model...")
    try:
        evaluation = run_calibration(output_path=CANDIDATE_MODEL)
    except Exception as e:
        logger.error(f"Training failed: {e}")
        sys.exit(1)

    candidate_brier = evaluation.get("brier_score")
    logger.info(f"Candidate model Brier score: {candidate_brier}")
    logger.info(f"Candidate AUC: {evaluation.get('roc_auc')}")
    logger.info(f"Candidate accuracy: {evaluation.get('accuracy')}")

    # 3. Compare and decide
    if existing_brier is None:
        logger.info("No existing model — promoting candidate")
        shutil.copy2(CANDIDATE_MODEL, PROD_MODEL)
        logger.info(f"Candidate promoted to {PROD_MODEL}")
    elif candidate_brier is not None and candidate_brier < existing_brier:
        improvement = existing_brier - candidate_brier
        logger.info(
            f"Candidate is BETTER (Brier {candidate_brier:.4f} < {existing_brier:.4f}, "
            f"improvement: {improvement:.4f}) — promoting"
        )
        shutil.copy2(CANDIDATE_MODEL, PROD_MODEL)
        logger.info(f"Candidate promoted to {PROD_MODEL}")
    else:
        logger.info(
            f"Candidate is NOT better (Brier {candidate_brier} >= {existing_brier}) "
            f"— keeping existing model"
        )

    # 4. Clean up candidate file
    if CANDIDATE_MODEL.exists():
        CANDIDATE_MODEL.unlink()
        logger.info("Cleaned up candidate file")


if __name__ == "__main__":
    main()
