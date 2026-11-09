// TASK-921 (REQ-120 R1.2 / R1.3, DECISIONS row 18) — Commission distribution, PURE: how ONE product-sale line's commission is split among its sellers, and how the FT pool is shared.
//
//   1. the AMOUNT is the sale line's `commission_minor` AS STORED (the line total, never × qty, never recomputed from a rate, never reduced by the bill's discount);
//   2. several sellers split it EQUALLY (de-duplicated, in the order given); the leftover satang go one each to the FIRST sellers in that order, so what goes in comes out;
//   3. an FT seller's share goes to the FT pool; a PT / FL / STAFF seller keeps their own (rule 5);
//   4. eligibility by type × group: FT · PT · FL earn on ALL groups; STAFF earn ONLY on the «Skate bag» group — matched on the product's `commission_group`, trimmed + case-insensitive,
//      NEVER on the Type or a name; a seller with no profile earns nothing;
//   5. an ineligible seller's share is DROPPED and reported (`skipped`) — it is NOT re-split among the eligible sellers (the default until ขวัญ answers Q1a);
//   6. the pool is split equally among every FT of the period (a mid-period joiner gets a full share); with no FT it stays unpaid and is reported.
// Integer satang everywhere; no float, no rounding.
import type { EmploymentType } from "./role-of-day";

/** ขวัญ's own word, «Only Skate bag» (CUSTOMER-ANSWERS 2026-10-23). */
export const STAFF_COMMISSION_GROUP = "Skate bag";

/** True when a product's `commission_group` IS the STAFF group: trimmed, case-insensitive, exact. NULL / empty / any other group is false. */
export const isStaffGroup = (group: string | null | undefined): boolean => (group ?? "").trim().toLowerCase() === STAFF_COMMISSION_GROUP.toLowerCase();

export type SkipReason = "NO_PROFILE" | "NOT_ELIGIBLE_GROUP";
export interface SplitSeller { teacherId: string; /** the seller's type on the sale's day (`roleOfDay`); null = no profile */ type: EmploymentType | null }
export interface SplitResult {
  /** PT / FL / eligible STAFF: they keep their own share. */
  own: { teacherId: string; amountMinor: number }[];
  /** the FT sellers' shares, summed: they go to the pool. */
  toPool: number;
  /** a share that is NOT paid, and why. */
  skipped: { teacherId: string; reason: SkipReason; amountMinor: number }[];
}

/** `total` split into `n` equal whole parts: floor each, then +1 satang to the first `total mod n` parts. Σ parts = total. */
export function equalShares(total: number, n: number): number[] {
  if (!Number.isInteger(total) || total < 0) throw new Error(`amount must be a whole number of satang ≥ 0, got ${total}`);
  if (!Number.isInteger(n) || n < 1) throw new Error("need at least one share");
  const base = Math.floor(total / n);
  const extra = total - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < extra ? 1 : 0));
}

export function splitLine(input: { amountMinor: number; sellers: SplitSeller[]; groupName: string | null | undefined }): SplitResult {
  const seen = new Set<string>();
  const sellers = input.sellers.filter((s) => (seen.has(s.teacherId) ? false : (seen.add(s.teacherId), true)));
  const out: SplitResult = { own: [], toPool: 0, skipped: [] };
  if (!sellers.length) return out;
  const shares = equalShares(input.amountMinor, sellers.length);
  sellers.forEach((s, i) => {
    const amountMinor = shares[i]!;
    if (s.type === null) { out.skipped.push({ teacherId: s.teacherId, reason: "NO_PROFILE", amountMinor }); return; }
    if (s.type === "STAFF" && !isStaffGroup(input.groupName)) { out.skipped.push({ teacherId: s.teacherId, reason: "NOT_ELIGIBLE_GROUP", amountMinor }); return; }
    if (s.type === "FT") out.toPool += amountMinor;
    else out.own.push({ teacherId: s.teacherId, amountMinor });
  });
  return out;
}

/** The FT pool shared equally (the same remainder rule). No FT ⇒ no shares and the whole pool is `unpaid`. */
export function poolSplit(poolMinor: number, ftTeacherIds: string[]): { shares: { teacherId: string; amountMinor: number }[]; unpaid: number } {
  const ids = [...new Set(ftTeacherIds)];
  if (!ids.length) return { shares: [], unpaid: poolMinor };
  const parts = equalShares(poolMinor, ids.length);
  return { shares: ids.map((teacherId, i) => ({ teacherId, amountMinor: parts[i]! })), unpaid: 0 };
}

/** The source_refs of the auto lines (0011's partial unique index is on (slip, kind, source_ref)). */
export const ownRef = (saleLineId: string, teacherId: string) => `cm:${saleLineId}:${teacherId}`;
export const poolRef = (periodId: string, teacherId: string) => `cm-pool:${periodId}:${teacherId}`;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dmy = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(2, 4)}`;
export const ownLabel = (productName: string, soldOn: string) => `Commission · ${productName.trim() || "product"} · ${dmy(soldOn)}`;
export const poolLabel = (year: number, month: number) => `Commission · Full-time pool · ${MONTHS[month - 1] ?? month} ${year}`;
