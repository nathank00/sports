"use client";

import { useState } from "react";
import { placeOrder } from "@/lib/kalshi-api";
import type { MatchedGame, SizingMode } from "@/lib/types";
import { computeContractCount } from "@/lib/terminal-settings";

interface TerminalGameRowProps {
  game: MatchedGame;
  sizingMode: SizingMode;
  betAmount: number;
}

export default function TerminalGameRow({
  game,
  sizingMode,
  betAmount,
}: TerminalGameRowProps) {
  const [inputAmount, setInputAmount] = useState(betAmount);
  const [inputMode, setInputMode] = useState<SizingMode>(sizingMode);
  const [showBetForm, setShowBetForm] = useState(false);
  const [placing, setPlacing] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const price = game.betSide === "yes" ? game.yesAsk : game.noAsk;

  const contractCount = price
    ? computeContractCount(
        { edgeThreshold: 0, sizingMode: inputMode, betAmount: inputAmount },
        price
      )
    : 0;

  const totalCost = price ? contractCount * price : 0;

  const handleBet = async () => {
    setPlacing(true);
    setResult(null);
    try {
      if (!price) {
        setResult("No valid price");
        setPlacing(false);
        return;
      }
      const res = await placeOrder(
        game.marketTicker,
        game.betSide as "yes" | "no",
        contractCount,
        price.toFixed(2)
      );
      setResult(`Order ${res.orderId} — ${res.status}`);
      setShowBetForm(false);
    } catch (e) {
      setResult(`Error: ${e}`);
    }
    setPlacing(false);
  };

  const edgeColor =
    game.edge >= 10
      ? "text-green-400"
      : game.edge >= 5
        ? "text-emerald-400"
        : game.edge > 0
          ? "text-neutral-300"
          : "text-red-400";

  const isContracts = inputMode === "contracts";

  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900/60 p-4 transition-colors hover:border-neutral-700">
      {/* Matchup line */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <span className="text-sm font-medium text-neutral-300 truncate">
            {game.awayName}
          </span>
          <span className="text-neutral-600 shrink-0">@</span>
          <span className="text-sm font-medium text-neutral-300 truncate">
            {game.homeName}
          </span>
        </div>
      </div>

      {/* Probability comparison */}
      <div className="mt-2 flex flex-wrap items-center gap-4 text-sm">
        <div className="flex items-center gap-2">
          <span className="text-xs uppercase tracking-wider text-neutral-600">
            Pick
          </span>
          <span className="font-semibold text-white">
            {game.predictedWinner.split(" ").pop()}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs uppercase tracking-wider text-neutral-600">
            Model
          </span>
          <span className="font-mono text-white">
            {Math.round(game.modelProb * 100)}%
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs uppercase tracking-wider text-neutral-600">
            Market
          </span>
          <span className="font-mono text-neutral-400">
            {Math.round(game.marketImpliedProb * 100)}%
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs uppercase tracking-wider text-neutral-600">
            Edge
          </span>
          <span className={`font-mono font-bold ${edgeColor}`}>
            {game.edge >= 0 ? "+" : ""}
            {game.edge.toFixed(1)}%
          </span>
        </div>

        <div className="ml-auto">
          {!showBetForm ? (
            <button
              onClick={() => setShowBetForm(true)}
              className="rounded-md border border-neutral-700 bg-neutral-800 px-3 py-1 text-xs font-medium text-neutral-300 transition-all hover:border-neutral-500 hover:text-white"
            >
              Bet
            </button>
          ) : (
            <div className="flex items-center gap-2">
              {/* Toggle contracts/dollars */}
              <button
                onClick={() =>
                  setInputMode(isContracts ? "dollars" : "contracts")
                }
                className="rounded border border-neutral-700 bg-neutral-900 px-1.5 py-1 text-[10px] font-medium text-neutral-400 hover:text-neutral-200"
                title={isContracts ? "Switch to dollars" : "Switch to contracts"}
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
                  className={`w-16 rounded border border-neutral-700 bg-neutral-900 py-1 text-xs text-neutral-100 outline-none focus:border-neutral-500 ${
                    !isContracts ? "pl-4 pr-1" : "px-2"
                  }`}
                />
              </div>
              {/* Show computed info */}
              <span className="text-[10px] text-neutral-500 whitespace-nowrap">
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
      </div>

      {result && (
        <div
          className={`mt-2 text-xs ${
            result.startsWith("Error")
              ? "text-red-400"
              : "text-green-400"
          }`}
        >
          {result}
        </div>
      )}
    </div>
  );
}
