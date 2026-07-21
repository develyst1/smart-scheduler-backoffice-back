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

const SCHEDULING_SOURCE = "smart-scheduler";

/** Teacher-sync onboard (TASK-015): upsert the scheduling teacher's ops party by ref — create if
 *  missing, else reactivate + refresh the name. Idempotent (guards the missing unique constraint). */
export async function upsertPartyByExternal(
  externalRef: string,
  displayName: string,
  orgCode?: string,
) {
  const org = await resolveOrganization(orgCode);
  const existing = await db.query.parties.findFirst({
    where: and(
      eq(parties.organizationId, org.id),
      eq(parties.externalSource, SCHEDULING_SOURCE),
      eq(parties.externalRef, externalRef),
    ),
  });
  if (existing) {
    const [row] = await db
      .update(parties)
      .set({ displayName, active: true })
      .where(eq(parties.id, existing.id))
      .returning();
    return toPartyDTO(row);
  }
  const [row] = await db
    .insert(parties)
    .values({
      organizationId: org.id,
      displayName,
      kind: "PERSON",
      externalSource: SCHEDULING_SOURCE,
      externalRef,
      active: true,
    })
    .returning();
  return toPartyDTO(row);
}

/** Update a teacher's ops party name/active by ref. Returns null if no party exists (the caller
 *  decides 404 for edit vs no-op for offboard). */
export async function updatePartyByExternal(
  externalRef: string,
  patch: { displayName?: string; active?: boolean },
  orgCode?: string,
) {
  const org = await resolveOrganization(orgCode);
  const existing = await db.query.parties.findFirst({
    where: and(
      eq(parties.organizationId, org.id),
      eq(parties.externalSource, SCHEDULING_SOURCE),
      eq(parties.externalRef, externalRef),
    ),
  });
  if (!existing) return null;

  const set: { displayName?: string; active?: boolean } = {};
  if (patch.displayName !== undefined) set.displayName = patch.displayName;
  if (patch.active !== undefined) set.active = patch.active;
  if (Object.keys(set).length === 0) return toPartyDTO(existing);

  const [row] = await db.update(parties).set(set).where(eq(parties.id, existing.id)).returning();
  return toPartyDTO(row);
}
