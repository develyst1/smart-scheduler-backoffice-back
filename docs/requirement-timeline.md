# Requirement Timeline — Smart Tutoring Scheduler

ไฟล์เดียวที่เป็น **แหล่งความต้องการล่าสุด (living spec)** ของทั้งโปรเจค
จัดเป็น **timeline เรียงจากใหม่ → เก่า** — entry บนสุดคือล่าสุดและ **ยึดอันนั้นเมื่อขัดกัน**

## วิธีเพิ่ม requirement ใหม่
เพิ่ม entry ใหม่ **ไว้บนสุด** (ใต้หัวข้อนี้) ตามรูปแบบ:

```
## YYYY-MM-DD — หัวข้อสั้นๆ ของรอบนี้
> ที่มา: (ใครสั่ง / คุยจากไหน)
- รายละเอียดความต้องการ...
```

กติกา: entry ใหม่กว่า**ชนะ**ของเก่าเมื่อเนื้อหาขัดกัน — ไม่ต้องไปลบของเก่า ให้ทับด้วยของใหม่ที่อยู่บน

---

## 2026-07-20 — As-built reconcile: Backoffice pivot เป็น Item-centric P&L (wallet/payroll พักไว้)  ⭐
> ที่มา: คุณฟีนสั่งให้ทีม AI ทำความเข้าใจโปรเจกต์ทั้งหมดก่อนสั่งงาน · Porter (PM) sweep โค้ดจริงทั้ง 4 repo (2026-07-20)
> บันทึกนี้แก้ข้อมูลสถานะที่ล้าสมัยในเอกสารเก่าให้ตรงโค้ดจริง — **ยังไม่ตัดสินใจ scope** (รอ stakeholder)

### สถานะจริงของ backoffice (แก้ของเดิมที่เขียนว่า greenfield 0%)
- **backoffice-front ไม่ใช่ 0%** — มีหน้าใช้งานจริงที่ต่อ API แล้ว 2 หน้า: **Dashboard งบกำไร-ขาดทุน (P&L)**
  และ **Items** (catalog CRUD + สต๊อกเข้า-ออก IN/OUT/ADJUST) · Next 16 + Mantine dark · port **3100**
  · หน้า `inventory` / `wallet` / `payroll` / `reports` ยังเป็น placeholder stub เฉยๆ
- **Backoffice pivot** จากโมเดลเดิม (wallet + payroll + inventory แยกส่วน) → เป็น **item-centric P&L**:
  ทุกอย่างเป็น `catalog_items` ที่มี `item_type` = **INCOME / EXPENSE / FIXED_COST**, ทุก movement เข้า P&L
  · `GET /reports/pl` = ตัวตอบ "เดือนนี้เงินเข้าเท่าไหร่" (revenue/cost/profit, by-type, by-item)
- **Wallet (`ops.accounts`) + Payroll (`ops.settlement_runs`) ถูกพักไว้** — accounts มี schema+API แต่ยังไม่ wire
  debit ตอน ATTENDED · settlement_runs/lines เป็น schema เปล่า ไม่มี service/route
  · เหตุผล: ฝั่งจองตารางนับชม.คงเหลือ (course.usedSessions / voucher.usedHours) อยู่แล้ว → wallet หลังบ้านเป็นของซ้อน
- ค่าครู (freelance รายชม. / fulltime fixed cost) ปัจจุบันโมเดลเป็น **expense item คีย์มือ** เข้า P&L
  — **ไม่ใช่** payroll engine ที่คำนวณอัตโนมัติจากชม.สอนจริง

### ✅ มติจากคุณฟีน (2026-07-20): ใช้ทาง A — item-centric P&L
- **ยืนยันทิศทาง backoffice = item-centric P&L** · **ไม่ทำ** payroll engine เต็ม + student hour-wallet (พักไว้)
- **ค่าครู Freelance = "งบรายเดือนแบบสต๊อก" ต่อคน** — ตั้งงบ+เรทรายคน, ตัดยอดที่ **end-of-day job** (สอนจริง = จอง−ลา),
  ยอดที่ตัดเข้า P&L เป็น EXPENSE อัตโนมัติ · งบถึง 0 → frontoffice ซ่อนครูจากหน้าจอง + teacher-mgmt ขึ้นธง ·
  แอดมินปลดล็อกได้ (เติมงบ หรือยอมติดลบ) · Full/Part-time = `FIXED_COST` คีย์มือรายเดือน
  → เป็น build จริงของ UC-016 (income ceiling / auto-disable)
