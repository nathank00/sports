"""MLB game state representation and feature vector extraction.

Defines the single source of truth for converting raw MLB game state
into model input for the live autopilot system.
"""

from dataclasses import dataclass
from autopilot.src.features.mlb_constants import (
    MLB_FEATURE_NAMES,
    MLB_NUM_FEATURES,
    MLB_TOTAL_REGULATION_OUTS,
    MLB_OUTS_PER_INNING,
    MLB_DEFAULTS,
)


@dataclass(frozen=True)
class MLBGameState:
    """Immutable MLB game state snapshot. The model's input interface."""

    home_score: int
    away_score: int
    inning: int                       # 1-9, 10+ for extras
    inning_half: str                  # "top" or "bottom"
    outs: int                         # 0-3 outs in current half-inning
    pregame_spread: float | None      # negative = home favored
    pregame_home_ml_prob: float | None


def compute_outs_remaining(inning: int, inning_half: str, outs: int) -> int:
    """Compute total outs remaining in the game.

    For regulation (innings 1-9):
        outs_remaining = remaining_full_innings * 6 + remaining_half_innings * 3 + (3 - outs)

    For extras (inning 10+):
        outs_remaining = (3 - outs) in current half + 3 if top (away still batting)
    """
    outs_in_half = min(outs, 3)

    if inning <= 9:
        # Full innings remaining after current inning
        remaining_full_innings = 9 - inning
        # Half-innings remaining in current inning
        if inning_half == "top":
            # Top: still have rest of top + bottom of this inning + remaining full innings
            outs_remaining = (3 - outs_in_half) + 3 + remaining_full_innings * 6
        else:
            # Bottom: just rest of this half + remaining full innings
            outs_remaining = (3 - outs_in_half) + remaining_full_innings * 6
    else:
        # Extra innings: just this inning's remaining outs
        if inning_half == "top":
            outs_remaining = (3 - outs_in_half) + 3  # rest of top + bottom
        else:
            outs_remaining = (3 - outs_in_half)  # rest of bottom

    return max(outs_remaining, 0)


def compute_outs_elapsed(inning: int, inning_half: str, outs: int) -> int:
    """Compute total outs elapsed so far in the game."""
    outs_in_half = min(outs, 3)

    # Full innings completed before current inning
    completed_innings = inning - 1
    elapsed = completed_innings * MLB_OUTS_PER_INNING

    if inning_half == "top":
        elapsed += outs_in_half
    else:
        # Top of this inning is complete (3 outs) + current bottom outs
        elapsed += 3 + outs_in_half

    return elapsed


def mlb_game_state_to_feature_vector(state: MLBGameState) -> list[float]:
    """Convert an MLBGameState into a fixed-length numeric feature vector.

    Returns list of floats in the order defined by MLB_FEATURE_NAMES.
    All None values are replaced with sensible defaults.
    """
    score_margin = float(state.home_score - state.away_score)

    outs_elapsed = compute_outs_elapsed(state.inning, state.inning_half, state.outs)
    outs_fraction = min(outs_elapsed / MLB_TOTAL_REGULATION_OUTS, 1.5)  # cap at 1.5 for extras

    inning = float(min(state.inning, 12))  # cap extras at 12

    is_home_batting = 1.0 if state.inning_half == "bottom" else -1.0

    spread = state.pregame_spread if state.pregame_spread is not None else MLB_DEFAULTS["pregame_spread"]
    ml_prob = state.pregame_home_ml_prob if state.pregame_home_ml_prob is not None else MLB_DEFAULTS["pregame_home_ml_prob"]

    # Interaction features
    margin_x_outs_frac = score_margin * outs_fraction
    spread_x_outs_frac = spread * outs_fraction

    vector = [
        score_margin,
        outs_fraction,
        inning,
        is_home_batting,
        spread,
        ml_prob,
        margin_x_outs_frac,
        spread_x_outs_frac,
    ]

    assert len(vector) == MLB_NUM_FEATURES, f"Expected {MLB_NUM_FEATURES} features, got {len(vector)}"
    return vector
