"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import { placeOrder, fetchPositions } from "@/lib/kalshi-api";
import { hasKalshiKeys } from "@/lib/kalshi-crypto";
import { tickerTeamSuffix } from "@/lib/matcher";
import AutopilotGameCard from "./AutopilotGameCard";
import type {
  AutopilotSignal,
  AutopilotGame,
  AutopilotSettings,
  PositionItem,
} from "@/lib/types";

const DEFAULT_SETTINGS: AutopilotSettings = {
  autoExecuteEnabled: false,
  edgeThreshold: 8.0,
  sizingMode: "dollars",
  betAmount: 10,
  cooldownSeconds: 60,
  maxContractsPerBet: 20,
  maxExposurePerGame: 50,
};

function loadSettings(): AutopilotSettings {
  if (typeof window === "undefined") return DEFAULT_SETTINGS;
  try {
    const raw = localStorage.getItem("autopilot-settings");
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw);
    // Migrate old field name
    if (
      parsed.maxContractsPerGame !== undefined &&
      parsed.maxContractsPerBet === undefined
    ) {
      parsed.maxContractsPerBet = parsed.maxContractsPerGame;
      delete parsed.maxContractsPerGame;
    }
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function saveSettings(settings: AutopilotSettings) {
  localStorage.setItem("autopilot-settings", JSON.stringify(settings));
}

/**
 * Compute the NBA "game day" cutoff in UTC.
 *
 * NBA game days run ~11 AM ET to ~2 AM ET the next morning, so we treat
 * 5 AM ET as the boundary. Everything from 5 AM ET today until 5 AM ET
 * tomorrow belongs to today's game slate.
 *
 * If the current ET hour is before 5 AM (watching a late west-coast game),
 * we roll back to yesterday's game day so those games stay visible.
 */
function getGameDayCutoffUTC(): string {
  const now = new Date();

  // Extract current date/time components in Eastern Time
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
  }).formatToParts(now);

  const etYear = parseInt(parts.find((p) => p.type === "year")!.value);
  const etMonth = parseInt(parts.find((p) => p.type === "month")!.value) - 1;
  const etDay = parseInt(parts.find((p) => p.type === "day")!.value);
  const etHour = parseInt(parts.find((p) => p.type === "hour")!.value);

  // Roll back a day if before 5 AM ET (still previous game day)
  const gameDay = new Date(etYear, etMonth, etDay);
  if (etHour < 5) {
    gameDay.setDate(gameDay.getDate() - 1);
  }

  const yyyy = gameDay.getFullYear();
  const mm = String(gameDay.getMonth() + 1).padStart(2, "0");
  const dd = String(gameDay.getDate()).padStart(2, "0");

  // Compute ET → UTC offset dynamically (handles EST/EDT automatically)
  const utcHour = now.getUTCHours();
  const etOffsetHours = (utcHour - etHour + 24) % 24; // 5 for EST, 4 for EDT
  const cutoffUTCHour = 5 + etOffsetHours; // 5 AM ET → 10:00 UTC (EST) or 09:00 UTC (EDT)

  return `${yyyy}-${mm}-${dd}T${String(cutoffUTCHour).padStart(2, "0")}:00:00Z`;
}

function computeContractCount(
  settings: AutopilotSettings,
  price: number
): number {
  if (settings.sizingMode === "contracts") {
    return Math.min(settings.betAmount, settings.maxContractsPerBet);
  }
  // dollars mode: betAmount / price
  if (price <= 0 || price >= 1) return 1;
  const count = Math.floor(settings.betAmount / price);
  return Math.min(Math.max(count, 1), settings.maxContractsPerBet);
}

const MONTHS = [
  "JAN", "FEB", "MAR", "APR", "MAY", "JUN",
  "JUL", "AUG", "SEP", "OCT", "NOV", "DEC",
] as const;

/**
 * Get today's NBA game date as a Kalshi ticker date string (e.g., "26MAR04").
 * Uses the 5 AM ET boundary to handle late-night games correctly.
 */