- ออกเป็น **REQ-001** (`ai-worker/requirements/REQ-001-freelance-budget-stock.md`, READY_FOR_SA → Sober)
- เอกสารกลางของทีม (as-built map + รายละเอียด): `ai-agent-workspace/smart-scheduler/ai-worker/project-understanding.md`

---

## 2026-07-16 — Reconcile requirement.html กับโค้ดจริง (as-built) + ดีไซน์ Auto-cut / Income-ceiling / LINE  ⭐
> ที่มา: คุณฟีนสั่ง "อัปเดต requirement ให้เป็นภาพปัจจุบัน แล้วเคลียร์ทีละเรื่อง" · verify โค้ดทั้ง 4 repo ด้วย sub-agent

### แก้ status ใน requirement.html ให้ตรงโค้ด
- **UC-029** แจ้งลาล่วงหน้าตามประเภทครู → **Implemented** (`lib/leave-notice.ts` FT/PT 60min, FL 120min, wired staff+LINE bot + test) — เดิม badge เขียน Planned ผิด
- **SCR-008** QR check-in → **Implemented** (token + Bangkok time-window `[start−30min, end]`, **ไม่มี GPS**)
- **API-018/019/020/021/022** (backoffice BE: catalog/sales/parties/accounts/commercial) → **Implemented**
- **API-023** pricing → Partial (มีแค่ GET/POST/GET:id **ไม่มี update/delete**; seed เรทเฉพาะ FREELANCE, FT/PT ยังไม่มี)
- **UC-031** ขยายคอร์สด้วยมือ → Partial (move คาบได้ แต่ extend/recompute remaining ยังไม่มี)
- **UC-033** ชื่อวิชา → Partial (seed โปรแกรมกีฬาจริงแล้ว แต่ **Bike/Scooter ยังรวม subject เดียว** — confirm ลูกค้าว่าจะแยกไหม)

### เพิ่ม/ปรับ card
- เพิ่ม **ระบบ Badge** ที่ build เสร็จ end-to-end แต่ hub ไม่เคยมี → **WF-012 / UC-036 / SCR-011 / API-024 / TC-016** (Implemented)
- **UC-034 Multi-branch → Descoped** (ลูกค้ายืนยัน 2026-07-15 ไม่เอาแยกสาขา แทนด้วย Badge) · WF-011 เหลือแค่ Google Calendar sync
- counts ใหม่: 12 WF · 36 UC · 11 SCR · 24 API · 15 TC · 8 DIA

### ดีไซน์ที่ตกลง (ยังไม่ build — ทำต่อรอบหน้า)
- **Auto-cut สิ้นวัน (UC-012):** `bun build --compile` exe เป็น trigger ยิง `POST /internal/jobs/end-of-day` ใน back (logic ตัด+รายงานอยู่ที่เดียว), **idempotent + `job_runs` log**, timezone Asia/Bangkok, Windows Task Scheduler ~18:05 · แยก 2 งาน (ตัดจริง/รายงาน) · **ทำได้เลย ไม่ต้องรอ backoffice**
- **Income ceiling (UC-016):** cross-system — mock ล้วน (back `teachers` ไม่มี column rate/limit → `overLimit` false เสมอ) · **รอ backoffice-*back*** (pricing เรทจริง + endpoint ดึงเรท/cap + D.1 wire) **ไม่รอ front** · foundation เดียวกับ wallet debit (UC-025) + payroll (UC-024) → ทำ backoffice-back finance ก่อน
- **LINE:** bot inbound ตอบได้จริง แต่ **reply ไทยล้วน (UC-032 Partial)** + **push แจ้งผู้ปกครองตอนสมัครคอร์สยังไม่ทำ (UC-028 Planned)** + UX ดิบ → **รอลูกค้าบรีฟก่อน**

