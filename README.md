<p align="center">
  <h1 align="center">[ ONE OF ONE ]</h1>
  <p align="center">
    AI-powered sports prediction engine + automated Kalshi trading
    <br />
    <a href="https://github.com/nathank00/oneofone/releases/latest"><strong>Download Desktop App</strong></a>
    &nbsp;&middot;&nbsp;
    <a href="#architecture">Architecture</a>
    &nbsp;&middot;&nbsp;
    <a href="#pipelines">Pipelines</a>
  </p>
</p>

---

## ONE OF ONE

ONE OF ONE is a sports prediction platform that trains ML models on historical game data, generates daily win predictions, and trades on those predictions through [Kalshi](https://kalshi.com) prediction markets.

| Component | What it does | Tech |
|-----------|-------------|------|
| **NBA Pipeline** | Game ingestion, feature engineering, XGBoost predictions | Python, nba_api, Supabase |
| **MLB Pipeline** | Lineup-weighted rolling stats, pitcher matchup modeling | Python, MLB Stats API, Supabase |
| **Web Dashboard** | Public predictions and historical record | Next.js, React, Tailwind |
| **Desktop App** | Trading interface — view edges, place bets, auto-scanner | Tauri 2, Rust, Kalshi API |

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         SUPABASE (PostgreSQL)                       │
│                                                                     │
│  nba_gamelogs  │  mlb_gamelogs  │  players  │  playerstats  │ ...  │
└──────────────┬──────────────────┬──────────────────┬────────────────┘
               │                  │                  │
         ┌─────┴─────┐    ┌──────┴──────┐    ┌──────┴──────┐
         │ PIPELINES  │    │     WEB     │    │   DESKTOP   │
         │  (writes)  │    │   (reads)   │    │   (reads)   │
         └─────┬─────┘    └─────────────┘    └──────┬──────┘
               │                                     │
        ┌──────┴──────┐                       ┌──────┴──────┐
        │  nba_api /  │                       │  Kalshi API │
        │  MLB Stats  │                       │  (trading)  │
        └─────────────┘                       └─────────────┘
```

---

## Pipelines

Both pipelines follow the same six-stage architecture. Each stage has a **full** mode (backfill from scratch) and a **current** mode (incremental delta updates). All rolling stats use `shift(1)` to prevent data leakage — the model only sees information that was available before game time.

```
    ┌──────────┐    ┌──────────┐    ┌────────────┐
    │  games   │    │ players  │    │ playerstats │
    │  .py     │    │  .py     │    │    .py      │
    └────┬─────┘    └────┬─────┘    └──────┬──────┘
         │               │                 │
         └───────────────┼─────────────────┘
                         ▼
                  ┌──────────────┐
                  │  gamelogs.py │   Feature engineering
                  │  (rolling)   │   (no data leakage)
                  └──────┬───────┘
                         │
                  ┌──────┴───────┐
                  │   train.py   │   XGBoost classifier
                  └──────┬───────┘
                         │
                  ┌──────┴───────┐
                  │  predict.py  │   Daily inference
                  │              │   → Supabase
                  └──────────────┘
```

Each pipeline is orchestrated by a `run_pipeline.py` at the pipeline root. The orchestrator chains the stages in the correct order and handles logging/error propagation.

### NBA Pipeline

XGBoost binary classifier on team-level rolling averages.

- **Features**: 10 & 30 game rolling averages for PTS, REB, AST, STL, BLK, TOV, FG%, FG3%, FT%, +/-, plus home-vs-away differentials
- **Training**: Chronological 80/20 split, ~7K training samples
- **Data source**: `nba_api` (NBA.com)
- **Orchestration**: `run_pipeline.py` with two modes — `historical` (full rebuild) and `current` (delta update)
- **Schedule**: Runs 3x daily — 9:00 AM, 12:15 PM, and 1:00 PM ET

### MLB Pipeline

XGBoost binary classifier with lineup-aware, individual-player rolling stats.

- **Batting features**: Weighted average of the 1–9 lineup hitters' rolling stats (BA, OBP, SLG, OPS, R, HR, RBI, BB, SO, SB). Batter 1 gets the highest weight, batter 9 the lowest.
- **Pitching features**: Starting pitcher individual rolling stats (ERA, WHIP, SO, BB, HR, IP) + bullpen average rolling stats
- **Team features**: Win rate and games played over 10 & 50 game windows
- **Training**: ~12.7K samples, 108 features, chronological split
- **Data source**: MLB Stats API (schedule, live feed for lineups, per-player gamelogs)
- **Orchestration**: `run_pipeline.py` with three modes — `historical` (full rebuild), `current` (daily delta), and `live` (lightweight lineup capture + predict)
- **Schedule**: `current` runs daily at 9:00 AM ET. `live` runs every 10 minutes from 11 AM – 1 AM ET to capture lineups as they post (~1-2h pre-game).

---

## Automation

Both pipelines are automated via GitHub Actions (`.github/workflows/`). Each workflow can be enabled or disabled from the Actions tab in the GitHub repo, and can also be triggered manually with a mode selector.

| Workflow | Schedule | Mode |
|----------|----------|------|
| **NBA Pipeline** | 9:00 AM, 12:15 PM, 1:00 PM ET | `current` |
| **MLB Pipeline** | 9:00 AM ET | `current` |
| **MLB Pipeline** | Every 10 min, 11 AM – 1 AM ET | `live` |

Both require `SUPABASE_URL` and `SUPABASE_KEY` as repository secrets.

---

## Desktop App

The desktop app is the trading interface. Connects to Supabase for predictions and Kalshi for market execution.

**Dashboard** — Portfolio overview: cash balance, portfolio value, open positions

**Manual Mode** — Today's predictions with confidence %, matched Kalshi markets with edge calculations, one-click bet placement

**Auto Mode** — Background scanner that polls every 30s, matches predictions to live markets, calculates edge, and auto-places bets when edge exceeds your threshold

**Settings** — Kalshi API credentials (RSA-PSS signed requests), edge threshold, bet sizing, demo/live toggle

### Edge Calculation

```
edge = (model_probability - market_implied_probability) x 100

Example:
  Model says Lakers win at 72%
  Kalshi market implies 60% (yes_ask = $0.60)
  Edge = +12% → auto-bet fires if threshold < 12%
```

---

## Web Dashboard

The web dashboard displays predictions and historical accuracy for both NBA and MLB. Built with Next.js 16, React 19, and Tailwind CSS 4. Reads directly from Supabase on the client side — no backend API needed.

Each sport page shows a date picker, prediction cards with confidence percentages, and daily/all-time W-L records. Completed games display the final score and whether the prediction was correct.

---

## Project Structure

```
oneofone/
├── .github/workflows/
│   ├── nba-pipeline.yml        # Scheduled automation (3x daily)
│   └── mlb-pipeline.yml        # Scheduled automation (daily + live)
│
├── nba-pipeline/               # NBA prediction pipeline
│   ├── src/
│   │   ├── games.py            # Game + roster ingestion
│   │   ├── players.py          # Player metadata
│   │   ├── playerstats.py      # Per-player game stats
│   │   ├── gamelogs.py         # Rolling feature engineering
│   │   ├── train.py            # XGBoost training
│   │   └── predict.py          # Daily inference
│   ├── run_pipeline.py         # Orchestrator (historical / current)
│   └── models/
│
├── mlb-pipeline/               # MLB prediction pipeline
│   ├── src/
│   │   ├── games.py            # Schedule + lineup ingestion
│   │   ├── players.py          # Player metadata + type classification
│   │   ├── playerstats.py      # Per-player batting/pitching gamelogs
│   │   ├── gamelogs.py         # Lineup-weighted feature engineering
│   │   ├── train.py            # XGBoost training
│   │   └── predict.py          # Daily inference
│   ├── run_pipeline.py         # Orchestrator (historical / current / live)
│   ├── models/
│   └── migrations/
│
├── web/                        # Next.js dashboard
│   └── src/
│       ├── app/                # Pages (/, /nba, /mlb)
│       ├── components/         # Dashboard, PredictionCard, DatePicker
│       └── lib/                # Supabase client, types, date helpers
│
├── desktop/                    # Tauri trading app
│   ├── src/                    # React frontend
│   └── src-tauri/src/          # Rust backend (Kalshi auth, scanner)
│
└── shared/                     # Constants, schemas
    ├── nba/
    ├── mlb/
    └── schemas/
```

---

## Tech Stack

```
┌──────────────────────────────────────────────────────────────────┐
│                        ONE OF ONE                                │
├──────────────┬──────────────────┬────────────────────────────────┤
│  Pipelines   │       Web        │           Desktop              │
├──────────────┼──────────────────┼────────────────────────────────┤
│ Python 3.12  │ Next.js 16       │ Tauri 2 (Rust)                 │
│ XGBoost      │ React 19         │ React 19 + Vite                │
│ pandas/numpy │ Tailwind CSS 4   │ Tailwind CSS 4                 │
│ nba_api      │ Supabase JS      │ reqwest + tokio                │
│ MLB Stats API│ TypeScript 5     │ rsa (PKCS#1/PKCS#8)            │
│ supabase-py  │ Vercel           │ serde + chrono                 │
└──────────────┴──────────────────┴────────────────────────────────┘
                         │
                    Supabase
                   (PostgreSQL)
```

---

## License

MIT — see [LICENSE](LICENSE) for details.
