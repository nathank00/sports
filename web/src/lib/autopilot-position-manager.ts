/**
 * Frontend Position Manager — simplified fire-and-verify pattern.
 *
 * Kalshi is the source of truth. No state machine. No "pending" states.
 *
 * Entry:  signal arrives → fire buy order (30s auto-expiry) → verify via Kalshi after 30s
 *         ALSO: every 5s, re-evaluate latest signal with fresh Kalshi prices (price-check)
 * Exit:   TP/SL triggers sell → verify via Kalshi after 30s
 * Manual: user clicks EXIT → same as above
 *
 */

import { supabase } from "@/lib/supabase";
import {
  placeOrder,
  sellOrder,
  fetchNbaMarkets,
  fetchPositions,
} from "@/lib/kalshi-api";
import type {
  AutopilotSignal,
  AutopilotGame,
  AutopilotPosition,
  AutopilotSettingsV2,
  PositionItem,
  KalshiMarket,
} from "@/lib/types";

export type LogCallback = (
  level: string,
  message: string,
  eventId?: string,
  metadata?: Record<string, unknown>
) => void;

/** Game state for TP/SL + late-game exit checking. Keyed by team abbreviation in dashboard. */
export interface GameState {
  period: number;
  secondsRemaining: number;
  homeTeam: string;
  awayTeam: string;
}


export class AutopilotPositionManager {
  private userId: string;
  private onLog: LogCallback;

  /** Events currently being processed (buy or sell in-flight). Prevents double-firing. */
  private busyEvents = new Set<string>();

  /** Signals we've already acted on (by signal ID). Prevents re-buying on poll. */
  private processedSignals = new Set<number>();

  /** Events we've recently fired sells for (by event_id). Prevents re-selling. */
  private recentSellFired = new Map<string, number>();

  /** Last signal ID we evaluated per game (by game_id). Resets when new signal arrives so we re-check. */
  private lastCheckedSignalId = new Map<string, number>();

  /** Tracks whether we already fired a buy for a given signal ID via the 5s price check. */
  private priceCheckFiredSignals = new Set<number>();

  constructor(userId: string, onLog: LogCallback) {
    this.userId = userId;
    this.onLog = onLog;
  }

  // ── Entry: fired by dashboard when new signal arrives ─────────────

  /** No-trade window — last 5 minutes of Q4/OT. Must match backend. */
  private static readonly NO_TRADE_SECONDS = 300;

