-- TASK-930 (REQ-120 R0.1, SPEC-097 §3) - "one login with the front office": bo.users.fo_user_id links an ADMITTED person to public.users.id.
-- Additive only. NULL = a back-office-own row (the env-seeded CEO), never verified against the front office. A plain uuid: NO FK to public.users (owned by smart-scheduler-back).
-- The partial unique index is the LAST statement: one front-office person is admitted at most once.
-- Hand-authored + journal-registered; idempotent. Reverse (never on sid without the owner): DROP INDEX bo.bo_users_fo_user_id_uq; ALTER TABLE bo.users DROP COLUMN fo_user_id;
ALTER TABLE "bo"."users" ADD COLUMN IF NOT EXISTS "fo_user_id" uuid;
CREATE UNIQUE INDEX IF NOT EXISTS "bo_users_fo_user_id_uq" ON "bo"."users" ("fo_user_id") WHERE "fo_user_id" IS NOT NULL;
