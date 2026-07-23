-- REQ-006 / TASK-021: new `bo` schema (universal item/movement/tag model). Hand-written
-- (drifted meta blocks non-interactive generate). CREATE ... IF NOT EXISTS makes re-apply safe;
-- enums use a DO block since CREATE TYPE has no IF NOT EXISTS. Old `ops.*` is untouched (dormant).
CREATE SCHEMA IF NOT EXISTS "bo";
--> statement-breakpoint
DO $$ BEGIN CREATE TYPE "bo"."direction" AS ENUM('INCOME','EXPENSE'); EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN CREATE TYPE "bo"."cadence" AS ENUM('VARIABLE','FIXED_MONTHLY','FIXED_DAILY','FIXED_QUARTERLY'); EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bo"."item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"unit" text DEFAULT 'each' NOT NULL,
	"direction" "bo"."direction" NOT NULL,
	"cadence" "bo"."cadence" DEFAULT 'VARIABLE' NOT NULL,
	"ceiling_qty" integer,
	"remaining_qty" integer,
	"unit_price_minor" integer DEFAULT 0 NOT NULL,
	"owner_ref" text,
	"external_source" text,
	"active" boolean DEFAULT true NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bo"."movement" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_id" uuid NOT NULL,
	"qty" integer NOT NULL,
	"remaining_after" integer,
	"value_minor" integer DEFAULT 0 NOT NULL,
	"reason" text,
	"ref_type" text,
	"ref_id" text,
	"idempotency_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bo"."tag_group" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bo"."tag_value" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tag_group_id" uuid NOT NULL,
	"label" text NOT NULL,
	"color" text,
	"active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bo"."item_tag" (
	"item_id" uuid NOT NULL,
	"tag_value_id" uuid NOT NULL,
	"tag_group_id" uuid NOT NULL,
	CONSTRAINT "bo_item_tag_pk" PRIMARY KEY("item_id","tag_value_id")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bo"."movement" ADD CONSTRAINT "bo_movement_item_id_item_id_fk" FOREIGN KEY ("item_id") REFERENCES "bo"."item"("id") ON DELETE cascade ON UPDATE no action;
 ALTER TABLE "bo"."tag_value" ADD CONSTRAINT "bo_tag_value_tag_group_id_tag_group_id_fk" FOREIGN KEY ("tag_group_id") REFERENCES "bo"."tag_group"("id") ON DELETE cascade ON UPDATE no action;
 ALTER TABLE "bo"."item_tag" ADD CONSTRAINT "bo_item_tag_item_id_item_id_fk" FOREIGN KEY ("item_id") REFERENCES "bo"."item"("id") ON DELETE cascade ON UPDATE no action;
 ALTER TABLE "bo"."item_tag" ADD CONSTRAINT "bo_item_tag_tag_value_id_tag_value_id_fk" FOREIGN KEY ("tag_value_id") REFERENCES "bo"."tag_value"("id") ON DELETE cascade ON UPDATE no action;
 ALTER TABLE "bo"."item_tag" ADD CONSTRAINT "bo_item_tag_tag_group_id_tag_group_id_fk" FOREIGN KEY ("tag_group_id") REFERENCES "bo"."tag_group"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "bo_movement_idempotency_uq" ON "bo"."movement" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bo_movement_item_idx" ON "bo"."movement" USING btree ("item_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bo_item_owner_idx" ON "bo"."item" USING btree ("external_source","owner_ref");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "bo_item_tag_group_uq" ON "bo"."item_tag" USING btree ("item_id","tag_group_id");
