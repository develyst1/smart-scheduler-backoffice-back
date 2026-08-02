// TASK-086 — witness→verdict logic, shared by the seeder and the verifier. The MAP lives in
// migration-witness.ts; this file is the reasoning only, so both scripts import one notion of "applied".
//
// The 2026-08-02 dry-run proved the ledger is not faithful to the schema: 9 journal entries unrecorded, 6 of
// them demonstrably live. So the ledger stops being the input to reconciliation and becomes its output.
//
// ## The two rules that make a witness safe — they matter more than the map
// 1. **Witness the LAST object the migration creates, never the first.** A half-applied migration then reads
//    as "not applied", re-runs, and its `IF NOT EXISTS` guards absorb what already landed. Witnessing the
//    first object would declare a half-applied migration finished and leave a permanent hole.
// 2. **A false "applied" must be impossible.** The object must exist *only* because that migration ran. If a
//    hand-run fix or another migration could have created it, it is a bad witness — say so and pick another,
//    or mark it `needs-human`.
//
// ## ⚠️ How half-application can actually happen here — narrower than it looks
// `drizzle-orm/pg-core/dialect.cjs` wraps **the whole migrate run in ONE `session.transaction(...)`**, so a
// failure rolls everything back: `db:migrate` cannot leave a half-applied migration behind.
// The real exposure is **out-of-band** application — and we have a confirmed instance: the deleted
// `scripts/db-check-migrate.ts` executed statements one at a time with `sql.unsafe(stmt)` and **no
// transaction**, for `0004` and `0005`. Those two are exactly where a partial state is possible, which is why
// rule 1 is applied strictly rather than waved through on "it's transactional anyway".

/** How the verdict was reached, so the operator sees the reasoning and not just a boolean. */
export type WitnessKind =
  | { kind: "column"; table: string; column: string; schema?: string }
  | { kind: "column-absent"; table: string; column: string; schema?: string }
  | { kind: "table"; table: string; schema?: string }
  | { kind: "index"; index: string; schema?: string }
  | { kind: "index-predicate"; index: string; contains: string; schema?: string }
  | { kind: "constraint"; constraint: string }
  | { kind: "superseded-by"; tag: string }
  /**
   * TASK-087 — never applied, never will be, **and here is why**. For migrations that touch only a schema
   * the product has retired: applying them would mean hand-running SQL against something nothing reads.
   *
   * Expressed as a **probe kind** rather than a boolean flag, deliberately: it resolves without a query,
   * exactly like `superseded-by`, so it's the same mechanism rather than a special case bolted alongside it.
   */
  | { kind: "retired"; since: string }
  | { kind: "needs-human" };

export interface Witness {
  tag: string;
  probe: WitnessKind;
  /** Why this object proves *this* migration ran. A witness nobody can justify is a guess with a query on it. */
  why: string;
  /**
   * Can `db:migrate` safely attempt it if the verdict is "not applied"?
   * `false` ⇒ **halt and ask a human** — a wrong verdict there isn't recoverable by re-running.
   */
  rerunnable: boolean;
}

/**
 * scheduling-back. Each entry names the **last** object its migration creates.
 *
 * ⚠️ Two entries are deliberately not simple existence probes; both are explained on the entry.
 */
export type Verdict = "applied" | "not-applied" | "needs-human" | "retired";

/**
 * 🔴 Retired entries are **printed every run and never seeded**, and they keep the verifier **green**.
 *
 * Green rather than red because a permanently-red guard gets ignored, and then the next real skip is
 * invisible — a guard nobody trusts is worse than no guard, and a silent failure is the whole reason this
 * machinery exists. Visible + justified + stable keeps the check meaningful.
 *
 * ⚠️ Never seeded into the ledger: a row there would be a claim that something was applied, which nobody
 * verified and which isn't true.
 */
export const isRetired = (r: { verdict: Verdict }): boolean => r.verdict === "retired";

export interface WitnessResult {
  tag: string;
  /** What the probe looked for, rendered for the operator. */
  probe: string;
  /** What the database answered. `null` when the probe could not be evaluated. */
  found: boolean | null;
  verdict: Verdict;
  rerunnable: boolean;
  why: string;
}

