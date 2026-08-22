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
];
