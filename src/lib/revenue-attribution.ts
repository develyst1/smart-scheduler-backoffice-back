// Sale attribution (SPEC-021 / TASK-064) — ONE map, grouped two ways.
//
// A sale is a `bo.movement` with `refType: "SALE"`. Its item's `external_ref` (the product code) says what
// `refId` points at; following that link gives the student and, where one exists, the sport:
//
//   course-{size}                  → public.course_packages.id → its bookings' subjectId
//   first-trial / single-session   → public.bookings.id        → bookings.subjectId
//   voucher-{hours}                → public.vouchers.id        → student yes, sport NO (generic hours)
//
// Everything here is pure: the queries live in the service, so every rule below is unit-tested without a DB.
//
// ⚠️ Both reports read the SAME attributed list. Building it twice is how two screens end up disagreeing
// about one month's total.

export type ProductKind = "COURSE" | "VOUCHER" | "BOOKING";

/** Why a sale couldn't be attributed to a sport. `voucher` is by nature; the other two are faults. */
export type UnattributedReason = "voucher" | "unresolved" | "unknown-code";

export interface SaleMovement {
  refId: string | null;
  productCode: string | null;
  valueMinor: number;
  createdAt: Date;
}

/** What `refId` resolves to, loaded from `public` by the service. */
export interface AttributionSources {
  /** course id → { studentId, subjectId | null } (a course ⇔ one subject, REQ-010). */
  courses: Map<string, { studentId: string; subjectId: string | null }>;
  /** voucher id → studentId. Sport is structurally unknowable — see SPEC-021 §3. */
  vouchers: Map<string, { studentId: string }>;
  /** booking id → { studentId, subjectId }. */
  bookings: Map<string, { studentId: string; subjectId: string }>;
}

export interface AttributedSale {
  productCode: string | null;
  kind: ProductKind | null;
  amountMinor: number;
  studentId: string | null;
  subjectId: string | null;
  /** Set only when `subjectId` is null. */
  reason?: UnattributedReason;
}

const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000;

/**
 * Is this sale in `month` ("YYYY-MM") **in Bangkok time**?
 *
 * ⚠️ TASK-062's lesson, and it matters more here because this is money. Comparing `toISOString()` (UTC)
 * would file a purchase made at 01 Aug 02:00 Bangkok (= 31 Jul 19:00 UTC) under July — i.e. **revenue would
 * move between months for the first 7 hours of every month**. Thailand has no DST, so a fixed +07:00 shift
 * is exact.
 */
export const inMonthBangkok = (d: Date, month: string): boolean =>
  new Date(d.getTime() + BANGKOK_OFFSET_MS).toISOString().slice(0, 7) === month;

/**
 * The same month as a **UTC instant range** `[start, end)`, so the SQL can be bounded instead of reading
 * every sale ever recorded. `inMonthBangkok` stays the authority — this only narrows what's fetched, and it
 * is derived from the same +07:00 offset so the two can't disagree.
 */
export function bangkokMonthRangeUtc(month: string): { start: Date; end: Date } {
  const [y, m] = month.split("-").map(Number);
  const nextY = m === 12 ? y + 1 : y;
  const nextM = m === 12 ? 1 : m + 1;
  return {
    start: new Date(Date.UTC(y, m - 1, 1) - BANGKOK_OFFSET_MS),
    end: new Date(Date.UTC(nextY, nextM - 1, 1) - BANGKOK_OFFSET_MS),
  };
}

/** Product code → what kind of row `refId` points at. Unknown codes return null and are surfaced, never
 *  allowed to look like an ordinary voucher. */
export function productKind(code: string | null): ProductKind | null {
  if (!code) return null;
  if (/^course-\d+$/.test(code)) return "COURSE";
  if (/^voucher-\d+$/.test(code)) return "VOUCHER";
  if (code === "first-trial" || code === "single-session") return "BOOKING";
  return null;
}

/**
 * The attribution map. **Every sale comes out exactly once** — that is what makes the
 * `buckets + unattributed === total` identity hold by construction rather than by luck.
 */
