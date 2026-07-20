// Generic Operations API contract — domain-neutral DTOs for any consumer app.

export type StockDirection = "IN" | "OUT" | "ADJUST";
export type AccountUnit = "HOURS" | "CURRENCY" | "POINTS";
export type PartyKind = "PERSON" | "ORGANIZATION";
export type LedgerDirection = "CREDIT" | "DEBIT";
export type RequestKind = "TOP_UP" | "PURCHASE" | "ADJUSTMENT";
export type RequestStatus = "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED";
export type PriceRuleKind = "HOURLY" | "FIXED" | "PERCENTAGE" | "CAP";
export type ItemGroup = "PRODUCT" | "SERVICE";
export type ItemType = "INCOME" | "EXPENSE" | "FIXED_COST";

export interface OrganizationRef {
  id: string;
  code: string;
  name: string;
}

export interface PartyDTO {
  id: string;
  displayName: string;
  kind: PartyKind;
  externalRef: string | null;
  externalSource: string | null;
  active: boolean;
}

export interface CatalogItemDTO {
  id: string;
  sku: string;
  name: string;
  unit: string;
  itemGroup: ItemGroup;
  itemType: ItemType;
  salePriceMinor: number;
  trackStock: boolean;
  reorderLevel: number | null;
  externalRef: string | null;
  externalSource: string | null;
  quantityOnHand: number;
  metadata: Record<string, unknown> | null;
  active: boolean;
}

export interface StockMovementDTO {
  id: string;
  itemId: string;
  direction: StockDirection;
  quantity: number;
  quantityAfter: number;
  amountMinor: number;
  reason: string | null;
  refType: string | null;
  refId: string | null;
  createdAt: string;
}

export interface CatalogListResponse {
  items: CatalogItemDTO[];
}

export interface CreateCatalogItemRequest {
  sku: string;
  name: string;
  unit?: string;
  itemGroup?: ItemGroup;
  itemType?: ItemType;
  salePriceMinor?: number;
  trackStock?: boolean;
  reorderLevel?: number | null;
  externalRef?: string;
  externalSource?: string;
  /** Freelance-budget items (SPEC-001) carry { kind:'FREELANCE_BUDGET', monthlyBudgetMinor }. */
  metadata?: Record<string, unknown>;
}

/** Partial edit of a catalog item (TASK-009). Identity/classification
 *  (sku, item_group, item_type, external_*) are intentionally not editable here. */
export interface UpdateCatalogItemRequest {
  name?: string;
  salePriceMinor?: number;
  reorderLevel?: number | null;
  active?: boolean;
  /** Shallow-merged into existing metadata (e.g. edit monthlyBudgetMinor, keep kind). */
  metadata?: Record<string, unknown>;
}

export interface MovementByRefRequest extends StockMovementRequest {
  externalSource: string;
  externalRef: string;
}

export interface StockMovementRequest {
  direction: StockDirection;
  quantity: number;
  amountMinor?: number;
  reason?: string;
  refType?: string;
  refId?: string;
  idempotencyKey?: string;
  /** When true, skip the INSUFFICIENT_STOCK guard so quantity_on_hand may go ≤ 0.
   *  Used by the freelance capping-day overage and the admin allow-negative unlock. */
  allowNegative?: boolean;
}

export interface SaleLineRequest {
  itemId: string;
  quantity: number;
}

export interface CreateSaleRequest {
  lines: SaleLineRequest[];
  refType?: string;
  refId?: string;
  idempotencyKey?: string;
}

export interface CreateSaleResponse {
  movements: StockMovementDTO[];
  totalMinor: number;
}

export interface CreatePartyRequest {
  displayName: string;
  kind?: PartyKind;
  externalRef?: string;
  externalSource?: string;
  metadata?: Record<string, unknown>;
}

export interface AccountDTO {
  id: string;
  partyId: string;
  unit: AccountUnit;
  currencyCode: string | null;
  balanceMinor: number;
  active: boolean;
}