  /**
   * Evaluate a signal for entry. Called by the dashboard on each new signal.
   * Checks no-trade window, edge threshold, existing positions, then fires a buy if qualified.
   */
  async evaluateSignal(
    signal: AutopilotSignal,
    settings: AutopilotSettingsV2,
  ): Promise<void> {
    // Skip if not a buy signal
    if (signal.recommended_action !== "BUY_HOME" && signal.recommended_action !== "BUY_AWAY") {
      return;
    }

    // Skip if already processed this signal
    if (this.processedSignals.has(signal.id)) return;
    this.processedSignals.add(signal.id);

    // Prune old signal IDs (keep last 500)
    if (this.processedSignals.size > 500) {
      const arr = Array.from(this.processedSignals);
      for (let i = 0; i < arr.length - 500; i++) {
        this.processedSignals.delete(arr[i]);
      }
    }

    const edge = signal.edge_vs_kalshi;
    if (edge == null || edge < settings.edge_threshold) return;

    const ticker = signal.recommended_ticker;
    if (!ticker) return;

    const side = signal.recommended_action === "BUY_HOME" ? "HOME" : "AWAY";
    const gameLabel = `${signal.away_team}@${signal.home_team}`;

    // Underdog rule: require 2x edge threshold for low-probability sides (<20% model prob).
    // Matches backend logic in decision.py (underdog_prob_threshold = 0.20).
    const UNDERDOG_PROB_THRESHOLD = 0.20;
    const modelHomeProb = signal.blended_home_win_prob ?? signal.model_home_win_prob;
    const sideProb = side === "HOME" ? modelHomeProb : 1 - modelHomeProb;
    if (sideProb < UNDERDOG_PROB_THRESHOLD) {
      const underdogThreshold = settings.edge_threshold * 2;
      if (edge < underdogThreshold) {
        this.onLog(
          "BLOCKED",
          `${gameLabel}: Underdog edge ${edge.toFixed(1)}% < 2x threshold ${underdogThreshold.toFixed(1)}%`,
        );
        return;
      }
    }

    // No-trade window: last 5 minutes of Q4 or OT — skip silently (backend logs BLOCKED)
    if (signal.period >= 4 && signal.seconds_remaining < AutopilotPositionManager.NO_TRADE_SECONDS) {
      return;
    }

    // Extract event prefix (e.g., "KXNBAGAME-26MAR14-BOS-MIL" from ticker)
    const eventPrefix = ticker.substring(0, ticker.lastIndexOf("-"));
    if (!eventPrefix) return;

    // Skip if already busy with this game
    if (this.busyEvents.has(eventPrefix)) return;
    // Mark busy IMMEDIATELY to prevent race condition with concurrent signals
    this.busyEvents.add(eventPrefix);

    let orderFired = false;
    try {
      // Check Kalshi: do we already own contracts on this game?
      const kalshiPositions = await fetchPositions();
      const existing = kalshiPositions.find(
        (p) => p.position > 0 && p.ticker.startsWith(eventPrefix)
      );
      if (existing) {
        this.onLog("INFO", `${gameLabel}: Already own ${existing.position} contract(s) on ${existing.ticker} — skipping`, undefined);
        return;
      }

      // Fetch fresh ask price
      const markets = await fetchNbaMarkets();
      const market = markets.find((m) => m.ticker === ticker);
      if (!market?.yesAsk) {
        this.onLog("INFO", `${gameLabel}: No ask price for ${ticker} — skipping`, undefined);
        return;
      }
      const askPrice = market.yesAsk;

      // Compute contract count
      const contracts = this.computeContracts(settings, askPrice);

      // Fire buy order
      const result = await placeOrder(ticker, "yes", contracts, askPrice.toFixed(2), "buy");
      orderFired = true;

      this.onLog(
        "TRADE",
        `${gameLabel}: BUY FIRED — ${side} x${contracts} @ ${(askPrice * 100).toFixed(0)}c (edge ${edge.toFixed(1)}%)`,
        undefined,
        { orderId: result.orderId, ticker, contracts, askPrice, edge }
      );
      this.writeLog(
        "TRADE",
        `${gameLabel}: BUY FIRED — ${side} x${contracts} @ ${(askPrice * 100).toFixed(0)}c (edge ${edge.toFixed(1)}%)`,
        undefined,
        { orderId: result.orderId, ticker, contracts, askPrice, edge }
      );

      // Verify after 30s
      setTimeout(() => this.verifyBuy(ticker, eventPrefix, gameLabel, contracts), 30_000);
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      this.onLog("INFO", `${gameLabel}: BUY FAILED — ${errMsg}`, undefined);
      this.writeLog("INFO", `${gameLabel}: BUY FAILED — ${errMsg}`, undefined);
    } finally {
      // Release busyEvents unless we fired an order (verifyBuy releases after 30s)
      if (!orderFired) {
        this.busyEvents.delete(eventPrefix);
      }
    }
  }

  private async verifyBuy(ticker: string, eventPrefix: string, gameLabel: string, expectedContracts: number): Promise<void> {
    try {
      const positions = await fetchPositions();
      const pos = positions.find((p) => p.ticker === ticker && p.position > 0);
      if (pos) {
        const kalshiEntryPrice = pos.position > 0 ? pos.exposure / pos.position : 0;
        this.onLog("TRADE", `${gameLabel}: BUY CONFIRMED — ${pos.position} contract(s) @ ${(kalshiEntryPrice * 100).toFixed(0)}c`, undefined);
        this.writeLog("TRADE", `${gameLabel}: BUY CONFIRMED — ${pos.position} contract(s) @ ${(kalshiEntryPrice * 100).toFixed(0)}c`, undefined);
      } else {
        this.onLog("INFO", `${gameLabel}: BUY NOT FILLED — will retry on next signal`, undefined);
        this.writeLog("INFO", `${gameLabel}: BUY NOT FILLED`, undefined);
      }
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      this.onLog("INFO", `${gameLabel}: Cannot verify buy: ${errMsg}`, undefined);
    } finally {
      this.busyEvents.delete(eventPrefix);
    }
  }

