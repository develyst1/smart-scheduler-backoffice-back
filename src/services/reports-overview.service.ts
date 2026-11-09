// TASK-926 / SPEC-103 §4 - REPORT «รายงาน» (the month overview). READ-ONLY.
//
//   newStudents        students created in the month (Bangkok date), not archived
//   activeStudents     students with a live course / voucher AS OF the month's last day (today for the current month): the shared rule in `lib/reports-live.ts`, not archived
//   trialsBooked       FIRST_TRIAL bookings dated in the month, not CANCELLED
//   trials             the ATTENDED ones
//   trialsConverted    of those, the trials whose booking id is `from_trial_booking_id` (TASK-860) of a SALE course / voucher created within TRIAL_CONVERSION_DAYS (60) of the trial date, inclusive: day 60 in, day 61 out
//   coursesSold / vouchersSold   SALE rows created in the month (an IMPORT never counts)
//   sessionsTaught     ATTENDED lesson bookings dated in the month (FIRST_TRIAL · SINGLE_SESSION · COURSE_PACKAGE · VOUCHER; the non-lesson OTHER and the GROUP slot row, which is "never a lesson itself", are not counted)
//   CEO ONLY (the keys are ABSENT for an admin): revenueMinor / refundsMinor = `summary(date, branch).mtd` of the ledger (`revenue-ledger.service.ts:252`), reused, not re-summed
// `branch` filters the bookings / courses / vouchers / revenue; students are not branch-scoped, so newStudents and activeStudents ignore it.
import { sql } from "drizzle-orm";
import { db } from "../db";
import { liveEntitlementsByStudent } from "../lib/reports-live";
import { summary as ledgerSummary } from "./revenue-ledger.service";
import type { ReportRole } from "./reports-courses.service";

export interface OverviewQuery {
  month: string; // YYYY-MM
  branch?: "BRAVO" | "OTHER";
}
/** A trial counts as converted when a course / voucher sold within this many days of it carries its id (SPEC-103 §4; Khwan is asked about the window). */
export const TRIAL_CONVERSION_DAYS = 60;

/** The conversion window as a pure rule (the SQL below is its mirror, pinned by a test): the sale's Bangkok day is on or after the trial's day and at most TRIAL_CONVERSION_DAYS later (day 60 in, day 61 out). */
export function inConversionWindow(trialDay: string, soldDay: string): boolean {
  const diff = Math.round((Date.parse(`${soldDay}T00:00:00Z`) - Date.parse(`${trialDay}T00:00:00Z`)) / 86_400_000);
  return diff >= 0 && diff <= TRIAL_CONVERSION_DAYS;
}

export interface OverviewResult {
  month: string;
  newStudents: number;
  activeStudents: number;
  trialsBooked: number;
  trials: number;
  trialsConverted: number;
  coursesSold: number;
  vouchersSold: number;
  sessionsTaught: number;
  revenueMinor?: number;
  refundsMinor?: number;
}

type Exec = { execute: (q: ReturnType<typeof sql>) => Promise<unknown> };
export interface OverviewDeps {
  exec?: Exec;
  now?: () => Date;
  /** the ledger's `summary(date, branch)` (injectable for tests); only `.mtd` is read */
  summary?: (date: string, branch?: string) => Promise<{ mtd: { totalMinor: number; refundsMinor: number } }>;
}

const bangkokDay = (d: Date): string => new Date(d.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);
const num = (v: unknown): number => Number(v ?? 0);
/** The last calendar day of `YYYY-MM`. */
export const monthEnd = (month: string): string => {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};

