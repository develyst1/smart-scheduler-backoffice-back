# CLAUDE.md — smart-scheduler-backoffice-back (Operations API)

Guides Claude Code in this repo. Cross-repo map: workspace root `../CLAUDE.md`.

## What this is

**Operations / Finance API** — generic ERP primitives in PostgreSQL schema **`ops`**, not
tutoring-specific names. Powers `smart-scheduler-backoffice-front` and any upstream app
(`smart-scheduler-back`, future e-commerce, POS) via HTTP.

> Spec: **[docs/requirement.md](docs/requirement.md)**. **Tasks/scope live in the
> `smart-scheduler-requirement` repo, not a `todo.md`** (todo files were removed 2026-07-08 — do not
> recreate them): open `smart-scheduler-requirement/requirement.html` and treat `Partial` / `Planned`
> items as the work queue. See root `../CLAUDE.md` §"How work is assigned".

## Stack

- **Bun** + **Hono** + **Drizzle** + **PostgreSQL** (shared DB, schema `ops` only)
- Port **3002** · service token for machine consumers

```bash
bun install
bun run dev
bun run db:generate    # needs DATABASE_URL
bun run db:migrate
bun run db:seed
bun test
bun run smoke          # against running server
```

## Layout

```
src/
  index.ts              # health, CORS, onError, export AppType
  routes/               # catalog, parties, accounts, commercial, pricing
  services/             # domain logic (source of truth)
  db/schema.ts          # ops.* tables — generic names only
  middleware/auth.ts    # service token + admin JWT stub
```

## Naming (critical)

| Avoid | Use instead |
|-------|-------------|
| `teacher_rates`, `student_wallet` | `price_rules`, `accounts` |
| `teacher_id`, `student_id` FK | `parties.external_source` + `external_ref` |
| `/wallets/:id/deduct-hours` | `/accounts/:id/debits` |

Smart Scheduler maps students/teachers → `parties` with `external_source=smart-scheduler`.

## DB ownership

**This repo migrates `ops.*` only.** Scheduling tables in `public` are owned by
`smart-scheduler-back` — read-only here, never migrate.

## Env

`DATABASE_URL`, `PORT=3002`, `SERVICE_TOKEN`, `JWT_SECRET`, `SKIP_ADMIN_AUTH=true` (dev admin routes)
