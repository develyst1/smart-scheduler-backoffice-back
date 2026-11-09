import { describe, expect, test } from "bun:test";
import { ApiException } from "../lib/http";
import { tripSourceRef } from "../lib/transport-pricing";
import { createSalaryService } from "./salary.service";
import { memorySalaryStore } from "./salary-memory.store";
import {
  ADMIN_TRIP_KEYS,
  CEO_TRIP_KEYS,
  createTransportService,
  memoryTransportStore,
  planTransportLines,
  reconcile,
  tripDTO,
  type ExistingTransportLine,
  type Trip,
  type TransportLineStore,
} from "./transport.service";

// TASK-868 — schools, trips, the vehicle snapshot, the admin-sees-no-amount rule, the lock, and the auto pay lines.
// Jason's salary engine runs on his in-memory store; the transport lines are written through a store that shares THAT store's
// `lines`, so `getSlip` really shows them and the slip total is the real one. No database.

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; // FT, car
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"; // FT, motorbike
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"; // FT, NO vehicle
const D = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"; // FL, car (has a slip? no: FL with no hours gets none — we use FT only)
const NOBODY = "99999999-9999-4999-8999-999999999999"; // no profile, no slip

async function world(nowIso = "2026-08-20T03:00:00Z") {
  const salaryStore = memorySalaryStore();
  let t = new Date(nowIso);
  const salary = createSalaryService(salaryStore, () => t, { readHours: async () => [] });
  await salary.setProfile(A, { employmentType: "FT", baseSalary: 2_500_000, active: true, vehicle: "car" });
  await salary.setProfile(B, { employmentType: "FT", baseSalary: 1_800_000, active: true, vehicle: "motorbike" });
  await salary.setProfile(C, { employmentType: "FT", baseSalary: 1_000_000, active: true });
  const oct = await salary.createPeriod(2026, 10); // 30/9 – 30/10
  const sep = await salary.createPeriod(2026, 9); // 31/8 – 29/9
  await salary.runPeriod(oct.id);
  await salary.runPeriod(sep.id);
  const store = memoryTransportStore();
  const lines: TransportLineStore & { added: number } = {
    added: 0,
    async listAutoTransportLines(slipIds) {
      return [...salaryStore.lines.values()]
        .filter((l) => l.kind === "transport" && l.source === "auto" && l.sourceRef && slipIds.includes(l.slipId))
        .map((l) => ({ slipId: l.slipId, sourceRef: l.sourceRef!, label: l.label, amountSatang: l.amountSatang }));
    },
    async insertAutoTransportLine(l, actor) {
      const dup = [...salaryStore.lines.values()].some((x) => x.kind === "transport" && x.source === "auto" && x.slipId === l.slipId && x.sourceRef === l.sourceRef);
      if (dup) return "exists";
      const id = `tl-${salaryStore.lines.size + 1}`;
      salaryStore.lines.set(id, { id, slipId: l.slipId, kind: "transport", label: l.label, amountSatang: l.amountSatang, source: "auto", createdBy: actor, sourceRef: l.sourceRef });
      lines.added += 1;
      return "written";
    },
  };
  const svc = createTransportService({ store, lines, salary, profiles: salaryStore });
  const sta = await svc.createSchool({ name: "STA", distanceKm: 12 });
  const abc = await svc.createSchool({ name: "ABC", distanceKm: 8 });
  const slipOf = (teacherId: string, periodId = oct.id) => [...salaryStore.slips.values()].find((s) => s.periodId === periodId && s.teacherId === teacherId)!;
  return { salaryStore, salary, store, lines, svc, oct, sep, sta, abc, slipOf, setNow: (iso: string) => (t = new Date(iso)) };
}
const rejects = async (p: Promise<unknown>, status: number, code?: string) => {
  const e = await p.then(() => null, (x) => x);
  expect(e).toBeInstanceOf(ApiException);
  expect((e as ApiException).status).toBe(status);
  if (code) expect((e as ApiException).code).toBe(code);
};
const OCT_DAY = "2026-10-14"; // inside October's period 30/9–30/10

