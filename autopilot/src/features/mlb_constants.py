"""Feature definitions for the MLB autopilot win probability model."""

# Ordered list of feature names used by the model.
MLB_FEATURE_NAMES: list[str] = [
    "score_margin",           # home_score - away_score
    "outs_fraction",          # outs_elapsed / 54 (normalized 0-1, regulation)
    "inning",                 # 1-9, 10+ for extras
    "is_home_batting",        # +1.0 if home batting (bottom), -1.0 if away batting (top)
    "pregame_spread",         # home spread (negative = home favored)
    "pregame_home_ml_prob",   # moneyline implied probability for home
    "margin_x_outs_frac",    # score_margin * outs_fraction (interaction)
    "spread_x_outs_frac",    # pregame_spread * outs_fraction (interaction)
]

MLB_NUM_FEATURES = len(MLB_FEATURE_NAMES)

# Regulation game structure
MLB_REGULATION_INNINGS = 9
MLB_OUTS_PER_HALF_INNING = 3
MLB_OUTS_PER_INNING = 6       # 3 per half-inning × 2 halves
MLB_TOTAL_REGULATION_OUTS = 54  # 9 × 6

# Default values used when data is unavailable
MLB_DEFAULTS = {
    "pregame_spread": 0.0,
    "pregame_home_ml_prob": 0.5,
}