/** Human-readable form of a probe, so the dry-run output explains itself. */
export function describeProbe(p: WitnessKind): string {
  switch (p.kind) {
    case "column":
      return `column ${p.table}.${p.column} exists`;
    case "column-absent":
      return `column ${p.table}.${p.column} is ABSENT (dropped)`;
    case "table":
      return `table ${p.schema ?? "public"}.${p.table} exists`;
    case "index":
      return `index ${p.index} exists`;
    case "index-predicate":
      return `index ${p.index} definition contains "${p.contains}"`;
    case "constraint":
      return `constraint ${p.constraint} exists`;
    case "superseded-by":
      return `inherited from ${p.tag} (own effect no longer observable)`;
    case "retired":
      return `RETIRED — target schema retired by ${p.since}; will never be applied`;
    case "needs-human":
      return "no honest witness — a human must confirm";
  }
}

/**
 * Turn probe answers into verdicts. **Pure** — the SQL lives in the scripts, so this (the part that can be
 * wrong in an interesting way) is testable without a database.
 *
 * `probeResults` maps tag → what the database said. A tag missing from the map, or mapped to `null`, means
 * the probe could not be evaluated ⇒ `needs-human`, never an optimistic guess.
 */
export function judge(
  witnesses: Witness[],
  probeResults: Map<string, boolean | null>,
): WitnessResult[] {
  const out = new Map<string, WitnessResult>();

  const verdictOf = (w: Witness): Verdict => {
    if (w.probe.kind === "needs-human") return "needs-human";
    if (w.probe.kind === "retired") return "retired";
    if (w.probe.kind === "superseded-by") {
      // Inherit, and only from a verdict we actually have. Never assume.
      const parent = out.get(w.probe.tag);
      if (!parent || parent.verdict !== "applied") return "needs-human";
      return "applied";
    }
    const found = probeResults.get(w.tag);
    if (found === undefined || found === null) return "needs-human";
    return found ? "applied" : "not-applied";
  };

  // Two passes so a `superseded-by` entry can inherit regardless of declaration order.
  for (const pass of [0, 1]) {
    for (const w of witnesses) {
      if (pass === 0 && w.probe.kind === "superseded-by") continue;
      const verdict = verdictOf(w);
      out.set(w.tag, {
        tag: w.tag,
        probe: describeProbe(w.probe),
        found: w.probe.kind === "superseded-by" ? null : (probeResults.get(w.tag) ?? null),
        verdict,
        rerunnable: w.rerunnable,
        why: w.why,
      });
    }
  }
  return witnesses.map((w) => out.get(w.tag)!);
}

/**
 * 🔴 The halt condition. Anything that would have `db:migrate` attempt a migration that cannot survive it,
 * or that we cannot judge, must stop the operator rather than proceed.
 */
export function blockers(results: WitnessResult[]): WitnessResult[] {
  return results.filter(
    (r) => r.verdict === "needs-human" || (r.verdict === "not-applied" && !r.rerunnable),
  );
}

/**
 * Rows to seed: one per journal entry the database says is already applied.
 * ⚠️ `retired` is deliberately NOT included — a ledger row would claim it was applied, which is untrue.
 */
export const appliedTags = (results: WitnessResult[]): string[] =>
  results.filter((r) => r.verdict === "applied").map((r) => r.tag);

/**
 * Tags the verifier must exclude from its "unrecorded in the ledger" check — otherwise a retired migration
 * makes `db:verify` permanently red, which is the outcome TASK-087 exists to avoid.
 *
 * ⚠️ This is the ONE place `retired` softens a check, so it is deliberately narrow: it excuses **only** these
 * exact tags. A genuinely unrecorded, non-retired migration is untouched by it and still turns verify red —
 * there's a test for exactly that, because otherwise `retired` becomes a way to switch the guard off.
 */
export const retiredTags = (results: WitnessResult[]): string[] =>
  results.filter((r) => r.verdict === "retired").map((r) => r.tag);