describe("schools", () => {
  test("create stores the name (trimmed), the distance, active by default", async () => {
    const w = await world();
    expect(await w.svc.createSchool({ name: "  NIS ", distanceKm: 18.5 })).toMatchObject({ name: "NIS", distanceKm: 18.5, active: true });
  });
  test("the list is by name", async () => {
    const w = await world();
    expect((await w.svc.listSchools()).map((s) => s.name)).toEqual(["ABC", "STA"]);
  });
  test("a duplicate name is 409 SCHOOL_EXISTS, case-insensitively", async () => {
    const w = await world();
    await rejects(w.svc.createSchool({ name: "sta", distanceKm: 5 }), 409, "SCHOOL_EXISTS");
  });
  test.each([0, -3, 1.234, Number.NaN])("distance %p is 400", async (d) => {
    const w = await world();
    await rejects(w.svc.createSchool({ name: "X", distanceKm: d }), 400);
  });
  test("an empty name is 400", async () => {
    const w = await world();
    await rejects(w.svc.createSchool({ name: "   ", distanceKm: 5 }), 400);
  });
  test("update: the distance is editable; a rename to another school's name is 409; unknown id is 404", async () => {
    const w = await world();
    expect(await w.svc.updateSchool(w.sta.id, { distanceKm: 14 })).toMatchObject({ distanceKm: 14, name: "STA" });
    await rejects(w.svc.updateSchool(w.sta.id, { name: "abc" }), 409, "SCHOOL_EXISTS");
    await rejects(w.svc.updateSchool("00000000-0000-4000-8000-0000000000ff", { distanceKm: 3 }), 404);
    await rejects(w.svc.updateSchool(w.sta.id, { distanceKm: 0 }), 400);
    expect(await w.svc.updateSchool(w.sta.id, { active: false })).toMatchObject({ active: false });
  });
  test("a new distance never re-prices a trip already entered (the trip keeps its own km)", async () => {
    const w = await world();
    const t = await w.svc.createTrip({ teacherId: A, date: OCT_DAY, schoolId: w.sta.id, roundTrip: true }, "admin-1", "ceo");
    await w.svc.updateSchool(w.sta.id, { distanceKm: 99 });
    const [after] = (await w.svc.listTrips({ periodId: w.oct.id }, "ceo")) as { id: string; km: number; amountSatang: number }[];
    expect([after.id, after.km, after.amountSatang]).toEqual([(t as { id: string }).id, 24, 14_400]);
  });
});

