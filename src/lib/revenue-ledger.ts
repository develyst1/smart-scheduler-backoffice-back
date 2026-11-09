// SPEC-098 §2–§3 / TASK-858 — the revenue ledger's pure logic: code lists, the category seed, date windows, the
// summary Block, and the sign rule. No DB, no clock, no I/O — so every edge is a unit test.

/** The 8 revenue types, in SPEC-098 §2's order (the final UI prints them in this order). REFUND is NOT one of them. */
export const REVENUE_TYPES = ["COURSE", "TRIAL", "VOUCHER", "ECA", "SALES", "FNB", "RENT", "OTHER"] as const;
export type RevenueType = (typeof REVENUE_TYPES)[number];

/** A line's type: the 8 revenue types plus REFUND (a negative line, R2.3). */
export const LINE_TYPES = [...REVENUE_TYPES, "REFUND"] as const;
export type LineType = (typeof LINE_TYPES)[number];

export const BRANCHES = ["BRAVO", "OTHER"] as const;
export type Branch = (typeof BRANCHES)[number];

export const METHODS = ["TRANSFER", "CASH", "CARD"] as const;
export type Method = (typeof METHODS)[number];

// ── The category seed (SPEC-098 §2: exactly the final UI's v3 tree, `b-revenue.ts` REV_CATS_BY_TYPE) ──────────────
const SPORTS = ["Inline Skate", "Surfskate", "Skateboard", "Bike", "Balance Play", "Onewheel", "Freeskate", "Scooter"];
const COURSE_SUBS = ["Private", "Duo", "1 HR"];

export const CATEGORY_SEED: Record<RevenueType, string[]> = {
  COURSE: [...SPORTS.flatMap((s) => COURSE_SUBS.map((c) => `${s} · ${c}`)), "Balance Camp", "Birthday"],
  TRIAL: SPORTS.map((s) => `1st Trial (${s})`),
  VOUCHER: ["5 Hr", "10 Hr", "15 Hr"],
  ECA: ["STA", "RIS", "ABC", "ISB", "KIS"],
  SALES: ["Miller", "Inline Skate", "Bike", "Safety"],
  FNB: ["Drink", "Snack"],
  RENT: ["EQUIPMENT", "PARK"],
  OTHER: ["Shirt", "Sock", "Bag"],
};

/** The seed as flat rows, sort_order counting 0, 1, 2… within each type, types in §2's order. */
export function categorySeedRows(): { type: RevenueType; name: string; sortOrder: number }[] {
  return REVENUE_TYPES.flatMap((type) => CATEGORY_SEED[type].map((name, sortOrder) => ({ type, name, sortOrder })));
}

// ── The sign rule (the DB's `revenue_line_sign_ck`, mirrored so a bad value is a 400 and never a 500) ──────────────
/** REFUND must be < 0; every other type must be > 0. Amounts are integer satang. */
export function signOk(type: LineType, amountMinor: number): boolean {
  if (!Number.isInteger(amountMinor)) return false;
  return type === "REFUND" ? amountMinor < 0 : amountMinor > 0;
}

