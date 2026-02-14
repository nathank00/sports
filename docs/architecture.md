# File Structure

```
oneofone/
├── .github/
│   └── workflows/
│       ├── nba-pipeline.yml              # NBA scheduled automation (3x daily)
│       └── mlb-pipeline.yml              # MLB scheduled automation (daily + every 10 min)
│
├── nba-pipeline/
│   ├── src/
│   │   ├── games.py                      # Game schedule + roster ingestion (nba_api)
│   │   ├── players.py                    # Player metadata (active players per season)
│   │   ├── playerstats.py                # Per-player game stats (league game logs)
│   │   ├── gamelogs.py                   # Rolling feature engineering (10/30 game windows)
│   │   ├── train.py                      # XGBoost model training (chronological split)
│   │   ├── predict.py                    # Daily inference → writes to Supabase
│   │   └── __init__.py
│   ├── run_pipeline.py                   # Orchestrator: historical | current
│   ├── models/
│   │   └── nba_winner.json               # Trained XGBoost model artifact
│   ├── requirements.txt
│   └── tests/
│
├── mlb-pipeline/
│   ├── src/
│   │   ├── games.py                      # Schedule + lineup ingestion (MLB Stats API)
│   │   ├── players.py                    # Player metadata + batter/pitcher classification
│   │   ├── playerstats.py                # Per-player batting/pitching game logs
│   │   ├── gamelogs.py                   # Lineup-weighted rolling feature engineering
│   │   ├── train.py                      # XGBoost model training (108 features)
│   │   ├── predict.py                    # Daily inference → writes to Supabase
│   │   └── __init__.py
│   ├── run_pipeline.py                   # Orchestrator: historical | current | live
│   ├── models/
│   │   ├── mlb_winner.json               # Trained XGBoost model artifact
│   │   └── mlb_winner_report.json        # Training metrics + feature importances
│   ├── migrations/
│   │   ├── 001_create_tables.sql         # Initial MLB table creation
│   │   └── 002_add_lineup_columns.sql    # Lineup array columns on gamelogs
│   └── requirements.txt
│
├── web/                                  # Next.js 16 dashboard (Vercel)
│   ├── src/
│   │   ├── app/
│   │   │   ├── layout.tsx                # Root layout with Nav
│   │   │   ├── page.tsx                  # Home page (NBA / MLB buttons)
│   │   │   ├── nba/page.tsx              # NBA predictions page
│   │   │   └── mlb/page.tsx              # MLB predictions page
│   │   ├── components/
│   │   │   ├── Nav.tsx                   # Sticky navigation bar
│   │   │   ├── NbaDashboard.tsx          # NBA game list + records
│   │   │   ├── MlbDashboard.tsx          # MLB game list + records
│   │   │   ├── PredictionCard.tsx        # NBA game prediction card
│   │   │   ├── MlbPredictionCard.tsx     # MLB game prediction card
│   │   │   ├── DatePicker.tsx            # Date selection input
│   │   │   └── RecordBadge.tsx           # W-L record display
│   │   └── lib/
│   │       ├── supabase.ts               # Supabase client initialization
│   │       ├── types.ts                  # TypeScript interfaces (GameLog, MlbGameLog)
│   │       └── dates.ts                  # Date helpers (Eastern timezone)
│   ├── .env.local                        # Supabase URL + anon key (gitignored)
│   ├── package.json
│   ├── tsconfig.json
│   └── next.config.ts
│
├── desktop/                              # Tauri 2 trading app
│   ├── src/                              # React frontend (Vite)
│   └── src-tauri/
│       └── src/                          # Rust backend (Kalshi API, scanner)
│
├── shared/
│   ├── nba/
│   │   └── nba_constants.py              # Team abbreviations, IDs, name mappings
│   ├── mlb/
│   │   └── mlb_constants.py              # MLB team ID/name/abbreviation mappings
│   └── schemas/                          # Supabase table schema definitions
│       ├── games                         # NBA games table
│       ├── gamelogs                      # NBA gamelogs table
│       ├── players                       # NBA players table
│       ├── playerstats                   # NBA playerstats table
│       ├── mlb_games                     # MLB games table
│       ├── mlb_gamelogs                  # MLB gamelogs table
│       ├── mlb_players                   # MLB players table
│       └── mlb_playerstats              # MLB playerstats table
│
├── docs/
│   └── architecture.md                   # This file
│
├── .env                                  # Supabase credentials (gitignored)
├── .gitignore
├── LICENSE                               # MIT
└── README.md
```
