#!/usr/bin/env python3
"""
Autopilot Live Runner
=====================
Long-lived process that polls live NBA game data, runs the win probability
model, and writes trading signals to the database.

Does NOT execute trades — the web frontend handles that per-user.

Usage:
  python run_live.py                            # Run with default config
  python run_live.py --min-edge 10              # Custom edge threshold
  python run_live.py --coefficients path.json   # Custom model file

Environment variables:
  SUPABASE_URL          # Required — database access
  SUPABASE_KEY          # Required — database access
  ODDS_API_KEY          # Optional — pregame odds from The Odds API
"""

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

import argparse
import asyncio
import logging

from autopilot.src.model.winprob import WinProbModel
from autopilot.src.trading.decision import TradingConfig
from autopilot.src.loop.orchestrator import Orchestrator

DEFAULT_COEFFICIENTS = Path(__file__).parent / "coefficients" / "nba_winprob_v1.json"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)


def main():
    parser = argparse.ArgumentParser(description="Autopilot Live Runner")
    parser.add_argument(
        "--coefficients",
        type=Path,
        default=DEFAULT_COEFFICIENTS,
        help="Path to model coefficients JSON",
    )
    parser.add_argument(
        "--min-edge",
        type=float,
        default=2.0,
        help="Minimum edge %% to generate a trade signal (default: 2)",
    )
    parser.add_argument(
        "--min-time",
        type=float,
        default=120.0,
        help="Minimum seconds remaining to generate signals (default: 120)",
    )
    args = parser.parse_args()

    # Load model
    logger.info(f"Loading model from {args.coefficients}")
    model = WinProbModel(args.coefficients)
    logger.info(f"Model version: {model.version}")

    # Trading config
    config = TradingConfig(
        min_edge_pct=args.min_edge,
        min_seconds_remaining=args.min_time,
    )

    # Run orchestrator
    orchestrator = Orchestrator(model=model, config=config)

    try:
        asyncio.run(orchestrator.run())
    except KeyboardInterrupt:
        logger.info("Interrupted — shutting down")
        orchestrator.stop()


if __name__ == "__main__":
    main()
