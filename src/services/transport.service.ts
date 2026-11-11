// TASK-868 (REQ-120 R1.2 / R1.6, SPEC-100 §3 / §5 / §9b) — Transportation: the schools, the trips, and the trips as AUTO pay lines.
//
//   • schools   — name + stored one-way distance (editable). Changing a distance never re-prices a trip already entered:
//                 a trip stores its OWN total km.
//   • trips     — one person, one date, one school, one-way or round trip; `km` defaults to the school's distance (× 2 for a
//                 round trip) and is editable per trip; `vehicle` is a SNAPSHOT of the person's profile at entry.
//   • the lines — `applyTransportLines(periodId)`: one `kind='transport'`, `source='auto'` line per trip, `source_ref =
//                 trip:<tripId>`, IDEMPOTENT (migration 0011's partial unique index), the SAME pattern as TASK-867.
//
// Who sees what (REQ-120 R0.2 — an admin never sees pay): the routes let a ceo OR an admin enter schools and trips; the DTO an
// admin gets has NO amount and NO vehicle (the vehicle + the km would give the pay away). That is decided HERE, in `tripDTO`,
// by a whitelist of keys, not in the route.
//
// What `applyTransportLines` deliberately does NOT do (as 867): never DELETE or REWRITE a money line — a line whose trip is
// gone comes back as `orphaned`, one whose amount/label would now differ as `changed`; never create a slip; never touch a
// `confirmed` slip; never write into a `locked` period (409 `LOCKED`); a trip with no vehicle on file is `SKIPPED_NO_VEHICLE`.
import { and, asc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { db } from "../db";
import { boPaySlipLine } from "../db/schema";
import { boSchool, boTransportTrip } from "../db/schema-salary-b";
import { badRequest, conflict, notFound, pgErrorCode } from "../lib/http";
import { numericFromSatang, satangFromNumeric } from "../lib/satang";
import { defaultTripKm, kmToHundredths, tripAmountSatang, tripLabel, tripSourceRef, type Vehicle } from "../lib/transport-pricing";
import { dbSalaryStore } from "./salary-db.store";
import type { SalaryService, SalaryStore } from "./salary.service";
import { autoLineKey, fire, payLineText, realNotify, transportDetail, type NotifyFn } from "./salary-notify"; // 🔻 TASK-920

export type Viewer = "ceo" | "admin";

export interface School { id: string; name: string; distanceKm: number; active: boolean }
export interface Trip {
  id: string;
  teacherId: string;
  date: string;
  schoolId: string;
  roundTrip: boolean;
  km: number;
  vehicle: Vehicle | null;
  note: string | null;
  createdBy: string | null;
}

// ───────────────────────────────── the store (the real one and the in-memory one implement it) ─────────────────────────────────

export interface TransportStore {
  listSchools(): Promise<School[]>;
  getSchool(id: string): Promise<School | undefined>;
  /** Throws a Postgres-style `{code:"23505"}` error on a duplicate name (case-insensitive). */
  insertSchool(s: { name: string; distanceKm: number; active: boolean }): Promise<School>;
  updateSchool(id: string, patch: Partial<{ name: string; distanceKm: number; active: boolean }>): Promise<School | undefined>;
  /** Trips whose date is in `[from, to]` (inclusive), optionally one person's, ordered by date then id. */
  listTrips(range: { from: string; to: string }, teacherId?: string): Promise<Trip[]>;
  getTrip(id: string): Promise<Trip | undefined>;
  insertTrip(t: Omit<Trip, "id">): Promise<Trip>;
  updateTrip(id: string, patch: Partial<Omit<Trip, "id" | "teacherId" | "createdBy">>): Promise<Trip | undefined>;
  deleteTrip(id: string): Promise<boolean>;
}

const school = (r: typeof boSchool.$inferSelect): School => ({ id: r.id, name: r.name, distanceKm: Number(r.distanceKm), active: r.active });
const trip = (r: typeof boTransportTrip.$inferSelect): Trip => ({
  id: r.id,
  teacherId: r.teacherId,
  date: r.date,
  schoolId: r.schoolId,
  roundTrip: r.roundTrip,
  km: Number(r.km),
  vehicle: r.vehicle,
  note: r.note,
  createdBy: r.createdBy,
});
/** km as the exact decimal text numeric(8,2) takes: `12.5` → "12.50". Goes through hundredths, never a float. */
const kmText = (km: number): string => {
  const h = kmToHundredths(km);
  return `${Math.floor(h / 100)}.${String(h % 100).padStart(2, "0")}`;
};

export function dbTransportStore(exec: any = db): TransportStore {
  return {
    async listSchools() {
      const rows: (typeof boSchool.$inferSelect)[] = await exec.select().from(boSchool).orderBy(asc(boSchool.name));
      return rows.map(school);
    },
    async getSchool(id) {
      const [r] = await exec.select().from(boSchool).where(eq(boSchool.id, id)).limit(1);
      return r ? school(r) : undefined;
    },
    async insertSchool(s) {
      const [r] = await exec.insert(boSchool).values({ name: s.name, distanceKm: kmText(s.distanceKm), active: s.active }).returning();
      return school(r);
    },
    async updateSchool(id, patch) {
      const set: Record<string, unknown> = {};
      if (patch.name !== undefined) set.name = patch.name;
      if (patch.distanceKm !== undefined) set.distanceKm = kmText(patch.distanceKm);
      if (patch.active !== undefined) set.active = patch.active;
      const [r] = await exec.update(boSchool).set(set).where(eq(boSchool.id, id)).returning();
      return r ? school(r) : undefined;
    },
    async listTrips(range, teacherId) {
      const where = and(gte(boTransportTrip.date, range.from), lte(boTransportTrip.date, range.to), teacherId ? eq(boTransportTrip.teacherId, teacherId) : undefined);
      const rows: (typeof boTransportTrip.$inferSelect)[] = await exec.select().from(boTransportTrip).where(where).orderBy(asc(boTransportTrip.date), asc(boTransportTrip.id));
      return rows.map(trip);
    },
    async getTrip(id) {
      const [r] = await exec.select().from(boTransportTrip).where(eq(boTransportTrip.id, id)).limit(1);
      return r ? trip(r) : undefined;
    },
    async insertTrip(t) {
      const [r] = await exec
        .insert(boTransportTrip)
        .values({ teacherId: t.teacherId, date: t.date, schoolId: t.schoolId, roundTrip: t.roundTrip, km: kmText(t.km), vehicle: t.vehicle, note: t.note, createdBy: t.createdBy })
        .returning();
      return trip(r);
    },
    async updateTrip(id, patch) {
      const set: Record<string, unknown> = {};
      if (patch.date !== undefined) set.date = patch.date;
      if (patch.schoolId !== undefined) set.schoolId = patch.schoolId;
      if (patch.roundTrip !== undefined) set.roundTrip = patch.roundTrip;
      if (patch.km !== undefined) set.km = kmText(patch.km);
      if (patch.vehicle !== undefined) set.vehicle = patch.vehicle;
      if (patch.note !== undefined) set.note = patch.note;
      const [r] = await exec.update(boTransportTrip).set(set).where(eq(boTransportTrip.id, id)).returning();
      return r ? trip(r) : undefined;
    },
    async deleteTrip(id) {
      const gone: { id: string }[] = await exec.delete(boTransportTrip).where(eq(boTransportTrip.id, id)).returning({ id: boTransportTrip.id });
      return gone.length > 0;
    },
  };
}

/** The keys of `o` whose value is not `undefined` (what the real store's `set` object holds). */
const defined = <T extends object>(o: T): Partial<T> => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;

export function memoryTransportStore():TransportStore & { schools: Map<string, School>; trips: Map<string, Trip> } {
  const schools = new Map<string, School>();
  const trips = new Map<string, Trip>();
  let n = 0;
  const id = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
  return {
    schools,
    trips,
    async listSchools() { return [...schools.values()].sort((a, b) => a.name.localeCompare(b.name)); },
    async getSchool(i) { return schools.get(i); },
    async insertSchool(s) {
      if ([...schools.values()].some((x) => x.name.toLowerCase() === s.name.toLowerCase())) throw Object.assign(new Error("duplicate key"), { code: "23505" });
      const row = { id: id(), ...s };
      schools.set(row.id, row);
      return { ...row };
    },
    async updateSchool(i, patch) {
      const cur = schools.get(i);
      if (!cur) return undefined;
      if (patch.name !== undefined && [...schools.values()].some((x) => x.id !== i && x.name.toLowerCase() === patch.name!.toLowerCase())) throw Object.assign(new Error("duplicate key"), { code: "23505" });
      const next = { ...cur, ...defined(patch) };
      schools.set(i, next);
      return { ...next };
    },
    async listTrips(range, teacherId) {
      return [...trips.values()]
        .filter((t) => t.date >= range.from && t.date <= range.to && (!teacherId || t.teacherId === teacherId))
        .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : 1))
        .map((t) => ({ ...t }));
    },
    async getTrip(i) { const t = trips.get(i); return t ? { ...t } : undefined; },
    async insertTrip(t) { const row = { id: id(), ...t }; trips.set(row.id, row); return { ...row }; },
    async updateTrip(i, patch) {
      const cur = trips.get(i);
      if (!cur) return undefined;
      const next = { ...cur, ...defined(patch) }; // like the real store: a key left `undefined` is not set
      trips.set(i, next);
      return { ...next };
    },
    async deleteTrip(i) { return trips.delete(i); },
  };
}

