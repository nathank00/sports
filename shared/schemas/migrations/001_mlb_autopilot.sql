-- MLB Autopilot Migration
-- Run this in the Supabase SQL Editor (Dashboard > SQL Editor)
-- ================================================================

-- 1. Add MLB-specific columns to autopilot_signals
ALTER TABLE public.autopilot_signals
  ADD COLUMN IF NOT EXISTS sport text DEFAULT 'nba',
  ADD COLUMN IF NOT EXISTS inning_half text,
  ADD COLUMN IF NOT EXISTS outs_in_inning integer;

-- Index for filtering by sport
CREATE INDEX IF NOT EXISTS idx_signals_sport ON public.autopilot_signals (sport);

-- 2. Add sport column to autopilot_settings (changes PK from user_id to user_id+sport)

-- Add sport column
ALTER TABLE public.autopilot_settings
  ADD COLUMN IF NOT EXISTS sport text NOT NULL DEFAULT 'nba';

-- Drop old primary key and create composite key
ALTER TABLE public.autopilot_settings DROP CONSTRAINT IF EXISTS autopilot_settings_pkey;
ALTER TABLE public.autopilot_settings ADD PRIMARY KEY (user_id, sport);

-- Update RLS policies to include sport
DROP POLICY IF EXISTS "Users can read own settings" ON public.autopilot_settings;
DROP POLICY IF EXISTS "Users can insert own settings" ON public.autopilot_settings;
DROP POLICY IF EXISTS "Users can update own settings" ON public.autopilot_settings;

CREATE POLICY "Users can read own settings"
  ON public.autopilot_settings FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own settings"
  ON public.autopilot_settings FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own settings"
  ON public.autopilot_settings FOR UPDATE
  USING (auth.uid() = user_id);

-- 3. MLB heartbeat row (NBA uses id=1, MLB needs id=2)
-- The table has a "single_row" check constraint that only allows id=1.
-- Drop that constraint so we can have one row per sport.
ALTER TABLE public.autopilot_heartbeat DROP CONSTRAINT IF EXISTS single_row;

INSERT INTO public.autopilot_heartbeat (id, last_heartbeat)
VALUES (2, now())
ON CONFLICT (id) DO NOTHING;

-- 4. Update schema file docs
COMMENT ON COLUMN public.autopilot_signals.sport IS 'nba or mlb';
COMMENT ON COLUMN public.autopilot_signals.inning_half IS 'MLB only: top, bottom, or end';
COMMENT ON COLUMN public.autopilot_signals.outs_in_inning IS 'MLB only: 0-3 outs in current half-inning';
COMMENT ON COLUMN public.autopilot_settings.sport IS 'nba or mlb — separate settings per sport';
