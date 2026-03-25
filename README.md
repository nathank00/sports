<div align="center">

# [ EDGEMASTER ]

**Quantitative prediction market trading platform** — probability modeling, real-time edge computation, and disciplined execution on [Kalshi](https://kalshi.com)

<br />

[Platform](#the-platform) · [Autopilot](#autopilot) · [Pregame Models](#pregame-models) · [Architecture](#architecture) · [Tech Stack](#tech-stack)

</div>

---

Edgemaster is a vertically integrated prediction and execution platform for sports prediction markets. It pairs pregame ensemble classifiers with live in-game probabilistic models to surface mispriced contracts on Kalshi — then executes on them with disciplined risk controls.

The system ingests live game telemetry, engineers temporal and contextual features, fits calibrated probability models on historical outcomes, and evaluates the resulting predictions against live market prices. Execution is governed by friction-aware edge computation, liquidity filters, anti-hedging enforcement, and configurable take-profit / stop-loss auto-exits.

Currently supports **NBA** and **MLB**.

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

The flagship product. A live win probability engine that runs during NBA and MLB games, infers calibrated outcome probabilities, blends them with pregame market expectations, and compares the result against Kalshi market prices. Trades are executed only when edge survives friction deduction, spread-width filters, and underdog guards — with automatic take-profit, stop-loss, and late-game exits.

The autopilot dashboard provides a tabbed interface (NBA | MLB) with independent settings, game feeds, and execution controls per sport.

### NBA Model

L2-regularized logistic regression fit on **19 engineered features** across **510,000+ play-by-play snapshots** spanning six NBA seasons (2020–2025).

| Metric | Value |
|--------|-------|
| Brier Score | 0.147 |
| ROC AUC | 0.869 |
| Accuracy | 77.8% |
| Test Samples | 102,037 |

**Features** — score margin, time fraction, period, possession indicator, pregame spread, pregame moneyline implied probability, home/away offensive rating, home/away defensive rating, pace, home/away possession count, home/away timeouts remaining, home/away team foul count, margin × time interaction, spread × time interaction.

Pregame odds (spread + moneyline) are sourced from ESPN pickcenter during live games. Historical training data was backfilled from OddsShark across all six seasons.

### MLB Model

Analytical logistic regression with **8 hand-calibrated features** derived from well-known baseball win expectancy tables. Requires no training data — coefficients are set analytically based on historical run-scoring distributions and home-field advantage rates.

**Features** — score margin, outs fraction (outs elapsed / 54), inning, is-home-batting indicator, pregame spread, pregame moneyline probability, margin × outs interaction, spread × outs interaction.

MLB uses **outs remaining** as its time metric (54 total in regulation: 9 innings × 6 outs per inning). Extra innings reset to 6 outs per inning.

### Probability Blending

Raw model output is volatile — a single score change can swing probability significantly, creating ephemeral "edges" that disappear on the next play. The blending layer stabilizes output before it reaches the decision engine:

1. **Exponential smoothing** (EMA, α = 0.3) — dampens single-play spikes
2. **Time-weighted pregame anchor** — blends smoothed output with pregame moneyline probability, decaying from 60% pregame weight early to 5% late

### Live Loop

An asynchronous orchestrator polls ESPN's live feed every 3 seconds during active games. On each state transition:

1. Constructs a game state from the current score, period/inning, and contextual data
2. Extracts the feature vector
3. Runs the model (microsecond inference)
4. Applies probability blending
5. Fetches current Kalshi contract prices (15-second cache)
6. Computes directional edge against both home and away contracts, deducting friction
7. Applies spread-width, underdog, and blowout filters
8. Writes a trading signal with structured reason code to the database

Signals propagate to the frontend via Supabase real-time subscriptions. The dashboard auto-executes orders on Kalshi when edge exceeds the user's configured threshold and all quality filters pass.

NBA and MLB run as **separate processes** with independent heartbeats, allowing either to be enabled/disabled without affecting the other.

### Signal Logic

```
raw_edge = blended_probability − kalshi_ask_price
edge = raw_edge − friction (Kalshi fee: $0.02/contract)

Filter chain (in order):
  1. No-trade window:
       NBA: block if < 5 min remain in Q4/OT
       MLB: block if in final inning (≤ 6 outs remaining)
  2. Blowout filter:
       NBA: block if margin > 15 in Q4+
       MLB: block if margin > 8 in 7th+
  3. Spread filter: block side if bid-ask spread > $0.10
  4. Underdog guard: if model prob < 20%, require 2x edge threshold
  5. Edge threshold: edge after friction must exceed user's threshold

If edge_home qualifies → BUY_HOME
If edge_away qualifies → BUY_AWAY
Otherwise → NO_TRADE (with structured reason code)
```

### Execution

The frontend position manager follows a fire-and-verify pattern with Kalshi as the source of truth:

- **Entry**: signal arrives → fire buy order (30s auto-expiry) → verify fill via Kalshi API after 30s
- **Price-check re-evaluation**: every 5s, re-check latest signal against fresh market prices for opportunities between signals
- **TP/SL exits**: every 5s, check all open positions against current bid prices
- **Manual exit**: user-triggered sell with immediate execution
- **One direction per event**: never holds both home and away contracts simultaneously

All API keys remain exclusively in the browser. The backend creates signals in Supabase; the frontend executes trades via signed Kalshi API requests.

### Training Pipeline (NBA)

```bash
python run_calibrate.py ingest                    # Ingest 6 seasons of PBP data → 510K snapshots
python run_calibrate.py backfill-oddsshark-odds   # Backfill pregame odds
python run_calibrate.py train                     # Fit model, evaluate, export coefficients
```

A daily GitHub Actions job converts yesterday's live signals into labeled training snapshots and refits the model on the expanded corpus.

---

## Pregame Models

Two gradient-boosted ensemble classifiers (XGBoost) generate daily pregame win probability estimates for NBA and MLB.

Both pipelines follow the same methodology: ingest raw game and player data from official league APIs, engineer multi-horizon rolling statistical features at the player and team level, and fit binary classifiers on chronologically-split historical outcomes. All rolling computations apply `shift(1)` to enforce strict temporal separation — the model never sees information that wasn't available before game time.

The **NBA model** operates on team-level rolling aggregates across offensive and defensive box score categories with home/away differential features. The **MLB model** is lineup-aware — it constructs position-weighted composites of individual batter rolling statistics and models starting pitcher matchups independently from bullpen tendencies, producing a 108-dimensional feature space.

Both models run on automated schedules via GitHub Actions and write predictions directly to the database.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           SUPABASE (PostgreSQL)                         │
│                                                                         │
│   gamelogs │ autopilot_signals │ autopilot_settings │ autopilot_logs    │
└──────┬──────────────┬──────────────────┬──────────────────┬─────────────┘
       │              │                  │                  │
 ┌─────┴──────┐ ┌─────┴──────┐    ┌─────┴──────┐    ┌─────┴──────┐
 │   PREGAME  │ │  AUTOPILOT │    │    WEB     │    │   KALSHI   │
 │  PIPELINES │ │  (backend) │    │ (frontend) │───→│  (trading) │
 └─────┬──────┘ └─────┬──────┘    └────────────┘    └────────────┘
       │              │                 ▲
 ┌─────┴──────┐ ┌─────┴──────┐         │
 │  nba_api / │ │  ESPN API  │    Supabase Realtime
 │  MLB Stats │ │  (NBA+MLB) │    (signal subscriptions)
 └────────────┘ └────────────┘
```

The backend creates trading signals in Supabase. The frontend subscribes to signal changes via Supabase Realtime and executes orders against Kalshi — keeping API keys exclusively in the browser.

---

## Automation

All pipelines are orchestrated via GitHub Actions with configurable schedules and manual dispatch.

| Workflow | Schedule | Description |
|----------|----------|-------------|
| **NBA Pipeline** | 9:00 AM, 12:15 PM, 1:00 PM ET | Pregame inference |
| **MLB Pipeline** | 9:00 AM ET + every 10 min 11 AM–1 AM | Pregame inference + live lineup capture |
| **Autopilot (NBA)** | Every 15 min, 12 PM–12 AM ET | Live NBA win probability + signal generation |
| **Autopilot (MLB)** | Every 15 min, 11 AM–1 AM ET | Live MLB win probability + signal generation |
| **Autopilot Cleanup** | 10:00 AM ET daily | Signal → training snapshot conversion + model retraining |

---

## Project Structure

```
edgemaster/
├── .github/workflows/
│   ├── nba-pipeline.yml             # Pregame NBA
│   ├── mlb-pipeline.yml             # Pregame MLB
│   ├── autopilot.yml                # Live NBA autopilot
│   ├── autopilot-mlb.yml            # Live MLB autopilot
│   └── autopilot-cleanup.yml        # Daily cleanup + retraining
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
│   │   ├── features/                # GameState dataclasses, feature vectors (NBA + MLB)
│   │   ├── ingest/                  # ESPN live feeds (NBA + MLB)
│   │   ├── loop/                    # Async orchestrators, per-game state tracking (NBA + MLB)
│   │   ├── model/                   # Win probability models, probability blending
│   │   └── trading/                 # Signal evaluation, market matching (NBA + MLB)
│   ├── coefficients/                # NBA trained model coefficients (JSON)
│   ├── run_live.py                  # NBA live loop entry point
│   ├── run_mlb_live.py              # MLB live loop entry point
│   ├── run_calibrate.py             # NBA training + evaluation pipeline
│   ├── run_retrain.py               # Daily NBA model retraining
│   └── run_cleanup.py               # Daily signal → training conversion
│
├── web/                             # Next.js web application
│   └── src/
│       ├── app/                     # Pages: /, /nba, /mlb, /terminal, /autopilot, /profile
│       ├── components/              # Dashboards, trading cards, paywall, navigation
│       └── lib/                     # Supabase client, Kalshi API, Stripe billing, types
│
├── shared/                          # Shared constants and database schemas
│   ├── nba/                         # NBA team mappings
│   ├── mlb/                         # MLB team mappings
│   └── schemas/                     # SQL table definitions + migrations
│
└── tests/                           # Test suite
```

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **Pregame Models** | Python 3.12, XGBoost, pandas, numpy, nba_api, MLB Stats API |
| **Autopilot Models** | Python 3.12, scikit-learn (NBA logistic regression), analytical model (MLB), asyncio, aiohttp |
| **Web** | Next.js 16, React 19, TypeScript 5, Tailwind CSS 4 |
| **Database** | Supabase (PostgreSQL) with real-time change subscriptions |
| **Auth** | Supabase Auth |
| **Billing** | Stripe (per-product subscriptions) |
| **Hosting** | Vercel (web), GitHub Actions (pipelines + live loops) |
| **Markets** | Kalshi API (RSA-PSS signed requests) |

---

<div align="center">
<sub>Built by <a href="https://github.com/nathank00">@nathank00</a></sub>
</div>
