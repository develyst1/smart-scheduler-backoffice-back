// TASK-915 (REQ-120 R3.6) - the PURE half of Stock Demo: the seed sheet parser, the site vocabulary, the movement rules. No database, no clock, no IO.

/** The six sites in the final UI's order (Bravo leftmost). The customer's «Demo» tab names them Bravo / STA / (blank) / RIS / ABC / Abbey. */
export const DEMO_SEED_SITES = ["Bravo", "STA", "ABC", "RIS", "WA (Abbey)", "KIS"] as const;

/** The sheet's header text (normalised) -> the site's name. The one UNNAMED location column (col E, all zeros) is IGNORED entirely (DECISIONS row 22): KIS is a seeded site that simply starts empty. */
const HEADER_ALIAS: Record<string, string> = { bravo: "Bravo", sta: "STA", abc: "ABC", ris: "RIS", abbey: "WA (Abbey)", wa: "WA (Abbey)", "wa (abbey)": "WA (Abbey)", kis: "KIS" };

export interface DemoSeedRow { sheetRow: number; category: string | null; name: string; remark: string | null; balances: Record<string, number> }
export interface DemoSeed { sites: string[]; rows: DemoSeedRow[]; skippedBlank: number; warnings: string[] }

/** Whitespace (incl. newlines and non-breaking spaces) collapsed, trimmed; empty -> null. */
export const tidy = (v: unknown): string | null => {
  const t = String(v ?? "").replace(/[\s ]+/g, " ").trim();
  return t === "" ? null : t;
};

/**
 * The Demo tab (as a grid of cells, row 0 = the first sheet row) -> items + per-site balances.
 * Row 2 of the sheet (index 1) names the location columns; data starts at row 3. Rows with no name are spacers (skipped, counted). A blank / non-numeric balance cell is 0 and not recorded;
 * a negative or fractional one is a warning and is skipped (a stock count cannot be negative). Duplicate names are KEPT as separate items (the sheet is the source).
 */
export function parseDemoGrid(grid: readonly (readonly unknown[])[]): DemoSeed {
  const warnings: string[] = [];
  const header = grid[1] ?? [];
  const columns: { col: number; site: string }[] = [];
  for (let c = 2; c < header.length; c++) {
    const h = tidy(header[c]);
    if (h && h.toLowerCase() === "remark") continue;
    if (h === null) continue; // the unnamed column: ignored (row 22)
    const site = HEADER_ALIAS[h.toLowerCase()];
    if (!site) {
      warnings.push(`unknown column header «${h}» (col ${c + 1}) ignored`);
      continue;
    }
    columns.push({ col: c, site });
  }
  const remarkCol = header.findIndex((h) => tidy(h)?.toLowerCase() === "remark");
  const rows: DemoSeedRow[] = [];
  let skippedBlank = 0;
  for (let r = 2; r < grid.length; r++) {
    const row = grid[r] ?? [];
    const name = tidy(row[1]);
    if (!name) {
      skippedBlank++;
      continue;
    }
    const balances: Record<string, number> = {};
    for (const { col, site } of columns) {
      const v = row[col];
      if (v === null || v === undefined || v === "") continue;
      const n = typeof v === "number" ? v : Number(String(v).trim());
      if (!Number.isFinite(n)) {
        warnings.push(`row ${r + 1}: «${name}» ${site} = ${JSON.stringify(v)} is not a number, skipped`);
        continue;
      }
      if (!Number.isInteger(n) || n < 0) {
        warnings.push(`row ${r + 1}: «${name}» ${site} = ${n} is not a whole number >= 0, skipped`);
        continue;
      }
      if (n > 0) balances[site] = (balances[site] ?? 0) + n;
    }
    rows.push({ sheetRow: r + 1, category: tidy(row[0]), name, remark: remarkCol >= 0 ? tidy(row[remarkCol]) : null, balances });
  }
  return { sites: [...DEMO_SEED_SITES], rows, skippedBlank, warnings };
}

export type DemoMovementType = "MOVE" | "DEFECT_IN" | "WRITE_OFF" | "OPENING";

const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** A real calendar day. */
export const isRealDay = (s: string): boolean => DAY.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
