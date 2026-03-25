"use client";

import { useState } from "react";
import type { AutopilotGame, AutopilotPosition, PositionItem, KalshiMarket, Sport } from "@/lib/types";

/** Friction in cents — must match backend decision.py and position manager. */
const FRICTION_CENTS = 2.0;

interface Props {
  game: AutopilotGame;
  kalshiPosition: PositionItem | null;
  liveMarkets: KalshiMarket[];
  edgeThreshold: number;
  onManualExit: (position: AutopilotPosition) => void;
  isFinished?: boolean;
  sport: Sport;
}

function formatNbaClock(period: number, secondsRemaining: number): string {
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

/** MLB outs indicator — three circles, filled = out recorded. */
function OutsIndicator({ outs }: { outs: number }) {
  const clampedOuts = Math.min(Math.max(outs, 0), 3);
  return (
    <span className="inline-flex items-center gap-0.5 ml-1.5">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className={`inline-block w-2 h-2 rounded-full border ${
            i < clampedOuts
              ? "bg-yellow-400 border-yellow-400"
              : "bg-transparent border-neutral-600"
          }`}
        />
      ))}
    </span>
  );
}

/** Format MLB inning half label. */
function formatMlbInning(inning: number, inningHalf?: string | null): string {
  const ordinal = inning === 1 ? "1st" : inning === 2 ? "2nd" : inning === 3 ? "3rd" : `${inning}th`;
  if (inningHalf === "top") return `Top ${ordinal}`;
  if (inningHalf === "bottom") return `Bot ${ordinal}`;
  if (inningHalf === "end") return `End ${ordinal}`;
  return ordinal;
}