function getKalshiGameDateStr(): string {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
  }).formatToParts(now);

  const etYear = parseInt(parts.find((p) => p.type === "year")!.value);
  const etMonth = parseInt(parts.find((p) => p.type === "month")!.value) - 1;
  const etDay = parseInt(parts.find((p) => p.type === "day")!.value);
  const etHour = parseInt(parts.find((p) => p.type === "hour")!.value);

  const gameDay = new Date(etYear, etMonth, etDay);
  if (etHour < 5) {
    gameDay.setDate(gameDay.getDate() - 1);
  }

  const yy = String(gameDay.getFullYear()).slice(-2);
  const mmm = MONTHS[gameDay.getMonth()];
  const dd = String(gameDay.getDate()).padStart(2, "0");
  return `${yy}${mmm}${dd}`;
}

/**
 * Match Kalshi positions to a specific game.
 *
 * Three-layer check for robustness:
 *   1. Ticker suffix (the YES-side team) matches one of the two teams
 *   2. Ticker contains BOTH team abbreviations (ensures it's this exact matchup)
 *   3. Ticker contains today's game date (prevents matching yesterday's unsettled positions)
 */
function matchPositionsToGame(
  positions: PositionItem[],
  homeTeam: string,
  awayTeam: string
): PositionItem[] {
  const gameDate = getKalshiGameDateStr();
  return positions.filter((pos) => {
    const suffix = tickerTeamSuffix(pos.ticker);
    if (suffix !== homeTeam && suffix !== awayTeam) return false;
    if (!pos.ticker.includes(homeTeam) || !pos.ticker.includes(awayTeam)) return false;
    // Verify the ticker matches today's game date (e.g., "26MAR04" in "KXNBAGAME-26MAR04BOSLAL-BOS")
    return pos.ticker.includes(gameDate);
  });
}

/**
 * Get the user's total dollar exposure on a game from Kalshi positions.
 * Sums absolute totalTraded across both sides (home YES + away YES).
 */
function getGameExposure(
  positions: PositionItem[],
  homeTeam: string,
  awayTeam: string
): number {
  const matched = matchPositionsToGame(positions, homeTeam, awayTeam);
  return matched.reduce((sum, pos) => sum + Math.abs(pos.totalTraded), 0);
}

/** Shape of the /api/games/today response. */
interface ScheduledGame {
  espnGameId: string;
  homeTeam: string;
  awayTeam: string;
  homeScore: number;
  awayScore: number;
  status: string;
  period: number;
  clock: string;
  startTime: string | null;
  statusDetail: string;
  kalshiHomePrice: number | null;
  kalshiAwayPrice: number | null;
}

interface LogEntry {
  timestamp: string;
  message: string;
  type: "info" | "skip" | "trade" | "error";
}