export interface LedgerEntryDTO {
  id: string;
  accountId: string;
  direction: LedgerDirection;
  amountMinor: number;
  balanceAfter: number;
  reason: string | null;
  refType: string | null;
  refId: string | null;
  createdAt: string;
}

export interface CreateAccountRequest {
  partyId: string;
  unit: AccountUnit;
  currencyCode?: string;
  metadata?: Record<string, unknown>;
}

export interface ListAccountsQuery {
  partyId?: string;
  unit?: AccountUnit;
}

export interface AccountMutationRequest {
  amountMinor: number;
  reason?: string;
  refType?: string;
  refId?: string;
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
}

export interface CommercialRequestDTO {
  id: string;
  partyId: string;
  accountId: string | null;
  kind: RequestKind;
  status: RequestStatus;
  payload: Record<string, unknown>;
  reviewNote: string | null;
  reviewedAt: string | null;
  createdAt: string;
}

export interface CreateCommercialRequest {
  partyId: string;
  accountId?: string;
  kind: RequestKind;
  payload: Record<string, unknown>;
}

export interface ReviewCommercialRequest {
  action: "approve" | "reject";
  reviewNote?: string;
}

export interface PriceRuleDTO {
  id: string;
  partyId: string | null;
  kind: PriceRuleKind;
  label: string | null;
  amountMinor: number;
  capMinor: number | null;
  currencyCode: string;
  validFrom: string | null;
  validTo: string | null;
  active: boolean;
}

export interface CreatePriceRuleRequest {
  partyId?: string;
  kind: PriceRuleKind;
  label?: string;
  amountMinor: number;
  capMinor?: number | null;
  currencyCode?: string;
  validFrom?: string;
  validTo?: string;
  metadata?: Record<string, unknown>;
}

export interface ListPriceRulesQuery {
  orgCode?: string;
  partyId?: string;
  orgDefault?: boolean;
}

// ── Profit & Loss (item-centric) ──
export interface PLByItem {
  itemId: string;
  sku: string;
  name: string;
  itemGroup: ItemGroup;
  itemType: ItemType;
  amountMinor: number;
}

export interface PLReport {
  from: string;
  to: string;
  revenueMinor: number; // Σ INCOME item movements
  costMinor: number; // Σ EXPENSE + FIXED_COST item movements
  profitMinor: number; // revenue − cost
  byType: { itemType: ItemType; amountMinor: number }[];
  byItem: PLByItem[];
}

export interface PLReportQuery {
  orgCode?: string;
  from?: string; // YYYY-MM-DD inclusive
  to?: string; // YYYY-MM-DD inclusive
}

// ── Recurring FT/PT salary (SPEC-002) ──
export interface RecurringCostDTO {
  id: string;
  externalRef: string | null; // teacherId (from the FIXED_COST item)
  itemId: string;
  label: string | null;
  amountMinor: number;
  effectiveFrom: string; // "YYYY-MM-DD" (first of month)
  effectiveTo: string | null; // null = open-ended
  active: boolean;
  teacherType: string | null;
}

export interface SetRecurringCostRequest {
  externalRef: string; // teacherId
  label?: string;
  amountMinor: number;
  effectiveFrom: string; // "YYYY-MM"
  teacherType?: "FULL_TIME" | "PART_TIME";
}

export interface MaterializeResult {
  month: string; // "YYYY-MM"
  posted: {
    externalRef: string | null;
    itemId: string;
    amountMinor: number;
    movementId: string;
  }[];
}

export interface MonthStartResult {
  month: string;
  freelanceReset: number; // budgets reset
  salariesPosted: number; // FIXED_COST salaries materialized
}

export type ApiErrorCode =
  | "VALIDATION"
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "UNAUTHORIZED"
  | "CONFLICT"
  | "INSUFFICIENT_STOCK"
  | "INSUFFICIENT_BALANCE";

export interface ApiError {
  error: { code: ApiErrorCode; message: string; details?: unknown };
}
