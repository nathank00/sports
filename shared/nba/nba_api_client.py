# shared/nba/nba_api_client.py
"""
NBA data client with stats.nba.com primary + cdn.nba.com fallback.

stats.nba.com requires full browser-like headers and intermittently blocks
programmatic access. When it's down, we fall back to cdn.nba.com which
serves static JSON files (scoreboard, schedule, box scores) reliably.

Each public function returns a list of DataFrames matching the nba_api
pattern (get_data_frames()[0], etc.) so callers need minimal changes.
"""

import logging
import pandas as pd
import requests
from urllib3.util.retry import Retry
from requests.adapters import HTTPAdapter

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# stats.nba.com — primary source
# ---------------------------------------------------------------------------

STATS_BASE_URL = "https://stats.nba.com/stats"

# Full browser-like headers required by stats.nba.com (Feb 2026).
# Incomplete headers get silently blocked (connection hangs until timeout).
STATS_HEADERS = {
    "Accept": "application/json, text/plain, */*",
    "Accept-Encoding": "gzip, deflate, br",
    "Accept-Language": "en-US,en;q=0.9",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "Host": "stats.nba.com",
    "Origin": "https://www.nba.com",
    "Pragma": "no-cache",
    "Referer": "https://www.nba.com/",
    "Sec-Ch-Ua": '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Platform": '"Windows"',
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-site",
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/131.0.0.0 Safari/537.36"
    ),
}

# ---------------------------------------------------------------------------
# cdn.nba.com — fallback source
# ---------------------------------------------------------------------------

CDN_SCOREBOARD_URL = "https://cdn.nba.com/static/json/liveData/scoreboard/todaysScoreboard_00.json"
CDN_SCHEDULE_URL = "https://cdn.nba.com/static/json/staticData/scheduleLeagueV2.json"
CDN_BOXSCORE_URL = "https://cdn.nba.com/static/json/liveData/boxscore/boxscore_{game_id}.json"

DEFAULT_TIMEOUT = 30
CDN_TIMEOUT = 15

# ---------------------------------------------------------------------------
# Session management
# ---------------------------------------------------------------------------

_stats_session = None
_cdn_session = None


def _get_stats_session():
    """Create a requests session for stats.nba.com with retry logic."""
    session = requests.Session()
    session.headers.update(STATS_HEADERS)
    retry = Retry(
        total=2,
        backoff_factor=1,
        status_forcelist=[429, 500, 502, 503, 504],
        allowed_methods=["GET"],
    )
    session.mount("https://", HTTPAdapter(max_retries=retry))
    return session


def _get_cdn_session():
    """Create a requests session for cdn.nba.com with a browser User-Agent."""
    session = requests.Session()
    session.headers.update({
        "User-Agent": STATS_HEADERS["User-Agent"],
        "Referer": "https://www.nba.com/",
    })
    retry = Retry(total=2, backoff_factor=0.5, allowed_methods=["GET"])
    session.mount("https://", HTTPAdapter(max_retries=retry))
    return session


def _stats():
    global _stats_session
    if _stats_session is None:
        _stats_session = _get_stats_session()
    return _stats_session


def _cdn():
    global _cdn_session
    if _cdn_session is None:
        _cdn_session = _get_cdn_session()
    return _cdn_session


def reset_sessions():
    """Reset cached sessions (useful if headers need refreshing)."""
    global _stats_session, _cdn_session
    _stats_session = None
    _cdn_session = None


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _stats_api_get(endpoint, params, timeout=DEFAULT_TIMEOUT):
    """GET request to stats.nba.com, returns parsed JSON."""
    url = f"{STATS_BASE_URL}/{endpoint}"
    resp = _stats().get(url, params=params, timeout=timeout)
    resp.raise_for_status()
    return resp.json()


def _cdn_get(url, timeout=CDN_TIMEOUT):
    """GET request to cdn.nba.com, returns parsed JSON."""
    resp = _cdn().get(url, timeout=timeout)
    resp.raise_for_status()
    return resp.json()


def _result_sets_to_dataframes(data):
    """Convert stats.nba.com resultSets JSON to a list of DataFrames."""
    frames = []
    for rs in data.get("resultSets", []):
        headers = rs.get("headers", [])
        rows = rs.get("rowSet", [])
        frames.append(pd.DataFrame(rows, columns=headers))
    return frames


