"use client";

import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import { getTodayEastern, toGameDate } from "@/lib/dates";
import type { MlbGameLog, WLRecord } from "@/lib/types";
import DatePicker from "./DatePicker";
import MlbPredictionCard from "./MlbPredictionCard";
import RecordBadge from "./RecordBadge";

const SELECT_COLS = [
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

export default function MlbDashboard() {
  const [selectedDate, setSelectedDate] = useState(getTodayEastern());
  const [games, setGames] = useState<MlbGameLog[]>([]);
  const [allTimeRecord, setAllTimeRecord] = useState<WLRecord>({
    wins: 0,
    losses: 0,
  });
  const [loading, setLoading] = useState(true);
  const [allTimeLoading, setAllTimeLoading] = useState(true);

  // ── Fetch games for selected date ──────────────────────────────────
  const fetchGames = useCallback(async (dateStr: string) => {
    setLoading(true);
    const gameDate = toGameDate(dateStr);

    const { data, error } = await supabase
      .from("mlb_gamelogs")
      .select(SELECT_COLS)
      .eq("GAME_DATE", gameDate)
      .order("GAME_ID", { ascending: true });

    if (error) {
      console.error("Error fetching MLB games:", error);
      setGames([]);
    } else {
      setGames((data as unknown as MlbGameLog[]) ?? []);
    }
    setLoading(false);
  }, []);

  // ── Fetch all-time record (once on mount) ──────────────────────────
  const fetchAllTimeRecord = useCallback(async () => {
    setAllTimeLoading(true);

    const { data, error } = await supabase
      .from("mlb_gamelogs")
      .select("PREDICTION,GAME_OUTCOME")
      .not("PREDICTION", "is", null)
      .not("GAME_OUTCOME", "is", null)
      .limit(20000);

    if (error || !data) {
      console.error("Error fetching MLB all-time record:", error);
      setAllTimeLoading(false);
      return;
    }

    let wins = 0;
    let losses = 0;
    for (const row of data) {
      if (row.PREDICTION === row.GAME_OUTCOME) {
        wins++;
      } else {
        losses++;
      }
    }
    setAllTimeRecord({ wins, losses });
    setAllTimeLoading(false);
  }, []);

  useEffect(() => {
    fetchGames(selectedDate);
  }, [selectedDate, fetchGames]);

  useEffect(() => {
    fetchAllTimeRecord();
  }, [fetchAllTimeRecord]);

  // ── Compute daily record from displayed games ──────────────────────
  const dailyRecord: WLRecord = games.reduce(
    (acc, game) => {
      if (game.PREDICTION !== null && game.GAME_OUTCOME !== null) {
        if (game.PREDICTION === game.GAME_OUTCOME) {
          acc.wins++;
        } else {
          acc.losses++;
        }
      }
      return acc;
    },
    { wins: 0, losses: 0 },
  );

  const hasFinishedGames = games.some(
    (g) => g.PREDICTION !== null && g.GAME_OUTCOME !== null,
  );

  return (
    <div>
      {/* Header: title + date picker */}
      <div className="mb-6 flex items-center justify-between">
        <h1 className="font-mono text-2xl font-bold tracking-wider text-white">
          MLB Predictions
        </h1>
        <DatePicker value={selectedDate} onChange={setSelectedDate} />
      </div>

      {/* Records */}
      <div className="mb-6 flex gap-4">
        {hasFinishedGames && (
          <RecordBadge
            label="Daily"
            wins={dailyRecord.wins}
            losses={dailyRecord.losses}
          />
        )}
        {!allTimeLoading && (allTimeRecord.wins > 0 || allTimeRecord.losses > 0) && (
          <RecordBadge
            label="Overall"
            wins={allTimeRecord.wins}
            losses={allTimeRecord.losses}
          />
        )}
      </div>

      {/* Games list */}
      {loading ? (
        <div className="space-y-3">
          {Array.from({ length: 8 }).map((_, i) => (
            <div
              key={i}
              className="h-20 animate-pulse rounded-lg bg-neutral-800/50"
            />
          ))}
        </div>
      ) : games.length === 0 ? (
        <div className="py-20 text-center text-neutral-600">
          No games found for this date.
        </div>
      ) : (
        <div className="space-y-3">
          {games.map((game) => (
            <MlbPredictionCard key={game.GAME_ID} game={game} />
          ))}
        </div>
      )}
    </div>
  );
}
