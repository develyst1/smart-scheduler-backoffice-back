-- TASK-066 (SPEC-021 / REQ-014) — give `bo.item` a product-code key of its own.
--
-- Why: sales are posted by product code ("course-6", "voucher-10", "first-trial", …). Until now the
-- only ref columns on bo.item were `owner_ref` (which already means *teacher id* on freelance ceiling
-- items) and `external_source`. Overloading `owner_ref` would give one column two meanings separated
-- only by which query you happen to be reading — so it gets its own column. Sober's call, TASK-064 Q2.
--
-- Hand-authored and registered in drizzle/meta/_journal.json by hand (TASK-042 rule): this repo's
-- snapshot chain is incomplete (meta/ has 0000 + 0003 only), so `db:generate` would re-emit the whole
-- schema instead of a delta. Idempotent, so re-running the migration step is safe.
--
-- `bo` is owned by this repo — this migration touches nothing in `public`.

ALTER TABLE "bo"."item" ADD COLUMN IF NOT EXISTS "external_ref" text;

-- One item per (source, product code) so the sale-posting lookup can never be ambiguous.
-- Partial: existing rows (incl. every freelance ceiling item) have external_ref NULL and must not collide.
CREATE UNIQUE INDEX IF NOT EXISTS "bo_item_external_uq"
  ON "bo"."item" ("external_source", "external_ref")
  WHERE "external_ref" IS NOT NULL;
