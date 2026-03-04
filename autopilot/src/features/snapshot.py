"""Game state representation and feature vector extraction.

This module defines the single source of truth for converting raw game state
into model input. Used by both the calibration pipeline (from historical PBP)
and the live system (from ESPN/nba_api data).
"""

from dataclasses import dataclass
from autopilot.src.features.constants import (
    FEATURE_NAMES,
    NUM_FEATURES,
    REGULATION_SECONDS,
    DEFAULTS,
)


@dataclass(frozen=True)
class GameState:
    """Immutable game state snapshot. The model's input interface."""

    home_score: int
    away_score: int
    period: int                        # 1-4, 5+ for OT
    seconds_remaining: float           # total seconds left in game
    home_has_possession: bool | None   # None = unknown
    pregame_spread: float | None       # negative = home favored
    pregame_home_ml_prob: float | None
    home_off_rating: float | None
    away_off_rating: float | None
    home_def_rating: float | None
    away_def_rating: float | None
    pace: float | None
    home_possessions: int | None
    away_possessions: int | None
    home_timeouts: int | None
    away_timeouts: int | None
    home_team_fouls: int | None
    away_team_fouls: int | None


def game_state_to_feature_vector(state: GameState) -> list[float]:
    """Convert a GameState into a fixed-length numeric feature vector.

    Returns list of floats in the order defined by FEATURE_NAMES.
    All None values are replaced with sensible defaults.
    """
    score_margin = float(state.home_score - state.away_score)
    time_fraction = state.seconds_remaining / REGULATION_SECONDS
    period = float(min(state.period, 5))  # cap OT at 5

    if state.home_has_possession is True:
        possession_indicator = 1.0
    elif state.home_has_possession is False:
        possession_indicator = -1.0
    else:
        possession_indicator = 0.0

    spread = state.pregame_spread if state.pregame_spread is not None else DEFAULTS["pregame_spread"]
    ml_prob = state.pregame_home_ml_prob if state.pregame_home_ml_prob is not None else DEFAULTS["pregame_home_ml_prob"]

    home_off = state.home_off_rating if state.home_off_rating is not None else DEFAULTS["off_rating"]
    away_off = state.away_off_rating if state.away_off_rating is not None else DEFAULTS["off_rating"]
    home_def = state.home_def_rating if state.home_def_rating is not None else DEFAULTS["def_rating"]
    away_def = state.away_def_rating if state.away_def_rating is not None else DEFAULTS["def_rating"]
    pace = state.pace if state.pace is not None else DEFAULTS["pace"]

    home_poss = float(state.home_possessions or 0)
    away_poss = float(state.away_possessions or 0)
    home_to = float(state.home_timeouts or 0)
    away_to = float(state.away_timeouts or 0)
    home_fouls = float(state.home_team_fouls or 0)
    away_fouls = float(state.away_team_fouls or 0)

    # Interaction features
    margin_x_time = score_margin * time_fraction
    spread_x_time = spread * time_fraction

    vector = [
        score_margin,
        time_fraction,
        period,
        possession_indicator,
        spread,
        ml_prob,
        home_off,
        away_off,
        home_def,
        away_def,
        pace,
        home_poss,
        away_poss,
        home_to,
        away_to,
        home_fouls,
        away_fouls,
        margin_x_time,
        spread_x_time,
    ]

    assert len(vector) == NUM_FEATURES, f"Expected {NUM_FEATURES} features, got {len(vector)}"
    return vector
