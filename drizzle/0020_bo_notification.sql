-- TASK-917 (REQ-120 R0.4 / R3.7) - the in-web notifications, who gets which type (ROLE-DERIVED, ruling C-h: no opt-out), and the Low-Stock per-type thresholds.
--
-- Three NEW tables, nothing existing is touched:
--   bo.notification             a person's own feed (recipient_ref = their username = the token's `sub`); no money in any text; `dedupe_key` makes a generated item idempotent per recipient
--   bo.notification_assignment  who receives which type: a ROLE ('ceo' gets all) or a named USER; read-only to the app (no self-service write: ruling C-h)
--   bo.low_stock_threshold      the alert level per type (F&B 10 · Safety 1 · Miller 5 · Sock 1 · Shirt 1); a NULL level = no alert
-- Seeds (idempotent ON CONFLICT DO NOTHING): the CEO role receives every type; the customer's default thresholds. The one named person (London = Low Stock) is seeded by
-- `bun run db:seed-notification-assignments -- --user <username>` because the username is not known to the schema.
-- Hand-authored + journal-registered per this repo's rule; idempotent (IF NOT EXISTS). Reverse (never on sid without the owner): DROP TABLE bo.notification, bo.notification_assignment, bo.low_stock_threshold;
CREATE TABLE IF NOT EXISTS "bo"."notification" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "recipient_ref" text NOT NULL,
  "type" text NOT NULL,
  "text" text NOT NULL,
  "occurred_on" date NOT NULL,
  "read_at" timestamp with time zone,
  "dedupe_key" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "notification_type_ck" CHECK ("type" IN ('Bonus','Commission','Transportation','OT','Other','Low Stock','Extra Hour'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bo_notification_recipient_idx" ON "bo"."notification" USING btree ("recipient_ref", "occurred_on" DESC);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "bo_notification_dedupe_uq" ON "bo"."notification" USING btree ("recipient_ref", "dedupe_key") WHERE "dedupe_key" is not null;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bo"."notification_assignment" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "subject_kind" text NOT NULL,
  "subject" text NOT NULL,
  "type" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "notification_assignment_kind_ck" CHECK ("subject_kind" IN ('role','user')),
  CONSTRAINT "notification_assignment_type_ck" CHECK ("type" IN ('Bonus','Commission','Transportation','OT','Other','Low Stock','Extra Hour'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "bo_notification_assignment_uq" ON "bo"."notification_assignment" USING btree ("subject_kind", lower("subject"), "type");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bo"."low_stock_threshold" (
  "type" text PRIMARY KEY NOT NULL,
  "threshold" integer,
  "updated_by" text,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "low_stock_threshold_ck" CHECK ("threshold" IS NULL OR "threshold" >= 0)
);
--> statement-breakpoint
INSERT INTO "bo"."notification_assignment" ("subject_kind", "subject", "type")
SELECT 'role', 'ceo', t FROM unnest(ARRAY['Bonus','Commission','Transportation','OT','Other','Low Stock','Extra Hour']) AS t
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "bo"."low_stock_threshold" ("type", "threshold", "updated_by")
VALUES ('F&B', 10, 'seed'), ('Safety', 1, 'seed'), ('Miller', 5, 'seed'), ('Sock', 1, 'seed'), ('Shirt', 1, 'seed')
ON CONFLICT DO NOTHING;
