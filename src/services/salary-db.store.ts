// The Drizzle implementation of SalaryStore (SPEC-100). `numeric(14,2)` baht ⇄ integer satang through `lib/satang.ts`.
// A factory over an executor so a probe can run the REAL store inside a transaction it then rolls back (leaving no rows).
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import { boFlRate, boPayPeriod, boPaySlip, boPaySlipLine, boSalaryProfile } from "../db/schema";
import type { AutoLine } from "../lib/pay-rules";
import { numericFromSatang, satangFromNumeric } from "../lib/satang";
import type { FlRate, Line, Period, Profile, SalaryStore, Slip } from "./salary.service";

const period = (r: typeof boPayPeriod.$inferSelect): Period => ({ id: r.id, year: r.year, month: r.month, periodStart: r.periodStart, periodEnd: r.periodEnd, status: r.status, lockAt: r.lockAt, lockedAt: r.lockedAt });
const slip = (r: typeof boPaySlip.$inferSelect): Slip => ({ id: r.id, periodId: r.periodId, teacherId: r.teacherId, baseSatang: satangFromNumeric(r.baseAmount), status: r.status });
const line = (r: typeof boPaySlipLine.$inferSelect): Line => ({ id: r.id, slipId: r.slipId, kind: r.kind, label: r.label, amountSatang: satangFromNumeric(r.amount), source: r.source, createdBy: r.createdBy, sourceRef: r.sourceRef, classType: r.classType });
const profile = (r: typeof boSalaryProfile.$inferSelect): Profile => ({
  teacherId: r.teacherId,
  employmentType: r.employmentType,
  roles: r.roles,
  baseSatang: r.baseSalary === null ? null : satangFromNumeric(r.baseSalary),
  meritEligible: r.meritEligible,
  vehicle: r.vehicle,
  active: r.active,
});

