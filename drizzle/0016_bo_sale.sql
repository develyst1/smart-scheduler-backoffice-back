-- TASK-909 (REQ-120 R3.5) - the Stock OUT sale record: bo.sale (header) + bo.sale_line (one per SALE movement).
--
-- Additive only: two NEW tables, nothing existing is altered. branch / method / buyer_ref / remark / seller_refs and the per-line commission are stored AS GIVEN and
-- are forward-looking (the Revenue posting and the commission layer read them, so they do not re-migrate). Money is integer satang.
-- Not idempotent by itself (plain CREATE TABLE), so a half-applied run is fixed by hand; the LAST object is the unique index on sale_line.movement_id = the witness.
-- Reverse (never on sid without the owner): DROP TABLE bo.sale_line; DROP TABLE bo.sale;
--
-- Hand-authored + journal-registered per this repo's rule.
CREATE TABLE "bo"."sale" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "sold_at" timestamp with time zone NOT NULL,
  "branch" text DEFAULT 'BRAVO' NOT NULL,
  "method" text,
  "buyer_ref" text,
  "remark" text,
  "seller_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "actor" text,
  "idempotency_key" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "bo_sale_branch_ck" CHECK ("branch" IN ('BRAVO','OTHER')),
  CONSTRAINT "bo_sale_method_ck" CHECK ("method" IS NULL OR "method" IN ('TRANSFER','CASH','CARD'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "bo_sale_idempotency_uq" ON "bo"."sale" ("idempotency_key");
--> statement-breakpoint
CREATE TABLE "bo"."sale_line" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "sale_id" uuid NOT NULL REFERENCES "bo"."sale"("id") ON DELETE RESTRICT,
  "item_id" uuid NOT NULL REFERENCES "bo"."item"("id") ON DELETE RESTRICT,
  "qty" integer NOT NULL,
  "unit_price_minor" integer NOT NULL,
  "discount_minor" integer DEFAULT 0 NOT NULL,
  "commission_minor" integer DEFAULT 0 NOT NULL,
  "movement_id" uuid NOT NULL REFERENCES "bo"."movement"("id") ON DELETE RESTRICT,
  CONSTRAINT "bo_sale_line_qty_ck" CHECK ("qty" > 0),
  CONSTRAINT "bo_sale_line_money_ck" CHECK ("unit_price_minor" >= 0 AND "discount_minor" >= 0 AND "commission_minor" >= 0 AND "discount_minor" <= "qty" * "unit_price_minor")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "bo_sale_line_movement_uq" ON "bo"."sale_line" ("movement_id");
