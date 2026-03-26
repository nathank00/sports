"""ESPN hidden API async client for live MLB game data.

Primary free data source. Polls ESPN's undocumented JSON endpoints
for live scores, inning state, and box score data.

Endpoints:
  Scoreboard: site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard
  Game detail: site.web.api.espn.com/apis/site/v2/sports/baseball/mlb/summary?event={id}
"""

import json
import logging
import urllib.request

import aiohttp

logger = logging.getLogger(__name__)

ESPN_SCOREBOARD_URL = (
    "https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard"
)
ESPN_SUMMARY_URL = (
    "https://site.web.api.espn.com/apis/site/v2/sports/baseball/mlb/summary"
)

# Normalize ESPN abbreviations to match Kalshi ticker format.
# ESPN and Kalshi differ for several teams.
ESPN_MLB_ABBR_MAP: dict[str, str] = {
    "ARI": "AZ",     # ESPN: ARI, Kalshi: AZ
    "OAK": "ATH",    # ESPN: OAK, Kalshi: ATH (Athletics)
    "CHW": "CWS",    # ESPN: CHW, Kalshi: CWS
    # WSH stays as WSH (both ESPN and Kalshi use WSH)
}


def normalize_espn_mlb_abbr(abbr: str) -> str:
    """Normalize ESPN MLB team abbreviation to standard form."""
    return ESPN_MLB_ABBR_MAP.get(abbr, abbr)


def fetch_mlb_scoreboard_by_date(date_str: str) -> list[dict]:
    """Fetch completed MLB games for a specific date (sync).

    Args:
        date_str: Date in YYYYMMDD format.

    Returns list of dicts for completed games.
    """
    url = f"{ESPN_SCOREBOARD_URL}?dates={date_str}"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read())
    except Exception as e:
        logger.error(f"ESPN MLB scoreboard fetch for {date_str} failed: {e}")
        return []

    games = []
    for event in data.get("events", []):
        competition = (event.get("competitions") or [{}])[0]
        status_type = event.get("status", {}).get("type", {}).get("state", "pre")

        if status_type != "post":
            continue

        competitors = competition.get("competitors", [])
        home = next((c for c in competitors if c.get("homeAway") == "home"), {})
        away = next((c for c in competitors if c.get("homeAway") == "away"), {})

        home_score = int(home.get("score", 0) or 0)
        away_score = int(away.get("score", 0) or 0)

        games.append({
            "espn_game_id": event.get("id", ""),
            "home_team": normalize_espn_mlb_abbr(home.get("team", {}).get("abbreviation", "")),
            "away_team": normalize_espn_mlb_abbr(away.get("team", {}).get("abbreviation", "")),
            "home_score": home_score,
            "away_score": away_score,
            "home_win": home_score > away_score,
        })

    return games


async def fetch_mlb_live_scoreboard(session: aiohttp.ClientSession) -> list[dict]:
    """Fetch today's MLB scoreboard from ESPN.

    Returns list of dicts, one per active/scheduled game:
    {
        "espn_game_id": str,
        "status": "in" | "pre" | "post",
        "home_team": str (abbreviation),
        "away_team": str,
        "home_score": int,
        "away_score": int,
        "inning": int,
        "inning_half": "top" | "bottom" | "",
        "outs": int,
    }
    """
    try:
        async with session.get(ESPN_SCOREBOARD_URL, timeout=aiohttp.ClientTimeout(total=10)) as resp:
            if resp.status != 200:
                logger.warning(f"ESPN MLB scoreboard returned {resp.status}")
                return []
            data = await resp.json()
    except Exception as e:
        logger.warning(f"ESPN MLB scoreboard fetch failed: {e}")
        return []

    games = []
    for event in data.get("events", []):
        competition = (event.get("competitions") or [{}])[0]
        status_obj = event.get("status", {})
        status_type = status_obj.get("type", {}).get("state", "pre")

        competitors = competition.get("competitors", [])
        home = next((c for c in competitors if c.get("homeAway") == "home"), {})
        away = next((c for c in competitors if c.get("homeAway") == "away"), {})

        home_team = normalize_espn_mlb_abbr(home.get("team", {}).get("abbreviation", ""))
        away_team = normalize_espn_mlb_abbr(away.get("team", {}).get("abbreviation", ""))

        # Inning info from situation
        situation = competition.get("situation", {})
        inning = int(status_obj.get("period", 0))

        # Determine half-inning from situation
        inning_half = ""
        if status_type == "in":
            # ESPN uses "isTopInning" in the situation
            if situation.get("isTopInning") is True:
                inning_half = "top"
            elif situation.get("isTopInning") is False:
                inning_half = "bottom"
            else:
                # Fallback: check displayClock or shortDetail
                detail = status_obj.get("type", {}).get("shortDetail", "").lower()
                if "top" in detail:
                    inning_half = "top"
                elif "bot" in detail or "bottom" in detail:
                    inning_half = "bottom"
                elif "end" in detail:
                    inning_half = "end"

        outs = int(situation.get("outs", 0))

        games.append({
            "espn_game_id": event.get("id", ""),
            "status": status_type,
            "home_team": home_team,
            "away_team": away_team,
            "home_score": int(home.get("score", 0) or 0),
            "away_score": int(away.get("score", 0) or 0),
            "inning": inning,
            "inning_half": inning_half,
            "outs": outs,
        })

    return games


