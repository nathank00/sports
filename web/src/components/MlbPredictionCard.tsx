import type { MlbGameLog } from "@/lib/types";

interface MlbPredictionCardProps {
  game: MlbGameLog;
}

export default function MlbPredictionCard({ game }: MlbPredictionCardProps) {
  const {
    AWAY_NAME,
    HOME_NAME,
    PREDICTION,
    PREDICTION_PCT,
    GAME_OUTCOME,
    GAME_STATUS,
    AWAY_RUNS,
    HOME_RUNS,
  } = game;

  const hasPrediction = PREDICTION !== null && PREDICTION_PCT !== null;
  // MLB: GAME_STATUS 3 = final, 4 = postponed
  const isCompleted = GAME_STATUS === 3 || GAME_OUTCOME !== null;

  // Predicted winner name
  const predictedWinner = PREDICTION === 1 ? HOME_NAME : AWAY_NAME;

  // Confidence from the predicted winner's perspective
  const confidence =
    hasPrediction
      ? PREDICTION === 1
        ? PREDICTION_PCT!
        : 1 - PREDICTION_PCT!
      : null;

  const confidenceStr =
    confidence !== null ? `${Math.round(confidence * 100)}%` : null;

  // Check if prediction was correct
  let predictionCorrect: boolean | null = null;
  if (isCompleted && hasPrediction && GAME_OUTCOME !== null) {
    predictionCorrect = PREDICTION === GAME_OUTCOME;
  }

  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900/60 p-4 transition-colors hover:border-neutral-700">
      {/* Matchup */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <span
            className={`text-sm font-medium truncate ${
              PREDICTION === 0 ? "text-white" : "text-neutral-400"
            }`}
          >
            {AWAY_NAME}
          </span>
          <span className="text-neutral-600 shrink-0">@</span>
          <span
            className={`text-sm font-medium truncate ${
              PREDICTION === 1 ? "text-white" : "text-neutral-400"
            }`}
          >
            {HOME_NAME}
          </span>
        </div>

        {/* Score for completed games */}
        {isCompleted && AWAY_RUNS != null && HOME_RUNS != null && (
          <span className="font-mono text-sm text-neutral-500 ml-3 shrink-0">
            {AWAY_RUNS} - {HOME_RUNS}
          </span>
        )}
      </div>

      {/* Prediction details */}
      {hasPrediction ? (
        <div className="mt-2 flex items-center gap-3">
          <span className="text-xs uppercase tracking-wider text-neutral-600">
            Pick
          </span>
          <span className="text-sm font-semibold text-white">
            {predictedWinner}
          </span>
          <span className="font-mono text-sm text-neutral-400">
            {confidenceStr}
          </span>

          {/* W/L badge for finished games */}
          {predictionCorrect !== null && (
            <span
              className={`ml-auto rounded-full px-2.5 py-0.5 text-xs font-bold ${
                predictionCorrect
                  ? "bg-green-900/40 text-green-400"
                  : "bg-red-900/40 text-red-400"
              }`}
            >
              {predictionCorrect ? "W" : "L"}
            </span>
          )}
        </div>
      ) : (
        <div className="mt-2">
          <span className="text-xs text-neutral-600">No prediction</span>
        </div>
      )}
    </div>
  );
}
