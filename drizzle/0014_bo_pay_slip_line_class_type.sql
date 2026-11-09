-- SPEC-101 §6 (TASK-903) - fl_pay is split per CLASS TYPE: one auto line per (FL date x class), so the slip / export can group "Freelance Teaching Pay" by Private / Duo / Group / ECA / Camp.
--
-- Additive only: one NULLABLE column on bo.pay_slip_line, typed with the existing enum bo.pay_class_type (0010). Only `fl_pay` lines set it; every other kind stays NULL.
-- Existing rows stay NULL (no back-fill: the next period run rewrites the auto lines under their new per-class source_ref). Idempotent (ADD COLUMN IF NOT EXISTS).
-- Reverse (never on sid without the owner): ALTER TABLE bo.pay_slip_line DROP COLUMN class_type;
--
-- Hand-authored + journal-registered per this repo's rule.
ALTER TABLE "bo"."pay_slip_line" ADD COLUMN IF NOT EXISTS "class_type" "bo"."pay_class_type";
