// SPEC-098 §3 / TASK-858 — the revenue ledger's reads and writes. (`revenue.service.ts` is the OLD REQ-014 report
// and is not touched.) Aggregation happens in SQL; nothing loads a year into memory.
import { and, asc, desc, eq, gte, ilike, inArray, lte, ne, or, sql } from "drizzle-orm";
import { db } from "../db";
import { boMovement } from "../db/schema";
import { boPayment, boRevenueCategory, boRevenueLine } from "../db/schema-revenue";
import { ttBookings, ttCoursePackages, ttStudents, ttVouchers } from "../db/pub-timetable"; // 🔻 TASK-893 (read-only `public`)
import { callRefundCancel } from "./refund-cancel-client"; // 🔻 TASK-893
import { ApiException, badRequest, conflict, notFound, pgErrorCode } from "../lib/http";
import {
  bangkokDate,
  buildBlock,
  ECA_TERM_MAX,
  ecaAmountMinor,
  ecaRemark,
  feeFromMovements,
  escapeLike,
  feeKeys,
  followsRevenueLine,
  installmentsFit,
  planLabel,
  refundAmountMinor,
  refundKeyFor,
  REFUND_SOURCES_LIMIT,
  refundWithinFee,
  sessionCounts,
  paymentTotals,
  REVENUE_TYPES,
  revenueLineKeyFor,
  summaryWindows,
  type Block,
  type DateWindow,
  type PaymentRefType,
  type RevenueType,
} from "../lib/revenue-ledger";

export type CategoryDTO = { id: string; type: string; name: string; sortOrder: number; active: boolean };
export type RevenueLineDTO = {
  id: string;
  occurredOn: string;
  branch: string;
  type: string;
  categoryId: string | null;
  categoryName: string | null;
  productName: string;
  amountMinor: number;
  method: string;
  remark: string | null;
  source: string;
  createdAt: string;
};

const toCategoryDTO = (r: typeof boRevenueCategory.$inferSelect): CategoryDTO => ({
  id: r.id,
  type: r.type,
  name: r.name,
  sortOrder: r.sortOrder,
  active: r.active,
});

const toLineDTO = (
  r: typeof boRevenueLine.$inferSelect,
  categoryName: string | null,
): RevenueLineDTO => ({
  id: r.id,
  occurredOn: r.occurredOn,
  branch: r.branch,
  type: r.type,
  categoryId: r.categoryId,
  categoryName,
  productName: r.productName,
  amountMinor: r.amountMinor,
  method: r.method,
  remark: r.remark,
  source: r.source,
  createdAt: r.createdAt.toISOString(),
});

// Ordered by type in SPEC-098 §2's order (not alphabetically), then sortOrder, then name.
const typeRank = sql`array_position(${sql.raw(`ARRAY[${REVENUE_TYPES.map((t) => `'${t}'`).join(",")}]::text[]`)}, ${boRevenueCategory.type})`;

export async function listCategories(opts: { type?: RevenueType; includeInactive?: boolean }) {
  const where = and(
    opts.type ? eq(boRevenueCategory.type, opts.type) : undefined,
    opts.includeInactive ? undefined : eq(boRevenueCategory.active, true),
  );
  const rows = await db
    .select()
    .from(boRevenueCategory)
    .where(where)
    .orderBy(asc(typeRank), asc(boRevenueCategory.sortOrder), asc(boRevenueCategory.name));
  return rows.map(toCategoryDTO);
}

export async function createCategory(input: { type: RevenueType; name: string }) {
  // Next slot inside the type, so a new category lands last in its list.
  const [{ next }] = await db
    .select({ next: sql<number>`coalesce(max(${boRevenueCategory.sortOrder}), -1) + 1` })
    .from(boRevenueCategory)
    .where(eq(boRevenueCategory.type, input.type));
  try {
    const [row] = await db
      .insert(boRevenueCategory)
      .values({ type: input.type, name: input.name, sortOrder: Number(next) })
      .returning();
    return toCategoryDTO(row);
  } catch (e) {
    // The unique index on (type, lower(name)) is the arbiter — never a check-then-insert race.
    if (pgErrorCode(e) === "23505") throw conflict("CONFLICT", "มีหมวดนี้อยู่แล้วในประเภทเดียวกัน");
    throw e;
  }
}

