"use client";

import { useState } from "react";
import type { AutopilotGame, PositionItem } from "@/lib/types";

interface Props {
  game: AutopilotGame;
  positions: PositionItem[];
  edgeThreshold: number;
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

// ── Positions section (shared between pregame and live) ────────────────

function PositionsSection({ positions }: { positions: PositionItem[] }) {
  if (positions.length === 0) return null;

  return (
    <div className="text-xs mb-2 py-1.5 px-2 rounded bg-neutral-800/50 border border-neutral-800">
      <p className="text-neutral-500 mb-1">Positions</p>
      {positions.map((pos) => (
        <div
          key={pos.ticker}
          className="flex items-center justify-between py-0.5"
        >
          <div className="flex items-center gap-2">
            <span className="text-neutral-400 font-medium">
              {pos.ticker.split("-").pop()}
            </span>
            <span
              className={`font-mono font-medium ${
                pos.exposure >= 0 ? "text-green-400" : "text-red-400"
              }`}
            >
              {pos.exposure >= 0 ? "+" : ""}${pos.exposure.toFixed(2)}
            </span>
          </div>
          <div className="flex items-center gap-2 text-neutral-600">
            <span>${pos.totalTraded.toFixed(2)} traded</span>
            {pos.restingOrders > 0 && (
              <span>{pos.restingOrders} resting</span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Pregame card ───────────────────────────────────────────────────────

function PregameCard({
  game,
  positions,
}: {
  game: AutopilotGame;
  positions: PositionItem[];
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
              {game.awayTeam} {probBar(awayPrice)}
            </span>
            <span>
              {probBar(homePrice)} {game.homeTeam}
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
          <div className="flex gap-4 text-xs text-neutral-600 mt-1.5">
            <span>
              {game.awayTeam}: {(awayPrice * 100).toFixed(0)}c
            </span>
            <span>
              {game.homeTeam}: {(homePrice * 100).toFixed(0)}c
            </span>
          </div>
        </div>
      )}

      {/* Show single-side price if only one is available */}
      {homePrice == null && awayPrice == null && (
        <div className="mb-3 text-xs text-neutral-600">
          Kalshi markets not yet available
        </div>
      )}

      <PositionsSection positions={positions} />

      <div className="text-xs text-neutral-600 mt-1">
        Model signals will appear when the game starts
      </div>
    </div>
  );
}

// ── Live card ──────────────────────────────────────────────────────────

function LiveCard({
  game,
  positions,
  edgeThreshold,
}: {
  game: AutopilotGame;
  positions: PositionItem[];
  edgeThreshold: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const s = game.latestSignal!;

  const homeProb = s.model_home_win_prob;
  const awayProb = 1 - homeProb;

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

      {/* Kalshi prices */}
      {(s.kalshi_home_price != null || s.kalshi_away_price != null) && (
        <div className="flex gap-4 text-xs text-neutral-500 mb-2">
          {s.kalshi_away_price != null && (
            <span>
              {s.away_team} Kalshi: {(s.kalshi_away_price * 100).toFixed(0)}c
            </span>
          )}
          {s.kalshi_home_price != null && (
            <span>
              {s.home_team} Kalshi: {(s.kalshi_home_price * 100).toFixed(0)}c
            </span>
          )}
        </div>
      )}

      <PositionsSection positions={positions} />

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
              <span className={actionColor(
                sig.recommended_action !== "NO_TRADE" &&
                sig.edge_vs_kalshi != null &&
                sig.edge_vs_kalshi < edgeThreshold
                  ? "NO_TRADE"
                  : sig.recommended_action
              )}>
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

export default function AutopilotGameCard({ game, positions, edgeThreshold }: Props) {
  if (game.latestSignal) {
    return <LiveCard game={game} positions={positions} edgeThreshold={edgeThreshold} />;
  }
  return <PregameCard game={game} positions={positions} />;
}
