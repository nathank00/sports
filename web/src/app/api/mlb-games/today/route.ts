/**
 * /api/mlb-games/today — Today's MLB game schedule + Kalshi market prices.
 *
 * Server-side endpoint that fetches from two public APIs (no auth needed):
 *   1. ESPN scoreboard — today's game slate with first pitch times and scores
 *   2. Kalshi markets — live market prices for MLB game contracts
 *
 * Uses the 7 AM ET boundary for the MLB "game day" so late-night
 * west-coast games stay on the correct day.
 */

import { NextResponse } from "next/server";

const ESPN_SCOREBOARD_URL =
  "https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard";

const KALSHI_MARKETS_URL =
  "https://api.elections.kalshi.com/trade-api/v2/markets";

/**
 * Normalize ESPN abbreviations to match Kalshi ticker format.
 * ESPN and Kalshi differ for several teams.
 */
const ESPN_MLB_ABBR_MAP: Record<string, string> = {
  ARI: "AZ",     // ESPN: ARI, Kalshi: AZ
  OAK: "ATH",    // ESPN: OAK, Kalshi: ATH
  CHW: "CWS",    // ESPN: CHW, Kalshi: CWS
  // WSH stays as WSH (both use WSH)
};

function normalizeEspnMlbAbbr(abbr: string): string {
  return ESPN_MLB_ABBR_MAP[abbr] || abbr;
}

/** Compute today's MLB game date as YYYYMMDD using the 7 AM ET boundary. */
function getTodayGameDate(): string {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
  }).formatToParts(now);

  const etYear = parseInt(parts.find((p) => p.type === "year")!.value);
  const etMonth = parseInt(parts.find((p) => p.type === "month")!.value);
  const etDay = parseInt(parts.find((p) => p.type === "day")!.value);
  const etHour = parseInt(parts.find((p) => p.type === "hour")!.value);

  const gameDay = new Date(etYear, etMonth - 1, etDay);
  if (etHour < 7) {
    gameDay.setDate(gameDay.getDate() - 1);
  }

  const yyyy = gameDay.getFullYear();
  const mm = String(gameDay.getMonth() + 1).padStart(2, "0");
  const dd = String(gameDay.getDate()).padStart(2, "0");
  return `${yyyy}${mm}${dd}`;
}

/**
 * Extract YES ask price from a Kalshi market object.
 */
function extractYesAsk(market: Record<string, unknown>): number | null {
  const dollarStr =
    (market.yes_ask_dollars as string) || (market.yesAskDollars as string);
  if (dollarStr) {
    const val = parseFloat(dollarStr);
    if (!isNaN(val) && val > 0 && val < 1) return val;
  }

  for (const key of ["yes_ask", "yesAsk"]) {
    const val = market[key];
    if (val != null) {
      const num = Number(val);
      if (!isNaN(num) && num > 0 && num < 1) return num;
      if (!isNaN(num) && num >= 1 && num <= 99) return num / 100;
    }
  }

  return null;
}

export async function GET() {
  try {
    const dateStr = getTodayGameDate();

    // Fetch ESPN scoreboard and Kalshi markets in parallel
    const [espnResp, kalshiResp] = await Promise.all([
      fetch(`${ESPN_SCOREBOARD_URL}?dates=${dateStr}`, {
        headers: { "User-Agent": "Mozilla/5.0" },
        next: { revalidate: 30 },
      }),
      fetch(
        `${KALSHI_MARKETS_URL}?series_ticker=KXMLBGAME&status=open&limit=200`,
        { next: { revalidate: 30 } }
      ),
    ]);

    interface ScheduledGame {
      espnGameId: string;
      homeTeam: string;
      awayTeam: string;
      homeScore: number;
      awayScore: number;
      status: string;
      period: number;    // inning
      clock: string;     // not used for MLB, but kept for compatibility
      inningHalf: string;
      outs: number;
      startTime: string | null;
      statusDetail: string;
      kalshiHomePrice: number | null;
      kalshiAwayPrice: number | null;
    }

    const games: ScheduledGame[] = [];

    if (espnResp.ok) {
      const espnData = await espnResp.json();

      for (const event of espnData.events || []) {
        const competition = (event.competitions || [{}])[0];
        const statusObj = event.status || {};
        const statusType = statusObj.type?.state || "pre";

        const competitors = competition.competitors || [];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const home = competitors.find((c: any) => c.homeAway === "home") || {};
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const away = competitors.find((c: any) => c.homeAway === "away") || {};

        const homeTeam = normalizeEspnMlbAbbr(
          home.team?.abbreviation || ""
        );
        const awayTeam = normalizeEspnMlbAbbr(
          away.team?.abbreviation || ""
        );

        // Inning half from situation
        const situation = competition.situation || {};
        let inningHalf = "";
        if (statusType === "in") {
          if (situation.isTopInning === true) inningHalf = "top";
          else if (situation.isTopInning === false) inningHalf = "bottom";
          else {
            const detail = (statusObj.type?.shortDetail || "").toLowerCase();
            if (detail.includes("top")) inningHalf = "top";
            else if (detail.includes("bot")) inningHalf = "bottom";
            else if (detail.includes("end")) inningHalf = "end";
          }
        }

        games.push({
          espnGameId: event.id || "",
          homeTeam,
          awayTeam,
          homeScore: parseInt(home.score || "0") || 0,
          awayScore: parseInt(away.score || "0") || 0,
          status: statusType,
          period: parseInt(statusObj.period || "0") || 0,
          clock: statusObj.displayClock || "",
          inningHalf,
          outs: parseInt(situation.outs || "0") || 0,
          startTime: event.date || null,
          statusDetail: statusObj.type?.shortDetail || "",
          kalshiHomePrice: null,
          kalshiAwayPrice: null,
        });
      }
    }

    // Parse Kalshi markets and match to games (with date filtering)
    if (kalshiResp.ok) {
      const kalshiData = await kalshiResp.json();
      const markets = kalshiData.markets || [];
      const MONTHS = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];

      for (const game of games) {
        // Derive Kalshi date fragment from the game's start time (in US Eastern)
        // ESPN returns UTC times, but Kalshi dates use the US Eastern date
        let gameDateStr = "";
        if (game.startTime) {
          const etStr = new Date(game.startTime).toLocaleDateString("en-CA", {
            timeZone: "America/New_York",
          }); // "2026-03-25"
          const [yyyy, mm, dd] = etStr.split("-");
          const yr = yyyy.substring(2);
          const mon = MONTHS[parseInt(mm, 10) - 1];
          gameDateStr = `${yr}${mon}${dd}`;
        }

        for (const market of markets) {
          const eventTicker =
            (market.event_ticker as string) ||
            (market.eventTicker as string) ||
            "";
          const ticker = (market.ticker as string) || "";

          // Event must involve both teams AND match the game date
          if (
            !eventTicker.includes(game.homeTeam) ||
            !eventTicker.includes(game.awayTeam)
          ) {
            continue;
          }
          if (gameDateStr && !eventTicker.includes(gameDateStr)) {
            continue;
          }

          const suffix = ticker.split("-").pop() || "";
          const yesAsk = extractYesAsk(market);

          if (suffix === game.homeTeam && yesAsk !== null) {
            game.kalshiHomePrice = yesAsk;
          } else if (suffix === game.awayTeam && yesAsk !== null) {
            game.kalshiAwayPrice = yesAsk;
          }
        }
      }
    }

    return NextResponse.json({ games });
  } catch (e) {
    console.error("Failed to fetch today's MLB games:", e);
    return NextResponse.json({ games: [] }, { status: 500 });
  }
}
