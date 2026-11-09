// TASK-917 (REQ-120 R0.4) - the notification store + feed, and the role-derived recipient assignments (ruling C-h: NO opt-out, no write).
//
//   * a feed is a person's OWN items (`recipient_ref` = their username = the token's `sub`); mark-read / mark-all touch only the caller's own rows; no money in any text;
//   * who gets which type is `bo.notification_assignment` (a ROLE like 'ceo' or a named USER), seeded and read-only to the app;
//   * THE SHARED SEAM for every producer (Bob's Monday Low-Stock job, TASK-919; Silver's Salary events are a cross-team follow-up and are NOT wired here):
//       recipientsForType(type, exec?)               -> the usernames assigned that type (a role expands to its active users), each once
//       createNotification(exec, { recipientRef, type, text, occurredOn, key })  -> true if a row was written, false if (recipient, key) already existed (idempotent)
//     `exec` is the global `db` or a transaction the caller already holds (so a producer can write its own rows and its notifications atomically).
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import { boUsers } from "../db/schema";
import { boNotification, boNotificationAssignment } from "../db/schema-notification";
import { ApiException, badRequest } from "../lib/http";
import { NOTIFY_TYPES, type NotifyType } from "../lib/notification";
import { bangkokDate } from "../lib/stock-read";
import { dbSalaryStore } from "./salary-db.store";

export interface FeedItem { id: string; type: NotifyType; text: string; date: string; read: boolean }
export interface AssignmentRow { subjectKind: "role" | "user"; subject: string; type: NotifyType }
export interface NewNotification { recipientRef: string; type: NotifyType; text: string; occurredOn: string; key: string | null }

// ───────────────────────────── THE SEAM (exported for Bob's job) ─────────────────────────────

/** The usernames (lower-case, sorted, each once) assigned `type`: the users named, plus every ACTIVE user holding an assigned role. */
export async function recipientsForType(type: NotifyType, exec: any = db): Promise<string[]> {
  const rows = (await exec.select().from(boNotificationAssignment).where(eq(boNotificationAssignment.type, type))) as Array<{ subjectKind: string; subject: string }>;
  const out = new Set<string>();
  for (const a of rows) {
    if (a.subjectKind === "user") out.add(a.subject.toLowerCase());
    else for (const u of await exec.select({ u: boUsers.username }).from(boUsers).where(and(eq(boUsers.role, a.subject as "ceo" | "admin" | "coach"), eq(boUsers.active, true)))) out.add(String(u.u).toLowerCase());
  }
  return [...out].sort();
}

/**
 * Write ONE notification. Idempotent: a second call with the same (recipientRef, key) writes nothing and returns false (a NULL key has no natural dedupe, so each call writes a row).
 * No money in `text` (an admin sees the same item). Validates the type, the text (1-500) and the day.
 */
export async function createNotification(exec: any, n: { recipientRef: string; type: NotifyType; text: string; occurredOn: string; key?: string | null }): Promise<boolean> {
  if (!(NOTIFY_TYPES as readonly string[]).includes(n.type)) throw badRequest("type ไม่ถูกต้อง", { field: "type" });
  const text = (n.text ?? "").trim();
  if (!text || text.length > 500) throw badRequest("text ต้องไม่ว่างและไม่เกิน 500 ตัวอักษร", { field: "text" });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(n.occurredOn)) throw badRequest("occurredOn ต้องเป็น YYYY-MM-DD", { field: "occurredOn" });
  const ref = (n.recipientRef ?? "").trim().toLowerCase();
  if (!ref) throw badRequest("recipientRef ต้องไม่ว่าง", { field: "recipientRef" });
  const r = await exec.insert(boNotification).values({ recipientRef: ref, type: n.type, text, occurredOn: n.occurredOn, dedupeKey: n.key ?? null }).onConflictDoNothing().returning({ id: boNotification.id });
  return r.length > 0;
}

// ───────────────────────────── the service (feed + assignments + coaches) ─────────────────────────────

export interface NotificationStore {
  feed(ref: string): Promise<FeedItem[]>;
  markRead(ref: string, id: string, at: Date): Promise<boolean>;
  markAll(ref: string, at: Date): Promise<number>;
  assignments(): Promise<AssignmentRow[]>;
  /** username -> role, for the usernames asked about (unknown ones are absent). */
  rolesOf(usernames: string[]): Promise<Map<string, string>>;
  coaches(): Promise<{ who: string; type: string }[]>;
}

const roleLabel = (r: string): string => (r === "ceo" ? "CEO" : r.charAt(0).toUpperCase() + r.slice(1));
const COACH_TYPE: Record<string, string> = { FT: "Full-time", PT: "Part-time", FL: "Freelance" };

