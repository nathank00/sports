#!/usr/bin/env python3
"""
MLB Autopilot Live Runner
=========================
Long-lived process that polls live MLB game data, runs the win probability
model, and writes trading signals to the database.

Does NOT execute trades — the web frontend handles that per-user.

Usage:
  python run_mlb_live.py

Environment variables:
  SUPABASE_URL          # Required — database access
  SUPABASE_KEY          # Required — database access
"""

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

import asyncio
import logging

from autopilot.src.model.mlb_winprob import MLBWinProbModel
from autopilot.src.loop.mlb_orchestrator import MLBOrchestrator

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)


def main():
    # Load model (analytical, no file needed)
    model = MLBWinProbModel()
    logger.info(f"Model version: {model.version}")

    # Run orchestrator
    orchestrator = MLBOrchestrator(model=model)

    try:
        asyncio.run(orchestrator.run())
    except KeyboardInterrupt:
        logger.info("Interrupted — shutting down")
        orchestrator.stop()


if __name__ == "__main__":
    main()
