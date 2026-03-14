/**
 * Frontend Position Manager — executes trade intents from the backend.
 *
 * Flow for every order (entry or exit):
 *   1. Check Kalshi positions for existing contracts on this game
 *   2. Place the order
 *   3. Wait 10 seconds
 *   4. Cancel whatever is left
 *   5. Check what we actually own → that's the truth
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
  cancelOrder,
} from "@/lib/kalshi-api";
import type { AutopilotPosition } from "@/lib/types";

/** Cooldown applied when an entry fails or gets no fills (seconds). */
const ENTRY_FAILURE_COOLDOWN = 120;

/** How long to wait for an order to fill before cancelling (ms). */
const ORDER_WAIT_MS = 10_000;

export type LogCallback = (
  level: string,
  message: string,
  eventId?: string,
  metadata?: Record<string, unknown>
) => void;

export class AutopilotPositionManager {
  private userId: string;
  private onLog: LogCallback;
  private processingIntents = new Set<string>();
  private processingGames = new Set<string>();

  constructor(userId: string, onLog: LogCallback) {
    this.userId = userId;
    this.onLog = onLog;
  }

  // ── Public API ──────────────────────────────────────────────────────

  async handlePositionChange(position: AutopilotPosition): Promise<void> {
    if (position.user_id !== this.userId) return;

    if (position.state === "PENDING_ENTRY") {
      if (this.processingIntents.has(position.event_id)) return;
      this.processingIntents.add(position.event_id);
      try {
        await this.executeEntry(position);
      } finally {
        this.processingIntents.delete(position.event_id);
      }
    }

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

  async manualExit(position: AutopilotPosition): Promise<void> {
    if (!position.ticker) return;
    try {
      const markets = await fetchNbaMarkets();
      const market = markets.find((m) => m.ticker === position.ticker);

      // Use the HIGHER of yesBid and lastPrice to avoid selling below market value.
      // yesBid can be far below the displayed price on thin order books.
      const yesBid = market?.yesBid;
      const lastPrice = market?.lastPrice;

      let exitPrice: number | null = null;
      if (yesBid != null && lastPrice != null) {
        exitPrice = Math.max(yesBid, lastPrice);
      } else {
        exitPrice = lastPrice ?? yesBid ?? null;
      }

      if (exitPrice == null) {
        this.onLog("INFO", `Could not get current price for ${position.ticker}`, position.event_id);
        return;
      }

      this.onLog("INFO", `Manual exit: bid=${yesBid != null ? (yesBid * 100).toFixed(0) + "c" : "N/A"}, last=${lastPrice != null ? (lastPrice * 100).toFixed(0) + "c" : "N/A"}, selling @ ${(exitPrice * 100).toFixed(0)}c`, position.event_id);

      await this.executeExit(position, exitPrice, "MANUAL");
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      this.onLog("INFO", `Manual exit failed: ${errMsg}`, position.event_id);
    }
  }

  /**
   * Recover a position stuck in EXITING state.
   * Checks Kalshi for the actual holding and reconciles Supabase.
   */
  async recoverExitingPosition(position: AutopilotPosition): Promise<void> {
    const { event_id, ticker, quantity, entry_price, home_team, away_team, side } = position;
    if (!ticker) return;

    // Prevent concurrent recovery attempts
    if (this.processingIntents.has(event_id)) return;
    this.processingIntents.add(event_id);

    const gameLabel = `${away_team}@${home_team}`;
    const longState = side === "HOME" ? "LONG_HOME" : "LONG_AWAY";

    try {
      this.onLog("INFO", `${gameLabel}: Recovering stuck EXITING position...`, event_id);

      const owned = await this.getOwnedContracts(ticker);

      if (owned === 0) {
        // Exit completed on Kalshi — mark as FLAT (ready for re-entry)
        await this.updatePosition(event_id, {
          state: "FLAT",
          side: null,
          ticker: null,
          exit_timestamp: new Date().toISOString(),
          realized_pnl: null,
          cooldown_until: null,
          quantity: null,
          intent_price: null, intent_contracts: null, intent_side: null, intent_created_at: null,
        });

        this.onLog("EXIT", `${gameLabel}: Recovery — exit confirmed (0 contracts on Kalshi), marked FLAT`, event_id);
        this.writeLog("EXIT", `Recovery: EXITING → FLAT (0 contracts remaining on Kalshi)`, event_id);
      } else {
        // Still own contracts — revert to LONG
        await this.updatePosition(event_id, {
          state: longState as "LONG_HOME" | "LONG_AWAY",
          quantity: owned,
          intent_price: null, intent_contracts: null, intent_side: null, intent_created_at: null,
        });

        this.onLog("INFO", `${gameLabel}: Recovery — still own ${owned} contracts, reverted to ${longState}`, event_id);
        this.writeLog("INFO", `Recovery: EXITING → ${longState} (still own ${owned} contracts)`, event_id);
      }
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      this.onLog("INFO", `${gameLabel}: Recovery failed: ${errMsg}`, event_id);
    } finally {
      this.processingIntents.delete(event_id);
    }
  }

  dispose(): void {
    // No background tasks to clean up
  }

  // ── Entry ───────────────────────────────────────────────────────────

  private async executeEntry(position: AutopilotPosition): Promise<void> {
    const { event_id, ticker, intent_price, intent_contracts, intent_created_at, home_team, away_team, side } = position;
    const gameLabel = `${away_team}@${home_team}`;

    // Validate intent age
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
      this.onLog("INFO", `${gameLabel}: Invalid intent data`, event_id);
      this.writeLog("INFO", `Invalid intent data — skipping`, event_id);
      return;
    }

    // Game-level lock — block concurrent entries on the same game
    const eventPrefix = ticker.substring(0, ticker.lastIndexOf("-"));
    if (this.processingGames.has(eventPrefix)) {
      this.onLog("INFO", `${gameLabel}: BLOCKED — already processing entry for this game`, event_id);
      this.writeLog("BLOCKED", `Game-level lock active for ${eventPrefix}`, event_id);
      return;
    }
    this.processingGames.add(eventPrefix);

    try {
      await this.executeEntryInner(position, eventPrefix);
    } finally {
      this.processingGames.delete(eventPrefix);
    }
  }

