import { Hono } from "hono";
import { authRoutes } from "./auth";
import { boRoutes } from "./bo";

/**
 * Versioned API. REQ-006 rebuild (TASK-027): the backoffice now serves ONLY the universal `bo` model +
 * auth. The old `ops.*` routes are **retired** — backoffice-back runs on the shared `smart_scheduler` DB
 * where no `ops.*` tables exist, so those routes would 500. Their route/service files stay dormant
 * (unimported) and get deleted in a later cleanup.
 */
export const v1 = new Hono().route("/auth", authRoutes).route("/bo", boRoutes);

export const api = new Hono().route("/v1", v1);
