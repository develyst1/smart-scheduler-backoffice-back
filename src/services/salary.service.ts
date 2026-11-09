// Thin-slip pay-run + slip engine (SPEC-100 / TASK-865). The logic lives here, against a small `SalaryStore`, so the whole
// round trip (create period → run → lines → total → lock → export) is testable with no database. Money is integer SATANG.
// Every response money field (`baseAmount`, `total`, `amount`) is integer satang; the CSV is baht with 2 decimals.

import { ApiException, badRequest, conflict, notFound } from "../lib/http";
import { formulaSafe } from "../lib/slip-sections"; // 🔻 TASK-879 (Silver's condition): a text cell that starts with = + - @ must not become a formula
import { numericFromSatang } from "../lib/satang";

import { payPeriodRange } from "../lib/pay-period";
import { effectiveRoles, rolesProblem, roleOfDay, type EmploymentType } from "../lib/role-of-day";
import { ddmm, extraHourLines, flPayLines, otPaySatang, type AutoLine, type HoursDay } from "../lib/pay-rules";
import { readHours as defaultReadHours } from "./hours-reader";
import { autoLineKey, fire, hoursText, manualLineKey, otherDetail, payLineText, realNotify, type NotifyFn } from "./salary-notify"; // 🔻 TASK-920
import { bangkokDate } from "../lib/stock-read";
export type { EmploymentType };
export type ClassType = "private" | "duo" | "group" | "eca" | "camp";
export const CLASS_TYPES: readonly ClassType[] = ["private", "duo", "group", "eca", "camp"];
export type Vehicle = "car" | "motorbike";
export type PeriodStatus = "open" | "locked";
export type SlipStatus = "draft" | "confirmed" | "locked";
export type LineKind = "base" | "other" | "extra_hour" | "ot" | "merit" | "bonus" | "commission" | "fl_pay" | "transport";

export interface Period { id: string; year: number; month: number; periodStart: string | null; periodEnd: string | null; status: PeriodStatus; lockAt: Date; lockedAt: Date | null }
export interface Slip { id: string; periodId: string; teacherId: string; baseSatang: number; status: SlipStatus }
export interface Line { id: string; slipId: string; kind: LineKind; label: string; amountSatang: number; source: "manual" | "auto"; createdBy: string; /** What an AUTO line was derived from (e.g. `fl:2026-10-14`); null on a manual line. */ sourceRef?: string | null; /** 🔻 TASK-903: the class type of a `fl_pay` line (one line per FL date x class); null on every other kind. */ classType?: ClassType | null }

/** The slip's display name for a line kind. `fl_pay` is shown as "Freelance Hour" (REQ-5010 item 4); the stored kind never changes. */
export const KIND_LABEL: Record<LineKind, string> = { base: "Base", other: "Other", extra_hour: "Extra Hour", ot: "OT", merit: "Merit", bonus: "Bonus", commission: "Commission", fl_pay: "Freelance Hour", transport: "Transport" };
/** The kinds `runPeriod` derives from the timetable: it owns (creates, refreshes, removes) the AUTO lines of exactly these. */
export const DERIVED_KINDS: readonly LineKind[] = ["fl_pay", "extra_hour"];
export interface Profile {
  teacherId: string;
  employmentType: EmploymentType;
  /** The roles held; EMPTY ⇒ just `employmentType`. The only multi-role combination is PT + FL. */
  roles: EmploymentType[];
  baseSatang: number | null;
  meritEligible: boolean;
  vehicle: Vehicle | null;
  active: boolean;
}
export interface FlRate { classType: ClassType; rateSatang: number }