  // ── Exit: triggered by TP/SL/late-game or manual button ────────────

  /**
   * Frontend-side TP/SL + late-game exit checking — runs every 5s from dashboard poll.
   *
   * Uses KALSHI POSITIONS as source of truth. Entry price is computed from
   * Kalshi exposure/position. Game state (period, seconds remaining) comes from
   * the gameStates map built from dashboard signals.
   *
   * Market bids come from the authenticated Kalshi API (reliable data).
   */
  async checkAutoExits(
    settings: AutopilotSettingsV2,
    kalshiPositions: PositionItem[],
    gameStates: Map<string, GameState>,
    markets: KalshiMarket[],
  ): Promise<void> {
    // Work from actual Kalshi holdings
    const activeKalshi = kalshiPositions.filter(
      (kp) => kp.position > 0 && kp.ticker.startsWith("KXNBA")
    );
    if (activeKalshi.length === 0) return;

    for (const kp of activeKalshi) {
      const { ticker } = kp;
      const eventPrefix = ticker.substring(0, ticker.lastIndexOf("-"));

      // Skip if already processing or recently sold
      if (this.busyEvents.has(eventPrefix)) continue;
      const lastSell = this.recentSellFired.get(eventPrefix);
      if (lastSell && Date.now() - lastSell < 45_000) continue;

      // Entry price from Kalshi (exposure / position)
      const entryPrice = kp.position > 0 ? kp.exposure / kp.position : 0;
      if (entryPrice <= 0) continue;

      // Look up game state by team abbreviation from ticker
      const tickerTeam = ticker.substring(ticker.lastIndexOf("-") + 1);
      const gameState = gameStates.get(tickerTeam);
      const gameLabel = gameState
        ? `${gameState.awayTeam}@${gameState.homeTeam}`
        : ticker;

      // Get current bid from markets (fallback to lastPrice like fireSell does)
      const market = markets.find((m) => m.ticker === ticker);
      const currentBid = market?.yesBid ?? market?.lastPrice;

      // Build position object for fireSell
      const isHome = gameState ? tickerTeam === gameState.homeTeam : true;
      const posForSell: AutopilotPosition = {
        user_id: this.userId,
        event_id: eventPrefix,
        ticker,
        side: isHome ? "HOME" : "AWAY",
        entry_price: entryPrice,
        home_team: gameState?.homeTeam ?? "",
        away_team: gameState?.awayTeam ?? "",
        sell_signal: null,
      };

      if (currentBid == null) {
        // Only warn if market object exists but has no price data.
        // Missing market = closed/settled game — skip silently.
        if (market) {
          console.warn(`[TP/SL] ${gameLabel}: No bid/lastPrice for ${ticker}`);
        }
        continue;
      }

      const pnl = currentBid - entryPrice;
      console.log(
        `[TP/SL] ${gameLabel}: bid=${(currentBid * 100).toFixed(0)}c entry=${(entryPrice * 100).toFixed(0)}c pnl=${(pnl * 100).toFixed(0)}c | TP=${(settings.take_profit * 100).toFixed(0)}c SL=-${(settings.stop_loss * 100).toFixed(0)}c`
      );

      // Take-profit check
      if (pnl >= settings.take_profit) {
        this.onLog(
          "EXIT",
          `${gameLabel}: TAKE PROFIT — +${(pnl * 100).toFixed(0)}c/contract (entry=${(entryPrice * 100).toFixed(0)}c, bid=${(currentBid * 100).toFixed(0)}c)`,
        );
        this.writeLog(
          "EXIT",
          `${gameLabel}: TAKE PROFIT — +${(pnl * 100).toFixed(0)}c/contract (entry=${(entryPrice * 100).toFixed(0)}c, bid=${(currentBid * 100).toFixed(0)}c)`,
          undefined,
          { reason_code: "EXIT_TP_TRIGGERED", entry_price: entryPrice, currentBid, pnl_per_contract: pnl, ticker },
        );
        await this.fireSell(posForSell, "TAKE PROFIT");
        continue;
      }

      // Stop-loss check
      if (pnl <= -settings.stop_loss) {
        this.onLog(
          "EXIT",
          `${gameLabel}: STOP LOSS — ${(pnl * 100).toFixed(0)}c/contract (entry=${(entryPrice * 100).toFixed(0)}c, bid=${(currentBid * 100).toFixed(0)}c)`,
        );
        this.writeLog(
          "EXIT",
          `${gameLabel}: STOP LOSS — ${(pnl * 100).toFixed(0)}c/contract (entry=${(entryPrice * 100).toFixed(0)}c, bid=${(currentBid * 100).toFixed(0)}c)`,
          undefined,
          { reason_code: "EXIT_SL_TRIGGERED", entry_price: entryPrice, currentBid, pnl_per_contract: pnl, ticker },
        );
        await this.fireSell(posForSell, "STOP LOSS");
        continue;
      }
    }
  }

