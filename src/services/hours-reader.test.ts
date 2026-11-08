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
import { day, EDGE_RANGE, EDGE_ROWS, FIXTURES, row } from "./hours-reader.fixtures";

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
    expect(Object.keys(d!).sort()).toEqual(["byType", "date", "teachingMinutesTotal"]);
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
