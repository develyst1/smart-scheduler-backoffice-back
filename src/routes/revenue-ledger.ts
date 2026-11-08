import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import * as ledger from "../services/revenue-ledger.service";
import { requirePaymentAccess, requireRevenueAccess } from "../middleware/revenue-access";
import { badRequest } from "../lib/http";
import {
  BRANCHES,
  daysBetween,
  isValidDate,
  LINE_TYPES,
  MAX_RANGE_DAYS,
  METHODS,
  PAYMENT_REF_TYPES,
  REVENUE_TYPES,
} from "../lib/revenue-ledger";

// SPEC-098 §3 — the revenue ledger API, mounted at /api/v1/revenue.
// 🔐 EVERY route goes through `requireRevenueAccess` (§1.6) — reads included.
//
// Validators live here, not in `validation.ts` (outside TASK-858's closed list). They follow its style, but a failure
// is thrown as the app's own 400 `VALIDATION` body (SPEC §3) rather than zValidator's default shape.
const zv = <T extends "json" | "query" | "param", S extends z.ZodType>(target: T, schema: S) =>
  zValidator(target, schema, (result) => {
    if (!result.success) {
      const issue = result.error.issues[0];
      throw badRequest(`${issue?.path.join(".") || target}: ${issue?.message ?? "invalid"}`, result.error.issues);
    }
  });

const date = z.string().refine(isValidDate, "must be a real date, YYYY-MM-DD");
const typeEnum = z.enum(REVENUE_TYPES);

const categoriesQuery = z.object({
  type: typeEnum.optional(),
  includeInactive: z.enum(["true", "false"]).optional(),
});

const createCategoryBody = z.object({
  type: typeEnum, // REFUND is not in REVENUE_TYPES, so it is rejected here
  name: z.string().trim().min(1).max(60),
});

const createLineBody = z.object({
  occurredOn: date,
  branch: z.enum(BRANCHES),
  type: typeEnum, // a manual line is never a REFUND (§3)
  categoryId: z.string().uuid(),
  productName: z.string().trim().max(120).optional(),
  amountMinor: z.number().int().positive(),
  method: z.enum(METHODS),
  remark: z.string().trim().max(500).optional(),
});

const listLinesQuery = z
  .object({
    from: date,
    to: date,
    branch: z.enum(BRANCHES).optional(),
    type: z.enum(LINE_TYPES).optional(),
    categoryId: z.string().uuid().optional(),
  })
  .superRefine((q, ctx) => {
    const span = daysBetween(q.from, q.to);
    if (span < 0) ctx.addIssue({ code: "custom", path: ["from"], message: "from must not be after to" });
    else if (span > MAX_RANGE_DAYS)
      ctx.addIssue({ code: "custom", path: ["to"], message: `range must be at most ${MAX_RANGE_DAYS} days` });
  });

const summaryQuery = z.object({ date, branch: z.enum(BRANCHES).optional() });

// ── SPEC-099 §8 / TASK-874 — the F2 payment record. Slice 2a: COURSE and VOUCHER only. ──
const paymentRefQuery = z.object({ refType: z.enum(PAYMENT_REF_TYPES), refId: z.string().uuid() });
const createPaymentBody = z.object({
  refType: z.enum(PAYMENT_REF_TYPES),
  refId: z.string().uuid(),
  paidOn: date,
  amountMinor: z.number().int().positive(),
  method: z.enum(METHODS),
});
const patchPaymentBody = z
  .object({
    method: z.enum(METHODS).optional(),
    paidOn: date.optional(),
    // Every row's amount is editable since §8.9 (row 1 included); the service enforces sum(rows) <= the fee.
    amountMinor: z.number().int().positive().optional(),
  })
  .refine((b) => b.method !== undefined || b.paidOn !== undefined || b.amountMinor !== undefined, { message: "send at least one of method, paidOn, amountMinor" });
const paymentIdParam = z.object({ id: z.string().uuid() });

export const revenueLedgerRoutes = new Hono()
  .get("/categories", requireRevenueAccess, zv("query", categoriesQuery), async (c) => {
    const q = c.req.valid("query");
    return c.json({
      categories: await ledger.listCategories({ type: q.type, includeInactive: q.includeInactive === "true" }),
    });
  })
  .post("/categories", requireRevenueAccess, zv("json", createCategoryBody), async (c) =>
    c.json({ category: await ledger.createCategory(c.req.valid("json")) }, 201),
  )
  .post("/lines", requireRevenueAccess, zv("json", createLineBody), async (c) => {
    // `actor` = the JWT subject when there is one (SKIP_ADMIN_AUTH without a token sets the dev user, never null).
    const actor = c.get("user")?.sub ?? null;
    return c.json({ line: await ledger.createManualLine(c.req.valid("json"), actor) }, 201);
  })
  .get("/lines", requireRevenueAccess, zv("query", listLinesQuery), async (c) =>
    c.json(await ledger.listLines(c.req.valid("query"))),
  )
  .get("/summary", requireRevenueAccess, zv("query", summaryQuery), async (c) => {
    const q = c.req.valid("query");
    return c.json(await ledger.summary(q.date, q.branch));
  })
  // ── the F2 payment record: ceo OR admin (`requirePaymentAccess`); payment rows only, never a revenue figure (R0.2) ──
  .get("/payments", requirePaymentAccess, zv("query", paymentRefQuery), async (c) => {
    const q = c.req.valid("query");
    return c.json(await ledger.listPayments(q.refType, q.refId));
  })
  .post("/payments", requirePaymentAccess, zv("json", createPaymentBody), async (c) => {
    // `actor` = the JWT subject (SPEC-099 §8.5); under SKIP_ADMIN_AUTH the dev user.
    const actor = c.get("user")?.sub ?? null;
    return c.json({ payment: await ledger.createPayment(c.req.valid("json"), actor) }, 201);
  })
  .patch("/payments/:id", requirePaymentAccess, zv("param", paymentIdParam), zv("json", patchPaymentBody), async (c) => {
    const actor = c.get("user")?.sub ?? null;
    return c.json({ payment: await ledger.updatePayment(c.req.valid("param").id, c.req.valid("json"), actor) });
  });
