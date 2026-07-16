import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../db";
import { toPriceRuleDTO } from "../db/mappers";
import { parties, priceRules } from "../db/schema";
import { notFound } from "../lib/http";
import { resolveOrganization } from "./inventory.service";
import type { CreatePriceRuleRequest, ListPriceRulesQuery } from "../types/contract";

const SCHEDULING_SOURCE = "smart-scheduler";

/**
 * Rate + income ceiling per scheduling teacher, in one call (UC-016). Resolves the
 * 2-hop party→rules lookup and the metadata disambiguation server-side so the
 * scheduling API can enrich its TeacherDTO with real numbers instead of a mock.
 * Baht (not minor units) since the scheduling/front side works in baht.
 *
 *  - hourlyRate  = the PRIVATE HOURLY rule (weekday exception excluded)
 *  - incomeLimit = the CAP rule tagged purpose=INCOME_CAP
 *
 * Only teachers that carry at least one of the two are returned (today: FREELANCE).
 */
export async function getTeacherRates(orgCode?: string) {
  const org = await resolveOrganization(orgCode);
  const partyRows = await db.query.parties.findMany({
    where: and(
      eq(parties.organizationId, org.id),
      eq(parties.externalSource, SCHEDULING_SOURCE),
      eq(parties.active, true),
    ),
  });
  if (!partyRows.length) return [];

  const partyIds = partyRows.map((p) => p.id);
  const ruleRows = await db.query.priceRules.findMany({
    where: and(inArray(priceRules.partyId, partyIds), eq(priceRules.active, true)),
  });

  const rulesByParty = new Map<string, typeof ruleRows>();
  for (const r of ruleRows) {
    if (!r.partyId) continue;
    const list = rulesByParty.get(r.partyId) ?? [];
    list.push(r);
    rulesByParty.set(r.partyId, list);
  }

  const toBaht = (minor: number | null | undefined) =>
    typeof minor === "number" ? minor / 100 : null;

  return partyRows
    .map((p) => {
      const rules = rulesByParty.get(p.id) ?? [];
      const meta = (r: (typeof rules)[number]) => (r.metadata ?? {}) as Record<string, unknown>;
      const hourly = rules.find(
        (r) => r.kind === "HOURLY" && meta(r).teachingMode === "PRIVATE" && !meta(r).weekdaysOnly,
      );
      const cap = rules.find((r) => r.kind === "CAP" && meta(r).purpose === "INCOME_CAP");
      return {
        externalRef: p.externalRef, // = scheduling teacher id
        partyId: p.id,
        hourlyRate: toBaht(hourly?.amountMinor),
        incomeLimit: toBaht(cap?.amountMinor),
      };
    })
    .filter((r) => r.externalRef && (r.hourlyRate !== null || r.incomeLimit !== null));
}

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
