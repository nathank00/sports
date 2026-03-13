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

/** How often to sync Kalshi positions with Supabase (ms). */
const POSITION_SYNC_INTERVAL = 15_000;

export class AutopilotPositionManager {
  private userId: string;
  private onLog: LogCallback;
  private processingIntents = new Set<string>(); // event_ids being processed
  private processingGames = new Set<string>(); // game-level lock (event prefix, e.g. "KXNBAGAME-26MAR12OKCBOS")
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private isSyncing = false;

  constructor(userId: string, onLog: LogCallback) {
    this.userId = userId;
    this.onLog = onLog;
    this.startSync();
  }

  /**
   * Start the periodic Kalshi → Supabase position sync.
   * Every 15 seconds, fetches actual Kalshi positions and reconciles
   * with Supabase state. Catches drift from failed state updates,
   * untracked fills, or any other desync.
   */
  private startSync(): void {
    // Run once immediately (after a short delay to let the dashboard load)
    setTimeout(() => this.syncPositions(), 3000);

    this.syncTimer = setInterval(() => this.syncPositions(), POSITION_SYNC_INTERVAL);
  }

  /**
   * Fetch Kalshi portfolio + Supabase position states, reconcile any drift.
   *
   * Cases handled:
   * 1. Kalshi has a position, Supabase says FLAT → sync to LONG (untracked fill)
   * 2. Supabase says LONG, Kalshi has 0 contracts → sync to FLAT (untracked exit)
   * 3. Supabase quantity doesn't match Kalshi → update quantity
   */
  private async syncPositions(): Promise<void> {
    if (this.isSyncing) return; // skip if previous sync still running
    this.isSyncing = true;

    try {
      // Fetch both sources in parallel
      const [kalshiPositions, supabaseResult] = await Promise.all([
        fetchPositions(),
        supabase
          .from("autopilot_positions")
          .select("*")
          .eq("user_id", this.userId),
      ]);

      const supabasePositions = (supabaseResult.data ?? []) as AutopilotPosition[];

      // Filter Kalshi positions to only NBA game markets
      const nbaPositions = kalshiPositions.filter(
        (p) => p.ticker.startsWith("KXNBAGAME") && p.position > 0
      );

      // Build a map of event_prefix → kalshi position for quick lookup
      const kalshiByPrefix = new Map<string, typeof nbaPositions[0]>();
      for (const kp of nbaPositions) {
        const prefix = kp.ticker.substring(0, kp.ticker.lastIndexOf("-"));
        // If multiple tickers on same game, keep the one with more contracts
        const existing = kalshiByPrefix.get(prefix);
        if (!existing || kp.position > existing.position) {
          kalshiByPrefix.set(prefix, kp);
        }
      }

      // Check each Supabase position against Kalshi reality
      for (const sp of supabasePositions) {
        const isLong = sp.state === "LONG_HOME" || sp.state === "LONG_AWAY";
        const isTransitioning = ["PENDING_ENTRY", "PENDING_EXIT", "EXITING"].includes(sp.state);

        // Skip positions that are actively being processed — don't interfere
        if (this.processingIntents.has(sp.event_id)) continue;
        if (isTransitioning) continue;

        if (isLong && sp.ticker) {
          // Case: Supabase says LONG — verify Kalshi still has the position
          const prefix = sp.ticker.substring(0, sp.ticker.lastIndexOf("-"));
          const kalshiPos = kalshiByPrefix.get(prefix);

          if (!kalshiPos || kalshiPos.position === 0) {
            // Kalshi has no position, but Supabase says LONG → untracked exit
            console.warn(
              `[Autopilot Sync] Supabase says ${sp.state} on ${sp.ticker} but Kalshi shows no position. Syncing to LOCKED.`
            );
            this.onLog(
              "INFO",
              `SYNC: ${sp.home_team}/${sp.away_team} — Supabase says ${sp.state} but Kalshi has no position. Marking LOCKED.`,
              sp.event_id
            );
            this.writeLog(
              "INFO",
              `Position sync: ${sp.state} on ${sp.ticker} but Kalshi shows 0 contracts. Auto-locking.`,
              sp.event_id,
              { previousState: sp.state, ticker: sp.ticker }
            );
            await this.updatePosition(sp.event_id, {
              state: "LOCKED",
              exit_timestamp: new Date().toISOString(),
              cooldown_until: new Date(Date.now() + ENTRY_FAILURE_COOLDOWN * 1000).toISOString(),
            });
          } else if (kalshiPos.ticker === sp.ticker && kalshiPos.position !== sp.quantity) {
            // Quantity mismatch — update Supabase to match Kalshi
            console.warn(
              `[Autopilot Sync] Quantity mismatch: Supabase says ${sp.quantity} on ${sp.ticker}, Kalshi says ${kalshiPos.position}`
            );
            this.writeLog(
              "INFO",
              `Position sync: quantity mismatch on ${sp.ticker} — Supabase: ${sp.quantity}, Kalshi: ${kalshiPos.position}. Updating.`,
              sp.event_id,
              { supabaseQty: sp.quantity, kalshiQty: kalshiPos.position }
            );
            await this.updatePosition(sp.event_id, {
              quantity: kalshiPos.position,
            });
          }

          // Remove from map so we know it's been accounted for
          kalshiByPrefix.delete(prefix);
        } else if (sp.state === "FLAT" && sp.ticker) {
          // Case: Supabase says FLAT — check if Kalshi unexpectedly has a position
          const prefix = sp.ticker.substring(0, sp.ticker.lastIndexOf("-"));
          const kalshiPos = kalshiByPrefix.get(prefix);

          if (kalshiPos && kalshiPos.position > 0) {
            // Kalshi has a position, Supabase says FLAT → untracked fill!
            console.warn(
              `[Autopilot Sync] Supabase says FLAT but Kalshi has ${kalshiPos.position} on ${kalshiPos.ticker}. Syncing to LONG.`
            );
            this.onLog(
              "INFO",
              `SYNC: ${sp.home_team}/${sp.away_team} — found untracked Kalshi position (${kalshiPos.ticker} x${kalshiPos.position}). Syncing.`,
              sp.event_id
            );
            this.writeLog(
              "TRADE",
              `Position sync: untracked Kalshi position found! ${kalshiPos.ticker} x${kalshiPos.position}. Syncing to LONG.`,
              sp.event_id,
              { ticker: kalshiPos.ticker, contracts: kalshiPos.position }
            );

            // Determine which side based on ticker
            const teamSuffix = kalshiPos.ticker.substring(kalshiPos.ticker.lastIndexOf("-") + 1);
            const isHome = teamSuffix.length === 3 && sp.home_team?.toUpperCase().startsWith(teamSuffix);
            const longState = isHome ? "LONG_HOME" : "LONG_AWAY";
            const sideValue = isHome ? "HOME" : "AWAY";

            await this.updatePosition(sp.event_id, {
              state: longState as "LONG_HOME" | "LONG_AWAY",
              side: sideValue as "HOME" | "AWAY",
              ticker: kalshiPos.ticker,
              quantity: kalshiPos.position,
              entry_timestamp: new Date().toISOString(),
              intent_price: null,
              intent_contracts: null,
              intent_side: null,
              intent_created_at: null,
            });

            kalshiByPrefix.delete(prefix);
          }
        }
      }

      // Any remaining Kalshi positions that weren't matched to a Supabase row
      // are truly untracked — log them so the user sees them
      for (const [prefix, kp] of kalshiByPrefix) {
        console.warn(
          `[Autopilot Sync] Kalshi position ${kp.ticker} x${kp.position} has no matching Supabase row (prefix: ${prefix})`
        );
        this.onLog(
          "INFO",
          `SYNC WARNING: Kalshi position ${kp.ticker} x${kp.position} has no matching Supabase position record.`
        );
      }
    } catch (e) {
      // Sync failures are non-fatal — just log and try again next interval
      const errMsg = e instanceof Error ? e.message : String(e);
      console.warn(`[Autopilot Sync] Failed: ${errMsg}`);
    } finally {
      this.isSyncing = false;
    }
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

    // ── GAME-LEVEL LOCK: Block concurrent entries on the same game ──
    // Prevents race condition where two entries (e.g. OKC and BOS on the
    // same game) both pass the pre-flight positions check before either fills.
    const eventPrefix = ticker.substring(0, ticker.lastIndexOf("-"));
    if (this.processingGames.has(eventPrefix)) {
      this.onLog("INFO", `${gameLabel}: BLOCKED — already processing an entry for this game`, event_id);
      this.writeLog("BLOCKED", `Game-level lock: already processing entry for ${eventPrefix}`, event_id, { ticker, eventPrefix });
      return;
    }
    this.processingGames.add(eventPrefix);

    try {
      await this.executeEntryInner(position, eventPrefix);
    } finally {
      this.processingGames.delete(eventPrefix);
    }
  }

