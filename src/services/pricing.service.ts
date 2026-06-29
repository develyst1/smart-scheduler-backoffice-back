import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "../db";
import { toPriceRuleDTO } from "../db/mappers";
import { priceRules } from "../db/schema";
import { notFound } from "../lib/http";
import { resolveOrganization } from "./inventory.service";
import type { CreatePriceRuleRequest, ListPriceRulesQuery } from "../types/contract";

export async function listPriceRules(query: ListPriceRulesQuery) {
  const org = await resolveOrganization(query.orgCode);
  const conditions = [eq(priceRules.active, true)];

  if (query.partyId) {
    conditions.push(eq(priceRules.partyId, query.partyId));
  } else if (query.orgDefault) {
    conditions.push(eq(priceRules.organizationId, org.id));
    conditions.push(isNull(priceRules.partyId));
  }

  const rows = await db.query.priceRules.findMany({
    where: and(...conditions),
    orderBy: [desc(priceRules.validFrom)],
  });
  return rows.map(toPriceRuleDTO);
}

export async function createPriceRule(input: CreatePriceRuleRequest, orgCode?: string) {
  const org = await resolveOrganization(orgCode);
  const [row] = await db
    .insert(priceRules)
    .values({
      organizationId: org.id,
      partyId: input.partyId ?? null,
      kind: input.kind,
      label: input.label ?? null,
      amountMinor: input.amountMinor,
      capMinor: input.capMinor ?? null,
      currencyCode: input.currencyCode ?? "THB",
      validFrom: input.validFrom ? new Date(input.validFrom) : null,
      validTo: input.validTo ? new Date(input.validTo) : null,
      metadata: input.metadata ?? null,
    })
    .returning();
  return toPriceRuleDTO(row);
}

export async function getPriceRule(id: string) {
  const row = await db.query.priceRules.findFirst({ where: eq(priceRules.id, id) });
  if (!row) throw notFound("ไม่พบ price rule");
  return toPriceRuleDTO(row);
}
