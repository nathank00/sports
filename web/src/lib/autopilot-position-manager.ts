/**
 * Frontend Position Manager — executes trade intents from the backend.
 *
 * Subscribes to position state changes from Supabase:
 * - PENDING_ENTRY → execute buy order with browser-stored Kalshi keys
 * - PENDING_EXIT → execute sell order (auto-exit from TP/SL/late-game)
 * - LONG_HOME/LONG_AWAY → held position (manual exit available)
 * - EXITING → sell order in progress
 * - LOCKED → done, no action
 *
 * All Kalshi keys stay in the browser. The backend decides when to enter
 * and exit; this module handles the actual execution.
 */

import { supabase } from "@/lib/supabase";
import {
  placeOrder,
  sellOrder,
  fetchNbaMarkets,
  fetchPositions,
  getOrder,
  cancelOrder,
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

    // Handle auto-exit intents from backend (TP/SL/late-game)
    if (position.state === "PENDING_EXIT") {
      if (this.processingIntents.has(position.event_id)) return;
      this.processingIntents.add(position.event_id);
      try {
        await this.executeAutoExit(position);
      } finally {
        this.processingIntents.delete(position.event_id);
      }
    }
  }

  /**
   * Execute a buy order from a PENDING_ENTRY intent.
   *
   * CRITICAL FIX: After placing a limit order, the initial API response may
   * show fill_count=0 even though the order fills moments later within its
   * 30-second expiration. We now:
   *   1. Place the order
   *   2. If immediate fills → update to LONG (fast path)
   *   3. If 0 fills → wait 3s → re-check order status via getOrder()
   *   4. If filled on re-check → update to LONG
   *   5. If still unfilled → cancelOrder() → reset to FLAT
   *
   * This prevents the system from resetting to FLAT while a resting order
   * fills on Kalshi, which caused untracked position accumulation.
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
        this.writeLog("INFO", `Intent expired (${Math.round(intentAge / 1000)}s old)`, event_id);
        await this.resetToFlatWithCooldown(event_id);
        return;
      }
    }

    if (!ticker || !intent_price || !intent_contracts) {
      this.onLog("INFO", `${gameLabel}: Invalid intent data (ticker=${ticker}, price=${intent_price}, contracts=${intent_contracts})`, event_id);
      this.writeLog("INFO", `Invalid intent data — skipping`, event_id);
      return;
    }

    const sideLabel = side ?? "UNKNOWN";
    this.onLog("INFO", `${gameLabel}: Executing ${sideLabel} entry — ${ticker} x${intent_contracts}`, event_id);
    this.writeLog("INFO", `Executing ${sideLabel} entry: ${ticker} x${intent_contracts}`, event_id);

    // ── PRE-FLIGHT: Check Kalshi portfolio for existing positions on this game ──
    // This is the hard safety gate. Before placing ANY buy order, verify
    // we don't already own contracts on either side of this game.
    try {
      const kalshiPositions = await fetchPositions();
      // Extract event prefix from ticker (e.g. "KXNBAGAME-26MAR12MILMIA" from
      // "KXNBAGAME-26MAR12MILMIA-MIA") to catch both sides of the same game
      const eventPrefix = ticker.substring(0, ticker.lastIndexOf("-"));
      const existingPos = kalshiPositions.find(
        (p) => p.position > 0 && p.ticker.startsWith(eventPrefix)
      );

      if (existingPos) {
        this.onLog(
          "INFO",
          `${gameLabel}: BLOCKED — already own ${existingPos.position} contract(s) on ${existingPos.ticker}`,
          event_id
        );
        this.writeLog(
          "BLOCKED",
          `PRE-FLIGHT BLOCKED: Already hold ${existingPos.position} contract(s) on ${existingPos.ticker}. Refusing to place duplicate/hedge order.`,
          event_id,
          {
            existingTicker: existingPos.ticker,
            existingContracts: existingPos.position,
            attemptedTicker: ticker,
          }
        );

        // Sync Supabase state to reflect the real Kalshi position
        const existingSide = existingPos.ticker === ticker
          ? sideLabel
          : sideLabel === "HOME" ? "AWAY" : "HOME";
        const existingState = existingSide === "HOME" ? "LONG_HOME" : "LONG_AWAY";

        await this.updatePosition(event_id, {
          state: existingState as "LONG_HOME" | "LONG_AWAY",
          side: existingSide as "HOME" | "AWAY",
          ticker: existingPos.ticker,
          quantity: existingPos.position,
          entry_timestamp: new Date().toISOString(),
          intent_price: null,
          intent_contracts: null,
          intent_side: null,
          intent_created_at: null,
        });

        this.onLog("INFO", `${gameLabel}: Synced position to ${existingState} (${existingPos.ticker} x${existingPos.position})`, event_id);
        this.writeLog("INFO", `Position synced from Kalshi: ${existingState} ${existingPos.ticker} x${existingPos.position}`, event_id);
        return;
      }
    } catch (e) {
      // If positions check fails, log but proceed — don't silently block a valid trade
      const errMsg = e instanceof Error ? e.message : String(e);
      this.onLog("INFO", `${gameLabel}: Pre-flight positions check failed: ${errMsg} — proceeding`, event_id);
      this.writeLog("INFO", `Pre-flight positions check failed: ${errMsg}`, event_id);
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
    let orderId: string | null = null;
    try {
      const result = await placeOrder(
        ticker,
        "yes",
        intent_contracts,
        freshPrice.toFixed(2),
        "buy"
      );

      orderId = result.orderId;
      this.onLog("INFO", `${gameLabel}: Order placed (${orderId})`, event_id);
      this.writeLog("INFO", `Order placed (${orderId}) @ ${(freshPrice * 100).toFixed(0)}c`, event_id, { orderId, freshPrice });

      // Wait 3s for the order to potentially fill
      this.onLog("INFO", `${gameLabel}: Waiting 3s for fill...`, event_id);
      await new Promise((r) => setTimeout(r, 3000));

      // Cancel any resting remainder before checking positions
      await this.safeCancelOrder(orderId, gameLabel, event_id);

      // Source of truth: check what we actually own on Kalshi
      const ownedContracts = await this.getOwnedContracts(ticker);

      this.onLog(
        "INFO",
        `${gameLabel}: Post-order position check — own ${ownedContracts} contract(s) on ${ticker}`,
        event_id
      );
      this.writeLog(
        "INFO",
        `Post-order position check: ${ownedContracts} contract(s) on ${ticker}`,
        event_id,
        { orderId, ticker, ownedContracts }
      );

      if (ownedContracts > 0) {
        await this.handleEntryFill(event_id, sideLabel, ticker, freshPrice, ownedContracts, gameLabel);
      } else {
        await this.resetToFlatWithCooldown(event_id);
        this.onLog("INFO", `${gameLabel}: No position after order — cooldown applied`, event_id);
        this.writeLog("INFO", "No position found after order — cooldown applied", event_id, { orderId });
      }
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      this.onLog("INFO", `${gameLabel}: Order failed — ${errMsg}`, event_id);
      this.writeLog("INFO", `Entry order failed: ${errMsg}`, event_id);

      // If we got an orderId, try to cancel
      if (orderId) {
        await this.safeCancelOrder(orderId, gameLabel, event_id);
      }

      // Check if we accidentally own contracts despite the error
      try {
        const ownedContracts = await this.getOwnedContracts(ticker);
        if (ownedContracts > 0) {
          this.onLog("INFO", `${gameLabel}: Order errored but we own ${ownedContracts} contract(s) — recording fill`, event_id);
          this.writeLog("INFO", `Order errored but position exists: ${ownedContracts} contract(s)`, event_id);
          await this.handleEntryFill(event_id, sideLabel, ticker, intent_price, ownedContracts, gameLabel);
          return;
        }
      } catch {
        // Can't check — fall through to reset
      }

      await this.resetToFlatWithCooldown(event_id);
    }
  }

  /**
   * Handle a confirmed entry fill — update position to LONG.
   * This is the critical state transition: if this fails, we have
   * contracts on Kalshi that the system doesn't know about.
   */
  private async handleEntryFill(
    eventId: string,
    side: string,
    ticker: string,
    entryPrice: number,
    fillCount: number,
    gameLabel: string
  ): Promise<void> {
    const newState = side === "HOME" ? "LONG_HOME" : "LONG_AWAY";

    // CRITICAL: This update MUST succeed. Retry aggressively.
    const success = await this.updatePosition(eventId, {
      state: newState as "LONG_HOME" | "LONG_AWAY",
      entry_price: entryPrice,
      quantity: fillCount,
      entry_timestamp: new Date().toISOString(),
      intent_price: null,
      intent_contracts: null,
      intent_side: null,
      intent_created_at: null,
    });

    if (!success) {
      // updatePosition already retried once internally.
      // Try one more time after a longer delay.
      await new Promise((r) => setTimeout(r, 2000));
      const retrySuccess = await this.updatePosition(eventId, {
        state: newState as "LONG_HOME" | "LONG_AWAY",
        entry_price: entryPrice,
        quantity: fillCount,
        entry_timestamp: new Date().toISOString(),
        intent_price: null,
        intent_contracts: null,
        intent_side: null,
        intent_created_at: null,
      });

      if (!retrySuccess) {
        // All retries failed — this is a crisis. Log everywhere possible.
        const msg =
          `CRITICAL STATE DESYNC: Filled ${side} x${fillCount} @ ${(entryPrice * 100).toFixed(0)}c ` +
          `on ${ticker} but FAILED to update position to ${newState}. ` +
          `Kalshi has the position, Supabase does NOT. Manual intervention required.`;
        this.onLog("ERROR", `${gameLabel}: ${msg}`, eventId);
        this.writeLog("ERROR", msg, eventId, { ticker, fillCount, entryPrice, newState });
        console.error(`[AUTOPILOT CRITICAL] ${msg}`);
        return;
      }
    }

    this.onLog(
      "TRADE",
      `${gameLabel}: FILLED ${side} YES x${fillCount} @ ${(entryPrice * 100).toFixed(0)}c`,
      eventId,
      { ticker, fillCount, entryPrice }
    );

    this.writeLog(
      "TRADE",
      `ENTRY FILLED: ${side} YES x${fillCount} @ ${(entryPrice * 100).toFixed(0)}c`,
      eventId,
      { ticker, fillCount, entryPrice }
    );
  }

  /**
   * Safely cancel a resting order, then re-check fill count.
   *
   * CRITICAL: An order can fill in the tiny window between getOrder()
   * and cancelOrder(). After cancelling, we MUST re-check the order
   * to see if any fills snuck in. Returns the final fill count.
   */
  private async safeCancelOrder(
    orderId: string,
    gameLabel: string,
    eventId: string
  ): Promise<number> {
    try {
      await cancelOrder(orderId);
      this.onLog("INFO", `${gameLabel}: Cancelled resting order ${orderId}`, eventId);
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      // "not_found" or "already cancelled" is expected if order expired or fully filled
      if (errMsg.includes("not_found") || errMsg.includes("cancel") || errMsg.includes("404")) {
        this.onLog("INFO", `${gameLabel}: Order ${orderId} already expired/cancelled`, eventId);
      } else {
        this.onLog("INFO", `${gameLabel}: Failed to cancel order ${orderId}: ${errMsg}`, eventId);
        this.writeLog("INFO", `Failed to cancel resting order: ${errMsg}`, eventId, { orderId });
      }
    }

    // Re-check order after cancel to catch race-condition fills
    try {
      const finalStatus = await getOrder(orderId);
      const finalFills = finalStatus.fillCount ?? 0;
      if (finalFills > 0) {
        this.onLog(
          "INFO",
          `${gameLabel}: Post-cancel check — order ${orderId} actually has ${finalFills} fill(s)! (status: ${finalStatus.status})`,
          eventId
        );
        this.writeLog(
          "INFO",
          `Post-cancel re-check: order ${orderId} has ${finalFills} fill(s) (status: ${finalStatus.status})`,
          eventId,
          { orderId, finalFills, status: finalStatus.status }
        );
      }
      return finalFills;
    } catch {
      // If we can't re-check, return 0 — conservative fallback
      return 0;
    }
  }

  /**
   * Check how many contracts we actually own on a specific ticker.
   * This is the source of truth — Kalshi's portfolio endpoint.
   */
  private async getOwnedContracts(ticker: string): Promise<number> {
    const positions = await fetchPositions();
    const pos = positions.find((p) => p.ticker === ticker);
    return pos && pos.position > 0 ? pos.position : 0;
  }

  /**
   * Execute an auto-exit from a PENDING_EXIT intent (TP/SL/late-game).
   *
   * Uses the same wait-and-verify pattern as executeEntry to prevent
   * the system from thinking a sell didn't fill when it actually did.
   */
  private async executeAutoExit(position: AutopilotPosition): Promise<void> {
    const {
      event_id,
      ticker,
      quantity,
      entry_price,
      intent_price,
      intent_created_at,
      home_team,
      away_team,
      side,
    } = position;

    const gameLabel = `${away_team}@${home_team}`;
    const longState = side === "HOME" ? "LONG_HOME" : "LONG_AWAY";

    // Validate intent hasn't expired
    if (intent_created_at) {
      const intentAge = Date.now() - new Date(intent_created_at).getTime();
      if (intentAge > 35_000) {
        this.onLog("INFO", `${gameLabel}: Exit intent expired (${Math.round(intentAge / 1000)}s old)`, event_id);
        this.writeLog("INFO", `Exit intent expired (${Math.round(intentAge / 1000)}s old)`, event_id);
        // Restore to LONG so backend can retry
        await this.updatePosition(event_id, {
          state: longState,
          intent_price: null,
          intent_contracts: null,
          intent_side: null,
          intent_created_at: null,
        });
        return;
      }
    }

    if (!ticker || !quantity || quantity <= 0) return;

    this.onLog("INFO", `${gameLabel}: Executing auto-exit — selling ${ticker} x${quantity}`, event_id);
    this.writeLog("INFO", `Executing auto-exit: selling ${ticker} x${quantity}`, event_id);

    // Fetch fresh bid price for exit
    let exitPrice = intent_price || 0;
    try {
      const markets = await fetchNbaMarkets();
      const market = markets.find((m) => m.ticker === ticker);
      if (market?.yesBid != null) {
        exitPrice = market.yesBid;
        this.onLog(
          "INFO",
          `${gameLabel}: Fresh bid ${(exitPrice * 100).toFixed(0)}c for auto-exit`,
          event_id
        );
      }
    } catch {
      this.onLog("INFO", `${gameLabel}: Using intent exit price`, event_id);
    }

    // Set state to EXITING (prevents double-exit)
    await this.updatePosition(event_id, { state: "EXITING" });

    let orderId: string | null = null;
    try {
      const result = await sellOrder(
        ticker,
        "yes",
        quantity,
        exitPrice.toFixed(2)
      );

      orderId = result.orderId;
      this.onLog("INFO", `${gameLabel}: Exit order placed (${orderId})`, event_id);
      this.writeLog("INFO", `Exit order placed (${orderId}) @ ${(exitPrice * 100).toFixed(0)}c`, event_id, { orderId, exitPrice });

      // Wait 3s for fill
      this.onLog("INFO", `${gameLabel}: Waiting 3s for exit fill...`, event_id);
      await new Promise((r) => setTimeout(r, 3000));

      // Cancel any resting remainder
      await this.safeCancelOrder(orderId, gameLabel, event_id);

      // Source of truth: check what we still own
      const remaining = await this.getOwnedContracts(ticker);
      const sold = quantity - remaining;

      this.onLog("INFO", `${gameLabel}: Post-exit check — still own ${remaining}, sold ${sold}`, event_id);
      this.writeLog("INFO", `Post-exit position check: own ${remaining}, sold ${sold}`, event_id, { orderId, remaining, sold });

      if (sold > 0) {
        await this.handleExitFill(event_id, ticker, exitPrice, sold, entry_price, gameLabel);
      } else {
        // Nothing sold — restore to LONG, backend will retry
        await this.updatePosition(event_id, {
          state: longState,
          intent_price: null,
          intent_contracts: null,
          intent_side: null,
          intent_created_at: null,
        });
        this.onLog("INFO", `${gameLabel}: Auto exit no fills — will retry`, event_id);
        this.writeLog("INFO", "Auto exit no fills — will retry", event_id, { orderId });
      }
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      if (orderId) {
        await this.safeCancelOrder(orderId, gameLabel, event_id);
      }
      // Restore to LONG, backend will retry
      await this.updatePosition(event_id, {
        state: longState,
        intent_price: null,
        intent_contracts: null,
        intent_side: null,
        intent_created_at: null,
      });
      this.onLog("INFO", `${gameLabel}: Auto exit failed — ${errMsg}`, event_id);
      this.writeLog("INFO", `Auto exit order failed: ${errMsg}`, event_id);
    }
  }

  /**
   * Handle a confirmed exit fill — update position to LOCKED.
   */
  private async handleExitFill(
    eventId: string,
    ticker: string,
    exitPrice: number,
    fillCount: number,
    entryPrice: number | null,
    gameLabel: string
  ): Promise<void> {
    const realizedPnl = entryPrice
      ? (exitPrice - entryPrice) * fillCount
      : null;

    const cooldownUntil = new Date(
      Date.now() + ENTRY_FAILURE_COOLDOWN * 1000
    ).toISOString();

    const success = await this.updatePosition(eventId, {
      state: "LOCKED",
      exit_price: exitPrice,
      exit_timestamp: new Date().toISOString(),
      realized_pnl: realizedPnl ? Math.round(realizedPnl * 100) / 100 : null,
      cooldown_until: cooldownUntil,
      intent_price: null,
      intent_contracts: null,
      intent_side: null,
      intent_created_at: null,
    });

    if (!success) {
      // Retry after delay
      await new Promise((r) => setTimeout(r, 2000));
      await this.updatePosition(eventId, {
        state: "LOCKED",
        exit_price: exitPrice,
        exit_timestamp: new Date().toISOString(),
        realized_pnl: realizedPnl ? Math.round(realizedPnl * 100) / 100 : null,
        cooldown_until: cooldownUntil,
        intent_price: null,
        intent_contracts: null,
        intent_side: null,
        intent_created_at: null,
      });
    }

    const pnlStr = realizedPnl != null
      ? `${realizedPnl >= 0 ? "+" : ""}$${realizedPnl.toFixed(2)}`
      : "unknown";

    this.onLog(
      "EXIT",
      `${gameLabel}: EXIT FILLED — sold x${fillCount} @ ${(exitPrice * 100).toFixed(0)}c (P&L: ${pnlStr})`,
      eventId,
      { exitPrice, fillCount, realizedPnl, reason: "AUTO" }
    );

    this.writeLog(
      "EXIT",
      `EXIT FILLED: sold x${fillCount} @ ${(exitPrice * 100).toFixed(0)}c, P&L: ${pnlStr}`,
      eventId,
      { exitPrice, fillCount, realizedPnl, reason: "AUTO", ticker }
    );
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
   * Uses wait-and-verify pattern to prevent phantom unfilled exits.
   */
  async executeExit(
    position: AutopilotPosition,
    exitPrice: number,
    reason: "MANUAL" | "AUTO_TP" | "AUTO_SL" | "AUTO_LATE_GAME"
  ): Promise<void> {
    const { event_id, ticker, quantity, entry_price, home_team, away_team } = position;
    const gameLabel = `${away_team}@${home_team}`;
    const longState = position.side === "HOME" ? "LONG_HOME" : "LONG_AWAY";

    if (!ticker || !quantity || quantity <= 0) return;

    // Set state to EXITING first (prevents double-exit)
    await this.updatePosition(event_id, { state: "EXITING" });

    this.onLog("EXIT", `${gameLabel}: ${reason} EXIT triggered at ${(exitPrice * 100).toFixed(0)}c`, event_id);
    this.writeLog("EXIT", `${reason} EXIT triggered: selling ${ticker} x${quantity} @ ${(exitPrice * 100).toFixed(0)}c`, event_id);

    let orderId: string | null = null;
    try {
      const result = await sellOrder(
        ticker,
        "yes",
        quantity,
        exitPrice.toFixed(2)
      );

      orderId = result.orderId;
      this.writeLog("INFO", `${reason} exit order placed (${orderId}) @ ${(exitPrice * 100).toFixed(0)}c`, event_id, { orderId, exitPrice, reason });

      // Wait 3s for fill
      await new Promise((r) => setTimeout(r, 3000));

      // Cancel any resting remainder
      await this.safeCancelOrder(orderId, gameLabel, event_id);

      // Source of truth: check what we still own
      const remaining = await this.getOwnedContracts(ticker);
      const sold = quantity - remaining;

      this.writeLog("INFO", `${reason} exit check: own ${remaining}, sold ${sold}`, event_id, { orderId, remaining, sold });

      if (sold > 0) {
        await this.handleExitFill(event_id, ticker, exitPrice, sold, entry_price, gameLabel);
      } else {
        // Nothing sold — restore to LONG
        await this.updatePosition(event_id, { state: longState });
        this.onLog("INFO", `${gameLabel}: ${reason} exit no fills — will retry`, event_id);
        this.writeLog("INFO", `${reason} exit no fills — will retry`, event_id, { orderId });
      }
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      if (orderId) {
        await this.safeCancelOrder(orderId, gameLabel, event_id);
      }
      await this.updatePosition(event_id, { state: longState });
      this.onLog("INFO", `${gameLabel}: ${reason} exit failed — ${errMsg}`, event_id);
      this.writeLog("INFO", `${reason} exit order failed: ${errMsg}`, event_id);
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
   *
   * Checks the { error } response (Supabase JS client doesn't throw)
   * and retries once on failure. Returns true if successful.
   */
  private async updatePosition(
    eventId: string,
    data: Partial<AutopilotPosition>
  ): Promise<boolean> {
    const payload = { ...data, updated_at: new Date().toISOString() };

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { error } = await supabase
          .from("autopilot_positions")
          .update(payload)
          .eq("user_id", this.userId)
          .eq("event_id", eventId);

        if (!error) return true;

        console.error(
          `updatePosition failed (attempt ${attempt + 1}): ${error.message}`
        );

        // On first failure, wait 500ms then retry
        if (attempt === 0) {
          await new Promise((r) => setTimeout(r, 500));
        }
      } catch (e) {
        console.error(
          `updatePosition exception (attempt ${attempt + 1}):`,
          e
        );
        if (attempt === 0) {
          await new Promise((r) => setTimeout(r, 500));
        }
      }
    }

    // Both attempts failed — write an error log so it's visible in the UI
    this.writeLog(
      "ERROR",
      `CRITICAL: Failed to update position state for event ${eventId}. ` +
        `Attempted: ${JSON.stringify(data)}. ` +
        `Position may be out of sync with Kalshi.`,
      eventId
    );

    return false;
  }

  /**
   * Write a log entry to Supabase (persistent, visible in UI LOGS tab).
   *
   * Checks { error } and retries once. Log failures are reported to
   * console but never throw — they must not break trade execution.
   */
  private async writeLog(
    level: string,
    message: string,
    eventId?: string,
    metadata?: Record<string, unknown>
  ): Promise<void> {
    const row = {
      user_id: this.userId,
      level,
      message,
      event_id: eventId ?? null,
      metadata: metadata ?? null,
    };

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { error } = await supabase.from("autopilot_logs").insert(row);
        if (!error) return;

        console.error(
          `writeLog failed (attempt ${attempt + 1}): ${error.message}`
        );
        if (attempt === 0) {
          await new Promise((r) => setTimeout(r, 300));
        }
      } catch (e) {
        console.error(`writeLog exception (attempt ${attempt + 1}):`, e);
        if (attempt === 0) {
          await new Promise((r) => setTimeout(r, 300));
        }
      }
    }
  }

  dispose(): void {
    // No-op — no background tasks to clean up
  }
}