  private async executeEntryInner(position: AutopilotPosition, eventPrefix: string): Promise<void> {
    const { event_id, home_team, away_team, side } = position;
    const ticker = position.ticker!;
    const intentPrice = position.intent_price!;
    const intentContracts = position.intent_contracts!;
    const gameLabel = `${away_team}@${home_team}`;
    const sideLabel = side ?? "UNKNOWN";

    this.onLog("INFO", `${gameLabel}: Executing ${sideLabel} entry — ${ticker} x${intentContracts}`, event_id);
    this.writeLog("INFO", `Executing ${sideLabel} entry: ${ticker} x${intentContracts}`, event_id);

    // ── PRE-FLIGHT SAFETY GATE ──────────────────────────────────────
    // Two checks. Both must pass or the order is BLOCKED.
    // If either check ERRORS, we block (never proceed blind).

    // Gate 1: Supabase — any active position on this game?
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
        this.onLog("INFO", `${gameLabel}: BLOCKED — Supabase shows active position (${activePos.state}) on event ${activePos.event_id}`, event_id);
        this.writeLog("BLOCKED", `Active ${activePos.state} position exists on ${activePos.ticker ?? activePos.event_id}`, event_id);
        await this.resetToFlatWithCooldown(event_id);
        return;
      }
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      this.onLog("INFO", `${gameLabel}: BLOCKED — Supabase check failed: ${errMsg}`, event_id);
      this.writeLog("BLOCKED", `Cannot verify Supabase positions: ${errMsg}`, event_id);
      return;
    }

    // Gate 2: Kalshi — fetch ALL positions and check for this game.
    // We call fetchPositions() twice (with 500ms gap) to guard against flaky API responses.
    try {
      let existing: { ticker: string; position: number } | null = null;

      for (let attempt = 0; attempt < 2; attempt++) {
        const allPositions = await fetchPositions();
        const activeNba = allPositions.filter((p) => p.position > 0 && p.ticker.startsWith("KX"));

        // Log what the API actually returned so we can diagnose issues
        const positionSummary = activeNba.map((p) => `${p.ticker} x${p.position}`).join(", ") || "NONE";
        this.onLog("INFO", `${gameLabel}: Kalshi positions (attempt ${attempt + 1}): [${positionSummary}]`, event_id);
        if (attempt === 0) {
          this.writeLog("INFO", `Pre-flight Kalshi positions: [${positionSummary}]`, event_id, {
            positionCount: activeNba.length,
            positions: activeNba.map((p) => ({ ticker: p.ticker, qty: p.position })),
          });
        }

        const match = activeNba.find((p) => p.ticker.startsWith(eventPrefix));
        if (match) {
          existing = { ticker: match.ticker, position: match.position };
          break;
        }

        if (attempt === 0) await new Promise((r) => setTimeout(r, 500));
      }

      if (existing) {
        this.onLog("INFO", `${gameLabel}: BLOCKED — already own ${existing.position} contract(s) on ${existing.ticker}`, event_id);
        this.writeLog("BLOCKED", `Already hold ${existing.position} contract(s) on ${existing.ticker}`, event_id, {
          existingTicker: existing.ticker, existingContracts: existing.position, attemptedTicker: ticker,
        });

        // Sync Supabase to reflect reality
        const existingSide = existing.ticker === ticker ? sideLabel : (sideLabel === "HOME" ? "AWAY" : "HOME");
        const existingState = existingSide === "HOME" ? "LONG_HOME" : "LONG_AWAY";
        await this.updatePosition(event_id, {
          state: existingState as "LONG_HOME" | "LONG_AWAY",
          side: existingSide as "HOME" | "AWAY",
          ticker: existing.ticker,
          quantity: existing.position,
          entry_timestamp: new Date().toISOString(),
          intent_price: null, intent_contracts: null, intent_side: null, intent_created_at: null,
        });
        this.onLog("INFO", `${gameLabel}: Synced to ${existingState} (${existing.ticker} x${existing.position})`, event_id);
        return;
      }
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      this.onLog("INFO", `${gameLabel}: BLOCKED — cannot verify Kalshi positions: ${errMsg}`, event_id);
      this.writeLog("BLOCKED", `Cannot verify Kalshi positions: ${errMsg}`, event_id);
      return;
    }

    // ── Fetch fresh price ───────────────────────────────────────────
    let freshPrice = intentPrice;
    try {
      const markets = await fetchNbaMarkets();
      const market = markets.find((m) => m.ticker === ticker);
      if (market?.yesAsk != null) {
        freshPrice = market.yesAsk;
        this.onLog("INFO", `${gameLabel}: Fresh ask ${(freshPrice * 100).toFixed(0)}c (intent was ${(intentPrice * 100).toFixed(0)}c)`, event_id);
      }
    } catch {
      this.onLog("INFO", `${gameLabel}: Using intent price`, event_id);
    }

    // ── Place order → wait 10s → cancel → check positions ───────────
    let orderId: string | null = null;
    try {
      const result = await placeOrder(ticker, "yes", intentContracts, freshPrice.toFixed(2), "buy");
      orderId = result.orderId;

      this.onLog("INFO", `${gameLabel}: Order placed (${orderId}) @ ${(freshPrice * 100).toFixed(0)}c`, event_id);
      this.writeLog("INFO", `Order placed (${orderId}) @ ${(freshPrice * 100).toFixed(0)}c`, event_id, { orderId, freshPrice });

      // Wait for fill
      this.onLog("INFO", `${gameLabel}: Waiting 10s for fill...`, event_id);
      await new Promise((r) => setTimeout(r, ORDER_WAIT_MS));

      // Cancel whatever is left
      await this.tryCancelOrder(orderId, gameLabel, event_id);

      // Check what we actually own
      const owned = await this.getOwnedContracts(ticker);
      this.onLog("INFO", `${gameLabel}: Own ${owned} contract(s) on ${ticker}`, event_id);
      this.writeLog("INFO", `Post-order: ${owned} contract(s) on ${ticker}`, event_id, { orderId, owned });

      if (owned > 0) {
        await this.handleEntryFill(event_id, sideLabel, ticker, freshPrice, owned, gameLabel);
      } else {
        await this.resetToFlatWithCooldown(event_id);
        this.onLog("INFO", `${gameLabel}: No fill — cooldown applied`, event_id);
        this.writeLog("INFO", "No fill after 10s — cooldown applied", event_id, { orderId });
      }
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      this.onLog("INFO", `${gameLabel}: Order failed — ${errMsg}`, event_id);
      this.writeLog("INFO", `Entry order failed: ${errMsg}`, event_id);

      if (orderId) await this.tryCancelOrder(orderId, gameLabel, event_id);

      // Check if we own anything despite the error
      try {
        const owned = await this.getOwnedContracts(ticker);
        if (owned > 0) {
          this.onLog("INFO", `${gameLabel}: Error but own ${owned} contract(s) — recording`, event_id);
          await this.handleEntryFill(event_id, sideLabel, ticker, intentPrice, owned, gameLabel);
          return;
        }
      } catch { /* can't check — fall through */ }

      await this.resetToFlatWithCooldown(event_id);
    }
  }

  // ── Exit (auto) ─────────────────────────────────────────────────────

  private async executeAutoExit(position: AutopilotPosition): Promise<void> {
    const { event_id, ticker, quantity, entry_price, intent_price, intent_created_at, home_team, away_team, side } = position;
    const gameLabel = `${away_team}@${home_team}`;
    const longState = side === "HOME" ? "LONG_HOME" : "LONG_AWAY";

    if (intent_created_at) {
      const intentAge = Date.now() - new Date(intent_created_at).getTime();
      if (intentAge > 35_000) {
        this.onLog("INFO", `${gameLabel}: Exit intent expired (${Math.round(intentAge / 1000)}s old)`, event_id);
        await this.updatePosition(event_id, {
          state: longState, intent_price: null, intent_contracts: null, intent_side: null, intent_created_at: null,
        });
        return;
      }
    }

    if (!ticker || !quantity || quantity <= 0) return;

    this.onLog("INFO", `${gameLabel}: Executing auto-exit — selling ${ticker} x${quantity}`, event_id);
    this.writeLog("INFO", `Executing auto-exit: selling ${ticker} x${quantity}`, event_id);

    let exitPrice = intent_price || 0;
    try {
      const markets = await fetchNbaMarkets();
      const market = markets.find((m) => m.ticker === ticker);
      if (market) {
        // Use the higher of yesBid and lastPrice to avoid selling below market value
        const bid = market.yesBid;
        const last = market.lastPrice;
        if (bid != null && last != null) {
          exitPrice = Math.max(bid, last);
        } else if (last != null) {
          exitPrice = last;
        } else if (bid != null) {
          exitPrice = bid;
        }
      }
    } catch { /* use intent price */ }

    await this.updatePosition(event_id, { state: "EXITING" });

    let orderId: string | null = null;
    try {
      const result = await sellOrder(ticker, "yes", quantity, exitPrice.toFixed(2));
      orderId = result.orderId;
      this.onLog("INFO", `${gameLabel}: Exit order placed (${orderId}) @ ${(exitPrice * 100).toFixed(0)}c`, event_id);
      this.writeLog("INFO", `Exit order placed (${orderId}) @ ${(exitPrice * 100).toFixed(0)}c`, event_id, { orderId, exitPrice });

      await new Promise((r) => setTimeout(r, ORDER_WAIT_MS));
      await this.tryCancelOrder(orderId, gameLabel, event_id);

      const remaining = await this.getOwnedContracts(ticker);
      const sold = quantity - remaining;

      this.onLog("INFO", `${gameLabel}: Sold ${sold}, still own ${remaining}`, event_id);
      this.writeLog("INFO", `Post-exit: sold ${sold}, own ${remaining}`, event_id, { orderId, remaining, sold });

      if (sold > 0) {
        await this.handleExitFill(event_id, ticker, exitPrice, sold, entry_price, gameLabel);
      } else {
        await this.updatePosition(event_id, {
          state: longState, intent_price: null, intent_contracts: null, intent_side: null, intent_created_at: null,
        });
        this.onLog("INFO", `${gameLabel}: Auto exit no fills — will retry`, event_id);
      }
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      if (orderId) await this.tryCancelOrder(orderId, gameLabel, event_id);
      await this.updatePosition(event_id, {
        state: longState, intent_price: null, intent_contracts: null, intent_side: null, intent_created_at: null,
      });
      this.onLog("INFO", `${gameLabel}: Auto exit failed — ${errMsg}`, event_id);
      this.writeLog("INFO", `Auto exit failed: ${errMsg}`, event_id);
    }
  }

  // ── Exit (manual / general) ─────────────────────────────────────────

  async executeExit(
    position: AutopilotPosition,
    exitPrice: number,
    reason: "MANUAL" | "AUTO_TP" | "AUTO_SL" | "AUTO_LATE_GAME"
  ): Promise<void> {
    const { event_id, ticker, quantity, entry_price, home_team, away_team } = position;
    const gameLabel = `${away_team}@${home_team}`;
    const longState = position.side === "HOME" ? "LONG_HOME" : "LONG_AWAY";

    if (!ticker || !quantity || quantity <= 0) return;

    await this.updatePosition(event_id, { state: "EXITING" });
    this.onLog("EXIT", `${gameLabel}: ${reason} EXIT at ${(exitPrice * 100).toFixed(0)}c`, event_id);
    this.writeLog("EXIT", `${reason} EXIT: selling ${ticker} x${quantity} @ ${(exitPrice * 100).toFixed(0)}c`, event_id);

    let orderId: string | null = null;
    try {
      const result = await sellOrder(ticker, "yes", quantity, exitPrice.toFixed(2));
      orderId = result.orderId;
      this.writeLog("INFO", `${reason} exit order placed (${orderId})`, event_id, { orderId, exitPrice });

      await new Promise((r) => setTimeout(r, ORDER_WAIT_MS));
      await this.tryCancelOrder(orderId, gameLabel, event_id);

      const remaining = await this.getOwnedContracts(ticker);
      const sold = quantity - remaining;

      if (sold > 0) {
        await this.handleExitFill(event_id, ticker, exitPrice, sold, entry_price, gameLabel);
      } else {
        await this.updatePosition(event_id, { state: longState });
        this.onLog("INFO", `${gameLabel}: ${reason} exit no fills — will retry`, event_id);
      }
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      if (orderId) await this.tryCancelOrder(orderId, gameLabel, event_id);
      await this.updatePosition(event_id, { state: longState });
      this.onLog("INFO", `${gameLabel}: ${reason} exit failed — ${errMsg}`, event_id);
      this.writeLog("INFO", `${reason} exit failed: ${errMsg}`, event_id);
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────

  /**
   * Check how many contracts we own on a specific ticker.
   * Fetches ALL positions and scans locally — no server-side event_ticker filter.
   */
  private async getOwnedContracts(ticker: string): Promise<number> {
    const positions = await fetchPositions();
    const pos = positions.find((p) => p.ticker === ticker && p.position > 0);
    return pos ? pos.position : 0;
  }

  /**
   * Try to cancel an order. Swallows errors (order may already be filled/expired).
   */
  private async tryCancelOrder(orderId: string, gameLabel: string, eventId: string): Promise<void> {
    try {
      await cancelOrder(orderId);
      this.onLog("INFO", `${gameLabel}: Cancelled order ${orderId}`, eventId);
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      if (errMsg.includes("not_found") || errMsg.includes("cancel") || errMsg.includes("404")) {
        this.onLog("INFO", `${gameLabel}: Order ${orderId} already filled/expired`, eventId);
      } else {
        this.onLog("INFO", `${gameLabel}: Cancel failed for ${orderId}: ${errMsg}`, eventId);
      }
    }
  }

  /**
   * Record a confirmed entry fill → LONG.
   */
  private async handleEntryFill(
    eventId: string, side: string, ticker: string,
    entryPrice: number, fillCount: number, gameLabel: string
  ): Promise<void> {
    const newState = side === "HOME" ? "LONG_HOME" : "LONG_AWAY";

    const success = await this.updatePosition(eventId, {
      state: newState as "LONG_HOME" | "LONG_AWAY",
      entry_price: entryPrice,
      quantity: fillCount,
      entry_timestamp: new Date().toISOString(),
      intent_price: null, intent_contracts: null, intent_side: null, intent_created_at: null,
    });

    if (!success) {
      await new Promise((r) => setTimeout(r, 2000));
      const retry = await this.updatePosition(eventId, {
        state: newState as "LONG_HOME" | "LONG_AWAY",
        entry_price: entryPrice,
        quantity: fillCount,
        entry_timestamp: new Date().toISOString(),
        intent_price: null, intent_contracts: null, intent_side: null, intent_created_at: null,
      });
      if (!retry) {
        const msg = `CRITICAL: Filled ${side} x${fillCount} @ ${(entryPrice * 100).toFixed(0)}c on ${ticker} but FAILED to update Supabase. Manual fix required.`;
        this.onLog("ERROR", `${gameLabel}: ${msg}`, eventId);
        this.writeLog("ERROR", msg, eventId, { ticker, fillCount, entryPrice, newState });
        return;
      }
    }

    this.onLog("TRADE", `${gameLabel}: FILLED ${side} YES x${fillCount} @ ${(entryPrice * 100).toFixed(0)}c`, eventId, { ticker, fillCount, entryPrice });
    this.writeLog("TRADE", `ENTRY FILLED: ${side} YES x${fillCount} @ ${(entryPrice * 100).toFixed(0)}c`, eventId, { ticker, fillCount, entryPrice });
  }

  /**
   * Record a confirmed exit fill → FLAT (ready for re-entry).
   */
  private async handleExitFill(
    eventId: string, ticker: string, exitPrice: number,
    fillCount: number, entryPrice: number | null, gameLabel: string
  ): Promise<void> {
    const pnl = entryPrice ? (exitPrice - entryPrice) * fillCount : null;

    const success = await this.updatePosition(eventId, {
      state: "FLAT",
      side: null,
      ticker: null,
      exit_price: exitPrice,
      exit_timestamp: new Date().toISOString(),
      realized_pnl: pnl ? Math.round(pnl * 100) / 100 : null,
      cooldown_until: null,
      quantity: null,
      intent_price: null, intent_contracts: null, intent_side: null, intent_created_at: null,
    });

    if (!success) {
      await new Promise((r) => setTimeout(r, 2000));
      await this.updatePosition(eventId, {
        state: "FLAT",
        side: null,
        ticker: null,
        exit_price: exitPrice,
        exit_timestamp: new Date().toISOString(),
        realized_pnl: pnl ? Math.round(pnl * 100) / 100 : null,
        cooldown_until: null,
        quantity: null,
        intent_price: null, intent_contracts: null, intent_side: null, intent_created_at: null,
      });
    }

    const pnlStr = pnl != null ? `${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}` : "unknown";
    this.onLog("EXIT", `${gameLabel}: EXIT FILLED — sold x${fillCount} @ ${(exitPrice * 100).toFixed(0)}c (P&L: ${pnlStr})`, eventId);
    this.writeLog("EXIT", `EXIT FILLED: sold x${fillCount} @ ${(exitPrice * 100).toFixed(0)}c, P&L: ${pnlStr}`, eventId, { exitPrice, fillCount, pnl, ticker });
  }

  private async resetToFlatWithCooldown(eventId: string): Promise<void> {
    await this.updatePosition(eventId, {
      state: "FLAT",
      side: null,
      ticker: null,
      intent_price: null, intent_contracts: null, intent_side: null, intent_created_at: null,
      cooldown_until: new Date(Date.now() + ENTRY_FAILURE_COOLDOWN * 1000).toISOString(),
    });
  }

  // ── Supabase I/O ────────────────────────────────────────────────────

  private async updatePosition(eventId: string, data: Partial<AutopilotPosition>): Promise<boolean> {
    const payload = { ...data, updated_at: new Date().toISOString() };

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { error } = await supabase
          .from("autopilot_positions")
          .update(payload)
          .eq("user_id", this.userId)
          .eq("event_id", eventId);

        if (!error) return true;
        console.error(`updatePosition failed (attempt ${attempt + 1}): ${error.message}`);
        if (attempt === 0) await new Promise((r) => setTimeout(r, 500));
      } catch (e) {
        console.error(`updatePosition exception (attempt ${attempt + 1}):`, e);
        if (attempt === 0) await new Promise((r) => setTimeout(r, 500));
      }
    }

    this.writeLog("ERROR", `CRITICAL: Failed to update position for ${eventId}. Data: ${JSON.stringify(data)}`, eventId);
    return false;
  }

  private async writeLog(level: string, message: string, eventId?: string, metadata?: Record<string, unknown>): Promise<void> {
    const row = { user_id: this.userId, level, message, event_id: eventId ?? null, metadata: metadata ?? null };

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { error } = await supabase.from("autopilot_logs").insert(row);
        if (!error) return;
        if (attempt === 0) await new Promise((r) => setTimeout(r, 300));
      } catch {
        if (attempt === 0) await new Promise((r) => setTimeout(r, 300));
      }
    }
  }
}
