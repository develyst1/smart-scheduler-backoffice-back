-- TASK-915 (REQ-120 R3.6) - Stock DEMO: a separate multi-site sub-system (teaching equipment at STA / ABC / RIS / WA (Abbey) / KIS / Bravo), NOT the sale stock.
--
-- Four NEW tables, nothing existing is touched: bo.demo_site (+ sort_order), bo.demo_item (+ optional sale_item_id -> bo.item), bo.demo_stock (the per-(item, site) balance, never negative),
-- bo.demo_movement (the +/- history, never updated or deleted). No data is written here; the sites and the Demo-tab items are seeded by `bun run db:seed-demo-stock`.
-- Hand-authored + journal-registered per this repo's rule; idempotent (IF NOT EXISTS).
-- Reverse (never on sid without the owner): DROP TABLE bo.demo_movement, bo.demo_stock, bo.demo_item, bo.demo_site;
CREATE TABLE IF NOT EXISTS "bo"."demo_site" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "sort_order" integer DEFAULT 0 NOT NULL,
  "active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "bo_demo_site_name_uq" ON "bo"."demo_site" USING btree (lower("name"));
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bo"."demo_item" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "category" text,
  "name" text NOT NULL,
  "remark" text,
  "active" boolean DEFAULT true NOT NULL,
  "sale_item_id" uuid REFERENCES "bo"."item"("id") ON DELETE SET NULL,
  "seed_row" integer,
  "sort_order" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "bo_demo_item_seed_row_uq" ON "bo"."demo_item" USING btree ("seed_row") WHERE "seed_row" is not null;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bo"."demo_stock" (
  "demo_item_id" uuid NOT NULL REFERENCES "bo"."demo_item"("id") ON DELETE RESTRICT,
  "site_id" uuid NOT NULL REFERENCES "bo"."demo_site"("id") ON DELETE RESTRICT,
  "qty" integer DEFAULT 0 NOT NULL,
  CONSTRAINT "demo_stock_demo_item_id_site_id_pk" PRIMARY KEY ("demo_item_id", "site_id"),
  CONSTRAINT "demo_stock_qty_ck" CHECK ("qty" >= 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bo"."demo_movement" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "demo_item_id" uuid NOT NULL REFERENCES "bo"."demo_item"("id") ON DELETE RESTRICT,
  "type" text NOT NULL,
  "qty" integer NOT NULL,
  "from_site_id" uuid REFERENCES "bo"."demo_site"("id") ON DELETE RESTRICT,
  "to_site_id" uuid REFERENCES "bo"."demo_site"("id") ON DELETE RESTRICT,
  "reason" text,
  "actor" text,
  "occurred_on" date NOT NULL,
  "idempotency_key" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "demo_movement_type_ck" CHECK ("type" IN ('MOVE','DEFECT_IN','WRITE_OFF','OPENING')),
  CONSTRAINT "demo_movement_qty_ck" CHECK ("qty" > 0)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bo_demo_movement_day_idx" ON "bo"."demo_movement" USING btree ("occurred_on");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "bo_demo_movement_key_uq" ON "bo"."demo_movement" USING btree ("idempotency_key");