// ───────────────────────────────── what each viewer sees (R0.2) ─────────────────────────────────

/** The CEO's view of a trip: everything, with the computed pay (null when there is no vehicle to price it with). */
export interface TripDTOCeo { id: string; teacherId: string; date: string; schoolId: string; schoolName: string; roundTrip: boolean; km: number; vehicle: Vehicle | null; note: string | null; amountSatang: number | null }
/** An admin's view: NO amount, NO vehicle. */
export type TripDTOAdmin = Omit<TripDTOCeo, "amountSatang" | "vehicle">;

export const CEO_TRIP_KEYS = ["amountSatang", "date", "id", "km", "note", "roundTrip", "schoolId", "schoolName", "teacherId", "vehicle"] as const;
export const ADMIN_TRIP_KEYS = ["date", "id", "km", "note", "roundTrip", "schoolId", "schoolName", "teacherId"] as const;

/** Built key by key — a whitelist, so a field added to `Trip` later can never leak to an admin by accident. */
export function tripDTO(t: Trip, schoolName: string, viewer: Viewer): TripDTOCeo | TripDTOAdmin {
  const common = { id: t.id, teacherId: t.teacherId, date: t.date, schoolId: t.schoolId, schoolName, roundTrip: t.roundTrip, km: t.km, note: t.note };
  if (viewer !== "ceo") return common;
  return { ...common, vehicle: t.vehicle, amountSatang: t.vehicle ? tripAmountSatang(t.km, t.vehicle) : null };
}