describe("trips — km, the snapshot, validation", () => {
  test("km defaults to the school's distance: one way = 12, round trip = 24", async () => {
    const w = await world();
    const one = (await w.svc.createTrip({ teacherId: A, date: OCT_DAY, schoolId: w.sta.id, roundTrip: false }, "x", "ceo")) as { km: number };
    const round = (await w.svc.createTrip({ teacherId: A, date: OCT_DAY, schoolId: w.sta.id, roundTrip: true }, "x", "ceo")) as { km: number };
    expect([one.km, round.km]).toEqual([12, 24]);
  });
  test("km is editable at entry (the car case, Q22): an explicit km wins over the default", async () => {
    const w = await world();
    const t = (await w.svc.createTrip({ teacherId: A, date: OCT_DAY, schoolId: w.sta.id, roundTrip: true, km: 31.5 }, "x", "ceo")) as { km: number; amountSatang: number };
    expect([t.km, t.amountSatang]).toEqual([31.5, 18_900]);
  });
  test("the price of a trip is tripAmountSatang: 12 km one way by car = 72 ฿, by motorbike (B) = 40 ฿ (minimum)", async () => {
    const w = await world();
    const car = (await w.svc.createTrip({ teacherId: A, date: OCT_DAY, schoolId: w.sta.id, roundTrip: false }, "x", "ceo")) as { amountSatang: number };
    const moto = (await w.svc.createTrip({ teacherId: B, date: OCT_DAY, schoolId: w.sta.id, roundTrip: false }, "x", "ceo")) as { amountSatang: number };
    expect([car.amountSatang, moto.amountSatang]).toEqual([7_200, 4_000]);
  });
  test("the vehicle is snapshotted from the profile at entry", async () => {
    const w = await world();
    const t = (await w.svc.createTrip({ teacherId: B, date: OCT_DAY, schoolId: w.sta.id, roundTrip: false }, "x", "ceo")) as { vehicle: string };
    expect(t.vehicle).toBe("motorbike");
    expect([...w.store.trips.values()][0].vehicle).toBe("motorbike");
  });
  test("🔑 the snapshot SURVIVES a profile change: A switches car → motorbike, the old trip is still a car trip at the car price, and the new line is the car's", async () => {
    const w = await world();
    const t = (await w.svc.createTrip({ teacherId: A, date: OCT_DAY, schoolId: w.sta.id, roundTrip: false }, "x", "ceo")) as { id: string; amountSatang: number };
    expect(t.amountSatang).toBe(7_200);
    await w.salary.setProfile(A, { employmentType: "FT", baseSalary: 2_500_000, active: true, vehicle: "motorbike" });
    const [after] = (await w.svc.listTrips({ periodId: w.oct.id }, "ceo")) as { vehicle: string; amountSatang: number }[];
    expect([after.vehicle, after.amountSatang]).toEqual(["car", 7_200]);
    // an edit of another field does not re-snapshot either
    await w.svc.updateTrip(t.id, { note: "x" }, "ceo");
    expect([...w.store.trips.values()][0].vehicle).toBe("car");
    const r = await w.svc.applyTransportLines(w.oct.id, "ceo-1");
    expect(r.written).toBe(1);
    expect([...w.salaryStore.lines.values()].find((l) => l.kind === "transport")!.amountSatang).toBe(7_200);
    // a trip entered AFTER the change is the new vehicle's
    const t2 = (await w.svc.createTrip({ teacherId: A, date: "2026-10-15", schoolId: w.sta.id, roundTrip: false }, "x", "ceo")) as { vehicle: string };
    expect(t2.vehicle).toBe("motorbike");
  });
  test("no profile / no vehicle on file ⇒ the snapshot is null and the CEO sees amountSatang null (nothing guessed)", async () => {
    const w = await world();
    const c = (await w.svc.createTrip({ teacherId: C, date: OCT_DAY, schoolId: w.sta.id, roundTrip: false }, "x", "ceo")) as { vehicle: null; amountSatang: null };
    const n = (await w.svc.createTrip({ teacherId: NOBODY, date: OCT_DAY, schoolId: w.sta.id, roundTrip: false }, "x", "ceo")) as { vehicle: null; amountSatang: null };
    expect([c.vehicle, c.amountSatang, n.vehicle, n.amountSatang]).toEqual([null, null, null, null]);
  });
  test("a NULL snapshot is filled from the profile on the next edit (and only a null one is)", async () => {
    const w = await world();
    const t = (await w.svc.createTrip({ teacherId: C, date: OCT_DAY, schoolId: w.sta.id, roundTrip: false }, "x", "ceo")) as { id: string };
    await w.salary.setProfile(C, { employmentType: "FT", baseSalary: 1_000_000, active: true, vehicle: "motorbike" });
    const edited = (await w.svc.updateTrip(t.id, { note: "added vehicle later" }, "ceo")) as { vehicle: string };
    expect(edited.vehicle).toBe("motorbike");
    await w.salary.setProfile(C, { employmentType: "FT", baseSalary: 1_000_000, active: true, vehicle: "car" });
    expect(((await w.svc.updateTrip(t.id, { note: "again" }, "ceo")) as { vehicle: string }).vehicle).toBe("motorbike"); // not overwritten
  });
  test("an unknown or an inactive school is 400; a bad date is 400; a bad km is 400", async () => {
    const w = await world();
    await rejects(w.svc.createTrip({ teacherId: A, date: OCT_DAY, schoolId: "00000000-0000-4000-8000-0000000000ee", roundTrip: true }, "x", "ceo"), 400);
    await w.svc.updateSchool(w.abc.id, { active: false });
    await rejects(w.svc.createTrip({ teacherId: A, date: OCT_DAY, schoolId: w.abc.id, roundTrip: true }, "x", "ceo"), 400);
    await rejects(w.svc.createTrip({ teacherId: A, date: "2026-02-30", schoolId: w.sta.id, roundTrip: true }, "x", "ceo"), 400);
    await rejects(w.svc.createTrip({ teacherId: A, date: OCT_DAY, schoolId: w.sta.id, roundTrip: true, km: 0 }, "x", "ceo"), 400);
    await rejects(w.svc.createTrip({ teacherId: A, date: OCT_DAY, schoolId: w.sta.id, roundTrip: true, km: 1.234 }, "x", "ceo"), 400);
  });
  test("createdBy is the actor; the note is trimmed, blank = null", async () => {
    const w = await world();
    await w.svc.createTrip({ teacherId: A, date: OCT_DAY, schoolId: w.sta.id, roundTrip: true, note: "  hi " }, "admin-7", "ceo");
    await w.svc.createTrip({ teacherId: A, date: "2026-10-15", schoolId: w.sta.id, roundTrip: true, note: "   " }, "admin-7", "ceo");
    const rows = [...w.store.trips.values()];
    expect(rows.map((r) => [r.createdBy, r.note])).toEqual([["admin-7", "hi"], ["admin-7", null]]);
  });
});

