// TASK-865 / SPEC-100 — the pay-run + slip engine, round trip on an in-memory store (no database).
import { describe, expect, test } from "bun:test";
import { createSalaryService, defaultLockAt } from "./salary.service";
import { memorySalaryStore } from "./salary-memory.store";
import { numericFromSatang, satangFromNumeric } from "../lib/satang";
import { ApiException } from "../lib/http";

const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
const T3 = "33333333-3333-4333-8333-333333333333"; // PT — never gets a slip
const T4 = "44444444-4444-4444-8444-444444444444"; // FT but inactive — never gets a slip

/** a clock the tests can move */
const clock = (iso: string) => {
  let t = new Date(iso);
  return { now: () => t, set: (iso2: string) => (t = new Date(iso2)) };
};

async function world(startIso = "2026-11-10T03:00:00Z") {
  const store = memorySalaryStore();
  const c = clock(startIso);
  const svc = createSalaryService(store, c.now, { readHours: async () => [] });
  await svc.setProfile(T1, { employmentType: "FT", baseSalary: 2_500_000, active: true }); // 25,000.00 ฿
  await svc.setProfile(T2, { employmentType: "FT", baseSalary: 1_800_050, active: true }); // 18,000.50 ฿
  await svc.setProfile(T3, { employmentType: "PT", baseSalary: 999_999, active: true });
  await svc.setProfile(T4, { employmentType: "FT", baseSalary: 999_999, active: false });
  store.names.set(T1, "ต้น");
  store.names.set(T2, 'Ploy, "Jr"'); // a comma and a quote: the CSV must quote it
  return { store, svc, c };
}
const rejects = async (p: Promise<unknown>, status: number, code?: string) => {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ApiException);
    expect((e as ApiException).status).toBe(status);
    if (code) expect((e as ApiException).code).toBe(code);
    return;
  }
  throw new Error(`expected a ${status} rejection`);
};

describe("money: integer satang ⇄ numeric text, never a float", () => {
  test("round trips, signs and padding", () => {
    expect(satangFromNumeric("12345.67")).toBe(1234567);
    expect(satangFromNumeric("-5.5")).toBe(-550);
    expect(satangFromNumeric("100")).toBe(10000);
    expect(satangFromNumeric("0.10") + satangFromNumeric("0.20")).toBe(30); // the float trap: 0.1 + 0.2
    expect(numericFromSatang(1234567)).toBe("12345.67");
    expect(numericFromSatang(-550)).toBe("-5.50");
    expect(numericFromSatang(5)).toBe("0.05");
    expect(() => satangFromNumeric("1.234")).toThrow();
    expect(() => numericFromSatang(1.5)).toThrow();
  });
});

describe("the 12:00 lock instant", () => {
  test("12:00 Asia/Bangkok on the last day of the month = 05:00 UTC", () => {
    expect(defaultLockAt(2026, 11).toISOString()).toBe("2026-11-30T05:00:00.000Z");
    expect(defaultLockAt(2026, 12).toISOString()).toBe("2026-12-31T05:00:00.000Z");
    expect(defaultLockAt(2028, 2).toISOString()).toBe("2028-02-29T05:00:00.000Z"); // leap year
    expect(defaultLockAt(2027, 2).toISOString()).toBe("2027-02-28T05:00:00.000Z");
  });
});