/** `exec` is the global `db`, or a transaction cast to it (a nested `transaction` is then a savepoint). */
export function makeDbSalaryStore(exec: typeof db = db): SalaryStore {
  return {
    async listPeriods() {
      return (await exec.select().from(boPayPeriod).orderBy(desc(boPayPeriod.year), desc(boPayPeriod.month))).map(period);
    },
    async getPeriod(id) {
      const [r] = await exec.select().from(boPayPeriod).where(eq(boPayPeriod.id, id)).limit(1);
      return r && period(r);
    },
    async getPeriodByYearMonth(year, month) {
      const [r] = await exec.select().from(boPayPeriod).where(and(eq(boPayPeriod.year, year), eq(boPayPeriod.month, month))).limit(1);
      return r && period(r);
    },
    async insertPeriod(p) {
      const [r] = await exec.insert(boPayPeriod).values({ year: p.year, month: p.month, lockAt: p.lockAt, periodStart: p.periodStart, periodEnd: p.periodEnd }).returning();
      return period(r!);
    },
    async lockPeriod(id, at) {
      return exec.transaction(async (tx) => {
        await tx.update(boPayPeriod).set({ status: "locked", lockedAt: at }).where(and(eq(boPayPeriod.id, id), eq(boPayPeriod.status, "open")));
        await tx.update(boPaySlip).set({ status: "locked" }).where(eq(boPaySlip.periodId, id));
        const [r] = await tx.select().from(boPayPeriod).where(eq(boPayPeriod.id, id)).limit(1);
        return period(r!);
      });
    },
    async listProfiles() {
      return (await exec.select().from(boSalaryProfile).orderBy(asc(boSalaryProfile.createdAt), asc(boSalaryProfile.id))).map(profile);
    },
    async getProfile(teacherId) {
      const [r] = await exec.select().from(boSalaryProfile).where(eq(boSalaryProfile.teacherId, teacherId)).limit(1);
      return r && profile(r);
    },
    async upsertProfile(p) {
      const values = {
        teacherId: p.teacherId,
        employmentType: p.employmentType,
        roles: p.roles,
        baseSalary: p.baseSatang === null ? null : numericFromSatang(p.baseSatang),
        meritEligible: p.meritEligible,
        vehicle: p.vehicle,
        active: p.active,
      };
      const [r] = await exec
        .insert(boSalaryProfile)
        .values(values)
        .onConflictDoUpdate({
          target: boSalaryProfile.teacherId,
          set: { employmentType: values.employmentType, roles: values.roles, baseSalary: values.baseSalary, meritEligible: values.meritEligible, vehicle: values.vehicle, active: values.active },
        })
        .returning();
      return profile(r!);
    },
    async listFlRates(teacherId) {
      const rows = await exec
        .select({ classType: boFlRate.classType, rate: boFlRate.rate })
        .from(boFlRate)
        .innerJoin(boSalaryProfile, eq(boSalaryProfile.id, boFlRate.profileId))
        .where(eq(boSalaryProfile.teacherId, teacherId));
      return rows.map((r): FlRate => ({ classType: r.classType, rateSatang: satangFromNumeric(r.rate) }));
    },
    async upsertFlRate(teacherId, classType, rateSatang) {
      const [prof] = await exec.select({ id: boSalaryProfile.id }).from(boSalaryProfile).where(eq(boSalaryProfile.teacherId, teacherId)).limit(1);
      if (!prof) return undefined;
      const rate = numericFromSatang(rateSatang);
      const [r] = await exec
        .insert(boFlRate)
        .values({ profileId: prof.id, classType, rate })
        .onConflictDoUpdate({ target: [boFlRate.profileId, boFlRate.classType], set: { rate } })
        .returning();
      return { classType: r!.classType, rateSatang: satangFromNumeric(r!.rate) };
    },
    async listSlips(periodId) {
      return (await exec.select().from(boPaySlip).where(eq(boPaySlip.periodId, periodId)).orderBy(asc(boPaySlip.createdAt), asc(boPaySlip.id))).map(slip);
    },
    async getSlip(id) {
      const [r] = await exec.select().from(boPaySlip).where(eq(boPaySlip.id, id)).limit(1);
      return r && slip(r);
    },
    async upsertDraftSlip(periodId, teacherId, baseSatang) {
      const base = numericFromSatang(baseSatang);
      return exec.transaction(async (tx) => {
        const inserted = await tx.insert(boPaySlip).values({ periodId, teacherId, baseAmount: base }).onConflictDoNothing().returning({ id: boPaySlip.id });
        if (inserted.length) return "created" as const;
        const updated = await tx
          .update(boPaySlip)
          .set({ baseAmount: base })
          .where(and(eq(boPaySlip.periodId, periodId), eq(boPaySlip.teacherId, teacherId), eq(boPaySlip.status, "draft")))
          .returning({ id: boPaySlip.id });
        return updated.length ? ("refreshed" as const) : ("skipped" as const);
      });
    },
    async listLines(slipId) {
      return (await exec.select().from(boPaySlipLine).where(eq(boPaySlipLine.slipId, slipId)).orderBy(asc(boPaySlipLine.createdAt), asc(boPaySlipLine.id))).map(line);
    },
    async sumLinesByPeriod(periodId) {
      const rows = await exec
        .select({ slipId: boPaySlipLine.slipId, total: sql<string>`sum(${boPaySlipLine.amount})::text` })
        .from(boPaySlipLine)
        .innerJoin(boPaySlip, eq(boPaySlip.id, boPaySlipLine.slipId))
        .where(eq(boPaySlip.periodId, periodId))
        .groupBy(boPaySlipLine.slipId);
      return new Map(rows.map((r) => [r.slipId, satangFromNumeric(r.total)]));
    },
    async insertLine(l) {
      const values = { slipId: l.slipId, kind: l.kind, label: l.label, amount: numericFromSatang(l.amountSatang), source: l.source, sourceRef: l.sourceRef ?? null, createdBy: l.createdBy };
      if (l.source === "auto") {
        // an AUTO line is idempotent on (slip, kind, source_ref) via migration 0011's partial unique index: a duplicate is a no-op that returns the existing row
        if (!l.sourceRef) throw new Error("an auto line needs a sourceRef");
        const [ins] = await exec.insert(boPaySlipLine).values(values).onConflictDoNothing().returning();
        if (ins) return line(ins);
        const [have] = await exec.select().from(boPaySlipLine).where(and(eq(boPaySlipLine.slipId, l.slipId), eq(boPaySlipLine.kind, l.kind), eq(boPaySlipLine.sourceRef, l.sourceRef), eq(boPaySlipLine.source, "auto"))).limit(1);
        return line(have!);
      }
      const [r] = await exec.insert(boPaySlipLine).values(values).returning();
      return line(r!);
    },
    async syncAutoLines(slipId, kinds, desired, actor) {
      return exec.transaction(async (tx) => {
        const have = await tx.select().from(boPaySlipLine).where(and(eq(boPaySlipLine.slipId, slipId), eq(boPaySlipLine.source, "auto"), inArray(boPaySlipLine.kind, [...kinds])));
        const key = (k: string, r: string | null) => `${k}|${r ?? ""}`;
        const want = new Map(desired.map((d) => [key(d.kind, d.sourceRef), d]));
        let inserted = 0;
        let updated = 0;
        let removed = 0;
        const insertedLines: AutoLine[] = [];
        for (const l of have) {
          const d = want.get(key(l.kind, l.sourceRef));
          if (!d) {
            await tx.delete(boPaySlipLine).where(eq(boPaySlipLine.id, l.id));
            removed += 1;
            continue;
          }
          if (l.label !== d.label || satangFromNumeric(l.amount) !== d.amountSatang) {
            await tx.update(boPaySlipLine).set({ label: d.label, amount: numericFromSatang(d.amountSatang) }).where(eq(boPaySlipLine.id, l.id));
            updated += 1;
          }
          want.delete(key(l.kind, l.sourceRef));
        }
        for (const d of want.values()) {
          // the partial unique index (0011) turns a concurrent duplicate into a no-op, not a second row
          const r = await tx
            .insert(boPaySlipLine)
            .values({ slipId, kind: d.kind, label: d.label, amount: numericFromSatang(d.amountSatang), source: "auto", sourceRef: d.sourceRef, classType: d.classType ?? null, createdBy: actor })
            .onConflictDoNothing()
            .returning({ id: boPaySlipLine.id });
          inserted += r.length;
          if (r.length) insertedLines.push(d);
        }
        return { inserted, updated, removed, insertedLines };
      });
    },
    async getLine(id) {
      const [r] = await exec.select().from(boPaySlipLine).where(eq(boPaySlipLine.id, id)).limit(1);
      return r && line(r);
    },
    async deleteLine(id) {
      await exec.delete(boPaySlipLine).where(eq(boPaySlipLine.id, id));
    },
    /** TASK-886: active profiles joined to `public.teachers` (read-only), never `is_system`, ordered by name. Names + the merit flag only: no pay column is selected. */
    async listEntriesPeople() {
      const rows = await exec.execute(
        sql`select p.teacher_id::text as id, coalesce(nullif(btrim(t.nickname), ''), nullif(btrim(t.name), '')) as name, p.merit_eligible as merit
            from bo.salary_profile p join public.teachers t on t.id = p.teacher_id
            where p.active and not t.is_system
            order by 2, 1`,
      );
      const out: { teacherId: string; name: string; meritEligible: boolean }[] = [];
      for (const r of rows) if (r.name) out.push({ teacherId: String(r.id), name: String(r.name), meritEligible: Boolean(r.merit) });
      return out;
    },
    /** Display only: a READ of `public.teachers` (owned by smart-scheduler-back; never written here, not an FK). Nickname first (how coaches are known), else name. */
    async teacherNames(ids) {
      const uniq = [...new Set(ids)];
      if (!uniq.length) return new Map();
      const rows = await exec.execute(
        sql`select id::text as id, coalesce(nullif(btrim(nickname), ''), nullif(btrim(name), '')) as display from public.teachers where id in (${sql.join(uniq.map((i) => sql`${i}::uuid`), sql`, `)})`,
      );
      const out = new Map<string, string>();
      for (const r of rows) if (r.display) out.set(String(r.id), String(r.display));
      return out;
    },
  };
}

export const dbSalaryStore: SalaryStore = makeDbSalaryStore();
