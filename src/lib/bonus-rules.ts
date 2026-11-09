// TASK-863 (REQ-120 R1.2 · §9 C-e · §9.4 · DECISIONS row 12) — Bonus 50 / Bonus 100 CANDIDATES for a month: the rules,
// PURE. No database, no clock, no I/O, no imports: every rule is a function of plain rows, so each is a unit test and
// each OPEN ruling is a switch (`BonusRules`), not a code path.
//
//   • Bonus 50  — a 1st Trial, then a course OR a voucher, no time limit; goes to the TRIAL's coach (one coach, C-e);
//                 across sports counts (4A).
//   • Bonus 100 — a renewal goes to the OLD entitlement's first coach; across sports counts (4A). Voucher → voucher is
//                 NEVER a renewal. After a whole-course coach change the admin's `bonus100_pick` decides who.
//   • The month a bonus falls in = the month of the PURCHASE's `created_at`, in Bangkok time (R0-11: counted when its
//     trigger happens).
//
// This reader returns FACTS plus the dates eligibility needs. It writes nothing, pays nothing, and does NOT filter by
// teacher type (FT / PT-day eligibility is the pay-line TASK's, on Team A's F3 types).

/** The open rulings, switchable by design. Defaults are the team's current readings; each flip is one line. */
export interface BonusRules {
  /** The Salary go-live day (Bangkok `YYYY-MM-DD`). `null` = no cut-off. Cut-off checks apply ONLY when set. */
  goLiveDate: string | null;
  /** A trial dated before go-live still pays Bonus 50 if the purchase is after. Default false (readiness S13: both ends after go-live). */
  bonus50TrialBeforeGoLive: boolean;
  /** Bonus 100's 1A / 1B (Khwan, still open). true = 1A (an old course before go-live still earns it; the team's recommendation). false = 1B. */
  bonus100OldCourseBeforeGoLive: boolean;
  /** A10: course → voucher or voucher → course counts as a renewal. Default false (course → course only; flip on her word). */
  renewalAcrossCourseVoucher: boolean;
}

export const DEFAULT_RULES: Readonly<BonusRules> = Object.freeze({
  goLiveDate: null,
  bonus50TrialBeforeGoLive: false,
  bonus100OldCourseBeforeGoLive: true,
  renewalAcrossCourseVoucher: false,
});

export type PurchaseKind = "COURSE" | "VOUCHER";
export type SharePick = "FIRST" | "LATEST" | "SHARE";
export type ShareStatus = "RESOLVED" | "UNRESOLVED" | "NO_FIRST_COACH";

export interface ChildRef {
  id: string;
  name: string;
  nickname: string | null;
}

/** The 1st Trial a purchase converted (`from_trial_booking_id`), with its coach. */
export interface TrialRef {
  bookingId: string;
  /** The trial's calendar date (`YYYY-MM-DD`). */
  date: string;
  subject: string | null;
  coachId: string;
  /** `teachers.is_system` ("No Teacher", TASK-861). The loader sets it; a system teacher is never a bonus coach. */
  coachIsSystem?: boolean;
}

/** The child's previous entitlement (`prev_course_id` / `prev_voucher_id`), with the facts the shares need. */
export interface PrevRef {
  kind: PurchaseKind;
  id: string;
  createdAt: Date | string;
  firstTeacherId: string | null;
  latestTeacherId: string | null;
  coachChangedAt: Date | string | null;
  bonus100Pick: string | null;
  /** The previous entitlement's first ATTENDED session date (eligibility's PT-day check needs it). */
  firstAttendedDate: string | null;
  /** `teachers.is_system` of the first / latest coach (set by the loader). A system teacher is never paid. */
  firstTeacherIsSystem?: boolean;
  latestTeacherIsSystem?: boolean;
}

/** One sold course or voucher, with everything the rules look at. */
export interface PurchaseRow {
  kind: PurchaseKind;
  id: string;
  createdAt: Date | string;
  isDuo: boolean;
  child: ChildRef;
  trial: TrialRef | null;
  prev: PrevRef | null;
}

export interface Bonus50Candidate {
  purchaseKind: PurchaseKind;
  purchaseId: string;
  /** The purchase's Bangkok calendar date. */
  date: string;
  isDuo: boolean;
  childId: string;
  childName: string;
  childNickname: string | null;
  trialBookingId: string;
  /** The trial's date, kept so a later go-live switch flip needs no new read. */
  trialDate: string;
  trialSubject: string | null;
  coachId: string;
}

export interface CoachShare {
  coachId: string;
  fraction: 1 | 0.5;
}

export interface Bonus100Candidate {
  purchaseKind: PurchaseKind;
  purchaseId: string;
  date: string;
  isDuo: boolean;
  childId: string;
  childName: string;
  childNickname: string | null;
  prevKind: PurchaseKind;
  prevId: string;
  /** The previous entitlement's Bangkok creation date (the 1A / 1B switch tests it). */
  prevDate: string;
  firstCoachId: string | null;
  latestCoachId: string | null;
  /** The admin's pick, only when it is a valid one. */
  pick: SharePick | null;
  status: ShareStatus;
  /** Empty when `UNRESOLVED` or `NO_FIRST_COACH`: listed, never dropped, never guessed. */
  shares: CoachShare[];
  prevFirstAttendedDate: string | null;
}

