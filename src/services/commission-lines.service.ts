// TASK-921 (REQ-120 R1.2 / R1.3) — Commission distribution: the period's product-sale lines → commission pay lines. The rules are in `lib/commission-split.ts`; this file reads the sales, the profiles and the
// slips, and writes through its OWN small store on migration 0011's partial unique index (the 867 / 868 / 887 pattern) — never Team A's `insertLine`.
//
//   • the sale lines of a period are those whose Bangkok `sold_at` DATE is inside the R1.4 period range (DECISIONS row 18); the amount is `commission_minor` AS STORED;
//   • a person's type for a sale is `roleOfDay(profile, the sale's Bangkok date)`;
//   • OWN lines: one `kind 'commission'`, `source 'auto'` line per (sale line, seller), `source_ref cm:<saleLineId>:<teacherId>`, INSERT … ON CONFLICT DO NOTHING; a line that exists with another amount / label is
//     REPORT-ONLY (`changed`), never rewritten;
//   • POOL lines: one per FT per period, `source_ref cm-pool:<periodId>:<teacherId>`; the pool grows as sales arrive, so while the slip is a DRAFT the line is UPSERTED (amount + label); a confirmed / locked slip is
//     left as it is and listed;
//   • a locked period ⇒ 409 LOCKED; never creates a slip; a slip that is not a draft is skipped and listed (and the SQL itself refuses to write into a non-draft slip: defence in depth);
//   • a notification (TASK-920's \`notifyCommission\`, no money) for each NEWLY inserted line; a failure is counted, never thrown.
import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import { boItem, boPaySlipLine, boSale, boSaleLine } from "../db/schema";
import { conflict } from "../lib/http";
import { ownLabel, ownRef, poolLabel, poolRef, poolSplit, splitLine, type SkipReason } from "../lib/commission-split";
import { effectiveRoles, roleOfDay } from "../lib/role-of-day";
import { numericFromSatang, satangFromNumeric } from "../lib/satang";
import { dbSalaryStore } from "./salary-db.store";
import { notifyCommission, realNotify, type NotifyFn } from "./salary-notify";
import type { SalaryService, SalaryStore } from "./salary.service";

export interface SaleLineRow {
  saleLineId: string;
  soldOn: string; // the sale's Bangkok date
  commissionMinor: number; // the LINE total, as stored
  productName: string;
  groupName: string | null; // bo.item.commission_group
  sellerRefs: string[]; // teacher ids, as given at the sale (unvalidated)
}
export interface ExistingCommissionLine { id: string; slipId: string; sourceRef: string; label: string; amountSatang: number }
export type CommissionSkip = { saleLineId: string | null; teacherId: string | null; reason: SkipReason | "NO_SELLER" | "NO_SLIP" | "SLIP_NOT_DRAFT"; amountMinor: number };

export interface CommissionSaleStore { listSaleLines(range: { from: string; to: string }): Promise<SaleLineRow[]> }
export interface CommissionLineStore {
  listAutoCommissionLines(slipIds: string[]): Promise<ExistingCommissionLine[]>;
  /** ON CONFLICT DO NOTHING, and only into a DRAFT slip. Returns the new line's id, or null when it exists already / the slip is not a draft. */
  insertOwn(l: { slipId: string; sourceRef: string; label: string; amountSatang: number }, actor: string): Promise<string | null>;
  /** Insert-or-update (amount + label) of a pool line, only while its slip is a DRAFT. */
  upsertPool(l: { slipId: string; sourceRef: string; label: string; amountSatang: number }, actor: string): Promise<{ id: string; inserted: boolean } | null>;
}

export interface CommissionResult {
  written: number;
  updatedPool: number;
  unchanged: number;
  skipped: CommissionSkip[];
  changed: { slipId: string; sourceRef: string; was: { label: string; amountSatang: number }; now: { label: string; amountSatang: number } }[];
  poolUnpaid?: number;
  notifyFailed?: number;
}

const locked = () => conflict("LOCKED", "งวดนี้ถูกล็อกแล้ว แก้ไขไม่ได้");

export interface CommissionDeps {
  salary: Pick<SalaryService, "getPeriod">;
  profiles: Pick<SalaryStore, "getProfile">;
  sales: CommissionSaleStore;
  lines: CommissionLineStore;
  notify?: NotifyFn;
  names?: (ids: string[]) => Promise<Map<string, string>>;
  today?: () => string;
}

