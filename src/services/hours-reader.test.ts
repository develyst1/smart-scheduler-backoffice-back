import { describe, expect, test } from "bun:test";
import { ApiException } from "../lib/http";
import {
  bucketMinutes,
  classifyRow,
  CLASS_TYPES,
  COUNTED_STATUSES,
  COUNT_EMPTY_GROUP,
  liveGroupIds,
  minutesBetween,
  readHours,
  skippedMinutes,
  type TimetableRow,
} from "./hours-reader";
import { day, EDGE_RANGE, EDGE_ROWS, FIXTURES, kid, row } from "./hours-reader.fixtures";
import { childrenTaught, nameOf } from "./hours-reader";

// TASK-872 — the hours reader's rules, on fixtures of real timetable shapes. No database: `bucketMinutes` is pure and
// `readHours` is driven through its injectable `collect`. The one SELECT (`collectRows`) is proven on sid, read-only.

const TEACHER = "11111111-1111-4111-8111-111111111111";
const OTHER_TEACHER = "22222222-2222-4222-8222-222222222222";

describe("the pure core — one fixture per timetable shape", () => {
  test.each(FIXTURES.map((f) => [f.name, f] as const))("%s", (_name, f) => {
    expect(bucketMinutes(f.rows)).toEqual(f.expect);
  });

  test("the fixtures cover every one of the five class types and every Step 0 question default", () => {
    const seen = new Set(FIXTURES.flatMap((f) => f.expect.flatMap((d) => CLASS_TYPES.filter((t) => d.byType[t] > 0))));
    expect([...seen].sort()).toEqual([...CLASS_TYPES].sort());
    const names = FIXTURES.map((f) => f.name).join("\n");
    for (const q of ["[Q1]", "[Q2]", "[Q3]", "[Q4]", "[Q6]"]) expect(names + FIXTURES.map((f) => f.rule).join("\n")).toContain(q);
  });

  test("every fixture names the rule it pins", () => {
    for (const f of FIXTURES) expect(f.rule.length).toBeGreaterThan(10);
  });
});

describe("nothing vanishes unexplained", () => {
  const allRows = FIXTURES.flatMap((f) => f.rows);
  const counted = (rows: TimetableRow[]) => bucketMinutes(rows).reduce((n, d) => n + d.teachingMinutesTotal, 0);
  const skipped = (rows: TimetableRow[]) => Object.values(skippedMinutes(rows)).reduce((n, m) => n + (m ?? 0), 0);
  const total = (rows: TimetableRow[]) => rows.reduce((n, r) => n + minutesBetween(r.startTime, r.endTime), 0);

  test("counted + skipped minutes = every row's minutes, over all fixtures", () => {
    expect(counted(allRows) + skipped(allRows)).toBe(total(allRows));
  });

  test("each skip reason is reported under its own name", () => {
    const rows = [
      row({ status: "CANCELLED" }), // status
      row({ groupId: "g" }), // seat
      row({ bookingType: "GROUP", otherKind: "GROUP", slotYieldedAt: "2026-10-10T00:00:00Z" }), // yielded
      row({ bookingType: "OTHER", otherKind: null }), // not-a-class-type
      row({ bookingType: "GROUP", otherKind: null }), // unknown-group-kind
      row({ bookingType: "GROUP", otherKind: "GROUP" }), // empty-group (no seat in `rows`)
      row({ bookingType: "MYSTERY" }), // unknown-booking-type
      row({ startTime: "10:00:00", endTime: "10:00:00" }), // no-duration
    ];
    expect(Object.keys(skippedMinutes(rows)).sort()).toEqual(
      ["empty-group", "no-duration", "not-a-class-type", "seat", "status", "unknown-booking-type", "unknown-group-kind", "yielded"].sort(),
    );
  });
});

