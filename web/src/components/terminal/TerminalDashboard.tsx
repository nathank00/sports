"use client";

import { useEffect, useState } from "react";
import { fetchBalance, fetchPositions } from "@/lib/kalshi-api";
import { hasKalshiKeys } from "@/lib/kalshi-crypto";
import type { PositionItem } from "@/lib/types";

interface TerminalDashboardProps {
  onNavigate: (tab: "dashboard" | "manual" | "settings") => void;
}

export default function TerminalDashboard({ onNavigate }: TerminalDashboardProps) {
  const [balance, setBalance] = useState(0);
  const [portfolioValue, setPortfolioValue] = useState(0);
  const [positions, setPositions] = useState<PositionItem[]>([]);
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [positionsOpen, setPositionsOpen] = useState(false);

  const fetchData = async () => {
    setLoading(true);
    setError(null);

    // Check if keys are configured first
    const keysReady = await hasKalshiKeys();
    if (!keysReady) {
      setConnected(false);
      setLoading(false);
      return;
    }

    try {
      const [balData, posData] = await Promise.all([
        Promise.race([
          fetchBalance(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("Request timed out")), 10000)
          ),
        ]),
        Promise.race([
          fetchPositions(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("Request timed out")), 10000)
          ),
        ]),
      ]);

      setBalance(balData.balance);
      setPortfolioValue(balData.portfolioValue);
      setPositions(posData);
      setConnected(true);
    } catch (e) {
      setConnected(false);
      setError(String(e));
    }

    setLoading(false);
  };

  useEffect(() => {
    fetchData();
  }, []);

  if (loading) {
    return (
      <div className="space-y-4">
        {[...Array(3)].map((_, i) => (
          <div
            key={i}
            className="h-20 animate-pulse rounded-lg bg-neutral-800/50"
          />
        ))}
      </div>
    );
  }

  if (!connected) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[50vh] text-center px-6">
        <div className="rounded-full bg-neutral-800/50 p-4 mb-4">
          <svg
            className="w-8 h-8 text-neutral-500"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m9.86-2.813a4.5 4.5 0 00-6.364-6.364L4.5 8.25"
            />
          </svg>
        </div>
        <h2 className="text-lg font-semibold text-neutral-300 mb-2">
          Not Connected
        </h2>
        <p className="text-sm text-neutral-500 mb-1 max-w-xs">
          {error || "Configure your Kalshi API key to get started."}
        </p>
        <button
          onClick={() => onNavigate("settings")}
          className="mt-4 rounded-lg border border-neutral-700 bg-neutral-900 px-5 py-2 text-sm font-medium text-white transition-all hover:border-neutral-500 hover:bg-neutral-800"
        >
          Go to Settings
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between mb-2">
        <h1 className="font-mono text-xl font-bold tracking-wider text-white">
          Account Overview
        </h1>
        <button
          onClick={fetchData}
          className="text-xs text-neutral-500 hover:text-neutral-300 transition-colors"
        >
          Refresh
        </button>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <div className="rounded-lg border border-neutral-800 bg-neutral-900/60 p-4">
          <div className="text-xs uppercase tracking-wider text-neutral-500 mb-1">
            Cash Balance
          </div>
          <div className="font-mono text-2xl font-bold text-white">
            ${balance.toFixed(2)}
          </div>
        </div>

        <div className="rounded-lg border border-neutral-800 bg-neutral-900/60 p-4">
          <div className="text-xs uppercase tracking-wider text-neutral-500 mb-1">
            Portfolio Value
          </div>
          <div className="font-mono text-2xl font-bold text-white">
            ${portfolioValue.toFixed(2)}
          </div>
        </div>

        <button
          onClick={() => setPositionsOpen(!positionsOpen)}
          className="rounded-lg border border-neutral-800 bg-neutral-900/60 p-4 text-left transition-colors hover:border-neutral-700"
        >
          <div className="flex items-center justify-between">
            <div className="text-xs uppercase tracking-wider text-neutral-500 mb-1">
              Active Positions
            </div>
            <svg
              className={`w-3.5 h-3.5 text-neutral-500 transition-transform ${
                positionsOpen ? "rotate-180" : ""
              }`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M19 9l-7 7-7-7"
              />
            </svg>
          </div>
          <div className="font-mono text-2xl font-bold text-white">
            {positions.length}
          </div>
        </button>
      </div>

      {/* Positions dropdown */}
      {positionsOpen && (
        <div className="rounded-lg border border-neutral-800 bg-neutral-900/60 overflow-hidden">
          <div className="px-4 py-3 border-b border-neutral-800/60">
            <h2 className="text-xs uppercase tracking-wider text-neutral-500 font-semibold">
              Positions
            </h2>
          </div>
          {positions.length === 0 ? (
            <div className="px-4 py-6 text-center text-sm text-neutral-600">
              No active positions
            </div>
          ) : (
            <div className="divide-y divide-neutral-800/60">
              {/* Header row */}
              <div className="grid grid-cols-4 gap-2 px-4 py-2 text-[10px] uppercase tracking-wider text-neutral-600">
                <div>Ticker</div>
                <div className="text-right">Exposure</div>
                <div className="text-right">Traded</div>
                <div className="text-right">Resting</div>
              </div>
              {positions.map((pos) => (
                <div
                  key={pos.ticker}
                  className="grid grid-cols-4 gap-2 px-4 py-2.5 text-sm hover:bg-neutral-800/30 transition-colors"
                >
                  <div
                    className="font-mono text-xs text-neutral-200 truncate"
                    title={pos.ticker}
                  >
                    {pos.ticker}
                  </div>
                  <div
                    className={`text-right font-mono text-xs ${
                      pos.exposure >= 0 ? "text-green-400" : "text-red-400"
                    }`}
                  >
                    ${Math.abs(pos.exposure).toFixed(2)}
                  </div>
                  <div className="text-right font-mono text-xs text-neutral-400">
                    ${pos.totalTraded.toFixed(2)}
                  </div>
                  <div className="text-right font-mono text-xs text-neutral-500">
                    {pos.restingOrders}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
