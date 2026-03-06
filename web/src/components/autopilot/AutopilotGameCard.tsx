"use client";

import { useState } from "react";
import type { AutopilotGame, AutopilotPosition } from "@/lib/types";

interface Props {
  game: AutopilotGame;
  position: AutopilotPosition | null;
  edgeThreshold: number;
  onManualExit: (position: AutopilotPosition) => void;
}

function formatClock(period: number, secondsRemaining: number): string {
  if (period <= 4) {
    const fullQuartersLeft = 4 - period;
    const clockInQuarter = secondsRemaining - fullQuartersLeft * 720;
    const mins = Math.floor(Math.max(clockInQuarter, 0) / 60);
    const secs = Math.floor(Math.max(clockInQuarter, 0) % 60);
    return `Q${period} ${mins}:${secs.toString().padStart(2, "0")}`;
  }
  const mins = Math.floor(secondsRemaining / 60);
  const secs = Math.floor(secondsRemaining % 60);
  return `OT ${mins}:${secs.toString().padStart(2, "0")}`;
}

function actionColor(action: string): string {
  if (action === "BUY_HOME" || action === "BUY_AWAY") return "text-green-400";
  return "text-neutral-500";
}

function probBar(prob: number): string {
  return `${Math.round(prob * 100)}%`;
}

/** Format an ISO start time for display (e.g., "7:30 PM"). */
function formatStartTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      timeZone: "America/New_York",
    });
  } catch {
    return "";
  }
}

// ── Position state badge ─────────────────────────────────────────────

function PositionBadge({ state, label }: { state: string; label?: string }) {
  const config: Record<string, { bg: string; text: string; label: string }> = {
    FLAT: { bg: "bg-neutral-800", text: "text-neutral-500", label: "FLAT" },
    PENDING_ENTRY: {
      bg: "bg-yellow-900/40",
      text: "text-yellow-400",
      label: "PENDING",
    },
    LONG_HOME: {
      bg: "bg-green-900/40",
      text: "text-green-400",
      label: "LONG",
    },
    LONG_AWAY: {
      bg: "bg-green-900/40",
      text: "text-green-400",
      label: "LONG",
    },
    EXITING: {
      bg: "bg-blue-900/40",
      text: "text-blue-400",
      label: "EXITING",
    },
    LOCKED: {
      bg: "bg-neutral-800",
      text: "text-neutral-400",
      label: "LOCKED",
    },
  };

  const c = config[state] || config.FLAT;

  return (
    <span
      className={`text-xs font-medium px-2 py-0.5 rounded border ${c.bg} ${c.text} border-current/20`}
    >
      {label || c.label}
    </span>
  );
}

// ── Position details section ─────────────────────────────────────────

function PositionSection({
  position,
  currentHomePrice,
  currentAwayPrice,
  onManualExit,
}: {
  position: AutopilotPosition;
  currentHomePrice?: number | null;
  currentAwayPrice?: number | null;
  onManualExit: (position: AutopilotPosition) => void;
}) {
  const isLong =
    position.state === "LONG_HOME" || position.state === "LONG_AWAY";
  const isLocked = position.state === "LOCKED";
  const isPending = position.state === "PENDING_ENTRY";
  const isExiting = position.state === "EXITING";

  // Current market price for this side
  const currentPrice =
    position.side === "HOME" ? currentHomePrice : currentAwayPrice;

  // Unrealized P&L
  const unrealizedPnl =
    isLong &&
    position.entry_price != null &&
    position.quantity != null &&
    currentPrice != null
      ? (currentPrice - position.entry_price) * position.quantity
      : null;

  // Resolve the 3-letter team abbreviation for the side we bought
  const teamAbbr =
    position.side === "HOME"
      ? position.home_team
      : position.side === "AWAY"
        ? position.away_team
        : null;

  // Don't render anything for FLAT positions
  if (position.state === "FLAT") return null;

  return (
    <div className="text-xs mb-2 py-2 px-2 rounded bg-neutral-800/50 border border-neutral-800">
      {/* Header row: team badge + EXIT button */}
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-2">
          <PositionBadge
            state={position.state}
            label={
              (isLong || isExiting) && teamAbbr ? teamAbbr : undefined
            }
          />
        </div>
        {isLong && (
          <button
            onClick={() => onManualExit(position)}
            className="text-xs font-medium px-2 py-0.5 rounded bg-red-900/40 text-red-400 border border-red-800 hover:bg-red-900/60 transition-colors"
          >
            EXIT
          </button>
        )}
      </div>

      {/* Entry details (for LONG, EXITING, and LOCKED states) */}
      {(isLong || isLocked || isExiting) && position.entry_price != null && (
        <div className="flex items-center justify-between py-0.5">
          <span className="text-neutral-500">
            {position.quantity}x @ {(position.entry_price * 100).toFixed(0)}c
          </span>
          <div className="flex items-center gap-2">
            {unrealizedPnl != null && (
              <span
                className={`font-mono font-medium ${
                  unrealizedPnl >= 0 ? "text-green-400" : "text-red-400"
                }`}
              >
                {unrealizedPnl >= 0 ? "+" : ""}${unrealizedPnl.toFixed(2)}
              </span>
            )}
            {currentPrice != null && (
              <span className="text-neutral-600">
                now {(currentPrice * 100).toFixed(0)}c
              </span>
            )}
          </div>
        </div>
      )}

      {/* Pending intent info */}
      {isPending && position.intent_price != null && (
        <div className="text-yellow-400/70 py-0.5 animate-pulse">
          Intent: {position.intent_contracts}x @{" "}
          {(position.intent_price * 100).toFixed(0)}c — placing order...
        </div>
      )}

      {/* Locked (completed) position with realized P&L */}
      {isLocked && position.realized_pnl != null && (
        <div className="flex items-center justify-between py-0.5 mt-0.5">
          <span className="text-neutral-500">
            Exited @{" "}
            {position.exit_price != null
              ? `${(position.exit_price * 100).toFixed(0)}c`
              : "?"}
          </span>
          <span
            className={`font-mono font-medium ${
              position.realized_pnl >= 0 ? "text-green-400" : "text-red-400"
            }`}
          >
            {position.realized_pnl >= 0 ? "+" : ""}$
            {position.realized_pnl.toFixed(2)}
          </span>
        </div>
      )}

      {/* Exiting state */}
      {isExiting && (
        <div className="text-blue-400 py-0.5 animate-pulse">
          Placing sell order...
        </div>
      )}
    </div>
  );
}

