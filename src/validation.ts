import { z } from "zod";

export const orgCodeQuery = z.object({
  org: z.string().trim().min(1).optional(),
});

export const listCatalogQuery = z.object({
  org: z.string().trim().min(1).optional(),
  externalSource: z.string().trim().min(1).optional(),
  externalRef: z.string().trim().min(1).optional(),
  itemType: z.enum(["INCOME", "EXPENSE", "FIXED_COST"]).optional(),
});

export const createCatalogItem = z.object({
  sku: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(256),
  unit: z.string().trim().min(1).max(32).optional(),
  itemGroup: z.enum(["PRODUCT", "SERVICE"]).optional(),
  itemType: z.enum(["INCOME", "EXPENSE", "FIXED_COST"]).optional(),
  salePriceMinor: z.number().int().min(0).optional(),
  trackStock: z.boolean().optional(),
  reorderLevel: z.number().int().min(0).nullable().optional(),
  externalRef: z.string().trim().max(128).optional(),
  externalSource: z.string().trim().max(64).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

// Partial update of a catalog item (TASK-009) — all fields optional; identity/classification
// (sku, item_group, item_type, external_*) are not mutable here.
export const updateCatalogItem = z.object({
  name: z.string().trim().min(1).max(256).optional(),
  salePriceMinor: z.number().int().min(0).optional(),
  reorderLevel: z.number().int().min(0).nullable().optional(),
  active: z.boolean().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const stockMovement = z.object({
  direction: z.enum(["IN", "OUT", "ADJUST"]),
  quantity: z.number().int().positive(),
  // Optional explicit P&L value; when omitted the service computes quantity × unit amount.
  amountMinor: z.number().int().min(0).optional(),
  reason: z.string().trim().max(500).optional(),
  refType: z.string().trim().max(64).optional(),
  refId: z.string().trim().max(128).optional(),
  idempotencyKey: z.string().trim().min(8).max(128).optional(),
  // Skip the INSUFFICIENT_STOCK guard (freelance capping-day overage / allow-negative unlock).
  allowNegative: z.boolean().optional(),
});

// Decrement/adjust an item identified by its external ref (consumer doesn't know the uuid).
export const movementByRef = stockMovement.extend({
  org: z.string().trim().min(1).optional(),
  externalSource: z.string().trim().min(1).max(64),
  externalRef: z.string().trim().min(1).max(128),
});

export const createSale = z.object({
  lines: z
    .array(
      z.object({
        itemId: z.string().uuid(),
        quantity: z.number().int().positive(),
      }),
    )
    .min(1),
  refType: z.string().trim().max(64).optional(),
  refId: z.string().trim().max(128).optional(),
  idempotencyKey: z.string().trim().min(8).max(128).optional(),
});

export const listMovementsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const plReportQuery = z.object({
  org: z.string().trim().min(1).optional(),
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

// ── Recurring FT/PT salary (SPEC-002 / TASK-005) ──
const MONTH = z.string().regex(/^\d{4}-\d{2}$/, "ต้องเป็นเดือนรูปแบบ YYYY-MM");

export const listRecurringCostsQuery = z.object({
  org: z.string().trim().min(1).optional(),
  externalSource: z.string().trim().min(1).optional(),
  externalRef: z.string().trim().min(1).optional(),
});

export const setRecurringCost = z.object({
  externalRef: z.string().trim().min(1).max(128),
  label: z.string().trim().max(256).optional(),
  amountMinor: z.number().int().min(0),
  effectiveFrom: MONTH,
  teacherType: z.enum(["FULL_TIME", "PART_TIME"]).optional(),
});

export const materializeBody = z.object({ month: MONTH });
export const monthStartBody = z.object({ month: MONTH });

export const listPartiesQuery = z.object({
  org: z.string().trim().min(1).optional(),
  externalSource: z.string().trim().min(1).optional(),
  externalRef: z.string().trim().min(1).optional(),
});

export const createParty = z.object({
  displayName: z.string().trim().min(1).max(256),
  kind: z.enum(["PERSON", "ORGANIZATION"]).optional(),
  externalRef: z.string().trim().max(128).optional(),
  externalSource: z.string().trim().max(64).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const listAccountsQuery = z.object({
  partyId: z.string().uuid().optional(),
  unit: z.enum(["HOURS", "CURRENCY", "POINTS"]).optional(),
});

export const createAccount = z.object({
  partyId: z.string().uuid(),
  unit: z.enum(["HOURS", "CURRENCY", "POINTS"]),
  currencyCode: z.string().trim().length(3).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const accountMutation = z.object({
  amountMinor: z.number().int().positive(),
  reason: z.string().trim().max(500).optional(),
  refType: z.string().trim().max(64).optional(),
  refId: z.string().trim().max(128).optional(),
  idempotencyKey: z.string().trim().min(8).max(128).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const listLedgerQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const listCommercialQuery = z.object({
  status: z.enum(["PENDING", "APPROVED", "REJECTED", "CANCELLED"]).optional(),
});

export const createCommercialRequest = z.object({
  partyId: z.string().uuid(),
  accountId: z.string().uuid().optional(),
  kind: z.enum(["TOP_UP", "PURCHASE", "ADJUSTMENT"]),
  payload: z.record(z.string(), z.unknown()),
});

export const reviewCommercialRequest = z.object({
  action: z.enum(["approve", "reject"]),
  reviewNote: z.string().trim().max(500).optional(),
});

export const listPriceRulesQuery = z.object({
  org: z.string().trim().min(1).optional(),
  partyId: z.string().uuid().optional(),
  orgDefault: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true"),
});

export const createPriceRule = z.object({
  partyId: z.string().uuid().optional(),
  kind: z.enum(["HOURLY", "FIXED", "PERCENTAGE", "CAP"]),
  label: z.string().trim().max(128).optional(),
  amountMinor: z.number().int().min(0),
  capMinor: z.number().int().min(0).nullable().optional(),
  currencyCode: z.string().trim().length(3).optional(),
  validFrom: z.string().datetime().optional(),
  validTo: z.string().datetime().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
