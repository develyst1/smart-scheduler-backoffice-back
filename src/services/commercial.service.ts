import { desc, eq } from "drizzle-orm";
import { db } from "../db";
import { toCommercialRequestDTO } from "../db/mappers";
import { commercialRequests } from "../db/schema";
import { badRequest, notFound } from "../lib/http";
import { creditAccount } from "./accounts.service";
import { getParty } from "./parties.service";
import type { CreateCommercialRequest, ReviewCommercialRequest, RequestStatus } from "../types/contract";

function topUpAmount(payload: Record<string, unknown>): number | null {
  const raw = payload.amountMinor ?? payload.hours;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0) return null;
  return raw;
}

export async function listCommercialRequests(status?: RequestStatus) {
  const rows = await db.query.commercialRequests.findMany({
    where: status ? eq(commercialRequests.status, status) : undefined,
    orderBy: [desc(commercialRequests.createdAt)],
    limit: 100,
  });
  return rows.map(toCommercialRequestDTO);
}

export async function createCommercialRequest(input: CreateCommercialRequest) {
  await getParty(input.partyId);
  if (input.accountId) {
    // validates account exists via FK on insert
  }

  const [row] = await db
    .insert(commercialRequests)
    .values({
      partyId: input.partyId,
      accountId: input.accountId ?? null,
      kind: input.kind,
      payload: input.payload,
    })
    .returning();
  return toCommercialRequestDTO(row);
}

export async function getCommercialRequest(id: string) {
  const row = await db.query.commercialRequests.findFirst({
    where: eq(commercialRequests.id, id),
  });
  if (!row) throw notFound("ไม่พบคำขอ");
  return toCommercialRequestDTO(row);
}

export async function reviewCommercialRequest(id: string, input: ReviewCommercialRequest) {
  const row = await getCommercialRequest(id);
  if (row.status !== "PENDING") {
    throw badRequest("คำขอนี้ถูกดำเนินการแล้ว");
  }

  if (input.action === "reject") {
    const [updated] = await db
      .update(commercialRequests)
      .set({
        status: "REJECTED",
        reviewNote: input.reviewNote ?? null,
        reviewedAt: new Date(),
      })
      .where(eq(commercialRequests.id, id))
      .returning();
    return toCommercialRequestDTO(updated);
  }

  return await db.transaction(async (tx) => {
    const current = await tx.query.commercialRequests.findFirst({
      where: eq(commercialRequests.id, id),
    });
    if (!current || current.status !== "PENDING") {
      throw badRequest("คำขอนี้ถูกดำเนินการแล้ว");
    }

    if (current.kind === "TOP_UP" && current.accountId) {
      const amount = topUpAmount(current.payload);
      if (!amount) throw badRequest("payload ต้องมี amountMinor หรือ hours (integer > 0)");
      await creditAccount(current.accountId, {
        amountMinor: amount,
        reason: "commercial request approved",
        refType: "COMMERCIAL_REQUEST",
        refId: id,
        idempotencyKey: `commercial:${id}:credit`,
      });
    }

    const [updated] = await tx
      .update(commercialRequests)
      .set({
        status: "APPROVED",
        reviewNote: input.reviewNote ?? null,
        reviewedAt: new Date(),
      })
      .where(eq(commercialRequests.id, id))
      .returning();

    return toCommercialRequestDTO(updated);
  });
}
