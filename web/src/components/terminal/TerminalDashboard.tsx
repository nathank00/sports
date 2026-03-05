"use client";

import { useEffect, useState } from "react";
import { fetchBalance, fetchPositions, fetchSettlements, fetchNbaMarkets } from "@/lib/kalshi-api";
import { hasKalshiKeys } from "@/lib/kalshi-crypto";
import { ABBR_TO_TEAM, tickerTeamSuffix } from "@/lib/matcher";
import type { KalshiMarket, PositionItem, SettlementItem } from "@/lib/types";

function parseTeamFromTicker(ticker: string): string | null {
  const suffix = tickerTeamSuffix(ticker);
  return ABBR_TO_TEAM[suffix] || null;
}

interface TerminalDashboardProps {
  onNavigate: (tab: "dashboard" | "manual" | "settings") => void;
}

/** Get today's date in YYYY-MM-DD format (ET timezone). */
function getTodayET(): string {
  return new Date().toLocaleDateString("en-CA", {
    timeZone: "America/New_York",
  });
}

/**
 * Convert a YYYY-MM-DD date string to start/end Unix timestamps (seconds).
 * Uses the 7 AM ET game day boundary.
 * Kalshi's settlements API expects min_ts/max_ts as integer epoch seconds.
 */
function dateToRange(dateStr: string): { minTs: string; maxTs: string } {
  // Parse date and compute 7 AM ET on that day as a UTC epoch
  const d = new Date(dateStr + "T00:00:00");

  // Get the ET → UTC offset for this date (handles EST/EDT automatically)
  const etParts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
  }).formatToParts(d);

  const etHour = parseInt(
    etParts.find((p) => p.type === "hour")!.value
  );
  const utcHour = d.getUTCHours();
  const etOffsetHours = (utcHour - etHour + 24) % 24; // 5 for EST, 4 for EDT

  // 7 AM ET on the selected date in UTC
  const startUTC = new Date(d);
  startUTC.setUTCHours(7 + etOffsetHours, 0, 0, 0);

  // 7 AM ET on the next day in UTC
  const endUTC = new Date(startUTC);
  endUTC.setUTCDate(endUTC.getUTCDate() + 1);

  // Kalshi expects Unix epoch seconds (integers), not ISO strings
  const minTs = Math.floor(startUTC.getTime() / 1000).toString();
  const maxTs = Math.floor(endUTC.getTime() / 1000).toString();
  return { minTs, maxTs };
}

