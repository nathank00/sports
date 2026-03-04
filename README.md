<div align="center">

# [ ONE OF ONE ]

**Algorithmic sports prediction platform** — quantitative modeling, real-time edge computation, and autonomous execution on [Kalshi](https://kalshi.com) prediction markets

<br />

[Platform](#the-platform) · [Autopilot](#autopilot) · [Pregame Models](#pregame-models) · [Architecture](#architecture) · [Tech Stack](#tech-stack)

</div>

---

ONE OF ONE is a vertically integrated prediction and execution platform for sports markets. It pairs pregame ensemble classifiers with a live in-game probabilistic model to surface mispriced contracts on Kalshi — then acts on them autonomously.

The system ingests play-by-play telemetry, engineers temporal and contextual features, fits calibrated probability models on historical outcomes, and evaluates the resulting predictions against live market prices to isolate and capture edge in real time.


---

## The Platform

Three tiers. One pipeline.

| Tier | Description | Access |
|------|------------|--------|
| **Signals** | Daily pregame probability estimates with implied market price and computed edge for every game | Free |
| **Terminal** | Manual execution interface — predictions matched to live Kalshi contracts with configurable position sizing and one-click order placement | Subscription |
| **Autopilot** | Autonomous in-game engine — real-time win probability inference, continuous market surveillance, and algorithmic trade execution when edge exceeds threshold | Subscription |

---

## Autopilot

The flagship product. A live win probability engine that ingests play-by-play state during NBA games, infers calibrated outcome probabilities, and compares them against Kalshi market prices to detect and execute on mispricings.

### Model

L2-regularized logistic regression fit on **19 engineered features** across **510,000+ play-by-play snapshots** spanning six NBA seasons (2020–2025). The feature set captures game state, momentum, pregame market expectations, and their interactions:

| Metric | Value |
|--------|-------|
| Brier Score | 0.147 |
| ROC AUC | 0.869 |
| Accuracy | 77.8% |
| Test Samples | 102,037 |
| Calibration | Well-calibrated across all probability deciles |

**Feature vector** — score margin, time fraction, period, possession indicator, pregame spread, pregame moneyline implied probability, home/away offensive rating, home/away defensive rating, pace, home/away possession count, home/away timeouts remaining, home/away team foul count, margin &times; time interaction, spread &times; time interaction.

The interaction terms are critical — they allow the model to learn that a 10-point lead means something fundamentally different in Q1 than in Q4, and that pregame market expectations decay as in-game evidence accumulates.

Pregame odds (spread + moneyline) are sourced from ESPN pickcenter during live games. Historical training data was backfilled from OddsShark's scores API across all six seasons for complete feature coverage.

### Live Loop

An asynchronous orchestrator polls ESPN's live feed every 3 seconds during active games. On each state transition:

1. Constructs a `GameState` from the current box score and play-by-play context
2. Extracts the 19-dimensional feature vector
3. Runs the logistic model (microsecond inference — pure dot product against stored coefficients)
4. Fetches current Kalshi contract prices (30-second cache)
5. Computes directional edge against both home and away contracts
6. Writes a trading signal to the database

Signals propagate to the frontend via Supabase real-time subscriptions. The dashboard can optionally auto-execute orders on Kalshi when edge exceeds the user's configured threshold.

### Signal Logic

```
edge = model_probability − market_implied_probability

If edge_home > threshold → BUY_HOME
If edge_away > threshold → BUY_AWAY
Otherwise → NO_TRADE

Default threshold: 8%
Per-game cooldown: 60s
No execution in final 2 minutes of Q4/OT (insufficient liquidity window)
```

### Training Pipeline

```bash
python run_calibrate.py ingest                    # Ingest 6 seasons of PBP data → 510K snapshots
python run_calibrate.py backfill-oddsshark-odds   # Backfill pregame odds from OddsShark API
python run_calibrate.py train                     # Fit model, evaluate, export coefficients
```

### Continuous Learning

A daily cleanup job converts yesterday's live signals into labeled training snapshots, matches final game outcomes, and prunes stale data — the training corpus grows organically with every game the system observes.

---

## Pregame Models

Two gradient-boosted ensemble classifiers (XGBoost) generate daily pregame win probability estimates for NBA and MLB.

Both pipelines follow the same disciplined methodology: ingest raw game and player data from official league APIs, engineer multi-horizon rolling statistical features at the player and team level, and fit binary classifiers on chronologically-split historical outcomes. All rolling computations apply `shift(1)` to enforce strict temporal separation — the model never sees information that wasn't available before game time.

The NBA model operates on team-level rolling aggregates across offensive and defensive box score categories with home/away differential features. The MLB model is lineup-aware — it constructs position-weighted composites of individual batter rolling statistics and models starting pitcher matchups independently from bullpen tendencies, producing a 108-dimensional feature space.

Both models run on automated schedules via GitHub Actions and write predictions directly to the database, where the web dashboard and trading interfaces consume them.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                      SUPABASE (PostgreSQL)                       │
│                                                                  │
│  gamelogs │ mlb_gamelogs │ autopilot_signals │ autopilot_training │
└─────┬───────────┬──────────────┬───────────────────┬─────────────┘
      │           │              │                   │
┌─────┴─────┐ ┌───┴───┐  ┌──────┴──────┐     ┌──────┴─────┐
│  PREGAME  │ │  WEB  │  │  AUTOPILOT  │     │   KALSHI   │
│ PIPELINES │ │(reads)│  │ (live loop) │     │  (trading) │
└─────┬─────┘ └───────┘  └──────┬──────┘     └────────────┘
      │                         │
┌─────┴──────┐          ┌──────┴──────┐
│  nba_api / │          │  ESPN API / │
│  MLB Stats │          │  cdn.nba.com│
└────────────┘          └─────────────┘
```

---

## Automation

All pipelines are orchestrated via GitHub Actions with configurable schedules and manual dispatch.

| Workflow | Schedule | Description |
|----------|----------|-------------|
| **NBA Pipeline** | 9:00 AM, 12:15 PM, 1:00 PM ET | Pregame inference |
| **MLB Pipeline** | 9:00 AM ET + every 10 min 11 AM–1 AM | Pregame inference + live lineup capture |
| **Autopilot** | 12:00 PM, 6:30 PM ET | Live win probability + signal generation |
| **Autopilot Cleanup** | 10:00 AM ET daily | Signal → training snapshot conversion |

---

## Project Structure

```
oneofone/
├── .github/workflows/
│   ├── nba-pipeline.yml             # Pregame NBA (3x daily)
│   ├── mlb-pipeline.yml             # Pregame MLB (daily + live)
│   ├── autopilot.yml                # Live win probability loop
│   └── autopilot-cleanup.yml        # Daily training data conversion
│
├── nba-pipeline/                    # NBA pregame prediction pipeline
│   ├── src/                         # Ingestion, feature engineering, training, inference
│   ├── run_pipeline.py              # Orchestrator (historical / current)
│   └── models/                      # Trained model artifacts
│
├── mlb-pipeline/                    # MLB pregame prediction pipeline
│   ├── src/                         # Ingestion, feature engineering, training, inference
│   ├── run_pipeline.py              # Orchestrator (historical / current / live)
│   └── models/                      # Trained model artifacts
│
├── autopilot/                       # Live in-game win probability system
│   ├── src/
│   │   ├── features/                # GameState dataclass, feature vector extraction
│   │   ├── ingest/                  # ESPN live feed, OddsShark backfill, historical PBP
│   │   ├── loop/                    # Async orchestrator, per-game state tracking
│   │   ├── model/                   # Logistic regression inference, calibration pipeline
│   │   └── trading/                 # Signal evaluation, Kalshi market matching
│   ├── coefficients/                # Trained model coefficients (JSON)
│   ├── run_live.py                  # Live loop entry point
│   ├── run_calibrate.py             # Training + evaluation pipeline
│   └── run_cleanup.py               # Daily signal → training conversion
│
├── web/                             # Next.js web application
│   └── src/
│       ├── app/                     # Pages: /, /signals, /terminal, /autopilot, /profile
│       ├── components/              # Dashboards, trading cards, paywall, navigation
│       └── lib/                     # Supabase client, Kalshi API, Stripe billing, types
│
├── desktop/                         # Tauri desktop trading application
│   ├── src/                         # React frontend
│   └── src-tauri/src/               # Rust backend (Kalshi auth, market scanner)
│
└── shared/                          # Shared constants and database schemas
```

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **Pregame Models** | Python 3.12, XGBoost, pandas, numpy, nba_api, MLB Stats API |
| **Autopilot Model** | Python 3.12, scikit-learn (L2-regularized logistic regression), asyncio, aiohttp |
| **Web** | Next.js 16, React 19, TypeScript 5, Tailwind CSS 4 |
| **Database** | Supabase (PostgreSQL) with real-time change subscriptions |
| **Auth** | Supabase Auth (email/password) |
| **Billing** | Stripe (per-product subscriptions, customer portal) |
| **Hosting** | Vercel (web), GitHub Actions (pipelines + live loop) |
| **Markets** | Kalshi API (RSA-PSS signed requests) |
| **Desktop** | Tauri 2, Rust, React 19 |

---

<div align="center">
<sub>Built by <a href="https://github.com/nathank00">@nathank00</a></sub>
</div>
