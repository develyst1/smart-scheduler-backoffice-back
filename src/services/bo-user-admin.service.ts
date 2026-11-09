// TASK-930 (REQ-120 R0.1, SPEC-097 §3, owner: "same login as the front office"). The CEO ADMITS a front-office person into the back office.
//   admit      reads public.users (READ-ONLY), copies the argon2id hash as a fallback cache, sets role + teacherId + fo_user_id. The CEO picks the role; never `ceo`.
//   sign-in    (bo-user.service.ts `checkLogin`) verifies an admitted row against the LIVE front-office hash + disabled_at via `foCredential`, so an FO password change / disable carries over.
//   no reset   the password lives in the front office; BB has no password route at all.
// No password or hash ever leaves this file in a response.
import { eq, sql } from "drizzle-orm";
import { db } from "../db";
import { boUsers } from "../db/schema";
import { badRequest, conflict, notFound } from "../lib/http";

export interface FoUser {
  id: string;
  username: string;
  passwordHash: string;
  disabledAt: Date | string | null;
  teacherId: string | null;
}
/** What sign-in needs from the front office. */
export type FoCredential = { passwordHash: string; disabledAt: Date | string | null };

export type AdmittedUserDTO = { id: string; username: string; role: "admin" | "coach" | "ceo"; teacherId: string | null; active: boolean; admitted: boolean; createdAt: string };

export interface UsersStore {
  foByUsername(username: string): Promise<FoUser | undefined>;
  boByUsernameOrFoId(username: string, foUserId: string): Promise<{ id: string } | undefined>;
  insert(row: { username: string; passwordHash: string; role: "admin" | "coach"; teacherId: string | null; foUserId: string }): Promise<AdmittedUserDTO>;
  list(): Promise<AdmittedUserDTO[]>;
  get(id: string): Promise<{ id: string; role: string; active: boolean } | undefined>;
  setActive(id: string, active: boolean): Promise<AdmittedUserDTO>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const USERNAME_RE = /^[a-z0-9._-]{3,40}$/;
const normalize = (u: string): string => u.trim().toLowerCase();

type Exec = { execute: (q: ReturnType<typeof sql>) => Promise<unknown> };
const rowsOf = (r: unknown): Record<string, unknown>[] => [...(r as Iterable<Record<string, unknown>>)];
const toFo = (r: Record<string, unknown>): FoUser => ({ id: String(r.id), username: String(r.username), passwordHash: String(r.password_hash), disabledAt: (r.disabled_at as Date | string | null) ?? null, teacherId: r.teacher_id ? String(r.teacher_id) : null });

/** The front-office credential by id (READ-ONLY select on public.users). Undefined = the person no longer exists. */
export async function foCredential(foUserId: string, exec: Exec = db as unknown as Exec): Promise<FoCredential | undefined> {
  const r = rowsOf(await exec.execute(sql`select password_hash, disabled_at from public.users where id = ${foUserId}::uuid limit 1`))[0];
  return r ? { passwordHash: String(r.password_hash), disabledAt: (r.disabled_at as Date | string | null) ?? null } : undefined;
}

const dto = (r: typeof boUsers.$inferSelect): AdmittedUserDTO => ({ id: r.id, username: r.username, role: r.role, teacherId: r.teacherId ?? null, active: r.active, admitted: r.foUserId !== null, createdAt: new Date(r.createdAt).toISOString() });

/** The real store; `d` is `db`, or a transaction (the rolled-back sid check). */
export const makeDbStore = (d: typeof db = db): UsersStore => ({
  async foByUsername(username) {
    const r = rowsOf(await (d as unknown as Exec).execute(sql`select id, username, password_hash, disabled_at, teacher_id from public.users where username = ${username} limit 1`))[0];
    return r ? toFo(r) : undefined;
  },
  async boByUsernameOrFoId(username, foUserId) {
    const [r] = await d.select({ id: boUsers.id }).from(boUsers).where(sql`${boUsers.username} = ${username} or ${boUsers.foUserId} = ${foUserId}::uuid`).limit(1);
    return r;
  },
  async insert(row) {
    const [r] = await d.insert(boUsers).values(row).returning();
    return dto(r!);
  },
  async list() {
    return (await d.select().from(boUsers).orderBy(boUsers.username)).map(dto);
  },
  async get(id) {
    const [r] = await d.select({ id: boUsers.id, role: boUsers.role, active: boUsers.active }).from(boUsers).where(eq(boUsers.id, id)).limit(1);
    return r;
  },
  async setActive(id, active) {
    const [r] = await d.update(boUsers).set({ active }).where(eq(boUsers.id, id)).returning();
    return dto(r!);
  },
});
export const dbStore: UsersStore = makeDbStore();

export interface AdmitInput {
  username?: unknown;
  role?: unknown;
  teacherId?: unknown;
}

export async function admit(input: AdmitInput, store: UsersStore = dbStore): Promise<AdmittedUserDTO> {
  const username = typeof input.username === "string" ? normalize(input.username) : "";
  if (!USERNAME_RE.test(username)) throw badRequest("ชื่อผู้ใช้ไม่ถูกต้อง", { field: "username" });
  if (input.role === "ceo") throw badRequest("ไม่สามารถเพิ่มผู้ใช้เป็น CEO ได้", { field: "role" });
  if (input.role !== "admin" && input.role !== "coach") throw badRequest("role ต้องเป็น admin หรือ coach", { field: "role" });
  if (input.teacherId != null && (typeof input.teacherId !== "string" || !UUID.test(input.teacherId))) throw badRequest("teacherId ไม่ถูกต้อง", { field: "teacherId" });
  const fo = await store.foByUsername(username);
  if (!fo) throw notFound("ไม่พบผู้ใช้นี้ในระบบหน้าบ้าน");
  if (fo.disabledAt) throw badRequest("ผู้ใช้นี้ถูกปิดใช้งานในระบบหน้าบ้าน", { field: "username" });
  if (await store.boByUsernameOrFoId(username, fo.id)) throw conflict("ALREADY_ADMITTED", "ผู้ใช้นี้ถูกเพิ่มในหลังบ้านแล้ว");
  const teacherId = input.role === "coach" ? ((input.teacherId as string | null | undefined) ?? fo.teacherId) : null;
  if (input.role === "coach" && !teacherId) throw badRequest("โค้ชต้องระบุ teacherId", { field: "teacherId" });
  return store.insert({ username, passwordHash: fo.passwordHash, role: input.role, teacherId, foUserId: fo.id });
}

export const listUsers = (store: UsersStore = dbStore) => store.list();

async function setActive(id: string, active: boolean, store: UsersStore): Promise<AdmittedUserDTO> {
  if (!UUID.test(id)) throw badRequest("id ไม่ถูกต้อง");
  const row = await store.get(id);
  if (!row) throw notFound("ไม่พบผู้ใช้");
  if (row.role === "ceo") throw badRequest("ไม่สามารถปิดใช้งานบัญชี CEO ได้"); // the bootstrap CEO is never locked out from here
  return store.setActive(id, active);
}
export const deactivate = (id: string, store: UsersStore = dbStore) => setActive(id, false, store);
export const reactivate = (id: string, store: UsersStore = dbStore) => setActive(id, true, store);
