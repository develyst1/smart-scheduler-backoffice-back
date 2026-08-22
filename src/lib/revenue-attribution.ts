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

/**
 * Why a sale couldn't be attributed to a sport. `VOUCHER` is by nature; the other two are faults.
 *
 * ⚠️ **These codes are the vocabulary end to end** (TASK-083) — the same values travel from `attributeSales`
 * to the API response. The API supplies **identity**; the FE supplies **language**. My first version composed
 * an English sentence instead, which fused the two and rendered as a stray English string on a Thai
 * executive's screen — the same mistake as TASK-053's missing `titleKey`, which I should have recognised.
 */
export type UnattributedReason = "VOUCHER" | "UNRESOLVED_REF" | "UNKNOWN_CODE";

export interface SaleMovement {
  refId: string | null;
  productCode: string | null;
  valueMinor: number;
  createdAt: Date;
  /** TASK-159 (REQ-063): `"DISCOUNT"` marks a negative movement posted against its sale's OWN item + refId.
   *  It therefore attributes to the same sport by construction — it is not a special case in attribution, only
   *  in the gross/discount/net display split. Absent on every pre-REQ-063 row. */
  movementReason?: string | null;
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
  /** Carried through so the report can split gross vs discount without re-reading the movements. */
  movementReason?: string | null;
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
  // 🔴 TASK-159 (REQ-063): this used to test `/^course-\d+$/`, which has not matched a real code since
  // TASK-077 made courses program-priced — they are `course-{group}-{size}` (`course-onewheel-6`). Every
  // course sale therefore fell through to `null` and landed in **unattributed**, which is exactly the bucket
  // nobody questions because it always has something in it. Same story for single sessions: the code became
  // `session-{group}`, not the literal `single-session` still matched below (kept for pre-TASK-077 rows).
  if (/^course-[a-z-]+-\d+$/.test(code)) return "COURSE";
  if (/^voucher-\d+$/.test(code)) return "VOUCHER";
  if (/^session-[a-z-]+$/.test(code)) return "BOOKING";
  if (code === "first-trial" || code === "single-session") return "BOOKING"; // legacy codes, still on old rows
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
    // `movementReason` is spread in only when present, so every pre-REQ-063 attributed sale keeps exactly the
    // shape it had — no test or consumer sees a new `undefined` field appear.
    const base = {
      productCode: s.productCode,
      kind,
      amountMinor: s.valueMinor,
      ...(s.movementReason ? { movementReason: s.movementReason } : {}),
    };

    if (kind === null) {
      // A code we don't know how to follow. It must NOT quietly look like a voucher.
      return { ...base, studentId: null, subjectId: null, reason: "UNKNOWN_CODE" };
    }
    if (kind === "VOUCHER") {
      const v = s.refId ? sources.vouchers.get(s.refId) : undefined;
      // A voucher's CUSTOMER is known even though its SPORT never is — which is exactly why one map
      // serves both reports: unattributed by sport, fully attributed by student.
      return {
        ...base,
        studentId: v?.studentId ?? null,
        subjectId: null,
        reason: v ? "VOUCHER" : "UNRESOLVED_REF",
      };
    }
    const row = s.refId
      ? kind === "COURSE"
        ? sources.courses.get(s.refId)
        : sources.bookings.get(s.refId)
      : undefined;
    if (!row) return { ...base, studentId: null, subjectId: null, reason: "UNRESOLVED_REF" };

    const subjectId = row.subjectId ?? null;
    return {
      ...base,
      studentId: row.studentId,
      subjectId,
      ...(subjectId ? {} : { reason: "UNRESOLVED_REF" as const }),
    };
  });
}

export interface RevenueBucket {
  subjectId: string;
  name: string;
  amountMinor: number;
}
export interface UnattributedReasonRow {
  code: UnattributedReason;
  count: number;
  /** ⚠️ "3 vouchers" is less useful than "3 vouchers, ฿9,000" when deciding whether the gap matters. */
  amountMinor: number;
}

