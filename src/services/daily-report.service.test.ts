// 🔻 TASK-885 (REQ-120 R1.7) — the Daily Training Report: per day, each coach's hours and that day's derived pay, from the SAME reader and the SAME pure pay rules the pay run uses. No database: the deps are fakes; the HTTP gate runs on the in-memory store.
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import { CLASS_WORDS, buildDailyReport, extraPartFromLabel, flPartsFromLabel, type DailyDeps } from "./daily-report.service";
import { createSalaryService } from "./salary.service";
import { memorySalaryStore } from "./salary-memory.store";
import { makeSalaryRoutes } from "../routes/salary";
import * as hoursReader from "./hours-reader";
import { signToken, type Role } from "../lib/jwt";
import { ApiException } from "../lib/http";
import type { HoursDay } from "../lib/pay-rules";

const FT = "11111111-1111-4111-8111-111111111111", FT2 = "11111111-1111-4111-8111-111111111112", FL = "22222222-2222-4222-8222-222222222222", PTFL = "33333333-3333-4333-8333-333333333333", SYS = "99999999-9999-4999-8999-999999999999";
const WED = "2026-10-14", SAT = "2026-10-17", TUE = "2026-10-13";
const day = (date: string, byType: Partial<HoursDay["byType"]>): HoursDay => {
  const full = { private: 0, duo: 0, group: 0, eca: 0, camp: 0, ...byType };
  return { date, byType: full, teachingMinutesTotal: Object.values(full).reduce((a, b) => a + b, 0) };
};
type Prof = { teacherId: string; employmentType: "FT" | "PT" | "FL"; roles: Array<"FT" | "PT" | "FL">; active: boolean };
const prof = (teacherId: string, employmentType: Prof["employmentType"], roles: Prof["roles"] = [employmentType], active = true): Prof => ({ teacherId, employmentType, roles, active });
const deps = (profiles: Prof[], hours: Record<string, HoursDay[]>, rates: Record<string, Array<{ classType: string; rate: number }>> = {}, people?: string[]): DailyDeps & { reads: string[]; ranges: string[][] } => {
  const reads: string[] = [];
  const ranges: string[][] = [];
  return {
    reads,
    ranges,
    listProfiles: async () => profiles,
    getFlRates: async (id) => rates[id] ?? [],
    listEntriesPeople: async () => (people ?? profiles.map((p) => p.teacherId)).map((teacherId) => ({ teacherId })),
    readHours: async (id, a, b) => { reads.push(id); ranges.push([id, a, b]); return (hours[id] ?? []).filter((d) => d.date >= a && d.date <= b); },
  };
};

describe("🔴 TASK-885 — Full-time / Part-time: Extra Hour (the final UI's 13/10 and 14/10 rows)", () => {
  test("an FT coach with 6 h on a weekday ⇒ «Extra Hour 2 Hr × 350 ฿» = 70,000 satang; 4 h ⇒ «—», null (the threshold is the pay run's own)", async () => {
    const r = await buildDailyReport(WED, deps([prof(FT, "FT"), prof(FT2, "FT")], { [FT]: [day(WED, { private: 360 })], [FT2]: [day(WED, { private: 240 })] }));
    const six = r.rows.find((x) => x.teacherId === FT)!, four = r.rows.find((x) => x.teacherId === FT2)!;
    expect([six.description, six.incomeSatang, six.hours, six.minutes, six.role]).toEqual(["Extra Hour 2 Hr × 350 ฿", 70_000, 6, 360, "Full-time"]);
    expect([four.description, four.incomeSatang, four.hours]).toEqual(["—", null, 4]);
  });
  test("the reader is asked for THAT ONE DAY only (start = end = the date)", async () => {
    const d = deps([prof(FT, "FT")], { [FT]: [day(WED, { private: 360 })] });
    await buildDailyReport(WED, d);
    expect(d.ranges).toEqual([[FT, WED, WED]]);
  });
  test("5 h ⇒ Extra Hour 1 Hr × 350 ฿ = 35,000 (the final UI's May row); a half hour reads «0.5 Hr»", async () => {
    const r = await buildDailyReport(WED, deps([prof(FT, "FT"), prof(FT2, "FT")], { [FT]: [day(WED, { private: 300 })], [FT2]: [day(WED, { private: 270 })] }));
    expect(r.rows.find((x) => x.teacherId === FT)).toMatchObject({ description: "Extra Hour 1 Hr × 350 ฿", incomeSatang: 35_000 });
    expect(r.rows.find((x) => x.teacherId === FT2)).toMatchObject({ description: "Extra Hour 0.5 Hr × 350 ฿", incomeSatang: 17_500, hours: 4.5 });
  });
  test("an ECA / camp hour counts toward the day's minutes (R1.2): 3 h Private + 2 h ECA = 5 h ⇒ 1 extra hour", async () => {
    const r = await buildDailyReport(WED, deps([prof(FT, "FT")], { [FT]: [day(WED, { private: 180, eca: 120 })] }));
    expect(r.rows[0]).toMatchObject({ minutes: 300, description: "Extra Hour 1 Hr × 350 ฿", incomeSatang: 35_000 });
  });
});

