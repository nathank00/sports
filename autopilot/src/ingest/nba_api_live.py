"""cdn.nba.com async client for live NBA game data (fallback).

Uses the same CDN URLs and parsing patterns as shared/nba/nba_api_client.py
but with async HTTP via aiohttp instead of synchronous requests.
"""

import logging
import aiohttp

logger = logging.getLogger(__name__)

CDN_SCOREBOARD_URL = (
    "https://cdn.nba.com/static/json/liveData/scoreboard/todaysScoreboard_00.json"
)
CDN_BOXSCORE_URL = (
    "https://cdn.nba.com/static/json/liveData/boxscore/boxscore_{game_id}.json"
)

CDN_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/131.0.0.0 Safari/537.36"
    ),
    "Referer": "https://www.nba.com/",
}


async def fetch_cdn_scoreboard(session: aiohttp.ClientSession) -> list[dict]:
    """Fetch today's scoreboard from cdn.nba.com.

    Returns list of dicts, one per game:
    {
        "nba_game_id": str,
        "status": int (1=scheduled, 2=in progress, 3=final),
        "home_team": str (tricode),
        "away_team": str,
        "home_score": int,
        "away_score": int,
        "period": int,
        "clock": str,
    }
    """
    try:
        async with session.get(
            CDN_SCOREBOARD_URL,
            headers=CDN_HEADERS,
            timeout=aiohttp.ClientTimeout(total=10),
        ) as resp:
            if resp.status != 200:
                logger.warning(f"CDN scoreboard returned {resp.status}")
                return []
            data = await resp.json()
    except Exception as e:
        logger.warning(f"CDN scoreboard fetch failed: {e}")
        return []

    scoreboard = data.get("scoreboard", {})
    games = []

    for g in scoreboard.get("games", []):
        home = g.get("homeTeam", {})
        away = g.get("awayTeam", {})

        games.append({
            "nba_game_id": g.get("gameId", ""),
            "status": g.get("gameStatus", 1),
            "home_team": home.get("teamTricode", ""),
            "away_team": away.get("teamTricode", ""),
            "home_score": int(home.get("score", 0) or 0),
            "away_score": int(away.get("score", 0) or 0),
            "period": int(g.get("period", 0)),
            "clock": g.get("gameClock", "PT00M00.00S"),
        })

    return games


async def fetch_cdn_boxscore(
    session: aiohttp.ClientSession,
    nba_game_id: str,
) -> dict | None:
    """Fetch live boxscore for a single game from cdn.nba.com.

    Returns dict with:
    {
        "home_team": str,
        "away_team": str,
        "home_score": int,
        "away_score": int,
        "period": int,
        "clock": str,
        "home_stats": {fgm, fga, ftm, fta, oreb, tov, pf},
        "away_stats": {fgm, fga, ftm, fta, oreb, tov, pf},
    }
    """
    url = CDN_BOXSCORE_URL.format(game_id=nba_game_id)
    try:
        async with session.get(
            url,
            headers=CDN_HEADERS,
            timeout=aiohttp.ClientTimeout(total=10),
        ) as resp:
            if resp.status != 200:
                logger.warning(f"CDN boxscore {nba_game_id} returned {resp.status}")
                return None
            data = await resp.json()
    except Exception as e:
        logger.warning(f"CDN boxscore {nba_game_id} failed: {e}")
        return None

    game = data.get("game", {})
    home = game.get("homeTeam", {})
    away = game.get("awayTeam", {})

    return {
        "home_team": home.get("teamTricode", ""),
        "away_team": away.get("teamTricode", ""),
        "home_score": int(home.get("score", 0) or 0),
        "away_score": int(away.get("score", 0) or 0),
        "period": int(game.get("period", 0)),
        "clock": game.get("gameClock", ""),
        "home_stats": _extract_team_stats(home),
        "away_stats": _extract_team_stats(away),
    }


def _extract_team_stats(team_data: dict) -> dict:
    """Extract aggregated team stats from CDN boxscore team data.

    Sums player-level stats to get team totals.
    """
    stats = {"fgm": 0, "fga": 0, "ftm": 0, "fta": 0, "oreb": 0, "tov": 0, "pf": 0}

    for player in team_data.get("players", []):
        s = player.get("statistics", {})
        stats["fgm"] += int(s.get("fieldGoalsMade", 0) or 0)
        stats["fga"] += int(s.get("fieldGoalsAttempted", 0) or 0)
        stats["ftm"] += int(s.get("freeThrowsMade", 0) or 0)
        stats["fta"] += int(s.get("freeThrowsAttempted", 0) or 0)
        stats["oreb"] += int(s.get("reboundsOffensive", 0) or 0)
        stats["tov"] += int(s.get("turnovers", 0) or 0)
        stats["pf"] += int(s.get("foulsPersonal", 0) or 0)

    return stats
