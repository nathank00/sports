"""Historical play-by-play data ingestion for calibration.

Downloads NBA play-by-play CSVs from the shufinskiy/nba_data GitHub repo,
parses events into game-state snapshots at regular intervals, and writes
them to the autopilot_training_snapshots table in Supabase.

Data source: https://github.com/shufinskiy/nba_data
Format: stats.nba.com PBP with columns:
  GAME_ID, EVENTNUM, EVENTMSGTYPE, EVENTMSGACTIONTYPE, PERIOD,
  PCTIMESTRING, HOMEDESCRIPTION, VISITORDESCRIPTION, SCORE, SCOREMARGIN,
  PLAYER1_TEAM_ABBREVIATION, etc.

EVENTMSGTYPE codes:
  1 = Made shot
  2 = Missed shot
  3 = Free throw
  4 = Rebound
  5 = Turnover
  6 = Foul
  7 = Violation
  8 = Substitution
  9 = Timeout
  10 = Jump ball
  12 = Period start
  13 = Period end
"""

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT))

import io
import logging
import tarfile
import pandas as pd
import numpy as np
import requests
from tqdm import tqdm

from autopilot.src.db import supabase, upsert_batch

logger = logging.getLogger(__name__)

# shufinskiy/nba_data download URL pattern for stats.nba.com PBP
PBP_URL_TEMPLATE = (
    "https://raw.githubusercontent.com/shufinskiy/nba_data/main/"
    "datasets/nbastats_{season}.tar.xz"
)

# Snapshot interval: emit a snapshot every N seconds of game clock
SNAPSHOT_INTERVAL_SECONDS = 30

# Regulation game: 4 quarters * 12 minutes = 2880 seconds
QUARTER_SECONDS = 720
REGULATION_SECONDS = 2880

# OT period length: 5 minutes = 300 seconds
OT_SECONDS = 300


def download_pbp_season(season: int) -> pd.DataFrame:
    """Download PBP data for a season from shufinskiy/nba_data.

    Args:
        season: Start year of the season (e.g., 2023 for 2023-24).

    Returns:
        DataFrame with PBP events for the entire season.
    """
    url = PBP_URL_TEMPLATE.format(season=season)
    logger.info(f"Downloading PBP for {season}-{(season+1) % 100:02d} from {url}")

    resp = requests.get(url, timeout=120)
    resp.raise_for_status()

    # Decompress tar.xz and read the CSV inside
    with tarfile.open(fileobj=io.BytesIO(resp.content), mode="r:xz") as tar:
        for member in tar.getmembers():
            if member.name.endswith(".csv"):
                f = tar.extractfile(member)
                if f is None:
                    raise ValueError(f"Could not extract {member.name}")
                df = pd.read_csv(f)
                logger.info(f"  Loaded {len(df)} events from {member.name}")
                return df

    raise ValueError(f"No CSV found in archive for season {season}")


def fetch_game_outcomes(season: int) -> dict[str, dict]:
    """Fetch game outcomes and team info from the games table.

    Returns dict: game_id -> {home_team, away_team, home_win, game_date}
    """
    from autopilot.src.db import fetch_paginated
    from shared.nba.nba_constants import TEAM_ID_TO_NAME, TEAM_ABBR_TO_FULL

    rows = fetch_paginated(
        "games",
        "GAME_ID,HOME_NAME,AWAY_NAME,HOME_ID,AWAY_ID,GAME_OUTCOME,GAME_DATE",
        filters=[
            ("eq", "GAME_STATUS", 3),  # completed games only
        ],
        order_col="GAME_ID",
    )

    outcomes = {}
    for r in rows:
        game_id = str(r["GAME_ID"]).zfill(10)
        outcome = r.get("GAME_OUTCOME")
        if outcome is None:
            continue

        # Map full team names to abbreviations
        home_abbr = _name_to_abbr(r.get("HOME_NAME", ""))
        away_abbr = _name_to_abbr(r.get("AWAY_NAME", ""))

        if not home_abbr or not away_abbr:
            continue

        outcomes[game_id] = {
            "home_team": home_abbr,
            "away_team": away_abbr,
            "home_win": outcome == 1,
            "game_date": r.get("GAME_DATE", ""),
        }

    return outcomes


