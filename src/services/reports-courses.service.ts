// TASK-926 / SPEC-103 §2 - COURSE «คอร์สแยกประเภท» (courses by type): one row per activity × kind × size. READ-ONLY (SELECTs over SB's `public` tables + `bo.revenue_line`); no migration, no write.
//
//   kind     PRIVATE | DUO (`co_student_id` set; a GROUP seat reads PRIVATE today: Khwan's pack asks) | VOUCHER (a voucher has NO activity: its rows are per SIZE only, `subjectId: null`, `subjectName: "Voucher"`)
//   sold     SALE rows created in the window (Bangkok date of `created_at`); an IMPORT is an entitlement, never a sale, so it never counts
//   active   live AS OF `to` (the shared rule in `lib/reports-live.ts`: not ended, not paused, sessions / hours left, not expired). The DATES are evaluated as of `to`; the "left" figures are
//            TODAY's running counts (history is not stored), so for a `to` in the past the response carries `activeIsApprox: true`
//   paused   dropped (and not ended) as of `to`; a voucher cannot be paused (no `dropped_at`), so 0
//   ended    `ended_at` inside the window
//   sessionsTaught  ATTENDED bookings dated in the window, by their course's activity / kind / size (voucher bookings by the voucher's size)
//   revenueMinor    (CEO ONLY, absent for an admin) `bo.revenue_line` of type COURSE / VOUCHER in the window (`occurred_on`), joined by `ref_type` + `ref_id` to the course / voucher; a line that does
//                   not resolve (NULL ref, or ref_type CAMP / BOOKING) is left out of every row and summed in `totals.unmatchedRevenueMinor`; REFUND lines are not course revenue
// A FIXED number of grouped queries (courses · vouchers · course sessions · voucher sessions · [revenue, CEO] · subject names): never one per row.
import { sql } from "drizzle-orm";
import { db } from "../db";
import { ApiException } from "../lib/http";

export type ReportRole = "ceo" | "admin";
export interface CoursesQuery {
  from: string;
  to: string;
  branch?: "BRAVO" | "OTHER";
}
export type CourseKind = "PRIVATE" | "DUO" | "VOUCHER";
export interface CourseRow {
  subjectId: string | null;
  subjectName: string;
  kind: CourseKind;
  size: number;
  sold: number;
  active: number;
  paused: number;
  ended: number;
  sessionsTaught: number;
  /** CEO only: the key is ABSENT for an admin. */
  revenueMinor?: number;
}
export interface CourseTotals {
  sold: number;
  active: number;
  paused: number;
  ended: number;
  sessionsTaught: number;
  revenueMinor?: number;
  unmatchedRevenueMinor?: number;
}
export interface CoursesResult {
  rows: CourseRow[];
  totals: CourseTotals;
  /** true when `to` is before today (Bangkok): the "active" counts use TODAY's sessions / hours left. */
  activeIsApprox: boolean;
}

type Exec = { execute: (q: ReturnType<typeof sql>) => Promise<unknown> };
export interface CoursesDeps {
  exec?: Exec;
  now?: () => Date;
}

const KIND_ORDER: Record<CourseKind, number> = { PRIVATE: 0, DUO: 1, VOUCHER: 2 };
const VOUCHER_NAME = "Voucher";
/** Bangkok calendar day (YYYY-MM-DD) of an instant (UTC+7, no DST). */
const bangkokDay = (d: Date): string => new Date(d.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);
const num = (v: unknown): number => Number(v ?? 0);

interface Counts { sold: number; active: number; paused: number; ended: number }
interface Acc extends Counts { subjectId: string | null; kind: CourseKind; size: number; sessionsTaught: number; revenueMinor: number }
const key = (subjectId: string | null, kind: CourseKind, size: number): string => `${subjectId ?? "-"}|${kind}|${size}`;

