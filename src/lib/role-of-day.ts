// R1.1 — the role of a person on a given day (SPEC-101 §4 / TASK-871). A person holding PT + FL is FL on Mon–Fri and PT on Sat–Sun;
// a single-role person is that role every day. "The role of a class is automatic by its day": every downstream pay rule asks
// `roleOfDay`, never a stored per-class role.

export type EmploymentType = "FT" | "PT" | "FL" | "STAFF";
export const EMPLOYMENT_TYPES: readonly EmploymentType[] = ["FT", "PT", "FL", "STAFF"];

export interface HasRoles {
  /** The primary type (what the profile was created as). */
  employmentType: EmploymentType;
  /** The set of roles held. Empty / absent ⇒ just `employmentType`. The only multi-role combination is PT + FL. */
  roles?: readonly EmploymentType[];
}

/** The roles a profile effectively holds. */
export const effectiveRoles = (p: HasRoles): EmploymentType[] => (p.roles && p.roles.length ? [...new Set(p.roles)] : [p.employmentType]);

/** Day of week of a `YYYY-MM-DD` calendar date: 0 = Sunday … 6 = Saturday (no timezone: the date string IS the Bangkok date). */
export function dayOfWeek(date: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`not a YYYY-MM-DD date: ${date}`);
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) throw new Error(`not a real date: ${date}`);
  return d.getUTCDay();
}
export const isWeekend = (date: string): boolean => [0, 6].includes(dayOfWeek(date));

/** The role this person works as on `date`. PT+FL: FL Mon–Fri, PT Sat–Sun. Anything else: its single role every day. */
export function roleOfDay(p: HasRoles, date: string): EmploymentType {
  const roles = effectiveRoles(p);
  const wknd = isWeekend(date); // validates `date` too
  if (roles.includes("PT") && roles.includes("FL")) return wknd ? "PT" : "FL";
  return roles.length === 1 ? roles[0]! : p.employmentType;
}

/** A profile may hold one role, or exactly PT + FL. Returns an error text, or null when valid (and the primary type is one of the roles). */
export function rolesProblem(p: HasRoles): string | null {
  const roles = effectiveRoles(p);
  if (roles.some((r) => !EMPLOYMENT_TYPES.includes(r))) return "unknown role";
  if (roles.length === 1) return roles[0] === p.employmentType ? null : "the only role must equal employmentType";
  const set = new Set(roles);
  if (set.size === 2 && set.has("PT") && set.has("FL")) return p.employmentType === "PT" || p.employmentType === "FL" ? null : "for PT+FL, employmentType must be PT or FL";
  return "the only multi-role combination is PT + FL";
}
