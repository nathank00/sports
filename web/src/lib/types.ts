// ── Existing types (unchanged) ──────────────────────────────────────────

export interface GameLog {
  GAME_ID: number;
  GAME_DATE: string;
  AWAY_NAME: string;
  HOME_NAME: string;
  GAME_STATUS: number;
  GAME_OUTCOME: number | null;
  PREDICTION: number | null;
  PREDICTION_PCT: number | null;
  AWAY_PTS: number | null;
  HOME_PTS: number | null;
}

export interface MlbGameLog {
  GAME_ID: number;
  GAME_DATE: string;
  AWAY_NAME: string;
  HOME_NAME: string;
  GAME_STATUS: number;
  GAME_OUTCOME: number | null;
  PREDICTION: number | null;
  PREDICTION_PCT: number | null;
  AWAY_RUNS: number | null;
  HOME_RUNS: number | null;
  HOME_SP: number | null;
  AWAY_SP: number | null;
}

export interface WLRecord {
  wins: number;
  losses: number;
}

// ── Terminal types (ported from desktop app) ────────────────────────────

/** Kalshi market with prices as numbers (parsed from API string fields). */
export interface KalshiMarket {
  ticker: string;
  title: string;
  subtitle?: string;
  eventTicker: string;
  status: string;
  yesBid?: number;
  yesAsk?: number;
  noBid?: number;
  noAsk?: number;
  lastPrice?: number;
  volume?: number;
  openInterest?: number;
}

/** A prediction matched to a Kalshi market with edge calculation. */
export interface MatchedGame {
  gameId: number;
  homeName: string;
  awayName: string;
  predictedWinner: string;
  modelProb: number;
  marketImpliedProb: number;
  edge: number;
  marketTicker: string;
  marketTitle: string;
  yesAsk: number | null;
  noAsk: number | null;
  betSide: string;
}

/** Result from placing a Kalshi order. */
export interface OrderResult {
  orderId: string;
  ticker: string;
  status: string;
  side: string;
  action: string;
  fillCount: number | null;
  remainingCount: number | null;
}

/** A single portfolio position. */
export interface PositionItem {
  ticker: string;
  exposure: number;
  totalTraded: number;
  restingOrders: number;
}

/** Portfolio overview data. */
export interface PortfolioOverview {
  connected: boolean;
  balance: number;
  portfolioValue: number;
  positionsCount: number;
  positions: PositionItem[];
  error: string | null;
}

/** Prediction display for the terminal (before market matching). */
export interface PredictionDisplay {
  gameId: number;
  homeName: string;
  awayName: string;
  predictedWinner: string;
  winProbability: number;
  gameStatus: number;
}

/** Position sizing mode. */
export type SizingMode = "contracts" | "dollars";

/** Terminal trading settings (persisted in localStorage). */
export interface TerminalSettings {
  edgeThreshold: number;
  sizingMode: SizingMode;
  betAmount: number;
}