/** The pure assembly: the grouped rows of each query -> the ordered rows + totals. No database. */
export function assembleCourses(p: {
  courses: { subjectId: string; kind: "PRIVATE" | "DUO"; size: number; sold: number; active: number; paused: number; ended: number }[];
  vouchers: { size: number; sold: number; active: number; ended: number }[];
  courseSessions: { subjectId: string; kind: "PRIVATE" | "DUO"; size: number; n: number }[];
  voucherSessions: { size: number; n: number }[];
  /** null = an admin (no revenue at all) */
  revenue: { courses: { subjectId: string; kind: "PRIVATE" | "DUO"; size: number; amount: number }[]; vouchers: { size: number; amount: number }[]; unmatched: number } | null;
  names: Map<string, string>;
}): { rows: CourseRow[]; totals: CourseTotals } {
  const acc = new Map<string, Acc>();
  const at = (subjectId: string | null, kind: CourseKind, size: number): Acc => {
    const k = key(subjectId, kind, size);
    let a = acc.get(k);
    if (!a) acc.set(k, (a = { subjectId, kind, size, sold: 0, active: 0, paused: 0, ended: 0, sessionsTaught: 0, revenueMinor: 0 }));
    return a;
  };
  for (const c of p.courses) Object.assign(at(c.subjectId, c.kind, c.size), { sold: c.sold, active: c.active, paused: c.paused, ended: c.ended });
  for (const v of p.vouchers) Object.assign(at(null, "VOUCHER", v.size), { sold: v.sold, active: v.active, paused: 0, ended: v.ended });
  for (const s of p.courseSessions) at(s.subjectId, s.kind, s.size).sessionsTaught += s.n;
  for (const s of p.voucherSessions) at(null, "VOUCHER", s.size).sessionsTaught += s.n;
  if (p.revenue) {
    for (const r of p.revenue.courses) at(r.subjectId, r.kind, r.size).revenueMinor += r.amount;
    for (const r of p.revenue.vouchers) at(null, "VOUCHER", r.size).revenueMinor += r.amount;
  }
  const ceo = p.revenue !== null;
  const rows: CourseRow[] = [...acc.values()]
    .filter((a) => a.sold || a.active || a.paused || a.ended || a.sessionsTaught || a.revenueMinor) // a row with nothing in it is not listed
    .map((a) => ({
      subjectId: a.subjectId,
      subjectName: a.subjectId === null ? VOUCHER_NAME : (p.names.get(a.subjectId) ?? "—"),
      kind: a.kind,
      size: a.size,
      sold: a.sold,
      active: a.active,
      paused: a.paused,
      ended: a.ended,
      sessionsTaught: a.sessionsTaught,
      ...(ceo ? { revenueMinor: a.revenueMinor } : {}),
    }))
    .sort((a, b) => a.subjectName.localeCompare(b.subjectName) || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.size - b.size);
  const sum = (f: (r: CourseRow) => number): number => rows.reduce((s, r) => s + f(r), 0);
  const totals: CourseTotals = {
    sold: sum((r) => r.sold),
    active: sum((r) => r.active),
    paused: sum((r) => r.paused),
    ended: sum((r) => r.ended),
    sessionsTaught: sum((r) => r.sessionsTaught),
    ...(ceo ? { revenueMinor: sum((r) => r.revenueMinor ?? 0), unmatchedRevenueMinor: p.revenue!.unmatched } : {}),
  };
  return { rows, totals };
}

