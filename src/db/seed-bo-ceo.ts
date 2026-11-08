/**
 * Seed the one `ceo` back-office user (TASK-856 / SPEC-097, addendum 2026-11-08). Idempotent: an existing username is left as it is.
 *
 *   bun run seed          (same as: bun run db:seed-bo-ceo)
 *
 * Reads `BO_SEED_CEO_USERNAME` + `BO_SEED_CEO_PASSWORD` from the environment — the OWNER sets them on the server; they are never
 * in this repo, a file, an inbox or a chat. If either is unset, this seeds NOTHING and exits 0 (the `SKIP_ADMIN_AUTH` dev stub stays).
 */
import { eq } from "drizzle-orm";
import { db, queryClient } from "./index";
import { boUsers } from "./schema";
import { createBoUser, normalizeUsername } from "../services/bo-user.service";

const username = process.env.BO_SEED_CEO_USERNAME?.trim();
const password = process.env.BO_SEED_CEO_PASSWORD;

if (!username || !password) {
  console.log("BO_SEED_CEO_USERNAME / BO_SEED_CEO_PASSWORD not both set — no CEO seeded (dev stub only).");
  await queryClient.end();
  process.exit(0);
}

const existing = await db.select({ id: boUsers.id }).from(boUsers).where(eq(boUsers.username, normalizeUsername(username))).limit(1);
if (existing.length) {
  console.log(`bo.users already has "${normalizeUsername(username)}" — left as it is.`);
} else {
  const u = await createBoUser({ username, password, role: "ceo" });
  console.log(`seeded ceo "${u.username}".`);
}
await queryClient.end();
