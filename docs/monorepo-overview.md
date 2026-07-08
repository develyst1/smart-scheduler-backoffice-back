# Monorepo Overview — Smart Scheduler (4 Repos)

> อัปเดต: 2026-06-30 · สำหรับ AI agent ที่มาทำต่อ

---

## 1. โครงสร้าง monorepo

```
smart-scheduler/                    ← workspace root (เอกสารร่วมที่ docs/)
├── docs/                           ← ⭐ ต้นฉบับเอกสารธุรกิจ + living spec
├── chat-requirement-detail.md      ← ข้อความดิบลูกค้า (payroll)
├── S__74989580.jpg                 ← rate card โปรแกรม/ราคา
├── smart-scheduler-back/           ← Scheduling API (Hono :3001)
├── smart-scheduler-front/          ← Staff UI (Next.js :3000)
├── smart-scheduler-backoffice-back/← Operations API (Hono :3002)
└── smart-scheduler-backoffice-front/ ← Admin UI (greenfield)
```

**Database:** PostgreSQL เดียว — `public.*` (scheduling) + `ops.*` (finance)

---

## 2. สรุปแต่ละ repo

### smart-scheduler-back (Scheduling API)

| | |
|--|--|
| **Stack** | Bun, Hono, Drizzle, PostgreSQL (`public`) |
| **Port** | 3001 |
| **บทบาท** | Source of truth: ครู, นักเรียน, จอง, ลา, LINE push |
| **ความสำเร็จ** | ~75% — 17 API endpoints, conflict resolution, recurring course, voucher, JWT |
| **เหลือ** | C.1–C.5 (QR/LINE/CRM/cron), D.1 (wire backoffice) |
| **เริ่มอ่าน** | `CLAUDE.md`, `src/services/scheduler.service.ts` (งาน/สโคป: requirement repo) |

### smart-scheduler-front (Staff Web)

| | |
|--|--|
| **Stack** | Next.js 16, React 19, Mantine v9, TanStack Query |
| **Port** | 3000 |
| **บทบาท** | ปฏิทิน staff แทน Excel — จอง, เช็คอินมือ, รายงาน |
| **ความสำเร็จ** | ~70% — เชื่อม API จริง + auth |
| **เหลือ** | ฟอร์มสมัครคอร์ส/voucher (BE พร้อม), รอ C.* จาก BE |
| **เริ่มอ่าน** | `CLAUDE.md`, `src/components/partials/Calendar/` (งาน/สโคป: requirement repo) |

### smart-scheduler-backoffice-back (Operations API)

| | |
|--|--|
| **Stack** | Bun, Hono, Drizzle, PostgreSQL (`ops`) |
| **Port** | 3002 |
| **บทบาท** | Mini ERP/POS, wallet ชั่วโมง, pricing, settlement (payroll) |
| **ความสำเร็จ** | ~40% — catalog, parties, accounts, commercial, pricing CRUD |
| **เหลือ** | Settlement, reports, wire scheduling debit, seed เรทจริง |
| **เริ่มอ่าน** | `CLAUDE.md`, `docs/requirement.md`, `src/services/` |

### smart-scheduler-backoffice-front (Admin Web)

| | |
|--|--|
| **Stack** | (planned) Next 16 + Mantine dark theme |
| **บทบาท** | สต๊อก, wallet, payroll, รายงาน — แทน Alis To Soft |
| **ความสำเร็จ** | 0% — `src/` ว่าง, มีแค่ docs |
| **เริ่ม** | Wave 0 scaffold — สโคปดูที่ repo `smart-scheduler-requirement` (requirement.html) |

---

## 3. Data flow

```mermaid
flowchart LR
  subgraph frontoffice
    FE[front :3000]
    SCH[back :3001]
    FE --> SCH
  end

  subgraph backoffice
    BOFE[backoffice-front]
    OPS[backoffice-back :3002]
    BOFE -.-> OPS
  end

  subgraph db [PostgreSQL]
    PUB[public.*]
    OPS_S[ops.*]
  end

  SCH --> PUB
  SCH -. planned .-> OPS
  OPS --> OPS_S
```

**Integration ที่ยังไม่ wire:**

- `ATTENDED` → `POST /ops/accounts/:id/debits`
- Scheduling FE → `GET /ops/pricing/rules` (เรท/cap ครู)
- Settlement สิ้นเดือน ← aggregate จาก `bookings` + `commerce/sales`

---

## 4. สถานะฟีเจอร์ตามสัญญา Option C

| ฟีเจอร์ | BE sched | FE sched | BE ops | FE ops |
|---------|----------|----------|--------|--------|
| ปฏิทิน 09–18 | ✅ | ✅ | — | — |
| จอง 4 ประเภท | ✅ | ✅ | — | — |
| Conflict / จองทับ | ✅ | ✅ | — | — |
| กฎลา/ขยาย | ✅ | ✅ | — | — |
| Teacher order | ✅ | ✅ | — | — |
| Freelance income cap | 🟡 mock | 🟡 mock | ✅ rules | ❌ |
| LINE push ครู | 🟡 no userId | toast | ❌ | — |
| LINE OA webhook | ❌ | ❌ | ❌ | ❌ |
| QR check-in | ❌ | ❌ | — | — |
| CRM points | ❌ | ❌ | 🟡 schema | ❌ |
| Cron ตัดโควตาสิ้นวัน | ❌ | — | — | — |
| สมัครคอร์ส API | ✅ | ❌ form | — | — |
| Voucher API | ✅ | ❌ form | — | — |
| Inventory/POS | — | — | ✅ | ❌ |
| Wallet ชั่วโมง | — | — | ✅ | ❌ |
| Payroll settlement | — | — | ❌ | ❌ |

---

## 5. ลำดับงานแนะนำ (2026-06-30)

1. **Master data** — แทน seed ด้วยโปรแกรม + ครู 23 คนจริง ([teacher-roster-payroll.md](teacher-roster-payroll.md))
2. **C.4** LINE webhook (ปลดล็อก push จริง)
3. **C.3** cron 18:00 ตัดโควตา
4. **FE** ฟอร์มคอร์ส + voucher
5. **D.1** wire scheduling ↔ backoffice (debit + pricing)
6. **backoffice-front** Wave 0 → inventory demo
7. **Settlement** — payroll 3 ประเภทครูตาม [teacher-roster-payroll.md](teacher-roster-payroll.md)

---

## 6. คำสั่ง dev

```bash
# Scheduling API
cd smart-scheduler-back && bun install && bun run dev    # :3001

# Staff UI
cd smart-scheduler-front && bun install && bun run dev   # :3000

# Operations API
cd smart-scheduler-backoffice-back && bun install && bun run dev  # :3002

# DB migrate (scheduling)
cd smart-scheduler-back && bunx drizzle-kit migrate && bun run db:seed

# DB migrate (ops)
cd smart-scheduler-backoffice-back && bunx drizzle-kit migrate && bun run db:seed
```

**Env:** ดู `.env.example` ในแต่ละ repo · `SKIP_AUTH=true` / `SKIP_ADMIN_AUTH=true` ใน dev

---

## 7. เอกสารที่ต้องอ่านก่อน code

1. [business-domain.md](business-domain.md)
2. [product-catalog-pricing.md](product-catalog-pricing.md)
3. [teacher-roster-payroll.md](teacher-roster-payroll.md)
4. [requirement-timeline.md](requirement-timeline.md) — entry บนสุดชนะ
5. `<repo>/CLAUDE.md` + `smart-scheduler-requirement/requirement.html`
