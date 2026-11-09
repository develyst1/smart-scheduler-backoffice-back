// 🔻 TASK-887 (SPEC-102 §5-E4a) — the ONE write the coach's confirm needs, in this file's own small store (Team A's `SalaryStore` has no status setter and is not edited: same pattern as `BonusLineStore`).
// The whole write is a SINGLE conditional statement — `UPDATE bo.pay_slip SET status = 'confirmed' … WHERE … AND status = 'draft'` — so the 12:00 lazy lock racing a confirm is safe by construction: a slip the lock got to first is `locked`, matches
// nothing, and the confirm moves no row. It is typed against Team A's `bo.pay_slip` / `bo.pay_period` (a read-only import of the schema).
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { boPaySlip } from "../db/schema";

export type SlipStatus = "draft" | "confirmed" | "locked";

export interface SlipConfirmStore {
  /** draft → confirmed for the (teacher, year, month) slip, in ONE conditional statement. true when a row moved, false when none matched (no slip, or not `draft`). Never touches a `confirmed` or `locked` slip. */
  confirmDraft(teacherId: string, year: number, month: number, at: Date): Promise<boolean>;
  /** The slip's status now (null = no slip for that teacher and month). */
  slipStatus(teacherId: string, year: number, month: number): Promise<SlipStatus | null>;
}

/** The slip's period, by its human label (year, month) — the unique key `bo_pay_period_ym_uq`. */
const periodIdOf = (year: number, month: number) => sql`(select id from bo.pay_period where year = ${year} and month = ${month})`;

/** The real store. `exec` is the db or a transaction. */
export function dbSlipConfirmStore(exec: any = db): SlipConfirmStore {
  return {
    async confirmDraft(teacherId, year, month, at) {
      const moved: { id: string }[] = await exec
        .update(boPaySlip)
        .set({ status: "confirmed", confirmedAt: at })
        .where(and(eq(boPaySlip.teacherId, teacherId), eq(boPaySlip.status, "draft"), sql`${boPaySlip.periodId} = ${periodIdOf(year, month)}`))
        .returning({ id: boPaySlip.id });
      return moved.length > 0;
    },
    async slipStatus(teacherId, year, month) {
      const [row]: { status: SlipStatus }[] = await exec
        .select({ status: boPaySlip.status })
        .from(boPaySlip)
        .where(and(eq(boPaySlip.teacherId, teacherId), sql`${boPaySlip.periodId} = ${periodIdOf(year, month)}`))
        .limit(1);
      return row?.status ?? null;
    },
  };
}

/** An in-memory store over the memory salary store's slips, with the same one-condition rule, for tests. */
export function memorySlipConfirmStore(salary: {
  getPeriodByYearMonth(year: number, month: number): Promise<{ id: string } | undefined>;
  slips: Map<string, { periodId: string; teacherId: string; status: SlipStatus }>;
}): SlipConfirmStore & { writes: number } {
  const find = async (teacherId: string, year: number, month: number) => {
    const p = await salary.getPeriodByYearMonth(year, month);
    return p ? [...salary.slips.values()].find((s) => s.periodId === p.id && s.teacherId === teacherId) : undefined;
  };
  const store = {
    writes: 0,
    async confirmDraft(teacherId: string, year: number, month: number) {
      const s = await find(teacherId, year, month);
      if (!s || s.status !== "draft") return false; // the ONE condition
      s.status = "confirmed";
      store.writes++;
      return true;
    },
    async slipStatus(teacherId: string, year: number, month: number) {
      return (await find(teacherId, year, month))?.status ?? null;
    },
  };
  return store;
}