describe("update and delete", () => {
  async function one() {
    const w = await world();
    const t = (await w.svc.createTrip({ teacherId: A, date: OCT_DAY, schoolId: w.sta.id, roundTrip: true }, "x", "ceo")) as { id: string };
    return { w, id: t.id };
  }
  test("km omitted + round trip → one way: the default is recomputed (24 → 12)", async () => {
    const { w, id } = await one();
    expect(((await w.svc.updateTrip(id, { roundTrip: false }, "ceo")) as { km: number }).km).toBe(12);
  });
  test("km omitted + another school: recomputed from THAT school (8 × 2 = 16)", async () => {
    const { w, id } = await one();
    expect(((await w.svc.updateTrip(id, { schoolId: w.abc.id }, "ceo")) as { km: number }).km).toBe(16);
  });
  test("km omitted and nothing that changes the distance: the (edited) km STAYS", async () => {
    const { w, id } = await one();
    await w.svc.updateTrip(id, { km: 30 }, "ceo");
    expect(((await w.svc.updateTrip(id, { note: "n", date: "2026-10-16" }, "ceo")) as { km: number }).km).toBe(30);
  });
  test("an explicit km with a school change wins over the default", async () => {
    const { w, id } = await one();
    expect(((await w.svc.updateTrip(id, { schoolId: w.abc.id, km: 20 }, "ceo")) as { km: number }).km).toBe(20);
  });
  test("unknown trip → 404 for update and delete; delete removes it", async () => {
    const { w, id } = await one();
    await rejects(w.svc.updateTrip("00000000-0000-4000-8000-0000000000dd", { note: "x" }, "ceo"), 404);
    await rejects(w.svc.deleteTrip("00000000-0000-4000-8000-0000000000dd"), 404);
    await w.svc.deleteTrip(id);
    expect(w.store.trips.size).toBe(0);
  });
  test("moving a trip to an unknown school is 400", async () => {
    const { w, id } = await one();
    await rejects(w.svc.updateTrip(id, { schoolId: "00000000-0000-4000-8000-0000000000ee" }, "ceo"), 400);
  });
});

describe("🔑 the admin sees no amount (R0.2) — decided in tripDTO, by a whitelist", () => {
  const trip: Trip = { id: "t1", teacherId: A, date: OCT_DAY, schoolId: "s1", roundTrip: true, km: 24, vehicle: "car", note: "n", createdBy: "u" };
  test("the CEO's trip has exactly the CEO keys, with the amount and the vehicle", () => {
    const d = tripDTO(trip, "STA", "ceo");
    expect(Object.keys(d).sort()).toEqual([...CEO_TRIP_KEYS]);
    expect(d).toMatchObject({ amountSatang: 14_400, vehicle: "car" });
  });
  test("the ADMIN's trip has exactly the admin keys: no amountSatang, no vehicle, no createdBy", () => {
    const d = tripDTO(trip, "STA", "admin");
    expect(Object.keys(d).sort()).toEqual([...ADMIN_TRIP_KEYS]);
    expect("amountSatang" in d).toBe(false);
    expect("vehicle" in d).toBe(false);
    expect(JSON.stringify(d)).not.toMatch(/amount|vehicle|14400|car|createdBy/i);
  });
  test("every service path that returns a trip to an admin is clean: create, update, list", async () => {
    const w = await world();
    const created = await w.svc.createTrip({ teacherId: A, date: OCT_DAY, schoolId: w.sta.id, roundTrip: true }, "x", "admin");
    const updated = await w.svc.updateTrip((created as { id: string }).id, { km: 40 }, "admin");
    const listed = await w.svc.listTrips({ periodId: w.oct.id }, "admin");
    for (const d of [created, updated, ...listed]) expect(Object.keys(d).sort()).toEqual([...ADMIN_TRIP_KEYS]);
    expect(JSON.stringify([created, updated, listed])).not.toMatch(/amountSatang|vehicle/);
  });
  test("the same trips for the CEO DO carry the amount (the rule is about the viewer, not a missing field)", async () => {
    const w = await world();
    await w.svc.createTrip({ teacherId: A, date: OCT_DAY, schoolId: w.sta.id, roundTrip: true }, "x", "admin");
    const [t] = (await w.svc.listTrips({ periodId: w.oct.id }, "ceo")) as { amountSatang: number }[];
    expect(t.amountSatang).toBe(14_400);
  });
});

