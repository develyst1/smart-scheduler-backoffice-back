// TASK-921 (REQ-120 R1.2 / R1.3) — Commission distribution, DB-free: the pure split (remainder, eligibility, pool) and the apply over memory stores. Each test must fail when its code is removed
// (mutation set: commission-task921.mutations.json). The SQL itself (the draft-only guard, ON CONFLICT, the Bangkok-day range) is proven on sid in a rolled-back run.
import { describe, expect, test } from "bun:test";
import { ApiException } from "../lib/http";
import { STAFF_COMMISSION_GROUP, equalShares, isStaffGroup, ownLabel, ownRef, poolLabel, poolRef, poolSplit, splitLine } from "../lib/commission-split";
import { applyCommissionLines, type CommissionDeps, type CommissionLineStore, type CommissionSaleStore, type ExistingCommissionLine, type SaleLineRow } from "./commission-lines.service";
import type { NotifyEvent } from "./salary-notify";

const file = async (p: string) => (await Bun.file(new URL(p, import.meta.url)).text()).replace(/\r\n/g, "\n");

describe("equalShares — the remainder satang go to the first shares; what goes in comes out", () => {
  test("100 satang / 3 = 34 · 33 · 33", () => expect(equalShares(100, 3)).toEqual([34, 33, 33]));
  test("exact and single splits", () => { expect(equalShares(100, 2)).toEqual([50, 50]); expect(equalShares(7, 1)).toEqual([7]); expect(equalShares(0, 3)).toEqual([0, 0, 0]); });
  test("1 satang among 3 = 1 · 0 · 0", () => expect(equalShares(1, 3)).toEqual([1, 0, 0]));
  test("always Σ = total (a sweep)", () => { for (let t = 0; t < 60; t++) for (let n = 1; n < 9; n++) expect(equalShares(t, n).reduce((a, b) => a + b, 0)).toBe(t); });
  test("refuses a fractional / negative amount and no shares", () => {
    expect(() => equalShares(1.5, 2)).toThrow();
    expect(() => equalShares(-1, 2)).toThrow();
    expect(() => equalShares(5, 0)).toThrow();
  });
});

describe("the STAFF group — «Skate bag», trimmed, case-insensitive, never the Type or a name", () => {
  test("the constant is ขวัญ's word", () => expect(STAFF_COMMISSION_GROUP).toBe("Skate bag"));
  test('« skate BAG » matches; NULL, empty, another group and a near miss do not', () => {
    expect(isStaffGroup(" skate BAG ")).toBe(true);
    expect(isStaffGroup("Skate bag")).toBe(true);
    for (const g of [null, undefined, "", "Skate", "Skate bags", "Skatebag", "Miller"]) expect(isStaffGroup(g)).toBe(false);
  });
});