# ---------------------------------------------------------------------------
# Timezone helper
# ---------------------------------------------------------------------------

def _utc_to_eastern_date(utc_str):
    """
    Convert a UTC timestamp string (e.g. '2026-02-21T00:30:00Z') to an
    Eastern-time date string ('2026-02-20'). This is critical because most
    NBA games tip off 7-10:30 PM ET, which is the next day in UTC.
    """
    if not utc_str:
        return ""
    try:
        from datetime import datetime, timezone, timedelta
        from zoneinfo import ZoneInfo
        # Parse UTC timestamp
        clean = utc_str.replace("Z", "+00:00")
        dt = datetime.fromisoformat(clean)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        # Convert to Eastern
        eastern = dt.astimezone(ZoneInfo("America/New_York"))
        return eastern.strftime("%Y-%m-%d")
    except Exception:
        # Last resort: just truncate (wrong for evening games, but better than crashing)
        return utc_str[:10]


# ---------------------------------------------------------------------------
# CDN parsers — convert CDN JSON into DataFrames matching stats.nba.com format
# ---------------------------------------------------------------------------

def _cdn_scoreboard_to_dataframes(data):
    """
    Convert CDN todaysScoreboard JSON into DataFrames matching ScoreboardV2
    resultSets format: [GameHeader, LineScore, ...].
    """
    scoreboard = data.get("scoreboard", {})
    games = scoreboard.get("games", [])
    if not games:
        return [pd.DataFrame(), pd.DataFrame()]

    # The scoreboard's top-level "gameDate" is the correct Eastern date (YYYY-MM-DD)
    scoreboard_date = scoreboard.get("gameDate", "")

    # GameHeader-like DataFrame
    game_rows = []
    for g in games:
        ht = g.get("homeTeam", {})
        at = g.get("awayTeam", {})
        game_rows.append({
            "GAME_ID": g.get("gameId"),
            "GAME_STATUS_ID": g.get("gameStatus"),
            "GAME_STATUS_TEXT": g.get("gameStatusText", ""),
            "HOME_TEAM_ID": ht.get("teamId"),
            "VISITOR_TEAM_ID": at.get("teamId"),
            "GAME_DATE_EST": scoreboard_date or _utc_to_eastern_date(g.get("gameTimeUTC", "")),
        })
    game_header = pd.DataFrame(game_rows)

    # LineScore-like DataFrame
    line_rows = []
    for g in games:
        for side, key in [("home", "homeTeam"), ("visitor", "awayTeam")]:
            t = g.get(key, {})
            line_rows.append({
                "GAME_ID": g.get("gameId"),
                "TEAM_ID": t.get("teamId"),
                "TEAM_ABBREVIATION": t.get("teamTricode", ""),
                "PTS": t.get("score", 0),
            })
    line_score = pd.DataFrame(line_rows)

    return [game_header, line_score]


def _cdn_boxscore_to_player_rows(game_id, data):
    """
    Convert a CDN boxscore JSON into rows matching LeagueGameLog player format.
    Returns a list of dicts (one per player).
    """
    game = data.get("game", {})
    game_date = _utc_to_eastern_date(game.get("gameTimeUTC", ""))
    home_team = game.get("homeTeam", {})
    away_team = game.get("awayTeam", {})

    home_tricode = home_team.get("teamTricode", "")
    away_tricode = away_team.get("teamTricode", "")

    rows = []
    for team_data, is_home in [(home_team, True), (away_team, False)]:
        tricode = team_data.get("teamTricode", "")
        team_id = team_data.get("teamId")
        opp_tricode = away_tricode if is_home else home_tricode

        matchup = f"{tricode} vs. {opp_tricode}" if is_home else f"{tricode} @ {opp_tricode}"

        # Determine W/L from scores
        home_score = home_team.get("score", 0) or 0
        away_score = away_team.get("score", 0) or 0
        if home_score == 0 and away_score == 0:
            wl = None  # game not started
        elif is_home:
            wl = "W" if home_score > away_score else "L"
        else:
            wl = "W" if away_score > home_score else "L"

        for p in team_data.get("players", []):
            if not p.get("played", "0") and p.get("status") != "ACTIVE":
                continue

            stats = p.get("statistics", {})
            minutes_raw = stats.get("minutes", "")
            # Parse "PT30M41.80S" or "30:41" format
            minutes = _parse_cdn_minutes(minutes_raw)

            rows.append({
                "GAME_ID": str(game_id),
                "PLAYER_ID": p.get("personId"),
                "GAME_DATE": game_date,
                "MATCHUP": matchup,
                "WL": wl,
                "TEAM_ID": team_id,
                "TEAM_ABBREVIATION": tricode,
                "MIN": minutes,
                "FGM": stats.get("fieldGoalsMade"),
                "FGA": stats.get("fieldGoalsAttempted"),
                "FG_PCT": stats.get("fieldGoalsPercentage"),
                "FG3M": stats.get("threePointersMade"),
                "FG3A": stats.get("threePointersAttempted"),
                "FG3_PCT": stats.get("threePointersPercentage"),
                "FTM": stats.get("freeThrowsMade"),
                "FTA": stats.get("freeThrowsAttempted"),
                "FT_PCT": stats.get("freeThrowsPercentage"),
                "OREB": stats.get("reboundsOffensive"),
                "DREB": stats.get("reboundsDefensive"),
                "REB": stats.get("reboundsTotal"),
                "AST": stats.get("assists"),
                "STL": stats.get("steals"),
                "BLK": stats.get("blocks"),
                "TOV": stats.get("turnovers"),
                "PF": stats.get("foulsPersonal"),
                "PTS": stats.get("points"),
                "PLUS_MINUS": stats.get("plusMinusPoints"),
            })

    return rows