describe("the round trip: create period → run → Other± lines → total → lock → locked writes → export", () => {
  test("the whole demo path, with an EXPLICIT lock", async () => {
    const { svc } = await world();
    const period = await svc.createPeriod(2026, 11);
    expect(period).toMatchObject({ year: 2026, month: 11, status: "open", lockAt: "2026-11-30T05:00:00.000Z", lockedAt: null });

    // run: a draft slip per ACTIVE FT / PT / FL profile (T1, T2 and the PT; TASK-878 widened it from FT-only), not the inactive one
    expect(await svc.runPeriod(period.id)).toEqual({ created: 3, refreshed: 0 });
    const overview = await svc.getPeriod(period.id);
    expect(overview.slips.map((s) => s.teacherId).sort()).toEqual([T1, T2, "33333333-3333-4333-8333-333333333333"]);
    expect(overview.slips.every((s) => s.status === "draft")).toBe(true);
    const slip1 = overview.slips.find((s) => s.teacherId === T1)!;
    expect(slip1).toMatchObject({ baseAmount: 2_500_000, total: 2_500_000 });

    // two Other± lines, one negative
    const bonus = await svc.addLine(slip1.id, { amount: 150_000, label: "ค่าสอนพิเศษ" }, "phi");
    const fine = await svc.addLine(slip1.id, { amount: -30_050, label: "หักมาสาย" }, "phi");
    expect(bonus).toMatchObject({ kind: "other", amount: 150_000, source: "manual" });
    expect(fine.amount).toBe(-30_050);

    // GET slip: total = base + Σ lines (signed), exactly
    const slip = await svc.getSlip(slip1.id);
    expect(slip.lines.map((l) => l.amount)).toEqual([150_000, -30_050]);
    expect(slip.total).toBe(2_500_000 + 150_000 - 30_050);
    expect(slip.total).toBe(2_619_950);
    // …and the month overview agrees
    const ov2 = await svc.getPeriod(period.id);
    expect(ov2.slips.find((s) => s.id === slip1.id)!.total).toBe(2_619_950);
    expect(ov2.slips.find((s) => s.teacherId === T2)!.total).toBe(1_800_050);

    // remove one line while open
    await svc.removeLine(slip1.id, fine.id);
    expect((await svc.getSlip(slip1.id)).total).toBe(2_650_000);

    // EXPLICIT lock
    const locked = await svc.lockPeriod(period.id);
    expect(locked.status).toBe("locked");
    expect(locked.lockedAt).not.toBeNull();
    const after = await svc.getSlip(slip1.id);
    expect(after.status).toBe("locked");
    expect(after.total).toBe(2_650_000); // reads still work

    // every write after lock is 409 LOCKED
    await rejects(svc.addLine(slip1.id, { amount: 100, label: "x" }, "phi"), 409, "LOCKED");
    await rejects(svc.removeLine(slip1.id, bonus.id), 409, "LOCKED");
    await rejects(svc.runPeriod(period.id), 409, "LOCKED");

    // CSV export still works when locked
    const csv = await svc.exportCsv(period.id);
    expect(csv.filename).toBe("salary-2026-11.csv");
    const rows = csv.body.trim().split("\r\n");
    expect(rows[0]).toBe("teacher_id,teacher_name,base_salary,total,status");
    expect(rows).toContain(`${T1},ต้น,25000.00,26500.00,locked`);
    expect(rows).toContain(`${T2},"Ploy, ""Jr""",18000.50,18000.50,locked`); // quoted, quote doubled
    expect(rows.length).toBe(4); // header + T1 + T2 + the PT (slips now cover FT / PT / FL)
  });

  test("the LAZY 12:00 auto-lock: a read after lock_at locks the period and its slips", async () => {
    const { svc, c } = await world("2026-11-10T03:00:00Z");
    const period = await svc.createPeriod(2026, 11);
    await svc.runPeriod(period.id);
    const slipId = (await svc.getPeriod(period.id)).slips[0]!.id;
    await svc.addLine(slipId, { amount: 1000, label: "ก่อนล็อก" }, "phi"); // still open: fine

    c.set("2026-11-30T04:59:59Z"); // one second before 12:00 Bangkok
    expect((await svc.getPeriod(period.id)).period.status).toBe("open");
    await svc.addLine(slipId, { amount: 1000, label: "ยังทัน" }, "phi");

    c.set("2026-11-30T05:00:00Z"); // 12:00 Bangkok on the last day
    const ov = await svc.getPeriod(period.id); // ← any read evaluates it
    expect(ov.period.status).toBe("locked");
    expect(ov.period.lockedAt).toBe("2026-11-30T05:00:00.000Z");
    expect(ov.slips.every((s) => s.status === "locked")).toBe(true);
    await rejects(svc.addLine(slipId, { amount: 1, label: "สาย" }, "phi"), 409, "LOCKED");
    await rejects(svc.runPeriod(period.id), 409, "LOCKED");
    expect((await svc.getSlip(slipId)).total).toBe(2_500_000 + 2000);
  });

  test("lazy lock also fires on a WRITE (no prior read), and on the period list", async () => {
    const { svc, c } = await world("2026-11-10T03:00:00Z");
    const period = await svc.createPeriod(2026, 11);
    await svc.runPeriod(period.id);
    const slipId = (await svc.getPeriod(period.id)).slips[0]!.id;
    c.set("2026-12-01T00:00:00Z");
    await rejects(svc.addLine(slipId, { amount: 5, label: "ช้า" }, "phi"), 409, "LOCKED"); // first touch is the write
    expect((await svc.listPeriods())[0]!.status).toBe("locked");
  });
});

