// TASK-867 (REQ-120 R1.2 / R1.6, SPEC-100 §3 / §5 / §9b) — Bonus 50 / Bonus 100 as AUTO pay lines on the slip.
//
// For one pay period it turns TASK-863's candidates (`listBonusCandidates`) into `bo.pay_slip_line` rows with
// `kind = 'bonus'`, `source = 'auto'`, on the right coach's slip. IDEMPOTENT: run it twice and nothing doubles, because every
// line carries `source_ref = b50:<purchaseId>:<coachId>` / `b100:<purchaseId>:<coachId>` and migration 0011's partial unique
// index `(slip_id, kind, source_ref) WHERE source = 'auto'` refuses a second copy.
//
// What it deliberately does NOT do (the TASK's rules):
//   • it never DELETES or REWRITES a money line: a line whose candidate is gone comes back as `orphaned`, one whose amount or
//     label would now differ comes back as `changed`; who removes or corrects money lines is a Salary rule for later;
//   • it never creates a slip (a coach not in the run is `SKIPPED_NO_SLIP`), never touches a `confirmed` slip, never writes
//     into a `locked` period (409 `LOCKED`);
//   • it never pays an UNRESOLVED or NO_FIRST_COACH candidate: they are returned, with their status, for the CEO screen.
//
// Money is integer SATANG throughout: Bonus 50 = 5,000 · Bonus 100 = 10,000, times a share fraction of 1 or 0.5 (exact).
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import { boPaySlipLine } from "../db/schema";
import { conflict } from "../lib/http";
import { DEFAULT_RULES, type Bonus100Candidate, type Bonus50Candidate, type BonusRules } from "../lib/bonus-rules";
import { isWeekend, roleOfDay } from "../lib/role-of-day";
import { numericFromSatang, satangFromNumeric } from "../lib/satang";
import { listBonusCandidates, type BonusCandidates } from "./bonus-candidates.service";
import { dbSalaryStore } from "./salary-db.store";
import type { Profile, SalaryService, SalaryStore } from "./salary.service";

/** 50 ฿ and 100 ฿ in satang (R1.2). */
export const BONUS_50_SATANG = 5_000;
export const BONUS_100_SATANG = 10_000;

// ───────────────────────────────── the shapes ─────────────────────────────────

/** One line this run wants on a slip. `amountSatang` is always a positive integer. */
export interface DesiredLine {
  slipId: string;
  teacherId: string;
  sourceRef: string;
  label: string;
  amountSatang: number;
}

/** An AUTO bonus line already on a slip. */
export interface ExistingBonusLine {
  slipId: string;
  sourceRef: string;
  label: string;
  amountSatang: number;
}

export type SkipReason = "NOT_ELIGIBLE" | "SKIPPED_NO_SLIP" | "SKIPPED_CONFIRMED" | "SKIPPED_LOCKED";

export interface SkippedShare {
  reason: SkipReason;
  bonus: "BONUS_50" | "BONUS_100";
  purchaseId: string;
  coachId: string;
  /** The date eligibility was tested on (the trial's date, or the old course's first ATTENDED date); null when unknown. */
  date: string | null;
  sourceRef: string;
}

export interface UnresolvedCandidate {
  bonus: "BONUS_100";
  purchaseId: string;
  status: "UNRESOLVED" | "NO_FIRST_COACH";
  childId: string;
  prevId: string;
  firstCoachId: string | null;
  latestCoachId: string | null;
}

export interface OrphanedLine extends ExistingBonusLine {
  /** Why we say so: no candidate of this run wants this (slip, source_ref) any more. Left on the slip untouched. */
  note: "NO_LONGER_A_CANDIDATE";
}

export interface ChangedLine {
  slipId: string;
  sourceRef: string;
  existing: { label: string; amountSatang: number };
  wanted: { label: string; amountSatang: number };
}

export interface ApplyBonusResult {
  written: number;
  unchanged: number;
  skipped: SkippedShare[];
  unresolved: UnresolvedCandidate[];
  orphaned: OrphanedLine[];
  /** Same (slip, source_ref) but the amount or label now differs. NOT applied: correcting money is a Salary rule, not this TASK's. */
  changed: ChangedLine[];
}

// ───────────────────────────────── the pure rules ─────────────────────────────────

