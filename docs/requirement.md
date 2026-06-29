# Requirement — smart-scheduler-backoffice-back (Finance & Operations API)

เอกสารความต้องการเฉพาะ repo นี้ — อ้างอิงสัญญา **Option C (Ultimate)** และ
[requirement-timeline.md](requirement-timeline.md) (entry 2026-06-29, 2026-06-28 §5)

> **บทบาท:** API กลางด้านการเงิน/สต๊อก/ค่าจ้าง — ออกแบบให้ **consumer หลายระบบ** เรียกใช้ได้ในระยะยาว
> (รูปแบบคล้าย Jira / Trello / Stripe-style REST) ไม่ผูกกับ UI ตัวเดียว

---

## 1. เป้าหมายและหลักการ

### 1.1 เป้าหมายธุรกิจ

- แทน **Alis To Soft** ในส่วน **สต๊อก · กระเป๋าชั่วโมง/คอร์ส · ค่าจ้างครู Freelance**
- ให้ **`smart-scheduler-back`** (Scheduling API) และระบบอื่นในอนาคต เรียกใช้ผ่าน HTTP API
- ทุกการเปลี่ยนแปลงเงิน/ชั่วโมง/สต๊อก → **ledger + audit** (ตรวจสอบย้อนหลังได้)

### 1.2 หลักออกแบบ API (Third-party ready)

| หลัก | รายละเอียด |
|------|------------|
| **Resource-oriented** | `/api/v1/wallets/{id}`, `/api/v1/inventory/items`, `/api/v1/payroll/runs` |
| **Versioned** | prefix `/api/v1` — breaking change ไป v2 ได้โดยไม่พัง consumer เก่า |
| **Idempotent writes** | header `Idempotency-Key` สำหรับ mutation สำคัญ (ตัดสต๊อก, ตัดชั่วโมง, จ่ายเงิน) |
| **Ready-to-use responses** | embed ชื่อนักเรียน/ครู/สินค้า — consumer ไม่ต้อง join เอง |
| **Service auth** | JWT สำหรับ admin UI · **API key / service token** สำหรับ `smart-scheduler-back` และระบบภายนอก |
| **Errors มาตรฐาน** | `{ error: { code, message, details? } }` เหมือน Scheduling API |
| **Timezone** | `Asia/Bangkok` · เก็บ timestamp with time zone |

### 1.3 Stack (locked)

- **Bun** + **Hono** + **Drizzle** + **PostgreSQL** (DB ชุดเดียวกับ Scheduling API)
- TypeScript strict · validate ที่ route (zod) · domain ใน `services/*`
- Export **`AppType`** จาก `index.ts` สำหรับ `hc<AppType>` ฝั่ง FE

### 1.4 DB ownership

**Repo นี้ migrate เฉพาะตาราง finance/ops:**

- wallet, wallet_ledger, purchase_orders (หรือเทียบเท่า)
- inventory_items, inventory_movements
- teacher_rates, payroll_runs, payroll_lines, expense_lines (commission, travel)
- notification_outbox (LINE parent)
- api_clients / service_tokens (optional phase 1)

**อ่านอย่างเดียว** จาก scheduling: `students`, `teachers`, `bookings` (status `ATTENDED`) —
**ห้าม migrate** ตารางของ `smart-scheduler-back`

---

## 2. โดเมนหลัก

### 2.1 Inventory (Mini ERP/POS)

**Use case:** น้ำดื่ม, ขนม, อุปกรณ์ — รับเข้า/ขายออก/ปรับยอด

| ฟังก์ชัน | รายละเอียด |
|---------|------------|
| สินค้า (SKU) | ชื่อ, หน่วย, ราคาขาย, reorder level (optional) |
| รับเข้า (IN) | admin คีย์จำนวน + อ้างอิง (ใบสั่งซื้อ/หมายเหตุ) |
| ตัดออก (OUT) | ขาย POS · หรือ **API จาก Scheduling** เมื่อ staff ตัดสต๊อกจาก flow อื่น |
| Ledger | ทุก movement = 1 row (before/after qty, actor, ref) |
| ตรวจสอบ | ห้าม qty ติดลบ — transaction + lock row |

**API ตัวอย่าง (v1):**

```
GET    /api/v1/inventory/items
POST   /api/v1/inventory/items
GET    /api/v1/inventory/items/:id
POST   /api/v1/inventory/items/:id/movements   { type: IN|OUT|ADJUST, qty, reason, idempotencyKey }
GET    /api/v1/inventory/items/:id/movements
POST   /api/v1/inventory/sales                 { lines: [{ itemId, qty }], ... }  // POS batch
```

---

### 2.2 Wallet / ชั่วโมงเรียน (Credit ledger)

**Use case:** นักเรียนมี “ยอดชั่วโมง/คอร์ส” ตัดเมื่อมาเรียนจริง · เติมเมื่อซื้อคอร์ส

**กฎสำคัญ (จาก product owner):**

- ลูกค้า **ไม่ self-service ตัด/เติม** บน web scheduling — ลด chaos / interrupt
- Flow ซื้อผ่าน **LINE ตกลงกับ admin** → admin บันทึก/อนุมัติใน backoffice → **ค่อยๆ reflect** ใน wallet
- การตัดชั่วโมงเมื่อ **ATTENDED** มาจาก Scheduling (หรือ job อ่าน attendance) — atomic + ledger

