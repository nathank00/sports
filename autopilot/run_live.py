#!/usr/bin/env python3
"""
Autopilot Live Runner
=====================
Long-lived process that polls live NBA game data, runs the win probability
model, and writes trading signals to the database.

Does NOT execute trades — the web frontend handles that per-user.

Usage:
  python run_live.py

Environment variables:
  SUPABASE_URL          # Required — database access
  SUPABASE_KEY          # Required — database access
  ODDS_API_KEY          # Optional — pregame odds from The Odds API
"""

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

import asyncio
import logging

from autopilot.src.model.winprob import WinProbModel
from autopilot.src.loop.orchestrator import Orchestrator

DEFAULT_COEFFICIENTS = Path(__file__).parent / "coefficients" / "nba_winprob_v1.json"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)


def main():
    # Load model
    coefficients = DEFAULT_COEFFICIENTS
    logger.info(f"Loading model from {coefficients}")
    model = WinProbModel(coefficients)
    logger.info(f"Model version: {model.version}")

    # Run orchestrator (uses TradingConfig defaults)
    orchestrator = Orchestrator(model=model)

    try:
        asyncio.run(orchestrator.run())
    except KeyboardInterrupt:
        logger.info("Interrupted — shutting down")
        orchestrator.stop()


if __name__ == "__main__":
    main()