describe("splitLine", () => {
  const S = (teacherId: string, type: "FT" | "PT" | "FL" | "STAFF" | null) => ({ teacherId, type });
  test("ขวัญ's example: 100 ฿ (10000 satang), an FT and a PT ⇒ the PT keeps 5000, the pool gets 5000", () => {
    expect(splitLine({ amountMinor: 10_000, sellers: [S("ft", "FT"), S("pt", "PT")], groupName: "Miller" })).toEqual({ own: [{ teacherId: "pt", amountMinor: 5000 }], toPool: 5000, skipped: [] });
  });
  test("3 sellers, 100 satang ⇒ 34 · 33 · 33 in the order given, the total kept", () => {
    const r = splitLine({ amountMinor: 100, sellers: [S("a", "PT"), S("b", "FL"), S("c", "PT")], groupName: null });
    expect(r.own).toEqual([{ teacherId: "a", amountMinor: 34 }, { teacherId: "b", amountMinor: 33 }, { teacherId: "c", amountMinor: 33 }]);
  });
  test("the remainder goes to the first sellers even when they are FT (it joins the pool) — total in = total out", () => {
    const r = splitLine({ amountMinor: 100, sellers: [S("ft", "FT"), S("p1", "PT"), S("p2", "PT")], groupName: null });
    expect(r.toPool).toBe(34);
    expect(r.own.map((o) => o.amountMinor)).toEqual([33, 33]);
    expect(r.toPool + r.own.reduce((a, o) => a + o.amountMinor, 0)).toBe(100);
  });
  test("a seller listed twice counts once", () => {
    expect(splitLine({ amountMinor: 100, sellers: [S("a", "PT"), S("a", "PT"), S("b", "PT")], groupName: null }).own.map((o) => o.amountMinor)).toEqual([50, 50]);
  });
  test("STAFF on Skate bag is paid (own); STAFF on any other group, or a NULL group, is skipped NOT_ELIGIBLE_GROUP with the dropped amount", () => {
    expect(splitLine({ amountMinor: 1000, sellers: [S("s", "STAFF")], groupName: "Skate bag" }).own).toEqual([{ teacherId: "s", amountMinor: 1000 }]);
    for (const g of ["Miller", null, "Skate"]) {
      expect(splitLine({ amountMinor: 1000, sellers: [S("s", "STAFF")], groupName: g })).toEqual({ own: [], toPool: 0, skipped: [{ teacherId: "s", reason: "NOT_ELIGIBLE_GROUP", amountMinor: 1000 }] });
    }
  });
  test("FT / PT / FL earn on ANY group (incl. none)", () => {
    for (const type of ["FT", "PT", "FL"] as const) {
      const r = splitLine({ amountMinor: 1000, sellers: [S("x", type)], groupName: "Whatever" });
      expect(r.skipped).toEqual([]);
      expect(r.own.length + (r.toPool ? 1 : 0)).toBe(1);
    }
  });
  test("a seller with no profile is skipped NO_PROFILE; the dropped share is NOT re-split (the default for Q1a)", () => {
    const r = splitLine({ amountMinor: 100, sellers: [S("ghost", null), S("p", "PT")], groupName: null });
    expect(r.skipped).toEqual([{ teacherId: "ghost", reason: "NO_PROFILE", amountMinor: 50 }]);
    expect(r.own).toEqual([{ teacherId: "p", amountMinor: 50 }]);
  });
  test("no sellers ⇒ nothing", () => expect(splitLine({ amountMinor: 100, sellers: [], groupName: null })).toEqual({ own: [], toPool: 0, skipped: [] }));
});

describe("poolSplit", () => {
  test("equal shares, the remainder to the first in the list; Σ kept", () => {
    expect(poolSplit(100, ["a", "b", "c"])).toEqual({ shares: [{ teacherId: "a", amountMinor: 34 }, { teacherId: "b", amountMinor: 33 }, { teacherId: "c", amountMinor: 33 }], unpaid: 0 });
  });
  test("no FT ⇒ nothing is paid and the whole pool is reported unpaid", () => expect(poolSplit(500, [])).toEqual({ shares: [], unpaid: 500 }));
  test("a repeated id counts once", () => expect(poolSplit(100, ["a", "a"]).shares).toEqual([{ teacherId: "a", amountMinor: 100 }]));
});

// ───────────────────────── the apply over memory stores ─────────────────────────
const PERIOD = { id: "per-1", year: 2026, month: 10, periodStart: "2026-09-30", periodEnd: "2026-10-30" };
type Slip = { id: string; teacherId: string; status: "draft" | "confirmed" | "locked" };
const PROFILE = (teacherId: string, employmentType: "FT" | "PT" | "FL" | "STAFF", roles: Array<"FT" | "PT" | "FL" | "STAFF"> = [], active = true) => ({ teacherId, employmentType, roles, baseSatang: null, meritEligible: false, vehicle: null, active });

