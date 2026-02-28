"use client";

import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import { getTodayEastern, toGameDate } from "@/lib/dates";
import type { GameLog, MlbGameLog, WLRecord } from "@/lib/types";
import DatePicker from "./DatePicker";
import PredictionCard from "./PredictionCard";
import MlbPredictionCard from "./MlbPredictionCard";
import RecordBadge from "./RecordBadge";

type Sport = "all" | "nba" | "mlb";

const NBA_COLS = [
  "GAME_ID",
  "GAME_DATE",
  "AWAY_NAME",
  "HOME_NAME",
  "GAME_STATUS",
  "GAME_OUTCOME",
  "PREDICTION",
  "PREDICTION_PCT",
  "AWAY_PTS",
  "HOME_PTS",
].join(",");

const MLB_COLS = [
  "GAME_ID",
  "GAME_DATE",
  "AWAY_NAME",
  "HOME_NAME",
  "GAME_STATUS",
  "GAME_OUTCOME",
  "PREDICTION",
  "PREDICTION_PCT",
  "AWAY_RUNS",
  "HOME_RUNS",
  "HOME_SP",
  "AWAY_SP",
].join(",");

function computeRecord(
  games: { PREDICTION: number | null; GAME_OUTCOME: number | null }[],
): WLRecord {
  let wins = 0;
  let losses = 0;
  for (const g of games) {
    if (g.PREDICTION !== null && g.GAME_OUTCOME !== null) {
      if (g.PREDICTION === g.GAME_OUTCOME) wins++;
      else losses++;
    }
  }
  return { wins, losses };
}

