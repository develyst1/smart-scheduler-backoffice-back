// 🔻 TASK-887 (REQ-120 R1.5, SPEC-102 §5-E4) — the coach confirms their OWN slip (E4a), the CEO's "remind now" list + call (E4b), and the internal read the LINE reminders use (A). The logic lives HERE; `routes/salary.ts` carries one line each.
// 🔒 Auth is the route's (`requireRole`); everything below treats `teacherId` as what the TOKEN said and nothing else. No pay figure leaves this file except inside the coach's OWN slip DTO (E4a, their own data).
import { ApiException, badRequest, conflict } from "../lib/http";
import { payPeriodRange } from "../lib/pay-period";
import type { SalaryService } from "./salary.service";
import { dbSlipConfirmStore, type SlipConfirmStore } from "./slip-confirm.store";

type MySlip = Pick<SalaryService, "mySlip">;
type PeriodReads = Pick<SalaryService, "getPeriod" | "listEntriesPeople">;

const LOCKED_MSG = "This period is locked and cannot be edited"; // the same words as the pay run's own LOCKED
const NO_TEACHER_MSG = "This account has no coach salary slip"; // the same words as GET /salary/my-slip
const NO_SLIP_MSG = "No slip for this period";

// ───────────── the store a service is wired to (tests register an in-memory one; production = the db store) ─────────────
const stores = new WeakMap<object, SlipConfirmStore>();
export const useSlipConfirmStore = (service: object, store: SlipConfirmStore): void => void stores.set(service, store);
const storeFor = (service: object): SlipConfirmStore => stores.get(service) ?? dbSlipConfirmStore();

// ───────────── E4a: the coach confirm ─────────────
/**
 * `POST /salary/my-slip/confirm { year, month }`. The slip is resolved from the TOKEN's `teacherId` only (the body is `{ year, month }`: nothing else is read). The period is read through `service.mySlip` FIRST, which applies Jason's lazy 12:00
 * lock; then ONE conditional UPDATE does draft → confirmed. 0 rows moved ⇒ re-read: `confirmed` ⇒ 200 (idempotent) · `locked` ⇒ 409 LOCKED · gone ⇒ 404. This is what makes a lock racing a confirm safe.
 */
export async function confirmMySlipFor(service: MySlip, user: { teacherId?: string | null }, body: { year: number; month: number }, now: () => Date = () => new Date()) {
  const teacherId = user.teacherId;
  if (!teacherId) throw new ApiException(403, "NO_TEACHER", NO_TEACHER_MSG);
  const store = storeFor(service);
  const before = await service.mySlip(teacherId, body.year, body.month); // validates year / month (400) and applies the lazy lock
  if ("slip" in before) throw new ApiException(404, "NO_SLIP", NO_SLIP_MSG);
  if (before.status === "locked" || before.period.status === "locked") throw conflict("LOCKED", LOCKED_MSG);
  if (!(await store.confirmDraft(teacherId, body.year, body.month, now()))) {
    const now2 = await store.slipStatus(teacherId, body.year, body.month);
    if (now2 === null) throw new ApiException(404, "NO_SLIP", NO_SLIP_MSG);
    if (now2 === "locked") throw conflict("LOCKED", LOCKED_MSG);
    // "confirmed": somebody (this coach, a double click) got there first — idempotent
  }
  return service.mySlip(teacherId, body.year, body.month);
}

// ───────────── the unconfirmed list (E4b) ─────────────
export interface RemindTarget {
  teacherId: string;
  name: string;
  status: "draft" | "none";
}

/** Every ACTIVE profile (with a teacher row, never the system teacher: `listEntriesPeople`) whose slip in the period is `draft` or missing. `confirmed` / `locked` are out. Whitelist DTO: id, name, status — no pay. */
export async function listUnconfirmed(service: PeriodReads, periodId: string): Promise<RemindTarget[]> {
  const period = await service.getPeriod(periodId, { missingRates: false }); // 404 for an unknown period; the lazy lock applies; no hours are read
  const status = new Map<string, string>(period.slips.map((s: { teacherId: string; status: string }) => [s.teacherId, s.status]));
  const people = await service.listEntriesPeople();
  const out: RemindTarget[] = [];
  for (const p of people) {
    const st = status.get(p.teacherId);
    if (st === undefined) out.push({ teacherId: p.teacherId, name: p.name, status: "none" });
    else if (st === "draft") out.push({ teacherId: p.teacherId, name: p.name, status: "draft" });
  }
  return out;
}