/**
 * Eligibility (R1.1), from the person's ROLE ON THE DAY of the qualifying class (F3's `roleOfDay`, TASK-871):
 *   FT → yes · PT → only if that day is a PT day, Sat–Sun · FL / STAFF / no profile → no.
 * A person holding PT + FL is PT on Sat–Sun and FL Mon–Fri, so the same call answers them. `date` null ⇒ unknown ⇒ no.
 * An ineligible coach's share is simply not paid (readiness default S17(c), standing per the owner 10-27).
 */
export function isEligible(profile: Profile | undefined, date: string | null): boolean {
  if (!profile || !date) return false;
  const role = roleOfDay(profile, date);
  if (role === "FT") return true;
  return role === "PT" && isWeekend(date);
}

/** What the child is called on the line: nickname, else name. */
const childName = (c: { childNickname: string | null; childName: string }): string => (c.childNickname?.trim() ? c.childNickname.trim() : c.childName.trim());

/** The final UI's words (V3-F p5): `Bonus 50 · <name> (Private|Duo|Voucher)`. */
export function bonusLabel(bonus: "BONUS_50" | "BONUS_100", c: { purchaseKind: "COURSE" | "VOUCHER"; isDuo: boolean; childNickname: string | null; childName: string }): string {
  const what = c.purchaseKind === "VOUCHER" ? "Voucher" : c.isDuo ? "Duo" : "Private";
  return `${bonus === "BONUS_50" ? "Bonus 50" : "Bonus 100"} · ${childName(c)} (${what})`;
}

export const sourceRefOf = (bonus: "BONUS_50" | "BONUS_100", purchaseId: string, coachId: string): string => `${bonus === "BONUS_50" ? "b50" : "b100"}:${purchaseId}:${coachId}`;

/** base × a share fraction of 1 or 0.5, in exact integer satang. The bases are even, so 0.5 is exact; asserted anyway. */
export function shareSatang(base: number, fraction: 1 | 0.5): number {
  const v = fraction === 1 ? base : base / 2;
  if (!Number.isSafeInteger(v) || v <= 0) throw new Error(`a bonus share must be a positive integer of satang, got ${v}`);
  return v;
}

export interface PlanInput {
  candidates: BonusCandidates;
  /** teacherId → their slip in THIS period (absent ⇒ not in the run). */
  slipByTeacher: ReadonlyMap<string, { id: string; status: "draft" | "confirmed" | "locked" }>;
  profileByTeacher: ReadonlyMap<string, Profile>;
}

export interface Plan {
  /** The lines wanted on slips that can take them, in a stable order. */
  desired: DesiredLine[];
  skipped: SkippedShare[];
  unresolved: UnresolvedCandidate[];
  /** Every (slip, source_ref) a candidate of this run wants — also the ones skipped for a confirmed slip — used to tell orphans apart. */
  wantedKeys: Set<string>;
}

export const lineKey = (slipId: string, sourceRef: string): string => `${slipId}|${sourceRef}`;

/** Who gets which line, and why a case is not paid. PURE: no database, no clock. */
export function planBonusLines(input: PlanInput): Plan {
  const desired: DesiredLine[] = [];
  const skipped: SkippedShare[] = [];
  const unresolved: UnresolvedCandidate[] = [];
  const wantedKeys = new Set<string>();

  const place = (bonus: "BONUS_50" | "BONUS_100", purchaseId: string, coachId: string, date: string | null, label: string, amountSatang: number) => {
    const sourceRef = sourceRefOf(bonus, purchaseId, coachId);
    const skip = (reason: SkipReason) => skipped.push({ reason, bonus, purchaseId, coachId, date, sourceRef });
    // 1. eligibility first: an FL coach with no slip is NOT_ELIGIBLE, not "no slip"
    if (!isEligible(input.profileByTeacher.get(coachId), date)) return skip("NOT_ELIGIBLE");
    // 2. the slip
    const slip = input.slipByTeacher.get(coachId);
    if (!slip) return skip("SKIPPED_NO_SLIP");
    wantedKeys.add(lineKey(slip.id, sourceRef)); // wanted even when this slip cannot take it now (so an existing line is not called an orphan)
    if (slip.status === "locked") return skip("SKIPPED_LOCKED");
    if (slip.status === "confirmed") return skip("SKIPPED_CONFIRMED");
    desired.push({ slipId: slip.id, teacherId: coachId, sourceRef, label, amountSatang });
  };

  for (const c of input.candidates.bonus50 as Bonus50Candidate[]) {
    place("BONUS_50", c.purchaseId, c.coachId, c.trialDate, bonusLabel("BONUS_50", c), BONUS_50_SATANG);
  }
  for (const c of input.candidates.bonus100 as Bonus100Candidate[]) {
    if (c.status !== "RESOLVED") {
      unresolved.push({ bonus: "BONUS_100", purchaseId: c.purchaseId, status: c.status, childId: c.childId, prevId: c.prevId, firstCoachId: c.firstCoachId, latestCoachId: c.latestCoachId });
      continue;
    }
    for (const s of c.shares) {
      place("BONUS_100", c.purchaseId, s.coachId, c.prevFirstAttendedDate, bonusLabel("BONUS_100", c), shareSatang(BONUS_100_SATANG, s.fraction));
    }
  }
  return { desired, skipped, unresolved, wantedKeys };
}