export function createNotificationService(store: NotificationStore, now: () => Date = () => new Date()) {
  return {
    /** The caller's OWN feed, newest first. Never another person's. */
    feed: (ref: string) => store.feed(ref.toLowerCase()),

    async markRead(ref: string, id: string): Promise<void> {
      if (!(await store.markRead(ref.toLowerCase(), id, now()))) throw new ApiException(404, "NOT_FOUND", "ไม่พบการแจ้งเตือนนี้", { id });
    },
    markAll: async (ref: string) => ({ marked: await store.markAll(ref.toLowerCase(), now()) }),

    /** «CEO and Staff»: who is told about what, in the web. ROLE-DERIVED and READ-ONLY (ruling C-h): there is no write. The CEO row first, then the named people. */
    async recipients(): Promise<{ who: string; role: string; gets: NotifyType[] }[]> {
      const groups = new Map<string, { kind: "role" | "user"; subject: string; gets: Set<NotifyType> }>();
      for (const r of await store.assignments()) {
        const k = `${r.subjectKind}:${r.subject.toLowerCase()}`;
        const g = groups.get(k) ?? { kind: r.subjectKind, subject: r.subject, gets: new Set<NotifyType>() };
        g.gets.add(r.type);
        groups.set(k, g);
      }
      const roles = await store.rolesOf([...groups.values()].filter((g) => g.kind === "user").map((g) => g.subject.toLowerCase()));
      return [...groups.values()]
        .map((g) => ({ who: g.kind === "role" ? roleLabel(g.subject) : g.subject, role: g.kind === "role" ? roleLabel(g.subject) : roleLabel(roles.get(g.subject.toLowerCase()) ?? "admin"), gets: NOTIFY_TYPES.filter((t) => g.gets.has(t)) as NotifyType[], rank: g.kind === "role" ? 0 : 1 }))
        .sort((a, b) => a.rank - b.rank || a.who.localeCompare(b.who))
        .map(({ rank: _rank, ...x }) => x);
    },

    /** «Coach (Full-time / Part-time)»: coaches are always told of their own items. */
    coaches: () => store.coaches(),

    /** Convenience for a producer that has no executor of its own: write to everyone assigned `type`. */
    async notifyAssigned(n: { type: NotifyType; text: string; occurredOn?: string; key?: string | null }, exec: any = db): Promise<{ recipients: number; inserted: number }> {
      const people = await recipientsForType(n.type, exec);
      let inserted = 0;
      for (const recipientRef of people) if (await createNotification(exec, { recipientRef, type: n.type, text: n.text, occurredOn: n.occurredOn ?? bangkokDate(now()), key: n.key ?? null })) inserted++;
      return { recipients: people.length, inserted };
    },
  };
}

// ───────────────────────────── the Drizzle store ─────────────────────────────

/** `exec` is the global `db`, or a transaction a probe rolls back. */
export const makeDbNotificationStore = (exec: any = db): NotificationStore => ({
  async feed(ref) {
    const rows = await exec.select().from(boNotification).where(eq(boNotification.recipientRef, ref)).orderBy(desc(boNotification.occurredOn), desc(boNotification.createdAt));
    return rows.map((r: any) => ({ id: r.id, type: r.type, text: r.text, date: r.occurredOn, read: r.readAt !== null }));
  },
  async markRead(ref, id, at) {
    const r = await exec.update(boNotification).set({ readAt: at }).where(and(eq(boNotification.id, id), eq(boNotification.recipientRef, ref))).returning({ id: boNotification.id });
    return r.length > 0; // someone else's item is "not found", never "forbidden": it does not reveal that it exists
  },
  async markAll(ref, at) {
    const r = await exec.update(boNotification).set({ readAt: at }).where(and(eq(boNotification.recipientRef, ref), sql`${boNotification.readAt} is null`)).returning({ id: boNotification.id });
    return r.length;
  },
  async assignments() {
    return (await exec.select().from(boNotificationAssignment).orderBy(asc(boNotificationAssignment.subjectKind), asc(boNotificationAssignment.subject))).map((r: any) => ({ subjectKind: r.subjectKind, subject: r.subject, type: r.type }));
  },
  async rolesOf(usernames) {
    if (!usernames.length) return new Map();
    return new Map((await exec.select({ u: boUsers.username, r: boUsers.role }).from(boUsers).where(inArray(sql`lower(${boUsers.username})`, usernames))).map((r: any) => [String(r.u).toLowerCase(), r.r as string]));
  },
  async coaches() {
    const profiles = await dbSalaryStore.listProfiles();
    const active = profiles.filter((p) => p.active && p.employmentType !== "STAFF");
    const names = await dbSalaryStore.teacherNames(active.map((p) => p.teacherId));
    return active
      .map((p) => ({ who: names.get(p.teacherId) ?? p.teacherId, type: (p.roles.length ? p.roles : [p.employmentType]).map((r) => COACH_TYPE[r] ?? r).join(" + ") }))
      .sort((a, b) => a.who.localeCompare(b.who));
  },
});

export const notificationService = createNotificationService(makeDbNotificationStore());
