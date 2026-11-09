import { defineConfig } from "drizzle-kit";

export default defineConfig({
  // SPEC-098 §2: Team C's revenue ledger lives in its own file so TASK-856 can own `schema.ts` this week.
  schema: ["./src/db/schema.ts", "./src/db/schema-revenue.ts", "./src/db/schema-salary-b.ts", "./src/db/schema-demo.ts", "./src/db/schema-notification.ts"], // 🔻 TASK-868: Team B's Transportation tables (DECISIONS row 7: one entry, after Team C's)
  out: "./drizzle",
  // 🔴 TASK-085 — this repo's OWN migration ledger. Both repos previously used the default
  // `drizzle.__drizzle_migrations`, and drizzle applies by comparing ONE row's created_at (never by
  // hash) — so whichever repo migrated last silently blocked the other, permanently, with exit 0.
  // ⚠️ A fresh ledger is EMPTY, which would re-apply every migration from 0000 on a live DB.
  // Seed it first: `bun run db:split-ledger` (dry-run) → `--apply`.
  migrations: { table: "__drizzle_migrations_bo", schema: "drizzle" },
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
  casing: "snake_case",
  schemaFilter: ["ops", "bo"],
});
