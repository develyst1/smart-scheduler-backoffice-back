/**
 * Seed default organization + catalog + teacher parties & price rules.
 * Run after scheduling seed: `bun run db:seed`
 */
import { and, eq, sql } from "drizzle-orm";
import { db, queryClient } from "./index";
import { accounts, catalogItems, organizations, parties, priceRules, stockBalances } from "./schema";

const THB = (baht: number) => baht * 100;

type TeacherRow = {
  id: string;
  name: string;
  nickname: string;
  type: "FULL_TIME" | "PART_TIME" | "FREELANCE";
};

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

// Sync teacher parties + freelance price rules from scheduling DB
const teacherRows = await db.execute<TeacherRow>(sql`
  SELECT id, name, nickname, type::text AS type
  FROM public.teachers
  ORDER BY nickname
`);

if (teacherRows.length === 0) {
  console.warn("No teachers in public.teachers — run smart-scheduler-back db:seed first");
} else {
  // Reset teacher-linked ops data (dev seed — safe when no production ledger)
  await db.execute(sql`
    DELETE FROM ops.price_rules
    WHERE party_id IN (SELECT id FROM ops.parties WHERE external_source = 'smart-scheduler')
  `);
  await db.execute(sql`
    DELETE FROM ops.accounts
    WHERE party_id IN (SELECT id FROM ops.parties WHERE external_source = 'smart-scheduler')
  `);
  await db.execute(sql`DELETE FROM ops.parties WHERE external_source = 'smart-scheduler'`);

  const DEFAULT_FREELANCE_CAP = THB(20_000);

  for (const t of teacherRows) {
    const [teacherParty] = await db
      .insert(parties)
      .values({
        organizationId: orgId,
        displayName: t.name,
        kind: "PERSON",
        externalSource: "smart-scheduler",
        externalRef: t.id,
        metadata: { nickname: t.nickname, teacherType: t.type },
      })
      .returning();

    if (t.type !== "FREELANCE") continue;

    const rules: Array<{
      kind: "HOURLY" | "FIXED" | "CAP";
      label: string;
      amountMinor: number;
      metadata?: Record<string, unknown>;
    }> = [
      {
        kind: "HOURLY",
        label: "Private 1:1",
        amountMinor: THB(500),
        metadata: { teachingMode: "PRIVATE" },
      },
      {
        kind: "FIXED",
        label: "Group/Camp ครึ่งวัน",
        amountMinor: THB(625),
        metadata: { teachingMode: "GROUP_CAMP_HALF" },
      },
      {
        kind: "FIXED",
        label: "Group/Camp เต็มวัน",
        amountMinor: THB(1250),
        metadata: { teachingMode: "GROUP_CAMP_FULL" },
      },
      {
        kind: "CAP",
        label: "เพดานรายได้รายเดือน",
        amountMinor: DEFAULT_FREELANCE_CAP,
        metadata: { purpose: "INCOME_CAP" },
      },
    ];

    // Exception: ครูโต๊ด (Part-Time) — Private วันธรรมดา 400 บาท/ชม.
    if (t.nickname === "โต๊ด") {
      rules.unshift({
        kind: "HOURLY",
        label: "Private วันธรรมดา (exception)",
        amountMinor: THB(400),
        metadata: { teachingMode: "PRIVATE", weekdaysOnly: true },
      });
    }

    await db.insert(priceRules).values(
      rules.map((r) => ({
        organizationId: orgId,
        partyId: teacherParty.id,
        kind: r.kind,
        label: r.label,
        amountMinor: r.amountMinor,
        metadata: r.metadata,
      })),
    );
  }

  console.log(`Synced ${teacherRows.length} teacher parties + freelance price rules`);
}

console.log("Done. org=default, catalog=", catalogSeed.length);

await queryClient.end();
process.exit(0);
