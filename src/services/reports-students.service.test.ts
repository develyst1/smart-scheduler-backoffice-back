import { describe, expect, test } from "bun:test";
// Imported under a query string so it is NOT the module the route test mocks (mock.module is keyed by the plain path).
const spec = "./reports-students.service.ts?real";
const mod = await import(spec);
const { reportStudents, ageOn } = mod as typeof import("./reports-students.service");
type Store = import("./reports-students.service").StudentsStore;
type Rec = import("./reports-students.service").StudentRecord;

const NOW = new Date("2026-11-09T05:00:00Z"); // Bangkok 2026-11-09 12:00
const rec = (o: Partial<Rec> & { id: string; name: string }): Rec => ({
  nickname: null,
  gender: null,
  birthDate: null,
  createdAt: "2026-01-01T00:00:00Z",
  parentName: null,
  parentPhone: null,
  province: null,
  ...o,
});
const SUBJ = { a: "aaaaaaaa-0000-4000-8000-000000000001", b: "bbbbbbbb-0000-4000-8000-000000000002" };

function fake(o: {
  students?: Rec[];
  live?: Record<string, { count: number; subjectIds: string[] }>;
  bookings?: { studentId: string; subjectIds: string[]; lastAttendedOn: string | null }[];
} = {}) {
  const calls = { listStudents: [] as (string | null)[], live: [] as string[], bookings: 0, subjects: 0 };
  const store: Store = {
    listStudents: async (p) => (calls.listStudents.push(p), o.students ?? []),
    live: async (d) => (calls.live.push(d), new Map(Object.entries(o.live ?? {}))),
    bookings: async () => (calls.bookings++, o.bookings ?? []),
    subjects: async () => (calls.subjects++, [{ id: SUBJ.a, name: "Skateboard" }, { id: SUBJ.b, name: "Art" }]),
  };
  return { store, calls };
}
const run = (q: Partial<Parameters<typeof reportStudents>[0]>, f: ReturnType<typeof fake>) => reportStudents({ status: "ACTIVE", ...q }, { store: f.store, now: NOW });

describe("ageOn (Bangkok today)", () => {
  test("whole years; birthday not yet reached this year", () => {
    expect(ageOn("2018-11-09", "2026-11-09")).toBe(8); // birthday today
    expect(ageOn("2018-11-10", "2026-11-09")).toBe(7); // tomorrow
    expect(ageOn("2018-12-01", "2026-11-09")).toBe(7);
    expect(ageOn("2018-01-01", "2026-11-09")).toBe(8);
  });
  test("null for none, garbled, or future", () => {
    expect(ageOn(null, "2026-11-09")).toBeNull();
    expect(ageOn("x", "2026-11-09")).toBeNull();
    expect(ageOn("2027-01-01", "2026-11-09")).toBeNull();
  });
});