/** Everything the engine needs from storage. The Drizzle store and the in-memory test store both implement it. */
export interface SalaryStore {
  listPeriods(): Promise<Period[]>;
  getPeriod(id: string): Promise<Period | undefined>;
  getPeriodByYearMonth(year: number, month: number): Promise<Period | undefined>;
  insertPeriod(p: { year: number; month: number; lockAt: Date; periodStart: string; periodEnd: string }): Promise<Period>;
  /** Sets the period `locked` (+ `lockedAt`) and every slip in it `locked`. Idempotent. Returns the period. */
  lockPeriod(id: string, at: Date): Promise<Period>;
  listProfiles(): Promise<Profile[]>;
  getProfile(teacherId: string): Promise<Profile | undefined>;
  upsertProfile(p: Profile): Promise<Profile>;
  /** The FL hourly rates of a person (by teacher id), one per class type. Empty for an unknown person. */
  listFlRates(teacherId: string): Promise<FlRate[]>;
  /** Upsert one (person, class type) rate; `undefined` when the person has no profile. */
  upsertFlRate(teacherId: string, classType: ClassType, rateSatang: number): Promise<FlRate | undefined>;
  listSlips(periodId: string): Promise<Slip[]>;
  getSlip(id: string): Promise<Slip | undefined>;
  /** Creates a draft slip, or refreshes `baseSatang` of an existing DRAFT one; a confirmed/locked slip is left alone. */
  upsertDraftSlip(periodId: string, teacherId: string, baseSatang: number): Promise<"created" | "refreshed" | "skipped">;
  listLines(slipId: string): Promise<Line[]>;
  /** slipId → Σ amountSatang for every slip of the period. */
  sumLinesByPeriod(periodId: string): Promise<Map<string, number>>;
  insertLine(l: Omit<Line, "id">): Promise<Line>;
  /**
   * Makes the slip's AUTO lines of `kinds` equal `desired` (keyed on kind + sourceRef, migration 0011's partial unique index): inserts the
   * missing, rewrites a changed label/amount, deletes an auto line no longer derived. Manual lines are never touched. Atomic.
   */
  syncAutoLines(slipId: string, kinds: readonly LineKind[], desired: readonly AutoLine[], actor: string): Promise<{ inserted: number; updated: number; removed: number; /** 🔻 TASK-920: the lines actually inserted (not the ones kept or updated) */ insertedLines: AutoLine[] }>;
  getLine(id: string): Promise<Line | undefined>;
  deleteLine(id: string): Promise<void>;
  /** DISPLAY ONLY: teacher id → name, a read-only lookup of `public.teachers` (not an FK). An id with no row is absent from the map. */
  teacherNames(ids: string[]): Promise<Map<string, string>>;
  /** TASK-886: ACTIVE profiles joined to their display name, never a system teacher ("No Teacher"); a profile with no teacher row is left out. NO pay. */
  listEntriesPeople(): Promise<{ teacherId: string; name: string; meritEligible: boolean }[]>;
}

/** One CSV cell: quoted (with doubled quotes) only when it holds a comma, quote or line break. */
const csvCell = (s: string): string => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

const LOCKED_MSG = "งวดนี้ถูกล็อกแล้ว แก้ไขไม่ได้";
const locked = () => conflict("LOCKED", LOCKED_MSG);

/** 12:00 Asia/Bangkok (UTC+7, no DST) on the LAST day of (year, month) = 05:00 UTC (REQ-120 R1.5). month is 1–12. */
export const defaultLockAt = (year: number, month: number): Date => new Date(Date.UTC(year, month, 0, 5, 0, 0));

export interface SalaryDeps {
  /** link 2's reader; injectable so the pay run is testable with no database. */
  readHours: (teacherId: string, start: string, end: string) => Promise<HoursDay[]>;
  /** 🔻 TASK-920: the notifier for the Salary events (Extra Hour / OT / Other). Absent = notifications off (every existing test). Never throws; a failure is counted as `notifyFailed`. */
  notify?: NotifyFn;
}