export async function applyCommissionLines(periodId: string, actor: string, deps: CommissionDeps): Promise<CommissionResult> {
  const overview = await deps.salary.getPeriod(periodId); // 404 if unknown; applies the lazy 12:00 lock first
  if (overview.period.status === "locked") throw locked();
  const { periodStart, periodEnd, year, month } = overview.period;
  if (!periodStart || !periodEnd) throw conflict("NO_RANGE", "งวดนี้ไม่มีช่วงวันที่ (period_start / period_end)");

  const rows = await deps.sales.listSaleLines({ from: periodStart, to: periodEnd });
  const slipOf = new Map(overview.slips.map((s) => [s.teacherId, { id: s.id, status: s.status }]));
  const existing = await deps.lines.listAutoCommissionLines(overview.slips.map((s) => s.id));
  const have = new Map(existing.map((l) => [`${l.slipId}|${l.sourceRef}`, l]));

  const profileCache = new Map<string, Awaited<ReturnType<SalaryStore["getProfile"]>>>();
  const profileOf = async (id: string) => {
    if (!profileCache.has(id)) profileCache.set(id, await deps.profiles.getProfile(id));
    return profileCache.get(id);
  };

  const res: CommissionResult = { written: 0, updatedPool: 0, unchanged: 0, skipped: [], changed: [] };
  let notifyFailed = 0;
  const day = (deps.today ?? (() => new Date().toISOString().slice(0, 10)))();
  const coachNames = deps.names ? await deps.names([...new Set([...overview.slips.map((s) => s.teacherId)])]) : new Map<string, string>();

  // 1) split every sale line
  type Own = { teacherId: string; ref: string; label: string; amountSatang: number; soldOn: string; product: string };
  const owns: Own[] = [];
  let poolMinor = 0;
  for (const r of rows) {
    if (r.commissionMinor <= 0) continue;
    if (!r.sellerRefs.length) { res.skipped.push({ saleLineId: r.saleLineId, teacherId: null, reason: "NO_SELLER", amountMinor: r.commissionMinor }); continue; }
    const sellers = await Promise.all(
      r.sellerRefs.map(async (teacherId) => {
        const p = await profileOf(teacherId);
        return { teacherId, type: p ? roleOfDay(p, r.soldOn) : null };
      }),
    );
    const s = splitLine({ amountMinor: r.commissionMinor, sellers, groupName: r.groupName });
    for (const k of s.skipped) res.skipped.push({ saleLineId: r.saleLineId, teacherId: k.teacherId, reason: k.reason, amountMinor: k.amountMinor });
    poolMinor += s.toPool;
    for (const o of s.own) if (o.amountMinor > 0) owns.push({ teacherId: o.teacherId, ref: ownRef(r.saleLineId, o.teacherId), label: ownLabel(r.productName, r.soldOn), amountSatang: o.amountMinor, soldOn: r.soldOn, product: r.productName });
  }

  // 2) own lines: write what is missing, report what differs, skip what cannot be written
  for (const o of owns) {
    const slip = slipOf.get(o.teacherId);
    if (!slip) { res.skipped.push({ saleLineId: o.ref.split(":")[1] ?? null, teacherId: o.teacherId, reason: "NO_SLIP", amountMinor: o.amountSatang }); continue; }
    const cur = have.get(`${slip.id}|${o.ref}`);
    if (cur) {
      if (cur.amountSatang === o.amountSatang && cur.label === o.label) res.unchanged++;
      else res.changed.push({ slipId: slip.id, sourceRef: o.ref, was: { label: cur.label, amountSatang: cur.amountSatang }, now: { label: o.label, amountSatang: o.amountSatang } });
      continue;
    }
    if (slip.status !== "draft") { res.skipped.push({ saleLineId: o.ref.split(":")[1] ?? null, teacherId: o.teacherId, reason: "SLIP_NOT_DRAFT", amountMinor: o.amountSatang }); continue; }
    const id = await deps.lines.insertOwn({ slipId: slip.id, sourceRef: o.ref, label: o.label, amountSatang: o.amountSatang }, actor);
    if (id === null) { res.unchanged++; continue; } // raced: somebody wrote it first
    res.written++;
    notifyFailed += (await notifyCommission(deps.notify, { lineId: id, coach: coachNames.get(o.teacherId) ?? null, day: o.soldOn, detail: o.product })).failed;
  }

  // 3) the FT pool: every FT of the period (a mid-period joiner included) gets an equal share, recomputed each apply
  const ftIds: string[] = [];
  for (const s of overview.slips) {
    const p = await profileOf(s.teacherId);
    if (p && effectiveRoles(p).includes("FT")) ftIds.push(s.teacherId);
  }
  ftIds.sort();
  const { shares, unpaid } = poolSplit(poolMinor, ftIds);
  if (unpaid > 0) res.poolUnpaid = unpaid;
  const label = poolLabel(year, month);
  for (const sh of shares) {
    const slip = slipOf.get(sh.teacherId)!;
    const ref = poolRef(periodId, sh.teacherId);
    const cur = have.get(`${slip.id}|${ref}`);
    if (!cur && sh.amountMinor === 0) continue; // never write a zero pool line
    if (cur && cur.amountSatang === sh.amountMinor && cur.label === label) { res.unchanged++; continue; }
    if (slip.status !== "draft") {
      if (cur) res.changed.push({ slipId: slip.id, sourceRef: ref, was: { label: cur.label, amountSatang: cur.amountSatang }, now: { label, amountSatang: sh.amountMinor } });
      else res.skipped.push({ saleLineId: null, teacherId: sh.teacherId, reason: "SLIP_NOT_DRAFT", amountMinor: sh.amountMinor });
      continue;
    }
    const r = await deps.lines.upsertPool({ slipId: slip.id, sourceRef: ref, label, amountSatang: sh.amountMinor }, actor);
    if (r === null) { res.unchanged++; continue; }
    if (r.inserted) {
      res.written++;
      notifyFailed += (await notifyCommission(deps.notify, { lineId: r.id, coach: coachNames.get(sh.teacherId) ?? null, day, detail: "Full-time pool" })).failed;
    } else res.updatedPool++;
  }
  if (notifyFailed) res.notifyFailed = notifyFailed;
  return res;
}