// ───────────────────────────────── the pure planning of the pay lines ─────────────────────────────────

export interface DesiredLine { slipId: string; teacherId: string; sourceRef: string; label: string; amountSatang: number }
export interface ExistingTransportLine { slipId: string; sourceRef: string; label: string; amountSatang: number }
export type TransportSkipReason = "SKIPPED_NO_VEHICLE" | "SKIPPED_NO_SLIP" | "SKIPPED_CONFIRMED" | "SKIPPED_LOCKED";
export interface SkippedTrip { reason: TransportSkipReason; tripId: string; teacherId: string; date: string; sourceRef: string }
export interface ChangedLine { slipId: string; sourceRef: string; existing: { label: string; amountSatang: number }; wanted: { label: string; amountSatang: number } }
export interface OrphanedLine extends ExistingTransportLine { note: "TRIP_GONE" }
export interface ApplyTransportResult { written: number; unchanged: number; skipped: SkippedTrip[]; orphaned: OrphanedLine[]; changed: ChangedLine[]; /** 🔻 TASK-920: failed Transportation notifications (only when > 0) */ notifyFailed?: number }

export const lineKey = (slipId: string, sourceRef: string): string => `${slipId}|${sourceRef}`;

export interface PlanInput {
  trips: readonly Trip[];
  schoolName: (schoolId: string) => string;
  /** teacherId → their slip in THIS period (absent ⇒ not in the run). */
  slipByTeacher: ReadonlyMap<string, { id: string; status: "draft" | "confirmed" | "locked" }>;
}

