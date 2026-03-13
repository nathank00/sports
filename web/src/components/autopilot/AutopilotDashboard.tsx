"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import { hasKalshiKeys } from "@/lib/kalshi-crypto";
import { AutopilotPositionManager } from "@/lib/autopilot-position-manager";
import AutopilotGameCard from "./AutopilotGameCard";
import type {
  AutopilotSignal,
  AutopilotGame,
  AutopilotSettingsV2,
  AutopilotPosition,
  AutopilotLog,
  SizingMode,
} from "@/lib/types";

/** Default settings for new users (matches Supabase column defaults). */
const DEFAULT_SETTINGS: Omit<AutopilotSettingsV2, "user_id" | "updated_at"> = {
  auto_execute_enabled: false,
  edge_threshold: 8.0,
  take_profit: 0.08,
  stop_loss: 0.05,
  sizing_mode: "dollars",
  bet_amount: 10,
  cooldown_seconds: 60,
  max_contracts_per_bet: 20,
  max_exposure_per_game: 50,
};

/**
 * Compute the NBA "game day" cutoff in UTC.
 *
 * NBA game days run ~11 AM ET to ~2 AM ET the next morning, so we treat
 * 7 AM ET as the boundary. Everything from 7 AM ET today until 7 AM ET
 * tomorrow belongs to today's game slate.
 *
 * If the current ET hour is before 7 AM (watching a late west-coast game),
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

  // Roll back a day if before 7 AM ET (still previous game day)
  const gameDay = new Date(etYear, etMonth, etDay);
  if (etHour < 7) {
    gameDay.setDate(gameDay.getDate() - 1);
  }

  const yyyy = gameDay.getFullYear();
  const mm = String(gameDay.getMonth() + 1).padStart(2, "0");
  const dd = String(gameDay.getDate()).padStart(2, "0");

  // Compute ET → UTC offset dynamically (handles EST/EDT automatically)
  const utcHour = now.getUTCHours();
  const etOffsetHours = (utcHour - etHour + 24) % 24; // 5 for EST, 4 for EDT
  const cutoffUTCHour = 7 + etOffsetHours; // 7 AM ET → 12:00 UTC (EST) or 11:00 UTC (EDT)

  return `${yyyy}-${mm}-${dd}T${String(cutoffUTCHour).padStart(2, "0")}:00:00Z`;
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

interface Props {
  userId: string;
}

export default function AutopilotDashboard({ userId }: Props) {
  const [games, setGames] = useState<Map<string, AutopilotGame>>(new Map());
  const [settings, setSettings] = useState<AutopilotSettingsV2 | null>(null);
  const [keysConfigured, setKeysConfigured] = useState(false);
  const [loading, setLoading] = useState(true);
  const [systemStatus, setSystemStatus] = useState<"live" | "idle" | "unknown">(
    "unknown"
  );
  const [showSettings, setShowSettings] = useState(false);
  const [positions, setPositions] = useState<Map<string, AutopilotPosition>>(
    new Map()
  );
  const [activityLog, setActivityLog] = useState<AutopilotLog[]>([]);
  const [showLog, setShowLog] = useState(false);

  const positionManagerRef = useRef<AutopilotPositionManager | null>(null);
  // Ref to always call the latest handleNewSignal from the Supabase subscription
  const handleNewSignalRef = useRef<(signal: AutopilotSignal) => void>(
    () => {}
  );
  // Track latest signal timestamp for polling fallback
  const latestSignalTsRef = useRef<string | null>(null);

  // ── Initialize position manager ─────────────────────────────────────

  useEffect(() => {
    const logCallback = (
      level: string,
      message: string,
      eventId?: string
    ) => {
      console.log(
        `[Autopilot ${level}] ${message}${eventId ? ` (${eventId})` : ""}`
      );
    };

    const pm = new AutopilotPositionManager(userId, logCallback);
    positionManagerRef.current = pm;

    return () => {
      pm.dispose();
      positionManagerRef.current = null;
    };
  }, [userId]);

  // ── Load settings from Supabase (with localStorage migration) ───────

  useEffect(() => {
    hasKalshiKeys().then(setKeysConfigured);

    const loadSettings = async () => {
      try {
        const { data, error } = await supabase
          .from("autopilot_settings")
          .select("*")
          .eq("user_id", userId)
          .limit(1)
          .single();

        if (data && !error) {
          setSettings(data as AutopilotSettingsV2);
        } else {
          // No Supabase row — migrate from localStorage or use defaults
          let migrated: Omit<AutopilotSettingsV2, "user_id" | "updated_at"> = {
            ...DEFAULT_SETTINGS,
          };
          try {
            const raw = localStorage.getItem("autopilot-settings");
            if (raw) {
              const parsed = JSON.parse(raw);
              // Map old camelCase field names to new snake_case
              migrated = {
                auto_execute_enabled: parsed.autoExecuteEnabled ?? false,
                edge_threshold: parsed.edgeThreshold ?? 8.0,
                take_profit: 0.08, // new field, default
                stop_loss: 0.05, // new field, default
                sizing_mode: parsed.sizingMode ?? "dollars",
                bet_amount: parsed.betAmount ?? 10,
                cooldown_seconds: parsed.cooldownSeconds ?? 60,
                max_contracts_per_bet:
                  parsed.maxContractsPerBet ??
                  parsed.maxContractsPerGame ??
                  20,
                max_exposure_per_game: parsed.maxExposurePerGame ?? 50,
              };
              localStorage.removeItem("autopilot-settings");
            }
          } catch {
            // localStorage not available or corrupt — use defaults
          }

          // Seed Supabase row
          const row: AutopilotSettingsV2 = {
            user_id: userId,
            ...migrated,
            updated_at: new Date().toISOString(),
          };
          await supabase.from("autopilot_settings").upsert(row);
          setSettings(row);
        }
      } catch (e) {
        console.error("Failed to load settings:", e);
        // Use defaults in memory
        setSettings({
          user_id: userId,
          ...DEFAULT_SETTINGS,
          updated_at: new Date().toISOString(),
        });
      }
    };

    loadSettings();
  }, [userId]);

  // ── Subscribe to positions realtime ──────────────────────────────────

  useEffect(() => {
    // Fetch existing positions
    const fetchPositions = async () => {
      try {
        const { data } = await supabase
          .from("autopilot_positions")
          .select("*")
          .eq("user_id", userId);

        if (data) {
          const map = new Map<string, AutopilotPosition>();
          for (const pos of data as AutopilotPosition[]) {
            map.set(pos.event_id, pos);
            // Forward any pending intents to position manager for execution
            if (pos.state === "PENDING_ENTRY" || pos.state === "PENDING_EXIT") {
              positionManagerRef.current?.handlePositionChange(pos);
            }
          }
          setPositions(map);
        }
      } catch (e) {
        console.error("Failed to fetch positions:", e);
      }
    };

    fetchPositions();

    // Subscribe to INSERT and UPDATE events
    const channel = supabase
      .channel("autopilot-positions")
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "autopilot_positions",
          filter: `user_id=eq.${userId}`,
        },
        (payload) => {
          if (payload.eventType === "DELETE") {
            const old = payload.old as { event_id?: string };
            if (old?.event_id) {
              setPositions((prev) => {
                const next = new Map(prev);
                next.delete(old.event_id!);
                return next;
              });
            }
            return;
          }

          const position = payload.new as AutopilotPosition;
          if (position) {
            setPositions((prev) => {
              const next = new Map(prev);
              next.set(position.event_id, position);
              return next;
            });

            // Forward to position manager for execution (handles PENDING_ENTRY)
            positionManagerRef.current?.handlePositionChange(position);
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [userId]);

  // ── Fetch logs from Supabase + subscribe to realtime ─────────────────

  useEffect(() => {
    const cutoff = getGameDayCutoffUTC();

    const fetchLogs = async () => {
      try {
        const { data } = await supabase
          .from("autopilot_logs")
          .select("*")
          .eq("user_id", userId)
          .gte("timestamp", cutoff)
          .order("timestamp", { ascending: false })
          .limit(100);

        if (data) {
          setActivityLog(data as AutopilotLog[]);
        }
      } catch (e) {
        console.error("Failed to fetch logs:", e);
      }
    };

    fetchLogs();

    // Subscribe to new log inserts (from both frontend position manager and backend)
    const channel = supabase
      .channel("autopilot-logs")
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "autopilot_logs",
          filter: `user_id=eq.${userId}`,
        },
        (payload) => {
          const log = payload.new as AutopilotLog;
          setActivityLog((prev) => [log, ...prev].slice(0, 100));
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [userId]);

  // ── Fetch today's scheduled games (ESPN + Kalshi) ────────────────────

  useEffect(() => {
    fetchScheduledGames();
    const interval = setInterval(fetchScheduledGames, 30_000);
    return () => clearInterval(interval);
  }, []);

  // ── Fetch initial signals + subscribe to real-time updates ───────────

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

  // ── Position polling fallback (catches PENDING_ENTRY/EXIT if Realtime misses them) ──

  useEffect(() => {
    const pollPendingPositions = async () => {
      try {
        const { data } = await supabase
          .from("autopilot_positions")
          .select("*")
          .eq("user_id", userId)
          .in("state", ["PENDING_ENTRY", "PENDING_EXIT"]);

        if (data && data.length > 0) {
          for (const pos of data as AutopilotPosition[]) {
            // Update React state so UI reflects the position
            setPositions((prev) => {
              const next = new Map(prev);
              next.set(pos.event_id, pos);
              return next;
            });
            // Forward to position manager for execution
            positionManagerRef.current?.handlePositionChange(pos);
          }
        }
      } catch (e) {
        console.error("Position poll error:", e);
      }
    };

    // Poll immediately on mount, then every 5 seconds
    pollPendingPositions();
    const interval = setInterval(pollPendingPositions, 5_000);
    return () => clearInterval(interval);
  }, [userId]);

  // ── Signal polling fallback (in case Realtime subscription isn't working) ──

  useEffect(() => {
    const pollSignals = async () => {
      const since = latestSignalTsRef.current || getGameDayCutoffUTC();
      try {
        const { data } = await supabase
          .from("autopilot_signals")
          .select("*")
          .gt("created_at", since)
          .order("created_at", { ascending: true })
          .limit(100);

        if (data && data.length > 0) {
          for (const signal of data as AutopilotSignal[]) {
            handleNewSignalRef.current(signal);
          }
        }
      } catch (e) {
        console.error("Signal poll error:", e);
      }
    };

    const interval = setInterval(pollSignals, 15_000);
    return () => clearInterval(interval);
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
        // Track latest signal timestamp (data is ordered desc, first is newest)
        latestSignalTsRef.current = (data[0] as AutopilotSignal).created_at;
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

  const handleNewSignal = useCallback((signal: AutopilotSignal) => {
    // Track latest signal timestamp for polling fallback
    if (!latestSignalTsRef.current || signal.created_at > latestSignalTsRef.current) {
      latestSignalTsRef.current = signal.created_at;
    }

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
  }, []);

  // Keep ref in sync so the Supabase subscription always calls the latest version
  handleNewSignalRef.current = handleNewSignal;

  // ── Settings management ──────────────────────────────────────────────

  const updateSettings = async (patch: Partial<AutopilotSettingsV2>) => {
    if (!settings) return;

    const next = {
      ...settings,
      ...patch,
      updated_at: new Date().toISOString(),
    };
    setSettings(next);

    try {
      await supabase.from("autopilot_settings").upsert(next);
    } catch (e) {
      console.error("Failed to save settings:", e);
    }
  };

  // ── Manual exit handler ──────────────────────────────────────────────

  const handleManualExit = useCallback(
    async (position: AutopilotPosition) => {
      await positionManagerRef.current?.manualExit(position);
    },
    []
  );

  // ── Game list sorting ────────────────────────────────────────────────

  /**
   * Compute how far into a game we are as a single number (higher = further along).
   * Returns 0 for pregame.
   */
  const getGameProgress = (game: AutopilotGame): number => {
    if (!game.latestSignal) return 0;
    const { period, seconds_remaining } = game.latestSignal;

    const quarterLength = 720;
    const otLength = 300;

    if (period <= 4) {
      return (period - 1) * quarterLength + (quarterLength - seconds_remaining);
    }

    return (
      4 * quarterLength +
      (period - 5) * otLength +
      (otLength - seconds_remaining)
    );
  };

  /** Find position for a game by matching game_id, falling back to team matching. */
  const getPositionForGame = useCallback(
    (game: AutopilotGame): AutopilotPosition | null => {
      // Direct match by game_id (ESPN ID)
      for (const pos of positions.values()) {
        if (pos.game_id === game.gameId) return pos;
      }
      // Fallback: match by teams
      for (const pos of positions.values()) {
        if (
          pos.home_team === game.homeTeam &&
          pos.away_team === game.awayTeam
        ) {
          return pos;
        }
      }
      return null;
    },
    [positions]
  );

  /** Check if a game is finished (Final, Final/OT, etc.). */
  const isGameFinished = (game: AutopilotGame): boolean => {
    if (game.statusDetail?.toLowerCase().includes("final")) return true;
    // Q4 (or later) with 0 seconds remaining = game over
    if (game.latestSignal) {
      const { period, seconds_remaining } = game.latestSignal;
      if (period >= 4 && seconds_remaining === 0) return true;
    }
    return false;
  };

  const gameList = Array.from(games.values()).sort((a, b) => {
    const aFinished = isGameFinished(a);
    const bFinished = isGameFinished(b);
    const aLive = a.latestSignal !== null && !aFinished;
    const bLive = b.latestSignal !== null && !bFinished;
    const aPregame = a.latestSignal === null;
    const bPregame = b.latestSignal === null;

    // Priority: Live > Pregame > Finished
    if (aLive && !bLive) return -1;
    if (!aLive && bLive) return 1;

    // Both live: sort by game progress (furthest along first)
    if (aLive && bLive) {
      return getGameProgress(b) - getGameProgress(a);
    }

    // Pregame before finished
    if (aPregame && bFinished) return -1;
    if (aFinished && bPregame) return 1;

    // Both pregame: sort by start time (earliest first)
    if (aPregame && bPregame) {
      const aTime = a.startTime ? new Date(a.startTime).getTime() : 0;
      const bTime = b.startTime ? new Date(b.startTime).getTime() : 0;
      return aTime - bTime;
    }

    // Both finished: sort by progress (most recent first)
    if (aFinished && bFinished) {
      return getGameProgress(b) - getGameProgress(a);
    }

    return 0;
  });

  const effectiveSettings: AutopilotSettingsV2 = settings || {
    user_id: userId,
    ...DEFAULT_SETTINGS,
    updated_at: new Date().toISOString(),
  };

  // ── Log level → color mapping ──────────────────────────────────────

  const logLevelColor = (level: string): string => {
    switch (level) {
      case "TRADE":
        return "text-green-400";
      case "EXIT":
        return "text-blue-400";
      case "BLOCKED":
        return "text-neutral-500";
      case "SETTINGS":
        return "text-purple-400";
      default:
        return "text-yellow-400";
    }
  };

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
                activityLog.some((l) => l.level === "EXIT")
                  ? "text-blue-400 border-blue-800 hover:text-blue-300"
                  : activityLog.some((l) => l.level === "TRADE")
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
                auto_execute_enabled: !effectiveSettings.auto_execute_enabled,
              })
            }
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
              effectiveSettings.auto_execute_enabled
                ? "bg-green-600"
                : "bg-neutral-700"
            }`}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                effectiveSettings.auto_execute_enabled
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
                  effectiveSettings.auto_execute_enabled
                    ? "text-green-400"
                    : "text-neutral-500"
                }
              >
                {effectiveSettings.auto_execute_enabled ? "ON" : "OFF"}
              </span>
            </span>
            <p className="text-xs text-neutral-500 mt-0.5">
              {effectiveSettings.auto_execute_enabled
                ? keysConfigured
                  ? `Trading when edge > ${effectiveSettings.edge_threshold}% | TP: ${Math.round(effectiveSettings.take_profit * 100)}c | SL: ${Math.round(effectiveSettings.stop_loss * 100)}c`
                  : "Kalshi keys not configured — go to Terminal > Settings"
                : "Signals display only — no trades placed"}
            </p>
          </div>
        </div>

        {/* Activity log */}
        {showLog && (
          <div className="mt-3 p-4 rounded-lg border border-neutral-800 bg-neutral-900/60">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-medium">Activity Log</h3>
            </div>
            {activityLog.length === 0 ? (
              <p className="text-xs text-neutral-600">
                No activity yet. Signals will be evaluated as they arrive.
              </p>
            ) : (
              <div className="max-h-64 overflow-y-auto space-y-0.5">
                {activityLog.map((entry) => (
                  <div key={entry.id} className="flex gap-2 text-xs font-mono">
                    <span className="text-neutral-600 shrink-0">
                      {new Date(entry.timestamp).toLocaleTimeString("en-US", {
                        hour: "numeric",
                        minute: "2-digit",
                        second: "2-digit",
                        hour12: true,
                      })}
                    </span>
                    <span
                      className={`shrink-0 w-16 ${logLevelColor(entry.level)}`}
                    >
                      {entry.level}
                    </span>
                    <span className={logLevelColor(entry.level)}>
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
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-xs">
              <div>
                <label className="text-neutral-500 block mb-1">
                  Min Edge (%)
                </label>
                <input
                  type="number"
                  value={effectiveSettings.edge_threshold}
                  onChange={(e) =>
                    updateSettings({ edge_threshold: Number(e.target.value) })
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
                  value={effectiveSettings.bet_amount}
                  onChange={(e) =>
                    updateSettings({ bet_amount: Number(e.target.value) })
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
                  value={effectiveSettings.cooldown_seconds}
                  onChange={(e) =>
                    updateSettings({
                      cooldown_seconds: Number(e.target.value),
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
                  value={effectiveSettings.max_contracts_per_bet}
                  onChange={(e) =>
                    updateSettings({
                      max_contracts_per_bet: Number(e.target.value),
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
                  value={effectiveSettings.max_exposure_per_game}
                  onChange={(e) =>
                    updateSettings({
                      max_exposure_per_game: Number(e.target.value),
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
                  value={effectiveSettings.sizing_mode}
                  onChange={(e) =>
                    updateSettings({
                      sizing_mode: e.target.value as SizingMode,
                    })
                  }
                  className="w-full bg-neutral-800 border border-neutral-700 rounded px-2 py-1 text-white"
                >
                  <option value="dollars">Dollars</option>
                  <option value="contracts">Contracts</option>
                </select>
              </div>
              <div>
                <label className="text-neutral-500 block mb-1">
                  Take Profit (c/contract)
                </label>
                <input
                  type="number"
                  value={Math.round(effectiveSettings.take_profit * 100)}
                  onChange={(e) =>
                    updateSettings({
                      take_profit: Number(e.target.value) / 100,
                    })
                  }
                  className="w-full bg-neutral-800 border border-neutral-700 rounded px-2 py-1 text-white"
                  step="1"
                  min="1"
                />
              </div>
              <div>
                <label className="text-neutral-500 block mb-1">
                  Stop Loss (c/contract)
                </label>
                <input
                  type="number"
                  value={Math.round(effectiveSettings.stop_loss * 100)}
                  onChange={(e) =>
                    updateSettings({
                      stop_loss: Number(e.target.value) / 100,
                    })
                  }
                  className="w-full bg-neutral-800 border border-neutral-700 rounded px-2 py-1 text-white"
                  step="1"
                  min="1"
                />
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
                position={getPositionForGame(game)}
                edgeThreshold={effectiveSettings.edge_threshold}
                onManualExit={handleManualExit}
                isFinished={isGameFinished(game)}
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
