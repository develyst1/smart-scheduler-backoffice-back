import { and, desc, eq } from "drizzle-orm";
import { db } from "../db";
import { toAccountDTO, toLedgerEntryDTO } from "../db/mappers";
import { accountLedger, accounts } from "../db/schema";
import { assertPositiveInt } from "../lib/money";
import { badRequest, conflict, notFound } from "../lib/http";
import { getParty } from "./parties.service";
import type {
  AccountMutationRequest,
  CreateAccountRequest,
  ListAccountsQuery,
} from "../types/contract";

async function findLedgerByIdempotency(key: string | undefined) {
  if (!key) return null;
  return db.query.accountLedger.findFirst({
    where: eq(accountLedger.idempotencyKey, key),
  });
}

export async function listAccounts(query: ListAccountsQuery) {
  const conditions = [eq(accounts.active, true)];
  if (query.partyId) conditions.push(eq(accounts.partyId, query.partyId));
  if (query.unit) conditions.push(eq(accounts.unit, query.unit));

  const rows = await db.query.accounts.findMany({
    where: and(...conditions),
    orderBy: (t, { desc: d }) => d(t.updatedAt),
  });
  return rows.map(toAccountDTO);
}

export async function getAccount(id: string) {
  const row = await db.query.accounts.findFirst({ where: eq(accounts.id, id) });
  if (!row) throw notFound("ไม่พบ account");
  return toAccountDTO(row);
}

export async function createAccount(input: CreateAccountRequest) {
  await getParty(input.partyId);

  if (input.unit === "CURRENCY" && !input.currencyCode) {
    throw badRequest("unit CURRENCY ต้องระบุ currencyCode");
  }

  const [row] = await db
    .insert(accounts)
    .values({
      partyId: input.partyId,
      unit: input.unit,
      currencyCode: input.unit === "CURRENCY" ? (input.currencyCode ?? "THB") : null,
      metadata: input.metadata ?? null,
    })
    .returning();
  return toAccountDTO(row);
}

export async function listLedger(accountId: string, limit: number) {
  await getAccount(accountId);
  const rows = await db.query.accountLedger.findMany({
    where: eq(accountLedger.accountId, accountId),
    orderBy: [desc(accountLedger.createdAt)],
    limit,
  });
  return rows.map(toLedgerEntryDTO);
}

async function mutateAccount(
  accountId: string,
  direction: "CREDIT" | "DEBIT",
  input: AccountMutationRequest,
) {
  assertPositiveInt(input.amountMinor, "amountMinor");

  const existing = await findLedgerByIdempotency(input.idempotencyKey);
  if (existing) return toLedgerEntryDTO(existing);

  return await db.transaction(async (tx) => {
    const account = await tx.query.accounts.findFirst({
      where: eq(accounts.id, accountId),
    });
    if (!account) throw notFound("ไม่พบ account");
    if (!account.active) throw badRequest("account ถูกปิดใช้งาน");

    let nextBalance = account.balanceMinor;
    if (direction === "CREDIT") nextBalance += input.amountMinor;
    else {
      if (account.balanceMinor < input.amountMinor) {
        throw conflict("INSUFFICIENT_BALANCE", "ยอดไม่พอ");
      }
      nextBalance -= input.amountMinor;
    }

    await tx
      .update(accounts)
      .set({ balanceMinor: nextBalance })
      .where(eq(accounts.id, accountId));

    const [entry] = await tx
      .insert(accountLedger)
      .values({
        accountId,
        direction,
        amountMinor: input.amountMinor,
        balanceAfter: nextBalance,
        reason: input.reason ?? null,
        refType: input.refType ?? null,
        refId: input.refId ?? null,
        idempotencyKey: input.idempotencyKey ?? null,
        metadata: input.metadata ?? null,
      })
      .returning();

    return toLedgerEntryDTO(entry);
  });
}

export async function creditAccount(accountId: string, input: AccountMutationRequest) {
  return mutateAccount(accountId, "CREDIT", input);
}

export async function debitAccount(accountId: string, input: AccountMutationRequest) {
  return mutateAccount(accountId, "DEBIT", input);
}
