-- ============================================================
-- BharatQA: Phase 3 Infrastructure Migration
-- Dynamic Payouts & Admin Approval Gate
-- ============================================================

-- 1. Add budget and approval columns to tests
ALTER TABLE tests
  ADD COLUMN IF NOT EXISTS total_budget    NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS admin_approved  BOOLEAN DEFAULT FALSE;

-- 2. Backfill existing tests (Optional/Safety)
-- For existing tests, we assume total_budget = quota * price
UPDATE tests 
SET total_budget = COALESCE(tester_quota, 20) * COALESCE(price_paid, 0)
WHERE total_budget IS NULL;

-- 3. Success indicator
SELECT '✅ Phase 3 Migration applied successfully' as status;