// ───────────────────────────────── Bangkok dates and months ─────────────────────────────────
// Asia/Bangkok is a fixed UTC+7 with no daylight saving, so the conversion is an offset, not a time-zone library.
const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000;

/** The Bangkok calendar date (`YYYY-MM-DD`) of an instant (a `Date`, an ISO timestamp, or a plain date, which parses as UTC midnight = 07:00 Bangkok, the same day). */
export function bangkokDateOf(ts: Date | string): string {
  const t = new Date(ts).getTime();
  if (Number.isNaN(t)) throw new Error(`not a date: ${String(ts)}`);
  return new Date(t + BANGKOK_OFFSET_MS).toISOString().slice(0, 10);
}

/** The Bangkok month (`YYYY-MM`) of an instant. */
export const bangkokMonthOf = (ts: Date | string): string => bangkokDateOf(ts).slice(0, 7);

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** `[start, end)` as instants for a Bangkok month: from 00:00 on the 1st (UTC+7) to 00:00 on the 1st of the next month. */
export function monthWindow(month: string): { start: Date; end: Date } {
  const m = MONTH_RE.exec(month);
  if (!m) throw new Error(`month must be YYYY-MM, got ${String(month)}`);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const next = mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, "0")}`;
  return { start: new Date(`${month}-01T00:00:00+07:00`), end: new Date(`${next}-01T00:00:00+07:00`) };
}

// ───────────────────────────────── the coach shares ─────────────────────────────────

/**
 * Who a Bonus 100 goes to, from the OLD entitlement.
 *  - never attended (`first_teacher_id` NULL) → `NO_FIRST_COACH`, empty shares: listed, not dropped.
 *  - no whole-course coach change, or `latest = first` (treated as no change) → the first coach, 1.0.
 *  - a change: the admin's pick decides — FIRST → first 1.0 · LATEST → latest 1.0 · SHARE → 0.5 each · no (valid) pick
 *    yet → `UNRESOLVED`, empty shares.
 * A voucher has no change / pick columns, so it always reads as "no change".
 */
export function resolveCoachShares(prev: Pick<PrevRef, "firstTeacherId" | "latestTeacherId" | "coachChangedAt" | "bonus100Pick">): {
  status: ShareStatus;
  pick: SharePick | null;
  shares: CoachShare[];
} {
  const first = prev.firstTeacherId;
  if (!first) return { status: "NO_FIRST_COACH", pick: null, shares: [] };
  const latest = prev.latestTeacherId;
  const changed = !!prev.coachChangedAt && !!latest && latest !== first;
  if (!changed) return { status: "RESOLVED", pick: null, shares: [{ coachId: first, fraction: 1 }] };
  // Only the three picks the DB's CHECK allows resolve a change; anything else (none, or a stray value) is UNRESOLVED.
  const pick = prev.bonus100Pick;
  if (pick === "FIRST") return { status: "RESOLVED", pick, shares: [{ coachId: first, fraction: 1 }] };
  if (pick === "LATEST") return { status: "RESOLVED", pick, shares: [{ coachId: latest!, fraction: 1 }] };
  if (pick === "SHARE")
    return {
      status: "RESOLVED",
      pick,
      shares: [
        { coachId: first, fraction: 0.5 },
        { coachId: latest!, fraction: 0.5 },
      ],
    };
  return { status: "UNRESOLVED", pick: null, shares: [] };
}

// ───────────────────────────────── the candidates ─────────────────────────────────

/**
 * Is `kind` bought after `prevKind` a RENEWAL? Voucher → voucher is NEVER one (her "Renewal Voucher" label is only a
 * label: the prototype row read "Not a renewal"). Course → course always is. A mixed pair is one only under A10.
 */
export function isRenewalPair(kind: PurchaseKind, prevKind: PurchaseKind, rules: BonusRules): boolean {
  if (kind === "VOUCHER" && prevKind === "VOUCHER") return false;
  if (kind === "COURSE" && prevKind === "COURSE") return true;
  return rules.renewalAcrossCourseVoucher;
}

const byDateThenId = (a: { date: string; purchaseId: string }, b: { date: string; purchaseId: string }): number =>
  a.date < b.date ? -1 : a.date > b.date ? 1 : a.purchaseId < b.purchaseId ? -1 : a.purchaseId > b.purchaseId ? 1 : 0;

// 🔻 TASK-867 rework (DECISIONS row 18, R1.4): a candidate window is EITHER a Bangkok month (`YYYY-MM`, the TASK-863 form,
// kept for old callers) OR an inclusive Bangkok DATE range `{ from, to }` — the pay period `periodStart..periodEnd`.
export type DateRange = { from: string; to: string };
export type BonusWindow = string | DateRange;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isRealDate = (s: string): boolean => DATE_RE.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

/** `[start, end)` as instants for either form. Throws on a bad month, a bad date, or `from > to`. */
export function windowBounds(w: BonusWindow): { start: Date; end: Date } {
  if (typeof w === "string") return monthWindow(w);
  if (!w || !isRealDate(w.from) || !isRealDate(w.to)) throw new Error(`range must be { from, to } as YYYY-MM-DD, got ${JSON.stringify(w)}`);
  if (w.from > w.to) throw new Error(`range from ${w.from} is after to ${w.to}`);
  const next = new Date(new Date(`${w.to}T00:00:00Z`).getTime() + 86_400_000).toISOString().slice(0, 10);
  return { start: new Date(`${w.from}T00:00:00+07:00`), end: new Date(`${next}T00:00:00+07:00`) };
}

const inWindow = (createdAt: Date | string, w: BonusWindow | undefined): boolean => {
  if (w === undefined) return true;
  if (typeof w === "string") return bangkokMonthOf(createdAt) === w;
  const d = bangkokDateOf(createdAt);
  return d >= w.from && d <= w.to;
};

/**
 * Bonus 50 candidates: a purchase that converted a 1st Trial. Goes to the trial's coach.
 * With a go-live date set: the purchase must be on or after it, and a trial before it only counts when
 * `bonus50TrialBeforeGoLive` is on. Pass `month` (`YYYY-MM`, Bangkok) to keep only that month's purchases.
 */
export function bonus50Candidates(rows: readonly PurchaseRow[], rules: BonusRules = DEFAULT_RULES, month?: BonusWindow): Bonus50Candidate[] {
  const out: Bonus50Candidate[] = [];
  for (const r of rows) {
    if (!r.trial) continue;
    // The system teacher ("No Teacher", `is_system`) only ever sits on park-fee OTHER blocks, never on a trial; this makes
    // that impossible BY CONSTRUCTION: a trial coached by it is not a candidate (relayed rule, Silver via Porter).
    if (r.trial.coachIsSystem) continue;
    if (!inWindow(r.createdAt, month)) continue;
    const date = bangkokDateOf(r.createdAt);
    if (rules.goLiveDate) {
      if (date < rules.goLiveDate) continue;
      if (r.trial.date < rules.goLiveDate && !rules.bonus50TrialBeforeGoLive) continue;
    }
    out.push({
      purchaseKind: r.kind,
      purchaseId: r.id,
      date,
      isDuo: r.isDuo,
      childId: r.child.id,
      childName: r.child.name,
      childNickname: r.child.nickname,
      trialBookingId: r.trial.bookingId,
      trialDate: r.trial.date,
      trialSubject: r.trial.subject,
      coachId: r.trial.coachId,
    });
  }
  return out.sort(byDateThenId);
}

/**
 * Bonus 100 candidates: a renewal (see `isRenewalPair`). Goes to the OLD entitlement's first coach (`resolveCoachShares`).
 * With a go-live date set: the renewal must be on or after it, and an old entitlement from before it only counts when
 * `bonus100OldCourseBeforeGoLive` is on (1A) — off is 1B.
 */
export function bonus100Candidates(rows: readonly PurchaseRow[], rules: BonusRules = DEFAULT_RULES, month?: BonusWindow): Bonus100Candidate[] {
  const out: Bonus100Candidate[] = [];
  for (const r of rows) {
    const prev = r.prev;
    if (!prev) continue;
    if (!inWindow(r.createdAt, month)) continue;
    if (!isRenewalPair(r.kind, prev.kind, rules)) continue;
    const date = bangkokDateOf(r.createdAt);
    const prevDate = bangkokDateOf(prev.createdAt);
    if (rules.goLiveDate) {
      if (date < rules.goLiveDate) continue;
      if (prevDate < rules.goLiveDate && !rules.bonus100OldCourseBeforeGoLive) continue;
    }
    const s = resolveCoachShares(prev);
    // The system teacher is not a person to pay. An old entitlement whose FIRST coach is it, or whose resolved shares would
    // pay it (a whole-course change to it picked as LATEST / SHARE), is not a candidate. Impossible by construction.
    if (prev.firstTeacherIsSystem) continue;
    if (prev.latestTeacherIsSystem && s.shares.some((x) => x.coachId === prev.latestTeacherId)) continue;
    out.push({
      purchaseKind: r.kind,
      purchaseId: r.id,
      date,
      isDuo: r.isDuo,
      childId: r.child.id,
      childName: r.child.name,
      childNickname: r.child.nickname,
      prevKind: prev.kind,
      prevId: prev.id,
      prevDate,
      firstCoachId: prev.firstTeacherId,
      latestCoachId: prev.latestTeacherId,
      pick: s.pick,
      status: s.status,
      shares: s.shares,
      prevFirstAttendedDate: prev.firstAttendedDate,
    });
  }
  return out.sort(byDateThenId);
}
