"use client";

import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import { fetchNbaMarkets, fetchMlbMarkets } from "@/lib/kalshi-api";
import { hasKalshiKeys } from "@/lib/kalshi-crypto";
import { matchPredictionsToMarkets, matchMlbPredictionsToMarkets, type Prediction } from "@/lib/matcher";
import { loadTerminalSettings } from "@/lib/terminal-settings";
import { getTodayEastern, toGameDate } from "@/lib/dates";
import type { MatchedGame, TerminalSettings } from "@/lib/types";
import TerminalGameRow from "./TerminalGameRow";

interface UnifiedGame {
  gameId: number;
  awayName: string;
  homeName: string;
  predictedWinner: string;
  modelProb: number;
  gameStatus: number;
  sport: "NBA" | "MLB";
  market: {
    marketTicker: string;
    marketTitle: string;
    marketImpliedProb: number;
    edge: number;
    yesAsk: number | null;
    noAsk: number | null;
    betSide: string;
  } | null;
}

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
  const [unified, setUnified] = useState<UnifiedGame[]>([]);
  const [loading, setLoading] = useState(true);
  const [predsError, setPredsError] = useState<string | null>(null);
  const [marketsError, setMarketsError] = useState<string | null>(null);

  const [settings, setSettings] = useState<TerminalSettings>({
    edgeThreshold: 10,
    sizingMode: "contracts",
    betAmount: 10,
  });

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setPredsError(null);
    setMarketsError(null);

    // ── Step 1: Fetch NBA + MLB predictions in parallel ──
    let nbaPreds: Prediction[] = [];
    let mlbPreds: Prediction[] = [];
    try {
      const today = getTodayEastern();
      const gameDate = toGameDate(today);

      const [nbaResult, mlbResult] = await Promise.all([
        supabase
          .from("gamelogs")
          .select(PREDICTION_COLS)
          .eq("GAME_DATE", gameDate)
          .not("PREDICTION", "is", null)
          .order("GAME_ID", { ascending: true }),
        supabase
          .from("mlb_gamelogs")
          .select(PREDICTION_COLS)
          .eq("GAME_DATE", gameDate)
          .not("PREDICTION", "is", null)
          .order("GAME_ID", { ascending: true }),
      ]);

      if (nbaResult.error) throw new Error(nbaResult.error.message);
      if (mlbResult.error) throw new Error(mlbResult.error.message);
      nbaPreds = (nbaResult.data ?? []) as unknown as Prediction[];
      mlbPreds = (mlbResult.data ?? []) as unknown as Prediction[];
    } catch (e) {
      setPredsError(String(e));
      setLoading(false);
      return;
    }

    // Build display predictions with sport tag
    const predMap = new Map<
      string,
      {
        gameId: number;
        awayName: string;
        homeName: string;
        predictedWinner: string;
        modelProb: number;
        gameStatus: number;
        sport: "NBA" | "MLB";
      }
    >();

    for (const r of nbaPreds) {
      if (r.PREDICTION === null || r.PREDICTION_PCT === null) continue;
      predMap.set(`nba-${r.GAME_ID}`, {
        gameId: r.GAME_ID,
        awayName: r.AWAY_NAME,
        homeName: r.HOME_NAME,
        predictedWinner: r.PREDICTION === 1 ? r.HOME_NAME : r.AWAY_NAME,
        modelProb:
          r.PREDICTION === 1 ? r.PREDICTION_PCT : 1 - r.PREDICTION_PCT,
        gameStatus: r.GAME_STATUS,
        sport: "NBA",
      });
    }

    for (const r of mlbPreds) {
      if (r.PREDICTION === null || r.PREDICTION_PCT === null) continue;
      predMap.set(`mlb-${r.GAME_ID}`, {
        gameId: r.GAME_ID,
        awayName: r.AWAY_NAME,
        homeName: r.HOME_NAME,
        predictedWinner: r.PREDICTION === 1 ? r.HOME_NAME : r.AWAY_NAME,
        modelProb:
          r.PREDICTION === 1 ? r.PREDICTION_PCT : 1 - r.PREDICTION_PCT,
        gameStatus: r.GAME_STATUS,
        sport: "MLB",
      });
    }

    // ── Step 2: Fetch Kalshi markets for both sports (if keys are configured) ──
    let nbaMatchedMarkets: MatchedGame[] = [];
    let mlbMatchedMarkets: MatchedGame[] = [];
    const keysReady = await hasKalshiKeys();

    if (keysReady) {
      try {
        const [nbaMarkets, mlbMarkets] = await Promise.race([
          Promise.all([fetchNbaMarkets(), fetchMlbMarkets()]),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("Request timed out")), 15000),
          ),
        ]);
        nbaMatchedMarkets = matchPredictionsToMarkets(nbaPreds, nbaMarkets);
        mlbMatchedMarkets = matchMlbPredictionsToMarkets(mlbPreds, mlbMarkets);
      } catch (e) {
        setMarketsError(String(e));
      }
    } else {
      setMarketsError("Kalshi API keys not configured. Go to Settings.");
    }

    // ── Step 3: Merge into unified list ──
    const nbaMarketByGameId = new Map<number, MatchedGame>();
    for (const m of nbaMatchedMarkets) nbaMarketByGameId.set(m.gameId, m);

    const mlbMarketByGameId = new Map<number, MatchedGame>();
    for (const m of mlbMatchedMarkets) mlbMarketByGameId.set(m.gameId, m);

    const merged: UnifiedGame[] = [];
    for (const [, pred] of predMap) {
      const marketMap = pred.sport === "NBA" ? nbaMarketByGameId : mlbMarketByGameId;
      const m = marketMap.get(pred.gameId);
      merged.push({
        ...pred,
        market: m
          ? {
              marketTicker: m.marketTicker,
              marketTitle: m.marketTitle,
              marketImpliedProb: m.marketImpliedProb,
              edge: m.edge,
              yesAsk: m.yesAsk,
              noAsk: m.noAsk,
              betSide: m.betSide,
            }
          : null,
      });
    }

    // Sort: games with markets first (by edge desc), then games without
    merged.sort((a, b) => {
      if (a.market && !b.market) return -1;
      if (!a.market && b.market) return 1;
      if (a.market && b.market) return b.market.edge - a.market.edge;
      return 0;
    });

    setUnified(merged);
    setLoading(false);
  }, []);

  useEffect(() => {
    setSettings(loadTerminalSettings());
    fetchAll();
  }, [fetchAll]);

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="font-mono text-xl font-bold tracking-wider text-white">
          Manual Trading
        </h1>
        <button
          onClick={fetchAll}
          disabled={loading}
          className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-xs font-medium text-neutral-300 transition-all hover:border-neutral-500 hover:text-white disabled:opacity-50"
        >
          {loading ? "Loading..." : "Refresh"}
        </button>
      </div>

      {/* Column header */}
      <div className="hidden items-center px-4 text-[10px] uppercase tracking-[0.15em] text-neutral-700 sm:flex">
        <span className="flex-1 border-r border-neutral-800/60 pr-5">
          Model Prediction
        </span>
        <span className="pl-5">Kalshi Market</span>
      </div>

      {/* Errors */}
      {predsError && (
        <div className="rounded-md border border-red-800/40 bg-red-900/20 p-3 text-sm text-red-400">
          {predsError}
        </div>
      )}
      {marketsError && (
        <div className="rounded-md border border-yellow-800/40 bg-yellow-900/10 p-3 text-sm text-yellow-500/80">
          {marketsError}
        </div>
      )}

      {/* Game rows */}
      {loading ? (
        <div className="space-y-2">
          {[...Array(4)].map((_, i) => (
            <div
              key={i}
              className="h-[72px] animate-pulse rounded-lg bg-neutral-800/50"
            />
          ))}
        </div>
      ) : unified.length === 0 ? (
        <div className="rounded-lg border border-neutral-800 bg-neutral-900/40 py-12 text-center text-sm text-neutral-600">
          No predictions for today. Games will appear here once the model runs.
        </div>
      ) : (
        <div className="space-y-6">
          {/* NBA Section */}
          {unified.some((g) => g.sport === "NBA") && (
            <div className="space-y-2">
              <h2 className="text-xs uppercase tracking-[0.15em] text-neutral-500 font-semibold">
                NBA
              </h2>
              {unified
                .filter((g) => g.sport === "NBA")
                .map((game) => (
                  <TerminalGameRow
                    key={`nba-${game.gameId}`}
                    gameId={game.gameId}
                    awayName={game.awayName}
                    homeName={game.homeName}
                    predictedWinner={game.predictedWinner}
                    modelProb={game.modelProb}
                    gameStatus={game.gameStatus}
                    market={game.market}
                    sizingMode={settings.sizingMode}
                    betAmount={settings.betAmount}
                  />
                ))}
            </div>
          )}

          {/* MLB Section */}
          {unified.some((g) => g.sport === "MLB") && (
            <div className="space-y-2">
              <h2 className="text-xs uppercase tracking-[0.15em] text-neutral-500 font-semibold">
                MLB
              </h2>
              {unified
                .filter((g) => g.sport === "MLB")
                .map((game) => (
                  <TerminalGameRow
                    key={`mlb-${game.gameId}`}
                    gameId={game.gameId}
                    awayName={game.awayName}
                    homeName={game.homeName}
                    predictedWinner={game.predictedWinner}
                    modelProb={game.modelProb}
                    gameStatus={game.gameStatus}
                    market={game.market}
                    sizingMode={settings.sizingMode}
                    betAmount={settings.betAmount}
                  />
                ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
