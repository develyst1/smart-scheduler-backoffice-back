// SPEC-002 / TASK-005: effective-dated recurring FT/PT salary + the shared month-start job
// (freelance budget reset + salary materialize). Reuses the P&L path — a FIXED_COST OUT movement
// lands in costMinor / byType[FIXED_COST]. Past months stay frozen: materialize reads the row in
// effect *for the target month*, never a single mutable "current salary".

import { and, desc, eq, gte, isNull, lte, or, sql } from "drizzle-orm";
import { db } from "../db";
import { toRecurringCostDTO } from "../db/mappers";
import { catalogItems, parties, recurringCosts, stockBalances } from "../db/schema";
import { applyStockMovement, resolveOrganization } from "./inventory.service";
import { monthFirstDay, prevMonthFirstDay } from "../lib/month";
import type {
  MaterializeResult,
  MonthStartResult,
  SetRecurringCostRequest,
} from "../types/contract";

const SCHEDULING_SOURCE = "smart-scheduler";

export async function listRecurringCosts(filter: {
  orgCode?: string;
  externalSource?: string;
  externalRef?: string;
} = {}) {
  const org = await resolveOrganization(filter.orgCode);
  const conds = [eq(recurringCosts.organizationId, org.id)];
  if (filter.externalSource) conds.push(eq(catalogItems.externalSource, filter.externalSource));
  if (filter.externalRef) conds.push(eq(catalogItems.externalRef, filter.externalRef));

  const rows = await db
    .select({ rc: recurringCosts, item: catalogItems })
    .from(recurringCosts)
    .innerJoin(catalogItems, eq(catalogItems.id, recurringCosts.itemId))
    .where(and(...conds))
    .orderBy(catalogItems.externalRef, desc(recurringCosts.effectiveFrom));

  return rows.map((r) => toRecurringCostDTO(r.rc, r.item));
}

/** Set/change a teacher's monthly salary. First set creates the FIXED_COST posting item; a later
 *  change supersedes the prior open row (effective_to = month before the new effective_from) and
 *  inserts the new row → past months stay frozen. */
export async function setRecurringCost(input: SetRecurringCostRequest, orgCode?: string) {
  const org = await resolveOrganization(orgCode);
  const teacherId = input.externalRef;
  const effFrom = monthFirstDay(input.effectiveFrom);

  return await db.transaction(async (tx) => {
    let item = await tx.query.catalogItems.findFirst({
      where: and(
        eq(catalogItems.organizationId, org.id),
        eq(catalogItems.externalSource, SCHEDULING_SOURCE),
        eq(catalogItems.externalRef, teacherId),
        eq(catalogItems.itemType, "FIXED_COST"),
      ),
    });
    if (!item) {
      const [created] = await tx
        .insert(catalogItems)
        .values({
          organizationId: org.id,
          sku: `salary-${teacherId}`,
          name: input.label ?? `Salary ${teacherId}`,
          unit: "month",
          itemGroup: "SERVICE",
          itemType: "FIXED_COST",
          salePriceMinor: input.amountMinor,
          trackStock: false, // P&L posting only, no balance to draw down
          externalSource: SCHEDULING_SOURCE,
          externalRef: teacherId,
          metadata: { kind: "FTPT_SALARY", teacherType: input.teacherType ?? null },
        })
        .returning();
      item = created;
      await tx.insert(stockBalances).values({ itemId: item.id, quantityOnHand: 0 });
    }

    // Close the prior open row (if any) the month before the new one takes effect.
    await tx
      .update(recurringCosts)
      .set({ effectiveTo: prevMonthFirstDay(input.effectiveFrom) })
      .where(
        and(
          eq(recurringCosts.itemId, item.id),
          eq(recurringCosts.active, true),
          isNull(recurringCosts.effectiveTo),
        ),
      );

    // Best-effort link to an ops party for the teacher (the item is the real anchor).
    const party = await tx.query.parties.findFirst({
      where: and(
        eq(parties.organizationId, org.id),
        eq(parties.externalSource, SCHEDULING_SOURCE),
        eq(parties.externalRef, teacherId),
      ),
    });

    const [row] = await tx
      .insert(recurringCosts)
      .values({
        organizationId: org.id,
        partyId: party?.id ?? null,
        itemId: item.id,
        label: input.label ?? null,
        amountMinor: input.amountMinor,
        effectiveFrom: effFrom,
        effectiveTo: null,
        active: true,
        metadata: { teacherType: input.teacherType ?? null },
      })
      .returning();

    return toRecurringCostDTO(row, item);
  });
}