  /**
   * Inner entry execution — runs under the game-level lock.
   */
  private async executeEntryInner(position: AutopilotPosition, eventPrefix: string): Promise<void> {
    const { event_id, home_team, away_team, side } = position;
    const ticker = position.ticker!;
    const intentPrice = position.intent_price!;
    const intentContracts = position.intent_contracts!;

    const gameLabel = `${away_team}@${home_team}`;
    const sideLabel = side ?? "UNKNOWN";
    this.onLog("INFO", `${gameLabel}: Executing ${sideLabel} entry — ${ticker} x${intentContracts}`, event_id);
    this.writeLog("INFO", `Executing ${sideLabel} entry: ${ticker} x${intentContracts}`, event_id);

    // ── PRE-FLIGHT SAFETY GATE ──────────────────────────────────────────
    // Before placing ANY buy order, verify we don't already own contracts
    // on either side of this game. This is the HARD safety gate:
    //   - If Kalshi API works → check actual portfolio
    //   - If Kalshi API fails → BLOCK the order (never proceed blind)
    //   - Also check Supabase state as belt-and-suspenders backup

    // Gate 1: Check Supabase for any non-FLAT position on this game
    try {
      const { data: existingPositions } = await supabase
        .from("autopilot_positions")
        .select("state, side, ticker, quantity, event_id")
        .eq("user_id", this.userId)
        .eq("game_id", position.game_id)
        .not("state", "in", '("FLAT")');

      const activePos = existingPositions?.find(
        (p) => p.event_id !== event_id &&
               ["LONG_HOME", "LONG_AWAY", "PENDING_ENTRY", "EXITING", "PENDING_EXIT"].includes(p.state)
      );

      if (activePos) {
        this.onLog(
          "INFO",
          `${gameLabel}: BLOCKED — Supabase shows active position (${activePos.state}) on event ${activePos.event_id}`,
          event_id
        );
        this.writeLog(
          "BLOCKED",
          `Supabase state check: active ${activePos.state} position exists on ${activePos.ticker ?? activePos.event_id}. Refusing duplicate entry.`,
          event_id,
          { activeState: activePos.state, activeTicker: activePos.ticker, activeEventId: activePos.event_id }
        );
        await this.resetToFlatWithCooldown(event_id);
        return;
      }
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      this.onLog("INFO", `${gameLabel}: BLOCKED — Supabase state check failed: ${errMsg}`, event_id);
      this.writeLog("BLOCKED", `Cannot verify Supabase positions — refusing to place order: ${errMsg}`, event_id);
      return;
    }

    // Gate 2: Check actual Kalshi portfolio for owned contracts on this game
    try {
      const kalshiPositions = await fetchPositions();
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
      // CRITICAL: If we can't verify positions on Kalshi, we MUST NOT proceed.
      // Placing an order without knowing our current state risks duplicates/hedges.
      const errMsg = e instanceof Error ? e.message : String(e);
      this.onLog("INFO", `${gameLabel}: BLOCKED — cannot verify Kalshi positions: ${errMsg}`, event_id);
      this.writeLog("BLOCKED", `Cannot verify Kalshi positions — refusing to place order: ${errMsg}`, event_id);
      return;
    }

    // Fetch fresh Kalshi price
    let freshPrice = intentPrice;
    try {
      const markets = await fetchNbaMarkets();
      const market = markets.find((m) => m.ticker === ticker);
      if (market?.yesAsk != null) {
        freshPrice = market.yesAsk;
        this.onLog(
          "INFO",
          `${gameLabel}: Fresh ask ${(freshPrice * 100).toFixed(0)}c (intent was ${(intentPrice * 100).toFixed(0)}c)`,
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
        intentContracts,
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
          await this.handleEntryFill(event_id, sideLabel, ticker, intentPrice, ownedContracts, gameLabel);
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
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
  }
}