export function attributeSales(
  sales: SaleMovement[],
  sources: AttributionSources,
): AttributedSale[] {
  return sales.map((s): AttributedSale => {
    const kind = productKind(s.productCode);
    const base = { productCode: s.productCode, kind, amountMinor: s.valueMinor };

    if (kind === null) {
      // A code we don't know how to follow. It must NOT quietly look like a voucher.
      return { ...base, studentId: null, subjectId: null, reason: "unknown-code" };
    }
    if (kind === "VOUCHER") {
      const v = s.refId ? sources.vouchers.get(s.refId) : undefined;
      // A voucher's CUSTOMER is known even though its SPORT never is — which is exactly why one map
      // serves both reports: unattributed by sport, fully attributed by student.
      return {
        ...base,
        studentId: v?.studentId ?? null,
        subjectId: null,
        reason: v ? "voucher" : "unresolved",
      };
    }
    const row = s.refId
      ? kind === "COURSE"
        ? sources.courses.get(s.refId)
        : sources.bookings.get(s.refId)
      : undefined;
    if (!row) return { ...base, studentId: null, subjectId: null, reason: "unresolved" };

    const subjectId = row.subjectId ?? null;
    return {
      ...base,
      studentId: row.studentId,
      subjectId,
      ...(subjectId ? {} : { reason: "unresolved" as const }),
    };
  });
}

export interface RevenueBucket {
  subjectId: string;
  name: string;
  amountMinor: number;
}
export interface RevenueByActivity {
  month: string;
  totalMinor: number;
  buckets: RevenueBucket[];
  unattributedMinor: number;
  unattributedReason: string;
}

const REASON_LABEL: Record<UnattributedReason, string> = {
  voucher: "vouchers (generic hours — no sport at sale)",
  unresolved: "sales whose reference no longer resolves",
  "unknown-code": "⚠️ sales with an unrecognised product code",
};

/**
 * Group by sport. The `unattributed` bucket is a **requirement, not an edge case**: a finance report that
 * silently drops what it can't classify shows a tidy split that doesn't add up to the month's real revenue,
 * and that is the number an executive would act on.
 */
export function groupBySubject(
  attributed: AttributedSale[],
  month: string,
  subjectName: (id: string) => string,
): RevenueByActivity {
  const byId = new Map<string, number>();
  const reasons = new Map<UnattributedReason, number>();
  let unattributedMinor = 0;
  let totalMinor = 0;

  for (const a of attributed) {
    totalMinor += a.amountMinor;
    if (a.subjectId) {
      byId.set(a.subjectId, (byId.get(a.subjectId) ?? 0) + a.amountMinor);
    } else {
      unattributedMinor += a.amountMinor;
      const r = a.reason ?? "unresolved";
      reasons.set(r, (reasons.get(r) ?? 0) + 1);
    }
  }

  return {
    month,
    totalMinor,
    buckets: [...byId.entries()]
      .map(([subjectId, amountMinor]) => ({ subjectId, name: subjectName(subjectId), amountMinor }))
      .sort((a, b) => b.amountMinor - a.amountMinor),
    unattributedMinor,
    unattributedReason: describeUnattributed(reasons),
  };
}

/** Names the reasons **with counts**, so an unrecognised product code can never hide inside a total that
 *  reads as "just vouchers". */
export function describeUnattributed(reasons: Map<UnattributedReason, number>): string {
  if (reasons.size === 0) return "";
  const order: UnattributedReason[] = ["voucher", "unresolved", "unknown-code"];
  return order
    .filter((r) => reasons.has(r))
    .map((r) => `${reasons.get(r)} ${REASON_LABEL[r]}`)
    .join("; ");
}

export interface CustomerSpend {
  studentId: string;
  name: string;
  totalSpendMinor: number;
  courses: number;
  vouchers: number;
  sessions: number;
}

/**
 * Group the SAME attributed list by customer. A voucher counts fully here — the customer is known even when
 * the sport isn't. Sales with no resolvable student are omitted (they have no customer to attribute to);
 * they remain visible in the revenue report's `unattributed`, which is where the money is reconciled.
 */
export function groupByStudent(
  attributed: AttributedSale[],
  studentName: (id: string) => string,
  q?: string,
): CustomerSpend[] {
  const acc = new Map<string, CustomerSpend>();

  for (const a of attributed) {
    if (!a.studentId) continue;
    const row = acc.get(a.studentId) ?? {
      studentId: a.studentId,
      name: studentName(a.studentId),
      totalSpendMinor: 0,
      courses: 0,
      vouchers: 0,
      sessions: 0,
    };
    row.totalSpendMinor += a.amountMinor;
    if (a.kind === "COURSE") row.courses++;
    else if (a.kind === "VOUCHER") row.vouchers++;
    else if (a.kind === "BOOKING") row.sessions++;
    acc.set(a.studentId, row);
  }

  const needle = q?.trim().toLowerCase();
  return [...acc.values()]
    .filter((r) => !needle || r.name.toLowerCase().includes(needle))
    .sort((a, b) => b.totalSpendMinor - a.totalSpendMinor);
}
