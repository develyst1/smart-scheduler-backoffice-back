import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { toPartyDTO } from "../db/mappers";
import { parties } from "../db/schema";
import { notFound } from "../lib/http";
import { resolveOrganization } from "./inventory.service";
import type { CreatePartyRequest } from "../types/contract";

export async function listParties(filters: {
  orgCode?: string;
  externalSource?: string;
  externalRef?: string;
}) {
  const org = await resolveOrganization(filters.orgCode);
  const conditions = [eq(parties.organizationId, org.id), eq(parties.active, true)];

  if (filters.externalSource) {
    conditions.push(eq(parties.externalSource, filters.externalSource));
  }
  if (filters.externalRef) {
    conditions.push(eq(parties.externalRef, filters.externalRef));
  }

  const rows = await db.query.parties.findMany({
    where: and(...conditions),
    orderBy: (t, { asc }) => asc(t.displayName),
  });
  return rows.map(toPartyDTO);
}

export async function createParty(input: CreatePartyRequest, orgCode?: string) {
  const org = await resolveOrganization(orgCode);
  const [row] = await db
    .insert(parties)
    .values({
      organizationId: org.id,
      displayName: input.displayName,
      kind: input.kind ?? "PERSON",
      externalRef: input.externalRef ?? null,
      externalSource: input.externalSource ?? null,
      metadata: input.metadata ?? null,
    })
    .returning();
  return toPartyDTO(row);
}

export async function getParty(id: string) {
  const row = await db.query.parties.findFirst({ where: eq(parties.id, id) });
  if (!row) throw notFound("ไม่พบ party");
  return toPartyDTO(row);
}

export async function findPartyByExternal(
  externalSource: string,
  externalRef: string,
  orgCode?: string,
) {
  const org = await resolveOrganization(orgCode);
  const row = await db.query.parties.findFirst({
    where: and(
      eq(parties.organizationId, org.id),
      eq(parties.externalSource, externalSource),
      eq(parties.externalRef, externalRef),
    ),
  });
  return row ? toPartyDTO(row) : null;
}
