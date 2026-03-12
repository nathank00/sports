<div align="center">

# [ ONE OF ONE ]

**Quantitative prediction market trading platform** — probability modeling, real-time edge computation, and disciplined execution on [Kalshi](https://kalshi.com)

<br />

[Platform](#the-platform) · [Autopilot](#autopilot) · [Pregame Models](#pregame-models) · [Architecture](#architecture) · [Tech Stack](#tech-stack)

</div>

---

ONE OF ONE is a vertically integrated prediction and execution platform for sports prediction markets. It pairs pregame ensemble classifiers with a live in-game probabilistic model to surface mispriced contracts on Kalshi — then executes on them with disciplined risk controls.

The system ingests play-by-play telemetry, engineers temporal and contextual features, fits calibrated probability models on historical outcomes, and evaluates the resulting predictions against live market prices. Execution is governed by friction-aware edge computation, liquidity filters, anti-hedging enforcement, and configurable take-profit / stop-loss auto-exits.


---

## The Platform

Three tiers. One pipeline.

| Tier | Description | Access |
|------|------------|--------|
| **Signals** | Daily probability estimates, market-implied price, and computed edge for every game. Model outputs compared to live Kalshi prices | Free |
| **Terminal** | Manual execution with configurable sizing and risk controls. Connect Kalshi keys, match model outputs to live markets, and place orders with calculated position sizing | Subscription |
| **Autopilot** | Rule-based live market surveillance and automated execution when multiple conditions align. Probability smoothing, liquidity filters, take-profit, stop-loss, and disciplined entry criteria | Subscription |

---

## Autopilot

The flagship product. A live win probability engine that ingests play-by-play state during NBA games, infers calibrated outcome probabilities, blends them with pregame market expectations, and compares the result against Kalshi market prices. Trades are executed only when edge survives friction deduction, spread-width filters, and underdog guards — with automatic take-profit, stop-loss, and late-game exits.

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

### Probability Blending

Raw model output is volatile — a single basket can swing the probability by ~10 percentage points mid-game, creating ephemeral "edges" that disappear on the next possession. The blending layer stabilizes output before it reaches the decision engine:

1. **Exponential smoothing** (EMA, &alpha; = 0.3) — dampens single-basket spikes by blending each new raw prediction with the running smoothed value
2. **Time-weighted pregame anchor** — blends the smoothed model output with the pregame moneyline probability, decaying from 60% pregame weight in Q1 to 5% in the final minutes

This ensures the model properly reflects pregame expectations early (when in-game evidence is thin) while gradually releasing to pure model output as the game progresses.

### Live Loop

An asynchronous orchestrator polls ESPN's live feed every 3 seconds during active games. On each state transition:

1. Constructs a `GameState` from the current box score and play-by-play context
2. Extracts the 19-dimensional feature vector
3. Runs the logistic model (microsecond inference — pure dot product against stored coefficients)
4. Applies probability blending (EMA smoothing + pregame anchor)
5. Fetches current Kalshi contract prices (30-second cache)
6. Computes directional edge against both home and away contracts, deducting friction
7. Applies spread-width, underdog, and blowout filters
8. Writes a trading signal with structured reason code to the database
9. Checks open positions for auto-exit conditions (TP/SL/late-game)

Signals propagate to the frontend via Supabase real-time subscriptions. The dashboard auto-executes orders on Kalshi when edge exceeds the user's configured threshold and all quality filters pass.

### Signal Logic

```
raw_edge = blended_probability − kalshi_ask_price
edge = raw_edge − friction (Kalshi fee: $0.02/contract)

Filter chain (in order):
  1. No-trade window: block if < 4 min remain in Q4/OT
  2. Blowout filter: block if score margin > 15 in Q4+
  3. Spread filter: block side if bid-ask spread > $0.10
  4. Underdog guard: if model prob < 20%, require 2x edge threshold
  5. Edge threshold: edge after friction must exceed user's threshold

If edge_home qualifies → BUY_HOME
If edge_away qualifies → BUY_AWAY
Otherwise → NO_TRADE (with structured reason code)
```

### Execution Discipline

Positions follow a strict state machine with anti-hedging enforcement:

```
FLAT → PENDING_ENTRY → LONG_HOME/LONG_AWAY → PENDING_EXIT → EXITING → LOCKED → FLAT
```

- **One direction per event**: the system never holds both home and away contracts simultaneously
- **Anti-hedging**: opposite-side entries are blocked while a position is open
- **Auto-exit**: take-profit, stop-loss, and late-game triggers create `PENDING_EXIT` intents that the frontend executes automatically
- **Cooldown**: after any exit, the event enters a configurable cooldown before new entries are allowed
- **Intent architecture**: the Python backend creates entry/exit intents in Supabase; the frontend (which holds the user's Kalshi API keys) executes them via real-time subscription

### Training Pipeline

```bash
python run_calibrate.py ingest                    # Ingest 6 seasons of PBP data → 510K snapshots
python run_calibrate.py backfill-oddsshark-odds   # Backfill pregame odds from OddsShark API
python run_calibrate.py train                     # Fit model, evaluate, export coefficients
```

### Continuous Learning

A daily GitHub Actions job runs each morning:

1. **Cleanup** — converts yesterday's live signals into labeled training snapshots, matches final game outcomes, and prunes stale signal data
2. **Retrain** — fits the model on the expanded training corpus and promotes the updated coefficients if performance improves

The training corpus grows organically with every game the system observes.

---

## Pregame Models

Two gradient-boosted ensemble classifiers (XGBoost) generate daily pregame win probability estimates for NBA and MLB.

Both pipelines follow the same disciplined methodology: ingest raw game and player data from official league APIs, engineer multi-horizon rolling statistical features at the player and team level, and fit binary classifiers on chronologically-split historical outcomes. All rolling computations apply `shift(1)` to enforce strict temporal separation — the model never sees information that wasn't available before game time.

The NBA model operates on team-level rolling aggregates across offensive an defensive box score categories with home/away differential features. The MLB model is lineup-aware — it constructs position-weighted composites of individual batter rolling statistics and models starting pitcher matchups independently from bullpen tendencies, producing a 108-dimensional feature space.

Both models run on automated schedules via GitHub Actions and write predictions directly to the database, where the web dashboard and trading interfaces consume them.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                        SUPABASE (PostgreSQL)                          │
│                                                                      │
│  gamelogs │ autopilot_signals │ autopilot_positions │ autopilot_settings│
└─────┬──────────────┬──────────────────┬──────────────────┬───────────┘
      │              │                  │                  │
┌─────┴─────┐  ┌─────┴──────┐    ┌─────┴──────┐    ┌──────┴─────┐
│  PREGAME  │  │  AUTOPILOT │    │    WEB     │    │   KALSHI   │
│ PIPELINES │  │ (backend)  │    │ (frontend) │───→│  (trading) │
└─────┬─────┘  └─────┬──────┘    └────────────┘    └────────────┘
      │              │               ▲
┌─────┴──────┐ ┌─────┴──────┐       │
│  nba_api / │ │  ESPN API / │  Supabase Realtime
│  MLB Stats │ │  cdn.nba.com│  (position state changes)
└────────────┘ └─────────────┘
```

The backend creates trading intents (entries and exits) in Supabase. The frontend subscribes to position state changes via Supabase Realtime and executes orders against Kalshi — keeping API keys exclusively in the browser.

---

## Automation

All pipelines are orchestrated via GitHub Actions with configurable schedules and manual dispatch.

| Workflow | Schedule | Description |
|----------|----------|-------------|
| **NBA Pipeline** | 9:00 AM, 12:15 PM, 1:00 PM ET | Pregame inference |
| **MLB Pipeline** | 9:00 AM ET + every 10 min 11 AM–1 AM | Pregame inference + live lineup capture |
| **Autopilot** | 12:00 PM, 6:30 PM ET | Live win probability + signal generation |
| **Autopilot Cleanup + Retrain** | 10:00 AM ET daily | Signal → training snapshot conversion, then model retraining |

---

## Project Structure

```
oneofone/
├── .github/workflows/
│   ├── nba-pipeline.yml             # Pregame NBA (3x daily)
│   ├── mlb-pipeline.yml             # Pregame MLB (daily + live)
│   ├── autopilot.yml                # Live win probability loop
│   └── autopilot-cleanup.yml        # Daily cleanup + model retraining
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
│   │   ├── model/                   # Logistic regression inference, probability blending
│   │   └── trading/                 # Signal evaluation, position management, market matching
│   ├── coefficients/                # Trained model coefficients (JSON)
│   ├── run_live.py                  # Live loop entry point
│   ├── run_calibrate.py             # Training + evaluation pipeline
│   ├── run_retrain.py               # Daily model retraining
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
