# shared/mlb/mlb_constants.py
"""MLB team constants and mappings."""

# MLB team ID → full name (all 30 teams)
TEAM_ID_TO_NAME = {
    108: "Los Angeles Angels",
    109: "Arizona Diamondbacks",
    110: "Baltimore Orioles",
    111: "Boston Red Sox",
    112: "Chicago Cubs",
    113: "Cincinnati Reds",
    114: "Cleveland Guardians",
    115: "Colorado Rockies",
    116: "Detroit Tigers",
    117: "Houston Astros",
    118: "Kansas City Royals",
    119: "Los Angeles Dodgers",
    120: "Washington Nationals",
    121: "New York Mets",
    133: "Oakland Athletics",
    134: "Pittsburgh Pirates",
    135: "San Diego Padres",
    136: "Seattle Mariners",
    137: "San Francisco Giants",
    138: "St. Louis Cardinals",
    139: "Tampa Bay Rays",
    140: "Texas Rangers",
    141: "Toronto Blue Jays",
    142: "Minnesota Twins",
    143: "Philadelphia Phillies",
    144: "Atlanta Braves",
    145: "Chicago White Sox",
    146: "Miami Marlins",
    147: "New York Yankees",
    158: "Milwaukee Brewers",
}

# Full name → team ID
TEAM_NAME_TO_ID = {v: k for k, v in TEAM_ID_TO_NAME.items()}

# MLB team ID → abbreviation
TEAM_ID_TO_ABBR = {
    108: "LAA",
    109: "ARI",
    110: "BAL",
    111: "BOS",
    112: "CHC",
    113: "CIN",
    114: "CLE",
    115: "COL",
    116: "DET",
    117: "HOU",
    118: "KC",
    119: "LAD",
    120: "WSH",
    121: "NYM",
    133: "OAK",
    134: "PIT",
    135: "SD",
    136: "SEA",
    137: "SF",
    138: "STL",
    139: "TB",
    140: "TEX",
    141: "TOR",
    142: "MIN",
    143: "PHI",
    144: "ATL",
    145: "CWS",
    146: "MIA",
    147: "NYY",
    158: "MIL",
}

# Abbreviation → team ID
TEAM_ABBR_TO_ID = {v: k for k, v in TEAM_ID_TO_ABBR.items()}

# Abbreviation → full name
TEAM_ABBR_TO_NAME = {abbr: TEAM_ID_TO_NAME[tid] for abbr, tid in TEAM_ABBR_TO_ID.items()}

# Full name → abbreviation
TEAM_NAME_TO_ABBR = {v: k for k, v in TEAM_ABBR_TO_NAME.items()}

# All team IDs
ALL_TEAM_IDS = list(TEAM_ID_TO_NAME.keys())
