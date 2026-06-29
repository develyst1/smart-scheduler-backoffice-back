# TODO — smart-scheduler-backoffice-back

งาน implement ตาม [docs/requirement.md](docs/requirement.md) · สัญญา **Option C** · **Operations API กลาง (generic `ops` schema)**

> สถานะ: ✅ เสร็จ · 🟡 บางส่วน · ❌ ยังไม่มี  
> **[BE]** repo นี้ · **[SCH]** `smart-scheduler-back` consumer · **[FE]** backoffice-front

---

## Wave 0 — Scaffold & foundation

- [x] ✅ **[BE] Init project** — Bun, Hono, Drizzle, zod, `bun test`
- [x] ✅ **[BE] `src/index.ts`** — CORS, `/health`, `onError`, `/api/v1`, `AppType`
- [x] ✅ **[BE] `lib/http.ts` + `lib/money.ts`**
- [x] ✅ **[BE] `types/contract.ts`**
- [x] 🟡 **[BE] Drizzle migrate** — schema พร้อม · รัน `db:generate` + `db:migrate` เมื่อมี `DATABASE_URL`
- [x] 🟡 **[BE] Auth stub** — service token + admin stub (`SKIP_ADMIN_AUTH`)
- [ ] ❌ **[BE] Idempotency middleware** — table `idempotency_records` มีแล้ว · middleware ยังไม่ wire

---

## Wave 1 — Catalog / inventory

- [x] ✅ **[BE] Schema** — `ops.catalog_items`, `stock_balances`, `stock_movements`
- [x] ✅ **[BE] `GET/POST /api/v1/catalog/items`**
- [x] ✅ **[BE] `POST .../items/:id/movements`**
- [x] ✅ **[BE] `POST /api/v1/commerce/sales`**
- [x] ✅ **[BE] Seed** — org default + SKU ตัวอย่าง + demo party
- [ ] ❌ **[SCH] Client ใน scheduling-back** — optional v1

---

## Wave 2 — Parties, accounts & commercial requests

- [x] ✅ **[BE] Schema** — `parties`, `accounts`, `account_ledger`, `commercial_requests`
- [x] ✅ **[BE] `GET/POST /parties`**, `GET/POST /accounts`, ledger, credits/debits
- [x] ✅ **[BE] `GET/POST /commercial/requests` + `PATCH approve|reject`** (TOP_UP → credit)
- [ ] ❌ **[SCH] Scheduling: debit เมื่อ ATTENDED**
- [ ] ❌ **[BE] LINE outbox worker**

---

## Wave 3 — Pricing & settlement

- [x] 🟡 **[BE] Schema** — `price_rules`, `settlement_*` (schema only)
- [x] ✅ **[BE] `GET/POST /pricing/rules`**
- [ ] ❌ **[BE] Settlement runs API**
- [ ] ❌ **[BE] Income summary aggregate** (สำหรับ scheduling FE cap)
- [ ] ❌ **[SCH] Scheduling FE** — แทน mock rate/cap

---

## Wave 4 — Reports & hardening

- [ ] ❌ **[BE] Reports aggregate**
- [ ] ❌ **[BE] `api_credentials` + scopes**
- [x] 🟡 **[BE] `scripts/smoke.ts`**
- [ ] ❌ **[BE] OpenAPI / README API**

---

## ลำดับถัดไป

1. `db:generate` + `db:migrate` + `db:seed` บน shared PG  
2. Wire `smart-scheduler-back` → debit + pricing read  
3. Settlement + reports  
4. backoffice-front scaffold
