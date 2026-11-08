-- SPEC-097 / TASK-856 (REQ-120 R0.1) — the back office's own users + the three roles.
--
-- Additive only: one enum, one table, one unique index. Nothing existing is touched. Idempotent (CREATE ... IF NOT EXISTS;
-- the enum in a DO block, since CREATE TYPE has no IF NOT EXISTS), so a re-apply is safe.
-- Reverse (never on sid without the owner): DROP TABLE "bo"."users"; DROP TYPE "bo"."role";
--
-- Hand-authored + journal-registered per this repo's rule (meta/ holds 0000 + 0003 only, so `db:generate` re-emits the
-- whole schema instead of a delta — a generated file for this change would try to re-create live tables).
-- `teacher_id` is a plain uuid with NO foreign key: `public.teachers` belongs to smart-scheduler-back.
DO $$ BEGIN CREATE TYPE "bo"."role" AS ENUM('ceo','admin','coach'); EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bo"."users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"username" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" "bo"."role" NOT NULL,
	"teacher_id" uuid,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "bo_users_username_uq" ON "bo"."users" USING btree ("username");
