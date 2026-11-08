-- SPEC-101 §3–§4 / TASK-871 (REQ-120 R1.1, R1.2, R1.4) — the money-grade people model + the R1.4 pay period.
--
-- Additive only: 2 enums (bo.pay_class_type, bo.vehicle), 3 columns on bo.salary_profile (roles / merit_eligible / vehicle),
-- 2 nullable date columns on bo.pay_period (period_start / period_end), 1 new table bo.fl_rate (+ in-schema FK, 1 unique index).
-- Nothing existing is changed or dropped; every existing row keeps working (roles = '{}' means "just employment_type";
-- period_start/period_end stay NULL on rows made before this — the demo rows do not need a back-fill).
-- Idempotent (enums in DO blocks; ADD COLUMN IF NOT EXISTS; CREATE TABLE/INDEX IF NOT EXISTS; the FK in a DO block).
-- Reverse (never on sid without the owner): DROP TABLE bo.fl_rate; ALTER TABLE bo.salary_profile DROP COLUMN roles, DROP COLUMN merit_eligible,
--   DROP COLUMN vehicle; ALTER TABLE bo.pay_period DROP COLUMN period_start, DROP COLUMN period_end; DROP TYPE bo.vehicle, bo.pay_class_type;
--
-- Hand-authored + journal-registered per this repo's rule. `teacher_id` stays a plain uuid with NO cross-schema FK.
DO $$ BEGIN CREATE TYPE "bo"."pay_class_type" AS ENUM('private','duo','group','eca','camp'); EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN CREATE TYPE "bo"."vehicle" AS ENUM('car','motorbike'); EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
ALTER TABLE "bo"."salary_profile" ADD COLUMN IF NOT EXISTS "roles" "bo"."employment_type"[] DEFAULT '{}' NOT NULL;
--> statement-breakpoint
ALTER TABLE "bo"."salary_profile" ADD COLUMN IF NOT EXISTS "merit_eligible" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "bo"."salary_profile" ADD COLUMN IF NOT EXISTS "vehicle" "bo"."vehicle";
--> statement-breakpoint
ALTER TABLE "bo"."pay_period" ADD COLUMN IF NOT EXISTS "period_start" date;
--> statement-breakpoint
ALTER TABLE "bo"."pay_period" ADD COLUMN IF NOT EXISTS "period_end" date;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bo"."fl_rate" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL,
	"class_type" "bo"."pay_class_type" NOT NULL,
	"rate" numeric(14, 2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "bo"."fl_rate" ADD CONSTRAINT "fl_rate_profile_id_salary_profile_id_fk" FOREIGN KEY ("profile_id") REFERENCES "bo"."salary_profile"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "bo_fl_rate_profile_class_uq" ON "bo"."fl_rate" USING btree ("profile_id","class_type");
