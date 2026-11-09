import { sql } from "drizzle-orm";
import { db } from "../db";

/**
 * 🔻 TASK-924 / SPEC-103 §2 + §7 — the ONE "live entitlement" rule behind COURSE "active", STUDENT status and REPORT's
 * activeStudents. Change "active" here and all three move together.
 *
 * LIVE = not ended, not paused (course only — a voucher has no `dropped_at`, so it is never paused), sessions/hours
 * left > 0, and `expiry_date >= asOf`.
 *
 * BB cannot import smart-scheduler-back, so the predicates are MIRRORED by value from SB, each pinned by a test:
 *   ended   = `ended_at` set                     (SB `lib/course-plan.ts:375 isCourseEnded`, `lib/voucher.ts:31 isVoucherEnded`)
 *   paused  = `dropped_at` set                   (SB `lib/course-plan.ts:382 isCourseDropped`)
 *   course left  = size − prior_sessions − used  (SB `courseOwedTarget` :416 → `coursePlanSize`, REQ-064)
 *   voucher left = total_hours − used_hours      (SB `lib/voucher.ts:34 voucherRemaining`)
 * `asOf` is a Bangkok calendar date (YYYY-MM-DD). Used/size counts are today's running figures, not history.
 */

type Ts = Date | string | null | undefined;

export interface LiveCourseRow {
  size: number;
  priorSessions: number;
  usedSessions: number;
  endedAt?: Ts;
  droppedAt?: Ts;
  expiryDate: string;
}
export interface LiveVoucherRow {
  totalHours: number;
  usedHours: number;
  endedAt?: Ts;
  expiryDate: string;
}

export const courseLeft = (c: Pick<LiveCourseRow, "size" | "priorSessions" | "usedSessions">): number =>
  c.size - (c.priorSessions ?? 0) - c.usedSessions;
export const voucherLeft = (v: Pick<LiveVoucherRow, "totalHours" | "usedHours">): number => Math.max(0, v.totalHours - v.usedHours);

export const isLiveCourse = (c: LiveCourseRow, asOf: string): boolean =>
  c.endedAt == null && c.droppedAt == null && courseLeft(c) > 0 && c.expiryDate >= asOf;

export const isLiveVoucher = (v: LiveVoucherRow, asOf: string): boolean =>
  v.endedAt == null && voucherLeft(v) > 0 && v.expiryDate >= asOf;

export interface LiveEntitlements {
  count: number;
  subjectIds: string[];
}

type Exec = Pick<typeof db, "execute">;

/**
 * Every student's live entitlements, as ONE grouped query (never one per student).
 * A DUO course is live for BOTH children. A voucher has no subject: its subjects are those of its own bookings.
 * The SQL below restates `isLiveCourse` / `isLiveVoucher` — the test pins the two together on the same rows.
 */
export async function liveEntitlementsByStudent(asOf: string, d: Exec = db): Promise<Map<string, LiveEntitlements>> {
  const rows = (await d.execute(sql`
    with live as (
      select c.id as eid, c.student_id as sid, c.subject_id as subject_id
        from public.course_packages c
       where c.student_id is not null and c.ended_at is null and c.dropped_at is null
         and c.size - coalesce(c.prior_sessions, 0) - c.used_sessions > 0 and c.expiry_date >= ${asOf}::date
      union all
      select c.id, c.co_student_id, c.subject_id
        from public.course_packages c
       where c.co_student_id is not null and c.ended_at is null and c.dropped_at is null
         and c.size - coalesce(c.prior_sessions, 0) - c.used_sessions > 0 and c.expiry_date >= ${asOf}::date
      union all
      select v.id, v.student_id, b.subject_id
        from public.vouchers v
        left join public.bookings b on b.voucher_id = v.id
       where v.ended_at is null and v.total_hours - v.used_hours > 0 and v.expiry_date >= ${asOf}::date
    )
    select sid::text as student_id, count(distinct eid)::int as count,
           coalesce(array_agg(distinct subject_id::text) filter (where subject_id is not null), '{}') as subject_ids
      from live group by sid
  `)) as unknown as { student_id: string; count: number; subject_ids: string[] }[];
  const out = new Map<string, LiveEntitlements>();
  for (const r of rows) out.set(r.student_id, { count: Number(r.count), subjectIds: [...r.subject_ids].sort() });
  return out;
}
