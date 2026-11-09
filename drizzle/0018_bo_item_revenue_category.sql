-- TASK-909 / TASK-904 companion (DECISIONS row 21) - the revenue category a sale of a stock product posts into: bo.item.revenue_category_id -> bo.revenue_category(id).
--
-- Additive only: one NULLABLE uuid column with a foreign key (ON DELETE SET NULL; a category is deactivated, not deleted, so this never fires in practice). Existing rows stay NULL
-- (no back-fill): a product with no category is refused at sale time with NO_REVENUE_CATEGORY, and the stock import gives every imported product one. Idempotent (ADD COLUMN IF NOT EXISTS).
-- Reverse (never on sid without the owner): ALTER TABLE bo.item DROP COLUMN revenue_category_id;
--
-- Hand-authored + journal-registered per this repo's rule.
ALTER TABLE "bo"."item" ADD COLUMN IF NOT EXISTS "revenue_category_id" uuid REFERENCES "bo"."revenue_category"("id") ON DELETE SET NULL;
