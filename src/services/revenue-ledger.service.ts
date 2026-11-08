// SPEC-098 §3 / TASK-858 — the revenue ledger's reads and writes. (`revenue.service.ts` is the OLD REQ-014 report
// and is not touched.) Aggregation happens in SQL; nothing loads a year into memory.
import { and, asc, desc, eq, gte, inArray, lte, ne, sql } from "drizzle-orm";
import { db } from "../db";
import { boMovement } from "../db/schema";
import { boPayment, boRevenueCategory, boRevenueLine } from "../db/schema-revenue";
import { badRequest, conflict, notFound, pgErrorCode } from "../lib/http";
import {
  buildBlock,
  feeFromMovements,
  feeKeys,
  followsRevenueLine,
  installmentsFit,
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

export async function listLines(f: {
  from: string;
  to: string;
  branch?: string;
  type?: string;
  categoryId?: string;
}) {
  // ONE filter for the list and the totals, so the totals are always the sum of exactly the lines returned.
  const where = and(
    gte(boRevenueLine.occurredOn, f.from),
    lte(boRevenueLine.occurredOn, f.to),
    f.branch ? eq(boRevenueLine.branch, f.branch) : undefined,
    f.type ? eq(boRevenueLine.type, f.type) : undefined,
    f.categoryId ? eq(boRevenueLine.categoryId, f.categoryId) : undefined,
  );
  const [rows, [agg]] = await Promise.all([
    db
      .select({ line: boRevenueLine, categoryName: boRevenueCategory.name })
      .from(boRevenueLine)
      .leftJoin(boRevenueCategory, eq(boRevenueLine.categoryId, boRevenueCategory.id))
      .where(where)
      .orderBy(desc(boRevenueLine.occurredOn), desc(boRevenueLine.createdAt)),
    // SPEC-098 §3 (changed 2026-11-08): revenueMinor = non-REFUND lines, refundsMinor = REFUND lines (≤ 0), summed in SQL.
    // sum() over zero rows is NULL, hence coalesce; sum(integer) is bigint → string from postgres-js.
    db
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
    lines: rows.map((r) => toLineDTO(r.line, r.categoryName)),
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
