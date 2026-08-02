import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/db/schema.ts",
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