/** Teacher-sync (TASK-015): stop a teacher's salary — set `effective_to` on their **open** recurring
 *  row WITHOUT inserting a successor (the missing "terminate" path; `setRecurringCost` only supersedes).
 *  No-op if the teacher has no FIXED_COST item or no open row. Returns whether a row was closed. */
export async function terminateRecurring(
  externalRef: string,
  effectiveTo: string,
  orgCode?: string,
): Promise<boolean> {
  const org = await resolveOrganization(orgCode);
  const item = await db.query.catalogItems.findFirst({
    where: and(
      eq(catalogItems.organizationId, org.id),
      eq(catalogItems.externalSource, SCHEDULING_SOURCE),
      eq(catalogItems.externalRef, externalRef),
      eq(catalogItems.itemType, "FIXED_COST"),
    ),
  });
  if (!item) return false;

  const closed = await db
    .update(recurringCosts)
    .set({ effectiveTo })
    .where(
      and(
        eq(recurringCosts.itemId, item.id),
        eq(recurringCosts.active, true),
        isNull(recurringCosts.effectiveTo),
      ),
    )
    .returning();
  return closed.length > 0;
}

/** Post one FIXED_COST movement per teacher for `month`, using the salary in effect *that* month.
 *  Idempotent per teacher-month (`salary:<teacherId>:<month>`) → safe to re-run. */
export async function materializeRecurring(
  month: string,
  orgCode?: string,
): Promise<MaterializeResult> {
  const org = await resolveOrganization(orgCode);
  const d = monthFirstDay(month);

  const rows = await db
    .select({ rc: recurringCosts, item: catalogItems })
    .from(recurringCosts)
    .innerJoin(catalogItems, eq(catalogItems.id, recurringCosts.itemId))
    .where(
      and(
        eq(recurringCosts.organizationId, org.id),
        eq(recurringCosts.active, true),
        lte(recurringCosts.effectiveFrom, d),
        or(isNull(recurringCosts.effectiveTo), gte(recurringCosts.effectiveTo, d)),
      ),
    );

  const posted: MaterializeResult["posted"] = [];
  for (const { rc, item } of rows) {
    const mv = await applyStockMovement(rc.itemId, {
      direction: "OUT",
      quantity: rc.amountMinor > 0 ? rc.amountMinor : 1, // placeholder; value carried by amountMinor
      amountMinor: rc.amountMinor,
      reason: `salary ${month}`,
      refType: "SALARY",
      refId: month,
      idempotencyKey: `salary:${item.externalRef}:${month}`,
    });
    posted.push({
      externalRef: item.externalRef,
      itemId: rc.itemId,
      amountMinor: rc.amountMinor,
      movementId: mv.id,
    });
  }
  return { month, posted };
}

/** Shared month-start job (SPEC-001 reset + SPEC-002 materialize). Idempotent per month.
 *  (a) Reset every freelance budget to its configured amount (top-ups cleared, overwrite semantics).
 *  (b) Materialize FT/PT salaries for the new month. */
export async function runMonthStart(month: string, orgCode?: string): Promise<MonthStartResult> {
  const org = await resolveOrganization(orgCode);

  // (a) Freelance budget reset — ADJUST each FREELANCE_BUDGET item to its monthlyBudgetMinor.
  const budgetItems = await db.query.catalogItems.findMany({
    where: and(
      eq(catalogItems.organizationId, org.id),
      eq(catalogItems.externalSource, SCHEDULING_SOURCE),
      eq(catalogItems.itemType, "EXPENSE"),
      eq(catalogItems.active, true),
      sql`${catalogItems.metadata}->>'kind' = 'FREELANCE_BUDGET'`,
    ),
  });

  let freelanceReset = 0;
  for (const item of budgetItems) {
    const budget = item.metadata?.monthlyBudgetMinor;
    if (typeof budget !== "number") continue;
    // TASK-001 review: ADJUST needs a positive `quantity` placeholder + explicit amountMinor:0 so
    // the ledger figure stays honest and the reset is P&L-neutral.
    await applyStockMovement(item.id, {
      direction: "ADJUST",
      quantity: budget > 0 ? budget : 1,
      amountMinor: 0,
      reason: `=${budget}`,
      refType: "RESET",
      refId: month,
      idempotencyKey: `fl-reset:${item.externalRef}:${month}`,
    });
    freelanceReset++;
  }

  // (b) Salary materialize for the new month.
  const materialized = await materializeRecurring(month, orgCode);

  return { month, freelanceReset, salariesPosted: materialized.posted.length };
}
