// TASK-086 — run the witness probes against the schema. **Read-only: SELECTs on catalogs, nothing else.**
//
// Shared by BOTH the seeder and the verifier so they cannot form different notions of "applied" — if they
// could disagree, we'd eventually get a green verify on a broken database, which is worse than today's red.

import type postgres from "postgres";
import { describeProbe, type Witness, type WitnessKind } from "../src/lib/migration-witness";

/** Evaluate one probe. Returns `null` when it could not be evaluated ⇒ the judge yields `needs-human`. */
async function probeOne(sql: postgres.Sql, p: WitnessKind): Promise<boolean | null> {
  switch (p.kind) {
    case "column":
    case "column-absent": {
      const rows = await sql`
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = ${p.schema ?? "public"} AND table_name = ${p.table}
          AND column_name = ${p.column}
      `;
      const exists = rows.length > 0;
      // For `column-absent` the migration is proven by the column being GONE.
      return p.kind === "column" ? exists : !exists;
    }
    case "table": {
      const rows = await sql`
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = ${p.schema ?? "public"} AND table_name = ${p.table}
      `;
      return rows.length > 0;
    }
    case "index": {
      const rows = await sql`
        SELECT 1 FROM pg_indexes
        WHERE schemaname = ${p.schema ?? "public"} AND indexname = ${p.index}
      `;
      return rows.length > 0;
    }
    case "index-predicate": {
      // Existence is not enough — 0002 and 0007 share an index NAME and differ only in the predicate.
      const rows = await sql<{ indexdef: string }[]>`
        SELECT indexdef FROM pg_indexes
        WHERE schemaname = ${p.schema ?? "public"} AND indexname = ${p.index}
      `;
      if (rows.length === 0) return false;
      return rows[0]!.indexdef.includes(p.contains);
    }
    case "constraint": {
      const rows = await sql`SELECT 1 FROM pg_constraint WHERE conname = ${p.constraint}`;
      return rows.length > 0;
    }
    case "superseded-by":
    case "needs-human":
      return null; // resolved by `judge`, not by a query
  }
}

/** Probe every witness. Any error is swallowed into `null` — an unknown answer must never read as "applied". */
export async function probeAll(
  sql: postgres.Sql,
  witnesses: Witness[],
): Promise<Map<string, boolean | null>> {
  const out = new Map<string, boolean | null>();
  for (const w of witnesses) {
    try {
      out.set(w.tag, await probeOne(sql, w.probe));
    } catch (e) {
      console.error(`  ⚠️ probe failed for ${w.tag} (${describeProbe(w.probe)}):`, e);
      out.set(w.tag, null); // ⇒ needs-human
    }
  }
  return out;
}
