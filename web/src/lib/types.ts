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

// ── Autopilot types ─────────────────────────────────────────────────────

/** A prediction signal from the autopilot backend (one row in autopilot_signals). */
export interface AutopilotSignal {
  id: number;
  created_at: string;
  game_id: string;
  home_team: string;
  away_team: string;
  period: number;
  seconds_remaining: number;
  home_score: number;
  away_score: number;
  model_home_win_prob: number;
  kalshi_ticker_home: string | null;
  kalshi_ticker_away: string | null;
  kalshi_home_price: number | null;
  kalshi_away_price: number | null;
  pregame_home_ml_prob: number | null;
  edge_vs_kalshi: number | null;
  recommended_action: string;
  recommended_side: string | null;
  recommended_ticker: string | null;
  reason: string | null;
}

/** A live game grouped from autopilot signals. */
export interface AutopilotGame {
  gameId: string;
  homeTeam: string;
  awayTeam: string;
  latestSignal: AutopilotSignal;
  signals: AutopilotSignal[];
  trades: AutopilotExecution[];
}

/** A trade executed by the frontend auto-execution engine. */
export interface AutopilotExecution {
  signalId: number;
  timestamp: string;
  ticker: string;
  side: string;
  contracts: number;
  price: number;
  orderId: string | null;
  status: string;
  fillCount: number | null;
}

/** Autopilot settings (persisted in localStorage). */
export interface AutopilotSettings {
  autoExecuteEnabled: boolean;
  edgeThreshold: number;
  sizingMode: SizingMode;
  betAmount: number;
  cooldownSeconds: number;
  maxContractsPerGame: number;
}
