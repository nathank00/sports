/**
 * Frontend Position Manager — simplified fire-and-verify pattern.
 *
 * Kalshi is the source of truth. No state machine. No "pending" states.
 *
 * Entry:  signal arrives → fire buy order (30s auto-expiry) → verify via Kalshi after 30s
 * Exit:   backend sets sell_signal → fire sell order → verify via Kalshi after 30s
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
  AutopilotPosition,
  AutopilotSettingsV2,
} from "@/lib/types";

export type LogCallback = (
  level: string,
  message: string,
  eventId?: string,
  metadata?: Record<string, unknown>
) => void;


export class AutopilotPositionManager {
  private userId: string;
  private onLog: LogCallback;

  /** Events currently being processed (buy or sell in-flight). Prevents double-firing. */
  private busyEvents = new Set<string>();

  /** Signals we've already acted on (by signal ID). Prevents re-buying on poll. */
  private processedSignals = new Set<number>();

  /** DB positions we've already fired sells for (by event_id). Prevents re-selling. */
  private recentSellFired = new Map<string, number>();

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

      // Write minimal DB record (for backend TP/SL checks)
      await this.upsertPosition(eventPrefix, {
        ticker,
        side: side as "HOME" | "AWAY",
        entry_price: askPrice,
        home_team: signal.home_team,
        away_team: signal.away_team,
        sell_signal: null,
      });

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
        // Update entry_price from Kalshi (exposure/position is the true average cost)
        const kalshiEntryPrice = pos.position > 0 ? pos.exposure / pos.position : 0;
        if (kalshiEntryPrice > 0) {
          await this.updateEntryPrice(eventPrefix, kalshiEntryPrice);
        }
        this.onLog("TRADE", `${gameLabel}: BUY CONFIRMED — ${pos.position} contract(s) @ ${(kalshiEntryPrice * 100).toFixed(0)}c`, undefined);
        this.writeLog("TRADE", `${gameLabel}: BUY CONFIRMED — ${pos.position} contract(s) @ ${(kalshiEntryPrice * 100).toFixed(0)}c`, undefined);
      } else {
        this.onLog("INFO", `${gameLabel}: BUY NOT FILLED — will retry on next signal`, undefined);
        this.writeLog("INFO", `${gameLabel}: BUY NOT FILLED`, undefined);
        // Delete the DB record since we don't actually own anything
        await this.deletePosition(eventPrefix);
      }
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      this.onLog("INFO", `${gameLabel}: Cannot verify buy: ${errMsg}`, undefined);
    } finally {
      this.busyEvents.delete(eventPrefix);
    }
  }

  // ── Exit: triggered by sell_signal from backend or manual button ───

  /**
   * Check DB positions for sell_signal set by backend (TP/SL).
   * Called by dashboard polling loop.
   */
  async checkSellSignals(): Promise<void> {
    try {
      const { data } = await supabase
        .from("autopilot_positions")
        .select("*")
        .eq("user_id", this.userId)
        .not("sell_signal", "is", null);

      if (!data || data.length === 0) return;

      for (const pos of data as AutopilotPosition[]) {
        await this.fireSell(pos, "AUTO");
      }
    } catch (e) {
      console.error("checkSellSignals error:", e);
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

  private async fireSell(position: AutopilotPosition, reason: "AUTO" | "MANUAL"): Promise<void> {
    const { ticker, side, entry_price, home_team, away_team, event_id } = position;
    const gameLabel = `${away_team}@${home_team}`;
    const eventPrefix = ticker.substring(0, ticker.lastIndexOf("-"));

    // Skip if already processing this game
    if (this.busyEvents.has(eventPrefix)) {
      this.onLog("INFO", `${gameLabel}: Sell already in progress — waiting`, undefined);
      return;
    }

    // Skip if we recently fired a sell for this event (within 45s)
    // Manual exits bypass this cooldown — only AUTO sells are throttled
    if (reason === "AUTO") {
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
        this.onLog("INFO", `${gameLabel}: No position found on Kalshi for ${ticker} — cleaning up`, undefined);
        await this.deletePosition(eventPrefix);
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

      // Clear sell_signal immediately
      await supabase
        .from("autopilot_positions")
        .update({ sell_signal: null })
        .eq("user_id", this.userId)
        .eq("event_id", event_id);

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
        await this.deletePosition(eventPrefix);
      } else {
        this.onLog("INFO", `${gameLabel}: SELL NOT FILLED — still own ${pos.position} contract(s)`, undefined);
        this.writeLog("INFO", `${gameLabel}: SELL NOT FILLED — still own ${pos.position}`, undefined);
        // Don't delete the position — backend will re-trigger sell_signal on next tick
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

  private async upsertPosition(eventId: string, data: Omit<AutopilotPosition, "user_id" | "event_id">): Promise<void> {
    try {
      await supabase
        .from("autopilot_positions")
        .upsert(
          { user_id: this.userId, event_id: eventId, ...data },
          { onConflict: "user_id,event_id" }
        );
    } catch (e) {
      console.error("upsertPosition error:", e);
    }
  }

  private async updateEntryPrice(eventId: string, entryPrice: number): Promise<void> {
    try {
      await supabase
        .from("autopilot_positions")
        .update({ entry_price: entryPrice })
        .eq("user_id", this.userId)
        .eq("event_id", eventId);
    } catch (e) {
      console.error("updateEntryPrice error:", e);
    }
  }

  private async deletePosition(eventId: string): Promise<void> {
    try {
      await supabase
        .from("autopilot_positions")
        .delete()
        .eq("user_id", this.userId)
        .eq("event_id", eventId);
    } catch (e) {
      console.error("deletePosition error:", e);
    }
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