export default function SignalsDashboard() {
  const [selectedDate, setSelectedDate] = useState(getTodayEastern());
  const [sport, setSport] = useState<Sport>("all");
  const [nbaGames, setNbaGames] = useState<GameLog[]>([]);
  const [mlbGames, setMlbGames] = useState<MlbGameLog[]>([]);
  const [nbaAllTime, setNbaAllTime] = useState<WLRecord>({
    wins: 0,
    losses: 0,
  });
  const [mlbAllTime, setMlbAllTime] = useState<WLRecord>({
    wins: 0,
    losses: 0,
  });
  const [loading, setLoading] = useState(true);
  const [allTimeLoading, setAllTimeLoading] = useState(true);

  // ── Fetch games for selected date ──────────────────────────────────
  const fetchGames = useCallback(async (dateStr: string) => {
    setLoading(true);
    const gameDate = toGameDate(dateStr);

    const [nbaRes, mlbRes] = await Promise.all([
      supabase
        .from("gamelogs")
        .select(NBA_COLS)
        .eq("GAME_DATE", gameDate)
        .order("GAME_ID", { ascending: true }),
      supabase
        .from("mlb_gamelogs")
        .select(MLB_COLS)
        .eq("GAME_DATE", gameDate)
        .order("GAME_ID", { ascending: true }),
    ]);

    if (nbaRes.error) console.error("NBA fetch error:", nbaRes.error);
    if (mlbRes.error) console.error("MLB fetch error:", mlbRes.error);

    setNbaGames((nbaRes.data as unknown as GameLog[]) ?? []);
    setMlbGames((mlbRes.data as unknown as MlbGameLog[]) ?? []);
    setLoading(false);
  }, []);

  // ── Fetch all-time records (once) ──────────────────────────────────
  const fetchAllTimeRecords = useCallback(async () => {
    setAllTimeLoading(true);

    const [nbaRes, mlbRes] = await Promise.all([
      supabase
        .from("gamelogs")
        .select("PREDICTION,GAME_OUTCOME")
        .not("PREDICTION", "is", null)
        .not("GAME_OUTCOME", "is", null)
        .limit(10000),
      supabase
        .from("mlb_gamelogs")
        .select("PREDICTION,GAME_OUTCOME")
        .not("PREDICTION", "is", null)
        .not("GAME_OUTCOME", "is", null)
        .limit(20000),
    ]);

    if (nbaRes.data) setNbaAllTime(computeRecord(nbaRes.data));
    if (mlbRes.data) setMlbAllTime(computeRecord(mlbRes.data));
    setAllTimeLoading(false);
  }, []);

  useEffect(() => {
    fetchGames(selectedDate);
  }, [selectedDate, fetchGames]);

  useEffect(() => {
    fetchAllTimeRecords();
  }, [fetchAllTimeRecords]);

  // ── Derived data ───────────────────────────────────────────────────
  const nbaDailyRecord = computeRecord(nbaGames);
  const mlbDailyRecord = computeRecord(mlbGames);

  const combinedDaily: WLRecord = {
    wins: nbaDailyRecord.wins + mlbDailyRecord.wins,
    losses: nbaDailyRecord.losses + mlbDailyRecord.losses,
  };
  const combinedAllTime: WLRecord = {
    wins: nbaAllTime.wins + mlbAllTime.wins,
    losses: nbaAllTime.losses + mlbAllTime.losses,
  };

  const hasNbaFinished = nbaGames.some(
    (g) => g.PREDICTION !== null && g.GAME_OUTCOME !== null,
  );
  const hasMlbFinished = mlbGames.some(
    (g) => g.PREDICTION !== null && g.GAME_OUTCOME !== null,
  );
  const hasDailyRecord = hasNbaFinished || hasMlbFinished;

  const showNba = sport === "all" || sport === "nba";
  const showMlb = sport === "all" || sport === "mlb";

  const totalGames =
    (showNba ? nbaGames.length : 0) + (showMlb ? mlbGames.length : 0);

  return (
    <div>
      {/* ── Header ── */}
      <div className="mb-8 flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="font-mono text-2xl font-bold tracking-wider text-white">
            Signals
          </h1>
          <p className="mt-1 text-xs tracking-wide text-neutral-600">
            Daily pregame predictions across all sports
          </p>
        </div>
        <DatePicker value={selectedDate} onChange={setSelectedDate} />
      </div>

      {/* ── Sport filter pills ── */}
      <div className="mb-6 flex items-center gap-2">
        {(
          [
            { key: "all", label: "All" },
            { key: "nba", label: "NBA" },
            { key: "mlb", label: "MLB" },
          ] as const
        ).map((s) => (
          <button
            key={s.key}
            onClick={() => setSport(s.key)}
            className={`rounded-full px-4 py-1.5 font-mono text-xs uppercase tracking-wider transition-all ${
              sport === s.key
                ? "bg-white text-neutral-950"
                : "border border-neutral-800 text-neutral-500 hover:border-neutral-700 hover:text-neutral-300"
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>

      {/* ── Record badges ── */}
      <div className="mb-6 flex flex-wrap gap-3">
        {sport === "all" && hasDailyRecord && (
          <RecordBadge
            label="Daily"
            wins={combinedDaily.wins}
            losses={combinedDaily.losses}
          />
        )}
        {sport === "all" &&
          !allTimeLoading &&
          (combinedAllTime.wins > 0 || combinedAllTime.losses > 0) && (
            <RecordBadge
              label="Overall"
              wins={combinedAllTime.wins}
              losses={combinedAllTime.losses}
            />
          )}
        {sport === "nba" && hasNbaFinished && (
          <RecordBadge
            label="NBA Daily"
            wins={nbaDailyRecord.wins}
            losses={nbaDailyRecord.losses}
          />
        )}
        {sport === "nba" &&
          !allTimeLoading &&
          (nbaAllTime.wins > 0 || nbaAllTime.losses > 0) && (
            <RecordBadge
              label="NBA Overall"
              wins={nbaAllTime.wins}
              losses={nbaAllTime.losses}
            />
          )}
        {sport === "mlb" && hasMlbFinished && (
          <RecordBadge
            label="MLB Daily"
            wins={mlbDailyRecord.wins}
            losses={mlbDailyRecord.losses}
          />
        )}
        {sport === "mlb" &&
          !allTimeLoading &&
          (mlbAllTime.wins > 0 || mlbAllTime.losses > 0) && (
            <RecordBadge
              label="MLB Overall"
              wins={mlbAllTime.wins}
              losses={mlbAllTime.losses}
            />
          )}
      </div>

      {/* ── Game cards ── */}
      {loading ? (
        <div className="space-y-3">
          {Array.from({ length: 8 }).map((_, i) => (
            <div
              key={i}
              className="h-20 animate-pulse rounded-lg bg-neutral-800/50"
            />
          ))}
        </div>
      ) : totalGames === 0 ? (
        <div className="py-20 text-center text-neutral-600">
          No games found for this date.
        </div>
      ) : (
        <div className="space-y-8">
          {/* NBA Section */}
          {showNba && nbaGames.length > 0 && (
            <section>
              {sport === "all" && (
                <div className="mb-3 flex items-center gap-3">
                  <h2 className="font-mono text-xs font-medium uppercase tracking-[0.2em] text-neutral-500">
                    NBA
                  </h2>
                  <div className="h-px flex-1 bg-neutral-800/60" />
                  <span className="font-mono text-xs text-neutral-700">
                    {nbaGames.length} game
                    {nbaGames.length !== 1 ? "s" : ""}
                  </span>
                </div>
              )}
              <div className="space-y-2">
                {nbaGames.map((game) => (
                  <PredictionCard key={game.GAME_ID} game={game} />
                ))}
              </div>
            </section>
          )}

          {/* MLB Section */}
          {showMlb && mlbGames.length > 0 && (
            <section>
              {sport === "all" && (
                <div className="mb-3 flex items-center gap-3">
                  <h2 className="font-mono text-xs font-medium uppercase tracking-[0.2em] text-neutral-500">
                    MLB
                  </h2>
                  <div className="h-px flex-1 bg-neutral-800/60" />
                  <span className="font-mono text-xs text-neutral-700">
                    {mlbGames.length} game
                    {mlbGames.length !== 1 ? "s" : ""}
                  </span>
                </div>
              )}
              <div className="space-y-2">
                {mlbGames.map((game) => (
                  <MlbPredictionCard key={game.GAME_ID} game={game} />
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