describe("🔴 TASK-885 — Freelance: one part per class type, the pay run's own labels", () => {
  test("an FL coach with 1 h Private at 300 ⇒ «Private 1 Hr × 300 ฿», 30,000 satang (the final UI's Ton row)", async () => {
    const r = await buildDailyReport(TUE, deps([prof(FL, "FL")], { [FL]: [day(TUE, { private: 60 })] }, { [FL]: [{ classType: "private", rate: 30_000 }] }));
    expect(r.rows[0]).toMatchObject({ role: "Freelance", description: "Private 1 Hr × 300 ฿", incomeSatang: 30_000, hours: 1 });
  });
  test("several class types: the parts are joined « · » in the pay run's class order, and the amount is the pay run's ONE rounding", async () => {
    const r = await buildDailyReport(TUE, deps([prof(FL, "FL")], { [FL]: [day(TUE, { eca: 30, private: 60 })] }, { [FL]: [{ classType: "private", rate: 30_000 }, { classType: "eca", rate: 25_000 }] }));
    expect(r.rows[0]).toMatchObject({ description: "Private 1 Hr × 300 ฿ · ECA 0.5 Hr × 250 ฿", incomeSatang: 42_500 });
  });
  test("the parts keep the pay run's class order even when a MISSING part sits between two known ones (Private · Duo — · Eca)", async () => {
    const r = await buildDailyReport(TUE, deps([prof(FL, "FL")], { [FL]: [day(TUE, { private: 60, duo: 60, eca: 60 })] }, { [FL]: [{ classType: "private", rate: 30_000 }, { classType: "eca", rate: 25_000 }] }));
    expect(r.rows[0]!.description).toBe("Private 1 Hr × 300 ฿ · Duo 1 Hr × — ฿ · ECA 1 Hr × 250 ฿");
  });
  test("a PT + FL person: a Saturday is Part-time (Extra Hour from the 6th hour), a Wednesday is Freelance", async () => {
    const both = prof(PTFL, "PT", ["PT", "FL"]);
    const rates = { [PTFL]: [{ classType: "private", rate: 30_000 }] };
    const sat = await buildDailyReport(SAT, deps([both], { [PTFL]: [day(SAT, { private: 360 })] }, rates));
    expect(sat.rows[0]).toMatchObject({ role: "Part-time", description: "Extra Hour 1 Hr × 350 ฿", incomeSatang: 35_000 });
    const wed = await buildDailyReport(WED, deps([both], { [PTFL]: [day(WED, { private: 60 })] }, rates));
    expect(wed.rows[0]).toMatchObject({ role: "Freelance", description: "Private 1 Hr × 300 ฿", incomeSatang: 30_000 });
  });
  test("🔴 a missing FL rate is LISTED, not guessed: that part shows a dash for the rate, the income counts only what is known, and `missingRates` names it", async () => {
    const r = await buildDailyReport(TUE, deps([prof(FL, "FL")], { [FL]: [day(TUE, { private: 60, duo: 60 })] }, { [FL]: [{ classType: "private", rate: 30_000 }] }));
    expect(r.rows[0]).toMatchObject({ description: "Private 1 Hr × 300 ฿ · Duo 1 Hr × — ฿", incomeSatang: 30_000 });
    expect(r.missingRates).toEqual([{ teacherId: FL, classType: "duo" }]);
    const none = await buildDailyReport(TUE, deps([prof(FL, "FL")], { [FL]: [day(TUE, { group: 60 })] }));
    expect(none.rows[0]).toMatchObject({ description: "Group 1 Hr × — ฿", incomeSatang: null });
    expect(none.totals.incomeSatang).toBe(0);
  });
  test("🔻 the class words are the final UI's FIXED map (Private · Duo · Group · ECA · Camp) — ECA is never «Eca", async () => {
    expect(CLASS_WORDS).toEqual({ private: "Private", duo: "Duo", group: "Group", eca: "ECA", camp: "Camp" });
    expect(flPartsFromLabel("14/10 (Wed): eca 1 Hr × 250, camp 2 Hr × 200")).toEqual(["ECA 1 Hr × 250 ฿", "Camp 2 Hr × 200 ฿"]);
    const r = await buildDailyReport(TUE, deps([prof(FL, "FL")], { [FL]: [day(TUE, { eca: 60, camp: 60 })] }, { [FL]: [{ classType: "eca", rate: 25_000 }] }));
    expect(r.rows[0]!.description).toBe("ECA 1 Hr × 250 ฿ · Camp 1 Hr × — ฿"); // a MISSING part uses the same words
  });
  test("the description is BUILT FROM the pay run's label (one formatter): the helpers parse exactly what pay-rules writes", () => {
    expect(flPartsFromLabel("14/10 (Wed): private 1 Hr × 300, duo 2 Hr × 250")).toEqual(["Private 1 Hr × 300 ฿", "Duo 2 Hr × 250 ฿"]);
    expect(extraPartFromLabel("14/10 (Wed): 6 Hr → extra 2 Hr × 350")).toBe("Extra Hour 2 Hr × 350 ฿");
    expect(() => extraPartFromLabel("14/10 (Wed): nonsense")).toThrow();
  });
});

