// TASK-919 (REQ-120 R3.7) — Low Stock, PURE: the per-type thresholds (validation + defaults), the low-stock rule, the ISO-week key and the notification text. No database here.
//
//   • a threshold is per TYPE = the product's Category (the label the 904 import attaches), matched by its EXACT name (trimmed, case-insensitive); a type with NO threshold (absent or null) is NEVER low,
//     so an unconfigured category cannot flood the list;
//   • a SALE product is low when its quantity ≤ the threshold of its category (exactly at the level is low; 0 is low whenever the type HAS a level); inactive products and products with no tracked
//     balance are skipped. Demo stock is a different population (never read here) — R3.6: no alerts for demo;
//   • no money anywhere: rows and text carry model, name, category, quantity, level — never a price.
export const DEFAULT_LOW_STOCK_THRESHOLDS: Readonly<Record<string, number>> = { "F&B": 10, Safety: 1, Miller: 5, Sock: 1, Shirt: 1 };

/** The whole map the seam reads and writes: type → whole number ≥ 0, or null = no alert. */
export type Thresholds = Record<string, number | null>;

export interface ThresholdIssue { key: string; message: string }
export const MAX_TYPES = 200;
export const MAX_LEVEL = 1_000_000_000;

/** A threshold map from untrusted input: every problem collected (never thrown), keys trimmed, case-insensitive duplicates refused. */
export function parseThresholds(input: unknown): { value: Thresholds; issues: ThresholdIssue[] } {
  const issues: ThresholdIssue[] = [];
  const value: Thresholds = {};
  if (!input || typeof input !== "object" || Array.isArray(input)) return { value, issues: [{ key: "", message: "thresholds must be an object of type → level" }] };
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length > MAX_TYPES) return { value, issues: [{ key: "", message: `at most ${MAX_TYPES} types` }] };
  const seen = new Map<string, string>();
  for (const [raw, v] of entries) {
    const key = raw.trim();
    if (!key) { issues.push({ key: raw, message: "a type name is empty" }); continue; }
    if (key.length > 100) { issues.push({ key, message: "a type name is longer than 100 characters" }); continue; }
    const k = key.toLowerCase();
    if (seen.has(k)) { issues.push({ key, message: `«${key}» repeats «${seen.get(k)}»` }); continue; }
    seen.set(k, key);
    if (v === null) { value[key] = null; continue; }
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > MAX_LEVEL) { issues.push({ key, message: `the level of «${key}» must be a whole number, 0 or more (or null for no alert)` }); continue; }
    value[key] = v;
  }
  return { value, issues };
}

/** A product as the rule reads it (the stock products read of 904, no money). */
export interface LowInput { id: string; model: string; name: string; category: string | null; qty: number | null; active: boolean }
export interface LowRow { id: string; code: string; name: string; category: string; quantity: number; threshold: number; under: number }

const norm = (s: string) => s.trim().toLowerCase();

export function lowStockRows(products: LowInput[], thresholds: Thresholds): LowRow[] {
  const level = new Map<string, number>();
  for (const [k, v] of Object.entries(thresholds)) if (v !== null && v !== undefined) level.set(norm(k), v);
  const out: LowRow[] = [];
  for (const p of products) {
    if (!p.active || p.qty === null || !p.category) continue;
    const t = level.get(norm(p.category));
    if (t === undefined || p.qty > t) continue;
    out.push({ id: p.id, code: p.model, name: p.name, category: p.category, quantity: p.qty, threshold: t, under: t - p.qty });
  }
  return out.sort((a, b) => a.category.localeCompare(b.category) || b.under - a.under || a.name.localeCompare(b.name));
}

/** The ISO-8601 week of a calendar day (YYYY-MM-DD), as `YYYY-Www` — the week the Monday job's notifications are keyed on. */
export function isoWeekOf(ymd: string): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
  d.setUTCDate(d.getUTCDate() - dow + 3); // the Thursday of this week decides the year
  const year = d.getUTCFullYear();
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const week = 1 + Math.round(((d.getTime() - jan4.getTime()) / 86_400_000 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}
export const weeklyKey = (week: string) => `low-stock:${week}`;

export const TEXT_LIST_MAX = 8;
/** ONE notification per recipient per week: how many are low, then the first few (code, name, quantity ≤ level). No money. */
export function lowStockText(rows: LowRow[]): string {
  const head = `${rows.length} product${rows.length === 1 ? " is" : "s are"} low on stock`;
  const shown = rows.slice(0, TEXT_LIST_MAX).map((r) => `${r.code} ${r.name} (${r.quantity} ≤ ${r.threshold})`);
  const more = rows.length > TEXT_LIST_MAX ? `, and ${rows.length - TEXT_LIST_MAX} more` : "";
  return `${head}: ${shown.join("; ")}${more}`;
}