export default function AutopilotDashboard() {
  const [games, setGames] = useState<Map<string, AutopilotGame>>(new Map());
  const [settings, setSettings] = useState<AutopilotSettings>(DEFAULT_SETTINGS);
  const [keysConfigured, setKeysConfigured] = useState(false);
  const [loading, setLoading] = useState(true);
  const [systemStatus, setSystemStatus] = useState<"live" | "idle" | "unknown">(
    "unknown"
  );
  const [showSettings, setShowSettings] = useState(false);
  const [positions, setPositions] = useState<PositionItem[]>([]);
  const [activityLog, setActivityLog] = useState<LogEntry[]>([]);
  const [showLog, setShowLog] = useState(false);

  // Track cooldowns per game for auto-execution
  const lastExecutionTime = useRef<Map<string, number>>(new Map());
  // Ref for synchronous position reads in async callbacks (source of truth for exposure)
  const positionsRef = useRef<PositionItem[]>([]);
  // Ref to always call the latest handleNewSignal from the Supabase subscription
  const handleNewSignalRef = useRef<(signal: AutopilotSignal) => void>(() => {});

  const addLog = useCallback((message: string, type: LogEntry["type"] = "info") => {
    const timestamp = new Date().toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
      hour12: true,
    });
    setActivityLog((prev) => [{ timestamp, message, type }, ...prev].slice(0, 100));
  }, []);

  // Load settings on mount
  useEffect(() => {
    setSettings(loadSettings());
    hasKalshiKeys().then(setKeysConfigured);
  }, []);

  // Fetch Kalshi positions on mount + refresh every 15s (used for exposure cap)
  useEffect(() => {
    if (!keysConfigured) return;

    const loadPositions = () => {
      fetchPositions()
        .then((pos) => {
          setPositions(pos);
          positionsRef.current = pos;
        })
        .catch((e) => console.error("Failed to fetch positions:", e));
    };

    loadPositions();
    const interval = setInterval(loadPositions, 15_000);
    return () => clearInterval(interval);
  }, [keysConfigured]);

  // Fetch today's scheduled games (ESPN + Kalshi) on mount + refresh every 60s
  useEffect(() => {
    fetchScheduledGames();
    const interval = setInterval(fetchScheduledGames, 60_000);
    return () => clearInterval(interval);
  }, []);

  // Fetch initial signals + subscribe to real-time updates
  useEffect(() => {
    fetchInitialSignals();

    const channel = supabase
      .channel("autopilot-signals")
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "autopilot_signals",
        },
        (payload) => {
          const signal = payload.new as AutopilotSignal;
          handleNewSignalRef.current(signal);
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  const fetchScheduledGames = async () => {
    try {
      const resp = await fetch("/api/games/today");
      if (!resp.ok) return;
      const data = await resp.json();
      const scheduled: ScheduledGame[] = data.games || [];

      setGames((prev) => {
        const next = new Map(prev);

        for (const sg of scheduled) {
          const existing = next.get(sg.espnGameId);
          if (existing) {
            // Update schedule info but preserve signal data
            next.set(sg.espnGameId, {
              ...existing,
              startTime: sg.startTime ?? undefined,
              statusDetail: sg.statusDetail || undefined,
              kalshiHomePrice: sg.kalshiHomePrice,
              kalshiAwayPrice: sg.kalshiAwayPrice,
            });
          } else {
            // New pregame entry
            next.set(sg.espnGameId, {
              gameId: sg.espnGameId,
              homeTeam: sg.homeTeam,
              awayTeam: sg.awayTeam,
              latestSignal: null,
              signals: [],
              startTime: sg.startTime ?? undefined,
              statusDetail: sg.statusDetail || undefined,
              kalshiHomePrice: sg.kalshiHomePrice,
              kalshiAwayPrice: sg.kalshiAwayPrice,
            });
          }
        }

        return next;
      });
    } catch (e) {
      console.error("Failed to fetch scheduled games:", e);
    }
  };

  const fetchInitialSignals = async () => {
    setLoading(true);
    try {
      // Fetch signals for the current NBA game day (5 AM ET boundary)
      const cutoff = getGameDayCutoffUTC();
      const { data, error } = await supabase
        .from("autopilot_signals")
        .select("*")
        .gte("created_at", cutoff)
        .order("created_at", { ascending: false })
        .limit(500);

      if (error) {
        console.error("Failed to fetch signals:", error);
        setLoading(false);
        return;
      }

      if (data && data.length > 0) {
        const grouped = groupSignalsByGame(data as AutopilotSignal[]);
        // Merge with existing scheduled games
        setGames((prev) => {
          const next = new Map(prev);
          for (const [gameId, signalGame] of grouped) {
            const existing = next.get(gameId);
            if (existing) {
              // Merge signal data into scheduled game entry
              next.set(gameId, {
                ...existing,
                latestSignal: signalGame.latestSignal,
                signals: signalGame.signals,
              });
            } else {
              next.set(gameId, signalGame);
            }
          }
          return next;
        });
        setSystemStatus("live");
      } else {
        setSystemStatus("idle");
      }
    } catch (e) {
      console.error("Failed to fetch signals:", e);
    }
    setLoading(false);
  };

  const handleNewSignal = useCallback(
    (signal: AutopilotSignal) => {
      setGames((prev) => {
        const next = new Map(prev);
        const existing = next.get(signal.game_id);

        if (existing) {
          next.set(signal.game_id, {
            ...existing,
            latestSignal: signal,
            signals: [signal, ...existing.signals].slice(0, 100),
          });
        } else {
          next.set(signal.game_id, {
            gameId: signal.game_id,
            homeTeam: signal.home_team,
            awayTeam: signal.away_team,
            latestSignal: signal,
            signals: [signal],
          });
        }

        return next;
      });

      setSystemStatus("live");

      // Auto-execution check
      maybeAutoExecute(signal);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [settings, keysConfigured, addLog]
  );

  // Keep ref in sync so the Supabase subscription always calls the latest version
  handleNewSignalRef.current = handleNewSignal;

  const maybeAutoExecute = async (signal: AutopilotSignal) => {
    const currentSettings = loadSettings();
    const gameLabel = `${signal.away_team}@${signal.home_team}`;

    if (!currentSettings.autoExecuteEnabled) {
      addLog(`${gameLabel}: Auto-execute OFF, skipping`, "skip");
      return;
    }
    if (!keysConfigured) {
      addLog(`${gameLabel}: Kalshi keys not configured`, "skip");
      return;
    }
    if (signal.recommended_action === "NO_TRADE") {
      addLog(`${gameLabel}: Backend says NO_TRADE — ${signal.reason ?? "no reason"}`, "skip");
      return;
    }
    if (!signal.recommended_ticker) {
      addLog(`${gameLabel}: No recommended ticker`, "skip");
      return;
    }

    // Check edge threshold
    const edge = signal.edge_vs_kalshi ?? 0;
    if (edge < currentSettings.edgeThreshold) {
      addLog(
        `${gameLabel}: Edge ${edge.toFixed(1)}% < threshold ${currentSettings.edgeThreshold}% → skip`,
        "skip"
      );
      return;
    }

    // Check cooldown
    const now = Date.now();
    const lastExec = lastExecutionTime.current.get(signal.game_id) ?? 0;
    const cooldownRemaining = Math.ceil(
      (currentSettings.cooldownSeconds * 1000 - (now - lastExec)) / 1000
    );
    if (now - lastExec < currentSettings.cooldownSeconds * 1000) {
      addLog(
        `${gameLabel}: Cooldown active (${cooldownRemaining}s remaining)`,
        "skip"
      );
      return;
    }

    // Determine limit price: model_prob - edge_threshold
    const modelProb =
      signal.recommended_action === "BUY_HOME"
        ? signal.model_home_win_prob
        : 1 - signal.model_home_win_prob;

    const limitPrice = modelProb - currentSettings.edgeThreshold / 100;

    if (limitPrice <= 0 || limitPrice >= 1) {
      addLog(
        `${gameLabel}: Invalid limit price ${(limitPrice * 100).toFixed(0)}c (model=${(modelProb * 100).toFixed(0)}c - ${currentSettings.edgeThreshold}%)`,
        "skip"
      );
      return;
    }

    const contracts = computeContractCount(currentSettings, limitPrice);

    // Check cumulative per-game exposure cap using Kalshi positions (source of truth)
    const currentExposure = getGameExposure(
      positionsRef.current,
      signal.home_team,
      signal.away_team
    );
    const newExposure = contracts * limitPrice;
    if (currentExposure + newExposure > currentSettings.maxExposurePerGame) {
      addLog(
        `${gameLabel}: Exposure cap — $${currentExposure.toFixed(2)} existing + $${newExposure.toFixed(2)} new > $${currentSettings.maxExposurePerGame} max`,
        "skip"
      );
      return;
    }

    addLog(
      `${gameLabel}: Placing ${signal.recommended_action} x${contracts} @ limit ${(limitPrice * 100).toFixed(0)}c (model=${(modelProb * 100).toFixed(0)}c - ${currentSettings.edgeThreshold}% threshold)`,
      "info"
    );

    // Execute — limit order at (model_prob - threshold)
    try {
      const result = await placeOrder(
        signal.recommended_ticker,
        "yes",
        contracts,
        limitPrice.toFixed(2)
      );

      lastExecutionTime.current.set(signal.game_id, now);

      addLog(
        `${gameLabel}: ORDER ${result.status} — ${signal.recommended_ticker} x${contracts} @ ${(limitPrice * 100).toFixed(0)}c | fill=${result.fillCount ?? "?"}`,
        result.fillCount && result.fillCount > 0 ? "trade" : "info"
      );
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      addLog(`${gameLabel}: ORDER FAILED — ${errMsg}`, "error");
    }
  };

  const updateSettings = (patch: Partial<AutopilotSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      saveSettings(next);
      return next;
    });
  };

  const gameList = Array.from(games.values()).sort((a, b) => {
    const aLive = a.latestSignal !== null;
    const bLive = b.latestSignal !== null;

    // Live games first
    if (aLive && !bLive) return -1;
    if (!aLive && bLive) return 1;

    // Both live: sort by most recent signal
    if (aLive && bLive) {
      return (
        new Date(b.latestSignal!.created_at).getTime() -
        new Date(a.latestSignal!.created_at).getTime()
      );
    }

    // Both pregame: sort by start time (earliest first)
    const aTime = a.startTime ? new Date(a.startTime).getTime() : 0;
    const bTime = b.startTime ? new Date(b.startTime).getTime() : 0;
    return aTime - bTime;
  });

  return (
    <div className="min-h-screen bg-black text-white p-4 md:p-6 font-mono">
      {/* Header */}
      <div className="max-w-6xl mx-auto mb-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-xl font-bold tracking-wider">AUTOPILOT</h1>
            <p className="text-xs text-neutral-500 mt-1">
              Live win probability model + automated trading signals
            </p>
          </div>

          <div className="flex items-center gap-3">
            {/* System status */}
            <div className="flex items-center gap-2 text-xs">
              <div
                className={`w-2 h-2 rounded-full ${
                  systemStatus === "live"
                    ? "bg-green-500 animate-pulse"
                    : systemStatus === "idle"
                      ? "bg-neutral-600"
                      : "bg-yellow-500"
                }`}
              />
              <span className="text-neutral-400 uppercase">
                {systemStatus}
              </span>
            </div>

            {/* Log toggle */}
            <button
              onClick={() => setShowLog(!showLog)}
              className={`text-xs border rounded px-2 py-1 ${
                activityLog.some((l) => l.type === "error")
                  ? "text-red-400 border-red-800 hover:text-red-300"
                  : activityLog.some((l) => l.type === "trade")
                    ? "text-green-400 border-green-800 hover:text-green-300"
                    : "text-neutral-500 border-neutral-800 hover:text-neutral-300"
              }`}
            >
              Log{activityLog.length > 0 ? ` (${activityLog.length})` : ""}
            </button>

            {/* Settings toggle */}
            <button
              onClick={() => setShowSettings(!showSettings)}
              className="text-xs text-neutral-500 hover:text-neutral-300 border border-neutral-800 rounded px-2 py-1"
            >
              Settings
            </button>
          </div>
        </div>

        {/* Auto-execution toggle */}
        <div className="flex items-center gap-4 p-3 rounded-lg border border-neutral-800 bg-neutral-900/60">
          <button
            onClick={() =>
              updateSettings({
                autoExecuteEnabled: !settings.autoExecuteEnabled,
              })
            }
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
              settings.autoExecuteEnabled ? "bg-green-600" : "bg-neutral-700"
            }`}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                settings.autoExecuteEnabled
                  ? "translate-x-6"
                  : "translate-x-1"
              }`}
            />
          </button>
          <div>
            <span className="text-sm font-medium">
              Auto-Execute:{" "}
              <span
                className={
                  settings.autoExecuteEnabled
                    ? "text-green-400"
                    : "text-neutral-500"
                }
              >
                {settings.autoExecuteEnabled ? "ON" : "OFF"}
              </span>
            </span>
            <p className="text-xs text-neutral-500 mt-0.5">
              {settings.autoExecuteEnabled
                ? keysConfigured
                  ? `Placing bets when edge > ${settings.edgeThreshold}% (max $${settings.maxExposurePerGame}/game)`
                  : "Kalshi keys not configured — go to Terminal > Settings"
                : "Signals display only — no bets placed"}
            </p>
          </div>
        </div>

        {/* Activity log */}
        {showLog && (
          <div className="mt-3 p-4 rounded-lg border border-neutral-800 bg-neutral-900/60">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-medium">Activity Log</h3>
              <button
                onClick={() => setActivityLog([])}
                className="text-xs text-neutral-600 hover:text-neutral-400"
              >
                Clear
              </button>
            </div>
            {activityLog.length === 0 ? (
              <p className="text-xs text-neutral-600">
                No activity yet. Signals will be evaluated as they arrive.
              </p>
            ) : (
              <div className="max-h-64 overflow-y-auto space-y-0.5">
                {activityLog.map((entry, i) => (
                  <div key={i} className="flex gap-2 text-xs font-mono">
                    <span className="text-neutral-600 shrink-0">
                      {entry.timestamp}
                    </span>
                    <span
                      className={
                        entry.type === "error"
                          ? "text-red-400"
                          : entry.type === "trade"
                            ? "text-green-400"
                            : entry.type === "skip"
                              ? "text-neutral-500"
                              : "text-yellow-400"
                      }
                    >
                      {entry.message}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Settings panel */}
        {showSettings && (
          <div className="mt-3 p-4 rounded-lg border border-neutral-800 bg-neutral-900/60">
            <h3 className="text-sm font-medium mb-3">Execution Settings</h3>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4 text-xs">
              <div>
                <label className="text-neutral-500 block mb-1">
                  Min Edge (%)
                </label>
                <input
                  type="number"
                  value={settings.edgeThreshold}
                  onChange={(e) =>
                    updateSettings({ edgeThreshold: Number(e.target.value) })
                  }
                  className="w-full bg-neutral-800 border border-neutral-700 rounded px-2 py-1 text-white"
                  step="0.5"
                  min="0"
                />
              </div>
              <div>
                <label className="text-neutral-500 block mb-1">
                  Bet Amount ($)
                </label>
                <input
                  type="number"
                  value={settings.betAmount}
                  onChange={(e) =>
                    updateSettings({ betAmount: Number(e.target.value) })
                  }
                  className="w-full bg-neutral-800 border border-neutral-700 rounded px-2 py-1 text-white"
                  min="1"
                />
              </div>
              <div>
                <label className="text-neutral-500 block mb-1">
                  Cooldown (sec)
                </label>
                <input
                  type="number"
                  value={settings.cooldownSeconds}
                  onChange={(e) =>
                    updateSettings({
                      cooldownSeconds: Number(e.target.value),
                    })
                  }
                  className="w-full bg-neutral-800 border border-neutral-700 rounded px-2 py-1 text-white"
                  min="10"
                />
              </div>
              <div>
                <label className="text-neutral-500 block mb-1">
                  Max Contracts / Bet
                </label>
                <input
                  type="number"
                  value={settings.maxContractsPerBet}
                  onChange={(e) =>
                    updateSettings({
                      maxContractsPerBet: Number(e.target.value),
                    })
                  }
                  className="w-full bg-neutral-800 border border-neutral-700 rounded px-2 py-1 text-white"
                  min="1"
                />
              </div>
              <div>
                <label className="text-neutral-500 block mb-1">
                  Max Exposure / Game ($)
                </label>
                <input
                  type="number"
                  value={settings.maxExposurePerGame}
                  onChange={(e) =>
                    updateSettings({
                      maxExposurePerGame: Number(e.target.value),
                    })
                  }
                  className="w-full bg-neutral-800 border border-neutral-700 rounded px-2 py-1 text-white"
                  min="1"
                />
              </div>
              <div>
                <label className="text-neutral-500 block mb-1">
                  Sizing Mode
                </label>
                <select
                  value={settings.sizingMode}
                  onChange={(e) =>
                    updateSettings({
                      sizingMode: e.target.value as "contracts" | "dollars",
                    })
                  }
                  className="w-full bg-neutral-800 border border-neutral-700 rounded px-2 py-1 text-white"
                >
                  <option value="dollars">Dollars</option>
                  <option value="contracts">Contracts</option>
                </select>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Game cards */}
      <div className="max-w-6xl mx-auto">
        {loading ? (
          <div className="text-center py-20 text-neutral-500 text-sm">
            Loading games...
          </div>
        ) : gameList.length === 0 ? (
          <div className="text-center py-20">
            <p className="text-neutral-500 text-sm">
              No games scheduled today.
            </p>
            <p className="text-neutral-600 text-xs mt-2">
              Today&apos;s game slate will appear here when available.
            </p>
          </div>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {gameList.map((game) => (
              <AutopilotGameCard
                key={game.gameId}
                game={game}
                positions={matchPositionsToGame(
                  positions,
                  game.homeTeam,
                  game.awayTeam
                )}
                edgeThreshold={settings.edgeThreshold}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function groupSignalsByGame(
  signals: AutopilotSignal[]
): Map<string, AutopilotGame> {
  const map = new Map<string, AutopilotGame>();

  // signals are already ordered desc by created_at
  for (const signal of signals) {
    const existing = map.get(signal.game_id);
    if (existing) {
      existing.signals.push(signal);
    } else {
      map.set(signal.game_id, {
        gameId: signal.game_id,
        homeTeam: signal.home_team,
        awayTeam: signal.away_team,
        latestSignal: signal,
        signals: [signal],
      });
    }
  }

  return map;
}