### ✅ Build ที่ทำจริงรอบนี้ (verify จริงบน DB)
- **Auto-cut สิ้นวัน (UC-012):** migration `0009` (`NO_SHOW` + `job_runs`), `jobs.service.ts`, endpoint `POST /internal/jobs/end-of-day` (secret), exe `scripts/end-of-day.ts` · integration: CONFIRMED คาบผ่าน→NO_SHOW+ตัดโควตา, idempotent
- **Income ceiling เรท/เพดานจริง (UC-016):** backoffice `GET /pricing/teacher-rates` (API-026) → scheduling `lib/ops-client.ts` เติม TeacherDTO → front map จริง · verify cross-system: freelance ได้ 500/20000 จริง (เดิม mock) · **เหลือ:** ย้ายแถบสีมาปฏิทิน
- 🔴 **infra:** scheduling+backoffice ใช้ `drizzle.__drizzle_migrations` ร่วมกัน → backoffice migrate ถูกข้าม; รอบนี้ apply ops SQL ตรงๆ + seed แล้ว, ต้องแยก migrations table ถาวร

📄 รายละเอียดเต็ม + as-built ทุก ID พร้อม path/line: `smart-scheduler-requirement/HANDOFF-2026-07-16.md`

---

## 2026-07-15 — Badge system (แทน Multi-branch) + กฎแจ้งลาล่วงหน้า (UC-029)
> ที่มา: ประชุม 2026-07-11 + คุยลูกค้าเพิ่ม (คุณฟีน)

### Badge system ⭐ (แทนแนวคิดแยกสาขา)
ลูกค้า **ไม่เอาแยกสาขา** — ต่อให้มีหลายสาขาก็อยากดูบน **web + visual calendar เดียวกัน**
แทนด้วยระบบ **badge ยืดหยุ่น** ที่แอดมินออกแบบเอง → "สาขา" กลายเป็นแค่ badge type หนึ่ง
- โครงสร้าง 2 ชั้น: **badge type → values** (แต่ละค่ามีสีจาก palette 12 สี), การจอง 1 ครั้งติดได้หลาย type แต่ **type ละ 1 ค่า**
- ติด badge ตอนจอง · กรองปฏิทินตาม badge (OR) · dashboard: per-badge count + ครู×badge
- ลบค่าที่ใช้แล้ว = soft-delete · รายละเอียด → [badge-system-design.md](badge-system-design.md)
- **ค้าง:** แก้ badge ของ booking เดิมผ่าน view modal (API `PATCH /bookings/:id/badges` พร้อมแล้ว)

### UC-029 กฎแจ้งลาล่วงหน้าตามประเภทครู
- FULL_TIME/PART_TIME ≥ 1 ชม., FREELANCE ≥ 2 ชม. ก่อนเริ่มคลาส
- บังคับทุกคน + **admin override ได้** (`override:true`) · ลาไม่ทัน → ปฏิเสธ คาบคงเดิม (409 `LEAVE_NOTICE_TOO_LATE`)

### หมายเหตุจากรอบนี้
- feedback ข้อ 1 (English UI) + ข้อ 5 (overbook เฉพาะคนลา) **ทำไปแล้วก่อนหน้า** — รอบนี้แค่ cleanup
- check-in จริงเป็น **QR token + time-window ไม่มี GPS** (ต่างจากที่ประชุมเล่า) — ข้อ 4 รอ confirm ลูกค้า

---

## 2026-06-30 (11:25) — เรทค่าสอน Freelance + Group/Camp/ECA  ⭐ ยึดอันนี้ (payroll detail)
> ที่มา: ข้อความลูกค้า (`chat-requirement-detail.md` 11:25)

### หลักการ
- ค่าสอน **ล็อคกับตัวครู** และ **แอดมินแก้มือได้** (backoffice)
- รายละเอียดเต็ม → [teacher-roster-payroll.md](teacher-roster-payroll.md) § 2.3

### Freelance — Private 1:1
- ค่าเริ่มต้น: **500 บาท/ชม.**
- Exception: **ครูโต๊ด** วันธรรมดา (จ–ศ): **400 บาท/ชม.**  
  (⚠️ โต๊ดอยู่ในรายชื่อ Part-Time — confirm กับลูกค้า)

### Group / Camp (เหมาช่วง)
- ครึ่งวัน (เช้าหรือบ่าย): **625 บาท**
- เต็มวัน: **1,250 บาท**

### ECA (สอนในโรงเรียน)
- เรทชม. **กำหนดรายคนต่อครู** — ระบบต้องรองรับตั้งค่าแต่ละคน