def _parse_cdn_minutes(val):
    """Parse CDN minutes format: 'PT30M41.80S' or 'PT5M' or empty."""
    if not val or not isinstance(val, str):
        return None
    val = val.strip()
    if val.startswith("PT"):
        val = val[2:]  # remove 'PT'
        minutes = 0
        if "M" in val:
            m_part, val = val.split("M", 1)
            try:
                minutes = int(float(m_part))
            except ValueError:
                pass
        return minutes
    # Fallback: try plain number
    try:
        return int(float(val))
    except (ValueError, TypeError):
        return None


# ---------------------------------------------------------------------------
# Public API — each tries stats.nba.com first, falls back to CDN
# ---------------------------------------------------------------------------

def fetch_scoreboard(game_date, timeout=DEFAULT_TIMEOUT):
    """
    ScoreboardV2 — returns [GameHeader, LineScore, ...].
    Falls back to CDN todaysScoreboard if stats.nba.com is down.
    Note: CDN only has today's scoreboard, not arbitrary dates.
    """
    try:
        params = {
            "GameDate": game_date,
            "LeagueID": "00",
            "DayOffset": "0",
        }
        data = _stats_api_get("scoreboardv2", params, timeout=timeout)
        return _result_sets_to_dataframes(data)
    except Exception as e:
        logger.warning(f"stats.nba.com scoreboardv2 failed: {e} — trying CDN fallback")

    try:
        data = _cdn_get(CDN_SCOREBOARD_URL)
        return _cdn_scoreboard_to_dataframes(data)
    except Exception as e2:
        logger.error(f"CDN scoreboard also failed: {e2}")
        return [pd.DataFrame(), pd.DataFrame()]


def fetch_schedule(season, timeout=DEFAULT_TIMEOUT):
    """
    ScheduleLeagueV2 — returns the full season schedule as a single DataFrame.
    Falls back to CDN static schedule if stats.nba.com is down.
    """
    def _parse_schedule_json(data):
        game_dates = data.get("leagueSchedule", {}).get("gameDates", [])
        rows = []
        for gd in game_dates:
            for g in gd.get("games", []):
                home = g.get("homeTeam", {})
                away = g.get("awayTeam", {})
                rows.append({
                    "gameId": g.get("gameId"),
                    "gameDateTimeUTC": g.get("gameDateTimeUTC"),
                    "gameStatus": g.get("gameStatus"),
                    "postponedStatus": g.get("postponedStatus"),
                    "homeTeam_teamId": home.get("teamId"),
                    "homeTeam_score": home.get("score"),
                    "awayTeam_teamId": away.get("teamId"),
                    "awayTeam_score": away.get("score"),
                })
        return [pd.DataFrame(rows)] if rows else [pd.DataFrame()]

    try:
        params = {"Season": season, "LeagueID": "00"}
        url = f"{STATS_BASE_URL}/scheduleleaguev2"
        resp = _stats().get(url, params=params, timeout=timeout)
        resp.raise_for_status()
        return _parse_schedule_json(resp.json())
    except Exception as e:
        logger.warning(f"stats.nba.com scheduleleaguev2 failed: {e} — trying CDN fallback")

    try:
        data = _cdn_get(CDN_SCHEDULE_URL)
        return _parse_schedule_json(data)
    except Exception as e2:
        logger.error(f"CDN schedule also failed: {e2}")
        return [pd.DataFrame()]


