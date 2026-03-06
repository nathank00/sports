/**
 * Frontend Position Manager — executes trade intents from the backend.
 *
 * Subscribes to position state changes from Supabase:
 * - PENDING_ENTRY → execute buy order with browser-stored Kalshi keys
 * - LONG_HOME/LONG_AWAY → held position (manual exit only)
 * - EXITING → sell order in progress
 * - LOCKED → done, no action
 *
 * All Kalshi keys stay in the browser. The backend decides when to enter;
 * this module handles the actual execution.
 */

import { supabase } from "@/lib/supabase";
import {
  placeOrder,
  sellOrder,
  fetchNbaMarkets,
} from "@/lib/kalshi-api";
import type { AutopilotPosition } from "@/lib/types";

/** Cooldown applied when an entry fails or gets no fills (seconds). */
const ENTRY_FAILURE_COOLDOWN = 120;

export type LogCallback = (
  level: string,
  message: string,
  eventId?: string,
  metadata?: Record<string, unknown>
) => void;

export class AutopilotPositionManager {
  private userId: string;
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
        await this.resetToFlatWithCooldown(event_id);
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
        const entryPrice = freshPrice;
        const newState = side === "HOME" ? "LONG_HOME" : "LONG_AWAY";

        await this.updatePosition(event_id, {
          state: newState,
          entry_price: entryPrice,
          quantity: fillCount,
          entry_timestamp: new Date().toISOString(),
          intent_price: null,
          intent_contracts: null,
          intent_side: null,
          intent_created_at: null,
        });

        this.onLog(
          "TRADE",
          `${gameLabel}: FILLED ${side} YES x${fillCount} @ ${(entryPrice * 100).toFixed(0)}c`,
          event_id,
          { ticker, fillCount, entryPrice }
        );

        this.writeLog(
          "TRADE",
          `ENTRY FILLED: ${side} YES x${fillCount} @ ${(entryPrice * 100).toFixed(0)}c`,
          event_id,
          { ticker, fillCount, entryPrice }
        );
      } else {
        // No fills — reset to FLAT with cooldown to prevent re-entry loop
        await this.resetToFlatWithCooldown(event_id);
        this.onLog("INFO", `${gameLabel}: Order placed but no fills — cooldown applied`, event_id);
        this.writeLog("INFO", "Entry order got no fills — cooldown applied", event_id);
      }
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      this.onLog("INFO", `${gameLabel}: Order failed — ${errMsg}`, event_id);
      this.writeLog("INFO", `Entry order failed: ${errMsg}`, event_id);

      // Reset to FLAT with cooldown to prevent re-entry loop
      await this.resetToFlatWithCooldown(event_id);
    }
  }

  /**
   * Reset position to FLAT with a cooldown to prevent the backend
   * from immediately creating another PENDING_ENTRY.
   */
  private async resetToFlatWithCooldown(eventId: string): Promise<void> {
    const cooldownUntil = new Date(
      Date.now() + ENTRY_FAILURE_COOLDOWN * 1000
    ).toISOString();

    await this.updatePosition(eventId, {
      state: "FLAT",
      side: null,
      ticker: null,
      intent_price: null,
      intent_contracts: null,
      intent_side: null,
      intent_created_at: null,
      cooldown_until: cooldownUntil,
    });
  }

  /**
   * Execute an exit: place sell order, update position state.
   */
  async executeExit(
    position: AutopilotPosition,
    exitPrice: number,
    reason: "MANUAL"
  ): Promise<void> {
    const { event_id, ticker, quantity, entry_price, home_team, away_team } = position;
    const gameLabel = `${away_team}@${home_team}`;

    if (!ticker || !quantity || quantity <= 0) return;

    // Set state to EXITING first (prevents double-exit)
    await this.updatePosition(event_id, { state: "EXITING" });

    this.onLog("EXIT", `${gameLabel}: MANUAL EXIT triggered at ${(exitPrice * 100).toFixed(0)}c`, event_id);

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

        const cooldownUntil = new Date(
          Date.now() + ENTRY_FAILURE_COOLDOWN * 1000
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
          `${gameLabel}: MANUAL EXIT FILLED — sold x${fillCount} @ ${(exitPrice * 100).toFixed(0)}c (P&L: ${pnlStr})`,
          event_id,
          { exitPrice, fillCount, realizedPnl, reason }
        );

        this.writeLog(
          "EXIT",
          `MANUAL EXIT FILLED: sold x${fillCount} @ ${(exitPrice * 100).toFixed(0)}c, P&L: ${pnlStr}`,
          event_id,
          { exitPrice, fillCount, realizedPnl, reason }
        );
      } else {
        // Sell order didn't fill — go back to LONG to retry
        await this.updatePosition(event_id, {
          state: position.side === "HOME" ? "LONG_HOME" : "LONG_AWAY",
        });

        this.onLog("INFO", `${gameLabel}: Sell order got no fills — will retry`, event_id);
      }
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      // Go back to LONG to retry
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
    // No-op — no background tasks to clean up
  }
}