/** Render MLB or NBA game status display. */
function GameStatus({ signal, sport }: { signal: { period: number; seconds_remaining: number; inning_half?: string | null; outs_in_inning?: number | null }; sport: Sport }) {
  if (sport === "mlb") {
    return (
      <span className="text-xs text-neutral-500 flex items-center gap-1">
        <span>{formatMlbInning(signal.period, signal.inning_half)}</span>
        <OutsIndicator outs={signal.outs_in_inning ?? 0} />
      </span>
    );
  }
  return (
    <span className="text-xs text-neutral-500">
      {formatNbaClock(signal.period, signal.seconds_remaining)}
    </span>
  );
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

// ── Position display section ─────────────────────────────────────────

function PositionSection({
  kalshiPosition,
  homeTeam,
  awayTeam,
  currentHomePrice,
  currentAwayPrice,
  onManualExit,
}: {
  kalshiPosition: PositionItem;
  homeTeam: string;
  awayTeam: string;
  currentHomePrice?: number | null;
  currentAwayPrice?: number | null;
  onManualExit: (position: AutopilotPosition) => void;
}) {
  const quantity = kalshiPosition.position;

  // Derive team from Kalshi ticker (e.g., "KXNBAGAME-26MAR13MINGSW-GSW" → "GSW")
  const tickerTeam = kalshiPosition.ticker.substring(kalshiPosition.ticker.lastIndexOf("-") + 1);
  const isHome = tickerTeam === homeTeam;
  const teamAbbr = tickerTeam;

  // Derive entry price from Kalshi (exposure / position)
  const entryPrice = quantity > 0 ? kalshiPosition.exposure / quantity : 0;

  // Current market price for this side
  const currentPrice = isHome ? currentHomePrice : currentAwayPrice;

  // Unrealized P&L
  const unrealizedPnl =
    entryPrice > 0 && currentPrice != null
      ? (currentPrice - entryPrice) * quantity
      : null;

  const handleExit = () => {
    const eventPrefix = kalshiPosition.ticker.substring(0, kalshiPosition.ticker.lastIndexOf("-"));
    onManualExit({
      user_id: "",
      event_id: eventPrefix,
      ticker: kalshiPosition.ticker,
      side: isHome ? "HOME" : "AWAY",
      entry_price: entryPrice,
      home_team: homeTeam,
      away_team: awayTeam,
      sell_signal: null,
    });
  };

  return (
    <div className="text-xs mb-2 py-2 px-2 rounded bg-neutral-800/50 border border-neutral-800">
      {/* Header row: team badge + EXIT button */}
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium px-2 py-0.5 rounded border bg-green-900/40 text-green-400 border-current/20">
            {teamAbbr}
          </span>
        </div>
        <button
          onClick={handleExit}
          className="text-xs font-medium px-2 py-0.5 rounded bg-red-900/40 text-red-400 border border-red-800 hover:bg-red-900/60 transition-colors"
        >
          EXIT
        </button>
      </div>

      {/* Position details */}
      <div className="flex items-center justify-between py-0.5">
        <span className="text-neutral-500">
          {quantity}x @ {(entryPrice * 100).toFixed(0)}c
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
    </div>
  );
}

// ── Pregame card ───────────────────────────────────────────────────────

function PregameCard({
  game,
  kalshiPosition,
  onManualExit,
}: {
  game: AutopilotGame;
  kalshiPosition: PositionItem | null;
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

      {/* Position section — shown if Kalshi says we own contracts */}
      {kalshiPosition && kalshiPosition.position > 0 && (
        <PositionSection
          kalshiPosition={kalshiPosition}
          homeTeam={game.homeTeam}
          awayTeam={game.awayTeam}
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
  kalshiPosition,
  liveMarkets,
  edgeThreshold,
  onManualExit,
  sport,
}: {
  game: AutopilotGame;
  kalshiPosition: PositionItem | null;
  liveMarkets: KalshiMarket[];
  edgeThreshold: number;
  onManualExit: (position: AutopilotPosition) => void;
  sport: Sport;
}) {
  const [expanded, setExpanded] = useState(false);
  const s = game.latestSignal!;

  // Use blended probability if available, fallback to raw model
  const homeProb = s.blended_home_win_prob ?? s.model_home_win_prob;
  const awayProb = 1 - homeProb;
  const isBlended = s.blended_home_win_prob != null;

  // Use live market prices (5s poll) → game-level (30s poll) → signal-level (backend) as fallback chain
  const liveHomeMarket = s.kalshi_ticker_home ? liveMarkets.find((m) => m.ticker === s.kalshi_ticker_home) : null;
  const liveAwayMarket = s.kalshi_ticker_away ? liveMarkets.find((m) => m.ticker === s.kalshi_ticker_away) : null;
  const kalshiHomePrice = liveHomeMarket?.yesAsk ?? game.kalshiHomePrice ?? s.kalshi_home_price;
  const kalshiAwayPrice = liveAwayMarket?.yesAsk ?? game.kalshiAwayPrice ?? s.kalshi_away_price;

  // Compute live edge using fresh prices + model probability (with friction deduction)
  // This mirrors the edge calculation in checkEntryOpportunities
  const UNDERDOG_PROB_THRESHOLD = 0.20;
  const displayedAction = (() => {
    // Compute edge for both sides with fresh prices
    const homeEdge = kalshiHomePrice != null ? (homeProb - kalshiHomePrice) * 100 - FRICTION_CENTS : null;
    const awayEdge = kalshiAwayPrice != null ? (awayProb - kalshiAwayPrice) * 100 - FRICTION_CENTS : null;

    // Find best side
    let bestEdge: number | null = null;
    let bestSide: "BUY_HOME" | "BUY_AWAY" | null = null;
    if (homeEdge != null && homeEdge > 0 && (bestEdge == null || homeEdge > bestEdge)) {
      bestEdge = homeEdge;
      bestSide = "BUY_HOME";
    }
    if (awayEdge != null && awayEdge > 0 && (bestEdge == null || awayEdge > bestEdge)) {
      bestEdge = awayEdge;
      bestSide = "BUY_AWAY";
    }

    if (bestSide == null || bestEdge == null || bestEdge < edgeThreshold) return "NO_TRADE";

    // Underdog rule
    const sideProb = bestSide === "BUY_HOME" ? homeProb : awayProb;
    if (sideProb < UNDERDOG_PROB_THRESHOLD && bestEdge < edgeThreshold * 2) return "NO_TRADE";

    return bestSide;
  })();

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
        <GameStatus signal={s} sport={sport} />
      </div>

      {/* Model probability bar */}
      <div className="mb-3">
        <div className="flex justify-between text-xs text-neutral-500 mb-1">
          <span>
            {s.away_team} {probBar(awayProb)}
          </span>
          <span className="text-[10px] text-neutral-700 uppercase tracking-wide">
            {isBlended ? "Model (blended)" : "Model"}
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

      {/* Edge summary: best-edge side → team, model %, kalshi ask, net edge (computed from live prices) */}
      {(() => {
        // Determine which side to display using live prices
        let edgeTeam: string;
        let edgeModelProb: number;
        let edgeKalshiAsk: number | null;

        // Compute edge for both sides with fresh prices
        const homeEdge =
          kalshiHomePrice != null
            ? (homeProb - kalshiHomePrice) * 100 - FRICTION_CENTS
            : -Infinity;
        const awayEdge =
          kalshiAwayPrice != null
            ? (awayProb - kalshiAwayPrice) * 100 - FRICTION_CENTS
            : -Infinity;

        if (displayedAction === "BUY_HOME") {
          edgeTeam = s.home_team;
          edgeModelProb = homeProb;
          edgeKalshiAsk = kalshiHomePrice;
        } else if (displayedAction === "BUY_AWAY") {
          edgeTeam = s.away_team;
          edgeModelProb = awayProb;
          edgeKalshiAsk = kalshiAwayPrice;
        } else {
          // NO_TRADE — pick the side with better edge for display
          if (homeEdge >= awayEdge) {
            edgeTeam = s.home_team;
            edgeModelProb = homeProb;
            edgeKalshiAsk = kalshiHomePrice;
          } else {
            edgeTeam = s.away_team;
            edgeModelProb = awayProb;
            edgeKalshiAsk = kalshiAwayPrice;
          }
        }

        const netEdge =
          edgeKalshiAsk != null
            ? (edgeModelProb - edgeKalshiAsk) * 100 - FRICTION_CENTS
            : null;

        const isBuy = displayedAction !== "NO_TRADE";

        return (
          <div className="flex items-center justify-between mb-2">
            <span
              className={`text-xs font-medium px-2 py-0.5 rounded ${
                isBuy
                  ? "bg-green-900/40 text-green-400 border border-green-800"
                  : "bg-neutral-800 text-neutral-500 border border-neutral-700"
              }`}
            >
              {displayedAction}
            </span>
            <div className="flex items-center gap-3 text-xs font-mono">
              <span className="text-neutral-300 font-medium">{edgeTeam}</span>
              <span className="text-neutral-500">
                {Math.round(edgeModelProb * 100)}%
              </span>
              <span className="text-neutral-600">
                {edgeKalshiAsk != null
                  ? `${(edgeKalshiAsk * 100).toFixed(0)}¢`
                  : "—"}
              </span>
              {netEdge != null && (
                <span
                  className={`font-medium ${
                    netEdge >= edgeThreshold
                      ? "text-green-400"
                      : netEdge > 0
                        ? "text-yellow-400"
                        : "text-neutral-500"
                  }`}
                >
                  {netEdge > 0 ? "+" : ""}
                  {netEdge.toFixed(1)}%
                </span>
              )}
            </div>
          </div>
        );
      })()}

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

      {/* Position section — derived from Kalshi (use live bid for unrealized P&L) */}
      {kalshiPosition && kalshiPosition.position > 0 && (
        <PositionSection
          kalshiPosition={kalshiPosition}
          homeTeam={game.homeTeam}
          awayTeam={game.awayTeam}
          currentHomePrice={liveHomeMarket?.yesBid ?? kalshiHomePrice}
          currentAwayPrice={liveAwayMarket?.yesBid ?? kalshiAwayPrice}
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
                {sport === "mlb"
                  ? formatMlbInning(sig.period, sig.inning_half)
                  : formatNbaClock(sig.period, sig.seconds_remaining)}
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
                  (() => {
                    if (sig.recommended_action === "NO_TRADE") return "NO_TRADE";
                    if (sig.edge_vs_kalshi == null) return sig.recommended_action;
                    if (sig.edge_vs_kalshi < edgeThreshold) return "NO_TRADE";
                    const sigHomeProb = sig.blended_home_win_prob ?? sig.model_home_win_prob;
                    const sigSideProb = sig.recommended_action === "BUY_HOME" ? sigHomeProb : 1 - sigHomeProb;
                    if (sigSideProb < UNDERDOG_PROB_THRESHOLD && sig.edge_vs_kalshi < edgeThreshold * 2) return "NO_TRADE";
                    return sig.recommended_action;
                  })()
                )}
              >
                {(() => {
                  if (sig.recommended_action === "NO_TRADE") return "NO_TRADE";
                  if (sig.edge_vs_kalshi == null) return sig.recommended_action;
                  if (sig.edge_vs_kalshi < edgeThreshold) return "NO_TRADE";
                  const sigHomeProb = sig.blended_home_win_prob ?? sig.model_home_win_prob;
                  const sigSideProb = sig.recommended_action === "BUY_HOME" ? sigHomeProb : 1 - sigHomeProb;
                  if (sigSideProb < UNDERDOG_PROB_THRESHOLD && sig.edge_vs_kalshi < edgeThreshold * 2) return "NO_TRADE";
                  return sig.recommended_action;
                })()}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Finished card ─────────────────────────────────────────────────────

function FinishedCard({
  game,
  kalshiPosition,
  onManualExit,
  sport,
}: {
  game: AutopilotGame;
  kalshiPosition: PositionItem | null;
  onManualExit: (position: AutopilotPosition) => void;
  sport: Sport;
}) {
  const s = game.latestSignal!;

  // Determine winner for display
  const homeWon = s.home_score > s.away_score;
  const tied = s.home_score === s.away_score;
  const isExtras = sport === "mlb" ? s.period > 9 : s.period > 4;

  return (
    <div className="rounded-lg border border-neutral-800/60 bg-neutral-900/30 p-4 opacity-60">
      {/* Final score header */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-3">
          <div className="text-sm">
            <span className={homeWon && !tied ? "text-neutral-500" : "text-neutral-300 font-semibold"}>
              {s.away_team}
            </span>
            <span className={`font-bold ml-2 ${homeWon && !tied ? "text-neutral-500" : "text-white"}`}>
              {s.away_score}
            </span>
            <span className="text-neutral-700 mx-2">@</span>
            <span className={`font-bold mr-2 ${!homeWon && !tied ? "text-neutral-500" : "text-white"}`}>
              {s.home_score}
            </span>
            <span className={!homeWon && !tied ? "text-neutral-500" : "text-neutral-300 font-semibold"}>
              {s.home_team}
            </span>
          </div>
        </div>
        <span className="text-xs text-neutral-600 font-medium">
          {game.statusDetail || (isExtras ? (sport === "mlb" ? `Final/${s.period}` : "Final/OT") : "Final")}
        </span>
      </div>

      {/* Position section — show if we still own contracts (Kalshi truth) */}
      {kalshiPosition && kalshiPosition.position > 0 && (
        <PositionSection
          kalshiPosition={kalshiPosition}
          homeTeam={game.homeTeam}
          awayTeam={game.awayTeam}
          currentHomePrice={game.kalshiHomePrice ?? s.kalshi_home_price}
          currentAwayPrice={game.kalshiAwayPrice ?? s.kalshi_away_price}
          onManualExit={onManualExit}
        />
      )}
    </div>
  );
}

// ── Main export ────────────────────────────────────────────────────────

export default function AutopilotGameCard({
  game,
  kalshiPosition,
  liveMarkets,
  edgeThreshold,
  onManualExit,
  isFinished,
  sport,
}: Props) {
  if (isFinished && game.latestSignal) {
    return (
      <FinishedCard
        game={game}
        kalshiPosition={kalshiPosition}
        onManualExit={onManualExit}
        sport={sport}
      />
    );
  }
  if (game.latestSignal) {
    return (
      <LiveCard
        game={game}
        kalshiPosition={kalshiPosition}
        liveMarkets={liveMarkets}
        edgeThreshold={edgeThreshold}
        onManualExit={onManualExit}
        sport={sport}
      />
    );
  }
  return (
    <PregameCard
      game={game}
      kalshiPosition={kalshiPosition}
      onManualExit={onManualExit}
    />
  );
}
