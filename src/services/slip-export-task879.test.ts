// TASK-879 - Payment Detail export: the section model, the XLSX (parsed back) and the PDF (Thai text extracted back), plus the routes.
// DB-less: the in-memory salary store. Names in the fixtures are invented.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { inflateSync } from "node:zlib";
import ExcelJS from "exceljs";
import { Hono } from "hono";
import { ApiException } from "../lib/http";
import { signToken, type Role } from "../lib/jwt";
import { makeSalaryRoutes } from "../routes/salary";
import { BASE_ROW_TEXT, OTHER_TITLE, SECTION_ORDER, bahtText, buildSections, exportFilename, formulaSafe, periodLabel, type SlipInput } from "../lib/slip-sections";
import { createSalaryService } from "./salary.service";
import { memorySalaryStore } from "./salary-memory.store";
import { slipToPdf, slipToXlsx } from "./slip-export.service";

const TID = "11111111-1111-4111-8111-111111111111";
const slip = (over: Partial<SlipInput> = {}): SlipInput => ({
  teacherId: TID,
  teacherName: "Pete",
  baseAmount: 2_080_000,
  status: "locked",
  period: { year: 2026, month: 10, periodStart: "2026-09-30", periodEnd: "2026-10-30" },
  lines: [
    { id: "l1", kind: "other", label: "Reason: ทำอุปกรณ์เสีย · entered by Ploy", amount: -20_000 },
    { id: "l2", kind: "bonus", label: "For 50 : น้องมะลิ (Private) = 1", amount: 5_000 },
    { id: "l3", kind: "extra_hour", label: "14/10 (Wed): 6 Hr → extra 2 Hr × 350", amount: 70_000 },
    { id: "l4", kind: "merit", label: "Merit", amount: 100_000 },
    { id: "l5", kind: "mystery", label: "unknown kind row", amount: 1_234_567 },
    { id: "l6", kind: "bonus", label: "For 100 : น้องข้าวหอม = 3", amount: 30_000 },
    { id: "l7", kind: "transport", label: "STA · 12 km", amount: 14_400 },
  ],
  total: 2_080_000 - 20_000 + 5_000 + 70_000 + 100_000 + 1_234_567 + 30_000 + 14_400,
  ...over,
});

describe("section model (pure)", () => {
  test("the final UI's order and names; empty sections omitted; base is its own row", () => {
    const m = buildSections(slip());
    expect(m.sections.map((s) => s.title)).toEqual(["Base Salary", "Extra Hour", "Bonus", "Transportation", "Merit", "Other ±"]);
    expect(m.sections[0]).toEqual({ title: "Base Salary", rows: [{ text: BASE_ROW_TEXT, amountSatang: 2_080_000 }], subtotalSatang: 2_080_000 });
    expect(SECTION_ORDER).toEqual(["Base Salary", "Freelance Teaching Pay", "Freelance Teaching Pay · Private", "Freelance Teaching Pay · Duo", "Freelance Teaching Pay · Group", "Freelance Teaching Pay · ECA", "Freelance Teaching Pay · Camp", "Extra Hour", "OT", "Commission", "Bonus", "Transportation", "Merit", "Other ±"]);
  });
  test("subtotals; sum of subtotals = slip.total; a negative Other± line subtracts", () => {
    const s = slip();
    const m = buildSections(s);
    expect(m.sections.find((x) => x.title === "Bonus")!.subtotalSatang).toBe(35_000);
    const other = m.sections.find((x) => x.title === OTHER_TITLE)!;
    expect(other.subtotalSatang).toBe(-20_000 + 1_234_567); // the unknown kind landed here too
    expect(m.totalSatang).toBe(s.total);
  });
  test("an unknown kind goes under Other ± (never dropped) and is reported", () => {
    const m = buildSections(slip());
    expect(m.unknownKinds).toEqual(["mystery"]);
    expect(m.sections.find((x) => x.title === OTHER_TITLE)!.rows.map((r) => r.text)).toContain("unknown kind row");
  });
  test("a FL person: Freelance Teaching Pay sits right after Base Salary; PT base line kind 'base' joins the base row", () => {
    const m = buildSections(slip({ lines: [{ id: "a", kind: "extra_hour", label: "x", amount: 1 }, { id: "b", kind: "fl_pay", label: "y", amount: 2 }] }));
    expect(m.sections.map((s) => s.title)).toEqual(["Base Salary", "Freelance Teaching Pay", "Extra Hour"]);
  });
  test("satang -> baht text: integer math, thousands, 2 decimals, sign", () => {
    expect(bahtText(1_234_567)).toBe("12,345.67");
    expect(bahtText(0)).toBe("0.00");
    expect(bahtText(5)).toBe("0.05");
    expect(bahtText(-20_000)).toBe("-200.00");
    expect(bahtText(100_000_000_00)).toBe("100,000,000.00");
    expect(() => bahtText(1.5)).toThrow();
  });
  test("period label (DD/MM/YY as the final UI) and the filename slip-YYYY-MM-teacherId8", () => {
    expect(periodLabel(slip().period)).toBe("30/09/26–30/10/26");
    expect(exportFilename(slip().period, TID, "xlsx")).toBe("slip-2026-10-11111111.xlsx");
    expect(exportFilename(slip().period, TID, "pdf")).toBe("slip-2026-10-11111111.pdf");
  });
});

