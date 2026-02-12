# shared/nba/nba_constants.py
"""
Shared NBA constants: team name mappings, abbreviations, IDs, etc.
Import and use in pipeline, features, predictions, etc.
"""

# Abbreviation (3-letter) → Full name
TEAM_ABBR_TO_FULL = {
    "ATL": "Atlanta Hawks",
    "BOS": "Boston Celtics",
    "BKN": "Brooklyn Nets",
    "CHA": "Charlotte Hornets",
    "CHI": "Chicago Bulls",
    "CLE": "Cleveland Cavaliers",
    "DAL": "Dallas Mavericks",
    "DEN": "Denver Nuggets",
    "DET": "Detroit Pistons",
    "GSW": "Golden State Warriors",
    "HOU": "Houston Rockets",
    "IND": "Indiana Pacers",
    "LAC": "Los Angeles Clippers",
    "LAL": "Los Angeles Lakers",
    "MEM": "Memphis Grizzlies",
    "MIA": "Miami Heat",
    "MIL": "Milwaukee Bucks",
    "MIN": "Minnesota Timberwolves",
    "NOP": "New Orleans Pelicans",
    "NYK": "New York Knicks",
    "OKC": "Oklahoma City Thunder",
    "ORL": "Orlando Magic",
    "PHI": "Philadelphia 76ers",
    "PHX": "Phoenix Suns",
    "POR": "Portland Trail Blazers",
    "SAC": "Sacramento Kings",
    "SAS": "San Antonio Spurs",
    "TOR": "Toronto Raptors",
    "UTA": "Utah Jazz",
    "WAS": "Washington Wizards",
}

# Full name → Team ID (NBA official)
TEAM_FULL_TO_ID = {v: k for k, v in TEAM_ABBR_TO_FULL.items()}  # reverse lookup if needed
# Or keep the explicit one if you have legacy mappings:
TEAM_NAME_TO_ID = {
    "Atlanta Hawks": "1610612737",
    "Boston Celtics": "1610612738",
    "Brooklyn Nets": "1610612751",
    "Charlotte Hornets": "1610612766",
    "Chicago Bulls": "1610612741",
    "Cleveland Cavaliers": "1610612739",
    "Dallas Mavericks": "1610612742",
    "Denver Nuggets": "1610612743",
    "Detroit Pistons": "1610612765",
    "Golden State Warriors": "1610612744",
    "Houston Rockets": "1610612745",
    "Indiana Pacers": "1610612754",
    "Los Angeles Clippers": "1610612746",
    "Los Angeles Lakers": "1610612747",
    "Memphis Grizzlies": "1610612763",
    "Miami Heat": "1610612748",
    "Milwaukee Bucks": "1610612749",
    "Minnesota Timberwolves": "1610612750",
    "New Orleans Pelicans": "1610612740",
    "New York Knicks": "1610612752",
    "Oklahoma City Thunder": "1610612760",
    "Orlando Magic": "1610612753",
    "Philadelphia 76ers": "1610612755",
    "Phoenix Suns": "1610612756",
    "Portland Trail Blazers": "1610612757",
    "Sacramento Kings": "1610612758",
    "San Antonio Spurs": "1610612759",
    "Toronto Raptors": "1610612761",
    "Utah Jazz": "1610612762",
    "Washington Wizards": "1610612764",
}
TEAM_ID_TO_NAME = {v: k for k, v in TEAM_NAME_TO_ID.items()}  # reverse lookup if needed

# Short display name (no "Los Angeles" etc.) → Full name
# Useful for scoreboard/live endpoints that return "Lakers", "Clippers", etc.
TEAM_SHORT_TO_FULL = {
    "Hawks": "Atlanta Hawks",
    "Celtics": "Boston Celtics",
    "Nets": "Brooklyn Nets",
    "Hornets": "Charlotte Hornets",
    "Bulls": "Chicago Bulls",
    "Cavaliers": "Cleveland Cavaliers",
    "Mavericks": "Dallas Mavericks",
    "Nuggets": "Denver Nuggets",
    "Pistons": "Detroit Pistons",
    "Warriors": "Golden State Warriors",
    "Rockets": "Houston Rockets",
    "Pacers": "Indiana Pacers",
    "Clippers": "Los Angeles Clippers",
    "Lakers": "Los Angeles Lakers",
    "Grizzlies": "Memphis Grizzlies",
    "Heat": "Miami Heat",
    "Bucks": "Milwaukee Bucks",
    "Timberwolves": "Minnesota Timberwolves",
    "Pelicans": "New Orleans Pelicans",
    "Knicks": "New York Knicks",
    "Thunder": "Oklahoma City Thunder",
    "Magic": "Orlando Magic",
    "76ers": "Philadelphia 76ers",
    "Suns": "Phoenix Suns",
    "Trail Blazers": "Portland Trail Blazers",
    "Kings": "Sacramento Kings",
    "Spurs": "San Antonio Spurs",
    "Raptors": "Toronto Raptors",
    "Jazz": "Utah Jazz",
    "Wizards": "Washington Wizards",
}

# You can add more later: conferences, divisions, colors, logos URLs, etc.
