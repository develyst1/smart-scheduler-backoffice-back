-- SPEC-059 / TASK-159 (REQ-063) — who applied a discount, and why.
--
-- A discount is posted as a NEGATIVE movement on the sale's own item, with `reason = 'DISCOUNT'` and the sale's
-- `ref_id`. That records the money, but not the two things a money record is eventually asked for: **who
-- authorised it** and **what it was for** (`โปรวันแม่`). Both are additive and nullable — every existing
-- movement stays exactly as it is, and nothing reads these until TASK-160 starts writing them.
--
-- ⚠️ The task text says `ops.movement`; the live table is **`bo.movement`** — the `ops` schema was retired by
-- REQ-006/TASK-027 and the sale path posts to `bo`. Applying it to `ops` would add two columns nobody writes,
-- to a schema nobody reads, and leave the real table without them. Flagged in the task notes.
--
-- Hand-authored + journal-registered per this repo's rule (meta/ holds 0000 + 0003 only, so `db:generate`
-- would re-emit the whole schema instead of a delta). Idempotent.

ALTER TABLE "bo"."movement" ADD COLUMN IF NOT EXISTS "actor" text;
--> statement-breakpoint
ALTER TABLE "bo"."movement" ADD COLUMN IF NOT EXISTS "note" text;