async def fetch_mlb_live_game_detail(
    session: aiohttp.ClientSession,
    espn_game_id: str,
) -> dict | None:
    """Fetch detailed MLB game data for a single game.

    Returns dict with:
    {
        "home_team": str,
        "away_team": str,
        "home_score": int,
        "away_score": int,
        "inning": int,
        "inning_half": "top" | "bottom" | "end",
        "outs": int,
        "runners_on_base": int (0-3, count of occupied bases),
        "home_hits": int,
        "away_hits": int,
        "home_errors": int,
        "away_errors": int,
        "pregame_spread": float | None,
        "pregame_home_ml_prob": float | None,
    }
    """
    url = f"{ESPN_SUMMARY_URL}?event={espn_game_id}"
    try:
        async with session.get(url, timeout=aiohttp.ClientTimeout(total=10)) as resp:
            if resp.status != 200:
                logger.warning(f"ESPN MLB game detail {espn_game_id} returned {resp.status}")
                return None
            data = await resp.json()
    except Exception as e:
        logger.warning(f"ESPN MLB game detail {espn_game_id} failed: {e}")
        return None

    # Parse boxscore
    boxscore = data.get("boxscore", {})
    teams = boxscore.get("teams", [])
    if len(teams) < 2:
        return None

    # ESPN teams array: index 0 = away, index 1 = home
    away_data = teams[0]
    home_data = teams[1]

    home_team = normalize_espn_mlb_abbr(
        home_data.get("team", {}).get("abbreviation", "")
    )
    away_team = normalize_espn_mlb_abbr(
        away_data.get("team", {}).get("abbreviation", "")
    )

    home_stats = _parse_mlb_team_stats(home_data.get("statistics", []))
    away_stats = _parse_mlb_team_stats(away_data.get("statistics", []))

    # Game info
    game_info = data.get("header", {}).get("competitions", [{}])[0]
    status = game_info.get("status", {})
    inning = int(status.get("period", 0))

    # Scores
    competitors = game_info.get("competitors", [])
    home_comp = next((c for c in competitors if c.get("homeAway") == "home"), {})
    away_comp = next((c for c in competitors if c.get("homeAway") == "away"), {})

    # Situation: outs, runners, inning half
    # The situation object lives at the root of the summary response, NOT inside header.competitions
    situation = data.get("situation", {})
    outs = int(situation.get("outs", 0))

    # Runners on base
    runners = 0
    if situation.get("onFirst"):
        runners += 1
    if situation.get("onSecond"):
        runners += 1
    if situation.get("onThird"):
        runners += 1

    # Inning half
    inning_half = "top"
    if situation.get("isTopInning") is False:
        inning_half = "bottom"
    elif situation.get("isTopInning") is True:
        inning_half = "top"
    else:
        detail = status.get("type", {}).get("shortDetail", "").lower()
        if "bot" in detail or "bottom" in detail:
            inning_half = "bottom"
        elif "end" in detail:
            inning_half = "end"

    # Pregame odds from pickcenter
    pregame_spread, pregame_home_ml_prob = _parse_pickcenter(data.get("pickcenter", []))

    return {
        "home_team": home_team,
        "away_team": away_team,
        "home_score": int(home_comp.get("score", 0) or 0),
        "away_score": int(away_comp.get("score", 0) or 0),
        "inning": inning,
        "inning_half": inning_half,
        "outs": outs,
        "runners_on_base": runners,
        "home_hits": home_stats.get("hits", 0),
        "away_hits": away_stats.get("hits", 0),
        "home_errors": home_stats.get("errors", 0),
        "away_errors": away_stats.get("errors", 0),
        "pregame_spread": pregame_spread,
        "pregame_home_ml_prob": pregame_home_ml_prob,
    }


def _moneyline_to_prob(ml: float) -> float:
    """Convert American moneyline to implied probability."""
    if ml < 0:
        return abs(ml) / (abs(ml) + 100)
    elif ml > 0:
        return 100 / (ml + 100)
    return 0.5


def _parse_pickcenter(pickcenter: list) -> tuple[float | None, float | None]:
    """Extract pregame odds from ESPN pickcenter data.

    Returns (pregame_spread, pregame_home_ml_prob).
    """
    if not pickcenter:
        return None, None

    pick = pickcenter[0]

    # Opening spread
    pregame_spread = None
    try:
        point_spread = pick.get("pointSpread", {})
        open_line = point_spread.get("open", {}).get("line")
        if open_line is not None:
            pregame_spread = float(str(open_line))
    except (ValueError, TypeError):
        pass

    if pregame_spread is None:
        try:
            s = pick.get("spread")
            if s is not None:
                pregame_spread = float(s)
        except (ValueError, TypeError):
            pass

    # Home team moneyline → implied probability
    pregame_home_ml_prob = None
    try:
        home_odds = pick.get("homeTeamOdds", {})
        home_ml = home_odds.get("moneyLine")
        if home_ml is not None:
            pregame_home_ml_prob = round(_moneyline_to_prob(float(home_ml)), 4)
    except (ValueError, TypeError):
        pass

    return pregame_spread, pregame_home_ml_prob


def _parse_mlb_team_stats(statistics: list) -> dict:
    """Parse ESPN MLB team statistics array into a flat dict."""
    stats: dict[str, int] = {
        "hits": 0, "at_bats": 0, "runs": 0,
        "errors": 0, "rbi": 0, "walks": 0,
        "strikeouts": 0, "home_runs": 0, "lob": 0,
    }

    stat_name_map = {
        "hits": "hits",
        "atBats": "at_bats",
        "runs": "runs",
        "errors": "errors",
        "RBIs": "rbi",
        "walks": "walks",
        "strikeouts": "strikeouts",
        "homeRuns": "home_runs",
        "leftOnBase": "lob",
    }

    for stat in statistics:
        name = stat.get("name", "")
        if name in stat_name_map:
            try:
                stats[stat_name_map[name]] = int(float(stat.get("displayValue", 0)))
            except (ValueError, TypeError):
                pass

    return stats
