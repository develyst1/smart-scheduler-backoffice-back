// 🔻 TASK-915 (REQ-120 R3.6) - Stock DEMO: teaching equipment that lives at SITES, separate from the sale stock. A NEW file (like schema-revenue.ts); drizzle-kit finds it through
// the array in `drizzle.config.ts`. Own tables on purpose: the demo catalogue has no model codes and none of its names match the sale catalogue, so it is NOT `bo.item`.
//   demo_site      the places (Bravo, STA, ABC, RIS, WA (Abbey), KIS ...), ordered by `sort_order` (Bravo leftmost by default); more can be added
//   demo_item      the demo catalogue (category + name + remark, from the customer's «Demo» tab); `sale_item_id` is the OPTIONAL link to a sale product, for a later sale<->demo bridge
//   demo_stock     the stored balance per (item, site), moved in the SAME transaction as each movement (904's pattern); never negative
//   demo_movement  the +/- history: who / when / from -> to / reason. Never updated or deleted.
import { sql } from "drizzle-orm";
import { boolean, check, date, index, integer, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { bo, boItem } from "./schema";

export const boDemoSite = bo.table(
  "demo_site",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("bo_demo_site_name_uq").on(sql`lower(${t.name})`)],
);

export const boDemoItem = bo.table(
  "demo_item",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    category: text("category"),
    name: text("name").notNull(),
    remark: text("remark"),
    active: boolean("active").notNull().default(true),
    /** Optional link to a sale product (ON DELETE SET NULL). Nothing reads it yet: the sale<->demo bridge is deferred. */
    saleItemId: uuid("sale_item_id").references(() => boItem.id, { onDelete: "set null" }),
    /** The row of the customer's Demo sheet this item was seeded from (NULL for an item added by hand): makes the seed idempotent. */
    seedRow: integer("seed_row"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("bo_demo_item_seed_row_uq").on(t.seedRow).where(sql`${t.seedRow} is not null`)],
);

export const boDemoStock = bo.table(
  "demo_stock",
  {
    demoItemId: uuid("demo_item_id").notNull().references(() => boDemoItem.id, { onDelete: "restrict" }),
    siteId: uuid("site_id").notNull().references(() => boDemoSite.id, { onDelete: "restrict" }),
    qty: integer("qty").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.demoItemId, t.siteId] }), check("demo_stock_qty_ck", sql`"qty" >= 0`)],
);

export const DEMO_MOVEMENT_TYPES = ["MOVE", "DEFECT_IN", "WRITE_OFF", "OPENING"] as const;
export const boDemoMovement = bo.table(
  "demo_movement",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    demoItemId: uuid("demo_item_id").notNull().references(() => boDemoItem.id, { onDelete: "restrict" }),
    /** MOVE site -> site · DEFECT_IN (+qty at a site, from "Defect Product") · WRITE_OFF (-qty at a site) · OPENING (the seed's starting balance). */
    type: text("type").notNull(),
    qty: integer("qty").notNull(), // always > 0: the amount moved (the direction comes from type / from_site / to_site)
    fromSiteId: uuid("from_site_id").references(() => boDemoSite.id, { onDelete: "restrict" }),
    toSiteId: uuid("to_site_id").references(() => boDemoSite.id, { onDelete: "restrict" }),
    reason: text("reason"),
    actor: text("actor"),
    occurredOn: date("occurred_on").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("bo_demo_movement_key_uq").on(t.idempotencyKey),
    index("bo_demo_movement_day_idx").on(t.occurredOn),
    check("demo_movement_type_ck", sql`"type" IN ('MOVE','DEFECT_IN','WRITE_OFF','OPENING')`),
    check("demo_movement_qty_ck", sql`"qty" > 0`),
  ],
);