function setup(o: { slips: Slip[]; profiles: Array<ReturnType<typeof PROFILE>>; sales: SaleLineRow[]; periodStatus?: "open" | "locked"; notify?: (e: NotifyEvent) => Promise<boolean> }) {
  const lines: ExistingCommissionLine[] = [];
  const actors: string[] = [];
  const ranges: Array<{ from: string; to: string }> = [];
  let n = 0;
  const sales: CommissionSaleStore = { listSaleLines: async (r) => { ranges.push(r); return o.sales.map((s) => ({ ...s })); } };
  const slipStatus = (id: string) => o.slips.find((s) => s.id === id)?.status;
  const store: CommissionLineStore = {
    listAutoCommissionLines: async (ids) => lines.filter((l) => ids.includes(l.slipId)).map((l) => ({ ...l })),
    insertOwn: async (l, actor) => {
      if (slipStatus(l.slipId) !== "draft") return null; // the SQL guard
      if (lines.some((x) => x.slipId === l.slipId && x.sourceRef === l.sourceRef)) return null;
      const id = `line-${++n}`;
      lines.push({ id, slipId: l.slipId, sourceRef: l.sourceRef, label: l.label, amountSatang: l.amountSatang });
      actors.push(actor);
      return id;
    },
    upsertPool: async (l, actor) => {
      if (slipStatus(l.slipId) !== "draft") return null;
      const cur = lines.find((x) => x.slipId === l.slipId && x.sourceRef === l.sourceRef);
      if (cur) {
        if (cur.amountSatang === l.amountSatang && cur.label === l.label) return null;
        cur.amountSatang = l.amountSatang; cur.label = l.label;
        return { id: cur.id, inserted: false };
      }
      const id = `line-${++n}`;
      lines.push({ id, slipId: l.slipId, sourceRef: l.sourceRef, label: l.label, amountSatang: l.amountSatang });
      actors.push(actor);
      return { id, inserted: true };
    },
  };
  const events: NotifyEvent[] = [];
  const deps: CommissionDeps = {
    salary: { getPeriod: async () => ({ period: { ...PERIOD, status: o.periodStatus ?? "open" }, slips: o.slips.map((s) => ({ ...s })) }) } as never,
    profiles: { getProfile: async (id: string) => o.profiles.find((p) => p.teacherId === id) } as never,
    sales,
    lines: store,
    notify: o.notify ?? (async (e) => { events.push(e); return true; }),
    names: async (ids) => new Map(ids.map((i) => [i, `Name-${i}`])),
    today: () => "2026-11-09",
  };
  return { deps, lines, actors, ranges, events, run: () => applyCommissionLines("per-1", "ceo1", deps), slips: o.slips };
}
const SALE = (id: string, over: Partial<SaleLineRow> = {}): SaleLineRow => ({ saleLineId: id, soldOn: "2026-10-14", commissionMinor: 10_000, productName: "Helmet", groupName: "Miller", sellerRefs: [], ...over });
const draft = (teacherId: string): Slip => ({ id: `slip-${teacherId}`, teacherId, status: "draft" });