export async function reportOverview(q: OverviewQuery, role: ReportRole, deps: OverviewDeps = {}): Promise<OverviewResult> {
  const d: Exec = deps.exec ?? (db as unknown as Exec);
  const today = bangkokDay((deps.now ?? (() => new Date()))());
  const start = `${q.month}-01`;
  const end = monthEnd(q.month);
  const asOf = today >= start && today < end ? today : end; // the current month counts up to today; any other month to its last day
  const br = q.branch ?? null;
  const first = async (query: ReturnType<typeof sql>): Promise<Record<string, unknown>> => ([...((await d.execute(query)) as Iterable<Record<string, unknown>>)][0] ?? {}) as Record<string, unknown>;
  const day = (col: string) => sql.raw(`(${col} at time zone 'Asia/Bangkok')::date`);
  const bBr = br ? sql`and b.branch = ${br}` : sql``;
  const cBr = br ? sql`and c.branch = ${br}` : sql``;
  const vBr = br ? sql`and v.branch = ${br}` : sql``;

  // 1 · new students (not branch-scoped)
  const newStudents = num((await first(sql`select count(*)::int as n from public.students s where s.archived_at is null and ${day("s.created_at")} between ${start}::date and ${end}::date`)).n);

  // 2 · active students: the shared live rule (one grouped query) minus the archived ones (one small query)
  const live = await liveEntitlementsByStudent(asOf, d as never);
  const archived = new Set([...((await d.execute(sql`select id::text as id from public.students where archived_at is not null`)) as Iterable<{ id: string }>)].map((r) => String(r.id)));
  let activeStudents = 0;
  for (const sid of live.keys()) if (!archived.has(sid)) activeStudents++;

  // 3 · trials: booked / attended / converted
  const t = await first(sql`
    select count(*) filter (where b.status <> 'CANCELLED')::int as booked,
           count(*) filter (where b.status = 'ATTENDED')::int as attended,
           count(*) filter (where b.status = 'ATTENDED' and (
             exists (select 1 from public.course_packages c where c.from_trial_booking_id = b.id and c.source = 'SALE' ${cBr}
                       and ${day("c.created_at")} between b.date and b.date + ${TRIAL_CONVERSION_DAYS}::int)
             or exists (select 1 from public.vouchers v where v.from_trial_booking_id = b.id and v.source = 'SALE' ${vBr}
                       and ${day("v.created_at")} between b.date and b.date + ${TRIAL_CONVERSION_DAYS}::int)
           ))::int as converted
      from public.bookings b
     where b.booking_type = 'FIRST_TRIAL' and b.date between ${start}::date and ${end}::date ${bBr}`);

  // 4 · sold (SALE only)
  const sold = await first(sql`
    select (select count(*)::int from public.course_packages c where c.source = 'SALE' and ${day("c.created_at")} between ${start}::date and ${end}::date ${cBr}) as courses,
           (select count(*)::int from public.vouchers v where v.source = 'SALE' and ${day("v.created_at")} between ${start}::date and ${end}::date ${vBr}) as vouchers`);

  // 5 · sessions taught (ATTENDED lesson bookings)
  const taught = num((await first(sql`
    select count(*)::int as n from public.bookings b
     where b.status = 'ATTENDED' and b.booking_type in ('FIRST_TRIAL', 'SINGLE_SESSION', 'COURSE_PACKAGE', 'VOUCHER')
       and b.date between ${start}::date and ${end}::date ${bBr}`)).n);

  const out: OverviewResult = {
    month: q.month,
    newStudents,
    activeStudents,
    trialsBooked: num(t.booked),
    trials: num(t.attended),
    trialsConverted: num(t.converted),
    coursesSold: num(sold.courses),
    vouchersSold: num(sold.vouchers),
    sessionsTaught: taught,
  };
  // CEO ONLY: the month's revenue / refunds from the ledger's own filter (`summary().mtd` for a date inside the month); absent, never zeroed, for an admin
  if (role === "ceo") {
    const mtd = (await (deps.summary ?? ledgerSummary)(asOf, br ?? undefined)).mtd;
    out.revenueMinor = mtd.totalMinor;
    out.refundsMinor = mtd.refundsMinor;
  }
  return out;
}
