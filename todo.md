# TODO — smart-scheduler-backoffice-back

งาน implement ตาม [docs/requirement.md](docs/requirement.md) · สัญญา **Option C** · repo **greenfield**

> สถานะ: ✅ เสร็จ · 🟡 บางส่วน · ❌ ยังไม่มี  
> **[BE]** repo นี้ · **[SCH]** งานที่ `smart-scheduler-back` ต้อง consume · **[FE]** รอ backoffice-front

---

## Wave 0 — Scaffold & foundation

- [ ] ❌ **[BE] Init project** — `bun init`, Hono, Drizzle, zod, tsconfig strict, `bun test`
- [ ] ❌ **[BE] `src/index.ts`** — CORS, `/health`, global `onError`, mount `/api/v1`, export `AppType`
- [ ] ❌ **[BE] `lib/http.ts` + `lib/money.ts`** — ApiException, integer minor units, ฿ formatting helpers
- [ ] ❌ **[BE] `types/contract.ts`** — DTO ร่วมกับ FE (single source)
- [ ] ❌ **[BE] Drizzle config + migrate ว่าง** — เชื่อม `DATABASE_URL` (shared PG)
- [ ] ❌ **[BE] Auth stub** — JWT admin + `Authorization: Bearer` service token middleware
- [ ] ❌ **[BE] Idempotency middleware** — อ่าน `Idempotency-Key` เก็บผล mutation ซ้ำ

---

## Wave 1 — Inventory (Mini ERP)

- [ ] ❌ **[BE] Schema** — `inventory_items`, `inventory_movements` (+ indexes, check qty ≥ 0)
- [ ] ❌ **[BE] `GET/POST /api/v1/inventory/items`**
- [ ] ❌ **[BE] `POST .../items/:id/movements`** — IN / OUT / ADJUST + ledger row
- [ ] ❌ **[BE] `POST /api/v1/inventory/sales`** — POS หลายบรรทัด · transaction เดียว
- [ ] ❌ **[BE] Seed สินค้าตัวอย่าง** — น้ำ, ขนม
- [ ] ❌ **[SCH] Client ใน scheduling-back** — `POST inventory/sales` (optional v1)

---

## Wave 2 — Wallet & admin-mediated purchase

- [ ] ❌ **[BE] Schema** — `wallets`, `wallet_ledger`, `purchase_intents`
- [ ] ❌ **[BE] `GET /wallets`, `GET /wallets/:id/ledger`**
- [ ] ❌ **[BE] `POST /wallets/:id/top-ups`** — admin only
- [ ] ❌ **[BE] `POST /purchase-intents` + `PATCH approve|reject`**
- [ ] ❌ **[BE] `POST /wallets/:id/deduct-hours`** — service token · idempotent ต่อ `bookingId`
- [ ] ❌ **[SCH] Scheduling: เรียก deduct เมื่อ ATTENDED** — ใน `scheduler.service.ts`
- [ ] ❌ **[BE] LINE outbox** — แจ้งผู้ปกครองเมื่อ deduct / approve top-up

---

## Wave 3 — Teacher rates & payroll

- [ ] ❌ **[BE] Schema** — `teacher_rates`, `payroll_runs`, `payroll_lines`, `expense_lines`
- [ ] ❌ **[BE] `GET/PUT /teachers/:id/rates`**
- [ ] ❌ **[BE] `GET /teachers/:id/income-summary?month=`** — ให้ scheduling FE auto-disable Freelance
- [ ] ❌ **[BE] Payroll run** — draft จาก bookings ATTENDED · commission · ค่ารถ · finalize
- [ ] ❌ **[SCH] Scheduling FE** — แทน mock `hourlyRate` / `incomeLimit` ด้วย API จริง

---

## Wave 4 — Reports & hardening

- [ ] ❌ **[BE] `GET /reports/pnl`, inventory valuation, wallet summary, payroll summary
- [ ] ❌ **[BE] `business_unit_id` nullable** — เตรียม multi-business
- [ ] ❌ **[BE] API keys table + scope** — `inventory:write`, `wallet:deduct`, `rates:read`
- [ ] ❌ **[BE] `scripts/smoke.ts`** — e2e กับ server จริง
- [ ] ❌ **[BE] OpenAPI หรือ README API** — สำหรับ third-party ในอนาคต

---

## งานข้าม repo (บันทึกไว้)

| Consumer | งาน |
|----------|-----|
| `smart-scheduler-back` | service token env · HTTP client · deduct-hours · get rates |
| `smart-scheduler-front` | แสดง `monthlyIncome` จาก backoffice API |
| LINE OA (อนาคต) | webhook สร้าง `purchase_intent` → คิว admin approve |

---

## ลำดับแนะนำสัปดาห์แรก

1. Wave 0 ทั้งหมด  
2. Wave 1 Inventory (ใช้ demo ได้เร็ว)  
3. Wave 2 Wallet + deduct-hours ( unblock scheduling finance )  
4. Wave 3–4 ตาม priority ลูกค้า  
