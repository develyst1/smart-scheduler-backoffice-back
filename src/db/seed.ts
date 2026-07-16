/**
 * Seed default organization + catalog + teacher parties & price rules.
 * Run after scheduling seed: `bun run db:seed`
 */
import { and, eq, sql } from "drizzle-orm";
import { db, queryClient } from "./index";
import { accounts, catalogItems, organizations, parties, stockBalances } from "./schema";

const THB = (baht: number) => baht * 100;

console.log("Seeding ops schema…");

await db.execute(sql`CREATE SCHEMA IF NOT EXISTS ops`);

const [org] = await db
  .insert(organizations)
  .values({ code: "default", name: "Balance Sports Center" })
  .onConflictDoNothing({ target: organizations.code })
  .returning();

const orgId =
  org?.id ??
  (
    await db.query.organizations.findFirst({
      where: eq(organizations.code, "default"),
    })
  )!.id;

// Demo customer wallet (unchanged)
const [party] = await db
  .insert(parties)
  .values({
    organizationId: orgId,
    displayName: "Demo Customer",
    kind: "PERSON",
    externalSource: "demo-app",
    externalRef: "customer-001",
  })
  .onConflictDoNothing()
  .returning();

const partyId =
  party?.id ??
  (
    await db.query.parties.findFirst({
      where: and(
        eq(parties.organizationId, orgId),
        eq(parties.externalSource, "demo-app"),
        eq(parties.externalRef, "customer-001"),
      ),
    })
  )?.id;

if (partyId) {
  await db.insert(accounts).values({ partyId, unit: "HOURS", balanceMinor: 0 }).onConflictDoNothing();
}

// Catalog: retail + equipment rental (rate card §2)
const catalogSeed = [
  { sku: "WATER-600", name: "น้ำดื่ม 600ml", salePriceMinor: THB(15), reorderLevel: 24 },
  { sku: "SNACK-01", name: "ขนมขบเคี้ยว", salePriceMinor: THB(25), reorderLevel: 12 },
  { sku: "RENT-SET", name: "เช่า Set (Ride+Helmet+Pads) /ชม.", salePriceMinor: THB(200), reorderLevel: 0 },
  { sku: "RENT-RIDE", name: "เช่า Ride only /ชม.", salePriceMinor: THB(150), reorderLevel: 0 },
  { sku: "RENT-HELMET", name: "เช่า Helmet only /ชม.", salePriceMinor: THB(50), reorderLevel: 0 },
  { sku: "RENT-PADS", name: "เช่า Pads only /ชม.", salePriceMinor: THB(50), reorderLevel: 0 },
];

for (const s of catalogSeed) {
  const [item] = await db
    .insert(catalogItems)
    .values({
      organizationId: orgId,
      sku: s.sku,
      name: s.name,
      salePriceMinor: s.salePriceMinor,
      reorderLevel: s.reorderLevel,
      metadata: s.sku.startsWith("RENT-") ? { category: "RENTAL" } : { category: "RETAIL" },
    })
    .onConflictDoNothing()
    .returning();

  if (item) {
    await db.insert(stockBalances).values({ itemId: item.id, quantityOnHand: s.reorderLevel ?? 0 });
  }
}

// NOTE: teachers are NO LONGER read from public.teachers here. Backoffice now runs on
// its own standalone database (smart_backoffice_db) with no access to the scheduling
// schema. Teachers/customers enter as EXPENSE/INCOME items or parties via the API
// (frontoffice push) — see Phase 2. This seed only sets up generic demo data.

console.log("Done. org=default, catalog=", catalogSeed.length);

await queryClient.end();
process.exit(0);