// ── Pregame card ───────────────────────────────────────────────────────

function PregameCard({
  game,
  position,
  onManualExit,
}: {
  game: AutopilotGame;
  position: AutopilotPosition | null;
  onManualExit: (position: AutopilotPosition) => void;
}) {
  const homePrice = game.kalshiHomePrice;
  const awayPrice = game.kalshiAwayPrice;

  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900/60 p-4">
      {/* Teams + tipoff */}
      <div className="flex items-center justify-between mb-3">
        <div className="text-sm">
          <span className="text-neutral-400">{game.awayTeam}</span>
          <span className="text-neutral-600 mx-2">@</span>
          <span className="text-neutral-400">{game.homeTeam}</span>
        </div>
        <span className="text-xs text-neutral-500">
          {game.statusDetail ||
            (game.startTime ? formatStartTime(game.startTime) : "Scheduled")}
        </span>
      </div>

      {/* Kalshi market prices as implied probability bar */}
      {homePrice != null && awayPrice != null && (
        <div className="mb-3">
          <div className="flex justify-between text-xs text-neutral-500 mb-1">
            <span>
              {game.awayTeam} {(awayPrice * 100).toFixed(0)}c
            </span>
            <span className="text-[10px] text-neutral-700 uppercase tracking-wide">
              Kalshi
            </span>
            <span>
              {(homePrice * 100).toFixed(0)}c {game.homeTeam}
            </span>
          </div>
          <div className="h-2 bg-neutral-800 rounded-full overflow-hidden flex">
            <div
              className="bg-red-500/40 transition-all duration-500"
              style={{ width: `${awayPrice * 100}%` }}
            />
            <div
              className="bg-blue-500/40 transition-all duration-500"
              style={{ width: `${homePrice * 100}%` }}
            />
          </div>
        </div>
      )}

      {/* No market prices yet */}
      {homePrice == null && awayPrice == null && (
        <div className="mb-3 text-xs text-neutral-600">
          Kalshi markets not yet available
        </div>
      )}

      {/* Position section */}
      {position && (
        <PositionSection
          position={position}
          currentHomePrice={homePrice}
          currentAwayPrice={awayPrice}
          onManualExit={onManualExit}
        />
      )}

      <div className="text-xs text-neutral-600 mt-1">
        Model signals will appear when the game starts
      </div>
    </div>
  );
}

// ── Live card ──────────────────────────────────────────────────────────

