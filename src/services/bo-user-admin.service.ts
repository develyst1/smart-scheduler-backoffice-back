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

export type AdmittedUserDTO = { id: string; username: string; role: "admin" | "coach" | "ceo"; teacherId: string | null; active: boolean; admitted: boolean; createdAt: string; teacherName: string | null };

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

/** teacherName is filled only by `list()` (the join); the write responses carry null and the FE refetches. */
const dto = (r: typeof boUsers.$inferSelect): AdmittedUserDTO => ({ id: r.id, username: r.username, role: r.role, teacherId: r.teacherId ?? null, active: r.active, admitted: r.foUserId !== null, createdAt: new Date(r.createdAt).toISOString(), teacherName: null });

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
    // TASK-932: ONE read-only left join on public.teachers (id-match + nickname + name ONLY: no pay, phone, LINE or parent ids). nickname-else-name; null for admin / CEO / a teacher not found.
    const rows = rowsOf(await (d as unknown as Exec).execute(sql`
      select u.id, u.username, u.role, u.teacher_id, u.active, u.fo_user_id, u.created_at, coalesce(nullif(t.nickname, ''), t.name) as teacher_name
        from bo.users u left join public.teachers t on t.id = u.teacher_id order by u.username`));
    return rows.map((r) => ({
      id: String(r.id), username: String(r.username), role: r.role as AdmittedUserDTO["role"], teacherId: r.teacher_id ? String(r.teacher_id) : null, active: r.active === true,
      admitted: r.fo_user_id != null, createdAt: new Date(r.created_at as string | Date).toISOString(), teacherName: r.teacher_id && r.teacher_name ? String(r.teacher_name) : null,
    }));
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
  if (!USERNAME_RE.test(username)) throw badRequest("Invalid username", { field: "username" });
  if (input.role === "ceo") throw badRequest("A user can't be added as CEO", { field: "role" });
  if (input.role !== "admin" && input.role !== "coach") throw badRequest("Role must be admin or coach", { field: "role" });
  if (input.teacherId != null && (typeof input.teacherId !== "string" || !UUID.test(input.teacherId))) throw badRequest("Invalid teacher", { field: "teacherId" });
  const fo = await store.foByUsername(username);
  if (!fo) throw notFound("This person is not in the front office");
  if (fo.disabledAt) throw badRequest("This person is disabled in the front office", { field: "username" });
  if (await store.boByUsernameOrFoId(username, fo.id)) throw conflict("ALREADY_ADMITTED", "This person already has a back-office login");
  const teacherId = input.role === "coach" ? ((input.teacherId as string | null | undefined) ?? fo.teacherId) : null;
  if (input.role === "coach" && !teacherId) throw badRequest("A coach must have a teacher selected", { field: "teacherId" });
  return store.insert({ username, passwordHash: fo.passwordHash, role: input.role, teacherId, foUserId: fo.id });
}

export const listUsers = (store: UsersStore = dbStore) => store.list();

async function setActive(id: string, active: boolean, store: UsersStore): Promise<AdmittedUserDTO> {
  if (!UUID.test(id)) throw badRequest("Invalid id");
  const row = await store.get(id);
  if (!row) throw notFound("User not found");
  if (row.role === "ceo") throw badRequest("The CEO account can't be deactivated"); // the bootstrap CEO is never locked out from here
  return store.setActive(id, active);
}
export const deactivate = (id: string, store: UsersStore = dbStore) => setActive(id, false, store);
export const reactivate = (id: string, store: UsersStore = dbStore) => setActive(id, true, store);
