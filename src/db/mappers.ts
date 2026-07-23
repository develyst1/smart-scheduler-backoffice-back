import type {
  accountLedger,
  accounts,
  boItem,
  boMovement,
  boTagGroup,
  boTagValue,
  catalogItems,
  commercialRequests,
  parties,
  priceRules,
  recurringCosts,
  stockBalances,
  stockMovements,
} from "../db/schema";

// ── REQ-006 backoffice (bo.*) DTOs ──
export function toBoItemDTO(row: typeof boItem.$inferSelect, tagValueIds: string[] = []) {
  return {
    id: row.id,
    name: row.name,
    unit: row.unit,
    direction: row.direction,
    cadence: row.cadence,
    ceilingQty: row.ceilingQty,
    remainingQty: row.remainingQty,
    unitPriceMinor: row.unitPriceMinor,
    ownerRef: row.ownerRef,
    externalSource: row.externalSource,
    active: row.active,
    metadata: row.metadata ?? null,
    // The item's assigned tag values (one per group) — lets the FE prefill the tag editor so an
    // edit doesn't wipe existing tags via the replace-all PUT.
    tagValueIds,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toBoMovementDTO(row: typeof boMovement.$inferSelect) {
  return {
    id: row.id,
    itemId: row.itemId,
    qty: row.qty,
    remainingAfter: row.remainingAfter,
    valueMinor: row.valueMinor,
    reason: row.reason,
    refType: row.refType,
    refId: row.refId,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toBoTagGroupDTO(row: typeof boTagGroup.$inferSelect) {
  return { id: row.id, name: row.name, active: row.active, sortOrder: row.sortOrder };
}

export function toBoTagValueDTO(row: typeof boTagValue.$inferSelect) {
  return {
    id: row.id,
    tagGroupId: row.tagGroupId,
    label: row.label,
    color: row.color,
    active: row.active,
    sortOrder: row.sortOrder,
  };
}

export function toCatalogItemDTO(
  item: typeof catalogItems.$inferSelect,
  balance?: typeof stockBalances.$inferSelect | null,
) {
  return {
    id: item.id,
    sku: item.sku,
    name: item.name,
    unit: item.unit,
    itemGroup: item.itemGroup,
    itemType: item.itemType,
    salePriceMinor: item.salePriceMinor,
    trackStock: item.trackStock,
    reorderLevel: item.reorderLevel,
    externalRef: item.externalRef,
    externalSource: item.externalSource,
    quantityOnHand: balance?.quantityOnHand ?? 0,
    metadata: item.metadata ?? null,
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
    amountMinor: row.amountMinor,
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

export function toRecurringCostDTO(
  rc: typeof recurringCosts.$inferSelect,
  item?: typeof catalogItems.$inferSelect | null,
) {
  return {
    id: rc.id,
    externalRef: item?.externalRef ?? null,
    itemId: rc.itemId,
    label: rc.label,
    amountMinor: rc.amountMinor,
    effectiveFrom: rc.effectiveFrom,
    effectiveTo: rc.effectiveTo,
    active: rc.active,
    teacherType: (rc.metadata?.teacherType as string | undefined) ?? null,
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
