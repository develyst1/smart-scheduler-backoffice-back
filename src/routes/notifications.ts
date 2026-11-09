// /api/v1/notifications - the in-web notifications (TASK-917, REQ-120 R0.4). Matches the front's 914 seam (`services/notification.service.ts`), so each swap is one file.
//
//   GET  /notifications                → [{ id, type, text, date, read }]   the CALLER's OWN items, newest first (ceo + admin; a coach gets [])   no money in any text
//   POST /notifications/:id/read       → 204 · 404 for an unknown id OR someone else's (never revealed)
//   POST /notifications/read-all       → { marked }                         the caller's own unread items
//   GET  /notifications/recipients     → [{ who, role, gets[] }]            «CEO and Staff» (CEO ONLY): who is told about what, ROLE-DERIVED and READ-ONLY (ruling C-h: no opt-out, no write route exists)
//   GET  /notifications/coaches        → [{ who, type }]                    «Coach (Full-time / Part-time)» (CEO ONLY)
// The producers write through `createNotification` / `recipientsForType` (services/notification.service.ts), not through HTTP.
import { Hono } from "hono";
import { adminAuth, requireRole } from "../middleware/auth";
import { badRequest } from "../lib/http";
import { notificationService } from "../services/notification.service";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const subOf = (c: { get: (k: "user") => unknown }): string => String((c.get("user") as { sub?: string } | undefined)?.sub ?? "");

export const notificationRoutes = new Hono()
  .get("/", requireRole("ceo", "admin", "coach"), async (c) => {
    const role = (c.get("user") as { role?: string }).role;
    return c.json(role === "coach" ? [] : await notificationService.feed(subOf(c))); // a coach is told of their own items elsewhere; this feed is the staff's
  })
  .post("/read-all", adminAuth, async (c) => c.json(await notificationService.markAll(subOf(c))))
  .post("/:id/read", adminAuth, async (c) => {
    const id = c.req.param("id") ?? "";
    if (!UUID.test(id)) throw badRequest("id ไม่ถูกต้อง");
    await notificationService.markRead(subOf(c), id);
    return c.body(null, 204);
  })
  .get("/recipients", requireRole("ceo"), async (c) => c.json(await notificationService.recipients()))
  .get("/coaches", requireRole("ceo"), async (c) => c.json(await notificationService.coaches()));
