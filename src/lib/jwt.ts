// Back-office JWT (SPEC-097 / TASK-856). Hono's built-in HS256 helpers — no extra dependency. Secret + TTL come from env.
// The token carries the subject (the username), the role and, for a coach, the scheduling teacher they ARE.

import { sign, verify } from "hono/jwt";

/** The three roles, lower-case, exactly as `final-ui`'s `Role` (REQ-120 R0.1–R0.3). No others. */
export const ROLES = ["ceo", "admin", "coach"] as const;
export type Role = (typeof ROLES)[number];
export const isRole = (x: unknown): x is Role => typeof x === "string" && (ROLES as readonly string[]).includes(x);

export interface AuthClaims {
  sub: string;
  role: Role;
  /** Set for a coach (their own-slip scope); null/absent for ceo / admin. */
  teacherId?: string | null;
  exp?: number;
}

const ttlSeconds = () => Number(process.env.JWT_TTL_SECONDS ?? 12 * 3600);

function secret(): string {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error("JWT_SECRET not set");
  return s;
}

export async function signToken(claims: { sub: string; role: Role; teacherId?: string | null }): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds();
  return sign({ ...claims, exp }, secret(), "HS256");
}

/** Verify a token; throws if invalid/expired, or if its `role` is not one of the three. */
export async function verifyToken(token: string): Promise<AuthClaims> {
  const claims = (await verify(token, secret(), "HS256")) as unknown as AuthClaims;
  if (!isRole(claims.role)) throw new Error("token role is not one of ceo/admin/coach");
  return claims;
}
