#!/usr/bin/env python3
"""
MLB Pipeline Runner
===================
Three modes designed for different scheduling cadences:

  historical  — Full rebuild from scratch (2020-present).
                Deletes and regenerates all tables. Should rarely be needed.
                Runtime: ~30 minutes.

  current     — Daily delta update. Run once per day (early morning).
                Refreshes players/playerstats for recent games, rebuilds
                gamelogs for the last few days, and retrains the model.

  live        — Lightweight loop: games → gamelogs → predict.
                Designed to run every ~10 minutes during game days to
                capture newly posted lineups and generate predictions.

Usage:
  python run_pipeline.py historical
  python run_pipeline.py current
  python run_pipeline.py live
"""

import sys
import os
import subprocess
import time
import logging

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s — %(levelname)s — %(message)s",
)
logger = logging.getLogger(__name__)

PIPELINE_DIR = os.path.dirname(os.path.abspath(__file__))
SRC_DIR = os.path.join(PIPELINE_DIR, "src")


def run_script(name: str, mode: str | None = None) -> bool:
    """Run a pipeline script. Returns True on success."""
    script = os.path.join(SRC_DIR, name)
    cmd = [sys.executable, script]
    if mode:
        cmd.append(mode)

    label = f"{name} {mode}" if mode else name
    logger.info(f"▶  {label}")
    start = time.time()

    result = subprocess.run(cmd, cwd=PIPELINE_DIR)

    elapsed = time.time() - start
    if result.returncode != 0:
        logger.error(f"✗  {label} failed (exit {result.returncode}) [{elapsed:.1f}s]")
        return False

    logger.info(f"✓  {label} [{elapsed:.1f}s]")
    return True


# ─── Historical Mode ────────────────────────────────────────────────────────
def run_historical():
    """
    Full rebuild from scratch. Backfills all data from 2020 to present.

    Pipeline order:
      1. games.py full        — fetch all games + lineups
      2. players.py full      — fetch all player metadata
      3. playerstats.py full  — fetch all per-player game stats (~380k rows)
      4. gamelogs.py full     — compute all rolling features
      5. train.py             — retrain model on full dataset
      6. predict.py           — generate predictions for today (if games exist)
    """
    logger.info("=" * 60)
    logger.info("  MLB PIPELINE — HISTORICAL (full rebuild)")
    logger.info("=" * 60)

    steps = [
        ("games.py", "full"),
        ("players.py", "full"),
        ("playerstats.py", "full"),
        ("gamelogs.py", "full"),
        ("train.py", None),
        ("predict.py", None),
    ]

    start = time.time()
    for script, mode in steps:
        if not run_script(script, mode):
            logger.error(f"Pipeline aborted at {script}")
            sys.exit(1)

    logger.info(f"Historical pipeline complete [{time.time() - start:.0f}s total]")


# ─── Current Mode ───────────────────────────────────────────────────────────
def run_current():
    """
    Daily delta update. Run once per day, ideally early morning.

    Pipeline order:
      1. games.py current        — fetch/update recent games + lineups
      2. players.py current      — add any new players this season
      3. playerstats.py current  — fetch stats for players in recent games
      4. gamelogs.py current     — recompute rolling features for recent games
      5. train.py                — retrain model (picks up latest data)
      6. predict.py              — generate predictions for today
    """
    logger.info("=" * 60)
    logger.info("  MLB PIPELINE — CURRENT (daily update)")
    logger.info("=" * 60)

    steps = [
        ("games.py", "current"),
        ("players.py", "current"),
        ("playerstats.py", "current"),
        ("gamelogs.py", "current"),
        ("train.py", None),
        ("predict.py", None),
    ]

    start = time.time()
    for script, mode in steps:
        if not run_script(script, mode):
            logger.error(f"Pipeline aborted at {script}")
            sys.exit(1)

    logger.info(f"Current pipeline complete [{time.time() - start:.0f}s total]")


# ─── Live Mode ──────────────────────────────────────────────────────────────
def run_live():
    """
    Lightweight refresh: games → gamelogs → predict.

    Designed to run every ~10 minutes on game days.
    Captures newly posted lineups and generates/updates predictions.

    Does NOT run players.py or playerstats.py (those only need to run
    once per day via 'current' mode) or train.py (model doesn't change
    intra-day).
    """
    logger.info("=" * 60)
    logger.info("  MLB PIPELINE — LIVE (lineup capture + predict)")
    logger.info("=" * 60)

    steps = [
        ("games.py", "current"),
        ("gamelogs.py", "current"),
        ("predict.py", None),
    ]

    start = time.time()
    for script, mode in steps:
        if not run_script(script, mode):
            logger.error(f"Pipeline aborted at {script}")
            sys.exit(1)

    logger.info(f"Live pipeline complete [{time.time() - start:.0f}s total]")


# ─── CLI Entry Point ────────────────────────────────────────────────────────
MODES = {
    "historical": run_historical,
    "current": run_current,
    "live": run_live,
}


def main():
    if len(sys.argv) < 2 or sys.argv[1] not in MODES:
        print(__doc__)
        print(f"Available modes: {', '.join(MODES.keys())}")
        sys.exit(1)

    mode = sys.argv[1]
    MODES[mode]()


if __name__ == "__main__":
    main()