### Implement hint
- `ops.price_rules` ต่อ `party` (ครู) หลาย rule ต่อคน แยกด้วย `metadata.teachingMode`
- Booking ควรมี context ประเภทการสอน (`PRIVATE` / `GROUP_CAMP_HALF` / `GROUP_CAMP_FULL` / `ECA`) เพื่อคิด settlement

---

## 2026-06-30 — ธุรกิจจริง + รายชื่อครู + Payroll + Rate Card (โดเมน)
> ที่มา: ข้อความลูกค้า (`chat-requirement-detail.md`) + รูป rate card (`S__74989580.jpg`)

### ธุรกิจจริง (สำคัญ — แทนที่บริบท "กวดวิชา" ในเอกสารเก่า)

ลูกค้าดำเนินธุรกิจ **ศูนย์ฝึกทักษะการทรงตัวและกีฬาล้อ** (Bike, Scooter, Surfskate, Skateboard, Onewheel, Balance Play ฯลฯ)
ไม่ใช่สถาบันกวดวิชาวิชาการ — รายละเอียดเต็มใน [business-domain.md](business-domain.md) และ [product-catalog-pricing.md](product-catalog-pricing.md)

- โปรแกรมในระบบแมปกับตาราง `subjects` (ชื่อเดิมในโค้ด)
- แพ็กเรียน 1/4/6/10 ชม. ตาม rate card · เช่าอุปกรณ์รายชั่วโมง
- **Seed ปัจจุบัน (คณิต/ฟิสิกส์, ครู demo) เป็น placeholder** — ต้องแทนด้วย master data จริง

### รายชื่อครู 23 คน (3 ประเภท)

| ประเภท | จำนวน | รายชื่อ |
|--------|-------|---------|
| Full-Time | 7 | เอก, แบงค์, ฮาริส, ข้าวจ้าว, แคมป์, เลวิส |
| Part-Time | 8 | ปริ้นท์, กานต์, ซีด, เจย์, คิด, นิว, โต๊ด |
| Freelance | 8 | มาร์ค, โจ้, เก่ง, ต๊าบ, มุ, จิ, เนย์, กอล์ฟ |

รายละเอียด → [teacher-roster-payroll.md](teacher-roster-payroll.md)

### กฎ Payroll (สรุป — เงินออกสิ้นเดือนพร้อมกันทุกประเภท)

**Full-Time:** Base salary (รายคนไม่เท่ากัน) + ชม.สอนเกิน (วันธรรมดา >4ชม./วัน, เสาร์-อาทิตย์ >5ชม./วัน → **350 บาท/ชม.**) + ค่าน้ำมันนอกสถานที่ + OT

**Part-Time:** เหมาวันเสาร์-อาทิตย์ · วันธรรมดา = รายชั่วโมง (เรทรายคนไม่เท่ากัน)

**Freelance:** รายชั่วโมงตามสอนจริง (เรทรายคนไม่เท่ากัน) + ค่าคอมขายสินค้า (แต่ละ SKU ไม่เท่ากัน)

**Implement เป้าหมาย:** `ops.settlement_runs` + backoffice UI payroll — ดู [teacher-roster-payroll.md](teacher-roster-payroll.md) § แมประบบ

### Rate Card โปรแกรม/ราคาขาย

อ้างอิงรูป `S__74989580.jpg` — ตารางราคาเต็มใน [product-catalog-pricing.md](product-catalog-pricing.md)

### คำถามเปิด (รอ confirm ลูกค้า)

- เรท Part-Time / base salary FT / ค่าคอม **รายคนราย SKU** ยังไม่ครบ (Freelance Private/Group/ECA ได้บางส่วนแล้ว — ดู entry 11:25)
- ครูโต๊ด (Part-Time) ทำไมอยู่ในกฎเรท Freelance Private — confirm
- Voucher 5/10/15 ชม. ในโค้ด vs แพ็ก 1/4/6/10 ชม. ใน rate card — ใช้แบบไหน?
- คอร์ส 6 ชม. ขยายสูงสุด week 8 (assumption ในโค้ด) — ยืนยันกับลูกค้า

### เอกสารสำหรับ agent ถัดไป

อ่าน [monorepo-overview.md](monorepo-overview.md) + [docs/README.md](README.md) ก่อนลงมือ

---

## 2026-06-29 — ยืนยันขอบเขตสัญญา: Option C (Ultimate)
> ที่มา: confirm กับลูกค้า (คุณฟีน) / ทีมพัฒนา

