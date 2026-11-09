// TASK-879 - the Payment Detail section model (PURE: no database, no I/O). Groups a slip's lines into the sections of the final UI
// (`final-ui/src/pages/a/salary/SlipView.tsx` + `mock/a-salary.ts`), IN ITS ORDER and WITH ITS NAMES. Money is integer SATANG throughout.

/** The slice of `service.getSlip(id)` this needs. */
export interface SlipInput {
  teacherId: string;
  teacherName: string | null;
  baseAmount: number;
  status: "draft" | "confirmed" | "locked";
  period: { year: number; month: number; periodStart: string | null; periodEnd: string | null };
  lines: { id: string; kind: string; label: string; amount: number; /** 🔻 TASK-903: set on fl_pay lines (one per date x class) */ classType?: string | null }[];
  total: number;
}

export interface SectionRow { text: string; amountSatang: number }
export interface Section { title: string; rows: SectionRow[]; subtotalSatang: number }
export interface SlipModel {
  sections: Section[];
  totalSatang: number;
  unknownKinds: string[];
  /** Σ of the Freelance Teaching Pay sections (all classes), or null when the slip has none. INFORMATION: it is already inside `totalSatang` via its class rows - never add it again. */
  flTotalSatang: number | null;
}

/** The final UI's section order and names. A kind with no entry here goes under OTHER_TITLE, never dropped. */
export const SECTION_OF_KIND: Record<string, string> = {
  fl_pay: "Freelance Teaching Pay",
  extra_hour: "Extra Hour",
  ot: "OT",
  commission: "Commission",
  bonus: "Bonus",
  transport: "Transportation",
  merit: "Merit",
  other: "Other ±",
};
export const BASE_TITLE = "Base Salary";
export const OTHER_TITLE = "Other ±";
/** 🔻 TASK-903 - the final UI splits Freelance Teaching Pay by class type: "Freelance Teaching Pay · Private" / "· Group" ... in this order. */
export const FL_TITLE = "Freelance Teaching Pay";
export const FL_CLASS_ORDER: readonly string[] = ["private", "duo", "group", "eca", "camp"];
const CLASS_NAME: Record<string, string> = { private: "Private", duo: "Duo", group: "Group", eca: "ECA", camp: "Camp" };
export const flTitleOf = (classType: string | null | undefined): string => (classType && CLASS_NAME[classType] ? `${FL_TITLE} · ${CLASS_NAME[classType]}` : FL_TITLE);
export const SECTION_ORDER: readonly string[] = [BASE_TITLE, FL_TITLE, ...FL_CLASS_ORDER.map((c) => flTitleOf(c)), "Extra Hour", "OT", "Commission", "Bonus", "Transportation", "Merit", OTHER_TITLE];
/** The base row's text in the final UI. */
export const BASE_ROW_TEXT = "Set by the CEO";

/** The final UI's status words for the slip states we have. */
export const STATUS_WORD: Record<SlipInput["status"], string> = { draft: "Pending", confirmed: "Confirmed", locked: "AUTO-LOCKED" };

export function buildSections(slip: SlipInput): SlipModel {
  const byTitle = new Map<string, SectionRow[]>();
  const unknown = new Set<string>();
  byTitle.set(BASE_TITLE, [{ text: BASE_ROW_TEXT, amountSatang: slip.baseAmount }]);
  for (const l of slip.lines) {
    let title = l.kind === "base" ? BASE_TITLE : l.kind === "fl_pay" ? flTitleOf(l.classType) : SECTION_OF_KIND[l.kind];
    if (title === undefined) {
      unknown.add(l.kind);
      title = OTHER_TITLE;
    }
    const rows = byTitle.get(title) ?? [];
    rows.push({ text: l.label, amountSatang: l.amount });
    byTitle.set(title, rows);
  }
  const sections: Section[] = SECTION_ORDER.filter((t) => byTitle.has(t)).map((title) => {
    const rows = byTitle.get(title)!;
    return { title, rows, subtotalSatang: rows.reduce((s, r) => s + r.amountSatang, 0) };
  });
  const fl = sections.filter((s) => s.title === FL_TITLE || s.title.startsWith(`${FL_TITLE} · `));
  return {
    sections,
    totalSatang: sections.reduce((s, x) => s + x.subtotalSatang, 0),
    unknownKinds: [...unknown].sort(),
    flTotalSatang: fl.length ? fl.reduce((s, x) => s + x.subtotalSatang, 0) : null,
  };
}

/**
 * 🔒 Spreadsheet formula-injection guard (OWASP "CSV injection"). A text cell that BEGINS with = + - @ (or a tab / carriage return) can be run as a formula when a spreadsheet opens
 * the file; the names and labels come from people (an admin's Entries reason, a teacher's name). A leading apostrophe makes Excel / Sheets treat the cell as plain text.
 * Money cells are real numbers and never go through this.
 */
export const formulaSafe = (text: string): string => (/^[=+\-@\t\r]/.test(text) ? `'${text}` : text);

/** 1234567 -> "12,345.67" ; -20000 -> "-200.00". Integer math only (no float). */
export function bahtText(satang: number): string {
  if (!Number.isSafeInteger(satang)) throw new Error(`not an integer satang: ${satang}`);
  const abs = Math.abs(satang);
  const whole = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${satang < 0 ? "-" : ""}${whole}.${String(abs % 100).padStart(2, "0")}`;
}

/** "2026-09-30" -> "30/09/26" (the final UI's DD/MM/YY). */
const ddmmyy = (d: string): string => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(2, 4)}`;
export const periodLabel = (p: SlipInput["period"]): string => (p.periodStart && p.periodEnd ? `${ddmmyy(p.periodStart)}–${ddmmyy(p.periodEnd)}` : `${p.year}-${String(p.month).padStart(2, "0")}`);

/** `slip-<YYYY-MM>-<teacherId8>.<ext>` */
export const exportFilename = (p: SlipInput["period"], teacherId: string, ext: "xlsx" | "pdf"): string =>
  `slip-${p.year}-${String(p.month).padStart(2, "0")}-${teacherId.replace(/-/g, "").slice(0, 8)}.${ext}`;
