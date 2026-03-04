"""Per-game state tracking and change detection.

Maintains running state for each active game, detects meaningful
changes that should trigger model re-evaluation, and builds
GameState objects from raw poll data.
"""

import time
from dataclasses import dataclass, field

from autopilot.src.features.snapshot import GameState


def estimate_possessions(fga: int, fta: int, oreb: int, tov: int) -> int:
    """Estimate possessions using the standard formula.

    possessions ≈ FGA - OREB + TOV + 0.44 * FTA
    """
    return max(1, int(round(fga - oreb + tov + 0.44 * fta)))


@dataclass
class TrackedGame:
    """Tracks a single live game's state across polls."""

    # Game identification
    nba_game_id: str
    espn_game_id: str | None = None
    home_team: str = ""   # 3-letter abbreviation
    away_team: str = ""

    # Pre-game context (set once at tip-off, never changes)
    pregame_spread: float | None = None
    pregame_home_ml_prob: float | None = None
    pregame_odds_fetched: bool = False

    # Running box score accumulators (updated from each poll)
    home_fgm: int = 0
    home_fga: int = 0
    home_ftm: int = 0
    home_fta: int = 0
    home_oreb: int = 0
    home_tov: int = 0
    away_fgm: int = 0
    away_fga: int = 0
    away_ftm: int = 0
    away_fta: int = 0
    away_oreb: int = 0
    away_tov: int = 0

    # Current known state
    last_home_score: int = 0
    last_away_score: int = 0
    last_period: int = 0
    last_seconds_remaining: float = 2880.0
    last_possession_home: bool | None = None
    last_home_fouls: int = 0
    last_away_fouls: int = 0
    last_home_timeouts: int = 0
    last_away_timeouts: int = 0

    # Timestamps for rate limiting
    last_signal_time: float = 0.0     # time.monotonic() of last signal written
    last_state_change_time: float = 0.0

    # Kalshi market info (refreshed periodically, not every tick)
    kalshi_markets: list = field(default_factory=list)
    kalshi_markets_updated: float = 0.0

    def has_state_changed(
        self,
        home_score: int,
        away_score: int,
        period: int,
        seconds_remaining: float,
        possession_home: bool | None,
    ) -> bool:
        """Detect if the game state has meaningfully changed.

        A state change triggers model re-evaluation. Changes that matter:
        - Score changed (any basket)
        - Period changed (quarter transition)
        - Possession changed
        - 30+ seconds elapsed since last evaluation
        """
        if home_score != self.last_home_score:
            return True
        if away_score != self.last_away_score:
            return True
        if period != self.last_period:
            return True
        if possession_home != self.last_possession_home and possession_home is not None:
            return True
        if abs(self.last_seconds_remaining - seconds_remaining) >= 30:
            return True
        return False

    def update_state(
        self,
        home_score: int,
        away_score: int,
        period: int,
        seconds_remaining: float,
        possession_home: bool | None,
        home_stats: dict | None = None,
        away_stats: dict | None = None,
        home_timeouts: int | None = None,
        away_timeouts: int | None = None,
        home_fouls: int | None = None,
        away_fouls: int | None = None,
    ) -> None:
        """Update the tracked game with new poll data."""
        self.last_home_score = home_score
        self.last_away_score = away_score
        self.last_period = period
        self.last_seconds_remaining = seconds_remaining
        if possession_home is not None:
            self.last_possession_home = possession_home
        self.last_state_change_time = time.monotonic()

        # Update box score accumulators from team stats
        if home_stats:
            self.home_fgm = home_stats.get("fgm", self.home_fgm)
            self.home_fga = home_stats.get("fga", self.home_fga)
            self.home_ftm = home_stats.get("ftm", self.home_ftm)
            self.home_fta = home_stats.get("fta", self.home_fta)
            self.home_oreb = home_stats.get("oreb", self.home_oreb)
            self.home_tov = home_stats.get("tov", self.home_tov)

        if away_stats:
            self.away_fgm = away_stats.get("fgm", self.away_fgm)
            self.away_fga = away_stats.get("fga", self.away_fga)
            self.away_ftm = away_stats.get("ftm", self.away_ftm)
            self.away_fta = away_stats.get("fta", self.away_fta)
            self.away_oreb = away_stats.get("oreb", self.away_oreb)
            self.away_tov = away_stats.get("tov", self.away_tov)

        if home_timeouts is not None:
            self.last_home_timeouts = home_timeouts
        if away_timeouts is not None:
            self.last_away_timeouts = away_timeouts
        if home_fouls is not None:
            self.last_home_fouls = home_fouls
        if away_fouls is not None:
            self.last_away_fouls = away_fouls

    def build_game_state(self) -> GameState:
        """Build a GameState from the current tracked data.

        Computes offensive/defensive ratings and pace from box score accumulators.
        """
        h_poss = estimate_possessions(
            self.home_fga, self.home_fta, self.home_oreb, self.home_tov
        )
        a_poss = estimate_possessions(
            self.away_fga, self.away_fta, self.away_oreb, self.away_tov
        )

        total_poss = h_poss + a_poss
        elapsed_seconds = 2880 - self.last_seconds_remaining
        elapsed_minutes = max(elapsed_seconds / 60.0, 1.0)

        # Only compute ratings if we have enough data
        home_off = None
        away_off = None
        home_def = None
        away_def = None
        pace = None

        if h_poss > 5 and a_poss > 5:
            home_off = (self.last_home_score / h_poss) * 100
            away_off = (self.last_away_score / a_poss) * 100
            home_def = (self.last_away_score / h_poss) * 100
            away_def = (self.last_home_score / a_poss) * 100

        if elapsed_minutes > 2.0 and total_poss > 10:
            pace = (total_poss / elapsed_minutes) * 48

        return GameState(
            home_score=self.last_home_score,
            away_score=self.last_away_score,
            period=self.last_period,
            seconds_remaining=self.last_seconds_remaining,
            home_has_possession=self.last_possession_home,
            pregame_spread=self.pregame_spread,
            pregame_home_ml_prob=self.pregame_home_ml_prob,
            home_off_rating=round(home_off, 1) if home_off else None,
            away_off_rating=round(away_off, 1) if away_off else None,
            home_def_rating=round(home_def, 1) if home_def else None,
            away_def_rating=round(away_def, 1) if away_def else None,
            pace=round(pace, 1) if pace else None,
            home_possessions=h_poss,
            away_possessions=a_poss,
            home_timeouts=self.last_home_timeouts,
            away_timeouts=self.last_away_timeouts,
            home_team_fouls=self.last_home_fouls,
            away_team_fouls=self.last_away_fouls,
        )