/** Who gets which line and why a trip is not paid. PURE. */
export function planTransportLines(input: PlanInput): { desired: DesiredLine[]; skipped: SkippedTrip[]; wantedKeys: Set<string> } {
  const desired: DesiredLine[] = [];
  const skipped: SkippedTrip[] = [];
  const wantedKeys = new Set<string>();
  for (const t of input.trips) {
    const sourceRef = tripSourceRef(t.id);
    const skip = (reason: TransportSkipReason) => skipped.push({ reason, tripId: t.id, teacherId: t.teacherId, date: t.date, sourceRef });
    if (!t.vehicle) { skip("SKIPPED_NO_VEHICLE"); continue; } // nothing to price it with: listed, never guessed
    const slip = input.slipByTeacher.get(t.teacherId);
    if (!slip) { skip("SKIPPED_NO_SLIP"); continue; }
    wantedKeys.add(lineKey(slip.id, sourceRef)); // wanted even when this slip cannot take it now (an existing line is not an orphan)
    if (slip.status === "locked") { skip("SKIPPED_LOCKED"); continue; }
    if (slip.status === "confirmed") { skip("SKIPPED_CONFIRMED"); continue; }
    desired.push({
      slipId: slip.id,
      teacherId: t.teacherId,
      sourceRef,
      label: tripLabel({ schoolName: input.schoolName(t.schoolId), date: t.date, roundTrip: t.roundTrip, km: t.km }),
      amountSatang: tripAmountSatang(t.km, t.vehicle),
    });
  }
  return { desired, skipped, wantedKeys };
}

/** unchanged · changed (same key, different money/label — reported, NOT applied) · to write; orphans = existing trip lines nothing wants. */
export function reconcile(plan: { desired: DesiredLine[]; wantedKeys: Set<string> }, existing: readonly ExistingTransportLine[]) {
  const have = new Map(existing.map((l) => [lineKey(l.slipId, l.sourceRef), l]));
  const toWrite: DesiredLine[] = [];
  const changed: ChangedLine[] = [];
  let unchanged = 0;
  for (const d of plan.desired) {
    const e = have.get(lineKey(d.slipId, d.sourceRef));
    if (!e) toWrite.push(d);
    else if (e.amountSatang === d.amountSatang && e.label === d.label) unchanged += 1;
    else changed.push({ slipId: d.slipId, sourceRef: d.sourceRef, existing: { label: e.label, amountSatang: e.amountSatang }, wanted: { label: d.label, amountSatang: d.amountSatang } });
  }
  const orphaned = existing
    .filter((l) => l.sourceRef.startsWith("trip:") && !plan.wantedKeys.has(lineKey(l.slipId, l.sourceRef)))
    .map((l): OrphanedLine => ({ ...l, note: "TRIP_GONE" }));
  return { toWrite, unchanged, changed, orphaned };
}

// ───────────────────────────────── the line store (a tiny one of its own, ON PURPOSE — see bonus-lines.service) ─────────────────────────────────

export interface TransportLineStore {
  /** The AUTO transport lines (kind 'transport', source 'auto') of these slips. */
  listAutoTransportLines(slipIds: readonly string[]): Promise<ExistingTransportLine[]>;
  /** `"exists"` when (slip, kind, source_ref) is already there — never an error. */
  insertAutoTransportLine(line: DesiredLine, actor: string): Promise<"written" | "exists">;
}

