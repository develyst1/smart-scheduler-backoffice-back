/**
 * REQ-006 / TASK-025 — one-time, IDEMPOTENT data migration: ops.* + public.freelance_budgets → bo.*.
 *
 * Run MANUALLY at the REQ-006 deploy, AFTER the `bo` migration (0004) and BEFORE/with deploying TASK-024:
 *   bun run src/db/migrate-to-bo.ts
 *
 * Read-only on the old tables; upserts into `bo` by a stable key (metadata.migrationKey, or owner_ref+kind
 * for freelance) → safe to re-run. `remaining_qty` is set on INSERT only (never overwritten) so a re-run
 * after teachers have booked doesn't clobber live remaining.
 *
 * Scoping decisions (see task Questions — confirmed scope):
 *  - Skips ops catalog items with metadata.kind='FREELANCE_BUDGET' (the pre-REQ-004 freelance model; the
 *    LIVE freelance data is public.freelance_budgets, migrated below as hour-unit FREELANCE_CEILING items).
 *  - Migrates IN/OUT stock_movements (signed) → bo.movement; skips ADJUST (P&L-neutral; remaining comes
 *    from the balance). Freelance P&L expense history is a follow-up REQ, so freelance movements are skipped.
 *  - recurring_costs: corrects the salary item's unit_price to the current OPEN effective amount (the
 *    catalog_items pass already created the FIXED_COST item). Effective-dated history is not modelled in bo.
 *  - Skips the 5 dead ops tables + commercial_requests (no approvals in bo).
 */
import { eq, sql } from "drizzle-orm";
import { db, queryClient } from "./index";
import { pgErrorCode } from "../lib/http";
import {
  boItem,
  boMovement,
  catalogItems,
  recurringCosts,
  stockMovements,
} from "./schema";

const SCHED = "smart-scheduler";

async function findByMigrationKey(key: string) {
  return db.query.boItem.findFirst({
    where: sql`${boItem.metadata}->>'migrationKey' = ${key}`,
  });
}

/** Upsert a bo.item by migrationKey. `remainingOnInsert` is applied ONLY on first insert. Returns the id. */
async function upsertBoItem(
  key: string,
  values: Omit<typeof boItem.$inferInsert, "remainingQty" | "metadata">,
  metadata: Record<string, unknown>,
  remainingOnInsert: number | null,
): Promise<string> {
  const meta = { ...metadata, migrationKey: key };
  const existing = await findByMigrationKey(key);
  if (existing) {
    await db.update(boItem).set({ ...values, metadata: meta }).where(eq(boItem.id, existing.id));
    return existing.id;
  }
  const [row] = await db
    .insert(boItem)
    .values({ ...values, metadata: meta, remainingQty: remainingOnInsert })
    .returning({ id: boItem.id });
  return row.id;
}

async function migrateCatalogItems() {
  const items = await db.query.catalogItems.findMany({ with: { balance: true } });
  let n = 0;
  const idMap = new Map<string, string>(); // ops catalog_item id → bo.item id
  for (const it of items) {
    const kind = (it.metadata as Record<string, unknown> | null)?.kind;
    if (kind === "FREELANCE_BUDGET") continue; // superseded by public.freelance_budgets (migrated below)

    const direction = it.itemType === "INCOME" ? "INCOME" : "EXPENSE";
    const cadence = it.itemType === "FIXED_COST" ? "FIXED_MONTHLY" : "VARIABLE";
    const key = `ops-cat:${it.id}`;
    const boId = await upsertBoItem(
      key,
      {
        name: it.name,
        unit: it.unit,
        direction,
        cadence,
        unitPriceMinor: it.salePriceMinor,
        ownerRef: it.externalRef ?? null,
        externalSource: it.externalSource ?? null,
        active: it.active,
      },
      { reorder: it.reorderLevel ?? null },
      it.trackStock ? (it.balance?.quantityOnHand ?? 0) : null,
    );
    idMap.set(it.id, boId);
    n++;
  }
  return { n, idMap };
}

async function migrateMovements(idMap: Map<string, string>) {
  const rows = await db.query.stockMovements.findMany();
  let n = 0;
  for (const mv of rows) {
    const boItemId = idMap.get(mv.itemId);
    if (!boItemId) continue; // its item was skipped (e.g. freelance) → skip the movement too
    if (mv.direction === "ADJUST") continue; // P&L-neutral; remaining came from the balance

    const signedQty = mv.direction === "OUT" ? -mv.quantity : mv.quantity;
    const valueMinor = mv.direction === "OUT" ? mv.amountMinor : -mv.amountMinor;
    const idempotencyKey = mv.idempotencyKey ?? `ops-mv:${mv.id}`;

    await db
      .insert(boMovement)
      .values({
        itemId: boItemId,
        qty: signedQty,
        remainingAfter: null,
        valueMinor,
        reason: mv.reason,
        refType: mv.refType,
        refId: mv.refId,
        idempotencyKey,
      })
      .onConflictDoNothing(); // idempotent by the unique key
    n++;
  }
  return n;
}

