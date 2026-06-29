import type {
  accountLedger,
  accounts,
  catalogItems,
  commercialRequests,
  parties,
  priceRules,
  stockBalances,
  stockMovements,
} from "../db/schema";

export function toCatalogItemDTO(
  item: typeof catalogItems.$inferSelect,
  balance?: typeof stockBalances.$inferSelect | null,
) {
  return {
    id: item.id,
    sku: item.sku,
    name: item.name,
    unit: item.unit,
    salePriceMinor: item.salePriceMinor,
    trackStock: item.trackStock,
    reorderLevel: item.reorderLevel,
    quantityOnHand: balance?.quantityOnHand ?? 0,
    active: item.active,
  };
}

export function toStockMovementDTO(row: typeof stockMovements.$inferSelect) {
  return {
    id: row.id,
    itemId: row.itemId,
    direction: row.direction,
    quantity: row.quantity,
    quantityAfter: row.quantityAfter,
    reason: row.reason,
    refType: row.refType,
    refId: row.refId,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toPartyDTO(row: typeof parties.$inferSelect) {
  return {
    id: row.id,
    displayName: row.displayName,
    kind: row.kind,
    externalRef: row.externalRef,
    externalSource: row.externalSource,
    active: row.active,
  };
}

export function toAccountDTO(row: typeof accounts.$inferSelect) {
  return {
    id: row.id,
    partyId: row.partyId,
    unit: row.unit,
    currencyCode: row.currencyCode,
    balanceMinor: row.balanceMinor,
    active: row.active,
  };
}

export function toLedgerEntryDTO(row: typeof accountLedger.$inferSelect) {
  return {
    id: row.id,
    accountId: row.accountId,
    direction: row.direction,
    amountMinor: row.amountMinor,
    balanceAfter: row.balanceAfter,
    reason: row.reason,
    refType: row.refType,
    refId: row.refId,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toCommercialRequestDTO(row: typeof commercialRequests.$inferSelect) {
  return {
    id: row.id,
    partyId: row.partyId,
    accountId: row.accountId,
    kind: row.kind,
    status: row.status,
    payload: row.payload,
    reviewNote: row.reviewNote,
    reviewedAt: row.reviewedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toPriceRuleDTO(row: typeof priceRules.$inferSelect) {
  return {
    id: row.id,
    partyId: row.partyId,
    kind: row.kind,
    label: row.label,
    amountMinor: row.amountMinor,
    capMinor: row.capMinor,
    currencyCode: row.currencyCode ?? "THB",
    validFrom: row.validFrom?.toISOString() ?? null,
    validTo: row.validTo?.toISOString() ?? null,
    active: row.active,
  };
}
