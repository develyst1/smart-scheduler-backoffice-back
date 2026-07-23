// REQ-006 / TASK-022: universal item + movement + P&L on the `bo` schema. No org, no roles.
import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import { db } from "../db";
import { boItem, boMovement } from "../db/schema";
import { toBoItemDTO, toBoMovementDTO } from "../db/mappers";
import { badRequest, conflict, notFound } from "../lib/http";
import { computeRemainingAfter, foldPL, movementValueMinor, type PLItemRow } from "../lib/bo-money";

type Direction = "INCOME" | "EXPENSE";
type Cadence = "VARIABLE" | "FIXED_MONTHLY" | "FIXED_DAILY" | "FIXED_QUARTERLY";

export async function listItems(filter: {
  direction?: Direction;
  cadence?: Cadence;
  active?: boolean;
  tagValueId?: string;
} = {}) {
  const conds = [];
  if (filter.direction) conds.push(eq(boItem.direction, filter.direction));
  if (filter.cadence) conds.push(eq(boItem.cadence, filter.cadence));
  if (filter.active !== undefined) conds.push(eq(boItem.active, filter.active));

  const rows = await db.query.boItem.findMany({
    where: conds.length ? and(...conds) : undefined,
    with: { itemTags: true },
    orderBy: (t, { asc }) => asc(t.name),
  });
  const filtered = filter.tagValueId
    ? rows.filter((r) => r.itemTags.some((t) => t.tagValueId === filter.tagValueId))
    : rows;
  return filtered.map((r) => toBoItemDTO(r, r.itemTags.map((t) => t.tagValueId)));
}

export async function getItem(id: string) {
  const row = await db.query.boItem.findFirst({
    where: eq(boItem.id, id),
    with: { itemTags: true },
  });
  if (!row) throw notFound("ไม่พบ item");
  return toBoItemDTO(row, row.itemTags.map((t) => t.tagValueId));
}

export async function createItem(input: {
  name: string;
  unit?: string;
  direction: Direction;
  cadence?: Cadence;
  unitPriceMinor?: number;
  ceilingQty?: number | null;
  ownerRef?: string;
  externalSource?: string;
  metadata?: Record<string, unknown>;
}) {
  const [row] = await db
    .insert(boItem)
    .values({
      name: input.name,
      unit: input.unit ?? "each",
      direction: input.direction,
      cadence: input.cadence ?? "VARIABLE",
      unitPriceMinor: input.unitPriceMinor ?? 0,
      ceilingQty: input.ceilingQty ?? null,
      // On create with a ceiling, start remaining = ceiling.
      remainingQty: input.ceilingQty ?? null,
      ownerRef: input.ownerRef ?? null,
      externalSource: input.externalSource ?? null,
      metadata: input.metadata ?? null,
    })
    .returning();
  return toBoItemDTO(row);
}

/** Partial edit. `direction` and `unit` are fixed after create (design). Editing `ceilingQty` does not
 *  retroactively change `remainingQty` — use a movement/reset for that. */
export async function updateItem(
  id: string,
  input: {
    name?: string;
    unitPriceMinor?: number;
    ceilingQty?: number | null;
    cadence?: Cadence;
    active?: boolean;
    metadata?: Record<string, unknown>;
  },
) {
  const existing = await db.query.boItem.findFirst({ where: eq(boItem.id, id) });
  if (!existing) throw notFound("ไม่พบ item");

  const patch: Partial<typeof boItem.$inferInsert> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.unitPriceMinor !== undefined) patch.unitPriceMinor = input.unitPriceMinor;
  if (input.ceilingQty !== undefined) patch.ceilingQty = input.ceilingQty;
  if (input.cadence !== undefined) patch.cadence = input.cadence;
  if (input.active !== undefined) patch.active = input.active;
  if (input.metadata !== undefined)
    patch.metadata = { ...(existing.metadata ?? {}), ...input.metadata };

  if (Object.keys(patch).length > 0) {
    await db.update(boItem).set(patch).where(eq(boItem.id, id));
  }
  return getItem(id); // includes tagValueIds
}

export async function applyMovement(
  itemId: string,
  input: {
    qty: number;
    reason?: string;
    refType?: string;
    refId?: string;
    idempotencyKey?: string;
    allowNegative?: boolean;
  },
) {
  if (input.qty === 0) throw badRequest("qty ต้องไม่เป็นศูนย์");

  if (input.idempotencyKey) {
    const dup = await db.query.boMovement.findFirst({
      where: eq(boMovement.idempotencyKey, input.idempotencyKey),
    });
    if (dup) return toBoMovementDTO(dup);
  }

  return await db.transaction(async (tx) => {
    const item = await tx.query.boItem.findFirst({ where: eq(boItem.id, itemId) });
    if (!item) throw notFound("ไม่พบ item");

    const valueMinor = movementValueMinor(input.qty, item.unitPriceMinor);
    let remainingAfter: number | null = null;

    // Only ceiling-tracked items (remaining_qty not null) draw down + guard.
    if (item.remainingQty !== null) {
      const res = computeRemainingAfter(item.remainingQty, input.qty, input.allowNegative ?? false);
      if (res.blocked) throw conflict("CEILING_EXCEEDED", "เกินเพดานที่ตั้งไว้ของรายการนี้");
      remainingAfter = res.remainingAfter;
      await tx.update(boItem).set({ remainingQty: remainingAfter }).where(eq(boItem.id, itemId));
    }

    const [mv] = await tx
      .insert(boMovement)
      .values({
        itemId,
        qty: input.qty,
        remainingAfter,
        valueMinor,
        reason: input.reason ?? null,
        refType: input.refType ?? null,
        refId: input.refId ?? null,
        idempotencyKey: input.idempotencyKey ?? null,
      })
      .returning();
    return toBoMovementDTO(mv);
  });
}

export async function listMovements(itemId: string, limit: number) {
  const rows = await db.query.boMovement.findMany({
    where: eq(boMovement.itemId, itemId),
    orderBy: [desc(boMovement.createdAt)],
    limit,
  });
  return rows.map(toBoMovementDTO);
}

function currentMonthRange(): { from: string; to: string } {
  const now = new Date();
  const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return { from: first.toISOString().slice(0, 10), to: now.toISOString().slice(0, 10) };
}

export async function getPLReport(query: { from?: string; to?: string }) {
  const def = currentMonthRange();
  const from = query.from ?? def.from;
  const to = query.to ?? def.to;

  const rows = (await db
    .select({
      itemId: boItem.id,
      name: boItem.name,
      direction: boItem.direction,
      cadence: boItem.cadence,
      valueMinor: sql<number>`coalesce(sum(${boMovement.valueMinor}), 0)::int`,
    })
    .from(boMovement)
    .innerJoin(boItem, eq(boItem.id, boMovement.itemId))
    .where(
      and(
        gte(boMovement.createdAt, sql`${from}::date`),
        lt(boMovement.createdAt, sql`(${to}::date + 1)`), // `to` inclusive
      ),
    )
    .groupBy(boItem.id, boItem.name, boItem.direction, boItem.cadence)) as PLItemRow[];

  return foldPL(rows, { from, to });
}