describe("reportStudents — shape and rules", () => {
  const f = () =>
    fake({
      students: [
        rec({ id: "s1", name: "Ann", nickname: "A", gender: "F", birthDate: "2018-11-10", createdAt: "2026-03-31T18:00:00Z", parentName: "P", parentPhone: "0811111111", province: "Bangkok" }),
        rec({ id: "s2", name: "Bob" }),
        rec({ id: "s3", name: "Cat" }),
      ],
      live: { s1: { count: 2, subjectIds: [SUBJ.a, SUBJ.b] } },
      bookings: [
        { studentId: "s1", subjectIds: [SUBJ.a], lastAttendedOn: "2026-11-05" },
        { studentId: "s2", subjectIds: [SUBJ.b, SUBJ.a], lastAttendedOn: null },
      ],
    });

  test("the whole row, every key (no money, no extra keys)", async () => {
    const r = await run({ status: "ALL" }, f());
    expect(r.rows[0]).toEqual({
      studentId: "s1",
      name: "Ann",
      nickname: "A",
      gender: "F",
      birthDate: "2018-11-10",
      age: 7,
      parentName: "P",
      parentPhone: "0811111111",
      province: "Bangkok",
      activities: ["Art", "Skateboard"],
      status: "ACTIVE",
      liveEntitlements: 2,
      firstSeenOn: "2026-04-01", // 18:00Z on 03-31 is 01:00 on 04-01 in Bangkok
      lastAttendedOn: "2026-11-05",
    });
    expect(Object.keys(r.rows[0]).length).toBe(14);
    expect(JSON.stringify(r)).not.toMatch(/minor|revenue|amount/i);
  });
  test("default status ACTIVE lists only live students; INACTIVE the rest; ALL both; counts ignore the tab", async () => {
    const act = await run({ status: "ACTIVE" }, f());
    expect(act.rows.map((x) => x.studentId)).toEqual(["s1"]);
    expect(act.counts).toEqual({ active: 1, inactive: 2 });
    const ina = await run({ status: "INACTIVE" }, f());
    expect(ina.rows.map((x) => x.studentId)).toEqual(["s2", "s3"]);
    expect(ina.counts).toEqual({ active: 1, inactive: 2 });
    expect((await run({ status: "ALL" }, f())).rows.length).toBe(3);
  });
  test("activities: live subjects when any is live; else every subject ever booked; else none", async () => {
    const r = await run({ status: "ALL" }, f());
    expect(r.rows[0].activities).toEqual(["Art", "Skateboard"]); // s1: live
    expect(r.rows[1].activities).toEqual(["Art", "Skateboard"]); // s2: not live, booked both
    expect(r.rows[2].activities).toEqual([]); // s3: nothing
    expect(r.rows[2]).toMatchObject({ status: "INACTIVE", liveEntitlements: 0, lastAttendedOn: null });
  });
  test("a live student's activities ignore old bookings of other subjects", async () => {
    const g = fake({
      students: [rec({ id: "s1", name: "Ann" })],
      live: { s1: { count: 1, subjectIds: [SUBJ.a] } },
      bookings: [{ studentId: "s1", subjectIds: [SUBJ.a, SUBJ.b], lastAttendedOn: null }],
    });
    expect((await run({}, g)).rows[0].activities).toEqual(["Skateboard"]);
  });
  test("subjectId filter narrows rows AND counts (by the activities shown)", async () => {
    const r = await run({ status: "ALL", subjectId: SUBJ.b }, f());
    expect(r.rows.map((x) => x.studentId)).toEqual(["s1", "s2"]);
    expect(r.counts).toEqual({ active: 1, inactive: 1 });
  });
  test("keeps the store's name order", async () => {
    expect((await run({ status: "ALL" }, f())).rows.map((x) => x.name)).toEqual(["Ann", "Bob", "Cat"]);
  });
  test("a voucher-only live student (no subject) is ACTIVE with no activities", async () => {
    const g = fake({ students: [rec({ id: "s1", name: "Ann" })], live: { s1: { count: 1, subjectIds: [] } } });
    expect((await run({}, g)).rows[0]).toMatchObject({ status: "ACTIVE", activities: [] });
  });
});

describe("reportStudents — query discipline", () => {
  test("q is trimmed and LIKE-escaped (% _ \\) into a contains pattern; empty q = no pattern", async () => {
    const g = fake();
    await run({ q: "  50%_a\\b  " }, g);
    expect(g.calls.listStudents).toEqual(["%50\\%\\_a\\\\b%"]);
    const h = fake();
    await run({ q: "   " }, h);
    await run({}, h);
    expect(h.calls.listStudents).toEqual([null, null]);
  });
  test("exactly four reads, once each, whatever the number of students (never one per student)", async () => {
    const many = Array.from({ length: 500 }, (_, i) => rec({ id: `s${i}`, name: `N${i}` }));
    const g = fake({ students: many });
    await run({ status: "ALL" }, g);
    expect(g.calls.listStudents.length + g.calls.live.length + g.calls.bookings + g.calls.subjects).toBe(4);
  });
  test("live is evaluated as of TODAY in Bangkok", async () => {
    const g = fake();
    await reportStudents({ status: "ALL" }, { store: g.store, now: new Date("2026-11-08T18:30:00Z") }); // 01:30 on 11-09 in Bangkok
    expect(g.calls.live).toEqual(["2026-11-09"]);
  });
  test("archived students are excluded by the store's query (pinned in the SQL below)", async () => {
    const src = await Bun.file(new URL("./reports-students.service.ts", import.meta.url)).text();
    expect(src).toContain("isNull(rpStudents.archivedAt)");
  });
  test("read-only: the service source has no insert( / update( / delete(", async () => {
    const src = await Bun.file(new URL("./reports-students.service.ts", import.meta.url)).text();
    expect(src).not.toMatch(/\.(insert|update|delete)\(/);
  });
});
