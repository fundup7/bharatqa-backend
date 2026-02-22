-- Payment Accounting Migration
-- Run this in Supabase SQL Editor

-- 1. Add total_paid to testers
ALTER TABLE testers
  ADD COLUMN IF NOT EXISTS total_paid NUMERIC(10,2) DEFAULT 0;

-- 2. Create payment_transactions table
CREATE TABLE IF NOT EXISTS payment_transactions (
  id            SERIAL PRIMARY KEY,
  tester_id     INT NOT NULL REFERENCES testers(id) ON DELETE CASCADE,
  amount        NUMERIC(10,2) NOT NULL,
  upi_id        TEXT NOT NULL,
  status        TEXT DEFAULT 'paid',   -- paid | failed | pending
  note          TEXT,
  paid_at       TIMESTAMPTZ DEFAULT NOW(),
  period_start  TIMESTAMPTZ,
  period_end    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_payments_tester_id ON payment_transactions(tester_id);
CREATE INDEX IF NOT EXISTS idx_payments_paid_at   ON payment_transactions(paid_at);