describe("🔴 TASK-885 — who is listed, the order, the totals", () => {
  test("«No Teacher» is never a row: a profile that is not a REAL person (the system teacher) is not read at all", async () => {
    const d = deps([prof(FT, "FT"), prof(SYS, "FT")], { [FT]: [day(WED, { private: 360 })], [SYS]: [day(WED, { private: 360 })] }, {}, [FT]);
    const r = await buildDailyReport(WED, d);
    expect(r.rows.map((x) => x.teacherId)).toEqual([FT]);
    expect(d.reads).toEqual([FT]);
  });
  test("a day the reader returns with ZERO minutes is not a row", async () => {
    expect((await buildDailyReport(WED, deps([prof(FT, "FT")], { [FT]: [day(WED, {})] }))).rows).toEqual([]);
  });
  test("an inactive profile, a STAFF one and a person with no teaching that day are not rows", async () => {
    const r = await buildDailyReport(WED, deps([prof(FT, "FT", ["FT"], false), prof(FT2, "FT"), { teacherId: FL, employmentType: "STAFF" as any, roles: ["STAFF" as any], active: true }], { [FT]: [day(WED, { private: 360 })], [FT2]: [] }));
    expect(r.rows).toEqual([]);
  });
  test("the order is Full-time, Part-time, Freelance, then a stable id; the totals equal Σ rows (known income only)", async () => {
    const r = await buildDailyReport(SAT, deps([prof(FL, "FL"), prof(PTFL, "PT"), prof(FT, "FT")], { [FL]: [day(SAT, { private: 60 })], [PTFL]: [day(SAT, { private: 360 })], [FT]: [day(SAT, { private: 420 })] }, { [FL]: [{ classType: "private", rate: 30_000 }] }));
    // a Saturday: the FL person is Freelance everywhere (single role), the PT is Part-time, the FT is Full-time
    expect(r.rows.map((x) => x.role)).toEqual(["Full-time", "Part-time", "Freelance"]);
    expect(r.totals).toEqual({ coaches: 3, minutes: r.rows.reduce((n, x) => n + x.minutes, 0), incomeSatang: r.rows.reduce((n, x) => n + (x.incomeSatang ?? 0), 0) });
    expect(r.totals).toMatchObject({ coaches: 3, minutes: 840, incomeSatang: 70_000 + 35_000 + 30_000 });
    expect(r.weekday).toBe("Sat");
  });
  test("a malformed or impossible date ⇒ 400", async () => {
    for (const bad of ["", "2026-13-01", "2026-02-30", "14/10/2026", "2026-1-1"]) await expect(buildDailyReport(bad, deps([], {}))).rejects.toMatchObject({ status: 400 });
  });
  test("a day with nobody answers an empty, whole report (a read, never an error)", async () => {
    expect(await buildDailyReport(WED, deps([prof(FT, "FT")], {}))).toEqual({ date: WED, weekday: "Wed", rows: [], missingRates: [], totals: { coaches: 0, minutes: 0, incomeSatang: 0 } });
  });
});

