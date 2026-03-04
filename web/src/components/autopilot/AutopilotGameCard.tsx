"use client";

import { useState } from "react";
import type { AutopilotGame, AutopilotExecution } from "@/lib/types";

interface Props {
  game: AutopilotGame;
  executions: AutopilotExecution[];
}

function formatClock(period: number, secondsRemaining: number): string {
  if (period <= 4) {
    // Figure out seconds within the current quarter
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

export default function AutopilotGameCard({ game, executions }: Props) {
  const [expanded, setExpanded] = useState(false);
  const s = game.latestSignal;

  const homeProb = s.model_home_win_prob;
  const awayProb = 1 - homeProb;
  const homeFavored = homeProb >= 0.5;

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

      {/* Probability bar */}
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
              s.recommended_action !== "NO_TRADE"
                ? "bg-green-900/40 text-green-400 border border-green-800"
                : "bg-neutral-800 text-neutral-500 border border-neutral-700"
            }`}
          >
            {s.recommended_action}
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

      {/* Executions */}
      {executions.length > 0 && (
        <div className="mt-3 border-t border-neutral-800 pt-2">
          <p className="text-xs text-neutral-500 mb-1">
            Trades ({executions.length})
          </p>
          {executions.slice(0, 3).map((exec, i) => (
            <div
              key={i}
              className="flex items-center justify-between text-xs py-0.5"
            >
              <span className="text-green-400">
                BUY {exec.side.toUpperCase()} x{exec.contracts} @{" "}
                {(exec.price * 100).toFixed(0)}c
              </span>
              <span className="text-neutral-600">
                {exec.status}{" "}
                {exec.fillCount != null && `(${exec.fillCount} filled)`}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Expand for signal history */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="mt-2 text-xs text-neutral-600 hover:text-neutral-400"
      >
        {expanded
          ? "Hide history"
          : `Show history (${game.signals.length} signals)`}
      </button>

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
              <span className={actionColor(sig.recommended_action)}>
                {sig.recommended_action}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
