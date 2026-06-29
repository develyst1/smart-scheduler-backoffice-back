import { Hono } from "hono";
import { cors } from "hono/cors";
import { sql } from "drizzle-orm";
import { db } from "./db";
import { api } from "./routes/api";
import { ApiException, pgErrorCode } from "./lib/http";

const app = new Hono();

app.use("*", cors());

app.get("/health", async (c) => {
  const r = await db.execute(sql`select 1 as ok`);
  return c.json({
    ok: true,
    service: "operations-api",
    db: r[0]?.ok === 1,
  });
});

const routes = app.route("/api", api);

app.onError((err, c) => {
  if (err instanceof ApiException) {
    return c.json(
      { error: { code: err.code, message: err.message, details: err.details } },
      err.status as 400 | 401 | 403 | 404 | 409 | 500,
    );
  }
  const code = pgErrorCode(err);
  if (code === "23505") {
    return c.json({ error: { code: "CONFLICT", message: "ข้อมูลซ้ำ" } }, 409);
  }
  if (code === "23503") {
    return c.json({ error: { code: "VALIDATION", message: "ข้อมูลอ้างอิงไม่ถูกต้อง" } }, 400);
  }
  console.error(err);
  return c.json({ error: { code: "INTERNAL", message: "เกิดข้อผิดพลาดภายในระบบ" } }, 500);
});

export type AppType = typeof routes;

export default {
  port: Number(process.env.PORT ?? 3002),
  fetch: app.fetch,
};