describe("🔴 TASK-885 — the report and the slip can never disagree: the SAME fixture through the pay run", () => {
  test("the derived lines of 14/10 on the slip equal the report's income for each coach", async () => {
    const store = memorySalaryStore();
    store.names.set(FT, "A"); store.names.set(FL, "B");
    const hours: Record<string, HoursDay[]> = { [FT]: [day(WED, { private: 360 })], [FL]: [day(WED, { private: 60, duo: 90 })] };
    const readHours = async (id: string, a: string, b: string) => (hours[id] ?? []).filter((d) => d.date >= a && d.date <= b);
    const svc = createSalaryService(store, () => new Date("2026-10-20T03:00:00Z"), { readHours });
    await svc.setProfile(FT, { employmentType: "FT", baseSalary: 2_500_000, active: true });
    await svc.setProfile(FL, { employmentType: "FL", baseSalary: null, active: true });
    await svc.setFlRate(FL, "private", 30_000);
    await svc.setFlRate(FL, "duo", 25_000);
    const period = await svc.createPeriod(2026, 10);
    await svc.runPeriod(period.id);
    const overview = await svc.getPeriod(period.id);
    const slipOf = async (teacherId: string) => svc.getSlip(overview.slips.find((s: any) => s.teacherId === teacherId)!.id);
    const sum = async (teacherId: string) => (await slipOf(teacherId)).lines.filter((l: any) => l.label.startsWith("14/10")).reduce((n: number, l: any) => n + l.amount, 0);
    const report = await buildDailyReport(WED, { listProfiles: () => svc.listProfiles(), getFlRates: (id) => svc.getFlRates(id), listEntriesPeople: async () => [{ teacherId: FT }, { teacherId: FL }], readHours });
    for (const id of [FT, FL]) expect([id, report.rows.find((x) => x.teacherId === id)!.incomeSatang]).toEqual([id, await sum(id)]);
    expect(report.rows.find((x) => x.teacherId === FT)!.incomeSatang).toBe(70_000);
    expect(report.rows.find((x) => x.teacherId === FL)!.incomeSatang).toBe(30_000 + 37_500);
  });
});

describe("🔴 TASK-885 — GET /salary/daily: CEO only", () => {
  const KEYS = ["JWT_SECRET", "SKIP_ADMIN_AUTH"];
  const saved: Record<string, string | undefined> = {};
  const spies: Array<{ mockRestore: () => void }> = [];
  beforeAll(() => { for (const k of KEYS) saved[k] = process.env[k]; process.env.JWT_SECRET = "test-secret-885"; process.env.SKIP_ADMIN_AUTH = "false"; });
  afterAll(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } for (const s of spies) s.mockRestore(); });
  const app = async () => {
    const store = memorySalaryStore();
    store.names.set(FT, "A");
    const svc = createSalaryService(store, () => new Date("2026-10-20T03:00:00Z"), { readHours: async () => [] });
    await svc.setProfile(FT, { employmentType: "FT", baseSalary: 2_500_000, active: true });
    spies.push(spyOn(hoursReader, "readHours").mockImplementation((async (_t: string, a: string) => [day(a, { private: 360 })]) as any));
    const a = new Hono();
    a.onError((err, c) => (err instanceof ApiException ? c.json({ error: { code: err.code, message: err.message } }, err.status as 400) : c.json({ error: { code: "INTERNAL" } }, 500)));
    a.route("/salary", makeSalaryRoutes(svc));
    return a;
  };
  const get = async (a: Hono, role: Role | null, qs: string) => a.request(`/salary/daily${qs}`, { headers: role ? { Authorization: `Bearer ${await signToken({ sub: `u-${role}`, role })}` } : {} });
  test("no token ⇒ 401 · admin / coach ⇒ 403 · a malformed date ⇒ 400 · the CEO ⇒ 200 with the shape", async () => {
    const a = await app();
    expect((await get(a, null, `?date=${WED}`)).status).toBe(401);
    expect((await get(a, "admin", `?date=${WED}`)).status).toBe(403);
    expect((await get(a, "coach", `?date=${WED}`)).status).toBe(403);
    expect((await get(a, "ceo", "?date=not-a-date")).status).toBe(400);
    expect((await get(a, "ceo", "")).status).toBe(400);
    const ok = await get(a, "ceo", `?date=${WED}`);
    expect(ok.status).toBe(200);
    const body: any = await ok.json();
    expect(body).toMatchObject({ date: WED, weekday: "Wed", totals: { coaches: 1, minutes: 360, incomeSatang: 70_000 } });
    expect(body.rows[0]).toEqual({ teacherId: FT, role: "Full-time", hours: 6, minutes: 360, description: "Extra Hour 2 Hr × 350 ฿", incomeSatang: 70_000 });
  });
});