/** Splits what we want against what is already there: unchanged · changed (same key, different money/label) · to write. Orphans = existing lines nothing wants. */
export function reconcile(plan: Plan, existing: readonly ExistingBonusLine[]): { toWrite: DesiredLine[]; unchanged: number; changed: ChangedLine[]; orphaned: OrphanedLine[] } {
  const have = new Map(existing.map((l) => [lineKey(l.slipId, l.sourceRef), l]));
  const toWrite: DesiredLine[] = [];
  const changed: ChangedLine[] = [];
  let unchanged = 0;
  for (const d of plan.desired) {
    const e = have.get(lineKey(d.slipId, d.sourceRef));
    if (!e) toWrite.push(d);
    else if (e.amountSatang === d.amountSatang && e.label === d.label) unchanged += 1;
    else changed.push({ slipId: d.slipId, sourceRef: d.sourceRef, existing: { label: e.label, amountSatang: e.amountSatang }, wanted: { label: d.label, amountSatang: d.amountSatang } });
  }
  const orphaned = existing
    .filter((l) => (l.sourceRef.startsWith("b50:") || l.sourceRef.startsWith("b100:")) && !plan.wantedKeys.has(lineKey(l.slipId, l.sourceRef)))
    .map((l): OrphanedLine => ({ ...l, note: "NO_LONGER_A_CANDIDATE" }));
  return { toWrite, unchanged, changed, orphaned };
}

// ───────────────────────────────── the line store ─────────────────────────────────
// A tiny store of its own, ON PURPOSE. `SalaryStore.insertLine` drops `source_ref` on the real database (its `.values()` has no
// `sourceRef`; the in-memory store keeps it), and `syncAutoLines` DELETES auto lines that are no longer derived — which this
// TASK forbids. So the bonus lines are written here, with `ON CONFLICT DO NOTHING` on migration 0011's partial unique index.

export interface BonusLineStore {
  /** The AUTO bonus lines (kind 'bonus', source 'auto') of these slips. */
  listAutoBonusLines(slipIds: readonly string[]): Promise<ExistingBonusLine[]>;
  /** Inserts one auto bonus line. `"exists"` when (slip, kind, source_ref) is already there — never an error. */
  insertAutoBonusLine(line: DesiredLine, actor: string): Promise<"written" | "exists">;
}

/** The real store. `exec` is the db or a transaction. */
export function dbBonusLineStore(exec: any = db): BonusLineStore {
  return {
    async listAutoBonusLines(slipIds) {
      if (!slipIds.length) return [];
      const rows: (typeof boPaySlipLine.$inferSelect)[] = await exec
        .select()
        .from(boPaySlipLine)
        .where(and(inArray(boPaySlipLine.slipId, [...slipIds]), eq(boPaySlipLine.kind, "bonus"), eq(boPaySlipLine.source, "auto")));
      return rows.filter((r) => r.sourceRef).map((r) => ({ slipId: r.slipId, sourceRef: r.sourceRef!, label: r.label, amountSatang: satangFromNumeric(r.amount) }));
    },
    async insertAutoBonusLine(l, actor) {
      const inserted: { id: string }[] = await exec
        .insert(boPaySlipLine)
        .values({ slipId: l.slipId, kind: "bonus", label: l.label, amount: numericFromSatang(l.amountSatang), source: "auto", sourceRef: l.sourceRef, createdBy: actor })
        // the partial unique index (slip_id, kind, source_ref) WHERE source = 'auto' (0011): a re-run, or a lost race, is a no-op
        .onConflictDoNothing({ target: [boPaySlipLine.slipId, boPaySlipLine.kind, boPaySlipLine.sourceRef], where: sql`${boPaySlipLine.source} = 'auto'` })
        .returning({ id: boPaySlipLine.id });
      return inserted.length ? "written" : "exists";
    },
  };
}