export async function createManualLine(
  input: {
    occurredOn: string;
    branch: "BRAVO" | "OTHER";
    type: RevenueType;
    categoryId: string;
    productName?: string;
    amountMinor: number;
    method: "TRANSFER" | "CASH" | "CARD";
    remark?: string;
  },
  actor: string | null,
): Promise<RevenueLineDTO> {
  const [cat] = await db.select().from(boRevenueCategory).where(eq(boRevenueCategory.id, input.categoryId)).limit(1);
  if (!cat || !cat.active) throw badRequest("categoryId is unknown or inactive", { field: "categoryId" });
  if (cat.type !== input.type) throw badRequest("categoryId does not belong to this type", { field: "categoryId" });
  const [row] = await db
    .insert(boRevenueLine)
    .values({
      occurredOn: input.occurredOn,
      branch: input.branch,
      type: input.type,
      categoryId: cat.id,
      productName: input.productName?.trim() ? input.productName.trim() : cat.name,
      amountMinor: input.amountMinor,
      method: input.method,
      remark: input.remark ?? null,
      source: "MANUAL",
      actor,
    })
    .returning();
  return toLineDTO(row, cat.name);
}

/**
 * TASK-890 (R2.2) — ONE ECA payment = ONE revenue line: `type ECA`, the school (an ECA category) as its category, the TERM as the product
 * name, `price × students × classes` as the amount, counted on the day the school PAID. A manual entry (`idempotency_key` NULL, like
 * `createManualLine`); `source = 'ECA'`. `d` is injectable only so the rules are testable without a connection.
 */
export async function createEcaPayment(
  input: {
    categoryId: string;
    term: string;
    pricePerClassMinor: number;
    students: number;
    classesPerTerm: number;
    paidOn: string;
    branch: "BRAVO" | "OTHER";
    method: "TRANSFER" | "CASH" | "CARD";
  },
  actor: string | null,
  d: any = db,
): Promise<RevenueLineDTO> {
  const term = input.term.trim();
  if (!term || term.length > ECA_TERM_MAX) throw badRequest(`term must be 1–${ECA_TERM_MAX} characters`, { field: "term" });
  const [cat] = await d.select().from(boRevenueCategory).where(eq(boRevenueCategory.id, input.categoryId)).limit(1);
  if (!cat || !cat.active) throw badRequest("categoryId is unknown or inactive", { field: "categoryId" });
  if (cat.type !== "ECA") throw badRequest("categoryId is not an ECA school", { field: "categoryId" });
  const amountMinor = ecaAmountMinor(input.pricePerClassMinor, input.students, input.classesPerTerm);
  if (amountMinor === null) throw badRequest("the total (price × students × classes) is too large", { field: "amount" });
  const [row] = await d
    .insert(boRevenueLine)
    .values({
      occurredOn: input.paidOn,
      branch: input.branch,
      type: "ECA",
      categoryId: cat.id,
      productName: term,
      amountMinor,
      method: input.method,
      remark: ecaRemark(input.pricePerClassMinor, input.students, input.classesPerTerm),
      source: "ECA",
      idempotencyKey: null,
      actor,
    })
    .returning();
  return toLineDTO(row, cat.name);
}

export async function listLines(f: {
  from: string;
  to: string;
  branch?: string;
  type?: string;
  categoryId?: string;
}, d: any = db /* TASK-890: injectable so a rolled-back proof can read back its own uncommitted line */) {
  // ONE filter for the list and the totals, so the totals are always the sum of exactly the lines returned.
  const where = and(
    gte(boRevenueLine.occurredOn, f.from),
    lte(boRevenueLine.occurredOn, f.to),
    f.branch ? eq(boRevenueLine.branch, f.branch) : undefined,
    f.type ? eq(boRevenueLine.type, f.type) : undefined,
    f.categoryId ? eq(boRevenueLine.categoryId, f.categoryId) : undefined,
  );
  const [rows, [agg]] = await Promise.all([
    d
      .select({ line: boRevenueLine, categoryName: boRevenueCategory.name })
      .from(boRevenueLine)
      .leftJoin(boRevenueCategory, eq(boRevenueLine.categoryId, boRevenueCategory.id))
      .where(where)
      .orderBy(desc(boRevenueLine.occurredOn), desc(boRevenueLine.createdAt)),
    // SPEC-098 §3 (changed 2026-11-08): revenueMinor = non-REFUND lines, refundsMinor = REFUND lines (≤ 0), summed in SQL.
    // sum() over zero rows is NULL, hence coalesce; sum(integer) is bigint → string from postgres-js.
    d
      .select({
        revenue: sql<string>`coalesce(sum(${boRevenueLine.amountMinor}) filter (where ${boRevenueLine.type} <> 'REFUND'), 0)`,
        refunds: sql<string>`coalesce(sum(${boRevenueLine.amountMinor}) filter (where ${boRevenueLine.type} = 'REFUND'), 0)`,
      })
      .from(boRevenueLine)
      .where(where),
  ]);
  const revenueMinor = Number(agg?.revenue ?? 0);
  const refundsMinor = Number(agg?.refunds ?? 0);
  // totalMinor = revenueMinor + refundsMinor: the sum of the returned lines, refunds included.
  return {
    lines: rows.map((r: { line: typeof boRevenueLine.$inferSelect; categoryName: string | null }) => toLineDTO(r.line, r.categoryName)),
    totalMinor: revenueMinor + refundsMinor,
    revenueMinor,
    refundsMinor,
  };
}

