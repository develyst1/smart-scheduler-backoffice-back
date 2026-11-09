// TASK-915 (REQ-120 R3.6) - Stock DEMO: teaching equipment at SITES, separate from the sale stock. Its own tables (`schema-demo.ts`); it REUSES 904's rule and refusal for a negative balance
// (`refuseIfNegative` / `StockImportRefusal`) and the app's error envelope. No money anywhere, no alerts, no sale<->demo bridge (deferred), no sale-stock inter-branch transfer (15b, parked).
//
//   * balances are stored per (item, site) and moved in the SAME transaction as each movement; a balance can never go below zero (NEGATIVE_BALANCE, nothing written);
//   * every write is ONE transaction with the item row locked FOR UPDATE, idempotent on a client key (`demo:<key>:<n>` is the movement key; a re-POST writes nothing and answers `alreadyApplied`);
//   * the history (`demo_movement`) is never updated or deleted; `occurred_on` is the business day (Bangkok), default today, never in the future;
//   * MOVE site -> site (reason required) · DEFECT_IN a plain +qty at a site, from «Defect Product» (reason required; NOT sale-decrementing) · WRITE_OFF / Delete (reason required):
//     with `siteId` + `qty` it takes that many off that site; without them it zeroes the item at EVERY site and deactivates the item (it leaves the table, the history stays).
import { and, asc, desc, eq, gte, ilike, inArray, lte, or, sql } from "drizzle-orm";
import { db } from "../db";
import { boDemoItem, boDemoMovement, boDemoSite, boDemoStock } from "../db/schema-demo";
import { DEMO_SEED_SITES, isRealDay, type DemoMovementType } from "../lib/demo-stock";
import { ApiException, badRequest, pgErrorCode } from "../lib/http";
import { StockImportRefusal, refuseIfNegative } from "../lib/stock-import";
import { bangkokDate, daysBetween, escapeLike } from "../lib/stock-read";

export interface DemoSiteRow { id: string; name: string; sortOrder: number; active: boolean }
export interface DemoItemRow { id: string; category: string | null; name: string; remark: string | null; active: boolean; saleItemId: string | null }
export interface DemoMovementIn { itemId: string; type: DemoMovementType; qty: number; fromSiteId: string | null; toSiteId: string | null; reason: string | null; actor: string | null; occurredOn: string; idempotencyKey: string }

export interface DemoTx {
  sites(): Promise<DemoSiteRow[]>;
  /** The item row, locked FOR UPDATE for the rest of the transaction (so two writes on one item run one at a time). null = no such item. */
  lockItem(id: string): Promise<DemoItemRow | null>;
  balancesOf(itemId: string): Promise<{ siteId: string; qty: number }[]>;
  setBalance(itemId: string, siteId: string, qty: number): Promise<void>;
  addMovement(m: DemoMovementIn): Promise<void>;
  /** How many movements already carry a key that starts with `prefix`. */
  countKeyPrefix(prefix: string): Promise<number>;
  deactivateItem(id: string): Promise<void>;
  insertSite(name: string, sortOrder: number): Promise<DemoSiteRow>;
  setSiteOrder(ids: string[]): Promise<void>;
}
export interface DemoStore { transaction<T>(fn: (tx: DemoTx) => Promise<T>): Promise<T> }

const KEY = /^[A-Za-z0-9_.-]{8,100}$/;
const nameOf = (v: string, max: number, field: string): string => {
  const t = (v ?? "").replace(/\s+/g, " ").trim();
  if (!t || t.length > max) throw badRequest(`${field} ต้องไม่ว่างและไม่เกิน ${max} ตัวอักษร`, { field });
  return t;
};

export interface WriteResult { occurredOn: string; balances: Record<string, number>; movementsWritten: number; alreadyApplied?: true }

