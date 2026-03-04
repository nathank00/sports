"""Feature definitions for the autopilot win probability model."""

# Ordered list of feature names used by the model.
# Both calibration and live inference produce vectors in this exact order.
FEATURE_NAMES: list[str] = [
    "score_margin",           # home_score - away_score
    "time_fraction",          # seconds_remaining / 2880 (normalized 0-1)
    "period",                 # 1-4, 5+ for OT
    "possession_indicator",   # +1.0 home, -1.0 away, 0.0 unknown
    "pregame_spread",         # home spread (negative = home favored)
    "pregame_home_ml_prob",   # moneyline implied probability for home
    "home_off_rating",        # points per 100 possessions (live so far)
    "away_off_rating",
    "home_def_rating",        # opponent points per 100 possessions allowed
    "away_def_rating",
    "pace",                   # estimated possessions per 48 min
    "home_possessions",
    "away_possessions",
    "home_timeouts",
    "away_timeouts",
    "home_team_fouls",
    "away_team_fouls",
    "margin_x_time",          # score_margin * time_fraction (interaction)
    "spread_x_time",          # pregame_spread * time_fraction (interaction)
]

NUM_FEATURES = len(FEATURE_NAMES)

# Regulation game length in seconds (4 quarters * 12 minutes)
REGULATION_SECONDS = 2880

# Default values used when data is unavailable
DEFAULTS = {
    "pregame_spread": 0.0,
    "pregame_home_ml_prob": 0.5,
    "off_rating": 110.0,      # league average ~110 pts/100 poss
    "def_rating": 110.0,
    "pace": 100.0,            # league average ~100 possessions/game
}