describe("the lock — a trip in a locked period is 409 LOCKED", () => {
  test("create / update / delete are refused in a locked period; a trip moved INTO or OUT OF one is refused too", async () => {
    const w = await world();
    const inOct = (await w.svc.createTrip({ teacherId: A, date: OCT_DAY, schoolId: w.sta.id, roundTrip: true }, "x", "ceo")) as { id: string };
    const inSep = (await w.svc.createTrip({ teacherId: A, date: "2026-09-10", schoolId: w.sta.id, roundTrip: true }, "x", "ceo")) as { id: string };
    await w.salary.lockPeriod(w.sep.id);
    await rejects(w.svc.createTrip({ teacherId: A, date: "2026-09-11", schoolId: w.sta.id, roundTrip: true }, "x", "ceo"), 409, "LOCKED");
    await rejects(w.svc.updateTrip(inSep.id, { note: "x" }, "ceo"), 409, "LOCKED");
    await rejects(w.svc.deleteTrip(inSep.id), 409, "LOCKED");
    await rejects(w.svc.updateTrip(inOct.id, { date: "2026-09-12" }, "ceo"), 409, "LOCKED"); // INTO the locked period
    await rejects(w.svc.updateTrip(inSep.id, { date: OCT_DAY }, "ceo"), 409, "LOCKED"); // OUT of it
    expect(w.store.trips.size).toBe(2); // nothing changed
    // an open period still works
    expect(await w.svc.updateTrip(inOct.id, { note: "ok" }, "ceo")).toBeDefined();
  });
  test("the 12:00 auto-lock counts (Jason's lazy lock): after October's lockAt a trip in October is refused without anyone pressing lock", async () => {
    const w = await world();
    const t = (await w.svc.createTrip({ teacherId: A, date: OCT_DAY, schoolId: w.sta.id, roundTrip: true }, "x", "ceo")) as { id: string };
    w.setNow("2026-10-31T06:00:00Z"); // 13:00 Bangkok on 31/10, after 12:00 on the last day
    await rejects(w.svc.updateTrip(t.id, { note: "late" }, "ceo"), 409, "LOCKED");
  });
  test("the lock covers the period's range INCLUSIVELY: 30/9 and 30/10 are inside locked October; 29/9 and 31/10 are not", async () => {
    const w = await world();
    await w.salary.lockPeriod(w.oct.id);
    const make = (date: string) => w.svc.createTrip({ teacherId: A, date, schoolId: w.sta.id, roundTrip: true }, "x", "ceo");
    await rejects(make("2026-09-30"), 409, "LOCKED");
    await rejects(make("2026-10-30"), 409, "LOCKED");
    expect(await make("2026-09-29")).toBeDefined(); // September's (open)
    expect(await make("2026-10-31")).toBeDefined(); // November's (no period yet)
  });
  test("a date no period covers (yet) is open", async () => {
    const w = await world();
    expect(await w.svc.createTrip({ teacherId: A, date: "2027-03-05", schoolId: w.sta.id, roundTrip: true }, "x", "ceo")).toBeDefined();
  });
  test("applying a locked period is 409 LOCKED and reads nothing", async () => {
    const w = await world();
    await w.svc.createTrip({ teacherId: A, date: OCT_DAY, schoolId: w.sta.id, roundTrip: true }, "x", "ceo");
    await w.salary.lockPeriod(w.oct.id);
    await rejects(w.svc.applyTransportLines(w.oct.id, "ceo-1"), 409, "LOCKED");
    expect(w.lines.added).toBe(0);
  });
});

describe("listTrips — by period and person", () => {
  test("only the period's R1.4 range: 30/9 and 30/10 are October's, 29/9 and 31/10 are not", async () => {
    const w = await world();
    for (const date of ["2026-09-29", "2026-09-30", "2026-10-30"]) await w.svc.createTrip({ teacherId: A, date, schoolId: w.sta.id, roundTrip: false }, "x", "ceo");
    await w.svc.createTrip({ teacherId: A, date: "2026-10-31", schoolId: w.sta.id, roundTrip: false }, "x", "ceo"); // November's (no period yet → open)
    const oct = (await w.svc.listTrips({ periodId: w.oct.id }, "ceo")) as { date: string }[];
    expect(oct.map((t) => t.date)).toEqual(["2026-09-30", "2026-10-30"]);
    const sep = (await w.svc.listTrips({ periodId: w.sep.id }, "ceo")) as { date: string }[];
    expect(sep.map((t) => t.date)).toEqual(["2026-09-29"]);
  });
  test("the teacher filter", async () => {
    const w = await world();
    await w.svc.createTrip({ teacherId: A, date: OCT_DAY, schoolId: w.sta.id, roundTrip: false }, "x", "ceo");
    await w.svc.createTrip({ teacherId: B, date: OCT_DAY, schoolId: w.sta.id, roundTrip: false }, "x", "ceo");
    expect(((await w.svc.listTrips({ periodId: w.oct.id, teacherId: B }, "ceo")) as { teacherId: string }[]).map((t) => t.teacherId)).toEqual([B]);
  });
  test("an unknown period is 404; the school's name rides on the trip", async () => {
    const w = await world();
    await rejects(w.svc.listTrips({ periodId: "00000000-0000-4000-8000-0000000000aa" }, "ceo"), 404);
    await w.svc.createTrip({ teacherId: A, date: OCT_DAY, schoolId: w.sta.id, roundTrip: false }, "x", "ceo");
    expect(((await w.svc.listTrips({ periodId: w.oct.id }, "admin")) as { schoolName: string }[])[0].schoolName).toBe("STA");
  });
});

