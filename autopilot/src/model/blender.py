"""Probability smoothing and blending layer.

Sits between the raw WinProbModel output and the trading decision layer.
Applies exponential smoothing to dampen single-basket probability swings,
then blends the smoothed model output with pregame moneyline probability
on a time-weighted schedule so that early-game outputs lean on market
priors and late-game outputs lean on live inference.
"""

from dataclasses import dataclass, field


@dataclass
class BlendConfig:
    """Tuning knobs for the blending layer."""

    # EMA weight for new observation (0-1).
    # Lower = smoother (more lag). Higher = more responsive (less dampening).
    smoothing_alpha: float = 0.3

    # Pregame weight by game phase.
    # Evaluated top-to-bottom; first matching threshold wins.
    # time_fraction = seconds_remaining / 2880 (1.0 at tip-off, 0.0 at buzzer).
    phase_weights: list[tuple[float, float]] = field(default_factory=lambda: [
        # (min_time_fraction, pregame_weight)
        (0.75, 0.60),  # Q1: 60% pregame / 40% model
        (0.50, 0.45),  # Q2: 45% pregame / 55% model
        (0.25, 0.30),  # Q3: 30% pregame / 70% model
        (0.05, 0.15),  # Q4 (most): 15% pregame / 85% model
        (0.00, 0.05),  # Final minutes: 5% pregame / 95% model
    ])


class ProbabilityBlender:
    """Per-game probability smoothing and pregame blending.

    Lifecycle: one instance per TrackedGame. Created when the game
    first appears in the orchestrator, discarded when the game ends.

    Usage:
        blender = ProbabilityBlender()
        blended = blender.update(raw_model_prob, pregame_ml_prob, time_fraction)
    """

    def __init__(self, config: BlendConfig | None = None):
        self.config = config or BlendConfig()
        self._smoothed: float | None = None

    @property
    def smoothed_prob(self) -> float | None:
        """Last smoothed (but not yet blended) probability.

        Exposed for diagnostic logging. Not used in the trading path.
        """
        return self._smoothed

    def update(
        self,
        raw_model_prob: float,
        pregame_home_ml_prob: float | None,
        time_fraction: float,
    ) -> float:
        """Apply smoothing + blending and return the final probability.

        Args:
            raw_model_prob: P(home wins) from WinProbModel.predict(), in [0, 1].
            pregame_home_ml_prob: Pregame moneyline implied probability (0-1),
                or None if unavailable (falls back to 0.5).
            time_fraction: seconds_remaining / 2880. 1.0 at tip-off, 0.0 at
                end of regulation. Can exceed 1.0 briefly or go slightly
                negative in OT; clamped internally.

        Returns:
            Blended probability in [0.01, 0.99].
        """
        alpha = self.config.smoothing_alpha

        # 1. Exponential smoothing
        if self._smoothed is None:
            # First observation — no history to smooth against
            self._smoothed = raw_model_prob
        else:
            self._smoothed = alpha * raw_model_prob + (1.0 - alpha) * self._smoothed

        # 2. Time-weighted blending with pregame
        pregame = pregame_home_ml_prob if pregame_home_ml_prob is not None else 0.5
        tf = max(0.0, min(1.0, time_fraction))

        pregame_weight = self._get_pregame_weight(tf)
        blended = pregame_weight * pregame + (1.0 - pregame_weight) * self._smoothed

        # Clamp to avoid degenerate 0% / 100% values
        return max(0.01, min(0.99, blended))

    def _get_pregame_weight(self, time_fraction: float) -> float:
        """Look up pregame weight from the phase schedule.

        The schedule is evaluated top-to-bottom. The first entry whose
        threshold is <= time_fraction is used.
        """
        for threshold, weight in self.config.phase_weights:
            if time_fraction >= threshold:
                return weight
        # Fallback (should never happen if schedule covers 0.0)
        return 0.05

    def reset(self) -> None:
        """Reset smoothing state. Called if the game data is stale or restarted."""
        self._smoothed = None