export default function TerminalDashboard({ onNavigate }: TerminalDashboardProps) {
  const [balance, setBalance] = useState(0);
  const [portfolioValue, setPortfolioValue] = useState(0);
  const [positions, setPositions] = useState<PositionItem[]>([]);
  const [settlements, setSettlements] = useState<SettlementItem[]>([]);
  /** Current market bid prices keyed by ticker — used for live P&L. */
  const [marketPrices, setMarketPrices] = useState<Map<string, number>>(new Map());
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [positionsOpen, setPositionsOpen] = useState(true);
  const [settlementsOpen, setSettlementsOpen] = useState(true);
  const [selectedDate, setSelectedDate] = useState(getTodayET());
  const [settlementsLoading, setSettlementsLoading] = useState(false);

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
      const [balData, posData, marketsData] = await Promise.all([
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
        Promise.race([
          fetchNbaMarkets(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("Request timed out")), 10000)
          ),
        ]).catch(() => [] as KalshiMarket[]),
      ]);

      setBalance(balData.balance);
      setPortfolioValue(balData.portfolioValue);
      setPositions(posData);

      // Build ticker → yesBid map for live P&L calculation
      const priceMap = new Map<string, number>();
      for (const m of marketsData) {
        if (m.yesBid != null) {
          priceMap.set(m.ticker, m.yesBid);
        }
      }
      setMarketPrices(priceMap);

      setConnected(true);
    } catch (e) {
      setConnected(false);
      setError(String(e));
    }

    setLoading(false);
  };

  const fetchSettlementsForDate = async (dateStr: string) => {
    setSettlementsLoading(true);
    try {
      const { minTs, maxTs } = dateToRange(dateStr);
      const data = await fetchSettlements(minTs, maxTs);
      setSettlements(data);
    } catch (e) {
      console.error("Failed to fetch settlements:", e);
      setSettlements([]);
    }
    setSettlementsLoading(false);
  };

  useEffect(() => {
    fetchData();
  }, []);

  // Refresh positions + balance every 15s
  useEffect(() => {
    if (!connected) return;
    const interval = setInterval(async () => {
      try {
        const [balData, posData] = await Promise.all([
          fetchBalance(),
          fetchPositions(),
        ]);
        setBalance(balData.balance);
        setPortfolioValue(balData.portfolioValue);
        setPositions(posData);
      } catch (e) {
        console.error("Position refresh failed:", e);
      }
    }, 15_000);
    return () => clearInterval(interval);
  }, [connected]);

  // Refresh market prices every 3s for near-real-time P&L
  useEffect(() => {
    if (!connected) return;
    const interval = setInterval(async () => {
      try {
        const marketsData = await fetchNbaMarkets();
        const priceMap = new Map<string, number>();
        for (const m of marketsData) {
          if (m.yesBid != null) {
            priceMap.set(m.ticker, m.yesBid);
          }
        }
        setMarketPrices(priceMap);
      } catch {
        // Silently skip — stale prices are fine for a few seconds
      }
    }, 3_000);
    return () => clearInterval(interval);
  }, [connected]);

  // Fetch settlements when date changes or when connected
  useEffect(() => {
    if (connected) {
      fetchSettlementsForDate(selectedDate);
    }
  }, [selectedDate, connected]);

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

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="rounded-lg border border-neutral-800 bg-neutral-900/60 p-4">
          <div className="text-xs uppercase tracking-wider text-neutral-500 mb-1">
            Total Value
          </div>
          <div className="font-mono text-2xl font-bold text-white">
            ${(balance + portfolioValue).toFixed(2)}
          </div>
        </div>

        <div className="rounded-lg border border-neutral-800 bg-neutral-900/60 p-4">
          <div className="text-xs uppercase tracking-wider text-neutral-500 mb-1">
            Cash
          </div>
          <div className="font-mono text-2xl font-bold text-white">
            ${balance.toFixed(2)}
          </div>
        </div>

        <div className="rounded-lg border border-neutral-800 bg-neutral-900/60 p-4">
          <div className="text-xs uppercase tracking-wider text-neutral-500 mb-1">
            Portfolio
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
              Positions
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
          <div className="px-4 py-3 border-b border-neutral-800/60 flex items-center justify-between">
            <h2 className="text-xs uppercase tracking-wider text-neutral-500 font-semibold">
              Open Positions
            </h2>
            {positions.length > 0 && (() => {
              const totalCostBasis = positions.reduce((s, p) => s + p.totalTraded, 0);
              const totalMarketValue = positions.reduce((s, p) => {
                const qty = Math.abs(p.position);
                const bid = marketPrices.get(p.ticker);
                return s + (bid != null ? qty * bid : p.totalTraded);
              }, 0);
              const totalPnl = totalMarketValue - totalCostBasis;

              return (
                <div className="flex items-center gap-3 text-[10px]">
                  <span className="text-neutral-500">
                    Cost Basis: ${totalCostBasis.toFixed(2)}
                  </span>
                  <span
                    className={`font-mono font-medium ${
                      totalPnl >= 0 ? "text-green-400" : "text-red-400"
                    }`}
                  >
                    Unrealized P&L:{" "}
                    {totalPnl >= 0 ? "+" : ""}
                    ${totalPnl.toFixed(2)}
                  </span>
                </div>
              );
            })()}
          </div>
          {positions.length === 0 ? (
            <div className="px-4 py-6 text-center text-sm text-neutral-600">
              No open positions
            </div>
          ) : (
            <>
              {/* Column headers */}
              <div className="px-4 py-1.5 border-b border-neutral-800/40 grid grid-cols-12 gap-2 text-[10px] text-neutral-600 uppercase tracking-wider">
                <span className="col-span-4">Position</span>
                <span className="col-span-2 text-right">Qty</span>
                <span className="col-span-2 text-right">Avg Cost</span>
                <span className="col-span-2 text-right">Mkt Value</span>
                <span className="col-span-2 text-right">Unrealized P&L</span>
              </div>
              <div className="divide-y divide-neutral-800/60">
                {positions.map((pos) => {
                  const teamName = parseTeamFromTicker(pos.ticker);
                  const qty = Math.abs(pos.position);
                  const avgCost = qty > 0 ? pos.totalTraded / qty : 0;
                  const costBasis = pos.totalTraded;
                  // Use live market bid price for valuation (what we could sell at)
                  const currentBid = marketPrices.get(pos.ticker);
                  const marketValue = currentBid != null ? qty * currentBid : null;
                  const unrealizedPnl = marketValue != null ? marketValue - costBasis : null;
                  const unrealizedPct =
                    costBasis > 0 && unrealizedPnl != null
                      ? (unrealizedPnl / costBasis) * 100
                      : null;

                  return (
                    <div
                      key={pos.ticker}
                      className="px-4 py-3 hover:bg-neutral-800/30 transition-colors"
                    >
                      <div className="grid grid-cols-12 gap-2 items-center">
                        {/* Position name */}
                        <div className="col-span-4 min-w-0">
                          <span className="text-sm font-medium text-neutral-100">
                            {teamName || pos.ticker.split("-").pop()}
                          </span>
                          <div className="text-[10px] text-neutral-600 font-mono truncate">
                            {pos.ticker}
                          </div>
                        </div>

                        {/* Qty */}
                        <div className="col-span-2 text-right">
                          <span className="text-sm font-mono text-neutral-200">
                            {qty}
                          </span>
                        </div>

                        {/* Avg Cost */}
                        <div className="col-span-2 text-right">
                          <span className="text-sm font-mono text-neutral-200">
                            {(avgCost * 100).toFixed(0)}c
                          </span>
                          <div className="text-[10px] text-neutral-600 font-mono">
                            ${costBasis.toFixed(2)}
                          </div>
                        </div>

                        {/* Market Value */}
                        <div className="col-span-2 text-right">
                          {marketValue != null ? (
                            <>
                              <span className="text-sm font-mono text-neutral-200">
                                ${marketValue.toFixed(2)}
                              </span>
                              {qty > 0 && currentBid != null && (
                                <div className="text-[10px] text-neutral-600 font-mono">
                                  {(currentBid * 100).toFixed(0)}c/ea
                                </div>
                              )}
                            </>
                          ) : (
                            <span className="text-sm font-mono text-neutral-600">
                              —
                            </span>
                          )}
                        </div>

                        {/* Unrealized P&L */}
                        <div className="col-span-2 text-right">
                          {unrealizedPnl != null && unrealizedPct != null ? (
                            <>
                              <span
                                className={`text-sm font-mono font-medium ${
                                  unrealizedPnl >= 0
                                    ? "text-green-400"
                                    : "text-red-400"
                                }`}
                              >
                                {unrealizedPnl >= 0 ? "+" : ""}
                                ${unrealizedPnl.toFixed(2)}
                              </span>
                              <div
                                className={`text-[10px] font-mono ${
                                  unrealizedPct >= 0
                                    ? "text-green-600"
                                    : "text-red-600"
                                }`}
                              >
                                {unrealizedPct >= 0 ? "+" : ""}
                                {unrealizedPct.toFixed(1)}%
                              </div>
                            </>
                          ) : (
                            <span className="text-sm font-mono text-neutral-600">
                              —
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}

      {/* Settlements / History */}
      <div className="rounded-lg border border-neutral-800 bg-neutral-900/60 overflow-hidden">
        <div className="px-4 py-3 border-b border-neutral-800/60">
          <div className="flex items-center justify-between">
            <button
              onClick={() => setSettlementsOpen(!settlementsOpen)}
              className="flex items-center gap-2"
            >
              <h2 className="text-xs uppercase tracking-wider text-neutral-500 font-semibold">
                History
              </h2>
              <svg
                className={`w-3 h-3 text-neutral-500 transition-transform ${
                  settlementsOpen ? "rotate-180" : ""
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
            </button>
            <div className="flex items-center gap-2">
              <button
                onClick={() => {
                  const d = new Date(selectedDate);
                  d.setDate(d.getDate() - 1);
                  setSelectedDate(d.toISOString().split("T")[0]);
                }}
                className="text-neutral-500 hover:text-neutral-300 px-1"
              >
                &larr;
              </button>
              <input
                type="date"
                value={selectedDate}
                onChange={(e) => setSelectedDate(e.target.value)}
                max={getTodayET()}
                className="bg-neutral-800 border border-neutral-700 rounded px-2 py-1 text-xs text-white font-mono"
              />
              <button
                onClick={() => {
                  const d = new Date(selectedDate);
                  d.setDate(d.getDate() + 1);
                  const today = getTodayET();
                  const next = d.toISOString().split("T")[0];
                  if (next <= today) setSelectedDate(next);
                }}
                disabled={selectedDate >= getTodayET()}
                className="text-neutral-500 hover:text-neutral-300 px-1 disabled:opacity-30 disabled:cursor-not-allowed"
              >
                &rarr;
              </button>
            </div>
          </div>
        </div>

        {settlementsOpen && (
          <>
            {settlementsLoading ? (
              <div className="px-4 py-6 text-center text-sm text-neutral-600">
                Loading...
              </div>
            ) : settlements.length === 0 ? (
              <div className="px-4 py-6 text-center text-sm text-neutral-600">
                No settled positions for this date
              </div>
            ) : (
              <>
                {/* Summary row */}
                <div className="px-4 py-2 border-b border-neutral-800/60 flex items-center justify-between text-xs">
                  <span className="text-neutral-500">
                    {settlements.length} settlement
                    {settlements.length !== 1 ? "s" : ""}
                  </span>
                  <div className="flex items-center gap-3">
                    <span
                      className={`font-mono font-medium ${
                        settlements.reduce((s, t) => s + t.revenue, 0) >= 0
                          ? "text-green-400"
                          : "text-red-400"
                      }`}
                    >
                      {settlements.reduce((s, t) => s + t.revenue, 0) >= 0
                        ? "+"
                        : ""}
                      $
                      {Math.abs(
                        settlements.reduce((s, t) => s + t.revenue, 0)
                      ).toFixed(2)}{" "}
                      net
                    </span>
                    <span className="text-neutral-600">
                      ${settlements
                        .reduce((s, t) => s + t.feesPaid, 0)
                        .toFixed(2)}{" "}
                      fees
                    </span>
                  </div>
                </div>

                <div className="divide-y divide-neutral-800/60">
                  {settlements.map((s, i) => {
                    const teamName = parseTeamFromTicker(s.ticker);
                    const contracts = s.yesCount + s.noCount;
                    const won = s.revenue > 0;
                    return (
                      <div
                        key={`${s.ticker}-${i}`}
                        className="px-4 py-3 hover:bg-neutral-800/30 transition-colors"
                      >
                        <div className="flex items-center justify-between mb-1">
                          <div className="min-w-0">
                            <span className="text-sm font-medium text-neutral-100">
                              {teamName || s.ticker}
                            </span>
                            <span
                              className={`ml-2 text-[10px] font-medium px-1.5 py-0.5 rounded ${
                                won
                                  ? "bg-green-900/40 text-green-400"
                                  : "bg-red-900/40 text-red-400"
                              }`}
                            >
                              {won ? "WON" : "LOST"}
                            </span>
                          </div>
                          <span
                            className={`text-sm font-mono font-medium shrink-0 ml-3 ${
                              s.revenue >= 0
                                ? "text-green-400"
                                : "text-red-400"
                            }`}
                          >
                            {s.revenue >= 0 ? "+" : "-"}$
                            {Math.abs(s.revenue).toFixed(2)}
                          </span>
                        </div>
                        <div className="flex gap-4 text-[10px] text-neutral-500">
                          <span>
                            {contracts} contract{contracts !== 1 ? "s" : ""}
                          </span>
                          <span>Result: {s.marketResult.toUpperCase()}</span>
                          <span>
                            {new Date(s.settledTime).toLocaleTimeString(
                              "en-US",
                              {
                                hour: "numeric",
                                minute: "2-digit",
                                timeZone: "America/New_York",
                              }
                            )}
                          </span>
                          {s.feesPaid > 0 && (
                            <span>Fee: ${s.feesPaid.toFixed(2)}</span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