describe("applyCommissionLines — the lines", () => {
  test("ขวัญ's example end to end: an FT and a PT sell a 10000-satang commission ⇒ the PT line 5000 (cm:<line>:<teacher>), the FT's pool line 5000 (cm-pool:<period>:<teacher>)", async () => {
    const m = setup({ slips: [draft("ft1"), draft("pt1")], profiles: [PROFILE("ft1", "FT"), PROFILE("pt1", "PT")], sales: [SALE("sl-1", { sellerRefs: ["ft1", "pt1"] })] });
    const r = await m.run();
    expect(r).toEqual({ written: 2, updatedPool: 0, unchanged: 0, skipped: [], changed: [] });
    const byRef = Object.fromEntries(m.lines.map((l) => [l.sourceRef, l]));
    expect(byRef["cm:sl-1:pt1"]).toMatchObject({ slipId: "slip-pt1", amountSatang: 5000, label: "Commission · Helmet · 14/10/26" });
    expect(byRef["cm-pool:per-1:ft1"]).toMatchObject({ slipId: "slip-ft1", amountSatang: 5000, label: "Commission · Full-time pool · Oct 2026" });
    expect(m.actors).toEqual(["ceo1", "ceo1"]);
  });
  test("the amount is the line's commission AS STORED — whatever else the sale carried (discount, price, qty) is not in the row the service reads", async () => {
    const m = setup({ slips: [draft("pt1")], profiles: [PROFILE("pt1", "PT")], sales: [SALE("sl-1", { commissionMinor: 3000, sellerRefs: ["pt1"] })] });
    await m.run();
    expect(m.lines[0].amountSatang).toBe(3000);
    const S = (await file("./commission-lines.service.ts")).replace(/^\s*\/\/.*$/gm, "");
    const sel = S.slice(S.indexOf("export function dbCommissionSaleStore"), S.indexOf("export function dbCommissionLineStore"));
    for (const word of ["unitPriceMinor", "discountMinor", "qty", "valueMinor"]) expect(sel).not.toContain(word);
  });
  test("3 PT/FL sellers, 100 satang ⇒ 34 / 33 / 33", async () => {
    const m = setup({ slips: [draft("a"), draft("b"), draft("c")], profiles: [PROFILE("a", "PT"), PROFILE("b", "FL"), PROFILE("c", "PT")], sales: [SALE("sl-1", { commissionMinor: 100, sellerRefs: ["a", "b", "c"] })] });
    await m.run();
    expect(m.lines.map((l) => [l.sourceRef, l.amountSatang])).toEqual([["cm:sl-1:a", 34], ["cm:sl-1:b", 33], ["cm:sl-1:c", 33]]);
  });
  test("a share of 0 satang is never written (1 satang among 3 sellers)", async () => {
    const m = setup({ slips: [draft("a"), draft("b"), draft("c")], profiles: [PROFILE("a", "PT"), PROFILE("b", "PT"), PROFILE("c", "PT")], sales: [SALE("sl-1", { commissionMinor: 1, sellerRefs: ["a", "b", "c"] })] });
    await m.run();
    expect(m.lines.map((l) => l.sourceRef)).toEqual(["cm:sl-1:a"]);
  });
  test("STAFF on «Skate bag» (any spelling) is paid; on another group or NULL it is skipped NOT_ELIGIBLE_GROUP and listed", async () => {
    const m = setup({ slips: [draft("st")], profiles: [PROFILE("st", "STAFF")], sales: [SALE("bag", { groupName: " skate BAG ", commissionMinor: 2000, sellerRefs: ["st"] }), SALE("wheel", { groupName: "Miller", sellerRefs: ["st"] }), SALE("none", { groupName: null, sellerRefs: ["st"] })] });
    const r = await m.run();
    expect(m.lines.map((l) => [l.sourceRef, l.amountSatang])).toEqual([["cm:bag:st", 2000]]);
    expect(r.skipped).toEqual([{ saleLineId: "wheel", teacherId: "st", reason: "NOT_ELIGIBLE_GROUP", amountMinor: 10_000 }, { saleLineId: "none", teacherId: "st", reason: "NOT_ELIGIBLE_GROUP", amountMinor: 10_000 }]);
  });
  test("a PT + FL person: a Saturday sale is PT, a Wednesday sale is FL — both are theirs (own lines, never the pool), and a STAFF-by-role-of-day is judged on the sale's day", async () => {
    const both = PROFILE("pf", "FL", ["PT", "FL"]);
    const m = setup({ slips: [draft("pf"), draft("ft1")], profiles: [both, PROFILE("ft1", "FT")], sales: [SALE("sat", { soldOn: "2026-10-17", sellerRefs: ["pf"] }), SALE("wed", { soldOn: "2026-10-14", sellerRefs: ["pf"] })] });
    await m.run();
    expect(m.lines.map((l) => [l.sourceRef, l.amountSatang]).sort()).toEqual([["cm:sat:pf", 10_000], ["cm:wed:pf", 10_000]]);
  });
  test("unknown profile / no seller / no slip / a confirmed slip with no line ⇒ skipped and listed with the right reason", async () => {
    const m = setup({
      slips: [draft("pt1"), { id: "slip-conf", teacherId: "pt2", status: "confirmed" }],
      profiles: [PROFILE("pt1", "PT"), PROFILE("pt2", "PT"), PROFILE("noslip", "PT")],
      sales: [SALE("a", { sellerRefs: ["ghost"] }), SALE("b", { sellerRefs: [] }), SALE("c", { sellerRefs: ["noslip"] }), SALE("d", { sellerRefs: ["pt2"] }), SALE("e", { commissionMinor: 0, sellerRefs: ["pt1"] }), SALE("z", { commissionMinor: 0, sellerRefs: ["ghost"] })],
    });
    const r = await m.run();
    expect(r.written).toBe(0);
    expect(r.skipped.map((s) => [s.saleLineId, s.teacherId, s.reason])).toEqual([["a", "ghost", "NO_PROFILE"], ["b", null, "NO_SELLER"], ["c", "noslip", "NO_SLIP"], ["d", "pt2", "SLIP_NOT_DRAFT"]]);
    expect(m.lines).toEqual([]);
  });
  test("IDEMPOTENT: a second apply writes nothing; an own line whose amount differs is REPORT-ONLY (changed), never rewritten", async () => {
    const m = setup({ slips: [draft("pt1")], profiles: [PROFILE("pt1", "PT")], sales: [SALE("sl-1", { sellerRefs: ["pt1"] })] });
    await m.run();
    expect(await m.run()).toEqual({ written: 0, updatedPool: 0, unchanged: 1, skipped: [], changed: [] });
    m.lines[0].amountSatang = 1; // somebody edited it
    const r = await m.run();
    expect(r.changed).toEqual([{ slipId: "slip-pt1", sourceRef: "cm:sl-1:pt1", was: { label: "Commission · Helmet · 14/10/26", amountSatang: 1 }, now: { label: "Commission · Helmet · 14/10/26", amountSatang: 10_000 } }]);
    expect(m.lines[0].amountSatang).toBe(1);
  });
  test("a RACED insert (the store says «already there») counts as unchanged — nothing written, nobody notified", async () => {
    const m = setup({ slips: [draft("pt1")], profiles: [PROFILE("pt1", "PT")], sales: [SALE("sl-1", { sellerRefs: ["pt1"] })] });
    const raced = { ...m.deps, lines: { ...m.deps.lines, insertOwn: async () => null } };
    const r = await applyCommissionLines("per-1", "ceo1", raced);
    expect(r).toEqual({ written: 0, updatedPool: 0, unchanged: 1, skipped: [], changed: [] });
    expect(m.events).toEqual([]);
  });
  test("the period edges: the sales are read for exactly the R1.4 range (rule 8), nothing else", async () => {
    const m = setup({ slips: [draft("pt1")], profiles: [PROFILE("pt1", "PT")], sales: [] });
    await m.run();
    expect(m.ranges).toEqual([{ from: "2026-09-30", to: "2026-10-30" }]);
  });
  test("a locked period ⇒ 409 LOCKED, and the sales are not even read", async () => {
    const m = setup({ slips: [draft("pt1")], profiles: [PROFILE("pt1", "PT")], sales: [SALE("a", { sellerRefs: ["pt1"] })], periodStatus: "locked" });
    const err = await m.run().catch((e) => e);
    expect(err).toBeInstanceOf(ApiException);
    expect([err.status, err.code]).toEqual([409, "LOCKED"]);
    expect(m.ranges).toEqual([]);
    expect(m.lines).toEqual([]);
  });
});