- ลูกค้าเลือกและชำระมัดจำ **Option C: Ultimate Version** (73,000 บาท) ตาม [start_phase.md](../start_phase.md)
- **ขอบเขตสัญญาเดียว (Option C)** ครอบคลุมทั้ง 4 deployables — ไม่ใช่ “Phase 1 = Option B แล้วค่อย Option C ทีหลัง”
- ประกอบด้วย:
  - **Scheduling (Option B baseline):** ปฏิทิน 09:00–18:00, จอง 4 ประเภท, Policy Lock, LINE แจ้งครู, รายงานรายวัน, จัดการครู
  - **Inventory (จาก proposal Option C):** Mini ERP/POS — รับของเข้า / ตัดสต๊อกเมื่อขาย
  - **รายการ 2026-06-28 ด้านล่าง:** conflict resolution, QR/LINE check-in, CRM, LINE OA, Backoffice API อิสระ, wallet/payroll ตาม timeline
- **ลำดับส่งมอบ (build wave):** scheduling front+back ก่อน (มีโค้ดแล้ว) → backoffice inventory/finance ตาม — แต่ทั้งหมดอยู่ในสัญญา Option C เดียวกัน

---

## 2026-06-28 — ฟีเจอร์รอบล่าสุด (Calendar/CRM/LINE OA/Backoffice — Option C)
> ที่มา: requirement2 (เดิม `smart-scheduler-front/requirement2.md`)


### 1. ระบบตารางเรียนและการจอง (Visual Calendar & Booking)

* **หน้า Dashboard:** เพิ่มฟังก์ชันตัวกรอง (Filter) เพื่อให้สามารถเลือกดูตารางตามรายชื่อครูผู้สอนได้ 


* **รูปแบบการจอง 4 ประเภท:** เมื่อกดจองลงในตาราง จะมี Dropdown ให้เลือกประเภทการจอง ได้แก่ 1. ทดลองเรียน (Trial) 2. จองรายครั้ง (One time) 3. คอร์สรายสัปดาห์ (Weekly Course) และ 4. ใช้ Voucher 


* **การจัดการเมื่อตารางชนกัน (Conflict Resolution):** หากมีการสร้างคิวจองในวันที่มีการจองอยู่แล้ว ระบบจะมี Dropdown ให้เลือกวิธีจัดการกับ "การจองเก่า" ก่อน ได้แก่:
* ย้ายออกไปวันอื่น (ระบบจะแจ้งให้ติดต่อตกลงกับผู้ปกครองก่อน) 


* ย้ายไปสัปดาห์อื่น (ระบบจะแจ้งให้ติดต่อตกลงกับผู้ปกครองก่อน) 


* ย้ายไปให้ครูคนอื่นสอนแทน 





### 2. ระบบเช็คอิน กฎการลา และ CRM (Attendance, Policy & CRM)

* **การเช็คอินและแจ้งลาผ่าน QR Code/LINE:** เพื่อแก้ปัญหาลูกค้าไม่ทำตามขั้นตอน ระบบจะให้ลงทะเบียนผ่าน LINE OA เพื่อรับ QR Code สำหรับเช็คอินเข้าเรียนตามเวลา หรือใช้กดแจ้งลาได้โดยตรงผ่าน LINE 


* **ระบบ CRM สะสมแต้มและจัดระดับลูกค้า (Gamification):** ทุกครั้งที่ลูกค้าทำตามกฎ (เช่น เช็คอินตรงเวลา, แจ้งลาตามระบบ) จะได้รับคะแนนสะสม  เพื่อจัด Level ของลูกค้า "ที่น่ารัก" โดยลูกค้าระดับสูงจะได้รับสิทธิประโยชน์ โปรโมชั่น หรือการจัดลำดับความสำคัญก่อนใคร


* **ตัดคอร์สอัตโนมัติสิ้นวัน:** หากถึงเวลาสิ้นสุดการทำงานของวันแล้วไม่มีการสแกนเช็คอิน และไม่มีการแจ้งลาผ่านระบบ ระบบจะทำการตัดโควตาคอร์สเรียนอัตโนมัติ

### 3. การจัดการครูผู้สอน (Teacher Management)

