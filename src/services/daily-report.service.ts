// 🔻 TASK-885 (REQ-120 R1.7, SPEC-100) — the Daily Training Report: per day, each coach's teaching hours and THAT DAY's derived pay. READ-ONLY: no write, no period needed (a date with no period, or a locked one, still answers).
// It reuses — never re-derives — the pay run's own parts, so the report and the slip cannot disagree: the minutes come from TASK-872's `readHours`, the role of the day from `roleOfDay`, the amounts from `flPayLines` / `extraHourLines`
// applied to that one day. Teaching pay only: OT / Merit / Bonus / Other / Transportation are not in this report (the final UI's Daily shows none).
// Who is listed: every ACTIVE FT / PT / FL profile with teaching minutes that day, restricted to `listEntriesPeople()` — the people with a teacher row who are NOT the system teacher ("No Teacher", `is_system`), so it is never a row.
import { badRequest } from "../lib/http";
import { CLASS_ORDER, flPayLines, extraHourLines, type ClassType, type HoursDay } from "../lib/pay-rules";
import { dayOfWeek, roleOfDay, type EmploymentType } from "../lib/role-of-day";
import * as hoursReader from "./hours-reader"; // the namespace, so a test can stand in for the reader

/** The final UI's words for a role (`mock/a-salary.ts` DailyRow.role). */
export const DAILY_ROLE_WORDS: Record<"FT" | "PT" | "FL", "Full-time" | "Part-time" | "Freelance"> = { FT: "Full-time", PT: "Part-time", FL: "Freelance" };
const ROLE_ORDER: readonly string[] = ["FT", "PT", "FL"];
const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
/** What a part with no rate shows instead of an amount (no guessed figure): the rate cell is a dash. */
export const MISSING_RATE_WORDS = "—";

export interface DailyRow {
  teacherId: string;
  role: "Full-time" | "Part-time" | "Freelance";
  /** minutes ÷ 60, 2 decimals (the only non-integer number in the report) */
  hours: number;
  minutes: number;
  description: string;
  /** integer satang; null when nothing is derived that day (FT / PT under the threshold, or only missing rates) */
  incomeSatang: number | null;
}
export interface DailyReport {
  date: string;
  weekday: (typeof WEEKDAY)[number];
  rows: DailyRow[];
  missingRates: { teacherId: string; classType: ClassType }[];
  totals: { coaches: number; minutes: number; incomeSatang: number };
}

/** The slice of the salary service this report reads (injectable: testable with no database). */
export interface DailyDeps {
  listProfiles(): Promise<Array<{ teacherId: string; employmentType: EmploymentType; roles: readonly EmploymentType[]; active: boolean }>>;
  getFlRates(teacherId: string): Promise<Array<{ classType: string; rate: number }>>;
  /** active profiles with a teacher row, never the system teacher */
  listEntriesPeople(): Promise<Array<{ teacherId: string }>>;
  readHours?: (teacherId: string, start: string, end: string) => Promise<HoursDay[]>;
}