describe("applyCommissionLines — the FT pool", () => {
  test("2 FT + a mid-period joiner (a third FT slip) ⇒ 3 equal shares of the pool, the remainder to the first by id", async () => {
    const m = setup({
      slips: [draft("ft-a"), draft("ft-b"), draft("ft-new"), draft("pt1")],
      profiles: [PROFILE("ft-a", "FT"), PROFILE("ft-b", "FT"), PROFILE("ft-new", "FT"), PROFILE("pt1", "PT")],
      sales: [SALE("s1", { commissionMinor: 20_000, sellerRefs: ["ft-a"] }), SALE("s2", { commissionMinor: 10_001, sellerRefs: ["ft-b"] })],
    });
    await m.run();
    const pool = m.lines.filter((l) => l.sourceRef.startsWith("cm-pool:")).sort((a, b) => a.sourceRef.localeCompare(b.sourceRef));
    expect(pool.map((l) => [l.sourceRef, l.amountSatang])).toEqual([["cm-pool:per-1:ft-a", 10_001], ["cm-pool:per-1:ft-b", 10_000], ["cm-pool:per-1:ft-new", 10_000]]); // 30001 / 3
    expect(pool.reduce((a, l) => a + l.amountSatang, 0)).toBe(30_001);
  });
  test("the pool grows: a re-apply after a new sale UPDATES the DRAFT pool lines (updatedPool) and writes the new own line", async () => {
    const sales = [SALE("s1", { commissionMinor: 10_000, sellerRefs: ["ft1", "pt1"] })];
    const m = setup({ slips: [draft("ft1"), draft("ft2"), draft("pt1")], profiles: [PROFILE("ft1", "FT"), PROFILE("ft2", "FT"), PROFILE("pt1", "PT")], sales });
    await m.run(); // pool 5000 → 2500 each
    sales.push(SALE("s2", { commissionMinor: 8000, sellerRefs: ["ft1"] }));
    const r = await m.run(); // pool 13000 → 6500 each
    expect(r).toMatchObject({ written: 0, updatedPool: 2, unchanged: 1 });
    expect(m.lines.filter((l) => l.sourceRef.startsWith("cm-pool:")).map((l) => l.amountSatang)).toEqual([6500, 6500]);
    expect(m.events).toHaveLength(3); // only the three lines INSERTED by the first apply (pt1's own + the two pool lines); the UPDATED pool lines notify nobody
  });
  test("a CONFIRMED slip's pool line is left as it is and listed (changed); an FT whose confirmed slip has no pool line yet is skipped SLIP_NOT_DRAFT", async () => {
    const slips: Slip[] = [draft("ft1"), { id: "slip-ft2", teacherId: "ft2", status: "confirmed" }, { id: "slip-ft3", teacherId: "ft3", status: "locked" }];
    const sales = [SALE("s1", { commissionMinor: 9000, sellerRefs: ["ft1"] })];
    const m = setup({ slips, profiles: [PROFILE("ft1", "FT"), PROFILE("ft2", "FT"), PROFILE("ft3", "FT")], sales });
    const r1 = await m.run();
    expect(r1.written).toBe(1); // only ft1's draft slip
    expect(r1.skipped.map((s) => [s.teacherId, s.reason])).toEqual([["ft2", "SLIP_NOT_DRAFT"], ["ft3", "SLIP_NOT_DRAFT"]]);
    // ft2's slip had a pool line before it was confirmed:
    m.lines.push({ id: "old", slipId: "slip-ft2", sourceRef: "cm-pool:per-1:ft2", label: "Commission · Full-time pool · Oct 2026", amountSatang: 100 });
    const r2 = await m.run();
    expect(r2.changed).toEqual([{ slipId: "slip-ft2", sourceRef: "cm-pool:per-1:ft2", was: { label: "Commission · Full-time pool · Oct 2026", amountSatang: 100 }, now: { label: "Commission · Full-time pool · Oct 2026", amountSatang: 3000 } }]);
    expect(m.lines.find((l) => l.id === "old")!.amountSatang).toBe(100); // untouched
  });
  test("no FT in the period ⇒ the pool stays UNPAID and is reported", async () => {
    const m = setup({ slips: [draft("pt1")], profiles: [PROFILE("pt1", "PT"), PROFILE("ftx", "FT")], sales: [SALE("s1", { commissionMinor: 6000, sellerRefs: ["ftx", "pt1"] })] });
    const r = await m.run();
    expect(r.poolUnpaid).toBe(3000);
    expect(m.lines.map((l) => l.sourceRef)).toEqual(["cm:s1:pt1"]);
  });
  test("no pool when nothing goes to it; a zero pool line is never created", async () => {
    const m = setup({ slips: [draft("ft1"), draft("pt1")], profiles: [PROFILE("ft1", "FT"), PROFILE("pt1", "PT")], sales: [SALE("s1", { sellerRefs: ["pt1"] })] });
    const r = await m.run();
    expect(m.lines.map((l) => l.sourceRef)).toEqual(["cm:s1:pt1"]);
    expect(r.poolUnpaid).toBeUndefined();
  });
  test("a PT+FL person is not an FT; a person whose roles include FT is", async () => {
    const m = setup({ slips: [draft("pf"), draft("ft1")], profiles: [PROFILE("pf", "PT", ["PT", "FL"]), PROFILE("ft1", "FT")], sales: [SALE("s1", { commissionMinor: 4000, sellerRefs: ["ft1"] })] });
    await m.run();
    expect(m.lines.map((l) => [l.sourceRef, l.amountSatang])).toEqual([["cm-pool:per-1:ft1", 4000]]);
  });
});