describe("XLSX", () => {
  test("parsed back: header, one row per SECTION with its subtotal (2 decimals), then the total", async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await slipToXlsx(slip())).buffer as ArrayBuffer);
    const ws = wb.worksheets[0]!;
    const rows = ws.getRows(1, ws.rowCount)!.map((r) => [r.getCell(1).text, r.getCell(2).value ?? ""]);
    expect(rows).toEqual([
      ["Payment Detail", "Pete"],
      ["Period", "30/09/26–30/10/26"],
      ["Status", "AUTO-LOCKED"],
      ["", ""],
      ["Section", "Subtotal (฿)"],
      ["Base Salary", 20_800],
      ["Extra Hour", 700],
      ["Bonus", 350],
      ["Transportation", 144],
      ["Merit", 1_000],
      ["Other ±", 12_145.67],
      ["Total", 35_139.67],
    ]);
    // shown with 2 decimals and thousands (Excel number format), and still real numbers
    for (const r of [6, 7, 8, 9, 10, 11, 12]) expect(ws.getCell(`B${r}`).numFmt).toBe("#,##0.00;-#,##0.00");
  });
  test("no float drift: 1,234,567 satang reads 12,345.67", async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await slipToXlsx(slip({ baseAmount: 1_234_567, lines: [], total: 1_234_567 }))).buffer as ArrayBuffer);
    const cell = wb.worksheets[0]!.getCell("B6");
    expect(cell.value).toBe(12_345.67);
    expect(cell.numFmt).toBe("#,##0.00;-#,##0.00");
    expect(bahtText(1_234_567)).toBe("12,345.67");
  });
  test("falls back to the teacher id when there is no name", async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await slipToXlsx(slip({ teacherName: null }))).buffer as ArrayBuffer);
    expect(wb.worksheets[0]!.getCell("B1").text).toBe(TID);
  });
});

