// TASK-919 (REQ-120 R3.7) — the Low-Stock half: the per-type thresholds store (`bo.low_stock_threshold`, created and seeded by migration 0020 — no migration here), the computation, and the
// Monday job. The notification store is Jason's (TASK-917): this file calls his seam, it does not duplicate it.
//
//   • thresholds: read = the whole map (the table's rows; never saved ⇒ the defaults); write = the WHOLE map, replacing the table in one transaction (the seam of TASK-913: `getLowStockThresholds`
//     / `setLowStockThresholds`); invalid input is a 400 listing every problem;
//   • the list: the sale products low against those thresholds (stock products only — demo stock is never read);
//   • the weekly job: ONE notification per recipient of type «Low Stock» (`recipientsForType`), keyed `low-stock:<ISO week>` so a re-run the same week writes nothing (`createNotification` is idempotent
//     on (recipient, key)); NOTHING is written when nothing is low; all in one transaction.
import { db } from "../db";
import { boLowStockThreshold } from "../db/schema-notification";
import { badRequest } from "../lib/http";
import { DEFAULT_LOW_STOCK_THRESHOLDS, isoWeekOf, lowStockRows, lowStockText, parseThresholds, weeklyKey, type LowInput, type LowRow, type Thresholds } from "../lib/low-stock";
import { bangkokDate } from "../lib/stock-read";
import { createNotification, recipientsForType } from "./notification.service";
import { readProducts } from "./stock-import.service";

export interface LowStockStore {
  thresholds(): Promise<Thresholds | null>; // null = nothing saved yet
  replaceThresholds(map: Thresholds, by: string | null): Promise<void>;
  products(): Promise<LowInput[]>;
  /** The job's one transaction: the rows, the recipients and the notifier all see the SAME executor. */
  transaction<T>(fn: (tx: { products(): Promise<LowInput[]>; thresholds(): Promise<Thresholds | null>; exec: unknown }) => Promise<T>): Promise<T>;
}

const toInput = (p: { id: string; model: string; name: string; category: string | null; qty: number | null; active: boolean }): LowInput => ({ id: p.id, model: p.model, name: p.name, category: p.category, qty: p.qty, active: p.active });

async function readThresholds(exec: any): Promise<Thresholds | null> {
  const rows = (await exec.select().from(boLowStockThreshold)) as Array<{ type: string; threshold: number | null }>;
  if (!rows.length) return null;
  return Object.fromEntries(rows.map((r) => [r.type, r.threshold]));
}

export const dbLowStockStore: LowStockStore = {
  thresholds: () => readThresholds(db),
  products: async () => (await readProducts(db, false)).map(toInput),
  replaceThresholds: (map, by) =>
    db.transaction(async (tx: any) => {
      await tx.delete(boLowStockThreshold);
      const rows = Object.entries(map).map(([type, threshold]) => ({ type, threshold, updatedBy: by }));
      if (rows.length) await tx.insert(boLowStockThreshold).values(rows);
    }),
  transaction: (fn) =>
    db.transaction(async (tx: any) =>
      fn({ products: async () => (await readProducts(tx, false)).map(toInput), thresholds: () => readThresholds(tx), exec: tx }),
    ),
};

export interface Notifier {
  recipientsForType(type: "Low Stock", exec: unknown): Promise<string[]>;
  createNotification(exec: unknown, n: { recipientRef: string; type: "Low Stock"; text: string; occurredOn: string; key: string }): Promise<boolean>;
}
const jasonsSeam: Notifier = { recipientsForType: (t, e) => recipientsForType(t, e), createNotification: (e, n) => createNotification(e, n) };

export interface WeeklyResult { week: string; low: number; recipients: number; posted: number; alreadyPosted: number }

export function createLowStockService(store: LowStockStore = dbLowStockStore, notifier: Notifier = jasonsSeam, now: () => Date = () => new Date()) {
  const effective = (saved: Thresholds | null): Thresholds => saved ?? { ...DEFAULT_LOW_STOCK_THRESHOLDS };
  return {
    /** The whole map (never saved ⇒ the R3.7 defaults). */
    async getThresholds(): Promise<Thresholds> {
      return effective(await store.thresholds());
    },
    /** Replace the whole map. Every problem is reported at once (400); nothing is written on a bad map. */
    async setThresholds(input: unknown, by: string | null): Promise<Thresholds> {
      const { value, issues } = parseThresholds(input);
      if (issues.length) throw badRequest(`${issues.length} threshold(s) are invalid`, { issues });
      // an EMPTY map would empty the table, and an empty table reads as «never saved» (the defaults) — so it is refused: to switch a type off, send it with a null level
      if (!Object.keys(value).length) throw badRequest("send at least one type (use a null level for «no alert»)", { issues: [{ key: "", message: "an empty map" }] });
      await store.replaceThresholds(value, by);
      return value;
    },
    /** The sale products that are low now. */
    async lowList(): Promise<{ items: LowRow[] }> {
      return { items: lowStockRows(await store.products(), effective(await store.thresholds())) };
    },
    /** The Monday job. Idempotent per ISO week; writes nothing when nothing is low. */
    async runWeekly(): Promise<WeeklyResult> {
      const today = bangkokDate(now());
      const week = isoWeekOf(today);
      return store.transaction(async (tx) => {
        const rows = lowStockRows(await tx.products(), effective(await tx.thresholds()));
        if (!rows.length) return { week, low: 0, recipients: 0, posted: 0, alreadyPosted: 0 };
        const people = await notifier.recipientsForType("Low Stock", tx.exec);
        const text = lowStockText(rows);
        let posted = 0;
        for (const recipientRef of people) {
          if (await notifier.createNotification(tx.exec, { recipientRef, type: "Low Stock", text, occurredOn: today, key: weeklyKey(week) })) posted++;
        }
        return { week, low: rows.length, recipients: people.length, posted, alreadyPosted: people.length - posted };
      });
    },
  };
}

export const lowStockService = createLowStockService();