// ───────────────────────────────── the real stores ─────────────────────────────────

export function dbCommissionSaleStore(exec: any = db): CommissionSaleStore {
  return {
    async listSaleLines({ from, to }) {
      const day = sql<string>`to_char(${boSale.soldAt} at time zone 'Asia/Bangkok', 'YYYY-MM-DD')`;
      const rows = (await exec
        .select({ id: boSaleLine.id, commission: boSaleLine.commissionMinor, soldOn: day, sellers: boSale.sellerRefs, name: boItem.name, group: boItem.commissionGroup })
        .from(boSaleLine)
        .innerJoin(boSale, eq(boSale.id, boSaleLine.saleId))
        .innerJoin(boItem, eq(boItem.id, boSaleLine.itemId))
        .where(and(gt(boSaleLine.commissionMinor, 0), sql`${day} >= ${from}`, sql`${day} <= ${to}`))
        .orderBy(asc(boSale.soldAt), asc(boSaleLine.id))) as Array<{ id: string; commission: number; soldOn: string; sellers: unknown; name: string; group: string | null }>;
      return rows.map((r) => ({ saleLineId: r.id, soldOn: r.soldOn, commissionMinor: r.commission, productName: r.name, groupName: r.group, sellerRefs: Array.isArray(r.sellers) ? (r.sellers as unknown[]).map(String) : [] }));
    },
  };
}

export function dbCommissionLineStore(exec: any = db): CommissionLineStore {
  const guard = (slipId: string) => sql`exists (select 1 from bo.pay_slip where id = ${slipId}::uuid and status = 'draft')`;
  return {
    async listAutoCommissionLines(slipIds) {
      if (!slipIds.length) return [];
      const rows = (await exec
        .select()
        .from(boPaySlipLine)
        .where(and(inArray(boPaySlipLine.slipId, [...slipIds]), eq(boPaySlipLine.kind, "commission"), eq(boPaySlipLine.source, "auto")))) as Array<typeof boPaySlipLine.$inferSelect>;
      return rows.filter((r) => r.sourceRef).map((r) => ({ id: r.id, slipId: r.slipId, sourceRef: r.sourceRef!, label: r.label, amountSatang: satangFromNumeric(r.amount) }));
    },
    async insertOwn(l, actor) {
      const rows = (await exec.execute(
        sql`insert into bo.pay_slip_line (slip_id, kind, label, amount, source, source_ref, created_by)
            select ${l.slipId}::uuid, 'commission'::bo.pay_line_kind, ${l.label}, ${numericFromSatang(l.amountSatang)}::numeric, 'auto'::bo.pay_line_source, ${l.sourceRef}, ${actor}
            where ${guard(l.slipId)}
            on conflict (slip_id, kind, source_ref) where source = 'auto' do nothing
            returning id::text as id`,
      )) as Array<{ id: string }>;
      return rows[0]?.id ?? null;
    },
    async upsertPool(l, actor) {
      const rows = (await exec.execute(
        sql`insert into bo.pay_slip_line (slip_id, kind, label, amount, source, source_ref, created_by)
            select ${l.slipId}::uuid, 'commission'::bo.pay_line_kind, ${l.label}, ${numericFromSatang(l.amountSatang)}::numeric, 'auto'::bo.pay_line_source, ${l.sourceRef}, ${actor}
            where ${guard(l.slipId)}
            on conflict (slip_id, kind, source_ref) where source = 'auto'
            do update set amount = excluded.amount, label = excluded.label, updated_at = now()
              where bo.pay_slip_line.amount is distinct from excluded.amount or bo.pay_slip_line.label is distinct from excluded.label
            returning id::text as id, (xmax = 0) as inserted`,
      )) as Array<{ id: string; inserted: boolean }>;
      return rows[0] ? { id: rows[0].id, inserted: Boolean(rows[0].inserted) } : null;
    },
  };
}

/** The production wiring (the route calls this): the real sales, the real profiles, the real line store, the real notifier. */
export function applyCommissionLinesFor(salary: Pick<SalaryService, "getPeriod">, periodId: string, actor: string): Promise<CommissionResult> {
  return applyCommissionLines(periodId, actor, { salary, profiles: dbSalaryStore, sales: dbCommissionSaleStore(), lines: dbCommissionLineStore(), notify: realNotify, names: (ids) => dbSalaryStore.teacherNames(ids) });
}