describe("applyTransportLines — the auto pay lines", () => {
  const lineRows = (w: Awaited<ReturnType<typeof world>>) => [...w.salaryStore.lines.values()].filter((l) => l.kind === "transport");

  test("one trip → ONE line: kind transport, source auto, source_ref trip:<id>, the label, the exact satang", async () => {
    const w = await world();
    const t = (await w.svc.createTrip({ teacherId: A, date: OCT_DAY, schoolId: w.sta.id, roundTrip: true }, "x", "ceo")) as { id: string };
    const r = await w.svc.applyTransportLines(w.oct.id, "ceo-1");
    expect(r).toEqual({ written: 1, unchanged: 0, skipped: [], orphaned: [], changed: [] });
    expect(lineRows(w)).toEqual([
      { id: expect.any(String), slipId: w.slipOf(A).id, kind: "transport", label: "STA · 14/10/26 · Round trip · 24 km", amountSatang: 14_400, source: "auto", createdBy: "ceo-1", sourceRef: tripSourceRef(t.id) },
    ]);
  });
  test("a one-way trip's label uses the one-way word and the km", async () => {
    const w = await world();
    await w.svc.createTrip({ teacherId: B, date: OCT_DAY, schoolId: w.abc.id, roundTrip: false }, "x", "ceo");
    await w.svc.applyTransportLines(w.oct.id, "ceo-1");
    expect(lineRows(w)[0]).toMatchObject({ label: "ABC · 14/10/26 · One way · 8 km", amountSatang: 4_000 }); // 8 km by motorbike = 24 ฿ → minimum 40
  });
  test("🔑 IDEMPOTENT: a second run writes nothing and the rows are the same; a lost race counts as unchanged", async () => {
    const w = await world();
    await w.svc.createTrip({ teacherId: A, date: OCT_DAY, schoolId: w.sta.id, roundTrip: true }, "x", "ceo");
    await w.svc.applyTransportLines(w.oct.id, "ceo-1");
    const again = await w.svc.applyTransportLines(w.oct.id, "ceo-1");
    expect(again).toMatchObject({ written: 0, unchanged: 1 });
    expect(lineRows(w)).toHaveLength(1);
    const racing = { ...w.lines, insertAutoTransportLine: async () => "exists" as const };
    const w2 = await world();
    await w2.svc.createTrip({ teacherId: A, date: OCT_DAY, schoolId: w2.sta.id, roundTrip: true }, "x", "ceo");
    const svc2 = createTransportService({ store: w2.store, lines: racing, salary: w2.salary, profiles: w2.salaryStore });
    expect(await svc2.applyTransportLines(w2.oct.id, "x")).toMatchObject({ written: 0, unchanged: 1 });
  });
  test("two trips on the same day for the same person are two lines (each trip in full, R1.6)", async () => {
    const w = await world();
    await w.svc.createTrip({ teacherId: A, date: OCT_DAY, schoolId: w.sta.id, roundTrip: true }, "x", "ceo");
    await w.svc.createTrip({ teacherId: A, date: OCT_DAY, schoolId: w.sta.id, roundTrip: true }, "x", "ceo");
    expect((await w.svc.applyTransportLines(w.oct.id, "x")).written).toBe(2);
  });
  test("a new trip entered after the first run is added by the next; the old line is untouched", async () => {
    const w = await world();
    await w.svc.createTrip({ teacherId: A, date: OCT_DAY, schoolId: w.sta.id, roundTrip: true }, "x", "ceo");
    await w.svc.applyTransportLines(w.oct.id, "x");
    await w.svc.createTrip({ teacherId: B, date: OCT_DAY, schoolId: w.abc.id, roundTrip: false }, "x", "ceo");
    expect(await w.svc.applyTransportLines(w.oct.id, "x")).toMatchObject({ written: 1, unchanged: 1 });
  });
  test("🔑 a trip with no vehicle on file is SKIPPED_NO_VEHICLE, listed, and nothing is written", async () => {
    const w = await world();
    const t = (await w.svc.createTrip({ teacherId: C, date: OCT_DAY, schoolId: w.sta.id, roundTrip: true }, "x", "ceo")) as { id: string };
    const r = await w.svc.applyTransportLines(w.oct.id, "x");
    expect(r.written).toBe(0);
    expect(r.skipped).toEqual([{ reason: "SKIPPED_NO_VEHICLE", tripId: t.id, teacherId: C, date: OCT_DAY, sourceRef: tripSourceRef(t.id) }]);
    expect(lineRows(w)).toHaveLength(0);
  });
  test("a person with no slip in the run is SKIPPED_NO_SLIP and no slip is created", async () => {
    const w = await world();
    await w.salary.setProfile(D, { employmentType: "FL", baseSalary: null, active: true, vehicle: "car" }); // FL with no hours: no slip
    await w.svc.createTrip({ teacherId: D, date: OCT_DAY, schoolId: w.sta.id, roundTrip: true }, "x", "ceo");
    const slipsBefore = w.salaryStore.slips.size;
    const r = await w.svc.applyTransportLines(w.oct.id, "x");
    expect(r.skipped.map((s) => s.reason)).toEqual(["SKIPPED_NO_SLIP"]);
    expect(w.salaryStore.slips.size).toBe(slipsBefore);
  });
  test("a confirmed slip is SKIPPED_CONFIRMED and a locked one inside an open period SKIPPED_LOCKED; neither is written", async () => {
    const w = await world();
    await w.svc.createTrip({ teacherId: A, date: OCT_DAY, schoolId: w.sta.id, roundTrip: true }, "x", "ceo");
    await w.svc.createTrip({ teacherId: B, date: OCT_DAY, schoolId: w.sta.id, roundTrip: true }, "x", "ceo");
    w.salaryStore.slips.get(w.slipOf(A).id)!.status = "confirmed";
    w.salaryStore.slips.get(w.slipOf(B).id)!.status = "locked";
    const r = await w.svc.applyTransportLines(w.oct.id, "x");
    expect(r.skipped.map((s) => s.reason).sort()).toEqual(["SKIPPED_CONFIRMED", "SKIPPED_LOCKED"]);
    expect(lineRows(w)).toHaveLength(0);
  });
  test("only the period's own trips: a trip on 29/9 (September) and one on 31/10 (November) are not October's lines", async () => {
    const w = await world();
    for (const date of ["2026-09-29", "2026-10-31"]) await w.svc.createTrip({ teacherId: A, date, schoolId: w.sta.id, roundTrip: true }, "x", "ceo");
    expect((await w.svc.applyTransportLines(w.oct.id, "x")).written).toBe(0);
    expect((await w.svc.applyTransportLines(w.sep.id, "x")).written).toBe(1);
  });
  test("an unknown period is 404", async () => {
    const w = await world();
    await rejects(w.svc.applyTransportLines("00000000-0000-4000-8000-0000000000aa", "x"), 404);
  });
  test("🔑 a trip edited after its line was written is reported `changed` and the line is NOT rewritten; a deleted trip's line is `orphaned`, NOT deleted", async () => {
    const w = await world();
    const a = (await w.svc.createTrip({ teacherId: A, date: OCT_DAY, schoolId: w.sta.id, roundTrip: true }, "x", "ceo")) as { id: string };
    const b = (await w.svc.createTrip({ teacherId: B, date: OCT_DAY, schoolId: w.sta.id, roundTrip: true }, "x", "ceo")) as { id: string };
    await w.svc.applyTransportLines(w.oct.id, "x");
    await w.svc.updateTrip(a.id, { km: 40 }, "ceo");
    await w.svc.deleteTrip(b.id);
    const r = await w.svc.applyTransportLines(w.oct.id, "x");
    expect(r.written).toBe(0);
    expect(r.changed).toEqual([{ slipId: w.slipOf(A).id, sourceRef: tripSourceRef(a.id), existing: { label: "STA · 14/10/26 · Round trip · 24 km", amountSatang: 14_400 }, wanted: { label: "STA · 14/10/26 · Round trip · 40 km", amountSatang: 24_000 } }]);
    expect(r.orphaned).toEqual([{ slipId: w.slipOf(B).id, sourceRef: tripSourceRef(b.id), label: "STA · 14/10/26 · Round trip · 24 km", amountSatang: 7_200, note: "TRIP_GONE" }]); // 24 km by motorbike = 72 ฿
    expect(lineRows(w)).toHaveLength(2); // nothing deleted, nothing rewritten
  });
  test("the slip total is real: base + Σ lines in integer satang through Jason's getSlip, and a re-run does not move it", async () => {
    const w = await world();
    await w.svc.createTrip({ teacherId: A, date: OCT_DAY, schoolId: w.sta.id, roundTrip: true }, "x", "ceo"); // 144 ฿
    await w.svc.createTrip({ teacherId: A, date: "2026-10-16", schoolId: w.abc.id, roundTrip: false }, "x", "ceo"); // 8 km car = 48 → 60 ฿
    await w.svc.applyTransportLines(w.oct.id, "x");
    const slip = await w.salary.getSlip(w.slipOf(A).id);
    expect(slip.total).toBe(2_500_000 + 14_400 + 6_000);
    expect(slip.lines.map((l: { kindLabel: string }) => l.kindLabel)).toEqual(["Transport", "Transport"]);
    await w.svc.applyTransportLines(w.oct.id, "x");
    expect((await w.salary.getSlip(w.slipOf(A).id)).total).toBe(2_520_400);
  });
});