// ---- a minimal PDF text extractor: Flate streams, per-font ToUnicode CMaps, Tj / TJ hex strings ----
function pdfObjects(pdf: Buffer): Map<number, { dict: string; stream: Buffer | null }> {
  const s = pdf.toString("latin1");
  const out = new Map<number, { dict: string; stream: Buffer | null }>();
  const re = /(\d+) 0 obj\s*([\s\S]*?)endobj/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const body = m[2]!;
    const si = body.indexOf("stream");
    if (si < 0) out.set(Number(m[1]), { dict: body, stream: null });
    else {
      const start = m.index + m[0].indexOf(body) + si + "stream".length;
      const dict = body.slice(0, si);
      const len = Number(/\/Length (\d+)/.exec(dict)?.[1] ?? 0);
      let from = start;
      if (s[from] === "\r") from++;
      if (s[from] === "\n") from++;
      let raw = pdf.subarray(from, from + len);
      if (/\/FlateDecode/.test(dict)) raw = inflateSync(raw);
      out.set(Number(m[1]), { dict, stream: Buffer.from(raw) });
    }
  }
  return out;
}
function cmapOf(text: string): Map<number, string> {
  const map = new Map<number, string>();
  const u = (h: string) => Buffer.from(h, "hex").swap16().toString("utf16le");
  for (const blk of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) for (const p of blk[1]!.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) map.set(parseInt(p[1]!, 16), u(p[2]!));
  for (const blk of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const p of blk[1]!.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*\[([^\]]*)\]/g)) {
      const items = [...p[3]!.matchAll(/<([0-9a-fA-F]+)>/g)].map((x) => x[1]!);
      items.forEach((h, k) => map.set(parseInt(p[1]!, 16) + k, u(h)));
    }
    const rest = blk[1]!.replace(/<[0-9a-fA-F]+>\s*<[0-9a-fA-F]+>\s*\[[^\]]*\]/g, "");
    for (const p of rest.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
      const a = parseInt(p[1]!, 16);
      const b = parseInt(p[2]!, 16);
      const base = Buffer.from(p[3]!, "hex");
      for (let c = a; c <= b; c++) {
        const t = Buffer.from(base);
        t.writeUInt16BE(t.readUInt16BE(t.length - 2) + (c - a), t.length - 2);
        map.set(c, t.swap16().toString("utf16le"));
      }
    }
  }
  return map;
}
function pdfRaw(bytes: Uint8Array): string {
  const objs = pdfObjects(Buffer.from(bytes));
  const fontCmap = new Map<number, Map<number, string>>(); // font object -> cmap
  for (const [n, o] of objs) {
    const tu = /\/ToUnicode (\d+) 0 R/.exec(o.dict);
    if (/\/Type0/.test(o.dict) && tu) fontCmap.set(n, cmapOf(objs.get(Number(tu[1]))!.stream!.toString("latin1")));
  }
  const nameToObj = new Map<string, number>();
  for (const o of objs.values()) for (const f of o.dict.matchAll(/\/(F\d+) (\d+) 0 R/g)) nameToObj.set(f[1]!, Number(f[2]));
  let text = "";
  for (const o of objs.values()) {
    if (!o.stream || !/ Tf/.test(o.stream.toString("latin1")) || /\/Type \/XObject|\/FontFile/.test(o.dict)) continue;
    let cur: Map<number, string> | undefined;
    for (const tok of o.stream.toString("latin1").matchAll(/\/(F\d+) [\d.]+ Tf|\[([^\]]*)\]\s*TJ|<([0-9a-fA-F]+)>\s*Tj/g)) {
      if (tok[1]) cur = fontCmap.get(nameToObj.get(tok[1])!);
      else {
        const hex = (tok[2] ? [...tok[2].matchAll(/<([0-9a-fA-F]+)>/g)].map((x) => x[1]).join("") : tok[3])!;
        for (let i = 0; i + 4 <= hex.length; i += 4) text += cur?.get(parseInt(hex.slice(i, i + 4), 16)) ?? "?";
        text += "\n";
      }
    }
  }
  return text;
}
function pdfText(bytes: Uint8Array): string {
  // whitespace-free, NFKC. pdfkit shapes sara am (U+0E33) into nikhahit + sara aa and its ToUnicode lists the aa twice, so the extractor sees U+0E4D U+0E32 U+0E32: collapse it
  return pdfRaw(bytes).replace(/\s+/g, "").normalize("NFKC").replace(/\u0e4d\u0e32\u0e32/g, "\u0e4d\u0e32");
}
const n = (t: string) => t.replace(/\s+/g, "").normalize("NFKC");

