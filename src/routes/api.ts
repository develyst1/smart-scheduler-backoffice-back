import { Hono } from "hono";
import { catalogRoutes, commerceRoutes } from "./catalog";
import { partyRoutes } from "./parties";
import { accountRoutes } from "./accounts";
import { commercialRoutes } from "./commercial";
import { pricingRoutes } from "./pricing";
import { reportRoutes } from "./reports";
import { recurringCostRoutes, internalRoutes } from "./recurring";
import { authRoutes } from "./auth";

/** Versioned public API — resource names are domain-neutral. */
export const v1 = new Hono()
  .route("/auth", authRoutes)
  .route("/catalog/items", catalogRoutes)
  .route("/commerce", commerceRoutes)
  .route("/parties", partyRoutes)
  .route("/accounts", accountRoutes)
  .route("/commercial", commercialRoutes)
  .route("/pricing", pricingRoutes)
  .route("/reports", reportRoutes)
  .route("/recurring-costs", recurringCostRoutes)
  .route("/internal", internalRoutes);

export const api = new Hono().route("/v1", v1);