// ── Calendar dates: `YYYY-MM-DD` strings, no time zone, no `Date` local-time surprises ─────────────────────────────
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True only for a real calendar date (rejects 2026-02-30, 2026-13-01, "2026-1-1"). */
export function isValidDate(s: string): boolean {
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

const toDays = (s: string): number => {
  const m = DATE_RE.exec(s)!;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86_400_000;
};

/** Whole days from `from` to `to` (`to - from`). Both must be valid dates. */
export function daysBetween(from: string, to: string): number {
  return toDays(to) - toDays(from);
}

/** The longest `from`…`to` span `GET /lines` accepts: 366 days apart (SPEC-098 §3). */
export const MAX_RANGE_DAYS = 366;

export type DateWindow = { from: string; to: string };

/** Today = that date; MTD = the 1st of its month → date; YTD = 1 Jan → date (inclusive on both ends). */
export function summaryWindows(date: string): { today: DateWindow; mtd: DateWindow; ytd: DateWindow } {
  const [y, m] = date.split("-");
  return {
    today: { from: date, to: date },
    mtd: { from: `${y}-${m}-01`, to: date },
    ytd: { from: `${y}-01-01`, to: date },
  };
}

// ── The summary Block (SPEC-098 §3) ──────────────────────────────────────────────────────────────────────────────────
export type Block = {
  rows: { type: RevenueType; amountMinor: number }[];
  totalMinor: number;
  refundsMinor: number;
};

/**
 * Builds a Block from per-type sums. All 8 revenue types are always present, zero-filled, in §2's order.
 * `totalMinor` is the sum of those rows — refunds EXCLUDED, as the final UI's total is; `refundsMinor` is the REFUND
 * sum (≤ 0). A type this module does not know is ignored rather than guessed into a bucket.
 */
export function buildBlock(sums: { type: string; amountMinor: number }[]): Block {
  const byType = new Map<string, number>();
  for (const s of sums) byType.set(s.type, (byType.get(s.type) ?? 0) + s.amountMinor);
  const rows = REVENUE_TYPES.map((type) => ({ type, amountMinor: byType.get(type) ?? 0 }));
  return {
    rows,
    totalMinor: rows.reduce((a, r) => a + r.amountMinor, 0),
    refundsMinor: byType.get("REFUND") ?? 0,
  };
}

// ───────────────────────────────── the ECA payment entry (TASK-890, REQ-120 §2 R2.2) ─────────────────────────────────
// "per term: price per class × students × classes per term (ฟีน enters). It counts on the date the school pays." One entry = ONE
// revenue line. Money is integer satang; the column is a 32-bit int, so a total over that is refused, never wrapped.

/** The largest value of `bo.revenue_line.amount_minor` (a Postgres `integer`). */
export const INT32_MAX = 2_147_483_647;
/** The term's length: "Term 2", "2026 Term 1"… */
export const ECA_TERM_MAX = 40;

const isPosInt = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n > 0;

/** price per class × students × classes per term, in satang; `null` when any factor is not a positive integer or the total does not fit 32 bits. */
export function ecaAmountMinor(pricePerClassMinor: number, students: number, classesPerTerm: number): number | null {
  if (!isPosInt(pricePerClassMinor) || !isPosInt(students) || !isPosInt(classesPerTerm)) return null;
  const total = pricePerClassMinor * students * classesPerTerm;
  return total <= INT32_MAX ? total : null; // every factor is a positive safe integer, so a product past 2^53 is also past INT32_MAX: no separate "safe" check is needed
}

/** satang → the baht text: `150000` → "1500", `15050` → "150.50" (whole baht when it is whole; never a float). */
export function bahtText(minor: number): string {
  const whole = Math.floor(minor / 100);
  const frac = minor % 100;
  return frac === 0 ? String(whole) : `${whole}.${String(frac).padStart(2, "0")}`;
}

/** The line's remark: `<price> ฿ × <students> students × <classes> classes` (R2.2's three factors, readable on the history). */
export function ecaRemark(pricePerClassMinor: number, students: number, classesPerTerm: number): string {
  return `${bahtText(pricePerClassMinor)} ฿ × ${students} students × ${classesPerTerm} classes`;
}

// ───────────────────────────────── the refund (SPEC-099 §10, TASK-893) ─────────────────────────────────
// A refund is ONE negative REFUND line (R2.3: an expense in the month of the refund), keyed so a sale is refunded once. The sources list
// is the CEO's picker: the latest courses and vouchers matching a student, each with what a refund would cancel.

/** The idempotency key of a sale's refund line: `rl:refund:course:<id>` / `rl:refund:voucher:<id>` (the type in lower case, as `rl:course:<id>`). */
export const refundKeyFor = (refType: PaymentRefType, refId: string): string => `rl:refund:${refType.toLowerCase()}:${refId}`;

/** The line's amount: a refund is an EXPENSE, so the stored amount is negative (`revenue_line_sign_ck`: REFUND < 0). */
export const refundAmountMinor = (amountMinor: number): number => -amountMinor;

/** 0 < amount <= fee, both whole satang. `false` for a non-integer, zero, negative, or an amount over the fee. */
export const refundWithinFee = (amountMinor: number, feeMinor: number): boolean =>
  Number.isInteger(amountMinor) && amountMinor > 0 && amountMinor <= feeMinor;

/** SQL `LIKE` metacharacters in the CEO's search text are literals: `50%` finds "50%", not everything. */
export const escapeLike = (q: string): string => q.replace(/[\\%_]/g, (c) => `\\${c}`);

/** The most sources one search returns. */
export const REFUND_SOURCES_LIMIT = 20;

/** Statuses that count as a lesson held (the SB course set: ATTENDED, NO_SHOW) and as still to come (PENDING, CONFIRMED, EXTENDED = `COURSE_LIVE`). */
const DELIVERED = new Set(["ATTENDED", "NO_SHOW"]);
const LIVE = new Set(["PENDING", "CONFIRMED", "EXTENDED"]);

/** One plan's sessions → the two numbers the picker shows. `attended` = held; `toCancel` = what `endCourse` / `endVoucher` would cancel (live, and for a voucher dated today or later; none once ended). */
export function sessionCounts(
  refType: PaymentRefType,
  sessions: readonly { status: string; date: string }[],
  today: string,
  ended: boolean,
): { attended: number; toCancel: number } {
  const attended = sessions.filter((s) => DELIVERED.has(s.status)).length;
  if (ended) return { attended, toCancel: 0 };
  const toCancel = sessions.filter((s) => LIVE.has(s.status) && (refType === "COURSE" || s.date >= today)).length;
  return { attended, toCancel };
}

/** `<child> · Course 10` / `<child> · Voucher 5 Hr`: the child's nickname, else name. */
export function planLabel(refType: PaymentRefType, child: { nickname: string | null; name: string } | null, size: number): string {
  const who = child ? (child.nickname?.trim() ? child.nickname.trim() : child.name.trim()) : "";
  const what = refType === "COURSE" ? `Course ${size}` : `Voucher ${size} Hr`;
  return who ? `${who} · ${what}` : what;
}

/** The Asia/Bangkok calendar date of an instant (UTC+7, no DST). */
export const bangkokDate = (ts: Date | string): string => new Date(new Date(ts).getTime() + 7 * 3_600_000).toISOString().slice(0, 10);

// ───────────────────────────────── the F2 payment record (SPEC-099 §8, TASK-874) ─────────────────────────────────
// Pure rules. The service reads and writes; every decision lives here so it is a unit test.

/** Slice 2a covers courses and vouchers only. The DB also allows BOOKING · CAMP · RENTAL for later slices. */
export const PAYMENT_REF_TYPES = ["COURSE", "VOUCHER"] as const;
export type PaymentRefType = (typeof PAYMENT_REF_TYPES)[number];

/**
 * The idempotency keys a sale's money was posted under in `bo.movement` (`createCoursePackage` / `createVoucher` +
 * their discount): the sale and the discount. The TASK-864 course rule, read here and never guessed.
 */
export function feeKeys(refType: PaymentRefType, refId: string): { sale: string; discount: string } {
  return { sale: `${refType === "COURSE" ? "course-sale" : "voucher-sale"}:${refId}`, discount: `discount:${refId}` };
}

/**
 * THE FEE = the sale's net = the sale movement + the (negative) discount movement. `null` when the sale movement is not
 * there (a sale whose movements did not post): then there is no fee to split and the API refuses a new installment.
 */
export function feeFromMovements(refType: PaymentRefType, refId: string, rows: readonly { key: string | null; valueMinor: number }[]): number | null {
  const k = feeKeys(refType, refId);
  if (!rows.some((r) => r.key === k.sale)) return null;
  return rows.filter((r) => r.key === k.sale || r.key === k.discount).reduce((n, r) => n + r.valueMinor, 0);
}

/** The key of the revenue line a payment's METHOD follows (TASK-864 writes `rl:course:<id>` / `rl:voucher:<id>`). */
export const revenueLineKeyFor = (refType: PaymentRefType, refId: string): string => `rl:${refType.toLowerCase()}:${refId}`;

/**
 * SPEC-099 §8.4: only an edit of row 1's METHOD moves the revenue line's method. Installments (n >= 2) never touch it
 * (the whole amount counts at confirm), and amount / date edits never do either.
 */
export const followsRevenueLine = (n: number, patch: { method?: string }): boolean => n === 1 && patch.method !== undefined;

/** SPEC-099 §8.9: the installments SPLIT the fee, so their sum may never exceed it. `fee` is the sale's net (satang). */
export const installmentsFit = (feeMinor: number, rowsMinor: readonly number[]): boolean => rowsMinor.reduce((a, b) => a + b, 0) <= feeMinor;

/** `paid` = the sum of the rows; `remaining` = fee − paid (null with no fee: the card shows the rows only). */
export function paymentTotals(feeMinor: number | null, rowsMinor: readonly number[]): { feeMinor: number | null; paidMinor: number; remainingMinor: number | null } {
  const paidMinor = rowsMinor.reduce((a, b) => a + b, 0);
  return { feeMinor, paidMinor, remainingMinor: feeMinor === null ? null : feeMinor - paidMinor };
}