**สถานะ purchase / top-up (admin-mediated):**

```
LINE ตกลง → PENDING_APPROVAL → APPROVED → CREDITED (ledger +)
              ↘ REJECTED
```

**การตัดชั่วโมง:**

```
ATTENDED (scheduling) → POST /wallets/:id/deduct-hours { bookingId, hours, idempotencyKey }
                     → ledger DEBIT + optional LINE แจ้งผู้ปกครอง
```

**API ตัวอย่าง:**

```
GET    /api/v1/wallets?studentId=
GET    /api/v1/wallets/:id
GET    /api/v1/wallets/:id/ledger?page=
POST   /api/v1/wallets/:id/top-ups          { hours, amountMinor, source, note }  // admin only
POST   /api/v1/wallets/:id/deduct-hours     { bookingId, hours, idempotencyKey }  // service token
POST   /api/v1/purchase-intents             { studentId, package, lineRef }       // จาก LINE webhook → pending
PATCH  /api/v1/purchase-intents/:id         { action: approve|reject }
```

---

### 2.3 Payroll & รายจ่ายครู (Freelance / Part-time)

**Use case:** คำนวณรายได้ครู Freelance · ค่าคอม · ค่ารถ · สรุปรอบ (สัปดาห์/เดือน)

| รายการ | แหล่งข้อมูล |
|--------|-------------|
| ชั่วโมงสอนจริง | อ่าน `bookings` status `ATTENDED` + teacherId |
| เรท/ชม. | `teacher_rates` (backoffice owns) — Scheduling FE **ดึงเรท** ผ่าน API นี้ |
| ค่าคอม / ค่ารถ | expense line ต่อคาบหรือต่อรอบ payroll |
| Income cap | ส่ง `monthlyIncome`, `incomeLimit` ให้ Scheduling ใช้ auto-disable Freelance |

**API ตัวอย่าง:**

```
GET    /api/v1/teachers/:id/rates
PUT    /api/v1/teachers/:id/rates          { hourlyRateMinor, incomeLimitMinor, ... }
GET    /api/v1/payroll/runs?period=
POST   /api/v1/payroll/runs                { from, to }   // สร้าง draft
GET    /api/v1/payroll/runs/:id
PATCH  /api/v1/payroll/runs/:id            { action: finalize|void }
GET    /api/v1/teachers/:id/income-summary?month=   // สำหรับ scheduling FE
```

---

### 2.4 Reports & aggregates (สำหรับ FE + export)

```
GET /api/v1/reports/pnl?from=&to=&businessUnit=     // รายได้-รายจ่ายรวม
GET /api/v1/reports/inventory/valuation
GET /api/v1/reports/wallet/summary
GET /api/v1/reports/payroll/summary
```

รองรับ **หลายกิจการ (business unit)** ในอนาคต — field `businessUnitId` optional ตั้งแต่ schema v1

---

## 3. Integration กับ Scheduling API

`smart-scheduler-back` เป็น **consumer หลัก** (service-to-service):

| เมื่อ | เรียก Backoffice API |
|------|----------------------|
| ยืนยันว่ามาเรียน (ATTENDED) | `deduct-hours` (idempotent ต่อ bookingId) |
| ต้องการเรทครู / income cap | `GET teachers/:id/rates` หรือ `income-summary` |
| Staff ขายสินค้าจาก flow การจอง (optional) | `POST inventory/sales` |
| ตรวจ wallet ก่อนจอง voucher/course (optional) | `GET wallets?studentId=` |

**ห้าม:** Scheduling API migrate ตาราง finance · **ห้าม:** browser เรียก Backoffice โดยตรง (ผ่าน server หรือ BFF ถ้าจำเป็น)

---

## 4. LINE & notifications

- แจ้ง **ผู้ปกครอง** เมื่อตัดชั่วโมง / เติม package (หลัง admin approve)
- **Outbox + retry + idempotent** — เหมือน Scheduling API
- LINE Messaging API only (Notify ปิดแล้ว)

---

## 5. Security

- Admin JWT (backoffice FE)
- Service token scoped: `inventory:write`, `wallet:deduct`, `rates:read`
- Rate limit + audit log ทุก mutation
- เงิน/ชั่วโมง = **integer minor units** · mutation ใน **transaction** เท่านั้น

---

## 6. Non-goals (v1)

- ลูกค้า self-service ซื้อ/ตัด wallet บน scheduling web
- Public OAuth marketplace สำหรับ third party ภายนอก (เตรียม API key พอใน v1)
- บัญชี GAAP เต็มรูปแบบ / ใบกำกับภาษี (อนาคต)

---

## 7. Deliverables ตามลำดับ (แนะนำ)

1. Scaffold Bun/Hono + health + auth stub + `AppType`
2. Inventory CRUD + movements ledger
3. Wallet + ledger + admin top-up
4. Service token + `deduct-hours` สำหรับ Scheduling
5. Teacher rates + income summary API
6. Payroll run (draft → finalize)
7. Reports aggregate · LINE outbox worker

---

## อ้างอิง

- [CLAUDE.md](../CLAUDE.md) — layout & conventions
- [todo.md](../todo.md) — งาน implement รายข้อ
- Workspace [CLAUDE.md](../../CLAUDE.md) · [mastertodo.md](../../mastertodo.md)
