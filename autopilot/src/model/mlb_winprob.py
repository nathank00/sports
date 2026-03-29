"""MLB in-game win probability model.

Simple logistic regression with hand-calibrated coefficients derived from
well-known baseball win expectancy tables. Uses score margin, game progress
(outs elapsed), inning, batting side, and pregame odds.

No training data needed — coefficients are set analytically based on:
- Historical win expectancy by score differential and inning
- Home team advantage (~54% base rate)
- Pregame odds as informative prior (strong early, weak late)

Runs in microseconds, deterministic, no I/O after init.
"""

import math

from autopilot.src.features.mlb_snapshot import (
    MLBGameState,
    mlb_game_state_to_feature_vector,
)


class MLBWinProbModel:
    """Analytical MLB win probability model."""

    def __init__(self):
        self.version = "mlb_winprob_analytical_v1"

        # Hand-calibrated coefficients for MLB win probability.
        #
        # Feature order (matches mlb_constants.MLB_FEATURE_NAMES):
        #   0: score_margin       — each run ≈ +13% mid-game (sigmoid compresses)
        #   1: outs_fraction      — game progress, negative = more extreme outcomes late
        #   2: inning             — small additional late-game effect
        #   3: is_home_batting    — slight home advantage when batting
        #   4: pregame_spread     — run line prior
        #   5: pregame_home_ml_prob — moneyline prior (strongest feature early)
        #   6: margin_x_outs_frac — runs matter MORE as game progresses
        #   7: spread_x_outs_frac — spread influence fades over time
        #
        # Calibrated against historical baseball win expectancy tables:
        # - 1-run lead in 2nd ≈ 57% | 3-run lead in 2nd ≈ 85%
        # - 1-run lead in 9th ≈ 79% | 3-run lead in 7th ≈ 96%
        # - Tied game ≈ pregame odds early, ≈ 50% late
        # - 5-0 lead in 5th ≈ 99%
        #
        # v2: reduced pregame prior (1.80→1.10), increased margin_x_outs interaction
        # (0.45→0.85) so scoring events dominate over pregame anchoring.
        self.intercept = 0.0
        self.coefficients = [
            0.55,    # score_margin: base per-run impact (~13% at midpoint)
            -0.10,   # outs_fraction: slight compression as game ends
            0.02,    # inning: minimal direct effect
            0.08,    # is_home_batting: small home batting advantage
            -0.12,   # pregame_spread: each run of spread ≈ 3%
            1.10,    # pregame_home_ml_prob: moderate prior (reduced from 1.80 to prevent anchoring)
            0.85,    # margin_x_outs_frac: runs matter more late — strong interaction
            0.06,    # spread_x_outs_frac: pregame info fades as game progresses
        ]

    def predict(self, state: MLBGameState) -> float:
        """Compute P(home team wins) given the current MLB game state.

        Pure function: deterministic, no side effects, no I/O.
        Returns float in [0, 1].
        """
        features = mlb_game_state_to_feature_vector(state)

        # Center pregame_home_ml_prob around 0.5 so the intercept stays at 0
        # (a 50/50 game with 0-0 score should predict ~50%)
        features[5] = features[5] - 0.5

        logit = self.intercept + sum(
            c * f for c, f in zip(self.coefficients, features)
        )
        return 1.0 / (1.0 + math.exp(-logit))