* **การจัดลำดับความสำคัญ (Priority Dropdown):** แอดมินสามารถจัดเรียงลำดับกลุ่มครูได้ตามต้องการ (เช่น ลากกลุ่ม Freelance ขึ้นมาไว้บนสุด)  เมื่อกดจองตาราง ระบบก็จะแนะนำและกระจายงานตามลำดับ Priority ที่ตั้งไว้นั้น


* **ควบคุมงบประมาณ (Auto-Disable Limit Income):** สามารถตั้ง Limit รายได้ของครู Freelance ได้ โดยระบบจะดึงเรทราคาต่อชั่วโมงจากหลังบ้าน มาคูณกับจำนวนชั่วโมงที่รับงานไป หากคำนวณแล้วรายได้ของเดือนนั้นถึงลิมิตที่กำหนด ระบบจะทำการ Auto-Disable (ซ่อนสถานะการรับงาน) ไม่ให้แสดงบน Dashboard อัตโนมัติ เพื่อป้องกันการจองเกินงบ 



### 4. ระบบแจ้งเตือนและการยืนยันตัวตน (LINE OA & Notifications)

* **การยืนยันตัวตนและบทบาท (Role Verification):** เมื่อมีการทักเข้า LINE OA บอทจะสอบถามบทบาท (1. ลูกค้า 2. ครู 3. แอดมิน) ผู้ใช้จะต้องกรอกรหัสยืนยันตัวตนให้ถูกต้อง (เช่น พิมพ์ "แอดมิน... ขอรหัสแอดมิน : 229")  เมื่อรหัสถูกต้อง ระบบจะจดจำ ID แชทนั้นกับบทบาทนั้นทันที


* **ศูนย์กลางการแจ้งเตือน:** เมื่อลูกค้าระบุตัวตนแล้ว การแจ้งลาหรือแจ้งเตือนต่างๆ จากลูกค้าจะถูกเด้งไปแสดงที่ LINE ของแอดมินโดยตรง

### 5. ระบบหลังบ้านแบบครบวงจร (Backoffice & API - Option C)

* **ระบบจัดการคลังสินค้า (Mini ERP/POS):** เป็น Web Application ที่ออกแบบมาให้ใช้งานง่าย สำหรับคีย์รับของเข้าและตัดยอดเมื่อมีการนำของออก/ขายสินค้า
* **เชื่อมต่ออิสระผ่าน API:** ระบบ Backoffice จะมี API เป็นของตัวเอง (รูปแบบคล้ายการทำงานของ Jira) ที่อนุญาตให้ฝั่งระบบ Web จองตารางเรียน สามารถยิง API มาสั่งตัดสต๊อก ดึงเรทราคาครู หรือปรับปรุงข้อมูลได้โดยตรง ทำให้ระบบยืดหยุ่นและรองรับการขยายสเกลในอนาคต

---

## 2026-06-26 — Baseline (สรุปความต้องการรวมรอบแรก)
> ที่มา: requirement รอบรวมครั้งแรก (เดิม root `requirement.md`)

จากแหล่งข้อมูล โปรเจค **"Smart Tutoring Scheduler and Attendance Report System"** เป็นการพัฒนาระบบเพื่อเปลี่ยนจากการทำงานด้วยมือ (Manual) ใน Excel มาเป็นระบบอัตโนมัติที่ลดความผิดพลาดจากคน (Human Error) โดยมีรายละเอียดแยกตามหัวข้อสำคัญดังนี้ครับ:

### 1. ประเภทของคอร์สและการจอง (Course & Booking Types)
ระบบจะรองรับการเรียนหลากหลายรูปแบบเพื่อความยืดหยุ่น:
*   **First Trial:** การทดลองเรียนครั้งแรก 1 ครั้ง ซึ่งระบบจะทำเครื่องหมายแยกไว้เพื่อให้ทีมงานติดตามผลได้ง่าย
*   **คอร์สเรียนรายสัปดาห์ (Weekly Course):** เป็นคอร์สแบบ 4, 6 หรือ 10 ชั่วโมง ซึ่งจะมีการ**ฟิกเวลาและวันที่เรียน** เช่น เรียนทุกวันอาทิตย์ เวลา 09:00 น. ต่อเนื่องกันไป
*   **การจองรายครั้ง (1 Hour Booking):** สำหรับนักเรียนที่ต้องการเรียนเป็นครั้งๆ โดยไม่ผูกมัดเป็นคอร์ส
*   **วอยเชอร์ (Voucher):** ซื้อเป็นแพ็กเกจ (5, 10, 15 ชั่วโมง) ที่**ไม่ต้องฟิกตารางเรียนหรือครู** และมีอายุการใช้งานนานกว่าปกติ (3, 6, 9 เดือน) โดยจะนับอายุเมื่อเริ่มจองครั้งแรก

