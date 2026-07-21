// Admin JWT for the backoffice (mirrors smart-scheduler-back/src/lib/jwt.ts). Uses Hono's
// built-in HS256 helpers — no extra dependency. Secret + TTL come from env; the token carries
// the subject + role. A users table can replace the env-cred login later without changing this.

import { sign, verify } from "hono/jwt";

export type Role = "admin";

export interface AuthClaims {
  sub: string;
  role: Role;
  exp?: number;
}

const ttlSeconds = () => Number(process.env.JWT_TTL_SECONDS ?? 12 * 3600);

function secret(): string {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error("JWT_SECRET not set");
  return s;
}

export async function signToken(claims: { sub: string; role: Role }): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds();
  return sign({ ...claims, exp }, secret(), "HS256");
}

/** Verify a token; throws if invalid/expired. */
export async function verifyToken(token: string): Promise<AuthClaims> {
  return (await verify(token, secret(), "HS256")) as unknown as AuthClaims;
}
