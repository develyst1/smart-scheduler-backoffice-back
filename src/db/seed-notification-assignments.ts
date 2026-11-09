// TASK-917 - name ONE person as a recipient of a notification type (ruling C-h: assignments are ROLE-DERIVED and set by a script, never by the app, never opted out of).
//
//   bun run db:seed-notification-assignments -- --user <username> [--type "Low Stock"]
//
// The CEO role is seeded with every type by migration 0020. Today's one named person is "London" (Low Stock). Idempotent: a repeat adds nothing. The username is the person's
// `bo.users.username` (the token's `sub`); the script warns when no such user exists yet (the assignment is kept: the person starts receiving once the user exists).
import { sql } from "drizzle-orm";
import { db } from "./index";
import { boNotificationAssignment } from "./schema-notification";
import { isNotifyType } from "../lib/notification";

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const val = (flag: string): string | undefined => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);
  const user = (val("--user") ?? "").trim().toLowerCase();
  const type = val("--type") ?? "Low Stock";
  if (!user) throw new Error("--user <username> is required");
  if (!isNotifyType(type)) throw new Error(`--type must be one of the notification types, got «${type}»`);
  const [u] = [...(await db.execute(sql`select username, role::text as role, active from bo.users where lower(username) = ${user}`))] as Array<{ username: string; role: string; active: boolean }>;
  if (!u) console.log(`⚠ no bo.users row named «${user}» yet: the assignment is saved and starts delivering once the user exists`);
  else console.log(`user «${u.username}» (${u.role}, ${u.active ? "active" : "INACTIVE"})`);
  const r = await db.insert(boNotificationAssignment).values({ subjectKind: "user", subject: user, type }).onConflictDoNothing().returning({ id: boNotificationAssignment.id });
  console.log(r.length ? `assigned: ${user} receives «${type}»` : `already assigned: ${user} / «${type}»`);
  process.exit(0);
}
