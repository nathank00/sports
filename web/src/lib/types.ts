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
  /** Number of contracts currently held (positive = yes, negative = no). */
  position: number;
  exposure: number;
  totalTraded: number;
  restingOrders: number;
  realizedPnl: number;
  feesPaid: number;
}

/** A settled (closed) position from Kalshi. */
export interface SettlementItem {
  ticker: string;
  eventTicker: string;
  /** "yes" or "no" — the side that won */
  marketResult: string;
  yesCount: number;
  noCount: number;
  /** Net payout in dollars (positive = profit, negative = loss) */
  revenue: number;
  /** Total fees paid on this position */
  feesPaid: number;
  /** ISO timestamp when settled */
  settledTime: string;
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

/** Sport type for autopilot. */
export type Sport = "nba" | "mlb";

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
  period: number;              // NBA: quarter (1-4+), MLB: inning (1-9+)
  seconds_remaining: number;   // NBA: seconds left, MLB: outs remaining
  home_score: number;
  away_score: number;
  model_home_win_prob: number;
  blended_home_win_prob: number | null;
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
  reason_code: string | null;
  /** MLB-specific fields (null for NBA signals) */
  sport?: string | null;
  inning_half?: string | null;   // "top" | "bottom" | "end"
  outs_in_inning?: number | null; // 0-3
}

/** A game on today's slate — pregame, live (with model signals), or completed. */
export interface AutopilotGame {
  gameId: string;
  homeTeam: string;
  awayTeam: string;
  latestSignal: AutopilotSignal | null;
  signals: AutopilotSignal[];
  /** Schedule info (from ESPN). */
  startTime?: string;
  statusDetail?: string;
  /** Pregame Kalshi prices (from public API, before model signals arrive). */
  kalshiHomePrice?: number | null;
  kalshiAwayPrice?: number | null;
  /** Live game state from schedule endpoint (used before signals arrive). */
  homeScore?: number;
  awayScore?: number;
  period?: number;
  inningHalf?: string;
  outs?: number;
}

// ── Autopilot v2 types (simplified — Kalshi is source of truth) ───────

/**
 * Minimal position record in autopilot_positions.
 * Exists ONLY so the backend can check entry_price for TP/SL.
 * Kalshi API is the source of truth for what we actually own.
 */
export interface AutopilotPosition {
  user_id: string;
  event_id: string;
  ticker: string;
  side: "HOME" | "AWAY";
  entry_price: number;
  home_team: string;
  away_team: string;
  /** Set by backend when TP/SL triggers — bid price to sell at. Cleared by frontend after firing sell. */
  sell_signal: number | null;
}

/** Autopilot settings (persisted in Supabase, per-user per-sport). */
export interface AutopilotSettingsV2 {
  user_id: string;
  sport: Sport;
  auto_execute_enabled: boolean;
  edge_threshold: number;
  take_profit: number;
  stop_loss: number;
  sizing_mode: SizingMode;
  bet_amount: number;
  max_contracts_per_bet: number;
  updated_at: string;
}

/** A persistent log entry (one row in autopilot_logs). */
export interface AutopilotLog {
  id: number;
  user_id: string;
  timestamp: string;
  event_id: string | null;
  level: "INFO" | "BLOCKED" | "TRADE" | "EXIT" | "SETTINGS";
  message: string;
  metadata: Record<string, unknown> | null;
}