describe("PDF", () => {
  test("is a PDF with Sarabun embedded (a Thai-capable OFL font, not a standard font)", async () => {
    const pdf = await slipToPdf(slip());
    const raw = Buffer.from(pdf).toString("latin1");
    expect(raw.startsWith("%PDF-")).toBe(true);
    expect(raw).toMatch(/\/BaseFont \/[A-Z]{6}\+Sarabun/);
    expect(raw).toContain("/FontFile2");
    expect(raw).not.toContain("/Helvetica");
  });
  test("a Thai label round-trips as TEXT, and so does every line label, subtotal and the total", async () => {
    const s = slip();
    const text = pdfText(await slipToPdf(s));
    for (const needle of ["ทำอุปกรณ์เสีย", "น้องมะลิ", "น้องข้าวหอม", "Pete", "AUTO-LOCKED"]) expect(text).toContain(n(needle));
    for (const l of s.lines) expect(text).toContain(n(l.label));
    for (const sec of buildSections(s).sections) expect(text).toContain(n(sec.title));
    expect(text).toContain("35,139.67");
    expect(text).toContain("12,145.67");
    expect(text).toContain("-200.00");
  });
  test("many lines paginate without losing a label", async () => {
    const lines = Array.from({ length: 120 }, (_, i) => ({ id: `n${i}`, kind: "other", label: `row-${i}-ไทย`, amount: 100 }));
    const text = pdfText(await slipToPdf(slip({ lines, total: 2_080_000 + 12_000 })));
    for (const i of [0, 59, 119]) expect(text).toContain(n(`row-${i}-ไทย`));
  });
});

describe("routes (CEO only)", () => {
  const KEYS = ["JWT_SECRET", "SKIP_ADMIN_AUTH"];
  const saved: Record<string, string | undefined> = {};
  beforeAll(() => {
    for (const k of KEYS) saved[k] = process.env[k];
    process.env.JWT_SECRET = "test-secret-879";
    process.env.SKIP_ADMIN_AUTH = "false";
  });
  afterAll(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
  async function setup() {
    const store = memorySalaryStore();
    store.names.set(TID, "ต้น");
    const svc = createSalaryService(store, () => new Date("2026-10-10T03:00:00Z"), { readHours: async () => [] });
    await svc.setProfile(TID, { employmentType: "FT", baseSalary: 2_080_000, active: true });
    const period = await svc.createPeriod(2026, 10);
    await svc.runPeriod(period.id);
    const slipId = [...store.slips.values()][0]!.id;
    await svc.addLine(slipId, { amount: -20_000, label: "ทำอุปกรณ์เสีย" }, "ceo");
    const app = new Hono();
    app.onError((err, c) => (err instanceof ApiException ? c.json({ error: { code: err.code, message: err.message } }, err.status as 400) : c.json({ error: { code: "INTERNAL", message: String(err) } }, 500)));
    app.route("/salary", makeSalaryRoutes(svc));
    return { app, slipId };
  }
  const get = async (app: Hono, path: string, role: Role | null) => app.request(`/salary${path}`, { headers: role ? { Authorization: `Bearer ${await signToken({ sub: `u-${role}`, role })}` } : {} });

  test("401 with no token; 403 for an admin or a coach; on both formats", async () => {
    const { app, slipId } = await setup();
    for (const ext of ["xlsx", "pdf"]) {
      expect((await get(app, `/slips/${slipId}/export.${ext}`, null)).status).toBe(401);
      expect((await get(app, `/slips/${slipId}/export.${ext}`, "admin")).status).toBe(403);
      expect((await get(app, `/slips/${slipId}/export.${ext}`, "coach")).status).toBe(403);
    }
  });
  test("404 for an unknown slip and for a malformed id", async () => {
    const { app } = await setup();
    for (const ext of ["xlsx", "pdf"]) {
      expect((await get(app, `/slips/99999999-9999-4999-8999-999999999999/export.${ext}`, "ceo")).status).toBe(404);
      expect((await get(app, `/slips/not-a-uuid/export.${ext}`, "ceo")).status).toBe(404);
    }
  });
  test("200 for the CEO with the right Content-Type and Content-Disposition; the body parses", async () => {
    const { app, slipId } = await setup();
    const x = await get(app, `/slips/${slipId}/export.xlsx`, "ceo");
    expect(x.status).toBe(200);
    expect(x.headers.get("content-type")).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(x.headers.get("content-disposition")).toMatch(/^attachment; filename="slip-2026-10-[0-9a-f]{8}\.xlsx"$/);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await x.arrayBuffer());
    expect(wb.worksheets[0]!.getCell("B1").text).toBe("ต้น");
    const p = await get(app, `/slips/${slipId}/export.pdf`, "ceo");
    expect(p.status).toBe(200);
    expect(p.headers.get("content-type")).toBe("application/pdf");
    expect(p.headers.get("content-disposition")).toMatch(/\.pdf"$/);
    const text = pdfText(new Uint8Array(await p.arrayBuffer()));
    expect(text).toContain(n("ทำอุปกรณ์เสีย"));
    expect(text).toContain("20,600.00");
  });
});

describe("🔒 formula-injection guard (Silver's condition on TASK-879)", () => {
  test("formulaSafe: a leading = + - @ tab or CR gets an apostrophe; ordinary text and Thai are untouched", () => {
    for (const bad of ["=1+1", "+cmd|' /C calc'!A0", "-2+3", "@SUM(1)", "\tx", "\rx", '=HYPERLINK("http://evil","click")']) expect(formulaSafe(bad)).toBe(`'${bad}`);
    for (const ok of ["Pete", "ต้น", "Ploy, Jr", "a=b", "x-1", "", " =spaced"]) expect(formulaSafe(ok)).toBe(ok);
  });
  test("XLSX: a name that looks like a formula is written as TEXT with the guard, never as a formula cell", async () => {
    for (const evil of ["=1+1", "@SUM(A1)", "+cmd", "-1+2"]) {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load((await slipToXlsx(slip({ teacherName: evil }))).buffer as ArrayBuffer);
      const cell = wb.worksheets[0]!.getCell("B1");
      expect(cell.type).toBe(ExcelJS.ValueType.String);
      expect(cell.value).toBe(`'${evil}`);
      expect(typeof cell.formula).toBe("undefined");
    }
  });
  test("XLSX: money cells stay real numbers (negative subtotal is a number, not guarded text)", async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await slipToXlsx(slip({ baseAmount: -500, lines: [], total: -500 }))).buffer as ArrayBuffer);
    expect(wb.worksheets[0]!.getCell("B6").value).toBe(-5);
    expect(wb.worksheets[0]!.getCell("B6").type).toBe(ExcelJS.ValueType.Number);
  });
  test("the PDF keeps an admin's label as typed (it is not a spreadsheet, so no apostrophe)", async () => {
    const text = pdfText(await slipToPdf(slip({ lines: [{ id: "x", kind: "other", label: "=1+1 reason", amount: 100 }], total: 2_080_100 })));
    expect(text).toContain(n("=1+1 reason"));
    expect(text).not.toContain(n("'=1+1"));
  });
  test("the salary CSV export guards the teacher-name column too", async () => {
    const store = memorySalaryStore();
    store.names.set(TID, "=cmd|' /C calc'!A0");
    const svc = createSalaryService(store, () => new Date("2026-10-10T03:00:00Z"), { readHours: async () => [] });
    await svc.setProfile(TID, { employmentType: "FT", baseSalary: 100, active: true });
    const p = await svc.createPeriod(2026, 10);
    await svc.runPeriod(p.id);
    const row = (await svc.exportCsv(p.id)).body.trim().split("\r\n")[1]!;
    expect(row).toContain(`'=cmd|' /C calc'!A0`);
    expect(row.split(",")[1]!.startsWith("'=")).toBe(true);
  });
});