def fetch_game_finder(
    season=None,
    date_from=None,
    date_to=None,
    timeout=DEFAULT_TIMEOUT,
):
    """
    LeagueGameFinder — bulk completed games with scores.
    Falls back to CDN schedule + scoreboard for recent game data.
    """
    try:
        params = {
            "LeagueID": "00",
            "SeasonType": "Regular Season",
        }
        if season:
            params["Season"] = season
        if date_from:
            params["DateFrom"] = date_from
        if date_to:
            params["DateTo"] = date_to

        data = _stats_api_get("leaguegamefinder", params, timeout=timeout)
        return _result_sets_to_dataframes(data)
    except Exception as e:
        logger.warning(f"stats.nba.com leaguegamefinder failed: {e} — trying CDN fallback")

    # CDN fallback: use schedule to get game list, then scoreboard for scores.
    # This only works well for recent/today's games.
    try:
        return _cdn_game_finder_fallback(date_from, date_to)
    except Exception as e2:
        logger.error(f"CDN game finder fallback also failed: {e2}")
        return [pd.DataFrame()]


def _cdn_game_finder_fallback(date_from=None, date_to=None):
    """
    Approximate LeagueGameFinder using CDN schedule + box scores.
    Returns a DataFrame with the same key columns the pipeline expects.
    """
    from datetime import datetime

    # Parse date range
    def _parse_date(d):
        if not d:
            return None
        for fmt in ("%m/%d/%Y", "%Y-%m-%d"):
            try:
                return datetime.strptime(d, fmt).date()
            except ValueError:
                continue
        return None

    start = _parse_date(date_from)
    end = _parse_date(date_to)

    # Get schedule
    sched_data = _cdn_get(CDN_SCHEDULE_URL)
    game_dates = sched_data.get("leagueSchedule", {}).get("gameDates", [])

    game_ids = []
    for gd in game_dates:
        raw_date = gd.get("gameDate", "")
        # Format: "02/20/2026 00:00:00"
        try:
            gd_date = datetime.strptime(raw_date.split(" ")[0], "%m/%d/%Y").date()
        except ValueError:
            continue

        if start and gd_date < start:
            continue
        if end and gd_date > end:
            continue

        for g in gd.get("games", []):
            game_ids.append(g.get("gameId"))

    if not game_ids:
        return [pd.DataFrame()]

    # Fetch box scores for each game to build LeagueGameFinder-like rows
    from shared.nba.nba_constants import TEAM_ABBR_TO_FULL

    all_rows = []
    for gid in game_ids:
        try:
            url = CDN_BOXSCORE_URL.format(game_id=gid)
            data = _cdn_get(url)
            game = data.get("game", {})
            game_date = _utc_to_eastern_date(game.get("gameTimeUTC", ""))

            for team_key, is_home in [("homeTeam", True), ("awayTeam", False)]:
                t = game.get(team_key, {})
                tricode = t.get("teamTricode", "")
                opp_key = "awayTeam" if is_home else "homeTeam"
                opp_tricode = game.get(opp_key, {}).get("teamTricode", "")
                matchup = f"{tricode} vs. {opp_tricode}" if is_home else f"{tricode} @ {opp_tricode}"

                home_score = game.get("homeTeam", {}).get("score", 0) or 0
                away_score = game.get("awayTeam", {}).get("score", 0) or 0
                score = home_score if is_home else away_score

                if home_score > 0 or away_score > 0:
                    if is_home:
                        wl = "W" if home_score > away_score else "L"
                    else:
                        wl = "W" if away_score > home_score else "L"
                else:
                    wl = None

                all_rows.append({
                    "SEASON_ID": f"2{game_date[:4]}",
                    "TEAM_ID": t.get("teamId"),
                    "TEAM_ABBREVIATION": tricode,
                    "TEAM_NAME": TEAM_ABBR_TO_FULL.get(tricode, tricode),
                    "GAME_ID": str(gid),
                    "GAME_DATE": game_date,
                    "MATCHUP": matchup,
                    "WL": wl,
                    "PTS": score,
                })
        except Exception as e:
            logger.warning(f"CDN boxscore {gid} failed: {e}")
            continue

    return [pd.DataFrame(all_rows)] if all_rows else [pd.DataFrame()]