export function dbTransportLineStore(exec: any = db): TransportLineStore {
  return {
    async listAutoTransportLines(slipIds) {
      if (!slipIds.length) return [];
      const rows: (typeof boPaySlipLine.$inferSelect)[] = await exec
        .select()
        .from(boPaySlipLine)
        .where(and(inArray(boPaySlipLine.slipId, [...slipIds]), eq(boPaySlipLine.kind, "transport"), eq(boPaySlipLine.source, "auto")));
      return rows.filter((r) => r.sourceRef).map((r) => ({ slipId: r.slipId, sourceRef: r.sourceRef!, label: r.label, amountSatang: satangFromNumeric(r.amount) }));
    },
    async insertAutoTransportLine(l, actor) {
      const inserted: { id: string }[] = await exec
        .insert(boPaySlipLine)
        .values({ slipId: l.slipId, kind: "transport", label: l.label, amount: numericFromSatang(l.amountSatang), source: "auto", sourceRef: l.sourceRef, createdBy: actor })
        .onConflictDoNothing({ target: [boPaySlipLine.slipId, boPaySlipLine.kind, boPaySlipLine.sourceRef], where: sql`${boPaySlipLine.source} = 'auto'` })
        .returning({ id: boPaySlipLine.id });
      return inserted.length ? "written" : "exists";
    },
  };
}

export function memoryTransportLineStore(): TransportLineStore & { lines: ExistingTransportLine[]; actors: string[] } {
  const lines: ExistingTransportLine[] = [];
  const actors: string[] = [];
  return {
    lines,
    actors,
    async listAutoTransportLines(slipIds) { return lines.filter((l) => slipIds.includes(l.slipId)).map((l) => ({ ...l })); },
    async insertAutoTransportLine(l, actor) {
      if (lines.some((x) => x.slipId === l.slipId && x.sourceRef === l.sourceRef)) return "exists";
      lines.push({ slipId: l.slipId, sourceRef: l.sourceRef, label: l.label, amountSatang: l.amountSatang });
      actors.push(actor);
      return "written";
    },
  };
}

// ───────────────────────────────── the service ─────────────────────────────────

export interface TransportDeps {
  store: TransportStore;
  lines: TransportLineStore;
  /** Jason's service: `getPeriod` applies his LAZY 12:00 lock first (so the lock check is his, not a copy); `listPeriods` finds a date's period. */
  salary: Pick<SalaryService, "getPeriod" | "listPeriods">;
  /** The people (for the vehicle snapshot). */
  profiles: Pick<SalaryStore, "getProfile">;
  /** 🔻 TASK-920: the notifier + the coach-name lookup. Optional: absent = no notifications (every existing test). */
  notify?: NotifyFn;
  names?: (teacherIds: string[]) => Promise<Map<string, string>>;
}

