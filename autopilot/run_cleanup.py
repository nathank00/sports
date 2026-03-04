"""Daily cleanup: convert yesterday's signals to training data, then purge.

Run every morning (10 AM ET via GitHub Actions) to:
1. Fetch completed game outcomes from ESPN for yesterday
2. Convert signals → training snapshots with home_win labels
3. Upsert into autopilot_training_snapshots
4. Delete all signals older than today

Usage:
    python autopilot/run_cleanup.py              # auto-detect yesterday (ET)
    python autopilot/run_cleanup.py --date 2026-03-03   # specific date
"""

import argparse
import logging
import sys
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

# Ensure repo root is on path for imports
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from autopilot.src.db import supabase, fetch_paginated, upsert_batch
from autopilot.src.ingest.espn_live import fetch_scoreboard_by_date

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)

ET = ZoneInfo("America/New_York")


def _season_from_date(d: datetime) -> int:
    """NBA season start year from a game date.

    Games before July belong to the season that started the prior year.
    e.g., 2026-03-03 → 2025-26 season → returns 2025
    """
    if d.month >= 10:
        return d.year
    return d.year - 1


def run_cleanup(target_date: str | None = None) -> None:
    """Main cleanup routine.

    Args:
        target_date: Optional YYYY-MM-DD string. Defaults to yesterday (ET).
    """
    now_et = datetime.now(ET)

    if target_date:
        dt = datetime.strptime(target_date, "%Y-%m-%d").replace(tzinfo=ET)
    else:
        dt = now_et - timedelta(days=1)

    date_str = dt.strftime("%Y-%m-%d")
    espn_date = dt.strftime("%Y%m%d")

    # Today's midnight ET as the cutoff for signal deletion
    today_midnight_et = now_et.replace(hour=0, minute=0, second=0, microsecond=0)
    cutoff_utc = today_midnight_et.astimezone(ZoneInfo("UTC")).isoformat()

    logger.info(f"Cleanup target date: {date_str}")
    logger.info(f"Signal deletion cutoff: {cutoff_utc}")

    # ── Step 1: Fetch game outcomes from ESPN ────────────────────────
    logger.info(f"Fetching ESPN scoreboard for {espn_date}...")
    completed_games = fetch_scoreboard_by_date(espn_date)
    logger.info(f"  Found {len(completed_games)} completed games")

    if not completed_games:
        logger.info("No completed games found. Skipping snapshot conversion.")
    else:
        for g in completed_games:
            winner = g["home_team"] if g["home_win"] else g["away_team"]
            logger.info(
                f"  {g['away_team']} {g['away_score']} @ {g['home_team']} {g['home_score']} — W: {winner}"
            )

    # Build lookup: espn_game_id → game outcome
    outcome_map = {g["espn_game_id"]: g for g in completed_games}

    # ── Step 2: Fetch old signals ────────────────────────────────────
    logger.info("Fetching old signals from database...")
    old_signals = fetch_paginated(
        "autopilot_signals",
        "*",
        filters=[("lt", "created_at", cutoff_utc)],
        order_col="id",
    )
    logger.info(f"  Found {len(old_signals)} old signals")

    if not old_signals:
        logger.info("No old signals to process. Done.")
        return

    # ── Step 3: Convert signals → training snapshots ─────────────────
    season = _season_from_date(dt)
    snapshots = []

    matched_games = set()
    unmatched_games = set()

    for sig in old_signals:
        game_id = sig["game_id"]
        outcome = outcome_map.get(game_id)

        if not outcome:
            unmatched_games.add(game_id)
            continue

        matched_games.add(game_id)

        snapshots.append({
            "game_id": game_id,
            "season": season,
            "game_date": date_str,
            "home_team": sig["home_team"],
            "away_team": sig["away_team"],
            "period": sig["period"],
            "seconds_remaining": sig["seconds_remaining"],
            "home_score": sig["home_score"],
            "away_score": sig["away_score"],
            "score_margin": sig["home_score"] - sig["away_score"],
            "home_has_possession": None,
            "pregame_spread": None,
            "pregame_home_ml_prob": sig.get("pregame_home_ml_prob"),
            "home_off_rating": None,
            "away_off_rating": None,
            "home_def_rating": None,
            "away_def_rating": None,
            "pace": None,
            "home_possessions": None,
            "away_possessions": None,
            "home_timeouts": None,
            "away_timeouts": None,
            "home_team_fouls": None,
            "away_team_fouls": None,
            "home_win": outcome["home_win"],
        })

    if unmatched_games:
        logger.warning(
            f"  {len(unmatched_games)} game(s) in signals not found in ESPN results: {unmatched_games}"
        )

    logger.info(f"  {len(matched_games)} games matched, {len(snapshots)} snapshots to insert")

    # Deduplicate: keep last snapshot at each (game_id, period, seconds_remaining)
    if snapshots:
        seen: dict[tuple, int] = {}
        for i, snap in enumerate(snapshots):
            key = (snap["game_id"], snap["period"], snap["seconds_remaining"])
            seen[key] = i
        deduped = [snapshots[i] for i in sorted(seen.values())]
        logger.info(f"  Deduped: {len(deduped)} unique snapshots (from {len(snapshots)})")

        # ── Step 4: Upsert into training table ───────────────────────
        count = upsert_batch(
            "autopilot_training_snapshots",
            deduped,
            conflict_col="game_id,period,seconds_remaining",
        )
        logger.info(f"  Upserted {count} training snapshots")

    # ── Step 5: Delete old signals ───────────────────────────────────
    logger.info("Deleting old signals...")
    signal_ids = [s["id"] for s in old_signals]

    # Delete in batches (Supabase has query size limits)
    batch_size = 500
    deleted = 0
    for i in range(0, len(signal_ids), batch_size):
        batch = signal_ids[i : i + batch_size]
        try:
            supabase.table("autopilot_signals").delete().in_("id", batch).execute()
            deleted += len(batch)
        except Exception as e:
            logger.error(f"Delete batch failed: {e}")

    logger.info(f"  Deleted {deleted} old signals")

    # ── Summary ──────────────────────────────────────────────────────
    logger.info("Cleanup complete:")
    logger.info(f"  Date: {date_str}")
    logger.info(f"  Games processed: {len(matched_games)}")
    logger.info(f"  Training snapshots upserted: {len(deduped) if snapshots else 0}")
    logger.info(f"  Signals deleted: {deleted}")


def main():
    parser = argparse.ArgumentParser(description="Daily signal cleanup + training feedback")
    parser.add_argument(
        "--date",
        type=str,
        default=None,
        help="Target date (YYYY-MM-DD). Defaults to yesterday (ET).",
    )
    args = parser.parse_args()
    run_cleanup(args.date)


if __name__ == "__main__":
    main()