describe("[Q3] the empty-group rule (REQ-105 §5 #4)", () => {
  test("the switch is one named constant, and it is OFF: an empty group is not the coach's work", () => {
    expect(COUNT_EMPTY_GROUP).toBe(false);
  });
  test("liveGroupIds: a group is live with ≥ 1 seat in a counted status, by group_id", () => {
    const live = liveGroupIds([
      row({ groupId: "g-a", status: "ATTENDED" }),
      row({ groupId: "g-b", status: "SICK_LEAVE" }),
      row({ groupId: "g-b", status: "CANCELLED" }),
      row({ groupId: "g-c", status: "PENDING" }),
      row({ groupId: "g-d", status: "NO_SHOW" }),
      row({ groupId: "g-e", status: "CONFIRMED" }),
      row({ status: "ATTENDED" }), // not a seat: makes nothing live
    ]);
    expect([...live].sort()).toEqual(["g-a", "g-d", "g-e"]);
  });
  test("classifyRow: the same GROUP row is empty without a live seat and counted with one", () => {
    const g = row({ id: "g-x", bookingType: "GROUP", otherKind: "GROUP" });
    expect(classifyRow(g)).toEqual({ skipped: "empty-group" });
    expect(classifyRow(g, new Set(["g-other"]))).toEqual({ skipped: "empty-group" });
    expect(classifyRow(g, new Set(["g-x"]))).toEqual({ type: "group", minutes: 60 });
  });
  test("a yielded or unknown-kind group row keeps its OWN reason, not 'empty-group' (a rule gap stays visible)", () => {
    expect(classifyRow(row({ bookingType: "GROUP", otherKind: "GROUP", slotYieldedAt: "2026-10-10T00:00:00Z" }))).toEqual({ skipped: "yielded" });
    expect(classifyRow(row({ bookingType: "GROUP", otherKind: null }))).toEqual({ skipped: "unknown-group-kind" });
  });
  test("an EXTRA coach on a group sees it live because collectRows hands over the seats, whoever their teacher is", async () => {
    // collect for the extra coach returns the group row (they are on it) AND its seat rows (fetched by group_id).
    const g = row({ id: "g-ex", bookingType: "GROUP", otherKind: "GROUP", startTime: "16:00:00", endTime: "17:30:00" });
    const got = await readHours(OTHER_TEACHER, "2026-10-01", "2026-10-31", async () => [g, row({ groupId: "g-ex" })]);
    expect(got).toEqual([day("2026-10-14", { group: 90 })]);
    // …and without the seats it would (wrongly) read as empty: the reason collectRows fetches them.
    expect(await readHours(OTHER_TEACHER, "2026-10-01", "2026-10-31", async () => [g])).toEqual([]);
  });
});

describe("classifyRow", () => {
  test("a GROUP row of an unknown kind is surfaced, never guessed into a bucket", () => {
    expect(classifyRow(row({ bookingType: "GROUP", otherKind: null }))).toEqual({ skipped: "unknown-group-kind" });
    expect(classifyRow(row({ bookingType: "GROUP", otherKind: "WEIRD" }))).toEqual({ skipped: "unknown-group-kind" });
  });
  test("a type this reader does not know is surfaced", () => {
    expect(classifyRow(row({ bookingType: "SOMETHING_NEW" }))).toEqual({ skipped: "unknown-booking-type" });
  });
  test("an end that is not after the start counts nothing", () => {
    expect(classifyRow(row({ startTime: "11:00:00", endTime: "10:00:00" }))).toEqual({ skipped: "no-duration" });
  });
  test("a seat is a seat whatever its status or type", () => {
    for (const bookingType of ["COURSE_PACKAGE", "VOUCHER", "SINGLE_SESSION"]) {
      expect(classifyRow(row({ groupId: "g-1", bookingType, status: "ATTENDED" }))).toEqual({ skipped: "seat" });
    }
  });
  test("the counted statuses are exactly CONFIRMED · ATTENDED · NO_SHOW", () => {
    expect([...COUNTED_STATUSES].sort()).toEqual(["ATTENDED", "CONFIRMED", "NO_SHOW"]);
  });
});

describe("minutesBetween", () => {
  test.each([
    ["10:00:00", "11:00:00", 60],
    ["10:00", "11:30", 90],
    ["09:15:00", "10:00:00", 45],
    ["22:00:00", "23:59:00", 119],
    ["10:00:00", "10:00:00", 0],
    ["11:00:00", "10:00:00", 0],
    ["", "10:00:00", 0],
    ["nope", "10:00:00", 0],
  ])("%s → %s = %i min", (s, e, want) => {
    expect(minutesBetween(s, e)).toBe(want);
  });
  test("always an integer", () => {
    expect(Number.isInteger(minutesBetween("10:00:00", "10:20:40"))).toBe(true);
  });
});