def _name_to_abbr(full_name: str) -> str | None:
    """Convert full team name to 3-letter abbreviation."""
    from shared.nba.nba_constants import TEAM_ABBR_TO_FULL

    reverse = {v: k for k, v in TEAM_ABBR_TO_FULL.items()}
    return reverse.get(full_name)


def parse_clock_to_seconds(period: int, pctimestring: str) -> float:
    """Convert period + clock string (e.g., "4:32") to total seconds remaining.

    For regulation (periods 1-4): each quarter is 12 minutes.
    For OT (period 5+): each OT is 5 minutes.
    """
    try:
        parts = str(pctimestring).split(":")
        minutes = int(parts[0])
        seconds = int(parts[1]) if len(parts) > 1 else 0
        clock_seconds = minutes * 60 + seconds
    except (ValueError, IndexError):
        return 0.0

    if period <= 4:
        # Remaining full quarters after this one + clock in current quarter
        remaining_quarters = 4 - period
        return remaining_quarters * QUARTER_SECONDS + clock_seconds
    else:
        # OT: just the clock time (no additional periods assumed)
        return clock_seconds


def parse_score(score_str: str | None) -> tuple[int, int]:
    """Parse score string like '102 - 97' into (away_score, home_score).

    Note: stats.nba.com PBP SCORE format is 'AWAY - HOME'.
    """
    if not score_str or pd.isna(score_str):
        return 0, 0

    try:
        parts = str(score_str).split("-")
        away = int(parts[0].strip())
        home = int(parts[1].strip())
        return away, home
    except (ValueError, IndexError):
        return 0, 0


def estimate_possessions(fga: int, fta: int, oreb: int, tov: int) -> int:
    """Estimate possessions using the standard formula.

    possessions ≈ FGA - OREB + TOV + 0.44 * FTA
    """
    return max(1, int(round(fga - oreb + tov + 0.44 * fta)))


