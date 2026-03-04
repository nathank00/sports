"""ESPN hidden API async client for live NBA game data.

Primary free data source. Polls ESPN's undocumented JSON endpoints
for live scores, team stats, and play-by-play data.

Endpoints:
  Scoreboard: site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard
  Game detail: site.web.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event={id}
"""

import json
import logging
import urllib.request

import aiohttp

logger = logging.getLogger(__name__)

ESPN_SCOREBOARD_URL = (
    "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard"
)
ESPN_SUMMARY_URL = (
    "https://site.web.api.espn.com/apis/site/v2/sports/basketball/nba/summary"
)

# ESPN uses some different abbreviations than standard
ESPN_ABBR_MAP: dict[str, str] = {
    "GS": "GSW",
    "SA": "SAS",
    "NY": "NYK",
    "NO": "NOP",
    "WSH": "WAS",
    "PHO": "PHX",
    "UTAH": "UTA",
}


def normalize_espn_abbr(abbr: str) -> str:
    """Normalize ESPN team abbreviation to standard 3-letter form."""
    return ESPN_ABBR_MAP.get(abbr, abbr)


def fetch_scoreboard_by_date(date_str: str) -> list[dict]:
    """Fetch completed games for a specific date (sync, no aiohttp needed).

    Args:
        date_str: Date in YYYYMMDD format.

    Returns list of dicts for completed games:
    {
        "espn_game_id": str,
        "home_team": str (3-letter abbr),
        "away_team": str,
        "home_score": int,
        "away_score": int,
        "home_win": bool,
    }
    """
    url = f"{ESPN_SCOREBOARD_URL}?dates={date_str}"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read())
    except Exception as e:
        logger.error(f"ESPN scoreboard fetch for {date_str} failed: {e}")
        return []

    games = []
    for event in data.get("events", []):
        competition = (event.get("competitions") or [{}])[0]
        status_type = event.get("status", {}).get("type", {}).get("state", "pre")

        if status_type != "post":
            continue  # Only completed games

        competitors = competition.get("competitors", [])
        home = next((c for c in competitors if c.get("homeAway") == "home"), {})
        away = next((c for c in competitors if c.get("homeAway") == "away"), {})

        home_score = int(home.get("score", 0) or 0)
        away_score = int(away.get("score", 0) or 0)

        games.append({
            "espn_game_id": event.get("id", ""),
            "home_team": normalize_espn_abbr(home.get("team", {}).get("abbreviation", "")),
            "away_team": normalize_espn_abbr(away.get("team", {}).get("abbreviation", "")),
            "home_score": home_score,
            "away_score": away_score,
            "home_win": home_score > away_score,
        })

    return games


async def fetch_live_scoreboard(session: aiohttp.ClientSession) -> list[dict]:
    """Fetch today's scoreboard from ESPN.

    Returns list of dicts, one per active/scheduled game:
    {
        "espn_game_id": str,
        "status": "in" | "pre" | "post",
        "home_team": str (3-letter abbr),
        "away_team": str,
        "home_score": int,
        "away_score": int,
        "period": int,
        "clock": str (e.g., "4:32"),
        "possession_team": str | None (3-letter abbr),
    }
    """
    try:
        async with session.get(ESPN_SCOREBOARD_URL, timeout=aiohttp.ClientTimeout(total=10)) as resp:
            if resp.status != 200:
                logger.warning(f"ESPN scoreboard returned {resp.status}")
                return []
            data = await resp.json()
    except Exception as e:
        logger.warning(f"ESPN scoreboard fetch failed: {e}")
        return []

    games = []
    for event in data.get("events", []):
        competition = (event.get("competitions") or [{}])[0]
        status_obj = event.get("status", {})
        status_type = status_obj.get("type", {}).get("state", "pre")

        competitors = competition.get("competitors", [])
        home = next((c for c in competitors if c.get("homeAway") == "home"), {})
        away = next((c for c in competitors if c.get("homeAway") == "away"), {})

        home_team = normalize_espn_abbr(home.get("team", {}).get("abbreviation", ""))
        away_team = normalize_espn_abbr(away.get("team", {}).get("abbreviation", ""))

        # Possession: ESPN includes this in the situation object
        situation = competition.get("situation", {})
        poss_team_id = situation.get("possession")
        possession_team = None
        if poss_team_id:
            for comp in competitors:
                if comp.get("id") == poss_team_id:
                    possession_team = normalize_espn_abbr(
                        comp.get("team", {}).get("abbreviation", "")
                    )
                    break

        games.append({
            "espn_game_id": event.get("id", ""),
            "status": status_type,
            "home_team": home_team,
            "away_team": away_team,
            "home_score": int(home.get("score", 0) or 0),
            "away_score": int(away.get("score", 0) or 0),
            "period": int(status_obj.get("period", 0)),
            "clock": status_obj.get("displayClock", "0:00"),
            "possession_team": possession_team,
        })

    return games


