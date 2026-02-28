"use client";

import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import { fetchNbaMarkets } from "@/lib/kalshi-api";
import { hasKalshiKeys } from "@/lib/kalshi-crypto";
import { matchPredictionsToMarkets, type Prediction } from "@/lib/matcher";
import { loadTerminalSettings } from "@/lib/terminal-settings";
import { getTodayEastern, toGameDate } from "@/lib/dates";
import type { MatchedGame, PredictionDisplay, TerminalSettings } from "@/lib/types";
import TerminalGameRow from "./TerminalGameRow";

const PREDICTION_COLS = [
  "GAME_ID",
  "GAME_DATE",
  "HOME_NAME",
  "AWAY_NAME",
  "PREDICTION",
  "PREDICTION_PCT",
  "GAME_STATUS",
  "GAME_OUTCOME",
].join(",");

export default function TerminalManual() {
  // Section 1: Predictions from Supabase
  const [predictions, setPredictions] = useState<PredictionDisplay[]>([]);
  const [rawPredictions, setRawPredictions] = useState<Prediction[]>([]);
  const [predsLoading, setPredsLoading] = useState(true);
  const [predsError, setPredsError] = useState<string | null>(null);

  // Section 2: Matched Kalshi markets
  const [markets, setMarkets] = useState<MatchedGame[]>([]);
  const [marketsLoading, setMarketsLoading] = useState(true);
  const [marketsError, setMarketsError] = useState<string | null>(null);

  // Settings
  const [settings, setSettings] = useState<TerminalSettings>({
    edgeThreshold: 10,
    sizingMode: "contracts",
    betAmount: 10,
  });

  // Fetch predictions from Supabase (no Kalshi auth needed)
  const fetchPredictions = useCallback(async () => {
    setPredsLoading(true);
    setPredsError(null);

    try {
      const today = getTodayEastern();
      const gameDate = toGameDate(today);

      const { data, error } = await supabase
        .from("gamelogs")
        .select(PREDICTION_COLS)
        .eq("GAME_DATE", gameDate)
        .not("PREDICTION", "is", null)
        .order("GAME_ID", { ascending: true });

      if (error) throw new Error(error.message);

      const rows = (data ?? []) as unknown as Prediction[];
      setRawPredictions(rows);

      // Convert to display format
      const display: PredictionDisplay[] = rows
        .filter((r) => r.PREDICTION !== null && r.PREDICTION_PCT !== null)
        .map((r) => ({
          gameId: r.GAME_ID,
          homeName: r.HOME_NAME,
          awayName: r.AWAY_NAME,
          predictedWinner:
            r.PREDICTION === 1 ? r.HOME_NAME : r.AWAY_NAME,
          winProbability:
            r.PREDICTION === 1
              ? r.PREDICTION_PCT!
              : 1 - r.PREDICTION_PCT!,
          gameStatus: r.GAME_STATUS,
        }));

      setPredictions(display);
    } catch (e) {
      setPredsError(String(e));
      setPredictions([]);
      setRawPredictions([]);
    }

    setPredsLoading(false);
  }, []);

  // Fetch matched markets from Kalshi (needs auth)
  const fetchMarkets = useCallback(async () => {
    setMarketsLoading(true);
    setMarketsError(null);

    const keysReady = await hasKalshiKeys();
    if (!keysReady) {
      setMarketsError("Kalshi API keys not configured. Go to Settings.");
      setMarketsLoading(false);
      return;
    }

    try {
      // Wait for predictions to be fetched first if needed
      let preds = rawPredictions;
      if (preds.length === 0) {
        const today = getTodayEastern();
        const gameDate = toGameDate(today);
        const { data } = await supabase
          .from("gamelogs")
          .select(PREDICTION_COLS)
          .eq("GAME_DATE", gameDate)
          .not("PREDICTION", "is", null)
          .order("GAME_ID", { ascending: true });
        preds = (data ?? []) as unknown as Prediction[];
      }

      const kalshiMarkets = await Promise.race([
        fetchNbaMarkets(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Request timed out")), 15000)
        ),
      ]);

      const matched = matchPredictionsToMarkets(preds, kalshiMarkets);
      setMarkets(matched);
    } catch (e) {
      setMarketsError(String(e));
      setMarkets([]);
    }

    setMarketsLoading(false);
  }, [rawPredictions]);

  useEffect(() => {
    setSettings(loadTerminalSettings());
    fetchPredictions();
  }, [fetchPredictions]);

  // Fetch markets after predictions are loaded
  useEffect(() => {
    if (!predsLoading) {
      fetchMarkets();
    }
  }, [predsLoading, fetchMarkets]);

  const refreshAll = () => {
    fetchPredictions();
    // Markets will refresh via the useEffect above
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="font-mono text-xl font-bold tracking-wider text-white">
          Manual Trading
        </h1>
        <button
          onClick={refreshAll}
          disabled={predsLoading && marketsLoading}
          className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-xs font-medium text-neutral-300 transition-all hover:border-neutral-500 hover:text-white disabled:opacity-50"
        >
          {predsLoading && marketsLoading ? "Loading..." : "Refresh"}
        </button>
      </div>

      {/* ─── SECTION 1: Today's Predictions ─── */}
      <div>
        <h2 className="text-xs uppercase tracking-wider text-neutral-500 font-semibold mb-3">
          Today&apos;s Predictions
          <span className="text-neutral-600 font-normal ml-1">
            — from model
          </span>
        </h2>

        {predsError && (
          <div className="mb-3 rounded-md border border-red-800/40 bg-red-900/20 p-3 text-sm text-red-400">
            {predsError}
          </div>
        )}

        {predsLoading ? (
          <div className="space-y-2">
            {[...Array(3)].map((_, i) => (
              <div
                key={i}
                className="h-16 animate-pulse rounded-lg bg-neutral-800/50"
              />
            ))}
          </div>
        ) : predictions.length === 0 ? (
          <div className="rounded-lg border border-neutral-800 bg-neutral-900/40 py-10 text-center text-sm text-neutral-600">
            No predictions for today. Games will appear here once the model
            runs.
          </div>
        ) : (
          <div className="space-y-2">
            {predictions.map((pred) => (
              <div
                key={pred.gameId}
                className="rounded-lg border border-neutral-800 bg-neutral-900/60 p-4"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-neutral-300">
                      {pred.awayName}
                    </span>
                    <span className="text-neutral-600">@</span>
                    <span className="text-sm font-medium text-neutral-300">
                      {pred.homeName}
                    </span>
                    {pred.gameStatus === 1 && (
                      <span className="rounded bg-blue-900/40 border border-blue-800/30 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-blue-400">
                        Upcoming
                      </span>
                    )}
                    {pred.gameStatus === 2 && (
                      <span className="rounded bg-green-900/40 border border-green-800/30 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-green-400">
                        Live
                      </span>
                    )}
                    {(pred.gameStatus === 3 || pred.gameStatus === 4) && (
                      <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-neutral-500">
                        Final
                      </span>
                    )}
                  </div>
                </div>
                <div className="mt-2 flex items-center gap-4 text-sm">
                  <div className="flex items-center gap-2">
                    <span className="text-xs uppercase tracking-wider text-neutral-600">
                      Pick
                    </span>
                    <span className="font-semibold text-white">
                      {pred.predictedWinner.split(" ").pop()}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs uppercase tracking-wider text-neutral-600">
                      Model
                    </span>
                    <span className="font-mono text-white">
                      {Math.round(pred.winProbability * 100)}%
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ─── SECTION 2: Kalshi Markets ─── */}
      <div>
        <h2 className="text-xs uppercase tracking-wider text-neutral-500 font-semibold mb-3">
          Kalshi Markets
          <span className="text-neutral-600 font-normal ml-1">
            — place bets
          </span>
        </h2>

        {marketsError && (
          <div className="mb-3 rounded-md border border-red-800/40 bg-red-900/20 p-3 text-sm text-red-400">
            {marketsError}
          </div>
        )}

        {marketsLoading ? (
          <div className="space-y-2">
            {[...Array(3)].map((_, i) => (
              <div
                key={i}
                className="h-20 animate-pulse rounded-lg bg-neutral-800/50"
              />
            ))}
          </div>
        ) : markets.length === 0 ? (
          <div className="rounded-lg border border-neutral-800 bg-neutral-900/40 py-10 text-center text-sm text-neutral-600">
            No live NBA markets on Kalshi right now.
          </div>
        ) : (
          <div className="space-y-2">
            {markets.map((game) => (
              <TerminalGameRow
                key={game.marketTicker}
                game={game}
                sizingMode={settings.sizingMode}
                betAmount={settings.betAmount}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
