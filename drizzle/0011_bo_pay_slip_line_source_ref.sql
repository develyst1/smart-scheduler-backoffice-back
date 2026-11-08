-- SPEC-100 §9b / SPEC-101 §6 (TASK-867 Bonus auto-lines, TASK-878 link 3) — auto-line idempotency on bo.pay_slip_line.
--
-- Additive only: one NULLABLE column (`source_ref`) and one PARTIAL UNIQUE index on (slip_id, kind, source_ref) WHERE source = 'auto'.
-- A manual line has no source_ref and is outside the index; an auto line carries what it was derived from, so a pay-run re-run can upsert
-- it instead of duplicating it. Existing rows are untouched (source_ref stays NULL; NULLs never collide in a unique index anyway).
-- `bo.salary_profile.vehicle` is NOT here: it already shipped in 0010. Idempotent (ADD COLUMN / CREATE INDEX IF NOT EXISTS).
-- Reverse (never on sid without the owner): DROP INDEX bo.bo_pay_slip_line_auto_ref_uq; ALTER TABLE bo.pay_slip_line DROP COLUMN source_ref;
--
-- Hand-authored + journal-registered per this repo's rule.
ALTER TABLE "bo"."pay_slip_line" ADD COLUMN IF NOT EXISTS "source_ref" text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "bo_pay_slip_line_auto_ref_uq" ON "bo"."pay_slip_line" USING btree ("slip_id","kind","source_ref") WHERE "bo"."pay_slip_line"."source" = 'auto';