export function createDemoService(store: DemoStore, now: () => Date = () => new Date()) {
  const today = () => bangkokDate(now());
  const day = (d: string | undefined): string => {
    const v = d ?? today();
    if (!isRealDay(v)) throw badRequest("occurredOn ต้องเป็นวันที่ YYYY-MM-DD ที่มีจริง", { field: "occurredOn" });
    if (v > today()) throw badRequest("occurredOn เป็นอนาคต", { field: "occurredOn" });
    return v;
  };
  const checkKey = (k: string) => {
    if (!KEY.test(k ?? "")) throw badRequest("key ต้องเป็น A-Z a-z 0-9 _ . - ยาว 8-100 ตัว", { field: "key" });
  };
  const checkQty = (q: number) => {
    if (!Number.isSafeInteger(q) || q <= 0 || q > 1_000_000) throw badRequest("qty ต้องเป็นจำนวนเต็ม 1-1,000,000", { field: "qty" });
  };
  const needReason = (r: string | undefined): string => {
    const t = (r ?? "").trim();
    if (!t) throw badRequest("ต้องบอกเหตุผล ระบบเก็บประวัติไว้", { field: "reason" });
    if (t.length > 500) throw badRequest("เหตุผลยาวเกิน 500 ตัวอักษร", { field: "reason" });
    return t;
  };
  const balancesAfter = async (tx: DemoTx, itemId: string): Promise<Record<string, number>> => Object.fromEntries((await tx.balancesOf(itemId)).map((b) => [b.siteId, b.qty]));
  const site = (sites: DemoSiteRow[], id: string, field: string): DemoSiteRow => {
    const s = sites.find((x) => x.id === id && x.active);
    if (!s) throw new ApiException(404, "UNKNOWN_SITE", "ไม่พบสถานที่นี้", { field, siteId: id });
    return s;
  };
  const refuse = (item: DemoItemRow, siteId: string, current: number, delta: number): number => {
    try {
      return refuseIfNegative(item.name, item.name, current, delta);
    } catch (e) {
      if (e instanceof StockImportRefusal) throw new ApiException(409, "NEGATIVE_BALANCE", e.message, { itemId: item.id, siteId, name: item.name, resultingBalance: e.resultingBalance });
      throw e;
    }
  };
  /** Runs one write: lock the item, answer a repeat of the same key, then `fn`. A 23505 race (the key index) re-runs once and answers as already applied. */
  const write = async (itemId: string, key: string, fn: (tx: DemoTx, item: DemoItemRow, occurredOn: string) => Promise<{ written: number }>, occurredOn: string, mustBeActive = true): Promise<WriteResult> => {
    const run = () =>
      store.transaction(async (tx) => {
        const item = await tx.lockItem(itemId);
        if (!item) throw new ApiException(404, "UNKNOWN_ITEM", "ไม่พบสินค้า Demo นี้", { itemId });
        const prior = await tx.countKeyPrefix(`demo:${key}:`);
        if (prior > 0) return { occurredOn, balances: await balancesAfter(tx, itemId), movementsWritten: prior, alreadyApplied: true as const };
        if (mustBeActive && !item.active) throw new ApiException(409, "ITEM_INACTIVE", `«${item.name}» ถูกลบออกจากตารางแล้ว`, { itemId });
        const r = await fn(tx, item, occurredOn);
        return { occurredOn, balances: await balancesAfter(tx, itemId), movementsWritten: r.written };
      });
    try {
      return await run();
    } catch (e) {
      if (pgErrorCode(e) === "23505") return run();
      throw e;
    }
  };

  return {
    /** Move `qty` of an item from site A to site B (reason required). Refused (409 NEGATIVE_BALANCE) when A has fewer. */
    async move(i: { key: string; itemId: string; fromSiteId: string; toSiteId: string; qty: number; reason: string; occurredOn?: string }, actor: string | null): Promise<WriteResult> {
      checkKey(i.key);
      checkQty(i.qty);
      const reason = needReason(i.reason);
      if (i.fromSiteId === i.toSiteId) throw badRequest("ต้นทางและปลายทางต้องไม่ซ้ำกัน", { field: "toSiteId" });
      return write(i.itemId, i.key, async (tx, item, on) => {
        const sites = await tx.sites();
        site(sites, i.fromSiteId, "fromSiteId");
        site(sites, i.toSiteId, "toSiteId");
        const have = new Map((await tx.balancesOf(item.id)).map((b) => [b.siteId, b.qty]));
        const fromAfter = refuse(item, i.fromSiteId, have.get(i.fromSiteId) ?? 0, -i.qty); // refused BEFORE anything is written
        await tx.setBalance(item.id, i.fromSiteId, fromAfter);
        await tx.setBalance(item.id, i.toSiteId, (have.get(i.toSiteId) ?? 0) + i.qty);
        await tx.addMovement({ itemId: item.id, type: "MOVE", qty: i.qty, fromSiteId: i.fromSiteId, toSiteId: i.toSiteId, reason, actor, occurredOn: on, idempotencyKey: `demo:${i.key}:1` });
        return { written: 1 };
      }, day(i.occurredOn));
    },

    /** «Defect Product → Demo»: a plain +qty at a site (the piece was never in sellable stock, so nothing is taken from sale stock). Reason required. */
    async defectIn(i: { key: string; itemId: string; toSiteId: string; qty: number; reason: string; occurredOn?: string }, actor: string | null): Promise<WriteResult> {
      checkKey(i.key);
      checkQty(i.qty);
      const reason = needReason(i.reason);
      return write(i.itemId, i.key, async (tx, item, on) => {
        site(await tx.sites(), i.toSiteId, "toSiteId");
        const have = new Map((await tx.balancesOf(item.id)).map((b) => [b.siteId, b.qty]));
        await tx.setBalance(item.id, i.toSiteId, (have.get(i.toSiteId) ?? 0) + i.qty);
        await tx.addMovement({ itemId: item.id, type: "DEFECT_IN", qty: i.qty, fromSiteId: null, toSiteId: i.toSiteId, reason, actor, occurredOn: on, idempotencyKey: `demo:${i.key}:1` });
        return { written: 1 };
      }, day(i.occurredOn));
    },

    /**
     * «Delete» = a write-off with a reason. With `siteId` + `qty`: take that many off that site (409 NEGATIVE_BALANCE if it has fewer). Without them: zero the item at EVERY site
     * (one WRITE_OFF per site that had stock) and deactivate it, so it leaves the table; the history stays.
     */
    async remove(i: { key: string; itemId: string; reason: string; siteId?: string; qty?: number; occurredOn?: string }, actor: string | null): Promise<WriteResult> {
      checkKey(i.key);
      const reason = needReason(i.reason);
      if ((i.siteId === undefined) !== (i.qty === undefined)) throw badRequest("ส่ง siteId และ qty มาด้วยกัน หรือไม่ส่งทั้งคู่ (ลบทั้งรายการ)", { field: "qty" });
      if (i.qty !== undefined) checkQty(i.qty);
      return write(i.itemId, i.key, async (tx, item, on) => {
        const sites = await tx.sites();
        const have = await tx.balancesOf(item.id);
        if (i.siteId !== undefined && i.qty !== undefined) {
          site(sites, i.siteId, "siteId");
          const after = refuse(item, i.siteId, have.find((b) => b.siteId === i.siteId)?.qty ?? 0, -i.qty);
          await tx.setBalance(item.id, i.siteId, after);
          await tx.addMovement({ itemId: item.id, type: "WRITE_OFF", qty: i.qty, fromSiteId: i.siteId, toSiteId: null, reason, actor, occurredOn: on, idempotencyKey: `demo:${i.key}:1` });
          return { written: 1 };
        }
        let n = 0;
        for (const b of have.filter((x) => x.qty > 0)) {
          n++;
          await tx.setBalance(item.id, b.siteId, 0);
          await tx.addMovement({ itemId: item.id, type: "WRITE_OFF", qty: b.qty, fromSiteId: b.siteId, toSiteId: null, reason, actor, occurredOn: on, idempotencyKey: `demo:${i.key}:${n}` });
        }
        await tx.deactivateItem(item.id);
        return { written: n };
      }, day(i.occurredOn));
    },

    /** «Add Location»: a new site, appended last. 409 DUPLICATE_SITE (case-insensitive) when the name exists. */
    async addSite(nameIn: string): Promise<DemoSiteRow> {
      const name = nameOf(nameIn, 60, "name");
      try {
        return await store.transaction(async (tx) => {
          const all = await tx.sites();
          if (all.some((s) => s.name.toLowerCase() === name.toLowerCase())) throw new ApiException(409, "DUPLICATE_SITE", `มีสถานที่ «${name}» อยู่แล้ว`, { name });
          return tx.insertSite(name, all.reduce((m, s) => Math.max(m, s.sortOrder), 0) + 1);
        });
      } catch (e) {
        if (pgErrorCode(e) === "23505") throw new ApiException(409, "DUPLICATE_SITE", `มีสถานที่ «${name}» อยู่แล้ว`, { name });
        throw e;
      }
    },

    /** «Location Order»: the new left-to-right order. `ids` must be EXACTLY the active sites, each once. */
    async orderSites(ids: string[]): Promise<{ ids: string[] }> {
      return store.transaction(async (tx) => {
        const active = (await tx.sites()).filter((s) => s.active).map((s) => s.id);
        if (ids.length !== active.length || new Set(ids).size !== ids.length || ids.some((x) => !active.includes(x))) throw badRequest("ids ต้องเป็นสถานที่ทั้งหมด ไม่ซ้ำ", { field: "ids" });
        await tx.setSiteOrder(ids);
        return { ids };
      });
    },
  };
}