describe("PDF layout: a section subtotal stays on ONE line (Silver's fix)", () => {
  test("subtotals of 1,000 and up - up to 1,234,567.89 - are each a single text line, and so are the line amounts and the total", async () => {
    const s = slip({ baseAmount: 2_080_000, lines: [{ id: "a", kind: "bonus", label: "For 50", amount: 100_000 }, { id: "b", kind: "merit", label: "Merit", amount: 123_456_789 }, { id: "c", kind: "other", label: "-ok", amount: -2_100_000 }], total: 2_080_000 + 100_000 + 123_456_789 - 2_100_000 });
    const lines = pdfRaw(await slipToPdf(s)).split("\n").map((l) => l.trim());
    const model = buildSections(s);
    for (const sec of model.sections) expect(lines).toContain(`Subtotal ${bahtText(sec.subtotalSatang)} ฿`);
    for (const sec of model.sections) for (const r of sec.rows) expect(lines).toContain(`${bahtText(r.amountSatang)} ฿`);
    expect(lines.some((l) => l.endsWith(`${bahtText(model.totalSatang)} ฿`))).toBe(true);
    // never a bare "฿" on its own line, nor "Subtotal" without its amount
    expect(lines).not.toContain("฿");
    expect(lines).not.toContain("Subtotal");
  });
});

