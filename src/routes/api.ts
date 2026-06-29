import { Hono } from "hono";
import { catalogRoutes, commerceRoutes } from "./catalog";
import { partyRoutes } from "./parties";
import { accountRoutes } from "./accounts";
import { commercialRoutes } from "./commercial";
import { pricingRoutes } from "./pricing";

/** Versioned public API — resource names are domain-neutral. */
export const v1 = new Hono()
  .route("/catalog/items", catalogRoutes)
  .route("/commerce", commerceRoutes)
  .route("/parties", partyRoutes)
  .route("/accounts", accountRoutes)
  .route("/commercial", commercialRoutes)
  .route("/pricing", pricingRoutes);

export const api = new Hono().route("/v1", v1);