// ───────────────────────────── the Drizzle store ─────────────────────────────

/** `exec` is the global `db`, or a transaction a probe rolls back (a nested `transaction` is then a savepoint). */
export const makeDbDemoStore = (exec: any = db): DemoStore => ({
  transaction: (fn) =>
    exec.transaction(async (tx: any) =>
      fn({
        sites: async () => (await tx.select().from(boDemoSite).orderBy(asc(boDemoSite.sortOrder), asc(boDemoSite.createdAt))).map((r: any) => ({ id: r.id, name: r.name, sortOrder: r.sortOrder, active: r.active })),
        lockItem: async (id) => {
          const [r] = await tx.select().from(boDemoItem).where(eq(boDemoItem.id, id)).limit(1).for("update");
          return r ? { id: r.id, category: r.category, name: r.name, remark: r.remark, active: r.active, saleItemId: r.saleItemId } : null;
        },
        balancesOf: async (itemId) => (await tx.select().from(boDemoStock).where(eq(boDemoStock.demoItemId, itemId))).map((r: any) => ({ siteId: r.siteId, qty: r.qty })),
        setBalance: async (itemId, siteId, qty) => {
          await tx.insert(boDemoStock).values({ demoItemId: itemId, siteId, qty }).onConflictDoUpdate({ target: [boDemoStock.demoItemId, boDemoStock.siteId], set: { qty } });
        },
        addMovement: async (m) => {
          await tx.insert(boDemoMovement).values({ demoItemId: m.itemId, type: m.type, qty: m.qty, fromSiteId: m.fromSiteId, toSiteId: m.toSiteId, reason: m.reason, actor: m.actor, occurredOn: m.occurredOn, idempotencyKey: m.idempotencyKey });
        },
        countKeyPrefix: async (prefix) => {
          const r = await tx.select({ id: boDemoMovement.id }).from(boDemoMovement).where(sql`${boDemoMovement.idempotencyKey} like ${`${prefix.replace(/[\\%_]/g, (c: string) => `\\${c}`)}%`}`);
          return r.length;
        },
        deactivateItem: async (id) => {
          await tx.update(boDemoItem).set({ active: false }).where(eq(boDemoItem.id, id));
        },
        insertSite: async (name, sortOrder) => {
          const [r] = await tx.insert(boDemoSite).values({ name, sortOrder }).returning();
          return { id: r.id, name: r.name, sortOrder: r.sortOrder, active: r.active };
        },
        setSiteOrder: async (ids) => {
          for (let i = 0; i < ids.length; i++) await tx.update(boDemoSite).set({ sortOrder: i }).where(eq(boDemoSite.id, ids[i]!));
        },
      }),
    ),
});

