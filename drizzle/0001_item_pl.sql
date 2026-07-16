-- Item-centric P&L model: classify catalog items (group + type) and record the baht
-- value of each stock movement so income/cost/profit roll up from item movements.
DO $$ BEGIN
 CREATE TYPE "ops"."item_group" AS ENUM('PRODUCT', 'SERVICE');
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "ops"."item_type" AS ENUM('INCOME', 'EXPENSE', 'FIXED_COST');
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
ALTER TABLE "ops"."catalog_items" ADD COLUMN IF NOT EXISTS "item_group" "ops"."item_group" DEFAULT 'PRODUCT' NOT NULL;--> statement-breakpoint
ALTER TABLE "ops"."catalog_items" ADD COLUMN IF NOT EXISTS "item_type" "ops"."item_type" DEFAULT 'INCOME' NOT NULL;--> statement-breakpoint
ALTER TABLE "ops"."stock_movements" ADD COLUMN IF NOT EXISTS "amount_minor" integer DEFAULT 0 NOT NULL;