async function sumWindow(w: DateWindow, branch?: string): Promise<Block> {
  const rows = await db
    .select({ type: boRevenueLine.type, total: sql<string>`sum(${boRevenueLine.amountMinor})` })
    .from(boRevenueLine)
    .where(
      and(
        gte(boRevenueLine.occurredOn, w.from),
        lte(boRevenueLine.occurredOn, w.to),
        branch ? eq(boRevenueLine.branch, branch) : undefined,
      ),
    )
    .groupBy(boRevenueLine.type);
  // sum(integer) is bigint → a string from postgres-js; Number() is exact at satang scale.
  return buildBlock(rows.map((r) => ({ type: r.type, amountMinor: Number(r.total) })));
}

export async function summary(date: string, branch?: string) {
  const w = summaryWindows(date);
  const [today, mtd, ytd] = await Promise.all([
    sumWindow(w.today, branch),
    sumWindow(w.mtd, branch),
    sumWindow(w.ytd, branch),
  ]);
  return { date, today, mtd, ytd };
}

// ───────────────────────────────── the F2 payment record (SPEC-099 §8, TASK-874) ─────────────────────────────────
// `d` is the db (or a fake in tests). Every write runs in ONE transaction under a per-reference advisory lock, so two
// concurrent adds cannot take the same `n` and the "installments <= fee" check cannot race; the unique index
// `bo_payment_ref_n_uq` is the backstop (a collision maps to 409). The responses carry payment rows ONLY — never a
// revenue-line figure — because an admin may call these (R0.2).

export type PaymentDTO = {
  id: string;
  refType: string;
  refId: string;
  n: number;
  paidOn: string;
  amountMinor: number;
  method: string;
  updatedAt: string;
};

const toPaymentDTO = (r: typeof boPayment.$inferSelect): PaymentDTO => ({
  id: r.id,
  refType: r.refType,
  refId: r.refId,
  n: r.n,
  paidOn: r.paidOn,
  amountMinor: r.amountMinor,
  method: r.method,
  updatedAt: r.updatedAt.toISOString(),
});

/** The fee of a sale: its posted sale movement + discount movement (`feeFromMovements`); null when the sale did not post. */
async function feeOf(d: any, refType: PaymentRefType, refId: string): Promise<number | null> {
  const k = feeKeys(refType, refId);
  const rows: { key: string | null; valueMinor: number }[] = await d
    .select({ key: boMovement.idempotencyKey, valueMinor: boMovement.valueMinor })
    .from(boMovement)
    .where(inArray(boMovement.idempotencyKey, [k.sale, k.discount]));
  return feeFromMovements(refType, refId, rows);
}