export async function reportCourses(q: CoursesQuery, role: ReportRole, deps: CoursesDeps = {}): Promise<CoursesResult> {
  if (role !== "ceo" && role !== "admin") throw new ApiException(403, "FORBIDDEN", "ไม่มีสิทธิ์");
  const d: Exec = deps.exec ?? (db as unknown as Exec);
  const { from, to } = q;
  const br = q.branch ?? null;
  const rowsOf = async (query: ReturnType<typeof sql>): Promise<Record<string, unknown>[]> => [...((await d.execute(query)) as Iterable<Record<string, unknown>>)];
  // the Bangkok calendar day of a timestamptz column
  const day = (col: string) => sql.raw(`(${col} at time zone 'Asia/Bangkok')::date`);
  const cBr = br ? sql`and c.branch = ${br}` : sql``;
  const vBr = br ? sql`and v.branch = ${br}` : sql``;
  const bBr = br ? sql`and b.branch = ${br}` : sql``;
  const rBr = br ? sql`and r.branch = ${br}` : sql``;
  const left = sql`c.size - coalesce(c.prior_sessions, 0) - c.used_sessions > 0`;

  // 1 · the courses: sold / active / paused / ended per activity × kind × size
  const courses = await rowsOf(sql`
    select c.subject_id::text as subject_id,
           case when c.co_student_id is null then 'PRIVATE' else 'DUO' end as kind,
           c.size as size,
           count(*) filter (where c.source = 'SALE' and ${day("c.created_at")} between ${from}::date and ${to}::date)::int as sold,
           count(*) filter (where ${day("c.created_at")} <= ${to}::date
                              and (c.ended_at is null or ${day("c.ended_at")} > ${to}::date)
                              and (c.dropped_at is null or ${day("c.dropped_at")} > ${to}::date)
                              and ${left} and c.expiry_date >= ${to}::date)::int as active,
           count(*) filter (where c.dropped_at is not null and ${day("c.dropped_at")} <= ${to}::date
                              and (c.ended_at is null or ${day("c.ended_at")} > ${to}::date))::int as paused,
           count(*) filter (where c.ended_at is not null and ${day("c.ended_at")} between ${from}::date and ${to}::date)::int as ended
      from public.course_packages c
     where c.student_id is not null ${cBr}
     group by 1, 2, 3`);

  // 2 · the vouchers: per SIZE (a voucher has no activity, and cannot be paused)
  const vouchers = await rowsOf(sql`
    select v.total_hours as size,
           count(*) filter (where v.source = 'SALE' and ${day("v.created_at")} between ${from}::date and ${to}::date)::int as sold,
           count(*) filter (where ${day("v.created_at")} <= ${to}::date
                              and (v.ended_at is null or ${day("v.ended_at")} > ${to}::date)
                              and v.total_hours - v.used_hours > 0 and v.expiry_date >= ${to}::date)::int as active,
           count(*) filter (where v.ended_at is not null and ${day("v.ended_at")} between ${from}::date and ${to}::date)::int as ended
      from public.vouchers v
     where true ${vBr}
     group by 1`);

  // 3 · course sessions taught (ATTENDED in the window), by the course's activity / kind / size
  const courseSessions = await rowsOf(sql`
    select c.subject_id::text as subject_id,
           case when c.co_student_id is null then 'PRIVATE' else 'DUO' end as kind,
           c.size as size, count(*)::int as n
      from public.bookings b join public.course_packages c on c.id = b.course_id
     where b.status = 'ATTENDED' and b.date between ${from}::date and ${to}::date ${bBr}
     group by 1, 2, 3`);

  // 4 · voucher sessions taught, by the voucher's size
  const voucherSessions = await rowsOf(sql`
    select v.total_hours as size, count(*)::int as n
      from public.bookings b join public.vouchers v on v.id = b.voucher_id
     where b.status = 'ATTENDED' and b.date between ${from}::date and ${to}::date ${bBr}
     group by 1`);

  // 5 · (CEO only) the revenue of the window, joined to its course / voucher by ref_type + ref_id; what does not resolve is `unmatched`
  let revenue: Parameters<typeof assembleCourses>[0]["revenue"] = null;
  if (role === "ceo") {
    const lines = await rowsOf(sql`
      select c.subject_id::text as subject_id,
             case when c.id is not null then (case when c.co_student_id is null then 'PRIVATE' else 'DUO' end) end as ckind,
             c.size as csize, v.total_hours as vsize, sum(r.amount_minor)::bigint as amount
        from bo.revenue_line r
        left join public.course_packages c on r.ref_type = 'COURSE' and r.ref_id = c.id::text
        left join public.vouchers v on r.ref_type = 'VOUCHER' and r.ref_id = v.id::text
       where r.type in ('COURSE', 'VOUCHER') and r.occurred_on between ${from}::date and ${to}::date ${rBr}
       group by 1, 2, 3, 4`);
    revenue = { courses: [], vouchers: [], unmatched: 0 };
    for (const l of lines) {
      if (l.ckind) revenue.courses.push({ subjectId: String(l.subject_id), kind: l.ckind as "PRIVATE" | "DUO", size: num(l.csize), amount: num(l.amount) });
      else if (l.vsize !== null && l.vsize !== undefined) revenue.vouchers.push({ size: num(l.vsize), amount: num(l.amount) });
      else revenue.unmatched += num(l.amount); // NULL ref, ref_type CAMP / BOOKING, or a ref with no row: never guessed into a row
    }
  }

  // 6 · the activity names, once
  const names = new Map<string, string>((await rowsOf(sql`select id::text as id, name from public.subjects`)).map((r) => [String(r.id), String(r.name)]));

  const { rows, totals } = assembleCourses({
    courses: courses.map((r) => ({ subjectId: String(r.subject_id), kind: r.kind as "PRIVATE" | "DUO", size: num(r.size), sold: num(r.sold), active: num(r.active), paused: num(r.paused), ended: num(r.ended) })),
    vouchers: vouchers.map((r) => ({ size: num(r.size), sold: num(r.sold), active: num(r.active), ended: num(r.ended) })),
    courseSessions: courseSessions.map((r) => ({ subjectId: String(r.subject_id), kind: r.kind as "PRIVATE" | "DUO", size: num(r.size), n: num(r.n) })),
    voucherSessions: voucherSessions.map((r) => ({ size: num(r.size), n: num(r.n) })),
    revenue,
    names,
  });
  return { rows, totals, activeIsApprox: to < bangkokDay((deps.now ?? (() => new Date()))()) };
}
