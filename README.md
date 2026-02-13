<p align="center">
  <h1 align="center">[ ONE OF ONE ]</h1>
  <p align="center">
    AI-powered sports prediction engine + automated Kalshi trading
    <br />
    <a href="https://github.com/nathank00/oneofone/releases/latest"><strong>Download Desktop App</strong></a>
    &nbsp;&middot;&nbsp;
    <a href="#architecture">Architecture</a>
    &nbsp;&middot;&nbsp;
    <a href="#getting-started">Getting Started</a>
  </p>
</p>

---

## What is this?

ONE OF ONE is a full-stack sports prediction platform that trains ML models on historical NBA data, generates daily win predictions, and lets you trade on those predictions through [Kalshi](https://kalshi.com) prediction markets.

Three main components:

| Component | What it does | Tech |
|-----------|-------------|------|
| **NBA Pipeline** | Ingests game data, engineers features, trains XGBoost model, writes daily predictions | Python, XGBoost, nba_api, Supabase |
| **Web Dashboard** | Public-facing site showing today's predictions and historical record | Next.js 16, React 19, Tailwind CSS |
| **Desktop App** | Native trading app — view predictions, find edges, place bets (manual or auto) | Tauri 2, Rust, React 19, Kalshi API |

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         SUPABASE (PostgreSQL)                       │
│                                                                     │
│  gamelogs table                                                     │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │ GAME_ID │ GAME_DATE │ HOME │ AWAY │ PREDICTION │ PCT │ STATUS │ │
│  └────────────────────────────────────────────────────────────────┘ │
└──────────────┬──────────────────┬──────────────────┬────────────────┘
               │                  │                  │
         ┌─────┴─────┐    ┌──────┴──────┐    ┌──────┴──────┐
         │  PIPELINE  │    │     WEB     │    │   DESKTOP   │
         │  (writes)  │    │   (reads)   │    │   (reads)   │
         └─────┬─────┘    └─────────────┘    └──────┬──────┘
               │                                     │
        ┌──────┴──────┐                       ┌──────┴──────┐
        │   nba_api   │                       │  Kalshi API │
        │  (NBA data) │                       │  (trading)  │
        └─────────────┘                       └─────────────┘
```

### Data Flow

```
                    ┌──────────────┐
                    │   nba_api    │
                    │  (NBA.com)   │
                    └──────┬───────┘
                           │
              ┌────────────┼────────────┐
              ▼            ▼            ▼
        ┌──────────┐ ┌──────────┐ ┌──────────┐
        │  games   │ │ players  │ │  player  │
        │  .py     │ │  .py     │ │ stats.py │
        └────┬─────┘ └────┬─────┘ └────┬─────┘
             │             │            │
             └─────────────┼────────────┘
                           ▼
                    ┌──────────────┐
                    │  gamelogs.py │  Rolling stats
                    │  (features)  │  (10 & 30 game)
                    └──────┬───────┘
                           │
                    ┌──────┴───────┐
                    │   train.py   │  XGBoost model
                    │  (60 feats)  │  → models/nba_winner.json
                    └──────┬───────┘
                           │
                    ┌──────┴───────┐
                    │  predict.py  │  Daily inference
                    │              │  → Supabase
                    └──────────────┘
```

---

## The Model

**XGBoost binary classifier** predicting home team win probability.

- **Target**: `1` = home win, `0` = away win
- **Features (60)**: 52 rolling team stats + 8 derived differentials
  - Rolling windows: 10-game and 30-game averages
  - Stats: PTS, REB, AST, STL, BLK, TOV, PF, FG%, FG3%, FT%, +/-
  - Differentials: home minus away for key metrics
- **Training**: Chronological 80/20 split (no future data leakage)
- **Output**: `PREDICTION` (0 or 1) and `PREDICTION_PCT` (home win probability)

When `PREDICTION = 0` and `PREDICTION_PCT = 0.21`, the model is predicting an away win with **79% confidence** (1 - 0.21).

---

## Desktop App

The desktop app is the trading interface. It connects to both Supabase (for predictions) and Kalshi (for market execution).

### Screens

**Dashboard** — Portfolio overview: cash balance, portfolio value, open positions

**Manual Mode** — Two independent sections:
- **Top**: Today's model predictions with confidence % and game status badges (UPCOMING / LIVE / FINAL)
- **Bottom**: Matched Kalshi markets with edge calculations and one-click bet placement

**Auto Mode** — Background scanner that:
1. Polls every 30 seconds
2. Matches predictions to live Kalshi markets
3. Calculates edge (model probability vs. market implied probability)
4. Auto-places bets when edge exceeds your configured threshold
5. Streams events to a real-time log

**Settings** — Configure Kalshi API credentials, edge threshold, bet sizing (contracts or dollars), demo/live toggle

### Edge Calculation

```
edge = (model_probability - market_implied_probability) × 100

Example:
  Model says Lakers win at 72%
  Kalshi market implies 60% (yes_ask = $0.60)
  Edge = (0.72 - 0.60) × 100 = +12%
  → If edge_threshold = 10%, scanner auto-bets
```

### Kalshi Authentication

The app uses RSA-PSS signed API requests. You need:
1. A Kalshi account with API access
2. Your API Key ID (from Kalshi dashboard)
3. A `.pem` private key file (PKCS#8 or PKCS#1 format)

---

## Project Structure

```
oneofone/
├── nba-pipeline/               # ML prediction pipeline
│   ├── src/
│   │   ├── games.py            # Game metadata ingestion (922 lines)
│   │   ├── gamelogs.py         # Feature engineering (625 lines)
│   │   ├── playerstats.py      # Player stat ingestion (590 lines)
│   │   ├── players.py          # Player/roster data (219 lines)
│   │   ├── train.py            # XGBoost training (429 lines)
│   │   └── predict.py          # Daily inference (280 lines)
│   ├── models/
│   │   └── nba_winner.json     # Trained model artifact
│   └── requirements.txt
│
├── web/                        # Next.js dashboard
│   └── src/
│       ├── app/
│       │   ├── page.tsx        # Landing page
│       │   └── nba/page.tsx    # Predictions dashboard
│       ├── components/
│       │   ├── NbaDashboard.tsx
│       │   ├── PredictionCard.tsx
│       │   ├── DatePicker.tsx
│       │   └── RecordBadge.tsx
│       └── lib/
│           ├── supabase.ts
│           ├── dates.ts
│           └── types.ts
│
├── desktop/                    # Tauri trading app
│   ├── src/
│   │   ├── App.tsx             # Tab router
│   │   ├── components/
│   │   │   ├── Dashboard.tsx   # Portfolio overview
│   │   │   ├── ManualMode.tsx  # Predictions + manual betting
│   │   │   ├── AutoMode.tsx    # Scanner + event log
│   │   │   ├── GameRow.tsx     # Individual bet card
│   │   │   ├── Settings.tsx    # Configuration
│   │   │   ├── Header.tsx      # Navigation
│   │   │   └── EventLog.tsx    # Scanner log
│   │   └── lib/
│   │       ├── commands.ts     # Tauri IPC wrappers
│   │       └── types.ts        # TypeScript interfaces
│   └── src-tauri/
│       └── src/
│           ├── lib.rs          # Tauri commands (358 lines)
│           ├── types.rs        # Rust data models (275 lines)
│           ├── kalshi.rs       # RSA auth + Kalshi API
│           ├── supabase.rs     # Prediction fetching
│           ├── scanner.rs      # Background auto-trader
│           └── matcher.rs      # Prediction ↔ market matching
│
└── shared/
    └── nba/
        └── nba_constants.py    # Team name mappings (30 teams)
```

---

## Getting Started

### Prerequisites

- **Python 3.10+** (pipeline)
- **Node.js 18+** (web & desktop frontend)
- **Rust** via [rustup](https://rustup.rs) (desktop backend)
- **Supabase** account with a `gamelogs` table

### 1. Pipeline

```bash
cd nba-pipeline
python -m venv venv && source venv/bin/activate
pip install -r requirements.txt

# Set environment variables
export SUPABASE_URL="your-supabase-url"
export SUPABASE_KEY="your-service-key"

# Run the full pipeline
python -m src.games        # Ingest game data
python -m src.players      # Ingest player rosters
python -m src.playerstats  # Ingest player stats
python -m src.gamelogs     # Generate features
python -m src.train        # Train model
python -m src.predict      # Generate today's predictions
```

### 2. Web Dashboard

```bash
cd web
npm install

# Create .env.local with your Supabase credentials
echo "NEXT_PUBLIC_SUPABASE_URL=your-url" > .env.local
echo "NEXT_PUBLIC_SUPABASE_ANON_KEY=your-key" >> .env.local

npm run dev        # http://localhost:3000
```

### 3. Desktop App

**Option A: Download the pre-built app**

Go to [Releases](https://github.com/nathank00/oneofone/releases/latest) and download the `.dmg` for macOS.

> **First launch on macOS**: Right-click → Open, or run in Terminal:
> ```bash
> xattr -cr /Applications/ONE\ OF\ ONE.app
> ```

**Option B: Build from source**

```bash
cd desktop
npm install

# Development
npm run tauri dev

# Production build (native arch)
npm run tauri build

# Universal build (Apple Silicon + Intel)
rustup target add x86_64-apple-darwin aarch64-apple-darwin
npm run tauri build -- --target universal-apple-darwin
```

The built app will be at:
```
desktop/src-tauri/target/release/bundle/dmg/ONE OF ONE_0.1.0_*.dmg
```

---

## Tech Stack

```
┌──────────────────────────────────────────────────────────────────┐
│                        ONE OF ONE                                │
├──────────────┬──────────────────┬────────────────────────────────┤
│   Pipeline   │       Web        │           Desktop              │
├──────────────┼──────────────────┼────────────────────────────────┤
│ Python 3.10  │ Next.js 16       │ Tauri 2 (Rust)                 │
│ XGBoost      │ React 19         │ React 19 + Vite                │
│ pandas       │ Tailwind CSS 4   │ Tailwind CSS 4                 │
│ nba_api      │ Supabase JS      │ reqwest + tokio                │
│ scikit-learn │ TypeScript 5     │ rsa (PKCS#1/PKCS#8)            │
│ supabase-py  │ Vercel           │ serde + chrono                 │
└──────────────┴──────────────────┴────────────────────────────────┘
                         │
                    Supabase
                   (PostgreSQL)
```

---

## License

See [LICENSE](LICENSE) for details.