def extract_snapshots_from_game(
    game_events: pd.DataFrame,
    game_id: str,
    outcome: dict,
    pregame_spread: float | None = None,
    pregame_home_ml_prob: float | None = None,
) -> list[dict]:
    """Extract game-state snapshots from a single game's PBP events.

    Walks through events chronologically, maintaining running state.
    Emits one snapshot approximately every SNAPSHOT_INTERVAL_SECONDS.
    """
    events = game_events.sort_values("EVENTNUM").reset_index(drop=True)

    home_team = outcome["home_team"]
    away_team = outcome["away_team"]
    home_win = outcome["home_win"]
    game_date = outcome.get("game_date", "")
    # Extract just the date portion
    if game_date and "T" in str(game_date):
        game_date = str(game_date).split("T")[0]

    # Running state
    home_score = 0
    away_score = 0
    current_period = 1
    home_fgm, home_fga, home_ftm, home_fta, home_oreb, home_tov = 0, 0, 0, 0, 0, 0
    away_fgm, away_fga, away_ftm, away_fta, away_oreb, away_tov = 0, 0, 0, 0, 0, 0
    home_fouls, away_fouls = 0, 0
    home_timeouts, away_timeouts = 0, 0
    last_possession_home: bool | None = None

    snapshots: list[dict] = []
    last_snapshot_seconds: float | None = None

    for _, event in events.iterrows():
        period = int(event.get("PERIOD", current_period))
        current_period = period
        pctimestring = str(event.get("PCTIMESTRING", "12:00"))
        seconds_remaining = parse_clock_to_seconds(period, pctimestring)

        # Update score from SCORE column
        score_str = event.get("SCORE")
        if score_str and not pd.isna(score_str):
            away_s, home_s = parse_score(score_str)
            if away_s > 0 or home_s > 0:
                away_score = away_s
                home_score = home_s

        # Determine which team this event belongs to
        event_type = int(event.get("EVENTMSGTYPE", 0))
        p1_team_abbr = str(event.get("PLAYER1_TEAM_ABBREVIATION", ""))
        is_home_event = p1_team_abbr == home_team
        is_away_event = p1_team_abbr == away_team

        # Track stats by event type
        if event_type == 1:  # Made shot
            if is_home_event:
                home_fga += 1
                home_fgm += 1
                last_possession_home = True
            elif is_away_event:
                away_fga += 1
                away_fgm += 1
                last_possession_home = False

        elif event_type == 2:  # Missed shot
            if is_home_event:
                home_fga += 1
                last_possession_home = True
            elif is_away_event:
                away_fga += 1
                last_possession_home = False

        elif event_type == 3:  # Free throw
            if is_home_event:
                home_fta += 1
                desc = str(event.get("HOMEDESCRIPTION", ""))
                if "MISS" not in desc.upper():
                    home_ftm += 1
                last_possession_home = True
            elif is_away_event:
                away_fta += 1
                desc = str(event.get("VISITORDESCRIPTION", ""))
                if "MISS" not in desc.upper():
                    away_ftm += 1
                last_possession_home = False

        elif event_type == 4:  # Rebound
            if is_home_event:
                # Offensive rebound if last possession was also home (missed shot)
                if last_possession_home is True:
                    home_oreb += 1
            elif is_away_event:
                if last_possession_home is False:
                    away_oreb += 1

        elif event_type == 5:  # Turnover
            if is_home_event:
                home_tov += 1
                last_possession_home = True
            elif is_away_event:
                away_tov += 1
                last_possession_home = False

        elif event_type == 6:  # Foul
            if is_home_event:
                home_fouls += 1
            elif is_away_event:
                away_fouls += 1

        elif event_type == 9:  # Timeout
            if is_home_event:
                home_timeouts += 1
            elif is_away_event:
                away_timeouts += 1

        # Determine if we should emit a snapshot
        should_emit = False
        if last_snapshot_seconds is None:
            should_emit = True  # First event
        elif abs(last_snapshot_seconds - seconds_remaining) >= SNAPSHOT_INTERVAL_SECONDS:
            should_emit = True
        elif event_type == 12:  # Period start
            should_emit = True

        if should_emit and seconds_remaining >= 0:
            # Compute derived features
            h_poss = estimate_possessions(home_fga, home_fta, home_oreb, home_tov)
            a_poss = estimate_possessions(away_fga, away_fta, away_oreb, away_tov)
            total_poss = h_poss + a_poss
            elapsed_seconds = REGULATION_SECONDS - seconds_remaining
            elapsed_minutes = max(elapsed_seconds / 60.0, 1.0)

            home_off = (home_score / h_poss * 100) if h_poss > 0 else None
            away_off = (away_score / a_poss * 100) if a_poss > 0 else None
            home_def = (away_score / h_poss * 100) if h_poss > 0 else None
            away_def = (home_score / a_poss * 100) if a_poss > 0 else None
            pace = (total_poss / elapsed_minutes * 48) if elapsed_minutes > 1.0 else None

            # Round seconds_remaining to avoid floating point dedup issues
            sr_rounded = round(seconds_remaining, 1)

            snapshots.append({
                "game_id": game_id,
                "season": _game_id_to_season(game_id),
                "game_date": game_date,
                "home_team": home_team,
                "away_team": away_team,
                "period": period,
                "seconds_remaining": sr_rounded,
                "home_score": home_score,
                "away_score": away_score,
                "score_margin": home_score - away_score,
                "home_has_possession": last_possession_home,
                "pregame_spread": pregame_spread,
                "pregame_home_ml_prob": pregame_home_ml_prob,
                "home_off_rating": round(home_off, 1) if home_off else None,
                "away_off_rating": round(away_off, 1) if away_off else None,
                "home_def_rating": round(home_def, 1) if home_def else None,
                "away_def_rating": round(away_def, 1) if away_def else None,
                "pace": round(pace, 1) if pace else None,
                "home_possessions": h_poss,
                "away_possessions": a_poss,
                "home_timeouts": home_timeouts,
                "away_timeouts": away_timeouts,
                "home_team_fouls": home_fouls,
                "away_team_fouls": away_fouls,
                "home_win": home_win,
            })

            last_snapshot_seconds = seconds_remaining

    return snapshots