describe("applyCommissionLines — notifications (TASK-920's Commission helper; no money)", () => {
  test("one «Commission» event per NEWLY inserted line (own and pool), keyed by the line; none for unchanged or updated lines", async () => {
    const m = setup({ slips: [draft("ft1"), draft("pt1")], profiles: [PROFILE("ft1", "FT"), PROFILE("pt1", "PT")], sales: [SALE("s1", { sellerRefs: ["ft1", "pt1"] })] });
    await m.run();
    expect(m.events.map((e) => [e.type, e.key])).toEqual([["Commission", "pay-line:line-1"], ["Commission", "pay-line:line-2"]]);
    expect(m.events[0].text).toBe("Commission · Name-pt1 · 14/10/26 · Helmet");
    expect(m.events[1].text).toMatch(/^Commission · Name-ft1 · 09\/11\/26 · Full-time pool$/);
    m.events.length = 0;
    await m.run();
    expect(m.events).toEqual([]);
  });
  test("NO money in any text (no amount, no ฿)", async () => {
    const m = setup({ slips: [draft("ft1"), draft("pt1")], profiles: [PROFILE("ft1", "FT"), PROFILE("pt1", "PT")], sales: [SALE("s1", { commissionMinor: 12_345, sellerRefs: ["ft1", "pt1"] })] });
    await m.run();
    for (const e of m.events) { expect(e.text).not.toMatch(/฿|baht|satang|6172|6173|12345|123\.45/i); }
  });
  test("a notifier that fails is COUNTED (notifyFailed), never thrown, and the lines are still written", async () => {
    const m = setup({ slips: [draft("pt1")], profiles: [PROFILE("pt1", "PT")], sales: [SALE("s1", { sellerRefs: ["pt1"] })], notify: async () => false });
    const r = await m.run();
    expect(r.written).toBe(1);
    expect(r.notifyFailed).toBe(1);
    const t = setup({ slips: [draft("pt1")], profiles: [PROFILE("pt1", "PT")], sales: [SALE("s1", { sellerRefs: ["pt1"] })], notify: async () => { throw new Error("feed down"); } });
    expect((await t.run()).notifyFailed).toBe(1);
  });
});