### 2. การจัดการครูผู้สอน (Teacher Management)
ระบบมีกลไกจัดการบุคลากรที่มีความสำคัญต่างกัน:
*   **การจัดลำดับความสำคัญ:** ระบบจะพยายามจัดตารางให้ครู **Full-time** และ **Part-time** ให้เต็มก่อน แล้วจึงค่อยส่งงานให้ครู **Freelance**
*   **การควบคุมสถานะ (Active/Inactive):** ผู้บริหารสามารถเลือกปิด (Inactive) ครูบางคนหรือบางกลุ่มไม่ให้ปรากฏในหน้าจองเพื่อหยุดรับงานชั่วคราวได้

### 3. กฎการลาและการจัดการตารางเรียน (Attendance Logic)
เพื่อให้การจัดการตารางเป็นระบบและยุติธรรม:
*   **เงื่อนไขการลา:** มีการจำกัดสิทธิ์การลาตามขนาดของคอร์ส คือ **คอร์ส 4 ชม. ลาได้ 1 ครั้ง, 6 ชม. ลาได้ 2 ครั้ง และ 10 ชม. ลาได้ 3 ครั้ง** หากเกินกำหนดระบบจะล็อคไม่ให้เลื่อนคลาส
*   **การเลื่อนคลาสอัตโนมัติ:** เมื่อมีการลา ระบบจะดึงคาบเรียนนั้นออกและไป**เพิ่มต่อท้ายให้เป็นครั้งถัดไป**โดยอัตโนมัติ
*   **ความยืดหยุ่น:** ทีมงานสามารถย้าย (Move) หรือเพิ่ม (Add) คาบเรียนด้วยมือได้ในกรณีพิเศษ เช่น นักเรียนต้องการเรียนเพิ่มในช่วงปิดเทอม

### 4. ระบบแจ้งเตือนและรายงาน (Notification & Reports)
เน้นการสื่อสารที่ฉับไวและเห็นภาพรวม:
*   **Notification:** เมื่อมีการยืนยันการจอง ระบบจะ**แจ้งเตือนไปยัง Line** ของครูผู้สอนทันทีเพื่อให้ทราบข้อมูลนักเรียนและเวลา
*   **Visual Dashboard:** แสดงตารางสอนของครูทุกคนในหน้าเดียว (Single View) ตามช่วงเวลา 09:00 - 18:00 น. เพื่อให้ทีมงานเห็นสล็อตว่างได้ชัดเจน
*   **Daily Report:** สรุปยอดนักเรียนรายวัน เช่น จำนวนนักเรียนทั้งหมด จำนวนคนลา และจำนวนคนที่มาเรียนจริง เพื่อใช้ตรวจสอบความถูกต้อง

### 5. การปรับเปลี่ยนแผนสู่ระบบบริหารจัดการครบวงจร (System Overhaul)
เดิมทีมีแผนจะเชื่อมต่อกับระบบ **AlisToSoft** แต่เนื่องจากข้อจำกัดในการเชื่อมต่อ API จึงมีแนวโน้มจะสร้างระบบใหม่ทั้งหมดเพื่อทดแทน:
*   **ระบบสมาชิกและแต้ม:** เก็บข้อมูลนักเรียนและตัดจำนวนชั่วโมงเรียนโดยตรงในระบบเดียว
*   **ระบบสต็อกสินค้า:** จัดการการขายและตัดสต็อกสินค้าหน้าโรงเรียน (เช่น น้ำดื่ม, อุปกรณ์สเก็ต)
*   **การคำนวณรายได้ครู:** สรุปชั่วโมงสอนและคำนวณค่าจ้างสำหรับครู Freelance ได้ทันทีจากข้อมูลการสอนจริง

โปรเจคนี้จะช่วยลดค่าใช้จ่ายรายปีของระบบเดิม และสร้างเครื่องมือที่ตรงกับความต้องการของธุรกิจคุณฟีนมากที่สุดครับ