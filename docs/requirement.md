# Requirement — smart-scheduler-backoffice-back (Operations API)

เอกสารความต้องการเฉพาะ repo นี้ — อ้างอิงสัญญา **Option C (Ultimate)** และ
[requirement-timeline.md](requirement-timeline.md) (entry 2026-06-29)

> **บทบาท:** **Operations API กลาง** (สต๊อก · บัญชีเครดิต · อัตราราคา · settlement)
> ออกแบบให้ **consumer หลายระบบ** เรียกใช้ได้ — รวม `smart-scheduler-back`, เว็บขายของ, หรือ POS อื่น
> **ไม่ใช้** ชื่อ table/column/API ที่ผูกกับ tutoring โดยตรง (`teacher_rates`, `student_wallet`, …)

---

## 1. เป้าหมายและหลักการ

### 1.1 เป้าหมายธุรกิจ (Smart Scheduler)

| ความต้องการธุรกิจ | โมเดล generic ใน API นี้ |
|-------------------|---------------------------|
| สต๊อกน้ำ/ขนม/อุปกรณ์ | `catalog_items` + `stock_movements` |
| กระเป๋าชั่วโมงนักเรียน | `accounts` (unit=`HOURS`) + `account_ledger` |
| ซื้อคอร์สผ่าน LINE → admin อนุมัติ | `commercial_requests` (kind=`TOP_UP`) |
| ตัดชั่วโมงเมื่อมาเรียนจริง | `POST /accounts/:id/debits` (service token) |
| เรท/เพดานรายได้ Freelance | `price_rules` (kind=`HOURLY`, `CAP`) |
| ค่าจ้างครูรายรอบ | `settlement_runs` + `settlement_lines` |

### 1.2 หลักออกแบบ API (Third-party ready)

| หลัก | รายละเอียด |
|------|------------|
| **Resource-oriented** | `/api/v1/parties`, `/api/v1/accounts`, `/api/v1/catalog/items`, `/api/v1/pricing/rules` |
| **Versioned** | prefix `/api/v1` |
| **Idempotent writes** | header/body `idempotencyKey` สำหรับ mutation สำคัญ |
| **External linking** | `parties.external_source` + `external_ref` (เช่น `smart-scheduler` + uuid) — **ไม่** FK ไปตาราง scheduling |
| **Service auth** | JWT admin · **service token** สำหรับ machine consumers |
| **Errors** | `{ error: { code, message, details? } }` |
| **Timezone** | `Asia/Bangkok` |

### 1.3 Stack (locked)

- **Bun** + **Hono** + **Drizzle** + **PostgreSQL**
- PostgreSQL schema **`ops`** — แยกจากตาราง scheduling ใน `public`
- TypeScript strict · zod ที่ route · domain ใน `services/*`
- Export **`AppType`** จาก `index.ts`

### 1.4 DB ownership

**Repo นี้ migrate เฉพาะ schema `ops`:**

- `organizations`, `parties`
- `catalog_items`, `stock_balances`, `stock_movements`
- `accounts`, `account_ledger`
- `commercial_requests`
- `price_rules`
- `settlement_runs`, `settlement_lines`
- `notification_outbox`, `api_credentials`, `idempotency_records`

**อ่านอย่างเดียว** จาก scheduling (`public.*`) ได้ใน service layer ถ้าจำเป็น — **ห้าม migrate** ตารางของ `smart-scheduler-back`

---

## 2. โดเมนหลัก

### 2.1 Catalog & inventory

```
GET/POST  /api/v1/catalog/items
GET       /api/v1/catalog/items/:id
POST      /api/v1/catalog/items/:id/movements   { direction: IN|OUT|ADJUST, quantity, ... }
GET       /api/v1/catalog/items/:id/movements
POST      /api/v1/commerce/sales                { lines: [{ itemId, quantity }], ... }
```

---

### 2.2 Parties & accounts (wallet / credits)

**Party** = ลูกค้า, ผู้ให้บริการ, vendor — ลิงก์ upstream ผ่าน `external_source` + `external_ref`

**Account** = ยอดหน่วยใดหน่วยหนึ่ง (`HOURS`, `CURRENCY`, `POINTS`) ต่อ party

Flow เติมยอด (admin-mediated):

```
LINE ตกลง → commercial_requests PENDING → admin approve → CREDIT ledger
```

Flow ตัดยอด (machine):

```
upstream event (e.g. ATTENDED) → POST /accounts/:id/debits { amountMinor, refType, refId, idempotencyKey }
```

```
GET/POST  /api/v1/parties
GET       /api/v1/parties/:id
GET/POST  /api/v1/accounts
GET       /api/v1/accounts/:id
GET       /api/v1/accounts/:id/ledger
POST      /api/v1/accounts/:id/credits          admin
POST      /api/v1/accounts/:id/debits           service token
GET/POST  /api/v1/commercial/requests
PATCH     /api/v1/commercial/requests/:id       { action: approve|reject }
```

**Smart Scheduler mapping:** สร้าง `party` ต่อ student/teacher ด้วย `external_source=smart-scheduler`; account unit `HOURS` = ชั่วโมงเรียน

---

### 2.3 Pricing & settlement

**Price rules** = rate card ทั่วไป (ชม., คงที่, %, cap) — ไม่ใช่ `teacher_rates`

```
GET/POST  /api/v1/pricing/rules
GET       /api/v1/pricing/rules/:id
```

**Settlement** (payroll-like) — wave ถัดไป:

```
POST/GET  /api/v1/settlement/runs
GET       /api/v1/settlement/runs/:id/lines
PATCH     /api/v1/settlement/runs/:id           finalize|void
```

---

## 3. Integration กับ Scheduling API

`smart-scheduler-back` เป็น consumer หลัก:

| เมื่อ | เรียก Operations API |
|------|----------------------|
| ATTENDED | `POST /accounts/:id/debits` (idempotent ต่อ booking ref) |
| ต้องการเรท/cap | `GET /pricing/rules?partyId=` (party = teacher ที่ link แล้ว) |
| ขายสินค้า (optional) | `POST /commerce/sales` |
| ตรวจยอดก่อนจอง | `GET /accounts?partyId=` |

**ห้าม:** browser เรียก Operations API โดยตรง · **ห้าม:** migrate ตาราง scheduling

---

## 4. LINE & notifications

- Outbox + retry + idempotent
- LINE Messaging API only

---

## 5. Security

- Admin JWT (backoffice FE) · `SKIP_ADMIN_AUTH=true` ใน dev
- Service token: `Authorization: Bearer` หรือ `X-Service-Token`
- Integer minor units · mutation ใน transaction

---

## 6. Deliverables (ลำดับ implement)

1. ✅ Scaffold + health + auth stub + `AppType`
2. ✅ Catalog/inventory v1
3. ✅ Parties + accounts + commercial requests + pricing rules (CRUD พื้นฐาน)
4. ⬜ Settlement runs
5. ⬜ Reports · LINE worker · idempotency middleware · JWT จริง

---

## อ้างอิง

- [CLAUDE.md](../CLAUDE.md)
- [todo.md](../todo.md)
- Workspace [CLAUDE.md](../../CLAUDE.md)
