"""Per-game state tracking and change detection for MLB.

Maintains running state for each active MLB game, detects meaningful
changes that should trigger model re-evaluation, and builds
MLBGameState objects from raw poll data.
"""

import time
from dataclasses import dataclass, field

from autopilot.src.features.mlb_snapshot import MLBGameState, compute_outs_remaining
from autopilot.src.model.blender import ProbabilityBlender
from autopilot.src.features.mlb_constants import MLB_TOTAL_REGULATION_OUTS


@dataclass
class MLBTrackedGame:
    """Tracks a single live MLB game's state across polls."""

    # Game identification
    espn_game_id: str
    home_team: str = ""   # abbreviation
    away_team: str = ""

    # Pre-game context (set once, never changes)
    pregame_spread: float | None = None
    pregame_home_ml_prob: float | None = None
    pregame_odds_fetched: bool = False

    # Running box score accumulators
    home_hits: int = 0
    away_hits: int = 0
    home_errors: int = 0
    away_errors: int = 0

    # Current known state
    last_home_score: int = 0
    last_away_score: int = 0
    last_inning: int = 0
    last_inning_half: str = "top"   # "top", "bottom", "end"
    last_outs: int = 0
    last_runners: int = 0           # count of runners on base (0-3)

    # Timestamps for rate limiting
    last_signal_time: float = 0.0
    last_state_change_time: float = 0.0

    # Kalshi market info (refreshed periodically)
    kalshi_markets: list = field(default_factory=list)
    kalshi_markets_updated: float = 0.0

    # Probability blender (smoothing + pregame blend)
    blender: ProbabilityBlender = field(default_factory=ProbabilityBlender)

    # Last probabilities (for logging/diagnostics)
    last_blended_prob: float | None = None
    last_raw_model_prob: float | None = None

    def has_state_changed(
        self,
        home_score: int,
        away_score: int,
        inning: int,
        inning_half: str,
        outs: int,
    ) -> bool:
        """Detect if the game state has meaningfully changed.

        Changes that trigger model re-evaluation:
        - Score changed (any run)
        - Inning changed
        - Half-inning changed (top → bottom)
        - Outs changed
        - 60+ seconds elapsed since last evaluation
        """
        if home_score != self.last_home_score:
            return True
        if away_score != self.last_away_score:
            return True
        if inning != self.last_inning:
            return True
        if inning_half != self.last_inning_half:
            return True
        if outs != self.last_outs:
            return True
        if time.monotonic() - self.last_state_change_time >= 60:
            return True
        return False

    def update_state(
        self,
        home_score: int,
        away_score: int,
        inning: int,
        inning_half: str,
        outs: int,
        runners: int = 0,
        home_hits: int | None = None,
        away_hits: int | None = None,
        home_errors: int | None = None,
        away_errors: int | None = None,
    ) -> None:
        """Update the tracked game with new poll data."""
        self.last_home_score = home_score
        self.last_away_score = away_score
        self.last_inning = inning
        self.last_inning_half = inning_half
        self.last_outs = outs
        self.last_runners = runners
        self.last_state_change_time = time.monotonic()

        if home_hits is not None:
            self.home_hits = home_hits
        if away_hits is not None:
            self.away_hits = away_hits
        if home_errors is not None:
            self.home_errors = home_errors
        if away_errors is not None:
            self.away_errors = away_errors

    def build_game_state(self) -> MLBGameState:
        """Build an MLBGameState from the current tracked data."""
        # Normalize inning_half for model: "end" → "bottom" (end of inning = bottom is done)
        half = self.last_inning_half
        if half == "end":
            half = "bottom"

        return MLBGameState(
            home_score=self.last_home_score,
            away_score=self.last_away_score,
            inning=self.last_inning,
            inning_half=half,
            outs=self.last_outs,
            pregame_spread=self.pregame_spread,
            pregame_home_ml_prob=self.pregame_home_ml_prob,
        )

    def get_outs_remaining(self) -> int:
        """Get outs remaining in the game."""
        half = self.last_inning_half
        if half == "end":
            half = "bottom"
        return compute_outs_remaining(self.last_inning, half, self.last_outs)
