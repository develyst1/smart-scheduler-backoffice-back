// TASK-086 — "did this migration run?" answered by the DATABASE, not by the ledger. (backoffice-back)
//
// Same two rules as the scheduling repo, and they matter more than the map:
// 1. **Witness the LAST object the migration creates, never the first** — so a half-applied migration reads as
//    "not applied", re-runs, and its `IF NOT EXISTS` guards absorb what already landed.
// 2. **A false "applied" must be impossible** — the object must exist only because that migration ran.
//
// Note `drizzle-orm` wraps a whole migrate run in ONE transaction, so `db:migrate` cannot leave a half-applied
// migration here. This repo also had no equivalent of scheduling's out-of-band `db-check-migrate.ts`, so its
// exposure to partial state is lower — the rule is still applied strictly rather than waved through.

export type {
  Verdict,
  Witness,
  WitnessKind,
  WitnessResult,
} from "./migration-witness-core";
export {
  appliedTags,
  blockers,
  describeProbe,
  isRetired,
  judge,
  retiredTags,
} from "./migration-witness-core";
import type { Witness } from "./migration-witness-core";

/** backoffice-back. Each entry names the **last** object its migration creates. */
export const BO_WITNESSES: Witness[] = [
  {
    tag: "0000_friendly_moonstone",
    probe: { kind: "index", index: "stock_movements_item_idx", schema: "ops" },
    why:
      "Last statement of the ops baseline, created after every ops table and its other indexes — so it " +
      "proves the whole baseline landed. Nothing else creates it.",
    rerunnable: false, // bare CREATE TABLE/SCHEMA throughout → 42P07/42710 on re-run
  },
  // ── 🔴 TASK-087: the two `retired` entries ────────────────────────────────────────────────────────
  // Both touch ONLY `ops.*`, the schema retired by REQ-006 / TASK-027. The 2026-08-02 dry-run found them
  // not-applied, and they never will be: `routes/api.ts` mounts only `/auth` and `/bo`, so the `ops` surface
  // (`catalog.ts`, `recurring.ts`) is unreachable over HTTP, and drizzle can't reach the migrations either
  // (their `folderMillis` is below the newest seeded row). "Applying" them would mean hand-running SQL
  // against a schema nothing reads.
  //
  // They are NOT silently excluded — printed on every run, with this reason — because a ledger that says
  // nothing while the truth is elsewhere is the exact failure we spent two days undoing.
  {
    tag: "0001_item_pl",
    probe: { kind: "retired", since: "REQ-006 / TASK-027" },
    why:
      "Adds item_group/item_type to ops.catalog_items and amount_minor to ops.stock_movements — all in the " +
      "`ops` schema retired by REQ-006/TASK-027. ✅ Checked it masks nothing live: those columns are read " +
      "only by catalog.ts / recurring.ts / the dormant ops P&L, and api.ts mounts neither. Fully " +
      "IF NOT EXISTS-guarded, so even an accidental apply would be harmless — but we still don't.",
    rerunnable: false, // never attempt it: "apply" = hand-run SQL against a dead schema
  },
  {
    tag: "0002_item_external",
    probe: { kind: "retired", since: "REQ-006 / TASK-027" },
    why:
      "Adds external_source/external_ref + an index to ops.catalog_items — same retired schema, same " +
      "reasoning as 0001. Its only consumers (catalog.ts, recurring.ts) are unmounted. Fully " +
      "IF NOT EXISTS-guarded.",
    rerunnable: false,
  },
  {
    tag: "0003_even_turbo",
    probe: { kind: "index", index: "recurring_costs_effective_idx", schema: "ops" },
    why:
      "Last statement of 0003, after the recurring_costs/settlement tables and their other indexes — so it " +
      "witnesses the whole migration, not just its first table.",
    rerunnable: false, // bare CREATE TABLE
  },
  {
    tag: "0004_bo_schema",
    probe: { kind: "index", index: "bo_item_tag_group_uq", schema: "bo" },
    why:
      "The LAST object 0004 creates — after the bo schema, item, movement, tag_group, tag_value and item_tag. " +
      "This is the migration whose ledger row silently blocked scheduling (TASK-085), so witnessing its END " +
      "rather than the `bo` schema itself matters.",
    rerunnable: true, // its CREATEs are IF NOT EXISTS
  },
  {
    tag: "0005_bo_item_external_ref",
    probe: { kind: "index", index: "bo_item_external_uq", schema: "bo" },
    why:
      "Last statement of 0005, created after bo.item.external_ref — so it proves the column landed too. " +
      "The partial unique index exists only because this migration ran.",
    rerunnable: true,
  },
  {
    tag: "0006_bo_movement_audit",
    probe: { kind: "column", table: "movement", column: "note", schema: "bo" },
    why:
      "0006 adds `actor` then `note` to bo.movement, in that order — witnessing the LAST of the two means a " +
      "half-applied run cannot read as finished. There is nothing else to probe: both statements are plain " +
      "additive columns, with no index or constraint to stand for them.",
    rerunnable: true,
  },
  {
    tag: "0007_bo_users_roles",
    probe: { kind: "index", index: "bo_users_username_uq", schema: "bo" },
    why:
      "0007 creates the bo.role enum, then bo.users, then this unique index LAST — so the index existing proves " +
      "the enum and the table landed before it (TASK-856 / SPEC-097). Nothing else creates it.",
    rerunnable: true, // enum in a DO block, table + index IF NOT EXISTS
  },
  {
    tag: "0008_bo_revenue_ledger",
    probe: { kind: "index", index: "bo_revenue_line_day_idx", schema: "bo" },
    why:
      "0008 creates bo.revenue_category, bo.revenue_line, the FK, then the three indexes with this one LAST before the " +
      "seed INSERT, so the index existing proves both tables landed (TASK-858 / SPEC-098). The 53-row seed is the " +
      "final statement and has no probe.",
    rerunnable: false, // plain CREATE TABLE: a re-run on a half-applied DB fails on 'already exists'
  },
  {
    tag: "0009_bo_salary_thin_slip",
    probe: { kind: "index", index: "bo_pay_slip_line_slip_idx", schema: "bo" },
    why:
      "0009 creates the 5 pay enums, the 4 tables (salary_profile, pay_period, pay_slip, pay_slip_line), the 2 FKs, then the " +
      "indexes with this one LAST — so it existing proves every table landed (TASK-865 / SPEC-100). Nothing else creates it.",
    rerunnable: true, // enums + FKs in DO blocks, tables + indexes IF NOT EXISTS
  },
  {
    tag: "0010_bo_people_model_pay_period",
    probe: { kind: "index", index: "bo_fl_rate_profile_class_uq", schema: "bo" },
    why:
      "0010 creates the 2 enums, adds the 3 profile + 2 period columns, creates bo.fl_rate and its FK, then this unique index LAST — " +
      "so it existing proves the table and (running after the ALTERs) the columns landed (TASK-871 / SPEC-101). Nothing else creates it.",
    rerunnable: true, // enums + FK in DO blocks, ADD COLUMN / table / index IF NOT EXISTS
  },
  {
    tag: "0011_bo_pay_slip_line_source_ref",
    probe: { kind: "index", index: "bo_pay_slip_line_auto_ref_uq", schema: "bo" },
    why:
      "0011 adds bo.pay_slip_line.source_ref and then the partial unique index on it LAST — so the index existing proves the column " +
      "landed before it (TASK-867/878 auto-line idempotency). Nothing else creates it.",
    rerunnable: true, // ADD COLUMN / CREATE INDEX IF NOT EXISTS
  },
  {
    tag: "0012_bo_payment",
    probe: { kind: "index", index: "bo_payment_ref_n_uq", schema: "bo" },
    why:
      "0012 creates bo.payment (its four CHECKs inside the CREATE TABLE) and then the unique index on (ref_type, ref_id, n) LAST — so " +
      "the index existing proves the table landed before it (TASK-874 / SPEC-099 §8). Nothing else creates it.",
    rerunnable: false, // plain CREATE TABLE: a re-run on a half-applied DB fails on 'already exists'
  },
  {
    tag: "0013_bo_school_transport_trip",
    probe: { kind: "index", index: "bo_transport_trip_teacher_date_idx", schema: "bo" },
    why:
      "0013 creates bo.school and bo.transport_trip, the FK, the unique name index, and the trip's (teacher_id, date) index LAST — so " +
      "that index existing proves both tables landed before it (TASK-868 / SPEC-100 §9b Transportation). Nothing else creates it.",
    rerunnable: false, // plain CREATE TABLE: a re-run on a half-applied DB fails on 'already exists'
  },
  {
    tag: "0014_bo_pay_slip_line_class_type",
    probe: { kind: "column", table: "pay_slip_line", column: "class_type", schema: "bo" },
    why:
      "0014 adds the single column bo.pay_slip_line.class_type (TASK-903: fl_pay split per class type); there is nothing after it, so the column itself is the " +
      "last object the migration creates. Nothing else creates it.",
    rerunnable: true, // ADD COLUMN IF NOT EXISTS
  },
  {
    tag: "0015_bo_item_commission_group",
    probe: { kind: "column", table: "item", column: "commission_group", schema: "bo" },
    why:
      "0015 adds the single column bo.item.commission_group (TASK-904: a stock product's commission group name); there is nothing after it, so the column itself is the " +
      "last object the migration creates. Nothing else creates it.",
    rerunnable: true, // ADD COLUMN IF NOT EXISTS
  },
  {
    tag: "0016_bo_sale",
    probe: { kind: "index", index: "bo_sale_line_movement_uq", schema: "bo" },
    why:
      "0016 creates bo.sale and bo.sale_line (TASK-909: the Stock OUT sale record). The probe is the LAST object the file creates (the unique index on sale_line.movement_id), so a run that died after the first table " +
      "is not called applied. Not rerunnable (plain CREATE TABLE): a half-applied run is fixed by hand.",
    rerunnable: false,
  },
  {
    tag: "0017_bo_movement_occurred_on",
    probe: { kind: "column", table: "movement", column: "occurred_on", schema: "bo" },
    why: "0017 adds the single column bo.movement.occurred_on (TASK-911: the movement business date); nothing follows it, so the column itself is the last object the migration creates. Nothing else creates it.",
    rerunnable: true, // ADD COLUMN IF NOT EXISTS
  },
  {
    tag: "0018_bo_item_revenue_category",
    probe: { kind: "column", table: "item", column: "revenue_category_id", schema: "bo" },
    why: "0018 adds the single column bo.item.revenue_category_id (TASK-909 / 904 companion: the revenue category a stock sale posts into); nothing follows it, so the column itself is the last object the migration creates. Nothing else creates it.",
    rerunnable: true, // ADD COLUMN IF NOT EXISTS
  },
  {
    tag: "0019_bo_demo_stock",
    probe: { kind: "index", index: "bo_demo_movement_key_uq", schema: "bo" },
    why:
      "0019 creates bo.demo_site, bo.demo_item, bo.demo_stock and bo.demo_movement (TASK-915: Stock Demo); the unique idempotency-key index on demo_movement is the LAST statement, so it existing proves all four tables " +
      "landed before it. Nothing else creates it.",
    rerunnable: true, // CREATE TABLE / INDEX IF NOT EXISTS
  },
  {
    tag: "0020_bo_notification",
    probe: { kind: "index", index: "low_stock_threshold_pkey", schema: "bo" },
    why:
      "0020 creates bo.notification, bo.notification_assignment and bo.low_stock_threshold (TASK-917), then seeds; the primary-key index of low_stock_threshold is created WITH the last table, so it existing proves all three " +
      "tables landed before it. Nothing else creates it.",
    rerunnable: true, // CREATE TABLE / INDEX IF NOT EXISTS, seeds ON CONFLICT DO NOTHING
  },
];
