"""Stateless win probability model.

Loads logistic regression coefficients from a JSON file and computes
P(home team wins) given a GameState. No I/O after init, no side effects,
deterministic, runs in microseconds.
"""

import json
import math
from pathlib import Path

from autopilot.src.features.snapshot import GameState, game_state_to_feature_vector


class WinProbModel:
    """Logistic regression win probability model."""

    def __init__(self, coefficients_path: Path):
        with open(coefficients_path) as f:
            data = json.load(f)

        self.version: str = data["version"]
        self.feature_names: list[str] = data["features"]
        self.intercept: float = data["intercept"]
        self.coefficients: list[float] = data["coefficients"]

        if len(self.coefficients) != len(self.feature_names):
            raise ValueError(
                f"Coefficient count ({len(self.coefficients)}) does not match "
                f"feature count ({len(self.feature_names)})"
            )

    def predict(self, state: GameState) -> float:
        """Compute P(home team wins) given the current game state.

        Pure function: deterministic, no side effects, no I/O.
        Returns float in [0, 1].
        """
        features = game_state_to_feature_vector(state)
        logit = self.intercept + sum(
            c * f for c, f in zip(self.coefficients, features)
        )
        return 1.0 / (1.0 + math.exp(-logit))
