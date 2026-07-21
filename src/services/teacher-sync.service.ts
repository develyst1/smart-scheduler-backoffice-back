// SPEC-004 / TASK-015: machine-callable (serviceAuth) teacher-sync bridge for scheduling.
// Encapsulates the cross-system writes that the admin-only create endpoints don't expose to a
// service token: party upsert/update/deactivate + money-close (deactivate FL budget item, terminate
// open salary row). The admin still CREATES money later via the admin UI — this bridge only creates/
// deactivates the party and CLOSES old money on type-change/offboard. Every call is idempotent.

import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { catalogItems } from "../db/schema";
import { notFound } from "../lib/http";
import { prevMonthFirstDay } from "../lib/month";
import {
  resolveOrganization,
  updateCatalogItem,
} from "./inventory.service";
import { upsertPartyByExternal, updatePartyByExternal } from "./parties.service";
import { terminateRecurring } from "./recurring.service";

const SCHEDULING_SOURCE = "smart-scheduler";

/** Deactivate the teacher's active FREELANCE_BUDGET item (if any). Idempotent → false if none active. */
async function deactivateFreelanceBudget(orgId: string, externalRef: string): Promise<boolean> {
  const item = await db.query.catalogItems.findFirst({
    where: and(
      eq(catalogItems.organizationId, orgId),
      eq(catalogItems.externalSource, SCHEDULING_SOURCE),
      eq(catalogItems.externalRef, externalRef),
      eq(catalogItems.itemType, "EXPENSE"),
      eq(catalogItems.active, true),
      sql`${catalogItems.metadata}->>'kind' = 'FREELANCE_BUDGET'`,
    ),
  });
  if (!item) return false;
  await updateCatalogItem(item.id, { active: false });
  return true;
}

export async function syncOnboard(externalRef: string, displayName: string, orgCode?: string) {
  return { party: await upsertPartyByExternal(externalRef, displayName, orgCode) };
}

export async function syncUpdate(
  externalRef: string,
  patch: { displayName?: string; active?: boolean },
  orgCode?: string,
) {
  const party = await updatePartyByExternal(externalRef, patch, orgCode);
  if (!party) throw notFound("ไม่พบ party สำหรับครูนี้ — onboard ก่อน");
  return { party };
}

/** Offboard: party inactive + close ALL money (deactivate FL budget + terminate open salary). */
export async function syncOffboard(externalRef: string, effectiveMonth: string, orgCode?: string) {
  const org = await resolveOrganization(orgCode);
  const effectiveTo = prevMonthFirstDay(effectiveMonth);
  const partyDeactivated = !!(await updatePartyByExternal(externalRef, { active: false }, orgCode));
  const budgetDeactivated = await deactivateFreelanceBudget(org.id, externalRef);
  const salaryTerminated = await terminateRecurring(externalRef, effectiveTo, orgCode);
  return { externalRef, partyDeactivated, budgetDeactivated, salaryTerminated };
}

/** Change type: close OLD money only (FL budget + salary), leave the party active. New money set later. */
export async function syncSwitchType(externalRef: string, effectiveMonth: string, orgCode?: string) {
  const org = await resolveOrganization(orgCode);
  const effectiveTo = prevMonthFirstDay(effectiveMonth);
  const budgetDeactivated = await deactivateFreelanceBudget(org.id, externalRef);
  const salaryTerminated = await terminateRecurring(externalRef, effectiveTo, orgCode);
  return { externalRef, budgetDeactivated, salaryTerminated };
}