describe("the pure plan and reconcile", () => {
  const T = (o: Partial<Trip> = {}): Trip => ({ id: "t1", teacherId: A, date: OCT_DAY, schoolId: "s", roundTrip: true, km: 24, vehicle: "car", note: null, createdBy: null, ...o });
  const slips = new Map([[A, { id: "slipA", status: "draft" as const }]]);
  test("a NO_VEHICLE trip is skipped BEFORE the slip is looked at (the data problem is named first) and is never 'wanted'", () => {
    const p = planTransportLines({ trips: [T({ vehicle: null, teacherId: NOBODY })], schoolName: () => "S", slipByTeacher: slips });
    expect(p.skipped.map((s) => s.reason)).toEqual(["SKIPPED_NO_VEHICLE"]);
    expect(p.wantedKeys.size).toBe(0);
  });
  test("a confirmed slip's trip is still 'wanted' (so its existing line is not called an orphan)", () => {
    const p = planTransportLines({ trips: [T()], schoolName: () => "S", slipByTeacher: new Map([[A, { id: "slipA", status: "confirmed" as const }]]) });
    expect(p.wantedKeys.has("slipA|trip:t1")).toBe(true);
    const r = reconcile(p, [{ slipId: "slipA", sourceRef: "trip:t1", label: "old", amountSatang: 1 }]);
    expect(r.orphaned).toEqual([]);
  });
  test("`changed` is reported when ONLY the amount differs, and when ONLY the label differs (never applied)", () => {
    const d = { slipId: "slipA", teacherId: A, sourceRef: "trip:t1", label: "L", amountSatang: 100 };
    const plan = { desired: [d], wantedKeys: new Set(["slipA|trip:t1"]) };
    expect(reconcile(plan, [{ slipId: "slipA", sourceRef: "trip:t1", label: "L", amountSatang: 999 }]).changed).toHaveLength(1); // amount only
    expect(reconcile(plan, [{ slipId: "slipA", sourceRef: "trip:t1", label: "other", amountSatang: 100 }]).changed).toHaveLength(1); // label only
    const same = reconcile(plan, [{ slipId: "slipA", sourceRef: "trip:t1", label: "L", amountSatang: 100 }]);
    expect([same.unchanged, same.changed.length, same.toWrite.length]).toEqual([1, 0, 0]);
  });
  test("a school renamed after its trips were paid changes the LABEL only: reported, not rewritten", async () => {
    const w = await world();
    await w.svc.createTrip({ teacherId: A, date: OCT_DAY, schoolId: w.sta.id, roundTrip: true }, "x", "ceo");
    await w.svc.applyTransportLines(w.oct.id, "x");
    await w.svc.updateSchool(w.sta.id, { name: "STA2" });
    const r = await w.svc.applyTransportLines(w.oct.id, "x");
    expect(r.changed).toHaveLength(1);
    expect(r.changed[0].wanted.amountSatang).toBe(r.changed[0].existing.amountSatang);
    expect([...w.salaryStore.lines.values()].find((l) => l.kind === "transport")!.label).toContain("STA ·");
  });
  test("reconcile never calls another feature's auto line an orphan (a bonus line's source_ref is not trip:…)", () => {
    const existing: ExistingTransportLine[] = [{ slipId: "slipA", sourceRef: "b50:p:c", label: "Bonus 50", amountSatang: 5_000 }];
    expect(reconcile({ desired: [], wantedKeys: new Set() }, existing).orphaned).toEqual([]);
  });
  test("the plan does not mutate its input", () => {
    const trips = [T()];
    const before = JSON.stringify(trips);
    planTransportLines({ trips, schoolName: () => "S", slipByTeacher: slips });
    expect(JSON.stringify(trips)).toBe(before);
  });
});
