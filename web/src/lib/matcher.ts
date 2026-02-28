import type { KalshiMarket, MatchedGame } from "./types";

/**
 * Prediction data from Supabase (gamelogs table).
 * Uses the same column names as the database.
 */
export interface Prediction {
  GAME_ID: number;
  GAME_DATE: string;
  HOME_NAME: string;
  AWAY_NAME: string;
  PREDICTION: number | null;
  PREDICTION_PCT: number | null;
  GAME_STATUS: number;
  GAME_OUTCOME: number | null;
}

/**
 * NBA team name → Kalshi ticker abbreviation.
 * These match the suffixes on Kalshi market tickers, e.g., "-ORL", "-SAC".
 * Ported from desktop/src-tauri/src/matcher.rs
 */
const TEAM_ABBR_MAP: Record<string, string> = {
  "Atlanta Hawks": "ATL",
  "Boston Celtics": "BOS",
  "Brooklyn Nets": "BKN",
  "Charlotte Hornets": "CHA",
  "Chicago Bulls": "CHI",
  "Cleveland Cavaliers": "CLE",
  "Dallas Mavericks": "DAL",
  "Denver Nuggets": "DEN",
  "Detroit Pistons": "DET",
  "Golden State Warriors": "GSW",
  "Houston Rockets": "HOU",
  "Indiana Pacers": "IND",
  "Los Angeles Clippers": "LAC",
  "Los Angeles Lakers": "LAL",
  "Memphis Grizzlies": "MEM",
  "Miami Heat": "MIA",
  "Milwaukee Bucks": "MIL",
  "Minnesota Timberwolves": "MIN",
  "New Orleans Pelicans": "NOP",
  "New York Knicks": "NYK",
  "Oklahoma City Thunder": "OKC",
  "Orlando Magic": "ORL",
  "Philadelphia 76ers": "PHI",
  "Phoenix Suns": "PHX",
  "Portland Trail Blazers": "POR",
  "Sacramento Kings": "SAC",
  "San Antonio Spurs": "SAS",
  "Toronto Raptors": "TOR",
  "Utah Jazz": "UTA",
  "Washington Wizards": "WAS",
};

/**
 * Extract the team abbreviation suffix from a Kalshi ticker.
 * e.g., "KXNBAGAME-26FEB19ORLSAC-ORL" → "ORL"
 */
function tickerTeamSuffix(ticker: string): string {
  const parts = ticker.split("-");
  return parts[parts.length - 1] || "";
}

/**
 * Match predictions to Kalshi markets by team abbreviation.
 *
 * Strategy (YES-only):
 * 1. Look up the predicted winner's abbreviation
 * 2. Look up both teams' abbreviations to identify the correct game event
 * 3. Find the market whose ticker ends with the winner's abbreviation
 *    AND whose event ticker contains both teams' abbreviations
 * 4. Always bet YES on that market (never bet NO)
 *
 * Ported from desktop/src-tauri/src/matcher.rs
 */
export function matchPredictionsToMarkets(
  predictions: Prediction[],
  markets: KalshiMarket[]
): MatchedGame[] {
  const matched: MatchedGame[] = [];

  for (const pred of predictions) {
    if (pred.PREDICTION === null || pred.PREDICTION_PCT === null) continue;

    const homeAbbr = TEAM_ABBR_MAP[pred.HOME_NAME];
    const awayAbbr = TEAM_ABBR_MAP[pred.AWAY_NAME];

    if (!homeAbbr || !awayAbbr) continue;

    const predictedWinner =
      pred.PREDICTION === 1 ? pred.HOME_NAME : pred.AWAY_NAME;
    const winnerAbbr = pred.PREDICTION === 1 ? homeAbbr : awayAbbr;

    // Model probability for the predicted winner
    const modelProb =
      pred.PREDICTION === 1
        ? pred.PREDICTION_PCT
        : 1.0 - pred.PREDICTION_PCT;

    // Find the matching market
    for (const market of markets) {
      const eventTicker = market.eventTicker;
      const tickerSuffix = tickerTeamSuffix(market.ticker);

      // Check that this event involves both teams
      if (!eventTicker.includes(homeAbbr) || !eventTicker.includes(awayAbbr)) {
        continue;
      }

      // Only take the market where YES = our predicted winner
      if (tickerSuffix !== winnerAbbr) {
        continue;
      }

      const yesAsk = market.yesAsk ?? 0;

      // Skip if no valid price
      if (yesAsk <= 0 || yesAsk >= 1) continue;

      const edge = (modelProb - yesAsk) * 100;

      matched.push({
        gameId: pred.GAME_ID,
        homeName: pred.HOME_NAME,
        awayName: pred.AWAY_NAME,
        predictedWinner,
        modelProb,
        marketImpliedProb: yesAsk,
        edge,
        marketTicker: market.ticker,
        marketTitle: market.title,
        yesAsk: market.yesAsk ?? null,
        noAsk: market.noAsk ?? null,
        betSide: "yes",
      });

      break; // Found the correct market for this prediction
    }
  }

  // Sort by edge descending (best opportunities first)
  matched.sort((a, b) => b.edge - a.edge);
  return matched;
}
