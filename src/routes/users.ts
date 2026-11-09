// /api/v1/users - back-office user management (TASK-930, REQ-120 R0.1, SPEC-097 §3). CEO ONLY on every route.
//   GET  /users                  → [{ id, username, role, teacherId, active, admitted, createdAt }]   never a hash or password
//   POST /users                  → 201 the admitted user: { username, role: "admin"|"coach", teacherId? } for someone who ALREADY exists in the front office (404 if not, 409 if admitted, 400 for role ceo)
//   POST /users/:id/deactivate   → the user (soft: active=false, never a delete; the CEO row is refused)
//   POST /users/:id/reactivate   → the user
// There is NO password route: the password is the front office's (same login), so a reset is a front-office action.
import { Hono } from "hono";
import { requireRole } from "../middleware/auth";
import { badRequest } from "../lib/http";
import { admit, deactivate, listUsers, reactivate, type UsersStore } from "../services/bo-user-admin.service";

/** `store` is injectable so the routes are testable without a database. */
export function makeUserRoutes(store?: UsersStore) {
  return new Hono()
    .get("/", requireRole("ceo"), async (c) => c.json(await listUsers(store)))
    .post("/", requireRole("ceo"), async (c) => {
      const body = await c.req.json().catch(() => null);
      if (!body || typeof body !== "object" || Array.isArray(body)) throw badRequest("ข้อมูลไม่ถูกต้อง");
      return c.json(await admit(body as Record<string, unknown>, store), 201);
    })
    .post("/:id/deactivate", requireRole("ceo"), async (c) => c.json(await deactivate(c.req.param("id") ?? "", store)))
    .post("/:id/reactivate", requireRole("ceo"), async (c) => c.json(await reactivate(c.req.param("id") ?? "", store)));
}

export const userRoutes = makeUserRoutes();