export function createSalaryService(store: SalaryStore, now: () => Date = () => new Date(), deps: SalaryDeps = { readHours: defaultReadHours, notify: realNotify }) {
  const coachName = async (teacherId: string): Promise<string | null> => (await store.teacherNames([teacherId])).get(teacherId) ?? null; // 🔻 TASK-920
  /** The lazy 12:00 auto-lock: any read or write of a period first locks it (and its slips) once `now >= lock_at`. */
  async function fresh(period: Period): Promise<Period> {
    if (period.status === "open" && now().getTime() >= period.lockAt.getTime()) return store.lockPeriod(period.id, now());
    return period;
  }
  async function periodOrThrow(id: string): Promise<Period> {
    const p = await store.getPeriod(id);
    if (!p) throw notFound("ไม่พบงวดเงินเดือน");
    return fresh(p);
  }
  async function slipOrThrow(id: string): Promise<{ slip: Slip; period: Period }> {
    const slip = await store.getSlip(id);
    if (!slip) throw notFound("ไม่พบสลิป");
    const period = await periodOrThrow(slip.periodId);
    // a lazy lock may just have locked the slips: read it back
    const again = (await store.getSlip(id)) ?? slip;
    return { slip: again, period };
  }

  const profileDTO = (p: Profile) => ({
    teacherId: p.teacherId,
    employmentType: p.employmentType,
    roles: effectiveRoles(p),
    baseSalary: p.baseSatang,
    active: p.active,
    meritEligible: p.meritEligible,
    vehicle: p.vehicle,
  });
  const periodDTO = (p: Period) => ({ id: p.id, year: p.year, month: p.month, periodStart: p.periodStart, periodEnd: p.periodEnd, status: p.status, lockAt: p.lockAt.toISOString(), lockedAt: p.lockedAt ? p.lockedAt.toISOString() : null });
  const lineDTO = (l: Line) => ({ id: l.id, kind: l.kind, kindLabel: KIND_LABEL[l.kind], classType: l.classType ?? null, label: l.label, amount: l.amountSatang, source: l.source });

  return {
    async listPeriods() {
      const all = await store.listPeriods();
      return Promise.all(all.map(async (p) => periodDTO(await fresh(p))));
    },

    async createPeriod(year: number, month: number) {
      if (!Number.isInteger(year) || year < 2000 || year > 2100) throw badRequest("year must be 2000–2100");
      if (!Number.isInteger(month) || month < 1 || month > 12) throw badRequest("month must be 1–12");
      if (await store.getPeriodByYearMonth(year, month)) throw conflict("PERIOD_EXISTS", "มีงวดเดือนนี้แล้ว");
      const range = payPeriodRange(year, month); // R1.4: last day of the previous month → the day before the last day of this one
      return periodDTO(await fresh(await store.insertPeriod({ year, month, lockAt: defaultLockAt(year, month), periodStart: range.start, periodEnd: range.end })));
    },

    /** Upserts a draft slip for every ACTIVE FT profile. Idempotent; never touches a confirmed/locked slip or any line. */
    // TASK-878: also FT/PT/FL; re-derives that slip's AUTO lines (FL "Freelance Hour" + Extra Hour, one per date) from link 2's hours over
    // [period_start, period_end]. Idempotent (kind + source_ref); never touches a confirmed/locked slip or a manual line (OT, Merit, Other).
    // A day with a class type but no FL rate goes to `warnings`, never paid at 0 silently.
    async runPeriod(id: string) {
      const period = await periodOrThrow(id);
      if (period.status === "locked") throw locked();
      if (!period.periodStart || !period.periodEnd) throw badRequest("งวดนี้ไม่มีช่วงวันที่ (period_start / period_end)");
      let created = 0;
      let refreshed = 0;
      let auto = { inserted: 0, updated: 0, removed: 0 };
      let notifyFailed = 0; // 🔻 TASK-920
      const warnings: { teacherId: string; date: string; classType: ClassType; problem: "no_fl_rate" }[] = [];
      for (const p of (await store.listProfiles()).filter((x) => x.active && ["FT", "PT", "FL"].includes(x.employmentType))) {
        const r = await store.upsertDraftSlip(period.id, p.teacherId, p.baseSatang ?? 0);
        if (r === "created") created += 1;
        else if (r === "refreshed") refreshed += 1;
        if (r === "skipped") continue; // confirmed / locked: its lines are frozen
        const slip = (await store.listSlips(period.id)).find((s) => s.teacherId === p.teacherId)!;
        const days = await deps.readHours(p.teacherId, period.periodStart, period.periodEnd);
        const rates: Partial<Record<ClassType, number>> = Object.fromEntries((await store.listFlRates(p.teacherId)).map((x) => [x.classType, x.rateSatang]));
        const fl = flPayLines(p, rates, days);
        for (const m of fl.missingRates) warnings.push({ teacherId: p.teacherId, date: m.date, classType: m.classType, problem: "no_fl_rate" });
        const sync = await store.syncAutoLines(slip.id, DERIVED_KINDS, [...fl.lines, ...extraHourLines(p, days)], "auto");
        auto = { inserted: auto.inserted + sync.inserted, updated: auto.updated + sync.updated, removed: auto.removed + sync.removed };
        // 🔻 TASK-920: one Extra Hour item per line INSERTED by this run (a kept or updated line, FL pay and every re-run notify nothing). The line is committed; a failure is only counted.
        for (const l of sync.insertedLines.filter((x) => x.kind === "extra_hour")) {
          const day = l.sourceRef.slice(3); // eh:YYYY-MM-DD
          notifyFailed += (await fire(deps.notify, { type: "Extra Hour", text: payLineText("Extra Hour", await coachName(p.teacherId), day, hoursText(l.extraMinutes ?? 0)), occurredOn: day, key: autoLineKey(slip.id, "extra_hour", l.sourceRef) })).failed;
        }
      }
      return { created, refreshed, ...(auto.inserted + auto.updated + auto.removed ? { autoLines: auto } : {}), ...(warnings.length ? { warnings } : {}), ...(notifyFailed ? { notifyFailed } : {}) };
    },

    /**
     * OT (R1.2): the admin enters the NON-TEACHING minutes worked on a date of the period; the line is base / 26 / 8 x 1.15 per hour, in satang,
     * rounded once. FT / PT only (and only on a day the person works as FT / PT). The amount is fixed when entered: change the base later and
     * the line stays; delete it and enter again. Manual-source line, so a pay re-run never touches it.
     */
    async addOt(slipId: string, input: { date: string; minutes: number }, actor: string) {
      if (!Number.isInteger(input.minutes) || input.minutes <= 0 || input.minutes > 24 * 60) throw badRequest("minutes must be an integer 1-1440");
      const { slip, period } = await slipOrThrow(slipId);
      if (period.status === "locked" || slip.status === "locked") throw locked();
      if (!period.periodStart || !period.periodEnd || input.date < period.periodStart || input.date > period.periodEnd) throw badRequest("date is outside the pay period");
      const profile = await store.getProfile(slip.teacherId);
      if (!profile) throw notFound("ไม่พบโปรไฟล์");
      const role = roleOfDay(profile, input.date);
      if (role !== "FT" && role !== "PT") throw badRequest("OT is for FT / PT days only");
      if (slip.baseSatang <= 0) throw badRequest("the slip has no base salary to compute OT from");
      const amount = otPaySatang(slip.baseSatang, input.minutes);
      const hrs = Math.round((input.minutes / 60) * 100) / 100;
      const line = await store.insertLine({ slipId: slip.id, kind: "ot", label: `${ddmm(input.date)}: OT ${hrs} Hr`, amountSatang: amount, source: "manual", createdBy: actor, sourceRef: null });
      // 🔻 TASK-920: the OT line is written; tell the assigned people (hours only, NO amount). A failure never undoes the line.
      const nf = (await fire(deps.notify, { type: "OT", text: payLineText("OT", await coachName(slip.teacherId), input.date, hoursText(input.minutes)), occurredOn: input.date, key: manualLineKey(line.id) })).failed;
      return { ...lineDTO(line), ...(nf ? { notifyFailed: nf } : {}) };
    },

    /** TASK-886 / SPEC-102 E2b - the admin-safe people list for the Entries picker: id, display name, meritEligible. NO pay of any kind. Ordered by name. */
    async listEntriesPeople() {
      const rows = await store.listEntriesPeople();
      return rows.map((r) => ({ teacherId: r.teacherId, name: r.name, meritEligible: r.meritEligible })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.teacherId < b.teacherId ? -1 : 1));
    },

    /**
     * TASK-880 / SPEC-102 E1 - a coach reads ONLY their own slip. The slip is resolved by the TOKEN's teacherId (the route passes it; there is no
     * id the caller can supply). No period or no slip for the month => `{ slip: null }` (200); the FE shows "no slip yet".
     */
    async mySlip(teacherId: string, year: number, month: number) {
      if (!Number.isInteger(year) || year < 2000 || year > 2100) throw badRequest("year must be 2000-2100");
      if (!Number.isInteger(month) || month < 1 || month > 12) throw badRequest("month must be 1-12");
      const found = await store.getPeriodByYearMonth(year, month);
      if (!found) return { slip: null };
      const period = await fresh(found);
      const slip = (await store.listSlips(period.id)).find((s) => s.teacherId === teacherId);
      if (!slip) return { slip: null };
      const lines = await store.listLines(slip.id);
      const teacherName = (await store.teacherNames([teacherId])).get(teacherId) ?? null;
      const p = periodDTO(period);
      return {
        period: { year: p.year, month: p.month, periodStart: p.periodStart, periodEnd: p.periodEnd, lockAt: p.lockAt, status: p.status },
        teacherId,
        teacherName,
        baseAmount: slip.baseSatang,
        lines: lines.map((l) => ({ id: l.id, kind: l.kind, kindLabel: KIND_LABEL[l.kind], classType: l.classType ?? null, label: l.label, amountSatang: l.amountSatang })),
        total: slip.baseSatang + lines.reduce((s, l) => s + l.amountSatang, 0),
        status: slip.status,
      };
    },

    /**
     * TASK-880 / SPEC-102 E2 - the ADMIN-BLIND entry: add ONE merit / other line to a coach's slip for a period, finding or creating that slip.
     * The returned value is the created line ONLY - never a total, the base, another line or another coach (the blind contract; this return
     * is its single enforcement point). The period must already exist (an admin never creates one).
     */
    async addEntry(input: { teacherId: string; year: number; month: number; kind: string; amountSatang: number; label?: string; reason?: string }, actor: string) {
      if (input.kind !== "merit" && input.kind !== "other") throw new ApiException(400, "KIND_NOT_ALLOWED", "kind must be merit or other");
      if (!Number.isSafeInteger(input.amountSatang) || input.amountSatang === 0) throw badRequest("amountSatang must be a non-zero integer (satang)");
      if (input.kind === "merit" && input.amountSatang < 0) throw badRequest("merit must be positive");
      const label = (input.label ?? "").trim();
      const reason = (input.reason ?? "").trim();
      if (label.length > 200 || reason.length > 500) throw badRequest("label / reason too long");
      if (input.kind === "other" && !reason) throw badRequest("ต้องระบุเหตุผล");
      const found = await store.getPeriodByYearMonth(input.year, input.month);
      if (!found) throw notFound("ไม่พบงวดเงินเดือน");
      const period = await fresh(found);
      if (period.status === "locked") throw locked();
      const profile = await store.getProfile(input.teacherId);
      if (!profile) throw notFound("ไม่พบโปรไฟล์");
      if (input.kind === "merit" && !profile.meritEligible) throw new ApiException(422, "NOT_MERIT_ELIGIBLE", "this person is not merit-eligible");
      let slip = (await store.listSlips(period.id)).find((s) => s.teacherId === input.teacherId);
      if (!slip) {
        await store.upsertDraftSlip(period.id, input.teacherId, profile.baseSatang ?? 0);
        slip = (await store.listSlips(period.id)).find((s) => s.teacherId === input.teacherId)!;
      }
      if (slip.status === "locked") throw locked();
      const text = input.kind === "other" ? (label ? `${label} (${reason})` : reason) : label || reason || "Merit";
      const created = await store.insertLine({ slipId: slip.id, kind: input.kind, label: text, amountSatang: input.amountSatang, source: "manual", createdBy: actor, sourceRef: null });
      // 🔻 TASK-920: an admin-entered `other` line notifies (Merit is not a notification type). The admin-blind response is unchanged unless the notification failed.
      let nf = 0;
      if (input.kind === "other") {
        const day = bangkokDate(now());
        nf = (await fire(deps.notify, { type: "Other", text: payLineText("Other", await coachName(slip.teacherId), day, otherDetail(reason)), occurredOn: day, key: manualLineKey(created.id) })).failed;
      }
      return { lineId: created.id, kind: created.kind, kindLabel: KIND_LABEL[created.kind], label: created.label, amountSatang: created.amountSatang, ...(nf ? { notifyFailed: nf } : {}) };
    },

    /** Merit (R1.2): a typed positive amount (integer satang), only for a profile with `merit_eligible`. No auto compute. */
    async addMerit(slipId: string, input: { amount: number; label?: string }, actor: string) {
      if (!Number.isSafeInteger(input.amount) || input.amount <= 0) throw badRequest("amount must be a positive integer (satang)");
      const { slip, period } = await slipOrThrow(slipId);
      if (period.status === "locked" || slip.status === "locked") throw locked();
      const profile = await store.getProfile(slip.teacherId);
      if (!profile?.meritEligible) throw badRequest("this person is not merit-eligible");
      return lineDTO(await store.insertLine({ slipId: slip.id, kind: "merit", label: (input.label ?? "").trim() || "Merit", amountSatang: input.amount, source: "manual", createdBy: actor, sourceRef: null }));
    },

    /** The month overview. */
    // TASK-883: also `missingRates` - the FL-rate gaps runPeriod warns about, computed READ-ONLY here so they are always true, not "as of the last Run".
    // Cost: one reader call + one rates read per active FT/PT/FL profile on every overview read (fine for the demo; a cache is out of scope).
    async getPeriod(id: string, opts: { missingRates?: boolean } = {}) {
      const period = await periodOrThrow(id);
      const slips = await store.listSlips(period.id);
      const sums = await store.sumLinesByPeriod(period.id);
      const names = await store.teacherNames(slips.map((s) => s.teacherId));
      const missingRates: { teacherId: string; date: string; classType: ClassType; problem: "no_fl_rate" }[] = [];
      if (opts.missingRates !== false && period.periodStart && period.periodEnd) {
        for (const p of (await store.listProfiles()).filter((x) => x.active && ["FT", "PT", "FL"].includes(x.employmentType))) {
          const rates: Partial<Record<ClassType, number>> = Object.fromEntries((await store.listFlRates(p.teacherId)).map((x) => [x.classType, x.rateSatang]));
          const days = await deps.readHours(p.teacherId, period.periodStart, period.periodEnd);
          for (const m of flPayLines(p, rates, days).missingRates) missingRates.push({ teacherId: p.teacherId, date: m.date, classType: m.classType, problem: "no_fl_rate" });
        }
      }
      return {
        period: periodDTO(period),
        slips: slips.map((s) => ({ id: s.id, teacherId: s.teacherId, teacherName: names.get(s.teacherId) ?? null, baseAmount: s.baseSatang, total: s.baseSatang + (sums.get(s.id) ?? 0), status: s.status })),
        missingRates,
      };
    },

    async getSlip(id: string) {
      const { slip, period } = await slipOrThrow(id);
      const lines = await store.listLines(slip.id);
      const total = slip.baseSatang + lines.reduce((s, l) => s + l.amountSatang, 0);
      const teacherName = (await store.teacherNames([slip.teacherId])).get(slip.teacherId) ?? null;
      return { id: slip.id, period: periodDTO(period), teacherId: slip.teacherId, teacherName, baseAmount: slip.baseSatang, status: slip.status, lines: lines.map(lineDTO), total };
    },

    /** An "Other ±" line: signed integer satang, a non-empty reason. Refused (409 LOCKED) once the period / slip is locked. */
    async addLine(slipId: string, input: { amount: number; label: string }, actor: string) {
      const label = (input.label ?? "").trim();
      if (!label) throw badRequest("ต้องระบุเหตุผล");
      if (!Number.isSafeInteger(input.amount) || input.amount === 0) throw badRequest("amount must be a non-zero integer (satang, may be negative)");
      const { slip, period } = await slipOrThrow(slipId);
      if (period.status === "locked" || slip.status === "locked") throw locked();
      const line = await store.insertLine({ slipId: slip.id, kind: "other", label, amountSatang: input.amount, source: "manual", createdBy: actor });
      // 🔻 TASK-920: an "Other" item: the reason as typed unless it could hold money (then "Other item"); never the amount.
      const day = bangkokDate(now());
      const nf = (await fire(deps.notify, { type: "Other", text: payLineText("Other", await coachName(slip.teacherId), day, otherDetail(label)), occurredOn: day, key: manualLineKey(line.id) })).failed;
      return { ...lineDTO(line), ...(nf ? { notifyFailed: nf } : {}) };
    },

    async removeLine(slipId: string, lineId: string) {
      const { slip, period } = await slipOrThrow(slipId);
      if (period.status === "locked" || slip.status === "locked") throw locked();
      const line = await store.getLine(lineId);
      if (!line || line.slipId !== slip.id) throw notFound("ไม่พบรายการ");
      await store.deleteLine(line.id);
    },

    /** "Lock now" (explicit). Idempotent. */
    async lockPeriod(id: string) {
      const period = await periodOrThrow(id);
      return periodDTO(period.status === "locked" ? period : await store.lockPeriod(period.id, now()));
    },

    /** CSV, one row per slip: teacher_id, base_salary, total, status — baht with 2 decimals. Reads still work when locked. */
    async exportCsv(id: string) {
      const overview = await this.getPeriod(id, { missingRates: false });
      const rows = overview.slips.map((s) => [s.teacherId, csvCell(formulaSafe(s.teacherName ?? "")), numericFromSatang(s.baseAmount), numericFromSatang(s.total), s.status].join(","));
      const { year, month } = overview.period;
      return { filename: `salary-${year}-${String(month).padStart(2, "0")}.csv`, body: ["teacher_id,teacher_name,base_salary,total,status", ...rows].join("\r\n") + "\r\n" };
    },

    async listProfiles() {
      return (await store.listProfiles()).map(profileDTO);
    },

    /**
     * CEO sets a person's profile. `employmentType` / `baseSalary` / `active` as in SPEC-100; the TASK-871 fields are OPTIONAL and, when
     * omitted, keep what is stored (a new profile starts with roles = [] , merit off, no vehicle). Roles: one, or exactly PT + FL.
     */
    async setProfile(
      teacherId: string,
      input: { employmentType: EmploymentType; baseSalary: number | null; active: boolean; roles?: EmploymentType[]; meritEligible?: boolean; vehicle?: Vehicle | null },
    ) {
      if (input.baseSalary !== null && (!Number.isSafeInteger(input.baseSalary) || input.baseSalary < 0)) throw badRequest("baseSalary must be an integer ≥ 0 (satang) or null");
      const cur = await store.getProfile(teacherId);
      const roles = input.roles !== undefined ? [...new Set(input.roles)] : (cur?.roles ?? []);
      const problem = rolesProblem({ employmentType: input.employmentType, roles });
      if (problem) throw badRequest(`roles: ${problem}`);
      const p = await store.upsertProfile({
        teacherId,
        employmentType: input.employmentType,
        roles: roles.length === 1 && roles[0] === input.employmentType ? [] : roles, // a lone role is just employmentType: stored as []
        baseSatang: input.baseSalary,
        meritEligible: input.meritEligible ?? cur?.meritEligible ?? false,
        vehicle: input.vehicle !== undefined ? input.vehicle : (cur?.vehicle ?? null),
        active: input.active,
      });
      return profileDTO(p);
    },

    /** R1.2 — a person's FL hourly rates, one per class type that has one (integer satang per hour). 404 for an unknown person. */
    async getFlRates(teacherId: string) {
      if (!(await store.getProfile(teacherId))) throw notFound("ไม่พบโปรไฟล์");
      const have = new Map((await store.listFlRates(teacherId)).map((r) => [r.classType, r.rateSatang]));
      return CLASS_TYPES.filter((c) => have.has(c)).map((c) => ({ classType: c, rate: have.get(c)! }));
    },

    /** Set ONE (person, class type) FL rate: an integer satang per hour ≥ 0. 404 for an unknown person, 400 for a bad class type / rate. */
    async setFlRate(teacherId: string, classType: string, rate: number) {
      if (!(CLASS_TYPES as readonly string[]).includes(classType)) throw badRequest(`classType must be one of ${CLASS_TYPES.join(", ")}`);
      if (!Number.isSafeInteger(rate) || rate < 0) throw badRequest("rate must be an integer ≥ 0 (satang per hour)");
      const r = await store.upsertFlRate(teacherId, classType as ClassType, rate);
      if (!r) throw notFound("ไม่พบโปรไฟล์");
      return { classType: r.classType, rate: r.rateSatang };
    },
  };
}

export type SalaryService = ReturnType<typeof createSalaryService>;
