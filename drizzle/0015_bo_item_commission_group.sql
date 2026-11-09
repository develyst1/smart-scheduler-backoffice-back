-- TASK-904 (REQ-120 R3.1 / R3.5) - a stock product's COMMISSION GROUP (name), read by the sale picker and the commission pay line.
--
-- Additive only: one NULLABLE text column on bo.item. Existing rows stay NULL (no back-fill). Idempotent (ADD COLUMN IF NOT EXISTS).
-- Reverse (never on sid without the owner): ALTER TABLE bo.item DROP COLUMN commission_group;
--
-- Hand-authored + journal-registered per this repo's rule.
ALTER TABLE "bo"."item" ADD COLUMN IF NOT EXISTS "commission_group" text;