/** An in-memory store with the same uniqueness rule, for tests. */
export function memoryBonusLineStore(): BonusLineStore & { lines: ExistingBonusLine[]; actors: string[] } {
  const lines: ExistingBonusLine[] = [];
  const actors: string[] = [];
  return {
    lines,
    actors,
    async listAutoBonusLines(slipIds) {
      return lines.filter((l) => slipIds.includes(l.slipId)).map((l) => ({ ...l }));
    },
    async insertAutoBonusLine(l, actor) {
      if (lines.some((x) => x.slipId === l.slipId && x.sourceRef === l.sourceRef)) return "exists";
      lines.push({ slipId: l.slipId, sourceRef: l.sourceRef, label: l.label, amountSatang: l.amountSatang });
      actors.push(actor);
      return "written";
    },
  };
}

// ───────────────────────────────── the orchestrator ─────────────────────────────────

export interface BonusLinesDeps {
  /** Jason's service: `getPeriod` applies his LAZY 12:00 lock first, so the lock check is his, not a copy. */
  salary: Pick<SalaryService, "getPeriod">;
  /** The profiles (employment type, roles). */
  profiles: Pick<SalaryStore, "listProfiles">;
  lines: BonusLineStore;
  candidates: (month: string, rules: BonusRules) => Promise<BonusCandidates>;
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

/**
 * Applies the period's Bonus 50 / 100 candidates as auto lines. 404 for an unknown period (Jason's `getPeriod`); 409 `LOCKED`
 * for a locked one (SPEC-100 §4). The candidates are the PURCHASE-month's (the period's year and month), as the TASK says.
 * Not one database transaction: the stores have no unit of work; each line is atomic and the unique index makes a re-run finish
 * whatever a failure left undone.
 */
export async function applyBonusLines(periodId: string, rules: BonusRules, actor: string, deps: BonusLinesDeps): Promise<ApplyBonusResult> {
  const overview = await deps.salary.getPeriod(periodId); // lazy lock applied here; 404 if unknown
  if (overview.period.status === "locked") throw conflict("LOCKED", "งวดนี้ถูกล็อกแล้ว แก้ไขไม่ได้");

  const month = `${overview.period.year}-${pad2(overview.period.month)}`;
  const candidates = await deps.candidates(month, rules);
  const profiles = new Map((await deps.profiles.listProfiles()).map((p) => [p.teacherId, p]));
  const slipByTeacher = new Map(overview.slips.map((s) => [s.teacherId, { id: s.id, status: s.status }]));

  const plan = planBonusLines({ candidates, slipByTeacher, profileByTeacher: profiles });
  const existing = await deps.lines.listAutoBonusLines(overview.slips.map((s) => s.id));
  const { toWrite, unchanged, changed, orphaned } = reconcile(plan, existing);

  let written = 0;
  let raced = 0;
  for (const l of toWrite) {
    if ((await deps.lines.insertAutoBonusLine(l, actor)) === "written") written += 1;
    else raced += 1; // somebody wrote it between our read and our write: that is "unchanged", never a 500
  }
  return { written, unchanged: unchanged + raced, skipped: plan.skipped, unresolved: plan.unresolved, orphaned, changed };
}

/** The production wiring: the real candidates, the real profiles, the real line store. The route calls this. */
export function applyBonusLinesFor(salary: Pick<SalaryService, "getPeriod">, periodId: string, actor: string, rules: BonusRules = DEFAULT_RULES): Promise<ApplyBonusResult> {
  return applyBonusLines(periodId, rules, actor, { salary, profiles: dbSalaryStore, lines: dbBonusLineStore(), candidates: (m, r) => listBonusCandidates(m, r) });
}