def _game_id_to_season(game_id: str) -> int:
    """Extract season start year from NBA game ID.

    Game IDs: 00XYYZZZZZ where X=season type, YY=season year.
    e.g., 0022300001 -> season code at [3:5] = 23 -> 2023-24 -> return 2023
    """
    try:
        season_code = int(str(game_id).zfill(10)[3:5])
        if season_code < 50:
            return 2000 + season_code
        else:
            return 1900 + season_code
    except (ValueError, IndexError):
        return 0


def ingest_season(
    season: int,
    outcomes: dict[str, dict],
    odds: dict[str, dict] | None = None,
) -> int:
    """Ingest a single season of PBP data into training snapshots.

    Args:
        season: Start year of the season (e.g., 2023 for 2023-24).
        outcomes: dict of game_id -> {home_team, away_team, home_win, game_date}
        odds: optional dict of game_id -> {spread, home_ml_prob}

    Returns:
        Number of snapshots inserted.
    """
    try:
        pbp_df = download_pbp_season(season)
    except Exception as e:
        logger.error(f"Failed to download PBP for season {season}: {e}")
        return 0

    # Ensure GAME_ID is string
    pbp_df["GAME_ID"] = pbp_df["GAME_ID"].astype(str).str.zfill(10)

    game_ids = pbp_df["GAME_ID"].unique()
    logger.info(f"Processing {len(game_ids)} games for season {season}")

    all_snapshots: list[dict] = []

    for game_id in tqdm(game_ids, desc=f"Season {season}"):
        if game_id not in outcomes:
            continue

        game_events = pbp_df[pbp_df["GAME_ID"] == game_id]
        outcome = outcomes[game_id]

        # Get odds if available
        game_odds = (odds or {}).get(game_id, {})
        spread = game_odds.get("spread")
        ml_prob = game_odds.get("home_ml_prob")

        snapshots = extract_snapshots_from_game(
            game_events, game_id, outcome,
            pregame_spread=spread,
            pregame_home_ml_prob=ml_prob,
        )
        all_snapshots.extend(snapshots)

    if all_snapshots:
        # Deduplicate: keep last snapshot at each (game_id, period, seconds_remaining)
        seen: dict[tuple, int] = {}
        for i, snap in enumerate(all_snapshots):
            key = (snap["game_id"], snap["period"], snap["seconds_remaining"])
            seen[key] = i
        deduped = [all_snapshots[i] for i in sorted(seen.values())]
        logger.info(f"Upserting {len(deduped)} snapshots for season {season} (deduped from {len(all_snapshots)})")
        upsert_batch(
            "autopilot_training_snapshots",
            deduped,
            conflict_col="game_id,period,seconds_remaining",
        )

    return len(all_snapshots)


def ingest_all_seasons(
    start_season: int = 2014,
    end_season: int = 2025,
    odds: dict[str, dict] | None = None,
) -> int:
    """Ingest multiple seasons of PBP data.

    Returns total number of snapshots inserted.
    """
    logger.info(f"Fetching game outcomes from database...")
    outcomes = fetch_game_outcomes(start_season)
    logger.info(f"Found {len(outcomes)} completed games with outcomes")

    total = 0
    for season in range(start_season, end_season + 1):
        count = ingest_season(season, outcomes, odds)
        total += count
        logger.info(f"Season {season}: {count} snapshots (total: {total})")

    return total