def fetch_team_roster(team_id, season, timeout=DEFAULT_TIMEOUT):
    """CommonTeamRoster — roster for a single team/season. No CDN fallback."""
    params = {
        "TeamID": str(team_id),
        "Season": season,
        "LeagueID": "00",
    }
    data = _stats_api_get("commonteamroster", params, timeout=timeout)
    return _result_sets_to_dataframes(data)


def fetch_all_players(season, is_only_current_season=0, timeout=DEFAULT_TIMEOUT):
    """CommonAllPlayers — all players for a season. No CDN fallback."""
    params = {
        "IsOnlyCurrentSeason": str(is_only_current_season),
        "Season": season,
        "LeagueID": "00",
    }
    data = _stats_api_get("commonallplayers", params, timeout=timeout)
    return _result_sets_to_dataframes(data)


def fetch_league_game_log(
    season,
    player_or_team="P",
    season_type="Regular Season",
    date_from=None,
    date_to=None,
    timeout=DEFAULT_TIMEOUT,
):
    """
    LeagueGameLog — all player/team game logs for a season.
    Falls back to CDN box scores when stats.nba.com is down (player mode only).
    """
    try:
        params = {
            "Season": season,
            "PlayerOrTeam": player_or_team,
            "SeasonType": season_type,
            "LeagueID": "00",
        }
        if date_from:
            params["DateFrom"] = date_from
        if date_to:
            params["DateTo"] = date_to

        data = _stats_api_get("leaguegamelog", params, timeout=timeout)
        return _result_sets_to_dataframes(data)
    except Exception as e:
        logger.warning(f"stats.nba.com leaguegamelog failed: {e}")

        if player_or_team != "P":
            logger.error("CDN fallback only supports player mode")
            return [pd.DataFrame()]

        logger.info("Falling back to CDN box scores for player game logs...")
        try:
            return _cdn_league_game_log_fallback(season, date_from, date_to)
        except Exception as e2:
            logger.error(f"CDN league game log fallback also failed: {e2}")
            return [pd.DataFrame()]


def _cdn_league_game_log_fallback(season, date_from=None, date_to=None):
    """
    Approximate LeagueGameLog (player mode) using CDN schedule + box scores.
    Fetches box score for each game in the date range and builds a DataFrame
    matching the LeagueGameLog column format.
    """
    from datetime import datetime

    def _parse_date(d):
        if not d:
            return None
        for fmt in ("%m/%d/%Y", "%Y-%m-%d"):
            try:
                return datetime.strptime(d, fmt).date()
            except ValueError:
                continue
        return None

    start = _parse_date(date_from)
    end = _parse_date(date_to)

    # Get schedule to find game IDs in range
    sched_data = _cdn_get(CDN_SCHEDULE_URL)
    game_dates = sched_data.get("leagueSchedule", {}).get("gameDates", [])

    game_ids = []
    for gd in game_dates:
        raw_date = gd.get("gameDate", "")
        try:
            gd_date = datetime.strptime(raw_date.split(" ")[0], "%m/%d/%Y").date()
        except ValueError:
            continue
        if start and gd_date < start:
            continue
        if end and gd_date > end:
            continue

        for g in gd.get("games", []):
            # Only completed games (gameStatus == 3)
            if g.get("gameStatus") == 3:
                game_ids.append(g.get("gameId"))

    logger.info(f"CDN fallback: {len(game_ids)} completed games in date range")

    if not game_ids:
        return [pd.DataFrame()]

    # Fetch each box score
    all_rows = []
    for gid in game_ids:
        try:
            url = CDN_BOXSCORE_URL.format(game_id=gid)
            data = _cdn_get(url)
            rows = _cdn_boxscore_to_player_rows(gid, data)
            all_rows.extend(rows)
        except Exception as e:
            logger.warning(f"CDN boxscore {gid} failed: {e}")
            continue

    logger.info(f"CDN fallback: {len(all_rows)} player-game rows from box scores")
    return [pd.DataFrame(all_rows)] if all_rows else [pd.DataFrame()]
