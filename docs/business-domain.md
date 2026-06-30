# Business Domain — ลูกค้า (ศูนย์กิจกรรม Balance / Wheeled Sports)

> อัปเดต: 2026-06-30 · ที่มา: ข้อความลูกค้า + rate card (`S__74989580.jpg`) + สัญญา Option C

---

## 1. ธุรกิจจริงของลูกค้า

ลูกค้า (คุณฟีน) ดำเนินธุรกิจ **ศูนย์ฝึกทักษะการทรงตัวและกีฬาล้อ** — ไม่ใช่สถาบันกวดวิชาวิชาการ

**กลุ่มโปรแกรมหลัก:**

| กลุ่ม | อายุขั้นต่ำ | หมายเหตุ |
|-------|-------------|----------|
| 1st Trial | ทุกวัย | ทดลอง 1 ชม. รวมอุปกรณ์ |
| Bike / Scooter / Balance Cruiser | 2+ | แพ็ก 4 ชม. |
| Surfskate / Freeskate / Skateboard / Inline Skate | 5+ | แพ็ก 6/10 ชม. รวมอุปกรณ์ (บางโปรแกรม) |
| Onewheel E-Skate | 5+ | แพ็ก 1/4/6 ชม. รวมอุปกรณ์ |
| Balance Play (Private 1:1) | 2+ | แพ็ก 1/6/10 ชม. |
| Balance Play (Group) | 4+ | แพ็ก 1/6/10 ชม. |

**รายได้เสริม:**

- เช่าอุปกรณ์ (Set / Ride / Helmet / Pads) รายชั่วโมง
- ขายสินค้าหน้าร้าน (น้ำ, ขนม, อุปกรณ์) — ครู Freelance ได้ค่าคอมต่อชิ้น

รายละเอียดราคาขาย → [product-catalog-pricing.md](product-catalog-pricing.md)

---

## 2. บุคลากร (ครู)

มีครู **3 ประเภท** ตาม enum ในระบบ (`FULL_TIME`, `PART_TIME`, `FREELANCE`):

| ประเภท | จำนวน (จากลูกค้า) | สรุปการจ่าย |
|--------|-------------------|-------------|
| Full-Time | 7 คน | Base salary + OT + ค่าน้ำมันนอกสถานที่ + ชม.เกิน |
| Part-Time | 8 คน | เหมาวันเสาร์-อาทิตย์; วันธรรมดา = รายชั่วโมง |
| Freelance | 8 คน | รายชั่วโมงตามสอนจริง + ค่าคอมขายสินค้า |

รายชื่อ + กฎ payroll ละเอียด → [teacher-roster-payroll.md](teacher-roster-payroll.md)

**กฎ scheduling (มีในโค้ดแล้ว):** จัดตารางให้ Full-time / Part-time เต็มก่อน แล้วค่อย Freelance · แอดมินจัดลำดับกลุ่มครูบนปฏิทินได้

---

## 3. แมปโดเมนธุรกิจ → โมเดลในระบบ

ชื่อโปรเจคใช้คำว่า "Tutoring" / "Scheduler" แต่ในโค้ด generic พอที่จะรองรับธุรกิจนี้:

| ธุรกิจจริง | ตาราง/ฟีเจอร์ในระบบ | สถานะ |
|------------|---------------------|--------|
| โปรแกรม (Bike, Skate, Balance Play…) | `subjects` | ⚠️ seed ยังเป็นคณิต/ฟิสิกส์ (placeholder) |
| ครู + ประเภท | `teachers.type` | ✅ enum ตรง · ⚠️ seed ยังเป็นชื่อ demo |
| นักเรียน / ผู้ปกครอง | `students` + LINE fields | ✅ schema พร้อม · รอ LINE OA (C.4) |
| แพ็กเรียน 4/6/10 ชม. (ฟิกวัน-เวลา) | `course_packages` + `bookings` type `COURSE_PACKAGE` | ✅ logic พร้อม |
| ทดลองเรียน 1 ชม. | `bookings` type `FIRST_TRIAL` | ✅ |
| จองรายครั้ง | `bookings` type `SINGLE_SESSION` | ✅ |
| วอยเชอร์ (ไม่ฟิกครู/เวลา) | `vouchers` + `VOUCHER` | ✅ · ⚠️ ขนาด 5/10/15 ชม. อาจไม่ตรง rate card |
| กระเป๋าชั่วโมงนักเรียน | `ops.accounts` (unit=HOURS) | ✅ schema · รอ wire debit ตอน ATTENDED |
| สต๊อก + POS | `ops.catalog_items`, `commerce/sales` | ✅ API · รอ backoffice UI |
| เรทครู / เพดาน Freelance | `ops.price_rules` (HOURLY, FIXED, CAP) | ✅ API · ❌ seed เรทจริง |
| เรทหลายแบบต่อครู (Private/Group/Camp/ECA) | `price_rules` + `metadata.teachingMode` | ❌ ดู teacher-roster-payroll § 2.3 |
| Payroll รอบเดือน | `ops.settlement_runs` | ❌ schema only |
| ค่าคอมขายสินค้า (Freelance) | settlement line / catalog commission | ❌ ยังไม่ implement |

---

## 4. Gap สำคัญ (seed vs ของจริง)

| หัวข้อ | ปัจจุบันในโค้ด | ควรเป็น |
|--------|----------------|---------|
| `subjects` ใน seed | คณิต, ฟิสิกส์, อังกฤษ… | โปรแกรมจาก rate card (Bike/Scooter, Surfskate, Balance Play ฯลฯ) |
| `teachers` ใน seed | ครูแอน, บีม, แคท… (6 คน demo) | 23 คนจากลูกค้า (7 FT + 8 PT + 8 FL) |
| ชื่อโปรเจค/เอกสารเก่า | "Tutoring", "สถาบันกวดวิชา" | ศูนย์กิจกรรม Balance / Wheeled Sports |
| Voucher sizes | 5 / 10 / 15 ชม. (อายุ 3/6/9 เดือน) | rate card ใช้ 1/4/6/10 ชม. — **ต้อง confirm** |
| ราคาขาย | ยังไม่มีใน scheduling DB | อยู่ใน backoffice `catalog_items` / `price_rules` หรือ master แยก |

**งานแนะนำสำหรับ agent ถัดไป:** อัปเดต `seed.ts` + migration master data หลังได้ตัวเลขเรท/ราคาจากลูกค้า

---

## 5. User personas

| ผู้ใช้ | แอป | ทำอะไร |
|--------|-----|--------|
| Staff / แอดมิน | `smart-scheduler-front` | จองตาราง, เช็คอิน, รายงานรายวัน |
| Owner / การเงิน | `smart-scheduler-backoffice-front` | สต๊อก, wallet, payroll, รายงาน (ยังไม่เริ่ม) |
| ครู | LINE OA (planned) | รับแจ้งเตือนคาบ, ยืนยันตัวตน |
| ผู้ปกครอง / นักเรียน | LINE OA (planned) | QR check-in, แจ้งลา, ซื้อคอร์ส |

---

## 6. อ้างอิง

- [product-catalog-pricing.md](product-catalog-pricing.md)
- [teacher-roster-payroll.md](teacher-roster-payroll.md)
- [monorepo-overview.md](monorepo-overview.md)
- [requirement-timeline.md](requirement-timeline.md)