export interface RevenueByActivity {
  month: string;
  totalMinor: number;
  buckets: RevenueBucket[];
  /** TASK-083 — the structured form. `sum(reasons.amountMinor) === totalMinor` of this object. */
  unattributed: {
    totalMinor: number;
    reasons: UnattributedReasonRow[];
  };
  /** TASK-159 (REQ-063) — the display split. `totalMinor` stays the NET number every existing consumer and
   *  the `buckets + unattributed === total` identity already rely on; these two only explain how it was
   *  reached. `grossMinor + discountTotalMinor === totalMinor`, and `discountTotalMinor` is ≤ 0. */
  grossMinor: number;
  /** Σ of the DISCOUNT movements — negative (or 0 when nothing was discounted). */
  discountTotalMinor: number;
  /** @deprecated TASK-083 — same number as `unattributed.totalMinor`; kept so TASK-065 doesn't break
   *  mid-build. Derived, never computed separately. */
  unattributedMinor: number;
  /** @deprecated TASK-083 — **English prose on a Thai screen**. Derived from `unattributed.reasons` so the
   *  two can't drift, and safe to delete once Fern renders from the codes. Never parse this. */
  unattributedReason: string;
}

const REASON_LABEL: Record<UnattributedReason, string> = {
  VOUCHER: "vouchers (generic hours — no sport at sale)",
  UNRESOLVED_REF: "sales whose reference no longer resolves",
  UNKNOWN_CODE: "⚠️ sales with an unrecognised product code",
};

/** Stable order, so the FE renders the same sequence every time and `VOUCHER` (expected) reads before the
 *  two faults. */
const REASON_ORDER: UnattributedReason[] = ["VOUCHER", "UNRESOLVED_REF", "UNKNOWN_CODE"];

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
  const tally = new Map<UnattributedReason, { count: number; amountMinor: number }>();
  let unattributedMinor = 0;
  let totalMinor = 0;
  let discountTotalMinor = 0;

  for (const a of attributed) {
    totalMinor += a.amountMinor;
    // TASK-159: a DISCOUNT movement sits on its sale's own item + refId, so it has ALREADY reduced that
    // sport's bucket in the same pass — this only records how much of the net came from discounting. It is
    // never a bucket of its own, which is what keeps `buckets + unattributed === total` true on the net.
    if (a.movementReason === "DISCOUNT") discountTotalMinor += a.amountMinor;
    if (a.subjectId) {
      byId.set(a.subjectId, (byId.get(a.subjectId) ?? 0) + a.amountMinor);
    } else {
      unattributedMinor += a.amountMinor;
      const code = a.reason ?? "UNRESOLVED_REF";
      const row = tally.get(code) ?? { count: 0, amountMinor: 0 };
      row.count += 1;
      row.amountMinor += a.amountMinor;
      tally.set(code, row);
    }
  }

  // Accumulated in ONE pass alongside `unattributedMinor`, so `sum(reasons.amountMinor)` and
  // `unattributed.totalMinor` cannot disagree — a second number is a second chance to be wrong.
  const reasons: UnattributedReasonRow[] = REASON_ORDER.filter((c) => tally.has(c)).map((code) => ({
    code,
    ...tally.get(code)!,
  }));

  return {
    month,
    totalMinor,
    buckets: [...byId.entries()]
      .map(([subjectId, amountMinor]) => ({ subjectId, name: subjectName(subjectId), amountMinor }))
      .sort((a, b) => b.amountMinor - a.amountMinor),
    grossMinor: totalMinor - discountTotalMinor, // discountTotal is negative ⇒ gross is the pre-discount figure
    discountTotalMinor,
    unattributed: { totalMinor: unattributedMinor, reasons },
    unattributedMinor, // deprecated mirror
    unattributedReason: describeUnattributed(reasons), // deprecated, DERIVED from the codes
  };
}

/**
 * The deprecated English sentence, **derived from the codes** so it can never drift from them.
 *
 * Kept only so TASK-065 doesn't break mid-build. It is English prose on a Thai executive's screen, which is
 * the bug TASK-083 exists to fix — the FE should render from `unattributed.reasons`, and this can then go.
 * ⚠️ Never parse it: recovering numbers by splitting a sentence is a bug waiting to happen.
 */
export function describeUnattributed(reasons: UnattributedReasonRow[]): string {
  return reasons.map((r) => `${r.count} ${REASON_LABEL[r.code]}`).join("; ");
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