export const demoService = createDemoService(makeDbDemoStore());

// ───────────────────────────── the reads (admin-safe: no money exists here) ─────────────────────────────

export async function listDemoSites(exec: any = db) {
  const rows = await exec.select().from(boDemoSite).where(eq(boDemoSite.active, true)).orderBy(asc(boDemoSite.sortOrder), asc(boDemoSite.createdAt));
  return { sites: rows.map((r: any) => ({ id: r.id, name: r.name, sortOrder: r.sortOrder })) };
}

/** The matrix the screen draws: sites (left to right) and, per ACTIVE item, its balance at each site plus the total. `q` searches name / category / remark. */
export async function listDemoStock(query: { q?: string; category?: string }, exec: any = db) {
  const { sites } = await listDemoSites(exec);
  const term = query.q?.trim();
  const items = await exec
    .select()
    .from(boDemoItem)
    .where(and(eq(boDemoItem.active, true), query.category ? eq(boDemoItem.category, query.category) : undefined, term ? or(ilike(boDemoItem.name, `%${escapeLike(term)}%`), ilike(boDemoItem.category, `%${escapeLike(term)}%`), ilike(boDemoItem.remark, `%${escapeLike(term)}%`)) : undefined))
    .orderBy(asc(boDemoItem.sortOrder), asc(boDemoItem.createdAt));
  const ids: string[] = items.map((i: any) => i.id);
  const stock = ids.length ? await exec.select().from(boDemoStock).where(inArray(boDemoStock.demoItemId, ids)) : [];
  const by = new Map<string, Record<string, number>>();
  for (const s of stock) by.set(s.demoItemId, { ...(by.get(s.demoItemId) ?? {}), [s.siteId]: s.qty });
  return {
    sites,
    items: items.map((i: any) => {
      const balances = Object.fromEntries(sites.map((s: any) => [s.id, by.get(i.id)?.[s.id] ?? 0]));
      return { id: i.id, category: i.category, name: i.name, remark: i.remark, saleItemId: i.saleItemId, balances, total: Object.values(balances).reduce((a: number, b: any) => a + b, 0) };
    }),
  };
}

