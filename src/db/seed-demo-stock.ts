// TASK-915 - the ONE-TIME, IDEMPOTENT seed of Stock Demo from the customer's «Demo» tab. Not an API.
//
//   bun run db:seed-demo-stock [--file <path to Format-Stock-....xlsx>] [--dry]
//
// What it writes (all in ONE transaction; `--dry` rolls it back and prints the same counts):
//   * the six sites in the final UI's order (Bravo, STA, ABC, RIS, WA (Abbey), KIS), if missing (matched by name, case-insensitive);
//   * one `bo.demo_item` per sheet row that has a name (spacers skipped, duplicate names KEPT), keyed by `seed_row` so a second run adds nothing;
//   * one `OPENING` movement + the stored balance per non-zero (item, site) cell, key `demo-seed:<sheetRow>:<site>` (a re-run adds nothing).
// The unnamed location column (col E) is ignored (DECISIONS row 22). The target database is whatever DATABASE_URL says: check the host first.
import ExcelJS from "exceljs";
import { eq, sql } from "drizzle-orm";
import { db } from "./index";
import { boDemoItem, boDemoMovement, boDemoSite, boDemoStock } from "./schema-demo";
import { DEMO_SEED_SITES, parseDemoGrid, type DemoSeed } from "../lib/demo-stock";
import { cellValue } from "../services/stock-import.service";
import { bangkokDate } from "../lib/stock-read";

export const DEFAULT_SHEET = "H:/scheduler/SOM-BALANCE-Backoffice-spec/data/customer-files/Format-Stock-2026-from-feen-2026-10-30.xlsx";

export async function readDemoGrid(file: string): Promise<unknown[][]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const ws = wb.worksheets.find((s) => /^demo$/i.test(s.name.trim()));
  if (!ws) throw new Error("the workbook has no «Demo» sheet");
  const grid: unknown[][] = [];
  ws.eachRow({ includeEmpty: true }, (row, n) => {
    const cells: unknown[] = [];
    for (let c = 1; c <= Math.min(ws.columnCount, 30); c++) cells.push(cellValue(row.getCell(c).value));
    grid[n - 1] = cells;
  });
  for (let i = 0; i < grid.length; i++) grid[i] ??= [];
  return grid;
}

export interface SeedReport { sitesAdded: number; itemsAdded: number; itemsExisting: number; balancesWritten: number; unitsSeeded: number; skippedBlank: number; warnings: string[] }

/** The writes, over an executor (the global `db`, or a transaction a probe rolls back). Idempotent. */
export async function seedDemoStock(exec: any, seed: DemoSeed, on: string): Promise<SeedReport> {
  const report: SeedReport = { sitesAdded: 0, itemsAdded: 0, itemsExisting: 0, balancesWritten: 0, unitsSeeded: 0, skippedBlank: seed.skippedBlank, warnings: [...seed.warnings] };
  const siteId = new Map<string, string>();
  const have = (await exec.select().from(boDemoSite)) as Array<{ id: string; name: string; sortOrder: number }>;
  for (const s of have) siteId.set(s.name.toLowerCase(), s.id);
  let order = have.reduce((m, s) => Math.max(m, s.sortOrder), -1);
  for (const name of DEMO_SEED_SITES) {
    if (siteId.has(name.toLowerCase())) continue;
    const [r] = await exec.insert(boDemoSite).values({ name, sortOrder: ++order }).returning({ id: boDemoSite.id });
    siteId.set(name.toLowerCase(), r.id);
    report.sitesAdded++;
  }
  const existing = new Map<number, string>(((await exec.select({ id: boDemoItem.id, seedRow: boDemoItem.seedRow }).from(boDemoItem).where(sql`${boDemoItem.seedRow} is not null`)) as Array<{ id: string; seedRow: number }>).map((r) => [r.seedRow, r.id]));
  for (const row of seed.rows) {
    let itemId = existing.get(row.sheetRow);
    if (itemId) report.itemsExisting++;
    else {
      const [r] = await exec.insert(boDemoItem).values({ category: row.category, name: row.name, remark: row.remark, seedRow: row.sheetRow, sortOrder: row.sheetRow }).returning({ id: boDemoItem.id });
      itemId = r.id as string;
      report.itemsAdded++;
    }
    for (const [site, qty] of Object.entries(row.balances)) {
      const sid = siteId.get(site.toLowerCase());
      if (!sid) {
        report.warnings.push(`row ${row.sheetRow}: site «${site}» is not a seeded site, skipped`);
        continue;
      }
      const key = `demo-seed:${row.sheetRow}:${site}`;
      const [dup] = await exec.select({ id: boDemoMovement.id }).from(boDemoMovement).where(eq(boDemoMovement.idempotencyKey, key)).limit(1);
      if (dup) continue; // already seeded
      await exec.insert(boDemoStock).values({ demoItemId: itemId, siteId: sid, qty }).onConflictDoUpdate({ target: [boDemoStock.demoItemId, boDemoStock.siteId], set: { qty } });
      await exec.insert(boDemoMovement).values({ demoItemId: itemId, type: "OPENING", qty, toSiteId: sid, reason: "Seeded from the Demo sheet", actor: "seed", occurredOn: on, idempotencyKey: key });
      report.balancesWritten++;
      report.unitsSeeded += qty;
    }
  }
  return report;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const file = argv.includes("--file") ? argv[argv.indexOf("--file") + 1]! : DEFAULT_SHEET;
  const dry = argv.includes("--dry");
  const seed = parseDemoGrid(await readDemoGrid(file));
  console.log(`sheet: ${seed.rows.length} items, ${seed.skippedBlank} spacer rows skipped, ${seed.warnings.length} warnings`);
  class Rollback extends Error {}
  let report: SeedReport | null = null;
  try {
    await db.transaction(async (tx: any) => {
      report = await seedDemoStock(tx, seed, bangkokDate(new Date()));
      if (dry) throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
  console.log(dry ? "DRY RUN (rolled back):" : "SEEDED:", JSON.stringify(report));
  process.exit(0);
}