describe("readHours — the contract (SPEC-101 §5)", () => {
  test("the period edges are INCLUSIVE: first and last day in, the day before and after out", async () => {
    const got = await readHours(TEACHER, EDGE_RANGE.start, EDGE_RANGE.end, async () => EDGE_ROWS);
    expect(got.map((d) => d.date)).toEqual(["2026-10-01", "2026-10-31"]);
  });
  test("a single-day period (start = end) works", async () => {
    const got = await readHours(TEACHER, "2026-10-14", "2026-10-14", async () => [row(), row({ date: "2026-10-15" })]);
    expect(got).toEqual([day("2026-10-14", { private: 60 })]);
  });
  test("two coaches on one ECA: the same row, read for each, gives each the whole row", async () => {
    const eca = row({ bookingType: "OTHER", otherKind: "ECA", startTime: "15:00:00", endTime: "16:00:00" });
    const a = await readHours(TEACHER, "2026-10-01", "2026-10-31", async (t) => (t === TEACHER ? [eca] : []));
    const b = await readHours(OTHER_TEACHER, "2026-10-01", "2026-10-31", async (t) => (t === OTHER_TEACHER ? [eca] : []));
    expect(a).toEqual([day("2026-10-14", { eca: 60 })]);
    expect(b).toEqual([day("2026-10-14", { eca: 60 })]);
  });
  test("collect is called with exactly the coach and the period", async () => {
    const seen: unknown[] = [];
    await readHours(TEACHER, "2026-10-01", "2026-10-31", async (...args) => (seen.push(args), []));
    expect(seen).toEqual([[TEACHER, "2026-10-01", "2026-10-31"]]);
  });
  test("a period with no teaching is an empty list, not an error", async () => {
    expect(await readHours(TEACHER, "2026-10-01", "2026-10-31", async () => [])).toEqual([]);
  });
  test("the output keys are exactly the contract's", async () => {
    const [d] = await readHours(TEACHER, "2026-10-01", "2026-10-31", async () => [row()]);
    expect(Object.keys(d!).sort()).toEqual(["byType", "date", "students", "teachingMinutesTotal"]); // TASK-884 added `students`; the other three are TASK-872's
    expect(Object.keys(d!.byType).sort()).toEqual([...CLASS_TYPES].sort());
  });

  test.each([
    ["a non-uuid teacher", "not-a-uuid", "2026-10-01", "2026-10-31"],
    ["an impossible date", TEACHER, "2026-02-30", "2026-10-31"],
    ["a malformed date", TEACHER, "1/10/2026", "2026-10-31"],
    ["start after end", TEACHER, "2026-10-31", "2026-10-01"],
  ])("%s → 400 VALIDATION, and collect is never called", async (_n, t, s, e) => {
    let called = false;
    const err = await readHours(t, s, e, async () => ((called = true), [])).catch((x) => x);
    expect(err).toBeInstanceOf(ApiException);
    expect(err.status).toBe(400);
    expect(err.code).toBe("VALIDATION");
    expect(called).toBe(false);
  });
});

