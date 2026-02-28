"use client";

import { useState } from "react";
import { placeOrder } from "@/lib/kalshi-api";
import type { SizingMode } from "@/lib/types";
import { computeContractCount } from "@/lib/terminal-settings";

interface MarketData {
  marketTicker: string;
  marketTitle: string;
  marketImpliedProb: number;
  edge: number;
  yesAsk: number | null;
  noAsk: number | null;
  betSide: string;
}

interface TerminalGameRowProps {
  gameId: number;
  awayName: string;
  homeName: string;
  predictedWinner: string;
  modelProb: number;
  gameStatus: number;
  market: MarketData | null;
  sizingMode: SizingMode;
  betAmount: number;
}

export default function TerminalGameRow({
  awayName,
  homeName,
  predictedWinner,
  modelProb,
  gameStatus,
  market,
  sizingMode,
  betAmount,
}: TerminalGameRowProps) {
  const [inputAmount, setInputAmount] = useState(betAmount);
  const [inputMode, setInputMode] = useState<SizingMode>(sizingMode);
  const [showBetForm, setShowBetForm] = useState(false);
  const [placing, setPlacing] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const price = market
    ? market.betSide === "yes"
      ? market.yesAsk
      : market.noAsk
    : null;

  const contractCount = price
    ? computeContractCount(
        { edgeThreshold: 0, sizingMode: inputMode, betAmount: inputAmount },
        price,
      )
    : 0;

  const totalCost = price ? contractCount * price : 0;
  const isContracts = inputMode === "contracts";

  const handleBet = async () => {
    if (!market || !price) return;
    setPlacing(true);
    setResult(null);
    try {
      const res = await placeOrder(
        market.marketTicker,
        market.betSide as "yes" | "no",
        contractCount,
        price.toFixed(2),
      );
      setResult(`Order ${res.orderId} — ${res.status}`);
      setShowBetForm(false);
    } catch (e) {
      setResult(`Error: ${e}`);
    }
    setPlacing(false);
  };

  const edgeColor = market
    ? market.edge >= 10
      ? "text-green-400"
      : market.edge >= 5
        ? "text-emerald-400"
        : market.edge > 0
          ? "text-neutral-300"
          : "text-red-400"
    : "";

  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900/60 p-4 transition-colors hover:border-neutral-700">
      {/* Main row: left prediction | right market */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-0">
        {/* ── Left: Prediction ── */}
        <div className="flex min-w-0 flex-1 flex-col gap-2 sm:border-r sm:border-neutral-800/60 sm:pr-5">
          {/* Matchup */}
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-neutral-300">
              {awayName}
            </span>
            <span className="shrink-0 text-neutral-600">@</span>
            <span className="truncate text-sm font-medium text-neutral-300">
              {homeName}
            </span>
          </div>
          {/* Pick + Model */}
          <div className="flex items-center gap-4 text-sm">
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] uppercase tracking-wider text-neutral-600">
                Pick
              </span>
              <span className="font-semibold text-white">
                {predictedWinner.split(" ").pop()}
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] uppercase tracking-wider text-neutral-600">
                Model
              </span>
              <span className="font-mono text-white">
                {Math.round(modelProb * 100)}%
              </span>
            </div>
          </div>
        </div>

        {/* ── Right: Market ── */}
        {market ? (
          <div className="flex items-center gap-4 sm:pl-5">
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] uppercase tracking-wider text-neutral-600">
                Market
              </span>
              <span className="font-mono text-sm text-neutral-400">
                {Math.round(market.marketImpliedProb * 100)}%
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] uppercase tracking-wider text-neutral-600">
                Edge
              </span>
              <span className={`font-mono text-sm font-bold ${edgeColor}`}>
                {market.edge >= 0 ? "+" : ""}
                {market.edge.toFixed(1)}%
              </span>
            </div>

            {/* Bet button / form */}
            {!showBetForm ? (
              <button
                onClick={() => setShowBetForm(true)}
                className="ml-auto rounded-md border border-neutral-700 bg-neutral-800 px-3 py-1 text-xs font-medium text-neutral-300 transition-all hover:border-neutral-500 hover:text-white sm:ml-2"
              >
                Bet
              </button>
            ) : (
              <div className="ml-auto flex items-center gap-2 sm:ml-2">
                <button
                  onClick={() =>
                    setInputMode(isContracts ? "dollars" : "contracts")
                  }
                  className="rounded border border-neutral-700 bg-neutral-900 px-1.5 py-1 text-[10px] font-medium text-neutral-400 hover:text-neutral-200"
                  title={
                    isContracts ? "Switch to dollars" : "Switch to contracts"
                  }
                >
                  {isContracts ? "CTR" : "$"}
                </button>
                <div className="relative">
                  {!isContracts && (
                    <span className="absolute left-1.5 top-1/2 -translate-y-1/2 text-[10px] text-neutral-500">
                      $
                    </span>
                  )}
                  <input
                    type="number"
                    min={1}
                    value={inputAmount}
                    onChange={(e) => setInputAmount(Number(e.target.value))}
                    className={`w-14 rounded border border-neutral-700 bg-neutral-900 py-1 text-xs text-neutral-100 outline-none focus:border-neutral-500 ${
                      !isContracts ? "pl-4 pr-1" : "px-2"
                    }`}
                  />
                </div>
                <span className="whitespace-nowrap text-[10px] text-neutral-500">
                  {isContracts
                    ? `$${totalCost.toFixed(2)}`
                    : `x${contractCount}`}
                </span>
                <button
                  onClick={handleBet}
                  disabled={placing || contractCount === 0}
                  className="rounded-md bg-green-800/60 px-3 py-1 text-xs font-medium text-green-300 transition-all hover:bg-green-800 disabled:opacity-50"
                >
                  {placing ? "..." : "Confirm"}
                </button>
                <button
                  onClick={() => setShowBetForm(false)}
                  className="text-xs text-neutral-500 hover:text-neutral-300"
                >
                  ✕
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className="sm:pl-5">
            <span className="text-xs text-neutral-700">
              No matching market
            </span>
          </div>
        )}
      </div>

      {/* Order result */}
      {result && (
        <div
          className={`mt-2 text-xs ${
            result.startsWith("Error") ? "text-red-400" : "text-green-400"
          }`}
        >
          {result}
        </div>
      )}
    </div>
  );
}
