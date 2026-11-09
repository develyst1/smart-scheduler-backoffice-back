// R0.1 users (SPEC-097 / TASK-856): look up, verify and create back-office users. The password primitive is
// `Bun.password` (argon2id) — the same one the front office uses, so a seeded user can keep the same password.

import { eq } from "drizzle-orm";
import { db } from "../db";
import { boUsers } from "../db/schema";
import { isRole, type Role } from "../lib/jwt";
import { foCredential, type FoCredential } from "./bo-user-admin.service";

export type BoUserRow = typeof boUsers.$inferSelect;

/** What the API says about a user — never the hash. `teacherId` is null for ceo / admin. */
export type BoUserDTO = { username: string; role: Role; teacherId: string | null };

/** Trimmed + lower-cased: the login key (and the token `sub`). */
export const normalizeUsername = (u: string): string => u.trim().toLowerCase();
export const USERNAME_RE = /^[a-z0-9._-]{3,40}$/;
export const PASSWORD_MIN = 8;

export const hashPassword = (password: string) => Bun.password.hash(password);
export const verifyPassword = (password: string, hash: string) => Bun.password.verify(password, hash);

export const toDTO = (u: Pick<BoUserRow, "username" | "role" | "teacherId">): BoUserDTO => ({
  username: u.username,
  role: u.role,
  teacherId: u.teacherId ?? null,
});

export async function findBoUserByUsername(username: string): Promise<BoUserRow | undefined> {
  const [row] = await db.select().from(boUsers).where(eq(boUsers.username, normalizeUsername(username))).limit(1);
  return row;
}

/**
 * The one login check: a row that exists, is active, and whose hash matches. Returns the user or `null` — the caller
 * answers ONE sentence for unknown / wrong password / inactive, so the response never says which.
 */
export async function checkLogin(
  username: string,
  password: string,
  lookup: (username: string) => Promise<BoUserRow | undefined> = findBoUserByUsername,
  fo: (foUserId: string) => Promise<FoCredential | undefined> = foCredential,
): Promise<BoUserDTO | null> {
  const row = await lookup(username);
  if (!row || !row.active) return null;
  let hash = row.passwordHash;
  if (row.foUserId) {
    // TASK-930: an ADMITTED person signs in with the front office's LIVE password; a front-office disable (or a vanished person) refuses. A back-office-own row (the CEO seed) skips this.
    const cred = await fo(row.foUserId);
    if (!cred || cred.disabledAt) return null;
    hash = cred.passwordHash;
  }
  if (!(await verifyPassword(password, hash))) return null;
  return toDTO(row);
}

/** Create a user (the CEO seed, and later the user-management screen). Validates the shape; a duplicate username is a 23505 the app's error handler maps to 409. */
export async function createBoUser(input: { username: string; password: string; role: Role; teacherId?: string | null }): Promise<BoUserDTO> {
  const username = normalizeUsername(input.username);
  if (!USERNAME_RE.test(username)) throw new Error("username must be 3-40 chars of a-z 0-9 . _ -");
  if (input.password.length < PASSWORD_MIN) throw new Error(`password must be at least ${PASSWORD_MIN} characters`);
  if (!isRole(input.role)) throw new Error("role must be ceo, admin or coach");
  if (input.role === "coach" && !input.teacherId) throw new Error("a coach needs a teacherId (their own-slip scope)");
  const [row] = await db
    .insert(boUsers)
    .values({ username, passwordHash: await hashPassword(input.password), role: input.role, teacherId: input.teacherId ?? null })
    .returning();
  return toDTO(row!);
}
