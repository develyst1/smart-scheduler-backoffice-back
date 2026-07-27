/**
 * REQ-006 deploy safety check (run AFTER `migrate:bo`): `bun run verify:bo`. Read-only.
 * Reports bo.item counts by direction + kind, the bo.movement value sum (cross-check vs `/bo/reports/pl`),
 * and — the safety-critical bit — asserts every live `public.freelance_budgets` row has a matching
 * `FREELANCE_CEILING` bo.item with the expected ceiling/rate. Exits non-zero if any freelance is missing
 * or mismatched, so it can gate the deploy.
 */
import { sql } from "drizzle-orm";
import { db, queryClient } from "./index";

async function main() {
  const items = await db.query.boItem.findMany();
  const byDir: Record<string, number> = { INCOME: 0, EXPENSE: 0 };
  let freelanceItems = 0;
  for (const it of items) {
    byDir[it.direction] = (byDir[it.direction] ?? 0) + 1;
    if ((it.metadata as Record<string, unknown> | null)?.kind === "FREELANCE_CEILING") freelanceItems++;
  }

  const mvRes = (await db.execute(
    sql`SELECT coalesce(sum(value_minor), 0)::int AS total FROM bo.movement`,
  )) as unknown as Array<{ total: number }>;
  const totalValue = mvRes[0]?.total ?? 0;

  console.log(
    `bo.item: total=${items.length}  INCOME=${byDir.INCOME}  EXPENSE=${byDir.EXPENSE}  freelance=${freelanceItems}`,
  );
  console.log(
    `bo.movement Σvalue_minor = ${totalValue} (compare direction sums to the old ops /reports/pl via GET /api/v1/bo/reports/pl)`,
  );

  // Safety-critical: every live freelance budget must have a matching hour-unit bo.item.
  const fb = (await db.execute(
    sql`SELECT teacher_id, rate_minor, monthly_budget_minor FROM public.freelance_budgets`,
  )) as unknown as Array<{ teacher_id: string; rate_minor: number; monthly_budget_minor: number }>;

  let missing = 0;
  let mismatch = 0;
  for (const r of fb) {
    const item = items.find(
      (i) =>
        i.externalSource === "smart-scheduler" &&
        i.ownerRef === r.teacher_id &&
        (i.metadata as Record<string, unknown> | null)?.kind === "FREELANCE_CEILING",
    );
    if (!item) {
      missing++;
      console.error(`  MISSING bo.item for teacher ${r.teacher_id}`);
      continue;
    }
    const expCeiling = r.rate_minor > 0 ? Math.round(r.monthly_budget_minor / r.rate_minor) : null;
    if (item.ceilingQty !== expCeiling || item.unitPriceMinor !== r.rate_minor) {
      mismatch++;
      console.error(
        `  MISMATCH teacher ${r.teacher_id}: ceiling ${item.ceilingQty} vs ${expCeiling}, rate ${item.unitPriceMinor} vs ${r.rate_minor}`,
      );
    }
  }
  console.log(`freelance check: ${fb.length} budgets, ${missing} missing, ${mismatch} mismatched`);

  const ok = missing === 0 && mismatch === 0;
  console.log(ok ? "✅ migration verified" : "❌ migration has gaps — see above");
  await queryClient.end();
  process.exit(ok ? 0 : 1);
}

await main();
