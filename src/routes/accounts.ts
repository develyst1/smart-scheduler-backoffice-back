import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import * as v from "../validation";
import * as svc from "../services/accounts.service";
import { adminAuth, serviceAuth } from "../middleware/auth";

export const accountRoutes = new Hono()
  .get("/", zValidator("query", v.listAccountsQuery), async (c) => {
    const q = c.req.valid("query");
    return c.json({ items: await svc.listAccounts(q) });
  })
  .post("/", adminAuth, zValidator("json", v.createAccount), async (c) => {
    return c.json(await svc.createAccount(c.req.valid("json")), 201);
  })
  .get("/:id", async (c) => c.json(await svc.getAccount(c.req.param("id"))))
  .get("/:id/ledger", zValidator("query", v.listLedgerQuery), async (c) => {
    const { limit } = c.req.valid("query");
    return c.json({
      items: await svc.listLedger(c.req.param("id"), limit),
    });
  })
  .post(
    "/:id/credits",
    adminAuth,
    zValidator("json", v.accountMutation),
    async (c) => {
      return c.json(await svc.creditAccount(c.req.param("id"), c.req.valid("json")), 201);
    },
  )
  .post(
    "/:id/debits",
    serviceAuth,
    zValidator("json", v.accountMutation),
    async (c) => {
      return c.json(await svc.debitAccount(c.req.param("id"), c.req.valid("json")), 201);
    },
  );
