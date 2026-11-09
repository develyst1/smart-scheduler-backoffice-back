// TASK-909 (DECISIONS row 21) — the Stock OUT sale line's revenue writer. Sector specified it for `revenue-ledger.service.ts`; it lives in its OWN file because the revenue test files replace that
// whole module with a fake (bun's mock.module), which would hide this export from every later test file. Same function, same signature; `revenue-ledger.service.ts` is untouched.
import { eq } from "drizzle-orm";
import { boRevenueCategory, boRevenueLine } from "../db/schema-revenue";
import { ApiException } from "../lib/http";

/**
 * 🔻 TASK-909 (DECISIONS row 21) — ONE revenue line per Stock OUT sale line, written INSIDE the sale's transaction (`d` is that tx: REQUIRED, no default, so it can never run outside a sale).
 * The line's `type` is its category's `type` (a drink lands under FNB with no mapping table); the amount is the line NET (qty × unit − discount; commission is pay, never netted here);
 * `source STOCK` · `refType SALE_LINE` · `refId` = the sale line · key `rl:sale-line:<saleLineId>` (a replayed sale never doubles). A net ≤ 0 writes nothing (the sign CHECK needs > 0).
 * THROWS on any DB error — there is no `ok:false` here: a failed revenue line rolls the sale back, so a sale is never recorded without its revenue and never the reverse.
 */
export async function postSaleLineRevenue(
  d: any,
  input: {
    saleLineId: string;
    soldOn: string; // bangkokDate(sale.soldAt), YYYY-MM-DD
    branch: "BRAVO" | "OTHER";
    method: "TRANSFER" | "CASH" | "CARD";
    categoryId: string; // bo.item.revenue_category_id
    productName: string; // bo.item.name
    amountMinor: number; // qty × unitPriceMinor − discountMinor
    actor: string | null;
  },
): Promise<{ written: boolean }> {
  if (input.amountMinor <= 0) return { written: false };
  const [cat] = await d.select().from(boRevenueCategory).where(eq(boRevenueCategory.id, input.categoryId)).limit(1);
  if (!cat || !cat.active || cat.type === "REFUND") throw new ApiException(400, "NO_REVENUE_CATEGORY", "หมวดรายได้ของสินค้าไม่ถูกต้องหรือถูกปิดใช้งาน", { categoryId: input.categoryId });
  const inserted = await d
    .insert(boRevenueLine)
    .values({
      occurredOn: input.soldOn,
      branch: input.branch,
      type: cat.type,
      categoryId: cat.id,
      productName: input.productName,
      amountMinor: input.amountMinor,
      method: input.method,
      remark: null,
      source: "STOCK",
      refType: "SALE_LINE",
      refId: input.saleLineId,
      idempotencyKey: `rl:sale-line:${input.saleLineId}`,
      actor: input.actor,
    })
    .onConflictDoNothing({ target: boRevenueLine.idempotencyKey })
    .returning({ id: boRevenueLine.id });
  return { written: inserted.length > 0 };
}
