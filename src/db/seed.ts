/**
 * Seed default organization + sample catalog for dev/demo.
 * Run: bun run db:seed
 */
import { and, eq, sql } from "drizzle-orm";
import { db } from "./index";
import { accounts, catalogItems, organizations, parties, stockBalances } from "./schema";

console.log("Seeding ops schema…");

await db.execute(sql`CREATE SCHEMA IF NOT EXISTS ops`);

const [org] = await db
  .insert(organizations)
  .values({ code: "default", name: "Default Organization" })
  .onConflictDoNothing({ target: organizations.code })
  .returning();

const orgId =
  org?.id ??
  (
    await db.query.organizations.findFirst({
      where: eq(organizations.code, "default"),
    })
  )!.id;

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
  await db
    .insert(accounts)
    .values({ partyId, unit: "HOURS", balanceMinor: 0 })
    .onConflictDoNothing();
}

const samples = [
  { sku: "WATER-600", name: "น้ำดื่ม 600ml", salePriceMinor: 1500, reorderLevel: 24 },
  { sku: "SNACK-01", name: "ขนมขบเคี้ยว", salePriceMinor: 2500, reorderLevel: 12 },
  { sku: "PEN-01", name: "ปากกา", salePriceMinor: 3500, reorderLevel: 10 },
];

for (const s of samples) {
  const [item] = await db
    .insert(catalogItems)
    .values({
      organizationId: orgId,
      sku: s.sku,
      name: s.name,
      salePriceMinor: s.salePriceMinor,
      reorderLevel: s.reorderLevel,
    })
    .onConflictDoNothing()
    .returning();

  if (item) {
    await db.insert(stockBalances).values({ itemId: item.id, quantityOnHand: s.reorderLevel ?? 0 });
  }
}

console.log("Done. org=default, items=", samples.length, partyId ? ", demo party + HOURS account" : "");

process.exit(0);
