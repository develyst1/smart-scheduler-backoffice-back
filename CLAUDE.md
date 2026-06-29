# CLAUDE.md — smart-scheduler-backoffice-back (Finance API)

Guides Claude Code (and other agents) in this repo. For the cross-repo map see the
workspace root `../CLAUDE.md`. This repo is **greenfield**.

## What this is

The **backoffice backend** — the **Finance API** that powers `smart-scheduler-backoffice-front`.
Its job is to **retire "Alis To Soft"**: student wallet / hour deduction, inventory, and teacher
payroll. **Option C** build wave 2. It reads scheduling data the **Scheduling API** writes.

> Spec (Thai): **[docs/requirement-timeline.md](docs/requirement-timeline.md)** (living spec,
> latest entry §3–§5; synced from workspace root `docs/`).

## Stack

- **Bun** runtime + **Hono** + **Drizzle ORM** + **PostgreSQL** (the **shared** DB)
- TypeScript (strict). Tests with `bun test`.

```bash
bun install
bun run dev                 # bun --watch src/index.ts
bunx drizzle-kit generate
bunx drizzle-kit migrate
bun test
```

## Suggested layout

```
src/
  index.ts                 # Hono app, middleware, mount routes, export `AppType` for FE RPC
  routes/<domain>.ts       # wallet, inventory, payroll, reports
  services/<domain>.ts     # business logic — money math, payroll, stock (source of truth)
  db/
    schema.ts              # Drizzle schema for THIS app's tables (see ownership rule)
    index.ts               # drizzle client
  lib/
    line.ts                # LINE Messaging API push client (+ outbox/retry)
    money.ts               # integer-minor-unit helpers
  middleware/              # auth (admin/owner role), error handler, logging
drizzle.config.ts
```

Conventions: validate input (zod) → `services/*` → JSON. Keep money/payroll logic as **pure, tested
functions**. Export `AppType` for the frontend's `hc<AppType>` typed client. CORS allow-list the
backoffice frontend origin.

## Shared DB — this app's ownership

Both backends share **one PostgreSQL**. **This repo OWNS and migrates** the finance tables:
`student_wallet`, `wallet_ledger`, `inventory`, `inventory_movements`, `payroll`, `payroll_items`.
It **reads** scheduling tables (`attendance`, `bookings`, `teachers`) that `smart-scheduler-back`
owns — **read-only; never migrate them here.**

## Domain rules

- **Wallet / hour deduction:** maintain each student's remaining-hours balance. When the frontoffice
  records **real attendance**, deduct hours from the wallet and **push LINE to the parent**. Decide
  the trigger explicitly — polling/job over the shared `attendance` table, or a call/event from the
  Scheduling API. Every change writes a **ledger** row (auditable).
- **Inventory:** add stock; auto-deduct on point-of-sale; movements are logged.
- **Payroll:** compute Part-time / Freelance pay from **actual hours taught** (read from
  `attendance`), per weekly/monthly cycle.

## Notifications — LINE (this app: notify the parent)

- On hour deduction, push to the **parent** via **LINE Messaging API** (Official Account push).
- ⚠️ **LINE Notify is discontinued (2025-03-31)** — Messaging API only. Requires the parent's LINE
  **`userId`** (captured during onboarding). Use an **outbox + retry + audit log**; keep sends
  **idempotent**. LINE secrets live only here, in env.

## Money correctness (the whole point of this service)

- Store amounts/hours as **integer minor units**. Mutate balances **only inside DB transactions**.
- Never trust client-supplied balances; recompute from the ledger. Keep a full **audit trail** — this
  replaces a paid accounting tool, so every number must be traceable.

## Env

`DATABASE_URL` (same shared DB), `LINE_CHANNEL_ACCESS_TOKEN`, `LINE_CHANNEL_SECRET`, `JWT_SECRET`.
Timezone `Asia/Bangkok`.