async def fetch_live_game_detail(
    session: aiohttp.ClientSession,
    espn_game_id: str,
) -> dict | None:
    """Fetch detailed game data for a single game.

    Returns dict with:
    {
        "home_team": str,
        "away_team": str,
        "home_score": int,
        "away_score": int,
        "period": int,
        "clock": str,
        "seconds_remaining": float,
        "possession_team": str | None,
        "home_stats": {fgm, fga, ftm, fta, oreb, dreb, tov, pf, ...},
        "away_stats": {fgm, fga, ftm, fta, oreb, dreb, tov, pf, ...},
        "home_timeouts": int,
        "away_timeouts": int,
    }
    """
    url = f"{ESPN_SUMMARY_URL}?event={espn_game_id}"
    try:
        async with session.get(url, timeout=aiohttp.ClientTimeout(total=10)) as resp:
            if resp.status != 200:
                logger.warning(f"ESPN game detail {espn_game_id} returned {resp.status}")
                return None
            data = await resp.json()
    except Exception as e:
        logger.warning(f"ESPN game detail {espn_game_id} failed: {e}")
        return None

    # Parse boxscore
    boxscore = data.get("boxscore", {})
    teams = boxscore.get("teams", [])
    if len(teams) < 2:
        return None

    # ESPN teams array: index 0 = away, index 1 = home
    away_data = teams[0]
    home_data = teams[1]

    home_team = normalize_espn_abbr(
        home_data.get("team", {}).get("abbreviation", "")
    )
    away_team = normalize_espn_abbr(
        away_data.get("team", {}).get("abbreviation", "")
    )

    home_stats = _parse_team_stats(home_data.get("statistics", []))
    away_stats = _parse_team_stats(away_data.get("statistics", []))

    # Game info
    game_info = data.get("header", {}).get("competitions", [{}])[0]
    status = game_info.get("status", {})
    period = int(status.get("period", 0))
    clock = status.get("displayClock", "0:00")
    seconds_remaining = _clock_to_total_seconds(period, clock)

    # Scores
    competitors = game_info.get("competitors", [])
    home_comp = next((c for c in competitors if c.get("homeAway") == "home"), {})
    away_comp = next((c for c in competitors if c.get("homeAway") == "away"), {})

    # Possession
    situation = game_info.get("situation", {})
    poss_id = situation.get("possession")
    possession_team = None
    if poss_id:
        for comp in competitors:
            if comp.get("id") == poss_id:
                possession_team = normalize_espn_abbr(
                    comp.get("team", {}).get("abbreviation", "")
                )

    # Timeouts
    home_timeouts = int(home_comp.get("timeoutsRemaining", 0) or 0)
    away_timeouts = int(away_comp.get("timeoutsRemaining", 0) or 0)

    # Pregame odds from pickcenter
    pregame_spread, pregame_home_ml_prob = _parse_pickcenter(data.get("pickcenter", []))

    return {
        "home_team": home_team,
        "away_team": away_team,
        "home_score": int(home_comp.get("score", 0) or 0),
        "away_score": int(away_comp.get("score", 0) or 0),
        "period": period,
        "clock": clock,
        "seconds_remaining": seconds_remaining,
        "possession_team": possession_team,
        "home_stats": home_stats,
        "away_stats": away_stats,
        "home_timeouts": home_timeouts,
        "away_timeouts": away_timeouts,
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
    Uses opening line for spread, home team moneyline for ML probability.
    """
    if not pickcenter:
        return None, None

    pick = pickcenter[0]  # First provider (usually DraftKings)

    # Opening spread (home team perspective, negative = home favored)
    pregame_spread = None
    try:
        point_spread = pick.get("pointSpread", {})
        open_line = point_spread.get("open", {}).get("line")
        if open_line is not None:
            pregame_spread = float(str(open_line))
    except (ValueError, TypeError):
        pass

    # Fall back to top-level spread if opening not available
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


def _parse_team_stats(statistics: list) -> dict:
    """Parse ESPN team statistics array into a flat dict.

    ESPN returns stats as a list of {name, displayValue} pairs.
    """
    stats: dict[str, int] = {
        "fgm": 0, "fga": 0, "ftm": 0, "fta": 0,
        "oreb": 0, "dreb": 0, "reb": 0,
        "tov": 0, "pf": 0,
    }

    stat_name_map = {
        "fieldGoalsMade": "fgm",
        "fieldGoalsAttempted": "fga",
        "freeThrowsMade": "ftm",
        "freeThrowsAttempted": "fta",
        "offensiveRebounds": "oreb",
        "defensiveRebounds": "dreb",
        "totalRebounds": "reb",
        "turnovers": "tov",
        "fouls": "pf",
    }

    for stat in statistics:
        name = stat.get("name", "")
        if name in stat_name_map:
            try:
                stats[stat_name_map[name]] = int(float(stat.get("displayValue", 0)))
            except (ValueError, TypeError):
                pass

    return stats


def _clock_to_total_seconds(period: int, clock: str) -> float:
    """Convert period + display clock to total seconds remaining in the game.

    Same logic as pbp_historical.parse_clock_to_seconds.
    """
    try:
        parts = clock.split(":")
        minutes = int(parts[0])
        seconds = int(float(parts[1])) if len(parts) > 1 else 0
        clock_seconds = minutes * 60 + seconds
    except (ValueError, IndexError):
        return 0.0

    if period <= 4:
        remaining_quarters = 4 - period
        return remaining_quarters * 720 + clock_seconds
    else:
        return clock_seconds
