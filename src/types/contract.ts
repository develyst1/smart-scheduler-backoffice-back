// Generic Operations API contract — domain-neutral DTOs for any consumer app.

export type StockDirection = "IN" | "OUT" | "ADJUST";
export type AccountUnit = "HOURS" | "CURRENCY" | "POINTS";
export type PartyKind = "PERSON" | "ORGANIZATION";
export type LedgerDirection = "CREDIT" | "DEBIT";
export type RequestKind = "TOP_UP" | "PURCHASE" | "ADJUSTMENT";
export type RequestStatus = "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED";
export type PriceRuleKind = "HOURLY" | "FIXED" | "PERCENTAGE" | "CAP";

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
  salePriceMinor: number;
  trackStock: boolean;
  reorderLevel: number | null;
  quantityOnHand: number;
  active: boolean;
}

export interface StockMovementDTO {
  id: string;
  itemId: string;
  direction: StockDirection;
  quantity: number;
  quantityAfter: number;
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
  salePriceMinor?: number;
  trackStock?: boolean;
  reorderLevel?: number | null;
}

export interface StockMovementRequest {
  direction: StockDirection;
  quantity: number;
  reason?: string;
  refType?: string;
  refId?: string;
  idempotencyKey?: string;
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
