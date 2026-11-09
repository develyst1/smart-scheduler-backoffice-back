-- TASK-911 (REQ-120 R3.2 / R3.5) - the movement BUSINESS date. A Stock IN or Stock OUT can be back-dated (a late-entered delivery / sale), and the movement report keyed
-- its day off `created_at`, so a back-dated entry landed on the wrong day. `occurred_on` is the day the thing happened (Asia/Bangkok): Stock IN = receivedOn, Stock OUT = the
-- sale's day, an import = the day it was applied.
--
-- Additive only: one NULLABLE date column on bo.movement. No back-fill: the report falls back to date(created_at at Bangkok) for any row without it. Idempotent (ADD COLUMN IF NOT EXISTS).
-- Reverse (never on sid without the owner): ALTER TABLE bo.movement DROP COLUMN occurred_on;
--
-- Hand-authored + journal-registered per this repo's rule.
ALTER TABLE "bo"."movement" ADD COLUMN IF NOT EXISTS "occurred_on" date;