  // ── Entry: 5s price-check re-evaluation ──────────────────────────────

  /** Friction in cents — must match backend decision.py config. */
  private static readonly FRICTION_CENTS = 2.0;

  /**
   * Re-evaluate entry opportunities every 5s using fresh Kalshi prices.
   *
   * Uses the model probability from each game's latestSignal (updated every ~15s
   * or on new play) but compares it against fresh ask prices from the markets
   * array (fetched every 5s by the dashboard poll).
   *
   * This catches edge opportunities that appear between signals when market
   * prices move favorably — the model prediction hasn't changed, but the
   * price has moved past our threshold.
   */
  async checkEntryOpportunities(
    settings: AutopilotSettingsV2,
    games: Map<string, AutopilotGame>,
    kalshiPositions: PositionItem[],
    markets: KalshiMarket[],
  ): Promise<void> {
    const UNDERDOG_PROB_THRESHOLD = 0.20;

    for (const game of games.values()) {
      const signal = game.latestSignal;
      if (!signal) continue;

      // Need tickers and model probability to evaluate
      const homeTicker = signal.kalshi_ticker_home;
      const awayTicker = signal.kalshi_ticker_away;
      if (!homeTicker && !awayTicker) continue;

      const modelHomeProb = signal.blended_home_win_prob ?? signal.model_home_win_prob;
      const modelAwayProb = 1 - modelHomeProb;

      // No-trade window: last 5 minutes of Q4 or OT
      if (signal.period >= 4 && signal.seconds_remaining < AutopilotPositionManager.NO_TRADE_SECONDS) {
        continue;
      }

      // Skip if we already fired a buy for this exact signal via price-check
      if (this.priceCheckFiredSignals.has(signal.id)) continue;

      // Skip if evaluateSignal already processed this signal (and presumably fired or passed on non-price grounds)
      // But ONLY skip if the signal was a BUY signal that was already handled.
      // If it was handled but edge was too low at the time, we still want to re-check with fresh prices.
      // So we DON'T check processedSignals here — that's the whole point.

      // Check both sides for edge with fresh prices
      let bestEdge = 0;
      let bestTicker: string | null = null;
      let bestSide: "HOME" | "AWAY" | null = null;
      let bestAskPrice = 0;

      for (const [ticker, modelProb, side] of [
        [homeTicker, modelHomeProb, "HOME"] as const,
        [awayTicker, modelAwayProb, "AWAY"] as const,
      ]) {
        if (!ticker) continue;
        const market = markets.find((m) => m.ticker === ticker);
        if (!market?.yesAsk) continue;

        const edge = (modelProb - market.yesAsk) * 100 - AutopilotPositionManager.FRICTION_CENTS;
        if (edge > bestEdge) {
          bestEdge = edge;
          bestTicker = ticker;
          bestSide = side;
          bestAskPrice = market.yesAsk;
        }
      }

      if (!bestTicker || !bestSide || bestEdge <= 0) continue;

      // Edge threshold check
      if (bestEdge < settings.edge_threshold) continue;

      // Underdog rule: require 2x edge threshold for low-probability sides
      const sideProb = bestSide === "HOME" ? modelHomeProb : modelAwayProb;
      if (sideProb < UNDERDOG_PROB_THRESHOLD) {
        const underdogThreshold = settings.edge_threshold * 2;
        if (bestEdge < underdogThreshold) continue;
      }

      // Extract event prefix
      const eventPrefix = bestTicker.substring(0, bestTicker.lastIndexOf("-"));
      if (!eventPrefix) continue;

      // Skip if already busy (buy or sell in-flight for this game)
      if (this.busyEvents.has(eventPrefix)) continue;

      // Skip if we already own contracts on this game
      const existing = kalshiPositions.find(
        (p) => p.position > 0 && p.ticker.startsWith(eventPrefix)
      );
      if (existing) continue;

      // All checks passed — fire buy
      const gameLabel = `${signal.away_team}@${signal.home_team}`;
      this.busyEvents.add(eventPrefix);
      this.priceCheckFiredSignals.add(signal.id);

      // Prune old priceCheckFiredSignals (keep last 500)
      if (this.priceCheckFiredSignals.size > 500) {
        const arr = Array.from(this.priceCheckFiredSignals);
        for (let i = 0; i < arr.length - 500; i++) {
          this.priceCheckFiredSignals.delete(arr[i]);
        }
      }

      let orderFired = false;
      try {
        const contracts = this.computeContracts(settings, bestAskPrice);

        const result = await placeOrder(bestTicker, "yes", contracts, bestAskPrice.toFixed(2), "buy");
        orderFired = true;

        this.onLog(
          "TRADE",
          `${gameLabel}: BUY FIRED — ${bestSide} x${contracts} @ ${(bestAskPrice * 100).toFixed(0)}c (edge ${bestEdge.toFixed(1)}%, price-check)`,
          undefined,
          { orderId: result.orderId, ticker: bestTicker, contracts, askPrice: bestAskPrice, edge: bestEdge, trigger: "price-check" }
        );
        this.writeLog(
          "TRADE",
          `${gameLabel}: BUY FIRED — ${bestSide} x${contracts} @ ${(bestAskPrice * 100).toFixed(0)}c (edge ${bestEdge.toFixed(1)}%, price-check)`,
          undefined,
          { orderId: result.orderId, ticker: bestTicker, contracts, askPrice: bestAskPrice, edge: bestEdge, trigger: "price-check" }
        );

        // Verify after 30s
        setTimeout(() => this.verifyBuy(bestTicker!, eventPrefix, gameLabel, contracts), 30_000);
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        this.onLog("INFO", `${gameLabel}: BUY FAILED — ${errMsg}`, undefined);
        this.writeLog("INFO", `${gameLabel}: BUY FAILED — ${errMsg}`, undefined);
      } finally {
        if (!orderFired) {
          this.busyEvents.delete(eventPrefix);
        }
      }
    }
  }