/** Correct each salary item's unit_price to the CURRENT OPEN effective amount (definition only). */
async function migrateRecurringSalary() {
  const open = await db.query.recurringCosts.findMany({
    where: (r, { and, eq: e, isNull }) => and(e(r.active, true), isNull(r.effectiveTo)),
  });
  let n = 0;
  for (const rc of open) {
    const existing = await findByMigrationKey(`ops-cat:${rc.itemId}`);
    if (!existing) continue; // its FIXED_COST catalog item wasn't migrated
    await db.update(boItem).set({ unitPriceMinor: rc.amountMinor }).where(eq(boItem.id, existing.id));
    n++;
  }
  return n;
}

/** public.freelance_budgets → hour-unit bo.item, EXACTLY the shape TASK-024's findFreelanceItem expects
 *  (external_source, owner_ref, active, metadata.kind='FREELANCE_CEILING'). Keyed by owner_ref+kind so it
 *  is the same item the running app reads/writes. */
async function migrateFreelanceBudgets() {
  // public.freelance_budgets isn't in this repo's Drizzle schema — read it raw from the shared DB.
  const rows = (await db.execute(
    sql`SELECT teacher_id, monthly_budget_minor, rate_minor, remaining_minor, reorder_minor FROM public.freelance_budgets`,
  )) as unknown as Array<{
    teacher_id: string;
    monthly_budget_minor: number;
    rate_minor: number;
    remaining_minor: number;
    reorder_minor: number | null;
  }>;

  let n = 0;
  for (const fb of rows) {
    if (fb.rate_minor <= 0) continue;
    const ceilingQty = Math.round(fb.monthly_budget_minor / fb.rate_minor);
    const remainingQty = Math.round(fb.remaining_minor / fb.rate_minor);
    const reorderQty = fb.reorder_minor != null ? Math.round(fb.reorder_minor / fb.rate_minor) : null;

    const existing = await db.query.boItem.findFirst({
      where: (i, { and, eq: e, sql: s }) =>
        and(
          e(i.externalSource, SCHED),
          e(i.ownerRef, fb.teacher_id),
          s`${i.metadata}->>'kind' = 'FREELANCE_CEILING'`,
        ),
    });
    const metadata = { kind: "FREELANCE_CEILING", reorderQty, migrationKey: `fl:${fb.teacher_id}` };
    if (existing) {
      // definitional fields only — never clobber a live remaining_qty on re-run
      await db
        .update(boItem)
        .set({ ceilingQty, unitPriceMinor: fb.rate_minor, metadata })
        .where(eq(boItem.id, existing.id));
    } else {
      await db.insert(boItem).values({
        name: `ครูฟรีแลนซ์ ${fb.teacher_id}`,
        unit: "ชั่วโมง",
        direction: "EXPENSE",
        cadence: "FIXED_MONTHLY",
        ceilingQty,
        remainingQty,
        unitPriceMinor: fb.rate_minor,
        ownerRef: fb.teacher_id,
        externalSource: SCHED,
        metadata,
      });
    }
    n++;
  }
  return n;
}

/** After the shared-DB fix (TASK-027) backoffice-back points at `smart_scheduler` where `ops.*` doesn't
 *  exist. The ops passes then skip cleanly; the `public.freelance_budgets` pass is the essential one. */
async function opsSchemaPresent(): Promise<boolean> {
  const rows = (await db.execute(
    sql`SELECT 1 FROM information_schema.tables WHERE table_schema = 'ops' AND table_name = 'catalog_items' LIMIT 1`,
  )) as unknown as unknown[];
  return rows.length > 0;
}

async function main() {
  console.log("Migrating ops.* + public.freelance_budgets → bo.* …");
  let items = 0;
  let movements = 0;
  let salaries = 0;
  if (await opsSchemaPresent()) {
    // The table exists, but on a legacy/drifted `ops` schema (e.g. `0001_item_pl` never applied →
    // `item_group` missing) the ops passes throw a schema-shape error. Degrade to freelance-only rather
    // than aborting the ESSENTIAL freelance pass — the ops data is non-essential post-pivot (TASK-030).
    try {
      const cat = await migrateCatalogItems();
      items = cat.n;
      movements = await migrateMovements(cat.idMap);
      salaries = await migrateRecurringSalary();
    } catch (err) {
      const code = pgErrorCode(err); // 42P01 undefined_table / 42703 undefined_column = drifted ops
      if (code !== "42P01" && code !== "42703") throw err; // real failure → don't mask it
      console.warn(
        `ops schema present but drifted (${code}) — skipping ops passes; migrating freelance budgets only.`,
      );
    }
  } else {
    console.log("ops.* not present in this database — skipping ops passes (freelance-only migration).");
  }
  const freelance = await migrateFreelanceBudgets();
  console.log(
    `Done. catalog_items=${items}, movements=${movements}, salary_corrections=${salaries}, freelance=${freelance}`,
  );
  await queryClient.end();
  process.exit(0);
}

await main();
