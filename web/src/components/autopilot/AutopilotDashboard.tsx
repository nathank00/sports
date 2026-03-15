"use client";

import { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { supabase } from "@/lib/supabase";
import { hasKalshiKeys } from "@/lib/kalshi-crypto";
import { fetchPositions } from "@/lib/kalshi-api";
import { AutopilotPositionManager, type GameState } from "@/lib/autopilot-position-manager";
import AutopilotGameCard from "./AutopilotGameCard";
import type {
  AutopilotSignal,
  AutopilotGame,
  AutopilotSettingsV2,
  AutopilotPosition,
  AutopilotLog,
  PositionItem,
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
  max_contracts_per_bet: 20,
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
  const [activityLog, setActivityLog] = useState<AutopilotLog[]>([]);
  const [showLog, setShowLog] = useState(false);
  const [showTrades, setShowTrades] = useState(false);
  const [backendStatus, setBackendStatus] = useState<"live" | "stale" | "offline">("offline");

  // Kalshi positions — source of truth, polled every 5s
  const [kalshiPositions, setKalshiPositions] = useState<PositionItem[]>([]);

  const positionManagerRef = useRef<AutopilotPositionManager | null>(null);
  // Ref to always call the latest handleNewSignal from the Supabase subscription
  const handleNewSignalRef = useRef<(signal: AutopilotSignal) => void>(
    () => {}
  );
  // Track latest signal timestamp for polling fallback
  const latestSignalTsRef = useRef<string | null>(null);
  // Ref to settings so signal handlers always see latest
  const settingsRef = useRef<AutopilotSettingsV2 | null>(null);
  // Ref to Kalshi positions so the exit poll can access latest without stale closure
  const kalshiPositionsRef = useRef<PositionItem[]>([]);
  // Ref to games so we can build gameStates map for TP/SL + late-game exits
  const gamesRef = useRef<Map<string, AutopilotGame>>(new Map());

  // ── Initialize position manager ─────────────────────────────────────

  useEffect(() => {
    const logCallback = (
      level: string,
      message: string,
      eventId?: string,
      metadata?: Record<string, unknown>
    ) => {
      console.log(
        `[Autopilot ${level}] ${message}${eventId ? ` (${eventId})` : ""}`
      );
      // Add directly to activity log for instant UI feedback
      const entry: AutopilotLog = {
        id: -Date.now(),
        user_id: userId,
        timestamp: new Date().toISOString(),
        event_id: eventId ?? null,
        level: level as AutopilotLog["level"],
        message,
        metadata: metadata ?? null,
      };
      setActivityLog((prev) => [entry, ...prev].slice(0, 100));
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
          settingsRef.current = data as AutopilotSettingsV2;
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
                max_contracts_per_bet:
                  parsed.maxContractsPerBet ??
                  parsed.maxContractsPerGame ??
                  20,
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
          settingsRef.current = row;
        }
      } catch (e) {
        console.error("Failed to load settings:", e);
        // Use defaults in memory
        const defaults = {
          user_id: userId,
          ...DEFAULT_SETTINGS,
          updated_at: new Date().toISOString(),
        };
        setSettings(defaults);
        settingsRef.current = defaults;
      }
    };

    loadSettings();
  }, [userId]);

  // ── Poll Kalshi positions every 5s + run TP/SL + late-game exits ────

  useEffect(() => {
    const poll = async () => {
      try {
        const positions = await fetchPositions();
        setKalshiPositions(positions);
        kalshiPositionsRef.current = positions;
      } catch {
        // Silently fail — will retry in 5s
        return;
      }

      // TP/SL + late-game exit checking — runs on every Kalshi poll
      const currentSettings = settingsRef.current;
      if (currentSettings?.auto_execute_enabled && positionManagerRef.current) {
        // Build gameStates map from current games (keyed by team abbreviation)
        const gameStates = new Map<string, GameState>();
        for (const game of gamesRef.current.values()) {
          if (game.latestSignal) {
            const state: GameState = {
              period: game.latestSignal.period,
              secondsRemaining: game.latestSignal.seconds_remaining,
              homeTeam: game.homeTeam,
              awayTeam: game.awayTeam,
            };
            gameStates.set(game.homeTeam, state);
            gameStates.set(game.awayTeam, state);
          }
        }

        await positionManagerRef.current.checkAutoExits(
          currentSettings,
          kalshiPositionsRef.current,
          gameStates,
        );
      }
    };

    poll();
    const interval = setInterval(poll, 5_000);
    return () => clearInterval(interval);
  }, []);

  // ── Fetch logs from Supabase + poll every 5s ─────────────────────────

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
          const dbLogs = data as AutopilotLog[];
          setActivityLog((prev) => {
            // Keep in-memory logs (negative ID) that don't have a matching DB log yet
            const inMemory = prev.filter((p) => {
              if (p.id >= 0) return false; // DB log from previous poll — replaced by fresh fetch
              const pTime = new Date(p.timestamp).getTime();
              const hasDupe = dbLogs.some(
                (db) =>
                  db.level === p.level &&
                  db.message === p.message &&
                  Math.abs(new Date(db.timestamp).getTime() - pTime) < 5_000
              );
              return !hasDupe;
            });
            if (inMemory.length === 0) return dbLogs;
            const merged = [...inMemory, ...dbLogs];
            merged.sort(
              (a, b) =>
                new Date(b.timestamp).getTime() -
                new Date(a.timestamp).getTime()
            );
            return merged.slice(0, 100);
          });
        }
      } catch (e) {
        console.error("Failed to fetch logs:", e);
      }
    };

    fetchLogs();
    const interval = setInterval(fetchLogs, 5_000);

    return () => {
      clearInterval(interval);
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

  // ── Poll backend heartbeat every 10s ──────────────────────────────
  useEffect(() => {
    const checkHeartbeat = async () => {
      try {
        const { data } = await supabase
          .from("autopilot_heartbeat")
          .select("last_heartbeat")
          .eq("id", 1)
          .single();

        if (data?.last_heartbeat) {
          const ageSec =
            (Date.now() - new Date(data.last_heartbeat).getTime()) / 1000;
          if (ageSec < 60) setBackendStatus("live");
          else if (ageSec < 120) setBackendStatus("stale");
          else setBackendStatus("offline");
        } else {
          setBackendStatus("offline");
        }
      } catch {
        setBackendStatus("offline");
      }
    };

    checkHeartbeat();
    const interval = setInterval(checkHeartbeat, 10_000);
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

    // If auto-execute is enabled, evaluate for entry
    const currentSettings = settingsRef.current;
    if (currentSettings?.auto_execute_enabled && positionManagerRef.current) {
      positionManagerRef.current.evaluateSignal(signal, currentSettings);
    }
  }, []);

  // Keep refs in sync so callbacks always see the latest values
  handleNewSignalRef.current = handleNewSignal;
  gamesRef.current = games;

  // ── Settings management ──────────────────────────────────────────────

  const updateSettings = async (patch: Partial<AutopilotSettingsV2>) => {
    if (!settings) return;

    const next = {
      ...settings,
      ...patch,
      updated_at: new Date().toISOString(),
    };
    setSettings(next);
    settingsRef.current = next;

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

  /** Find Kalshi position for a game by matching ticker to game teams. */
  const getKalshiPositionForGame = useCallback(
    (game: AutopilotGame): PositionItem | null => {
      // Check via signal tickers (from the game's latest signal)
      if (game.latestSignal) {
        const homeTicker = game.latestSignal.kalshi_ticker_home;
        const awayTicker = game.latestSignal.kalshi_ticker_away;
        for (const ticker of [homeTicker, awayTicker]) {
          if (!ticker) continue;
          const eventPrefix = ticker.substring(0, ticker.lastIndexOf("-"));
          const match = kalshiPositions.find(
            (p) => p.position > 0 && p.ticker.startsWith(eventPrefix)
          );
          if (match) return match;
        }
      }

      // Fallback: match by team abbreviation in ticker
      const homeAbbr = game.homeTeam;
      const awayAbbr = game.awayTeam;
      const match = kalshiPositions.find(
        (p) => p.position > 0 && p.ticker.startsWith("KXNBA") &&
          (p.ticker.includes(homeAbbr) || p.ticker.includes(awayAbbr))
      );
      return match || null;
    },
    [kalshiPositions]
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

  // ── P&L + trade history ───────────────────────────────────────────

  const tradeHistory = useMemo(
    () => activityLog.filter((l) => l.level === "TRADE"),
    [activityLog]
  );

  const pnlSummary = useMemo(() => {
    let buys = 0;
    let sells = 0;
    let totalPnl = 0;
    let hasPnl = false;

    for (const log of tradeHistory) {
      if (log.message.includes("BUY FIRED")) {
        buys++;
      } else if (log.message.includes("SELL FIRED")) {
        sells++;
        const pnl = log.metadata?.pnl;
        if (typeof pnl === "number") {
          totalPnl += pnl;
          hasPnl = true;
        } else {
          // Fallback: parse from message "P&L: +$1.23" or "P&L: -$0.50"
          const match = log.message.match(/P&L:\s*([+-]?\$[\d.]+)/);
          if (match) {
            totalPnl += parseFloat(match[1].replace("$", ""));
            hasPnl = true;
          }
        }
      }
    }

    return { buys, sells, totalPnl, hasPnl };
  }, [tradeHistory]);

  const formatTradeTime = (iso: string): string =>
    new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZoneName: "short",
    }).format(new Date(iso));

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
            {/* Backend heartbeat */}
            <div className="flex items-center gap-1.5 text-xs">
              <div
                className={`w-1.5 h-1.5 rounded-full ${
                  backendStatus === "live"
                    ? "bg-green-500 animate-pulse"
                    : backendStatus === "stale"
                      ? "bg-yellow-500"
                      : "bg-neutral-700"
                }`}
              />
              <span
                className={
                  backendStatus === "live"
                    ? "text-green-400"
                    : backendStatus === "stale"
                      ? "text-yellow-400"
                      : "text-neutral-600"
                }
              >
                {backendStatus === "live"
                  ? "Backend"
                  : backendStatus === "stale"
                    ? "Backend stale"
                    : "Backend off"}
              </span>
            </div>

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

            {/* P&L toggle */}
            <button
              onClick={() => setShowTrades(!showTrades)}
              className={`text-xs border rounded px-2 py-1 ${
                tradeHistory.length > 0
                  ? "text-green-400 border-green-800 hover:text-green-300"
                  : "text-neutral-500 border-neutral-800 hover:text-neutral-300"
              }`}
            >
              P&L{tradeHistory.length > 0 ? ` (${tradeHistory.length})` : ""}
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

        {/* P&L + Trade History panel */}
        {showTrades && (
          <div className="mt-3 p-4 rounded-lg border border-neutral-800 bg-neutral-900/60">
            {/* Realized P&L summary */}
            <div className="flex items-center gap-6 mb-3 text-xs">
              <h3 className="text-sm font-medium">P&L</h3>
              {pnlSummary.buys > 0 && (
                <span className="text-green-400">
                  {pnlSummary.buys} buy{pnlSummary.buys !== 1 ? "s" : ""}
                </span>
              )}
              {pnlSummary.sells > 0 && (
                <span className="text-blue-400">
                  {pnlSummary.sells} sell{pnlSummary.sells !== 1 ? "s" : ""}
                </span>
              )}
              {pnlSummary.hasPnl && (
                <span
                  className={
                    pnlSummary.totalPnl >= 0
                      ? "text-green-400 font-bold"
                      : "text-red-400 font-bold"
                  }
                >
                  Realized: {pnlSummary.totalPnl >= 0 ? "+" : ""}$
                  {Math.abs(pnlSummary.totalPnl).toFixed(2)}
                </span>
              )}
            </div>

            {/* Trade history table */}
            {tradeHistory.length === 0 ? (
              <p className="text-xs text-neutral-600">
                No trades today.
              </p>
            ) : (
              <div className="max-h-80 overflow-y-auto space-y-0.5">
                {tradeHistory.map((entry) => {
                  const colonIdx = entry.message.indexOf(":");
                  const gameLabel =
                    colonIdx > 0
                      ? entry.message.substring(0, colonIdx)
                      : "";
                  const action =
                    colonIdx > 0
                      ? entry.message.substring(colonIdx + 2)
                      : entry.message;

                  return (
                    <div
                      key={entry.id}
                      className="flex items-baseline gap-3 text-xs font-mono py-0.5"
                    >
                      <span className="text-neutral-600 shrink-0 w-28">
                        {formatTradeTime(entry.timestamp)}
                      </span>
                      <span className="text-neutral-400 shrink-0 w-24 truncate">
                        {gameLabel}
                      </span>
                      <span className="text-green-400 flex-1 truncate">
                        {action}
                      </span>
                    </div>
                  );
                })}
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
                kalshiPosition={getKalshiPositionForGame(game)}
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