  /**
   * Manual exit — user clicked EXIT button on a game card.
   * Bypasses the recentSellFired cooldown (that's for AUTO sells only).
   */
  async manualExit(position: AutopilotPosition): Promise<void> {
    const gameLabel = `${position.away_team}@${position.home_team}`;
    this.onLog("TRADE", `${gameLabel}: MANUAL EXIT requested`, undefined);

    await this.fireSell(position, "MANUAL");
  }

  private async fireSell(position: AutopilotPosition, reason: string): Promise<void> {
    const { ticker, side, entry_price, home_team, away_team, event_id } = position;
    const gameLabel = `${away_team}@${home_team}`;

    if (!ticker) {
      this.onLog("INFO", `${gameLabel}: No ticker — cannot sell`, undefined);
      return;
    }

    const eventPrefix = ticker.substring(0, ticker.lastIndexOf("-"));

    // Skip if already processing this game
    if (this.busyEvents.has(eventPrefix)) {
      this.onLog("INFO", `${gameLabel}: Sell already in progress — waiting`, undefined);
      return;
    }

    // Skip if we recently fired a sell for this event (within 45s)
    // Manual exits bypass this cooldown — auto/TP/SL sells are throttled
    if (reason !== "MANUAL") {
      const lastSell = this.recentSellFired.get(event_id);
      if (lastSell && Date.now() - lastSell < 45_000) return;
    }

    // Get current quantity + entry price from Kalshi
    let quantity: number;
    let kalshiEntryPrice: number;
    try {
      const positions = await fetchPositions();
      const pos = positions.find((p) => p.ticker === ticker && p.position > 0);
      if (!pos || pos.position <= 0) {
        this.onLog("INFO", `${gameLabel}: No position found on Kalshi for ${ticker}`, undefined);
        return;
      }
      quantity = pos.position;
      // Derive entry price from Kalshi (exposure / position)
      kalshiEntryPrice = pos.exposure / pos.position;
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      this.onLog("INFO", `${gameLabel}: Cannot check Kalshi positions: ${errMsg}`, undefined);
      return;
    }

    // Fetch fresh bid price
    let bidPrice: number;
    try {
      const markets = await fetchNbaMarkets();
      const market = markets.find((m) => m.ticker === ticker);
      if (market?.yesBid != null) {
        bidPrice = market.yesBid;
      } else if (market?.lastPrice != null) {
        bidPrice = market.lastPrice;
      } else {
        this.onLog("INFO", `${gameLabel}: No bid price for ${ticker} — cannot sell`, undefined);
        return;
      }
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      this.onLog("INFO", `${gameLabel}: Cannot fetch markets: ${errMsg}`, undefined);
      return;
    }

    this.busyEvents.add(eventPrefix);
    this.recentSellFired.set(event_id, Date.now());

    // Prune old recentSellFired entries
    for (const [key, ts] of this.recentSellFired) {
      if (Date.now() - ts > 120_000) this.recentSellFired.delete(key);
    }

    try {
      // Use Kalshi-derived entry price for P&L (source of truth)
      const pnlPerContract = bidPrice - kalshiEntryPrice;
      const totalPnl = pnlPerContract * quantity;
      const pnlStr = `${totalPnl >= 0 ? "+" : ""}$${totalPnl.toFixed(2)}`;

      const result = await sellOrder(ticker, "yes", quantity, bidPrice.toFixed(2));
      this.onLog(
        "TRADE",
        `${gameLabel}: SELL FIRED — x${quantity} @ ${(bidPrice * 100).toFixed(0)}c (${reason}, P&L: ${pnlStr})`,
        undefined,
        { orderId: result.orderId, ticker, quantity, bidPrice, reason, pnl: totalPnl }
      );
      this.writeLog(
        "TRADE",
        `${gameLabel}: SELL FIRED — x${quantity} @ ${(bidPrice * 100).toFixed(0)}c (${reason}, P&L: ${pnlStr})`,
        undefined,
        { orderId: result.orderId, ticker, quantity, bidPrice, reason, pnl: totalPnl }
      );

      // Verify after 30s
      setTimeout(() => this.verifySell(ticker, eventPrefix, gameLabel, quantity), 30_000);
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      this.onLog("INFO", `${gameLabel}: SELL FAILED — ${errMsg}`, undefined);
      this.writeLog("INFO", `${gameLabel}: SELL FAILED — ${errMsg}`, undefined);
      this.busyEvents.delete(eventPrefix);
    }
  }

