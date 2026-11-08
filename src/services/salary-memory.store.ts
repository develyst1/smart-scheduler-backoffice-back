// In-memory SalaryStore: the test double that lets the whole pay-run round trip run with no database (TASK-865 evidence).
import { CLASS_TYPES, type Line, type Period, type Profile, type SalaryStore, type Slip } from "./salary.service";

let seq = 0;
const id = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

export function memorySalaryStore(): SalaryStore & { profiles: Map<string, Profile>; slips: Map<string, Slip>; lines: Map<string, Line>; names: Map<string, string> } {
  const names = new Map<string, string>();
  const flRates = new Map<string, number>();
  const periods = new Map<string, Period>();
  const profiles = new Map<string, Profile>();
  const slips = new Map<string, Slip>();
  const lines = new Map<string, Line>();
  return {
    names,
    profiles,
    slips,
    lines,
    async listPeriods() {
      return [...periods.values()].sort((a, b) => b.year - a.year || b.month - a.month);
    },
    async getPeriod(i) {
      return periods.get(i);
    },
    async getPeriodByYearMonth(year, month) {
      return [...periods.values()].find((p) => p.year === year && p.month === month);
    },
    async insertPeriod(p) {
      const row: Period = { id: id(), year: p.year, month: p.month, periodStart: p.periodStart, periodEnd: p.periodEnd, status: "open", lockAt: p.lockAt, lockedAt: null };
      periods.set(row.id, row);
      return row;
    },
    async lockPeriod(i, at) {
      const p = periods.get(i)!;
      if (p.status === "open") {
        p.status = "locked";
        p.lockedAt = at;
      }
      for (const s of slips.values()) if (s.periodId === i) s.status = "locked";
      return p;
    },
    async listProfiles() {
      return [...profiles.values()];
    },
    async getProfile(teacherId) {
      return profiles.get(teacherId);
    },
    async upsertProfile(p) {
      profiles.set(p.teacherId, p);
      return p;
    },
    async listFlRates(teacherId) {
      return CLASS_TYPES.filter((c) => flRates.has(`${teacherId}:${c}`)).map((c) => ({ classType: c, rateSatang: flRates.get(`${teacherId}:${c}`)! }));
    },
    async upsertFlRate(teacherId, classType, rateSatang) {
      if (!profiles.has(teacherId)) return undefined;
      flRates.set(`${teacherId}:${classType}`, rateSatang);
      return { classType, rateSatang };
    },
    async listSlips(periodId) {
      return [...slips.values()].filter((s) => s.periodId === periodId);
    },
    async getSlip(i) {
      return slips.get(i);
    },
    async upsertDraftSlip(periodId, teacherId, baseSatang) {
      const cur = [...slips.values()].find((s) => s.periodId === periodId && s.teacherId === teacherId);
      if (!cur) {
        const row: Slip = { id: id(), periodId, teacherId, baseSatang, status: "draft" };
        slips.set(row.id, row);
        return "created";
      }
      if (cur.status !== "draft") return "skipped";
      cur.baseSatang = baseSatang;
      return "refreshed";
    },
    async listLines(slipId) {
      return [...lines.values()].filter((l) => l.slipId === slipId);
    },
    async sumLinesByPeriod(periodId) {
      const out = new Map<string, number>();
      for (const l of lines.values()) {
        const s = slips.get(l.slipId);
        if (s && s.periodId === periodId) out.set(l.slipId, (out.get(l.slipId) ?? 0) + l.amountSatang);
      }
      return out;
    },
    async insertLine(l) {
      if (l.source === "auto") {
        if (!l.sourceRef) throw new Error("an auto line needs a sourceRef");
        const dup = [...lines.values()].find((x) => x.source === "auto" && x.slipId === l.slipId && x.kind === l.kind && x.sourceRef === l.sourceRef);
        if (dup) return dup; // mirrors the 0011 partial unique index: a duplicate auto line is a no-op
      }
      const row: Line = { ...l, sourceRef: l.sourceRef ?? null, id: id() };
      lines.set(row.id, row);
      return row;
    },
    async syncAutoLines(slipId, kinds, desired) {
      const have = [...lines.values()].filter((l) => l.slipId === slipId && l.source === "auto" && kinds.includes(l.kind));
      const key = (k: string, r: string | null | undefined) => `${k}|${r ?? ""}`;
      const want = new Map(desired.map((d) => [key(d.kind, d.sourceRef), d]));
      let inserted = 0;
      let updated = 0;
      let removed = 0;
      for (const l of have) {
        const d = want.get(key(l.kind, l.sourceRef));
        if (!d) {
          lines.delete(l.id);
          removed += 1;
          continue;
        }
        if (l.label !== d.label || l.amountSatang !== d.amountSatang) {
          l.label = d.label;
          l.amountSatang = d.amountSatang;
          updated += 1;
        }
        want.delete(key(l.kind, l.sourceRef));
      }
      for (const d of want.values()) {
        const row: Line = { id: id(), slipId, kind: d.kind, label: d.label, amountSatang: d.amountSatang, source: "auto", createdBy: "auto", sourceRef: d.sourceRef };
        lines.set(row.id, row);
        inserted += 1;
      }
      return { inserted, updated, removed };
    },
    async getLine(i) {
      return lines.get(i);
    },
    async deleteLine(i) {
      lines.delete(i);
    },
    async teacherNames(ids) {
      const out = new Map<string, string>();
      for (const i of ids) if (names.has(i)) out.set(i, names.get(i)!);
      return out;
    },
  };
}