const isRealDate = (d: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(new Date(`${d}T00:00:00Z`).getTime()) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;
/** The final UI's words for a class type (`mock/a-salary.ts`): a FIXED map, never a capitalisation (ECA is not «Eca»). */
export const CLASS_WORDS: Record<ClassType, string> = { private: "Private", duo: "Duo", group: "Group", eca: "ECA", camp: "Camp" };
const classWord = (c: string): string => CLASS_WORDS[c as ClassType] ?? c.charAt(0).toUpperCase() + c.slice(1);
const hoursOf = (min: number): number => Math.round((min / 60) * 100) / 100;

/**
 * The pay-rules label of a derived line is `"14/10 (Wed): private 1 Hr × 300, duo 2 Hr × 250"` (FL) or `"14/10 (Wed): 6 Hr → extra 2 Hr × 350"` (FT / PT). The report's description is built FROM that label — one formatter (the pay run's), not a second — in
 * the final UI's words: the class capitalised and the baht sign (`Private 1 Hr × 300 ฿`), and `Extra Hour 2 Hr × 350 ฿`.
 */
export function flPartsFromLabel(label: string): string[] {
  const body = label.slice(label.indexOf("): ") + 3);
  return body.split(", ").map((p) => { const [cls, ...rest] = p.split(" "); return `${[classWord(cls!), ...rest].join(" ")} ฿`; });
}
export function extraPartFromLabel(label: string): string {
  const m = /extra (\S+ Hr × \S+)$/.exec(label);
  if (!m) throw new Error(`unrecognised extra-hour label: ${label}`);
  return `Extra Hour ${m[1]} ฿`;
}

export async function buildDailyReport(date: string, deps: DailyDeps): Promise<DailyReport> {
  if (!isRealDate(date)) throw badRequest("date must be a real date, YYYY-MM-DD");
  const readHours = deps.readHours ?? ((t: string, a: string, b: string) => hoursReader.readHours(t, a, b));
  const [profiles, people] = await Promise.all([deps.listProfiles(), deps.listEntriesPeople()]);
  const real = new Set(people.map((p) => p.teacherId));
  const rows: Array<DailyRow & { _order: number }> = [];
  const missingRates: DailyReport["missingRates"] = [];

  for (const p of profiles.filter((x) => x.active && ["FT", "PT", "FL"].includes(x.employmentType) && real.has(x.teacherId))) {
    const days = await readHours(p.teacherId, date, date);
    const day = days.find((d) => d.date === date);
    if (!day || day.teachingMinutesTotal <= 0) continue;
    const role = roleOfDay(p, date);
    if (role !== "FT" && role !== "PT" && role !== "FL") continue;
    let description = "—";
    let incomeSatang: number | null = null;
    if (role === "FL") {
      const rates: Partial<Record<ClassType, number>> = {};
      for (const r of await deps.getFlRates(p.teacherId)) rates[r.classType as ClassType] = r.rate;
      const fl = flPayLines(p, rates, [day]);
      const parts = fl.lines.flatMap((l) => flPartsFromLabel(l.label));
      for (const m of fl.missingRates) {
        missingRates.push({ teacherId: p.teacherId, classType: m.classType });
        parts.push(`${classWord(m.classType)} ${hoursOf(day.byType[m.classType] ?? 0)} Hr × ${MISSING_RATE_WORDS} ฿`);
      }
      // keep the parts in the pay run's class order
      const order = (s: string) => CLASS_ORDER.findIndex((c) => s.startsWith(CLASS_WORDS[c]));
      parts.sort((a, b) => order(a) - order(b));
      if (parts.length) description = parts.join(" · ");
      if (fl.lines.length) incomeSatang = fl.lines.reduce((n, l) => n + l.amountSatang, 0);
    } else {
      const line = extraHourLines(p, [day])[0];
      if (line) {
        description = extraPartFromLabel(line.label);
        incomeSatang = line.amountSatang;
      }
    }
    rows.push({ teacherId: p.teacherId, role: DAILY_ROLE_WORDS[role], hours: hoursOf(day.teachingMinutesTotal), minutes: day.teachingMinutesTotal, description, incomeSatang, _order: ROLE_ORDER.indexOf(role) });
  }
  rows.sort((a, b) => a._order - b._order || (a.teacherId < b.teacherId ? -1 : a.teacherId > b.teacherId ? 1 : 0));
  const out: DailyRow[] = rows.map(({ _order, ...r }) => r);
  return {
    date,
    weekday: WEEKDAY[dayOfWeek(date)]!,
    rows: out,
    missingRates,
    totals: { coaches: out.length, minutes: out.reduce((n, r) => n + r.minutes, 0), incomeSatang: out.reduce((n, r) => n + (r.incomeSatang ?? 0), 0) },
  };
}