// ───────────── A: the internal read the LINE reminders (smart-scheduler-back) use ─────────────
const isRealDate = (d: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  const t = new Date(`${d}T00:00:00Z`).getTime();
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === d; // 2026-13-01 is an Invalid Date (toISOString would THROW), 2026-02-30 rolls over
};

/**
 * `GET /api/v1/internal/salary/unconfirmed?date=YYYY-MM-DD` — the period whose R1.4 range contains `date` (`{ periodId, lockAt, teacherIds }`, `teacherIds` = DRAFT slips only, active, never the system teacher), or `{ periodId: null }`.
 * A malformed date is a 400. `none` coaches are NOT in `teacherIds` (they have no slip to confirm; LINE goes to draft slips only).
 */
export async function unconfirmedForDate(service: Pick<SalaryService, "listPeriods"> & PeriodReads, date: string) {
  if (!isRealDate(date)) throw badRequest("date must be a real date, YYYY-MM-DD");
  const periods = await service.listPeriods(); // each read applies the lazy lock
  // THE CONFIRM-DAY RULE (Silver's ruling, 2026-11-09, the amendment to contract A): 1) a period whose `lockAt`, as a BANGKOK date, IS `date` wins — the confirm day belongs to the period being confirmed (31 Oct ⇒ October, though 31 Oct is also the
  // FIRST day of November's range); 2) otherwise the period whose R1.4 range contains `date`; 3) none ⇒ `{ periodId: null }`.
  const bangkokDay = (iso: string): string => new Date(new Date(iso).getTime() + 7 * 3_600_000).toISOString().slice(0, 10);
  const hit =
    periods.find((p: { lockAt: string }) => bangkokDay(p.lockAt) === date) ??
    periods.find((p: { year: number; month: number; periodStart: string | null; periodEnd: string | null }) => {
      const r = p.periodStart && p.periodEnd ? { start: p.periodStart, end: p.periodEnd } : payPeriodRange(p.year, p.month);
      return date >= r.start && date <= r.end;
    });
  if (!hit) return { periodId: null };
  const targets = await listUnconfirmed(service, hit.id);
  return { periodId: hit.id, lockAt: hit.lockAt, teacherIds: targets.filter((t) => t.status === "draft").map((t) => t.teacherId).sort() }; // sorted: the same answer every call
}

// ───────────── B: E4b — the CEO list + the "remind now" call to smart-scheduler-back ─────────────
export type SendResult = "NOT_CONFIGURED" | "FAILED" | Record<string, unknown>;

/**
 * `POST {SCHEDULER_API_URL}/internal/salary-remind-now`, body `{ periodId }` ONLY, header `x-internal-secret`. Either env key unset ⇒ `"NOT_CONFIGURED"` and NO request. A 200 ⇒ SB's `NowResult` relayed AS IS. Any other status, a timeout (5 s),
 * a network error or a body that is not an object ⇒ `"FAILED"`. Never throws.
 */
export async function callRemindNow(periodId: string, env: Record<string, string | undefined> = process.env, fetchFn: typeof fetch = fetch): Promise<SendResult> {
  const base = env.SCHEDULER_API_URL?.trim().replace(/\/+$/, "");
  const secret = env.SCHEDULER_INTERNAL_SECRET?.trim();
  if (!base || !secret) return "NOT_CONFIGURED";
  try {
    const res = await fetchFn(`${base}/internal/salary-remind-now`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-secret": secret },
      body: JSON.stringify({ periodId }),
      signal: AbortSignal.timeout(5000),
    });
    if (res.status !== 200) return "FAILED";
    const body = (await res.json()) as unknown;
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : "FAILED";
  } catch {
    return "FAILED";
  }
}

/** `POST /salary/periods/:id/remind` (CEO): the unconfirmed list (names + draft / none, no pay) plus `send` — SB's result, or NOT_CONFIGURED / FAILED. Always a 200 once the period exists. */
export async function remindPeriodFor(service: PeriodReads, periodId: string, env: Record<string, string | undefined> = process.env, fetchFn: typeof fetch = fetch) {
  const targets = await listUnconfirmed(service, periodId); // 404 first: nothing is sent for a period that does not exist
  const send = await callRemindNow(periodId, env, fetchFn);
  return { targets, send };
}