function LiveCard({
  game,
  position,
  edgeThreshold,
  onManualExit,
}: {
  game: AutopilotGame;
  position: AutopilotPosition | null;
  edgeThreshold: number;
  onManualExit: (position: AutopilotPosition) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const s = game.latestSignal!;

  const homeProb = s.model_home_win_prob;
  const awayProb = 1 - homeProb;

  // Use freshest Kalshi prices: game-level (from API poll every 30s) → signal-level (from backend)
  const kalshiHomePrice = game.kalshiHomePrice ?? s.kalshi_home_price;
  const kalshiAwayPrice = game.kalshiAwayPrice ?? s.kalshi_away_price;

  // Apply user's edge threshold to determine displayed action
  // Backend uses a 2% floor, but the user may have a higher threshold
  const displayedAction =
    s.recommended_action !== "NO_TRADE" &&
    s.edge_vs_kalshi != null &&
    s.edge_vs_kalshi < edgeThreshold
      ? "NO_TRADE"
      : s.recommended_action;

  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900/60 p-4">
      {/* Score header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-3">
          <div className="text-sm">
            <span className="text-neutral-400">{s.away_team}</span>
            <span className="text-white font-bold ml-2">{s.away_score}</span>
            <span className="text-neutral-600 mx-2">@</span>
            <span className="text-white font-bold mr-2">{s.home_score}</span>
            <span className="text-neutral-400">{s.home_team}</span>
          </div>
        </div>
        <span className="text-xs text-neutral-500">
          {formatClock(s.period, s.seconds_remaining)}
        </span>
      </div>

      {/* Model probability bar */}
      <div className="mb-3">
        <div className="flex justify-between text-xs text-neutral-500 mb-1">
          <span>
            {s.away_team} {probBar(awayProb)}
          </span>
          <span>
            {probBar(homeProb)} {s.home_team}
          </span>
        </div>
        <div className="h-2 bg-neutral-800 rounded-full overflow-hidden flex">
          <div
            className="bg-red-500/70 transition-all duration-500"
            style={{ width: `${awayProb * 100}%` }}
          />
          <div
            className="bg-blue-500/70 transition-all duration-500"
            style={{ width: `${homeProb * 100}%` }}
          />
        </div>
      </div>

      {/* Edge + action */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span
            className={`text-xs font-medium px-2 py-0.5 rounded ${
              displayedAction !== "NO_TRADE"
                ? "bg-green-900/40 text-green-400 border border-green-800"
                : "bg-neutral-800 text-neutral-500 border border-neutral-700"
            }`}
          >
            {displayedAction}
          </span>
          {s.edge_vs_kalshi != null && (
            <span className="text-xs text-neutral-400">
              Edge: {s.edge_vs_kalshi > 0 ? "+" : ""}
              {s.edge_vs_kalshi.toFixed(1)}%
            </span>
          )}
        </div>
        {s.reason && (
          <span className="text-xs text-neutral-600 truncate max-w-[200px]">
            {s.reason}
          </span>
        )}
      </div>

      {/* Kalshi market prices bar */}
      {(kalshiHomePrice != null || kalshiAwayPrice != null) && (
        <div className="mb-3">
          <div className="flex justify-between text-xs text-neutral-600 mb-0.5">
            <span>
              {s.away_team}{" "}
              {kalshiAwayPrice != null
                ? `${(kalshiAwayPrice * 100).toFixed(0)}c`
                : "—"}
            </span>
            <span className="text-[10px] text-neutral-700 uppercase tracking-wide">
              Kalshi
            </span>
            <span>
              {kalshiHomePrice != null
                ? `${(kalshiHomePrice * 100).toFixed(0)}c`
                : "—"}{" "}
              {s.home_team}
            </span>
          </div>
          {kalshiHomePrice != null && kalshiAwayPrice != null && (
            <div className="h-1.5 bg-neutral-800 rounded-full overflow-hidden flex">
              <div
                className="bg-red-500/30 transition-all duration-500"
                style={{ width: `${kalshiAwayPrice * 100}%` }}
              />
              <div
                className="bg-blue-500/30 transition-all duration-500"
                style={{ width: `${kalshiHomePrice * 100}%` }}
              />
            </div>
          )}
        </div>
      )}

      {/* Position section */}
      {position && (
        <PositionSection
          position={position}
          currentHomePrice={kalshiHomePrice}
          currentAwayPrice={kalshiAwayPrice}
          onManualExit={onManualExit}
        />
      )}

      {/* Expand for signal history */}
      {game.signals.length > 0 && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="mt-2 text-xs text-neutral-600 hover:text-neutral-400"
        >
          {expanded
            ? "Hide history"
            : `Show history (${game.signals.length} signals)`}
        </button>
      )}

      {expanded && (
        <div className="mt-2 max-h-48 overflow-y-auto border-t border-neutral-800 pt-2">
          {game.signals.slice(0, 20).map((sig) => (
            <div
              key={sig.id}
              className="flex items-center justify-between text-xs py-0.5 border-b border-neutral-800/50"
            >
              <span className="text-neutral-500">
                {formatClock(sig.period, sig.seconds_remaining)}
              </span>
              <span className="text-neutral-400">
                {sig.away_team} {sig.away_score} - {sig.home_score}{" "}
                {sig.home_team}
              </span>
              <span className="text-neutral-300">
                P(H)={probBar(sig.model_home_win_prob)}
              </span>
              <span
                className={actionColor(
                  sig.recommended_action !== "NO_TRADE" &&
                    sig.edge_vs_kalshi != null &&
                    sig.edge_vs_kalshi < edgeThreshold
                    ? "NO_TRADE"
                    : sig.recommended_action
                )}
              >
                {sig.recommended_action !== "NO_TRADE" &&
                sig.edge_vs_kalshi != null &&
                sig.edge_vs_kalshi < edgeThreshold
                  ? "NO_TRADE"
                  : sig.recommended_action}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Main export ────────────────────────────────────────────────────────

export default function AutopilotGameCard({
  game,
  position,
  edgeThreshold,
  onManualExit,
}: Props) {
  if (game.latestSignal) {
    return (
      <LiveCard
        game={game}
        position={position}
        edgeThreshold={edgeThreshold}
        onManualExit={onManualExit}
      />
    );
  }
  return (
    <PregameCard
      game={game}
      position={position}
      onManualExit={onManualExit}
    />
  );
}
