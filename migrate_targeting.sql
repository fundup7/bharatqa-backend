-- ============================================================
-- BharatQA: Tester Targeting & Ban System Migration
-- Run this once against your Supabase/Postgres database
-- ============================================================

-- 1. Add targeting profile columns to testers
ALTER TABLE testers
  ADD COLUMN IF NOT EXISTS ram_gb         NUMERIC(4,1),        -- e.g. 2.0, 4.0, 6.0, 8.0
  ADD COLUMN IF NOT EXISTS network_type   TEXT,                -- '2g' | '3g' | '4g' | '5g' | 'wifi'
  ADD COLUMN IF NOT EXISTS device_tier    TEXT,                -- 'low' | 'mid' | 'high'
  ADD COLUMN IF NOT EXISTS is_banned      BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS ban_reason     TEXT;

-- 2. Add targeting criteria column to tests (stored as JSONB)
ALTER TABLE tests
  ADD COLUMN IF NOT EXISTS criteria JSONB;

-- 3. Helpful indexes
CREATE INDEX IF NOT EXISTS idx_testers_is_banned    ON testers (is_banned);
CREATE INDEX IF NOT EXISTS idx_testers_device_tier  ON testers (device_tier);
CREATE INDEX IF NOT EXISTS idx_testers_network_type ON testers (network_type);
CREATE INDEX IF NOT EXISTS idx_testers_state        ON testers (state);
CREATE INDEX IF NOT EXISTS idx_testers_city         ON testers (city);
CREATE INDEX IF NOT EXISTS idx_tests_criteria       ON tests USING GIN (criteria);

-- ============================================================
-- Done! You can now use the following new API endpoints:
--
--  POST   /api/admin/testers/:id/ban       { ban_reason }
--  DELETE /api/admin/testers/:id/ban
--  GET    /api/admin/testers
--  PUT    /api/tests/:id/criteria          { device_tier, network_type, min_ram_gb, max_ram_gb, allowed_states, allowed_cities }
--  GET    /api/tests/:id/criteria
--  GET    /api/tests/:id/eligible-testers
--  GET    /api/available-tests?google_id=XXX   (returns only matching + non-banned tests)
-- ============================================================