  private async verifySell(ticker: string, eventPrefix: string, gameLabel: string, soldQuantity: number): Promise<void> {
    try {
      const positions = await fetchPositions();
      const pos = positions.find((p) => p.ticker === ticker && p.position > 0);
      if (!pos || pos.position <= 0) {
        this.onLog("TRADE", `${gameLabel}: SELL CONFIRMED — position closed`, undefined);
        this.writeLog("TRADE", `${gameLabel}: SELL CONFIRMED — position closed`, undefined);
      } else {
        this.onLog("INFO", `${gameLabel}: SELL NOT FILLED — still own ${pos.position} contract(s)`, undefined);
        this.writeLog("INFO", `${gameLabel}: SELL NOT FILLED — still own ${pos.position}`, undefined);
      }
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      this.onLog("INFO", `${gameLabel}: Cannot verify sell: ${errMsg}`, undefined);
    } finally {
      this.busyEvents.delete(eventPrefix);
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────

  private computeContracts(settings: AutopilotSettingsV2, price: number): number {
    if (settings.sizing_mode === "contracts") {
      return Math.min(Math.floor(settings.bet_amount), settings.max_contracts_per_bet);
    }
    // Dollars mode
    if (price <= 0 || price >= 1) return 1;
    const count = Math.floor(settings.bet_amount / price);
    return Math.min(Math.max(count, 1), settings.max_contracts_per_bet);
  }

  private async writeLog(level: string, message: string, eventId?: string, metadata?: Record<string, unknown>): Promise<void> {
    const row = { user_id: this.userId, level, message, event_id: eventId ?? null, metadata: metadata ?? null };
    try {
      await supabase.from("autopilot_logs").insert(row);
    } catch {
      // Silently fail — logs are best-effort
    }
  }

  dispose(): void {
    // No background tasks to clean up
  }
}