describe("TASK-903 follow-on: Freelance Teaching Pay is split per class type in the export", () => {
  const flLines = [
    { id: "f1", kind: "fl_pay", classType: "group", label: "14/10 (Wed): group 1 Hr × 250", amount: 25_000 },
    { id: "f2", kind: "fl_pay", classType: "private", label: "14/10 (Wed): private 2 Hr × 400", amount: 80_000 },
    { id: "f3", kind: "fl_pay", classType: "private", label: "15/10 (Thu): private 5 Hr × 400", amount: 200_000 },
    { id: "f4", kind: "extra_hour", classType: null, label: "17/10 (Sat): 6 Hr → extra 1 Hr × 350", amount: 35_000 },
  ];
  const fl = (over: Partial<SlipInput> = {}) => slip({ baseAmount: 1_000_000, lines: flLines, total: 1_000_000 + 340_000, ...over });

  test("model: one sub-section per class in Private, Duo, Group, ECA, Camp order; subtotals per class; the FL total; grand total unchanged", () => {
    const m = buildSections(fl());
    expect(m.sections.map((s) => s.title)).toEqual(["Base Salary", "Freelance Teaching Pay · Private", "Freelance Teaching Pay · Group", "Extra Hour"]);
    expect(m.sections.map((s) => s.subtotalSatang)).toEqual([1_000_000, 280_000, 25_000, 35_000]);
    expect(m.flTotalSatang).toBe(305_000);
    expect(m.totalSatang).toBe(1_340_000); // the class rows are what the total adds; the FL total is a memo
    expect(buildSections(slip()).flTotalSatang).toBeNull();
  });
  test("an old fl_pay line with no classType (a frozen pre-0014 slip) stays under plain 'Freelance Teaching Pay', first", () => {
    const m = buildSections(fl({ lines: [{ id: "o", kind: "fl_pay", classType: null, label: "old", amount: 105_000 }, ...flLines.slice(1)], total: 0 }));
    expect(m.sections.map((s) => s.title).slice(0, 3)).toEqual(["Base Salary", "Freelance Teaching Pay", "Freelance Teaching Pay · Private"]);
    expect(m.flTotalSatang).toBe(105_000 + 280_000);
  });
  test("XLSX: one row per class (no 'all classes' memo row); the Total counts them once", async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await slipToXlsx(fl())).buffer as ArrayBuffer);
    const ws = wb.worksheets[0]!;
    const rows = ws.getRows(6, ws.rowCount - 5)!.map((r) => [r.getCell(1).text, r.getCell(2).value]);
    expect(rows).toEqual([
      ["Base Salary", 10_000],
      ["Freelance Teaching Pay · Private", 2_800],
      ["Freelance Teaching Pay · Group", 250],
      ["Extra Hour", 350],
      ["Total", 13_400],
    ]);
    expect(2_800 + 250).toBe(3_050); // the two class rows are the Freelance pay; the Total adds them once
  });
  test("a slip with ONE class: just its class row", async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await slipToXlsx(fl({ lines: flLines.slice(1, 3), total: 0 }))).buffer as ArrayBuffer);
    const titles = wb.worksheets[0]!.getRows(6, wb.worksheets[0]!.rowCount - 5)!.map((r) => r.getCell(1).text);
    expect(titles).toEqual(["Base Salary", "Freelance Teaching Pay · Private", "Total"]);
  });
  test("PDF: each class sub-section with its lines and subtotal, no 'all classes' line, one text line each", async () => {
    const lines = pdfRaw(await slipToPdf(fl())).split("\n").map((l) => l.trim());
    for (const t of ["Freelance Teaching Pay · Private", "Freelance Teaching Pay · Group"]) expect(lines).toContain(t);
    expect(lines.some((l) => l.includes("all classes"))).toBe(false);
    for (const a of ["Subtotal 2,800.00 ฿", "Subtotal 250.00 ฿", "Subtotal 350.00 ฿"]) expect(lines).toContain(a);
    expect(lines).not.toContain("Subtotal 3,050.00 ฿");
    expect(lines).toContain("14/10 (Wed): private 2 Hr × 400");
    expect(lines.some((l) => l.endsWith("13,400.00 ฿"))).toBe(true);
  });
});