describe("read-only by construction (TASK-872 step 2)", () => {
  const read = (p: string) => Bun.file(new URL(p, import.meta.url)).text();
  const WRITES = /insert\(|update\(|delete\(|execute\(/;

  test("hours-reader.ts has no insert( / update( / delete( / execute(", async () => {
    expect(await read("./hours-reader.ts")).not.toMatch(WRITES);
  });
  test("pub-timetable.ts has none either, and declares no enum or migration", async () => {
    const src = await read("../db/pub-timetable.ts");
    expect(src).not.toMatch(WRITES);
    expect(src).not.toMatch(/pgEnum|pgSchema|\.references\(|bo\.table/);
  });
  test("the reader only SELECTs (db.select is the one query)", async () => {
    const src = await read("./hours-reader.ts");
    expect(src).toMatch(/\.select\(columns\)/);
    // every query call on `db` is a select: the only `db.<verb>` forms in the file are `.select(`
    const verbs = [...src.matchAll(/\bdb\s*\.\s*(\w+)\s*\(/g)].map((m) => m[1]);
    expect(verbs.every((v) => v === "select")).toBe(true);
    expect(src).not.toMatch(/db\s*\.\s*(insert|update|delete)/);
    expect(src).not.toMatch(/\.transaction\b/); // no write unit-of-work either
  });
  test("SB's tables are never given to drizzle-kit: drizzle.config.ts does not name pub-timetable", async () => {
    expect(await read("../../drizzle.config.ts")).not.toContain("pub-timetable");
  });
});

// ───────────────────────────────── TASK-884 — R1.6: who was taught, per day and class type ─────────────────────────────────
// Invented names only. `students` is LABELS: every test below that touches money-shaped output proves the minutes did not move.

describe("TASK-884 — the minutes are exactly TASK-872's (the names add, they never change a number)", () => {
  const strip = (days: ReturnType<typeof bucketMinutes>) => days.map(({ date, byType, teachingMinutesTotal }) => ({ date, byType, teachingMinutesTotal }));

  test.each(FIXTURES.map((f) => [f.name, f] as const))("fixture %s: byType / teachingMinutesTotal identical with children attached to every row", (_n, f) => {
    const withKids = f.rows.map((r, i) => ({ ...r, student: kid(`s${i}`, `Child ${i}`, `C${i}`), coStudent: r.coStudentId ? kid(`co${i}`, `Second ${i}`) : null }));
    expect(strip(bucketMinutes(withKids))).toEqual(strip(f.expect));
    expect(strip(bucketMinutes(f.rows))).toEqual(strip(f.expect));
  });
  test("the same rows with and without children are the same minutes day by day (the EDGE rows too)", () => {
    const withKids = EDGE_ROWS.map((r, i) => ({ ...r, student: kid(`e${i}`, `Edge ${i}`) }));
    expect(strip(bucketMinutes(withKids))).toEqual(strip(bucketMinutes(EDGE_ROWS)));
  });
  test("a counted row without a child is still counted", () => {
    expect(bucketMinutes([row({ student: null })])[0].teachingMinutesTotal).toBe(60);
  });
});

describe("TASK-884 — the names", () => {
  const A = kid("a", "Alpha Anan", "Pim");
  const B = kid("b", "Bravo Boon", "Ben");
  const C = kid("c", "Charlie Chai", "Chai");
  const E = kid("e", "Delta Dao", null);
  const names = (rows: TimetableRow[]) => bucketMinutes(rows)[0].students;

  test("a Private: one name", () => {
    expect(names([row({ student: A })])).toEqual([{ classType: "private", names: ["Pim"] }]);
  });
  test("a DUO course (a second child): two names, each its own entry, never joined", () => {
    const got = names([row({ coStudentId: "b", student: A, coStudent: B })]);
    expect(got).toEqual([{ classType: "duo", names: ["Ben", "Pim"] }]); // same start, so ordered by name: "Ben" before "Pim"
    expect(JSON.stringify(got)).not.toContain("&");
  });
  test("a nickname-less child falls back to the name; a blank nickname too; both trimmed", () => {
    expect(names([row({ student: E })])[0].names).toEqual(["Delta Dao"]);
    expect(names([row({ student: kid("x", "  Echo Eak ", "   ") })])[0].names).toEqual(["Echo Eak"]);
    expect(names([row({ student: kid("y", "Name", " Nick ") })])[0].names).toEqual(["Nick"]);
    expect(nameOf(kid("z", "Zed Zan", null))).toBe("Zed Zan");
  });
  test("a GROUP lists its LIVE seats: 3 live + 1 cancelled seat gives 3 names, not 4, and not the GROUP row own student", () => {
    const g = row({ id: "g-1", bookingType: "GROUP", otherKind: "GROUP", student: kid("own", "Owner Child", "Own") });
    const rows = [
      g,
      row({ groupId: "g-1", student: A }),
      row({ groupId: "g-1", student: B }),
      row({ groupId: "g-1", student: C, status: "CONFIRMED" }),
      row({ groupId: "g-1", student: kid("dead", "Dead Seat", "Dead"), status: "CANCELLED" }),
    ];
    const got = names(rows);
    expect(bucketMinutes(rows)[0].byType.group).toBe(60);
    expect(got).toEqual([{ classType: "group", names: ["Ben", "Chai", "Pim"] }]);
    expect(got[0].names).not.toContain("Own");
    expect(got[0].names).not.toContain("Dead");
  });
  test("a seat on sick leave / paused / pending is not a child taught that day either", () => {
    const rows = [
      row({ id: "g-2", bookingType: "GROUP", otherKind: "GROUP" }),
      row({ groupId: "g-2", student: A }),
      row({ groupId: "g-2", student: B, status: "SICK_LEAVE" }),
      row({ groupId: "g-2", student: C, status: "PAUSED" }),
      row({ groupId: "g-2", student: E, status: "PENDING" }),
    ];
    expect(names(rows)).toEqual([{ classType: "group", names: ["Pim"] }]);
  });
  test("an EMPTY GROUP (no live seat) is not counted: no entry, no name, no minutes", () => {
    const rows = [row({ id: "g-3", bookingType: "GROUP", otherKind: "GROUP", student: A }), row({ groupId: "g-3", student: B, status: "CANCELLED" })];
    expect(bucketMinutes(rows)).toEqual([]);
  });
  test("a live seat that itself carries a second child (the legacy DUO-seat shape) lists BOTH children", () => {
    const rows = [row({ id: "g-9", bookingType: "GROUP", otherKind: "DUO" }), row({ groupId: "g-9", coStudentId: "b", student: A, coStudent: B })];
    expect(names(rows)).toEqual([{ classType: "duo", names: ["Ben", "Pim"] }]);
  });
  test("a DUO group row (kind DUO) lists its two seated children under duo", () => {
    const rows = [row({ id: "g-4", bookingType: "GROUP", otherKind: "DUO" }), row({ groupId: "g-4", student: A }), row({ groupId: "g-4", student: B })];
    expect(names(rows)).toEqual([{ classType: "duo", names: ["Ben", "Pim"] }]);
  });
  test("a group extra coach sees the same seats (they are another coach rows, passed in by collectRows)", async () => {
    const rows = [row({ id: "g-5", bookingType: "GROUP", otherKind: "GROUP" }), row({ groupId: "g-5", student: A })];
    const [d] = await readHours(OTHER_TEACHER, "2026-10-01", "2026-10-31", async () => rows);
    expect(d.students).toEqual([{ classType: "group", names: ["Pim"] }]);
  });
  test("the same child twice in a day is listed ONCE, while all the hours still count", () => {
    const rows = [
      row({ student: A, startTime: "09:00:00", endTime: "10:00:00" }),
      row({ student: A, startTime: "15:00:00", endTime: "16:00:00" }),
      row({ student: B, startTime: "11:00:00", endTime: "12:00:00" }),
    ];
    expect(names(rows)).toEqual([{ classType: "private", names: ["Pim", "Ben"] }]);
    expect(bucketMinutes(rows)[0].byType.private).toBe(180);
  });
  test("one child in two class types the same day appears under each type (de-dup is within a class type)", () => {
    const rows = [row({ student: A }), row({ id: "g-6", bookingType: "GROUP", otherKind: "GROUP", startTime: "13:00:00", endTime: "14:00:00" }), row({ groupId: "g-6", student: A })];
    expect(names(rows)).toEqual([
      { classType: "private", names: ["Pim"] },
      { classType: "group", names: ["Pim"] },
    ]);
  });
  test("order: by the child FIRST lesson start that day, then by name, whatever order the rows arrive in", () => {
    const rows = [
      row({ student: C, startTime: "14:00:00", endTime: "15:00:00" }),
      row({ student: A, startTime: "09:00:00", endTime: "10:00:00" }),
      row({ student: B, startTime: "09:00:00", endTime: "10:00:00" }), // same start as A, so by name: "Ben" before "Pim"
      row({ student: C, startTime: "08:00:00", endTime: "08:30:00" }), // C FIRST start is 08:00, so C leads
    ];
    expect(names(rows)[0].names).toEqual(["Chai", "Ben", "Pim"]);
    expect(names([...rows].reverse())[0].names).toEqual(["Chai", "Ben", "Pim"]);
  });
  test("entries are in CLASS_TYPES order, one per type taught, and a day lists only the types it taught", () => {
    const rows = [
      row({ id: "e1", bookingType: "OTHER", otherKind: "ECA", student: B, startTime: "08:00:00", endTime: "09:00:00" }),
      row({ student: A, startTime: "10:00:00", endTime: "11:00:00" }),
      row({ coStudentId: "c", student: C, coStudent: E, startTime: "12:00:00", endTime: "13:00:00" }),
    ];
    expect(names(rows).map((s) => s.classType)).toEqual(["private", "duo", "eca"]);
    expect(CLASS_TYPES.filter((t) => bucketMinutes(rows)[0].byType[t] > 0)).toEqual(names(rows).map((s) => s.classType));
  });
  test("step 0: an ECA row carries the ONE student it was typed with (SB validation.ts:277), named; a title-only ECA has none, names [] and nothing invented", () => {
    expect(names([row({ bookingType: "OTHER", otherKind: "ECA", student: A })])).toEqual([{ classType: "eca", names: ["Pim"] }]);
    expect(names([row({ bookingType: "OTHER", otherKind: "ECA", student: null })])).toEqual([{ classType: "eca", names: [] }]);
  });
  test("step 0: the derived CAMP grid rows carry no child (the kids live in camp_days): names [] and the minutes still count", () => {
    const got = bucketMinutes([row({ bookingType: "OTHER", otherKind: "CAMP", startTime: "10:00:00", endTime: "15:00:00" })]);
    expect(got[0].byType.camp).toBe(300);
    expect(got[0].students).toEqual([{ classType: "camp", names: [] }]);
  });
  test("a skipped row adds no name: not-a-class-type (FREE / no kind), a yielded group, a non-counted status", () => {
    const rows = [
      row({ bookingType: "OTHER", otherKind: "FREE", student: A }),
      row({ bookingType: "OTHER", otherKind: null, student: B }),
      row({ id: "g-7", bookingType: "GROUP", otherKind: "GROUP", slotYieldedAt: "2026-10-01T00:00:00Z" }),
      row({ groupId: "g-7", student: C }),
      row({ student: E, status: "CANCELLED" }),
    ];
    expect(bucketMinutes(rows)).toEqual([]);
  });
  test("a day with teaching but no children anywhere still has its entry per type (names [])", () => {
    expect(names([row()])).toEqual([{ classType: "private", names: [] }]);
  });
  test("days stay ascending and each day has its own names", () => {
    const got = bucketMinutes([row({ date: "2026-10-15", student: B }), row({ date: "2026-10-14", student: A })]);
    expect(got.map((d) => [d.date, d.students[0].names])).toEqual([["2026-10-14", ["Pim"]], ["2026-10-15", ["Ben"]]]);
  });
  test("the input rows are untouched and a second call gives the same answer", () => {
    const rows = [row({ student: A }), row({ student: B, startTime: "12:00:00", endTime: "13:00:00" })];
    const before = JSON.stringify(rows);
    const first = bucketMinutes(rows);
    expect(JSON.stringify(rows)).toBe(before);
    expect(bucketMinutes(rows)).toEqual(first);
  });
  test("childrenTaught: a GROUP row own child is never its names; a lesson row has its child and the second child", () => {
    const g = row({ id: "g-8", bookingType: "GROUP", otherKind: "GROUP", student: A });
    expect(childrenTaught(g, new Map())).toEqual([]);
    expect(childrenTaught(row({ student: A, coStudent: B }), new Map())).toEqual([A, B]);
    expect(childrenTaught(row({}), new Map())).toEqual([]);
  });
});

describe("TASK-884 — the database side stays read-only and PII-narrow", () => {
  const read = (p: string) => Bun.file(new URL(p, import.meta.url)).text();
  test("the students declaration holds id / name / nickname only (no parent, phone or LINE id), and no is_system", async () => {
    const src = await read("../db/pub-timetable.ts");
    const block = /export const ttStudents = pgTable\("students", \{([\s\S]*?)\}\);/.exec(src)![1];
    expect([...block.matchAll(/(\w+): (?:uuid|text)\(/g)].map((m) => m[1])).toEqual(["id", "name", "nickname"]);
    expect(block).not.toMatch(/parent|phone|line|is_system|birth|note/i);
  });
  test("collectRows joins the children into its two SELECTs (left joins, no extra query)", async () => {
    const src = await read("./hours-reader.ts");
    expect((src.match(/\.leftJoin\(ttStudents/g) ?? []).length).toBe(2);
    expect((src.match(/\.leftJoin\(coStudents/g) ?? []).length).toBe(2);
    expect((src.match(/\.select\(columns\)/g) ?? []).length).toBe(2);
  });
});
