// TASK-879 - Payment Detail export of ONE slip: Excel = a summary per section (title + Subtotal), PDF = everything incl. every line.
// Reads only the slip DTO from the salary service (`getSlip`); the section grouping is the pure `lib/slip-sections.ts`.
// Libraries: exceljs (XLSX) and pdfkit (PDF), both pure JS and compile-safe; Thai text uses Sarabun (OFL), embedded from `assets/fonts`.
import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";
import regularFontPath from "../../assets/fonts/Sarabun-Regular.ttf" with { type: "file" };
import boldFontPath from "../../assets/fonts/Sarabun-Bold.ttf" with { type: "file" };
import { STATUS_WORD, bahtText, buildSections, exportFilename, formulaSafe, periodLabel, type SlipInput } from "../lib/slip-sections";

export const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
export const PDF_MIME = "application/pdf";

const fonts: { regular?: Uint8Array; bold?: Uint8Array } = {};
async function loadFonts() {
  fonts.regular ??= new Uint8Array(await Bun.file(regularFontPath).arrayBuffer());
  fonts.bold ??= new Uint8Array(await Bun.file(boldFontPath).arrayBuffer());
  return { regular: fonts.regular, bold: fonts.bold };
}

const personName = (s: SlipInput) => s.teacherName ?? s.teacherId; // the id when the name lookup finds none

/** The HTTP response for one export (the route's whole body besides the slip read): right type, an attachment filename, never cached. */
export async function exportSlip(slip: SlipInput, ext: "xlsx" | "pdf"): Promise<Response> {
  const body = ext === "xlsx" ? await slipToXlsx(slip) : await slipToPdf(slip);
  return new Response(body, {
    headers: {
      "Content-Type": ext === "xlsx" ? XLSX_MIME : PDF_MIME,
      "Content-Disposition": `attachment; filename="${exportFilename(slip.period, slip.teacherId, ext)}"`,
      "Cache-Control": "no-store",
    },
  });
}

/** One sheet: header (person, period, status), one row per SECTION (title + subtotal in baht, 2 decimals), then the total. */
export async function slipToXlsx(slip: SlipInput): Promise<Uint8Array> {
  const model = buildSections(slip);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Payment Detail");
  ws.columns = [{ width: 40 }, { width: 18 }];
  const money = '#,##0.00;-#,##0.00';
  ws.addRow(["Payment Detail", formulaSafe(personName(slip))]).font = { bold: true };
  ws.addRow(["Period", formulaSafe(periodLabel(slip.period))]);
  ws.addRow(["Status", formulaSafe(STATUS_WORD[slip.status])]);
  ws.addRow([]);
  const head = ws.addRow(["Section", "Subtotal (฿)"]);
  head.font = { bold: true };
  for (const s of model.sections) {
    const r = ws.addRow([formulaSafe(s.title), s.subtotalSatang / 100]); // satang -> baht: a 2-decimal number from an integer, formatted below
    r.getCell(2).numFmt = money;
  }
  const total = ws.addRow(["Total", model.totalSatang / 100]);
  total.font = { bold: true };
  total.getCell(2).numFmt = money;
  return new Uint8Array(await wb.xlsx.writeBuffer());
}

/** Everything: header, every section with every line (label + amount), the subtotals, the total. Thai labels render (Sarabun embedded). */
export async function slipToPdf(slip: SlipInput): Promise<Uint8Array> {
  const model = buildSections(slip);
  const f = await loadFonts();
  const doc = new PDFDocument({ size: "A4", margin: 40, font: f.regular, info: { Title: `Payment Detail ${personName(slip)}` } });
  const chunks: Uint8Array[] = [];
  doc.on("data", (c: Uint8Array) => chunks.push(c));
  const done = new Promise<void>((res) => doc.on("end", () => res()));
  doc.registerFont("Bold", f.bold);
  const L = 40;
  const W = doc.page.width - 80;
  const AMT = 110;
  const ensure = (h: number) => {
    if (doc.y + h > doc.page.height - 50) doc.addPage();
  };
  const row = (left: string, right: string, bold = false, size = 11) => {
    doc.font(bold ? "Bold" : "Regular").fontSize(size);
    // the amount column fits its own text (a bold 13 pt "Subtotal 20,800.00 ฿" is wider than the fixed 110 pt and used to wrap onto two lines)
    const rw = Math.max(AMT, Math.ceil(doc.widthOfString(right)) + 6);
    const h = Math.max(doc.heightOfString(left, { width: W - rw - 10 }), doc.heightOfString(right, { width: rw }));
    ensure(h + 2);
    const y = doc.y;
    doc.text(left, L, y, { width: W - rw - 10 });
    doc.text(right, L + W - rw, y, { width: rw, align: "right", lineBreak: false });
    doc.y = y + h + 2;
  };
  doc.registerFont("Regular", f.regular);

  doc.font("Bold").fontSize(18).text(personName(slip), L, 40, { width: W });
  doc.font("Regular").fontSize(11).text(`Period ${periodLabel(slip.period)}   ·   ${STATUS_WORD[slip.status]}`, L, doc.y + 2, { width: W });
  doc.moveDown(0.8);
  for (const s of model.sections) {
    ensure(40);
    row(s.title, `Subtotal ${bahtText(s.subtotalSatang)} ฿`, true, 13);
    for (const r of s.rows) row(r.text, `${bahtText(r.amountSatang)} ฿`);
    doc.moveDown(0.6);
  }
  ensure(30);
  row(`Total (${periodLabel(slip.period)})`, `${bahtText(model.totalSatang)} ฿`, true, 14);
  doc.end();
  await done;
  return new Uint8Array(Buffer.concat(chunks));
}