const locked = () => conflict("LOCKED", "This period is locked and cannot be edited");
const REAL_DATE = (s: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

/** A validated km figure (positive, at most 2 decimals), else a 400. */
function km2(v: number, what: string): number {
  try {
    kmToHundredths(v);
  } catch {
    throw badRequest(`${what} must be a positive number with at most 2 decimals`);
  }
  return v;
}

export function createTransportService(deps: TransportDeps) {
  const { store, lines, salary, profiles } = deps;

  /** 409 `LOCKED` when the pay period that contains `date` is locked. A date no period covers (yet) is open. */
  async function assertOpenOn(date: string): Promise<void> {
    if (!REAL_DATE(date)) throw badRequest("date must be a real date, YYYY-MM-DD");
    const periods = await salary.listPeriods(); // applies the lazy lock
    const hit = periods.filter((p) => p.periodStart && p.periodEnd && date >= p.periodStart && date <= p.periodEnd);
    if (hit.some((p) => p.status === "locked")) throw locked();
  }
  async function vehicleOf(teacherId: string): Promise<Vehicle | null> {
    return (await profiles.getProfile(teacherId))?.vehicle ?? null;
  }
  async function schoolNames(): Promise<Map<string, string>> {
    return new Map((await store.listSchools()).map((s) => [s.id, s.name]));
  }
  const schoolDTO = (s: School) => ({ id: s.id, name: s.name, distanceKm: s.distanceKm, active: s.active });
  const tripOut = async (t: Trip, viewer: Viewer) => tripDTO(t, (await schoolNames()).get(t.schoolId) ?? "", viewer);

  return {
    // ───── schools ─────
    async listSchools() {
      return (await store.listSchools()).map(schoolDTO);
    },
    async createSchool(input: { name: string; distanceKm: number; active?: boolean }) {
      const name = input.name.trim();
      if (!name) throw badRequest("name is required");
      km2(input.distanceKm, "distanceKm");
      try {
        return schoolDTO(await store.insertSchool({ name, distanceKm: input.distanceKm, active: input.active ?? true }));
      } catch (e) {
        if (pgErrorCode(e) === "23505") throw conflict("SCHOOL_EXISTS", "A school with this name already exists");
        throw e;
      }
    },
    async updateSchool(id: string, patch: { name?: string; distanceKm?: number; active?: boolean }) {
      const clean: { name?: string; distanceKm?: number; active?: boolean } = {};
      if (patch.name !== undefined) {
        clean.name = patch.name.trim();
        if (!clean.name) throw badRequest("name is required");
      }
      if (patch.distanceKm !== undefined) clean.distanceKm = km2(patch.distanceKm, "distanceKm");
      if (patch.active !== undefined) clean.active = patch.active;
      try {
        const s = await store.updateSchool(id, clean);
        if (!s) throw notFound("School not found");
        return schoolDTO(s);
      } catch (e) {
        if (pgErrorCode(e) === "23505") throw conflict("SCHOOL_EXISTS", "A school with this name already exists");
        throw e;
      }
    },

    // ───── trips ─────
    /** A period's trips (the R1.4 range), optionally one person's. 404 for an unknown period. */
    async listTrips(q: { periodId: string; teacherId?: string }, viewer: Viewer) {
      const { period } = await salary.getPeriod(q.periodId);
      if (!period.periodStart || !period.periodEnd) throw badRequest("This period has no date range (period_start / period_end)");
      const names = await schoolNames();
      const rows = await store.listTrips({ from: period.periodStart, to: period.periodEnd }, q.teacherId);
      return rows.map((t) => tripDTO(t, names.get(t.schoolId) ?? "", viewer));
    },
    async createTrip(input: { teacherId: string; date: string; schoolId: string; roundTrip: boolean; km?: number; note?: string | null }, actor: string, viewer: Viewer) {
      await assertOpenOn(input.date);
      const sch = await store.getSchool(input.schoolId);
      if (!sch) throw badRequest("school not found");
      if (!sch.active) throw badRequest("school is not active");
      const km = input.km !== undefined ? km2(input.km, "km") : defaultTripKm(sch.distanceKm, input.roundTrip);
      const created = await store.insertTrip({
        teacherId: input.teacherId,
        date: input.date,
        schoolId: input.schoolId,
        roundTrip: input.roundTrip,
        km,
        vehicle: await vehicleOf(input.teacherId), // the SNAPSHOT: a later profile change never re-prices this trip
        note: input.note?.trim() ? input.note.trim() : null,
        createdBy: actor,
      });
      return tripOut(created, viewer);
    },
    /**
     * Edit a trip. `km` omitted + the school or the round-trip flag changed ⇒ the default is recomputed for the new
     * school / flag; otherwise the km stays. The vehicle snapshot is NEVER overwritten — except a NULL one, which is filled from the
     * person's profile now (a trip entered before they had a vehicle on file would otherwise never be paid).
     */
    async updateTrip(id: string, patch: { date?: string; schoolId?: string; roundTrip?: boolean; km?: number; note?: string | null }, viewer: Viewer) {
      const cur = await store.getTrip(id);
      if (!cur) throw notFound("Trip not found");
      await assertOpenOn(cur.date); // the period it is in now…
      if (patch.date !== undefined) await assertOpenOn(patch.date); // …and the one it moves to
      const schoolId = patch.schoolId ?? cur.schoolId;
      const roundTrip = patch.roundTrip ?? cur.roundTrip;
      const sch = await store.getSchool(schoolId);
      if (!sch) throw badRequest("school not found");
      if (patch.schoolId !== undefined && patch.schoolId !== cur.schoolId && !sch.active) throw badRequest("school is not active");
      let km = cur.km;
      if (patch.km !== undefined) km = km2(patch.km, "km");
      else if (schoolId !== cur.schoolId || roundTrip !== cur.roundTrip) km = defaultTripKm(sch.distanceKm, roundTrip);
      const next = await store.updateTrip(id, {
        date: patch.date,
        schoolId,
        roundTrip,
        km,
        note: patch.note === undefined ? undefined : patch.note?.trim() ? patch.note.trim() : null,
        vehicle: cur.vehicle ?? (await vehicleOf(cur.teacherId)) ?? undefined,
      });
      if (!next) throw notFound("Trip not found");
      return tripOut(next, viewer);
    },
    async deleteTrip(id: string) {
      const cur = await store.getTrip(id);
      if (!cur) throw notFound("Trip not found");
      await assertOpenOn(cur.date);
      await store.deleteTrip(id);
    },

    // ───── the pay lines ─────
    /** Applies the period's trips as auto lines. 404 unknown period; 409 `LOCKED` locked period; idempotent. */
    async applyTransportLines(periodId: string, actor: string): Promise<ApplyTransportResult> {
      const overview = await salary.getPeriod(periodId); // lazy lock applied here; 404 if unknown
      if (overview.period.status === "locked") throw locked();
      const { periodStart, periodEnd } = overview.period;
      if (!periodStart || !periodEnd) throw badRequest("This period has no date range (period_start / period_end)");

      const trips = await store.listTrips({ from: periodStart, to: periodEnd });
      const names = await schoolNames();
      const slipByTeacher = new Map(overview.slips.map((s) => [s.teacherId, { id: s.id, status: s.status }]));
      const plan = planTransportLines({ trips, schoolName: (i) => names.get(i) ?? "", slipByTeacher });
      const existing = await lines.listAutoTransportLines(overview.slips.map((s) => s.id));
      const { toWrite, unchanged, changed, orphaned } = reconcile(plan, existing);

      let written = 0;
      let raced = 0;
      let notifyFailed = 0;
      const tripById = new Map(trips.map((t) => [t.id, t]));
      const nameOf = deps.names && toWrite.length ? await deps.names([...new Set(toWrite.map((l) => l.teacherId))]) : new Map<string, string>();
      for (const l of toWrite) {
        if ((await lines.insertAutoTransportLine(l, actor)) === "written") {
          written += 1;
          // 🔻 TASK-920: one Transportation item per line WRITTEN: «Transportation · coach · <trip date> · <school> · Round trip|One way», NO amount, NO km, NO vehicle (they give the pay away).
          const t = tripById.get(l.sourceRef.replace(/^trip:/, ""));
          if (t) notifyFailed += (await fire(deps.notify, { type: "Transportation", text: payLineText("Transportation", nameOf.get(l.teacherId), t.date, transportDetail(names.get(t.schoolId) ?? "", t.roundTrip)), occurredOn: t.date, key: autoLineKey(l.slipId, "transport", l.sourceRef) })).failed;
        } else raced += 1; // somebody wrote it between our read and our write: "unchanged", never a 500
      }
      return { written, unchanged: unchanged + raced, skipped: plan.skipped, orphaned, changed, ...(notifyFailed ? { notifyFailed } : {}) };
    },
  };
}

export type TransportService = ReturnType<typeof createTransportService>;

/** The production wiring: the real stores, on Jason's salary service. */
export function transportServiceFor(salary: Pick<SalaryService, "getPeriod" | "listPeriods">): TransportService {
  return createTransportService({ store: dbTransportStore(), lines: dbTransportLineStore(), salary, profiles: dbSalaryStore, notify: realNotify, names: (ids) => dbSalaryStore.teacherNames(ids) });
}