/** Serialises everything that touches one sale's payments. Released when the transaction ends. */
async function lockRef(tx: any, refType: string, refId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`payment:${refType}:${refId}`}))`);
}

const overFee = (refType: string) => badRequest(`the installments add up to more than the ${refType === "VOUCHER" ? "voucher" : "course"} fee`);

/** `GET`: the rows ordered by n, plus the fee, what is paid and what remains (the screen shows these, it sums nothing). */
export async function listPayments(refType: PaymentRefType, refId: string, d: any = db) {
  const rows: (typeof boPayment.$inferSelect)[] = await d
    .select()
    .from(boPayment)
    .where(and(eq(boPayment.refType, refType), eq(boPayment.refId, refId)))
    .orderBy(asc(boPayment.n));
  const fee = await feeOf(d, refType, refId);
  return { payments: rows.map(toPaymentDTO), ...paymentTotals(fee, rows.map((r) => r.amountMinor)) };
}

/** `POST`: row `n = max + 1` for the sale. No fee → 409 `NO_FEE`; sum over the fee → 400; a lost race on `n` → 409. */
export async function createPayment(
  input: { refType: PaymentRefType; refId: string; paidOn: string; amountMinor: number; method: "TRANSFER" | "CASH" | "CARD" },
  actor: string | null,
  d: any = db,
): Promise<PaymentDTO> {
  return d.transaction(async (tx: any) => {
    await lockRef(tx, input.refType, input.refId);
    const fee = await feeOf(tx, input.refType, input.refId);
    if (fee === null) throw conflict("NO_FEE", "this sale has no posted fee, so there is nothing to split into installments");
    const rows: { n: number; amountMinor: number }[] = await tx
      .select({ n: boPayment.n, amountMinor: boPayment.amountMinor })
      .from(boPayment)
      .where(and(eq(boPayment.refType, input.refType), eq(boPayment.refId, input.refId)));
    if (!installmentsFit(fee, [...rows.map((r) => r.amountMinor), input.amountMinor])) throw overFee(input.refType);
    const n = Math.max(0, ...rows.map((r) => r.n)) + 1;
    try {
      const [row] = await tx
        .insert(boPayment)
        .values({ refType: input.refType, refId: input.refId, n, paidOn: input.paidOn, amountMinor: input.amountMinor, method: input.method, actor })
        .returning();
      return toPaymentDTO(row);
    } catch (e) {
      if (pgErrorCode(e) === "23505") throw conflict("CONFLICT", "another payment took this installment number; try again");
      throw e;
    }
  });
}

/**
 * `PATCH`: any of method / paidOn / amountMinor (every row's amount is editable since §8.9, row 1 included).
 *  - an amount change must keep sum(rows) <= fee (400), and needs a fee (409 `NO_FEE`);
 *  - §8.4: an edit of ROW 1's method also sets the matching `bo.revenue_line.method` IN THE SAME TRANSACTION. No line yet
 *    (not confirmed) → only the payment changes. Installments never touch the line.
 */
export async function updatePayment(
  id: string,
  patch: { method?: "TRANSFER" | "CASH" | "CARD"; paidOn?: string; amountMinor?: number },
  actor: string | null,
  d: any = db,
): Promise<PaymentDTO> {
  return d.transaction(async (tx: any) => {
    const [found] = await tx.select().from(boPayment).where(eq(boPayment.id, id)).limit(1);
    if (!found) throw notFound("payment not found");
    await lockRef(tx, found.refType, found.refId);
    // re-read under the lock: another writer may have changed it between the first read and the lock
    const [cur] = await tx.select().from(boPayment).where(eq(boPayment.id, id)).limit(1);
    if (!cur) throw notFound("payment not found");

    if (patch.amountMinor !== undefined) {
      const fee = await feeOf(tx, cur.refType as PaymentRefType, cur.refId);
      if (fee === null) throw conflict("NO_FEE", "this sale has no posted fee, so an amount cannot be checked against it");
      const others: { amountMinor: number }[] = await tx
        .select({ amountMinor: boPayment.amountMinor })
        .from(boPayment)
        .where(and(eq(boPayment.refType, cur.refType), eq(boPayment.refId, cur.refId), ne(boPayment.id, cur.id)));
      if (!installmentsFit(fee, [...others.map((r) => r.amountMinor), patch.amountMinor])) throw overFee(cur.refType);
    }

    const [row] = await tx
      .update(boPayment)
      .set({
        ...(patch.method !== undefined ? { method: patch.method } : {}),
        ...(patch.paidOn !== undefined ? { paidOn: patch.paidOn } : {}),
        ...(patch.amountMinor !== undefined ? { amountMinor: patch.amountMinor } : {}),
        actor,
        updatedAt: new Date(),
      })
      .where(eq(boPayment.id, id))
      .returning();

    if (followsRevenueLine(cur.n, patch)) {
      await tx
        .update(boRevenueLine)
        .set({ method: patch.method })
        .where(eq(boRevenueLine.idempotencyKey, revenueLineKeyFor(cur.refType as PaymentRefType, cur.refId)));
    }
    return toPaymentDTO(row);
  });
}

// ───────────────────────────────── the refund (SPEC-099 §10, TASK-893) ─────────────────────────────────

export type RefundSourceDTO = {
  refType: PaymentRefType;
  refId: string;
  label: string;
  /** The Asia/Bangkok date it was sold. */
  soldOn: string;
  /** The sale's net (the TASK-874 fee); `null` when no sale movement was posted (such a plan cannot be refunded here: NO_FEE). */
  feeMinor: number | null;
  attended: number;
  toCancel: number;
  refunded: boolean;
};

/**
 * `GET /refunds/sources?q=`: up to 20 of the latest courses and vouchers whose student's nickname or name contains `q` (case-insensitive;
 * LIKE characters in `q` are literals; empty `q` = the latest). Personal data stays inside this CEO-only route. `d` / `today` are injectable for tests.
 */
export async function listRefundSources(q: string, d: any = db, today: string = bangkokDate(new Date())): Promise<{ sources: RefundSourceDTO[] }> {
  const text = q.trim();
  const like = `%${escapeLike(text)}%`;
  const match = text ? or(ilike(ttStudents.name, like), ilike(ttStudents.nickname, like)) : undefined;
  const [courses, vouchers]: [any[], any[]] = await Promise.all([
    d
      .select({ id: ttCoursePackages.id, size: ttCoursePackages.size, createdAt: ttCoursePackages.createdAt, endedAt: ttCoursePackages.endedAt, nickname: ttStudents.nickname, name: ttStudents.name })
      .from(ttCoursePackages)
      .leftJoin(ttStudents, eq(ttCoursePackages.studentId, ttStudents.id))
      .where(match)
      .orderBy(desc(ttCoursePackages.createdAt))
      .limit(REFUND_SOURCES_LIMIT),
    d
      .select({ id: ttVouchers.id, size: ttVouchers.totalHours, createdAt: ttVouchers.createdAt, endedAt: ttVouchers.endedAt, nickname: ttStudents.nickname, name: ttStudents.name })
      .from(ttVouchers)
      .leftJoin(ttStudents, eq(ttVouchers.studentId, ttStudents.id))
      .where(match)
      .orderBy(desc(ttVouchers.createdAt))
      .limit(REFUND_SOURCES_LIMIT),
  ]);
  const plans = [
    ...courses.map((r) => ({ refType: "COURSE" as const, ...r })),
    ...vouchers.map((r) => ({ refType: "VOUCHER" as const, ...r })),
  ]
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, REFUND_SOURCES_LIMIT);
  if (!plans.length) return { sources: [] };

  const courseIds = plans.filter((p) => p.refType === "COURSE").map((p) => p.id);
  const voucherIds = plans.filter((p) => p.refType === "VOUCHER").map((p) => p.id);
  const [sessions, movements, refundedRows]: [any[], any[], any[]] = await Promise.all([
    d
      .select({ courseId: ttBookings.courseId, voucherId: ttBookings.voucherId, status: ttBookings.status, date: ttBookings.date })
      .from(ttBookings)
      .where(or(courseIds.length ? inArray(ttBookings.courseId, courseIds) : undefined, voucherIds.length ? inArray(ttBookings.voucherId, voucherIds) : undefined)),
    d
      .select({ key: boMovement.idempotencyKey, valueMinor: boMovement.valueMinor })
      .from(boMovement)
      .where(inArray(boMovement.idempotencyKey, plans.flatMap((p) => Object.values(feeKeys(p.refType, p.id))))),
    d
      .select({ key: boRevenueLine.idempotencyKey })
      .from(boRevenueLine)
      .where(inArray(boRevenueLine.idempotencyKey, plans.map((p) => refundKeyFor(p.refType, p.id)))),
  ]);
  const refunded = new Set(refundedRows.map((r) => r.key));
  return {
    sources: plans.map((p) => {
      const mine = sessions.filter((s) => (p.refType === "COURSE" ? s.courseId : s.voucherId) === p.id);
      return {
        refType: p.refType,
        refId: p.id,
        label: planLabel(p.refType, p.name ? { nickname: p.nickname, name: p.name } : null, p.size),
        soldOn: bangkokDate(p.createdAt),
        feeMinor: feeFromMovements(p.refType, p.id, movements),
        ...sessionCounts(p.refType, mine, today, !!p.endedAt),
        refunded: refunded.has(refundKeyFor(p.refType, p.id)),
      };
    }),
  };
}

/**
 * `POST /refunds`, in THIS order (a failure at a step writes nothing at the later ones):
 *   1. the plan exists (404) · 2. it has a fee (409 NO_FEE) and `0 < amount <= fee` (400) · 3. not refunded yet (409 ALREADY_REFUNDED)
 *   4. SB cancels the plan (`NOT_CONFIGURED` → 503, an SB failure / timeout → 502; nothing written) · 5. ONE REFUND line.
 * A retry after a crash between 4 and 5 is safe: SB answers `alreadyCancelled`, and the line's key (`rl:refund:<type>:<id>`) makes it once. Two requests at
 * once: both pass 3, both call SB (idempotent), ONE inserts and the other gets 409 from the key.
 */
export async function createRefund(
  input: { refType: PaymentRefType; refId: string; refundedOn: string; amountMinor: number; method: "TRANSFER" | "CASH" | "CARD"; remark?: string },
  actor: string | null,
  deps: { d?: any; cancel?: typeof callRefundCancel } = {},
): Promise<{ line: RevenueLineDTO; cancelledSessions: number }> {
  const d = deps.d ?? db;
  const cancel = deps.cancel ?? callRefundCancel;

  // 1. the plan (its label goes on the line; an id that is not a plan is a 404, not a fee question)
  const planTable = input.refType === "COURSE" ? ttCoursePackages : ttVouchers;
  const sizeCol = input.refType === "COURSE" ? ttCoursePackages.size : ttVouchers.totalHours;
  const [plan] = await d
    .select({ id: planTable.id, size: sizeCol, nickname: ttStudents.nickname, name: ttStudents.name })
    .from(planTable)
    .leftJoin(ttStudents, eq(planTable.studentId, ttStudents.id))
    .where(eq(planTable.id, input.refId))
    .limit(1);
  if (!plan) throw notFound(input.refType === "COURSE" ? "course not found" : "voucher not found");

  // 2. the fee and the amount
  const fee = await feeOf(d, input.refType, input.refId);
  if (fee === null) throw conflict("NO_FEE", "this sale has no posted fee, so there is nothing to refund against");
  if (!refundWithinFee(input.amountMinor, fee)) throw badRequest(`amountMinor must be between 1 and the sale's fee (${fee})`, { field: "amountMinor" });

  // 3. once per sale
  const key = refundKeyFor(input.refType, input.refId);
  const [already] = await d.select({ id: boRevenueLine.id }).from(boRevenueLine).where(eq(boRevenueLine.idempotencyKey, key)).limit(1);
  if (already) throw conflict("ALREADY_REFUNDED", "this sale was already refunded");

  // 4. the scheduling side cancels the plan
  const sb = await cancel({ refType: input.refType, refId: input.refId, actor });
  if (sb === "NOT_CONFIGURED") throw new ApiException(503, "NOT_CONFIGURED", "the scheduling API is not configured (SCHEDULER_API_URL / SCHEDULER_INTERNAL_SECRET); nothing was refunded");
  if (sb === "FAILED") throw new ApiException(502, "SCHEDULER_FAILED", "the scheduling API did not cancel the plan; nothing was refunded");

  // 5. the line. It carries the branch of the sale's own line (F1), BRAVO when that line is not there.
  const [sale] = await d.select({ branch: boRevenueLine.branch }).from(boRevenueLine).where(eq(boRevenueLine.idempotencyKey, revenueLineKeyFor(input.refType, input.refId))).limit(1);
  const rows = await d
    .insert(boRevenueLine)
    .values({
      occurredOn: input.refundedOn,
      branch: sale?.branch === "OTHER" ? "OTHER" : "BRAVO",
      type: "REFUND",
      categoryId: null,
      productName: `Refund: ${planLabel(input.refType, plan.name ? { nickname: plan.nickname, name: plan.name } : null, plan.size)}`,
      amountMinor: refundAmountMinor(input.amountMinor),
      method: input.method,
      remark: input.remark?.trim() ? input.remark.trim() : null,
      source: "REFUND",
      refType: input.refType,
      refId: input.refId,
      idempotencyKey: key,
      actor,
    })
    .onConflictDoNothing({ target: boRevenueLine.idempotencyKey })
    .returning();
  if (!rows.length) throw conflict("ALREADY_REFUNDED", "this sale was already refunded");
  return { line: toLineDTO(rows[0], null), cancelledSessions: sb.cancelledSessions };
}