describe("pins — the route, the store's SQL, the labels", () => {
  test("POST /salary/periods/:id/apply-commission is CEO-only and one line in Jason's router", async () => {
    const R = (await file("../routes/salary.ts")).replace(/^\s*\/\/.*$/gm, "");
    expect(R).toContain('.post("/periods/:id/apply-commission", ceo,');
    expect(R).toContain("applyCommissionLinesFor(service,");
  });
  test("the store writes only into a DRAFT slip (SQL guard), is idempotent on 0011's index, and updates a pool line only when it differs; Team A's insertLine is never used", async () => {
    const S = (await file("./commission-lines.service.ts")).replace(/^\s*\/\/.*$/gm, "");
    expect(S.split("exists (select 1 from bo.pay_slip where id = ${slipId}::uuid and status = 'draft')").length - 1).toBe(1); // the one guard fragment…
    expect(S.split("where ${guard(l.slipId)}").length - 1).toBe(2); // …used by BOTH inserts
    expect(S).toContain("on conflict (slip_id, kind, source_ref) where source = 'auto' do nothing");
    expect(S).toContain("on conflict (slip_id, kind, source_ref) where source = 'auto'\n            do update set amount = excluded.amount, label = excluded.label, updated_at = now()");
    expect(S).toContain("where bo.pay_slip_line.amount is distinct from excluded.amount or bo.pay_slip_line.label is distinct from excluded.label");
    expect(S).not.toContain("insertLine");
    expect(S).toContain("'Asia/Bangkok'"); // the sale's Bangkok date decides its period
  });
  test("refs and labels", () => {
    expect(ownRef("sl", "t")).toBe("cm:sl:t");
    expect(poolRef("p", "t")).toBe("cm-pool:p:t");
    expect(ownLabel("  Helmet ", "2026-10-14")).toBe("Commission · Helmet · 14/10/26");
    expect(ownLabel("", "2026-10-14")).toBe("Commission · product · 14/10/26");
    expect(poolLabel(2026, 12)).toBe("Commission · Full-time pool · Dec 2026");
  });
});
