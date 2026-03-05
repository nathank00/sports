/**
 * Frontend Position Manager — executes trade intents and monitors exits.
 *
 * Subscribes to position state changes from Supabase:
 * - PENDING_ENTRY → execute buy order with browser-stored Kalshi keys
 * - LONG_HOME/LONG_AWAY → monitor prices for TP/SL exits
 * - EXITING → sell order in progress
 * - LOCKED → done, no action
 *
 * All Kalshi keys stay in the browser. The backend decides when to enter;
 * this module handles the actual execution + exit monitoring.
 */

import { supabase } from "@/lib/supabase";
import {
  placeOrder,
  sellOrder,
  fetchNbaMarkets,
} from "@/lib/kalshi-api";
import type {
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
  private exitMonitorInterval: ReturnType<typeof setInterval> | null = null;
  private onLog: LogCallback;
  private processingIntents = new Set<string>(); // event_ids being processed

  constructor(userId: string, onLog: LogCallback) {
    this.userId = userId;
    this.onLog = onLog;
  }

  /**
   * Handle a position state change from Supabase realtime.
   */
  async handlePositionChange(position: AutopilotPosition): Promise<void> {
    if (position.user_id !== this.userId) return;

    if (position.state === "PENDING_ENTRY") {
      // Prevent double-processing
      if (this.processingIntents.has(position.event_id)) return;
      this.processingIntents.add(position.event_id);
      try {
        await this.executeEntry(position);
      } finally {
        this.processingIntents.delete(position.event_id);
      }
    }
  }

  /**
   * Execute a buy order from a PENDING_ENTRY intent.
   */
  private async executeEntry(position: AutopilotPosition): Promise<void> {
    const {
      event_id,
      ticker,
      intent_price,
      intent_contracts,
      intent_created_at,
      home_team,
      away_team,
      side,
    } = position;

    const gameLabel = `${away_team}@${home_team}`;

    // Validate intent hasn't expired (35s timeout matches backend)
    if (intent_created_at) {
      const intentAge = Date.now() - new Date(intent_created_at).getTime();
      if (intentAge > 35_000) {
        this.onLog("INFO", `${gameLabel}: Intent expired (${Math.round(intentAge / 1000)}s old)`, event_id);
        await this.updatePosition(event_id, {
          state: "FLAT",
          side: null,
          ticker: null,
          intent_price: null,
          intent_contracts: null,
          intent_side: null,
          intent_created_at: null,
        });
        return;
      }
    }

    if (!ticker || !intent_price || !intent_contracts) {
      this.onLog("INFO", `${gameLabel}: Invalid intent data`, event_id);
      return;
    }

    // Fetch fresh Kalshi price
    let freshPrice = intent_price;
    try {
      const markets = await fetchNbaMarkets();
      const market = markets.find((m) => m.ticker === ticker);
      if (market?.yesAsk != null) {
        freshPrice = market.yesAsk;
        this.onLog(
          "INFO",
          `${gameLabel}: Fresh ask ${(freshPrice * 100).toFixed(0)}c (intent was ${(intent_price * 100).toFixed(0)}c)`,
          event_id
        );
      }
    } catch {
      this.onLog("INFO", `${gameLabel}: Could not fetch fresh prices, using intent price`, event_id);
    }

    // Place buy order
    try {
      const result = await placeOrder(
        ticker,
        "yes",
        intent_contracts,
        freshPrice.toFixed(2),
        "buy"
      );

      const fillCount = result.fillCount ?? 0;

      if (fillCount > 0) {
        // Fetch user settings for TP/SL calculation
        const settings = await this.fetchSettings();
        const tp = settings?.take_profit ?? 0.08;
        const sl = settings?.stop_loss ?? 0.05;
        const cooldown = settings?.cooldown_seconds ?? 60;

        const entryPrice = freshPrice; // approximate — Kalshi may fill at a better price
        const tpPrice = entryPrice + tp;
        const slPrice = entryPrice - sl;
        const newState = side === "HOME" ? "LONG_HOME" : "LONG_AWAY";

        await this.updatePosition(event_id, {
          state: newState,
          entry_price: entryPrice,
          quantity: fillCount,
          entry_timestamp: new Date().toISOString(),
          take_profit_price: tpPrice,
          stop_loss_price: slPrice,
          intent_price: null,
          intent_contracts: null,
          intent_side: null,
          intent_created_at: null,
        });

        this.onLog(
          "TRADE",
          `${gameLabel}: FILLED ${side} YES x${fillCount} @ ${(entryPrice * 100).toFixed(0)}c (TP=${(tpPrice * 100).toFixed(0)}c, SL=${(slPrice * 100).toFixed(0)}c)`,
          event_id,
          { ticker, fillCount, entryPrice, tpPrice, slPrice }
        );

        this.writeLog(
          "TRADE",
          `ENTRY FILLED: ${side} YES x${fillCount} @ ${(entryPrice * 100).toFixed(0)}c`,
          event_id,
          { ticker, fillCount, entryPrice, tpPrice, slPrice }
        );
      } else {
        // No fills — reset to FLAT
        await this.updatePosition(event_id, {
          state: "FLAT",
          side: null,
          ticker: null,
          intent_price: null,
          intent_contracts: null,
          intent_side: null,
          intent_created_at: null,
        });

        this.onLog("INFO", `${gameLabel}: Order placed but no fills — back to FLAT`, event_id);
        this.writeLog("INFO", "Entry order got no fills — reset to FLAT", event_id);
      }
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      this.onLog("INFO", `${gameLabel}: Order failed — ${errMsg}`, event_id);
      this.writeLog("INFO", `Entry order failed: ${errMsg}`, event_id);

      // Reset to FLAT on error
      await this.updatePosition(event_id, {
        state: "FLAT",
        side: null,
        ticker: null,
        intent_price: null,
        intent_contracts: null,
        intent_side: null,
        intent_created_at: null,
      });
    }
  }

  /**
   * Start the exit monitor — polls Kalshi prices every 4 seconds
   * and checks TP/SL for all held positions.
   */
  startExitMonitor(
    getPositions: () => AutopilotPosition[]
  ): void {
    this.stopExitMonitor();

    this.exitMonitorInterval = setInterval(async () => {
      const positions = getPositions().filter(
        (p) => p.state === "LONG_HOME" || p.state === "LONG_AWAY"
      );

      if (positions.length === 0) return;

      try {
        const markets = await fetchNbaMarkets();
        const priceMap = new Map<string, number>();
        for (const m of markets) {
          if (m.yesBid != null) priceMap.set(m.ticker, m.yesBid);
        }

        for (const pos of positions) {
          if (!pos.ticker) continue;
          const currentBid = priceMap.get(pos.ticker);
          if (currentBid == null) continue;

          await this.checkExit(pos, currentBid);
        }
      } catch {
        // Silently skip — will retry next cycle
      }
    }, 4_000);
  }

  stopExitMonitor(): void {
    if (this.exitMonitorInterval) {
      clearInterval(this.exitMonitorInterval);
      this.exitMonitorInterval = null;
    }
  }

  /**
   * Check if TP or SL is hit for a position.
   */
  private async checkExit(
    position: AutopilotPosition,
    currentBid: number
  ): Promise<void> {
    const { take_profit_price, stop_loss_price } = position;

    if (take_profit_price != null && currentBid >= take_profit_price) {
      await this.executeExit(position, currentBid, "TP");
    } else if (stop_loss_price != null && currentBid <= stop_loss_price) {
      await this.executeExit(position, currentBid, "SL");
    }
  }

  /**
   * Execute an exit: place sell order, update position state.
   */
  async executeExit(
    position: AutopilotPosition,
    exitPrice: number,
    reason: "TP" | "SL" | "MANUAL"
  ): Promise<void> {
    const { event_id, ticker, quantity, entry_price, home_team, away_team } = position;
    const gameLabel = `${away_team}@${home_team}`;

    if (!ticker || !quantity || quantity <= 0) return;

    // Set state to EXITING first (prevents double-exit)
    await this.updatePosition(event_id, { state: "EXITING" });

    const reasonLabel = reason === "TP" ? "TAKE PROFIT" : reason === "SL" ? "STOP LOSS" : "MANUAL EXIT";
    this.onLog("EXIT", `${gameLabel}: ${reasonLabel} triggered at ${(exitPrice * 100).toFixed(0)}c`, event_id);

    try {
      const result = await sellOrder(
        ticker,
        "yes",
        quantity,
        exitPrice.toFixed(2)
      );

      const fillCount = result.fillCount ?? 0;

      if (fillCount > 0) {
        const realizedPnl = entry_price
          ? (exitPrice - entry_price) * fillCount
          : null;

        const settings = await this.fetchSettings();
        const cooldown = settings?.cooldown_seconds ?? 60;
        const cooldownUntil = new Date(
          Date.now() + cooldown * 1000
        ).toISOString();

        await this.updatePosition(event_id, {
          state: "LOCKED",
          exit_price: exitPrice,
          exit_timestamp: new Date().toISOString(),
          realized_pnl: realizedPnl ? Math.round(realizedPnl * 100) / 100 : null,
          cooldown_until: cooldownUntil,
        });

        const pnlStr = realizedPnl != null
          ? `${realizedPnl >= 0 ? "+" : ""}$${realizedPnl.toFixed(2)}`
          : "unknown";

        this.onLog(
          "EXIT",
          `${gameLabel}: ${reasonLabel} FILLED — sold x${fillCount} @ ${(exitPrice * 100).toFixed(0)}c (P&L: ${pnlStr})`,
          event_id,
          { exitPrice, fillCount, realizedPnl, reason }
        );

        this.writeLog(
          "EXIT",
          `${reasonLabel} FILLED: sold x${fillCount} @ ${(exitPrice * 100).toFixed(0)}c, P&L: ${pnlStr}`,
          event_id,
          { exitPrice, fillCount, realizedPnl, reason }
        );
      } else {
        // Sell order didn't fill — go back to LONG to retry next cycle
        const prevState = position.state;
        await this.updatePosition(event_id, {
          state: prevState === "EXITING"
            ? (position.side === "HOME" ? "LONG_HOME" : "LONG_AWAY")
            : prevState,
        });

        this.onLog("INFO", `${gameLabel}: Sell order got no fills — will retry`, event_id);
      }
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      // Go back to LONG to retry next cycle
      await this.updatePosition(event_id, {
        state: position.side === "HOME" ? "LONG_HOME" : "LONG_AWAY",
      });

      this.onLog("INFO", `${gameLabel}: Sell order failed — ${errMsg}`, event_id);
    }
  }

  /**
   * Manual exit triggered by user clicking EXIT button.
   */
  async manualExit(position: AutopilotPosition): Promise<void> {
    if (!position.ticker) return;

    // Fetch current market price
    try {
      const markets = await fetchNbaMarkets();
      const market = markets.find((m) => m.ticker === position.ticker);
      const currentBid = market?.yesBid;

      if (currentBid == null) {
        this.onLog("INFO", `Could not get current price for ${position.ticker}`, position.event_id);
        return;
      }

      await this.executeExit(position, currentBid, "MANUAL");
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      this.onLog("INFO", `Manual exit failed: ${errMsg}`, position.event_id);
    }
  }

  /**
   * Update a position row in Supabase.
   */
  private async updatePosition(
    eventId: string,
    data: Partial<AutopilotPosition>
  ): Promise<void> {
    try {
      await supabase
        .from("autopilot_positions")
        .update({ ...data, updated_at: new Date().toISOString() })
        .eq("user_id", this.userId)
        .eq("event_id", eventId);
    } catch (e) {
      console.error("Failed to update position:", e);
    }
  }

  /**
   * Fetch user settings from Supabase.
   */
  private async fetchSettings(): Promise<AutopilotSettingsV2 | null> {
    try {
      const { data } = await supabase
        .from("autopilot_settings")
        .select("*")
        .eq("user_id", this.userId)
        .limit(1)
        .single();
      return data as AutopilotSettingsV2 | null;
    } catch {
      return null;
    }
  }

  /**
   * Write a log entry to Supabase (persistent).
   */
  private async writeLog(
    level: string,
    message: string,
    eventId?: string,
    metadata?: Record<string, unknown>
  ): Promise<void> {
    try {
      await supabase.from("autopilot_logs").insert({
        user_id: this.userId,
        level,
        message,
        event_id: eventId ?? null,
        metadata: metadata ?? null,
      });
    } catch {
      // Silently skip — log failure shouldn't break execution
    }
  }

  dispose(): void {
    this.stopExitMonitor();
  }
}