describe("teacherName (display only: a read-only lookup, null when not found)", () => {
  test("on the month overview and the single slip; null for an id with no row; the CSV cell is empty then", async () => {
    const { svc, store } = await world();
    store.names.delete(T2); // T2 is not in public.teachers
    const p = await svc.createPeriod(2026, 11);
    await svc.runPeriod(p.id);
    const ov = await svc.getPeriod(p.id);
    expect(ov.slips.find((s) => s.teacherId === T1)!.teacherName).toBe("ต้น");
    expect(ov.slips.find((s) => s.teacherId === T2)!.teacherName).toBeNull();
    const slip = await svc.getSlip(ov.slips.find((s) => s.teacherId === T1)!.id);
    expect(slip.teacherName).toBe("ต้น");
    expect((await svc.getSlip(ov.slips.find((s) => s.teacherId === T2)!.id)).teacherName).toBeNull();
    expect((await svc.exportCsv(p.id)).body).toContain(`${T2},,18000.50,18000.50,draft`);
  });
});

describe("run semantics", () => {
  test("idempotent: a second run creates nothing and refreshes DRAFT bases; lines are never deleted", async () => {
    const { svc } = await world();
    const p = await svc.createPeriod(2026, 11);
    await svc.runPeriod(p.id);
    const slipId = (await svc.getPeriod(p.id)).slips.find((s) => s.teacherId === T1)!.id;
    await svc.addLine(slipId, { amount: 777, label: "คงอยู่" }, "phi");
    await svc.setProfile(T1, { employmentType: "FT", baseSalary: 2_600_000, active: true }); // CEO raises the base
    expect(await svc.runPeriod(p.id)).toEqual({ created: 0, refreshed: 3 });
    const slip = await svc.getSlip(slipId);
    expect(slip.baseAmount).toBe(2_600_000); // refreshed
    expect(slip.lines.length).toBe(1); // untouched
    expect(slip.total).toBe(2_600_777);
  });

  test("never touches a confirmed slip", async () => {
    const { svc, store } = await world();
    const p = await svc.createPeriod(2026, 11);
    await svc.runPeriod(p.id);
    const s = [...store.slips.values()].find((x) => x.teacherId === T1)!;
    s.status = "confirmed";
    await svc.setProfile(T1, { employmentType: "FT", baseSalary: 9_000_000, active: true });
    expect(await svc.runPeriod(p.id)).toEqual({ created: 0, refreshed: 2 }); // T2 and the PT refreshed; T1 (confirmed) skipped
    expect(s.baseSatang).toBe(2_500_000);
    // a confirmed slip still takes lines while the period is open
    expect((await svc.addLine(s.id, { amount: 10, label: "ok" }, "phi")).amount).toBe(10);
  });

  test("a null base is 0 on the slip", async () => {
    const { svc } = await world();
    await svc.setProfile(T1, { employmentType: "FT", baseSalary: null, active: true });
    const p = await svc.createPeriod(2026, 11);
    await svc.runPeriod(p.id);
    expect((await svc.getPeriod(p.id)).slips.find((s) => s.teacherId === T1)!.baseAmount).toBe(0);
  });
});

describe("validation", () => {
  test("the reason is required and non-empty (400); the amount is a non-zero integer", async () => {
    const { svc } = await world();
    const p = await svc.createPeriod(2026, 11);
    await svc.runPeriod(p.id);
    const slipId = (await svc.getPeriod(p.id)).slips[0]!.id;
    await rejects(svc.addLine(slipId, { amount: 100, label: "" }, "phi"), 400);
    await rejects(svc.addLine(slipId, { amount: 100, label: "   " }, "phi"), 400);
    await rejects(svc.addLine(slipId, { amount: 0, label: "ศูนย์" }, "phi"), 400);
    await rejects(svc.addLine(slipId, { amount: 1.5, label: "เศษ" }, "phi"), 400);
  });
  test("a period is unique per (year, month) and the month is 1–12", async () => {
    const { svc } = await world();
    await svc.createPeriod(2026, 11);
    await rejects(svc.createPeriod(2026, 11), 409, "PERIOD_EXISTS");
    await rejects(svc.createPeriod(2026, 13), 400);
    await rejects(svc.createPeriod(2026, 0), 400);
  });
  test("unknown ids are 404; a line of another slip is 404", async () => {
    const { svc } = await world();
    const p = await svc.createPeriod(2026, 11);
    await svc.runPeriod(p.id);
    const [a, b] = (await svc.getPeriod(p.id)).slips;
    const line = await svc.addLine(a!.id, { amount: 5, label: "ของ a" }, "phi");
    await rejects(svc.getSlip("99999999-9999-4999-8999-999999999999"), 404);
    await rejects(svc.getPeriod("99999999-9999-4999-8999-999999999999"), 404);
    await rejects(svc.removeLine(b!.id, line.id), 404);
  });
  test("a profile base must be a non-negative integer or null", async () => {
    const { svc } = await world();
    await rejects(svc.setProfile(T1, { employmentType: "FT", baseSalary: -1, active: true }), 400);
    await rejects(svc.setProfile(T1, { employmentType: "FT", baseSalary: 12.5, active: true }), 400);
  });
});
