#!/usr/bin/env python3
"""
Autopilot Calibration Pipeline
===============================
Ingests historical PBP + odds data, trains the win probability model,
and exports coefficients.

Usage:
  python run_calibrate.py ingest              # Download + process historical PBP data
  python run_calibrate.py ingest-odds <csv>   # Load + match historical odds from Kaggle CSV
  python run_calibrate.py train               # Train model on ingested data
  python run_calibrate.py all <csv>           # Full pipeline: ingest + odds + train
"""

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

import argparse
import logging

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)


def cmd_ingest(args):
    """Download and process historical play-by-play data."""
    from autopilot.src.ingest.pbp_historical import ingest_all_seasons

    total = ingest_all_seasons(
        start_season=args.start_season,
        end_season=args.end_season,
    )
    logger.info(f"Ingestion complete: {total} total snapshots")


def cmd_ingest_odds(args):
    """Load historical odds from a Kaggle CSV and backfill into snapshots."""
    from autopilot.src.ingest.odds_historical import (
        load_kaggle_odds,
        match_odds_to_game_ids,
        backfill_snapshot_odds,
    )
    from autopilot.src.ingest.pbp_historical import fetch_game_outcomes

    csv_path = Path(args.csv_path)
    if not csv_path.exists():
        logger.error(f"CSV file not found: {csv_path}")
        sys.exit(1)

    odds_df = load_kaggle_odds(csv_path)
    outcomes = fetch_game_outcomes(args.start_season)
    odds = match_odds_to_game_ids(odds_df, outcomes)
    backfill_snapshot_odds(odds)


def cmd_train(args):
    """Train the win probability model on ingested data."""
    from autopilot.src.model.calibrate import run_calibration

    output_path = Path(__file__).parent / "coefficients" / "nba_winprob_v1.json"
    evaluation = run_calibration(
        min_season=args.start_season,
        output_path=output_path,
    )

    print("\n" + "=" * 60)
    print("  MODEL EVALUATION")
    print("=" * 60)
    for key, val in evaluation.items():
        if key != "calibration":
            print(f"  {key:30s} {val}")
    print("=" * 60)


def cmd_backfill_espn_odds(args):
    """Backfill pregame odds from ESPN's pickcenter for historical games."""
    from autopilot.src.ingest.odds_espn_backfill import backfill_espn_odds

    total = backfill_espn_odds(
        start_season=args.start_season,
        end_season=args.end_season,
    )
    logger.info(f"Backfill complete: {total} games updated")


def cmd_backfill_oddsshark_odds(args):
    """Backfill pregame odds from OddsShark's scores API for historical games."""
    from autopilot.src.ingest.odds_oddsshark_backfill import backfill_oddsshark_odds

    total = backfill_oddsshark_odds(
        start_season=args.start_season,
        end_season=args.end_season,
    )
    logger.info(f"OddsShark backfill complete: {total} games updated")


def cmd_all(args):
    """Full pipeline: ingest PBP + odds + train."""
    cmd_ingest(args)
    if args.csv_path:
        cmd_ingest_odds(args)
    cmd_train(args)


def main():
    parser = argparse.ArgumentParser(description="Autopilot Calibration Pipeline")
    parser.add_argument("--start-season", type=int, default=2014, help="First season to process")
    parser.add_argument("--end-season", type=int, default=2025, help="Last season to process")

    subparsers = parser.add_subparsers(dest="command", required=True)

    # ingest
    subparsers.add_parser("ingest", help="Ingest historical PBP data")

    # ingest-odds
    odds_parser = subparsers.add_parser("ingest-odds", help="Load historical odds from CSV")
    odds_parser.add_argument("csv_path", help="Path to Kaggle odds CSV file")

    # backfill-espn-odds
    subparsers.add_parser("backfill-espn-odds", help="Backfill pregame odds from ESPN pickcenter")

    # backfill-oddsshark-odds
    subparsers.add_parser("backfill-oddsshark-odds", help="Backfill pregame odds from OddsShark API")

    # train
    subparsers.add_parser("train", help="Train the win probability model")

    # all
    all_parser = subparsers.add_parser("all", help="Full pipeline: ingest + train")
    all_parser.add_argument("csv_path", nargs="?", default=None, help="Optional path to Kaggle odds CSV")

    args = parser.parse_args()

    commands = {
        "ingest": cmd_ingest,
        "ingest-odds": cmd_ingest_odds,
        "backfill-espn-odds": cmd_backfill_espn_odds,
        "backfill-oddsshark-odds": cmd_backfill_oddsshark_odds,
        "train": cmd_train,
        "all": cmd_all,
    }
    commands[args.command](args)


if __name__ == "__main__":
    main()