export interface DemoMovementQuery { from: string; to: string; siteId?: string; type?: DemoMovementType; q?: string; limit: number }
/** The ± history (newest first): who / when / from -> to / reason. The window is on the business day, inclusive, at most 366 days. */
export async function listDemoMovements(query: DemoMovementQuery, exec: any = db) {
  const span = daysBetween(query.from, query.to);
  if (span === null) throw badRequest("from / to ต้องเป็นวันที่ YYYY-MM-DD ที่มีจริง");
  if (span < 0) throw badRequest("from ต้องไม่เกิน to");
  if (span > 365) throw badRequest("ช่วงวันที่ต้องไม่เกิน 366 วัน");
  const term = query.q?.trim();
  const rows = await exec
    .select({
      id: boDemoMovement.id, occurredOn: boDemoMovement.occurredOn, type: boDemoMovement.type, qty: boDemoMovement.qty, reason: boDemoMovement.reason, actor: boDemoMovement.actor,
      itemId: boDemoMovement.demoItemId, itemName: boDemoItem.name, fromSiteId: boDemoMovement.fromSiteId, toSiteId: boDemoMovement.toSiteId,
    })
    .from(boDemoMovement)
    .innerJoin(boDemoItem, eq(boDemoItem.id, boDemoMovement.demoItemId))
    .where(
      and(
        gte(boDemoMovement.occurredOn, query.from),
        lte(boDemoMovement.occurredOn, query.to),
        query.type ? eq(boDemoMovement.type, query.type) : undefined,
        query.siteId ? or(eq(boDemoMovement.fromSiteId, query.siteId), eq(boDemoMovement.toSiteId, query.siteId)) : undefined,
        term ? ilike(boDemoItem.name, `%${escapeLike(term)}%`) : undefined,
      ),
    )
    .orderBy(desc(boDemoMovement.occurredOn), desc(boDemoMovement.createdAt))
    .limit(query.limit);
  const siteIds = [...new Set(rows.flatMap((r: any) => [r.fromSiteId, r.toSiteId]).filter(Boolean))] as string[];
  const names = new Map<string, string>(siteIds.length ? (await exec.select({ id: boDemoSite.id, name: boDemoSite.name }).from(boDemoSite).where(inArray(boDemoSite.id, siteIds))).map((s: any) => [s.id, s.name]) : []);
  return {
    items: rows.map((r: any) => ({
      id: r.id, occurredOn: r.occurredOn, who: r.actor, itemId: r.itemId, itemName: r.itemName, type: r.type as DemoMovementType, qty: r.qty, reason: r.reason,
      from: r.type === "DEFECT_IN" ? "Defect Product" : r.type === "OPENING" ? "Opening" : (names.get(r.fromSiteId) ?? null),
      to: r.type === "WRITE_OFF" ? "Deleted" : (names.get(r.toSiteId) ?? null),
    })),
  };
}

export { DEMO_SEED_SITES };
