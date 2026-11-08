-- SPEC-100 / TASK-865 (REQ-120, Salary thin-slip subset) — pay periods, slips, slip lines, salary profiles.
--
-- Additive only: 5 enums, 4 tables, their FKs (same schema), 5 indexes, 1 CHECK. Nothing existing is touched. Idempotent
-- (enums in DO blocks, since CREATE TYPE has no IF NOT EXISTS; tables / indexes IF NOT EXISTS; FKs in DO blocks).
-- Reverse (never on sid without the owner): DROP TABLE bo.pay_slip_line, bo.pay_slip, bo.pay_period, bo.salary_profile;
--   DROP TYPE bo.pay_line_source, bo.pay_line_kind, bo.pay_slip_status, bo.pay_period_status, bo.employment_type;
--
-- Hand-authored + journal-registered per this repo's rule (meta/ has too few snapshots, so `db:generate` re-emits the whole
-- schema instead of a delta). `teacher_id` is a plain uuid with NO foreign key: `public.teachers` belongs to smart-scheduler-back.
-- Money is numeric(14,2) baht; the code computes in integer satang.
DO $$ BEGIN CREATE TYPE "bo"."employment_type" AS ENUM('FT','PT','FL','STAFF'); EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN CREATE TYPE "bo"."pay_period_status" AS ENUM('open','locked'); EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN CREATE TYPE "bo"."pay_slip_status" AS ENUM('draft','confirmed','locked'); EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN CREATE TYPE "bo"."pay_line_kind" AS ENUM('base','other','extra_hour','ot','merit','bonus','commission','fl_pay','transport'); EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN CREATE TYPE "bo"."pay_line_source" AS ENUM('manual','auto'); EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bo"."salary_profile" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"teacher_id" uuid NOT NULL,
	"employment_type" "bo"."employment_type" DEFAULT 'FT' NOT NULL,
	"base_salary" numeric(14, 2),
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bo"."pay_period" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"year" integer NOT NULL,
	"month" integer NOT NULL,
	"status" "bo"."pay_period_status" DEFAULT 'open' NOT NULL,
	"lock_at" timestamp with time zone NOT NULL,
	"locked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bo_pay_period_month_chk" CHECK ("month" between 1 and 12)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bo"."pay_slip" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"period_id" uuid NOT NULL,
	"teacher_id" uuid NOT NULL,
	"base_amount" numeric(14, 2) DEFAULT '0' NOT NULL,
	"status" "bo"."pay_slip_status" DEFAULT 'draft' NOT NULL,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bo"."pay_slip_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slip_id" uuid NOT NULL,
	"kind" "bo"."pay_line_kind" NOT NULL,
	"label" text NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"source" "bo"."pay_line_source" DEFAULT 'manual' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "bo"."pay_slip" ADD CONSTRAINT "pay_slip_period_id_pay_period_id_fk" FOREIGN KEY ("period_id") REFERENCES "bo"."pay_period"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "bo"."pay_slip_line" ADD CONSTRAINT "pay_slip_line_slip_id_pay_slip_id_fk" FOREIGN KEY ("slip_id") REFERENCES "bo"."pay_slip"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "bo_salary_profile_teacher_uq" ON "bo"."salary_profile" USING btree ("teacher_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "bo_pay_period_ym_uq" ON "bo"."pay_period" USING btree ("year","month");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "bo_pay_slip_period_teacher_uq" ON "bo"."pay_slip" USING btree ("period_id","teacher_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bo_pay_slip_line_slip_idx" ON "bo"."pay_slip_line" USING btree ("slip_id");
