/**
 * Demo seed for the thin-slip pay run (SPEC-100 §7 / TASK-865) — Team A. ADDITIVE + IDEMPOTENT, no truncate/reset:
 *   - a `bo.salary_profile` (FT + a demo base) for up to 4 EXISTING active full-time coaches, read READ-ONLY from
 *     `public.teachers` (never written); an existing profile (e.g. a base the CEO already set) is left exactly as it is;
 *   - the `open` pay period of the current month (Asia/Bangkok), if it does not exist yet. The CEO presses "Run" in the UI.
 * If `public.teachers` has no full-time coach, it uses 4 clearly-demo uuids (`d0d0d0d0-…`).
 *
 *   bun run db:seed-salary-demo
 *
 * ⛔ NOT to be run on sid without the SA's word, and then only after the HOST-ONLY check (the DATABASE_URL host must be
 *    154.197.124.206 = sid — F-038). Writing this script is part of TASK-865; running it is a separate gated step.
 */
import { sql } from "drizzle-orm";
import { db, queryClient } from "./index";
import { boPayPeriod, boSalaryProfile } from "./schema";
import { numericFromSatang } from "../lib/satang";
import { defaultLockAt } from "../services/salary.service";

const DEMO_BASES_SATANG = [2_500_000, 2_200_000, 2_000_000, 1_800_000]; // 25,000 / 22,000 / 20,000 / 18,000 ฿

const found = await db.execute(sql`
  select id::text as id from public.teachers
  where type::text = 'FULL_TIME' and active and not archived and not is_system
  order by name limit 4`);
const ids: string[] = found.length
  ? found.map((r) => String(r.id))
  : [1, 2, 3, 4].map((n) => `d0d0d0d0-0000-4000-8000-00000000000${n}`);
console.log(found.length ? `read ${found.length} full-time coach id(s) from public.teachers (read-only)` : "no full-time coach in public.teachers — using demo uuids");

let created = 0;
for (const [i, teacherId] of ids.entries()) {
  const r = await db
    .insert(boSalaryProfile)
    .values({ teacherId, employmentType: "FT", baseSalary: numericFromSatang(DEMO_BASES_SATANG[i]!), active: true })
    .onConflictDoNothing({ target: boSalaryProfile.teacherId })
    .returning({ id: boSalaryProfile.id });
  created += r.length;
}
console.log(`salary profiles: ${created} created, ${ids.length - created} already existed (left as they are)`);

// the current month in Asia/Bangkok (UTC+7)
const bkk = new Date(Date.now() + 7 * 3600_000);
const year = bkk.getUTCFullYear();
const month = bkk.getUTCMonth() + 1;
const p = await db
  .insert(boPayPeriod)
  .values({ year, month, lockAt: defaultLockAt(year, month) })
  .onConflictDoNothing()
  .returning({ id: boPayPeriod.id });
console.log(p.length ? `pay period ${year}-${String(month).padStart(2, "0")}: created (open)` : `pay period ${year}-${String(month).padStart(2, "0")}: already existed (left as it is)`);

await queryClient.end();
