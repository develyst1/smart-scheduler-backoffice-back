# Teacher Roster & Payroll Rules

> อัปเดต: 2026-06-30 (11:25 — Freelance rate detail) · ที่มา: `chat-requirement-detail.md`  
> เงินออก: **สิ้นเดือนพร้อมกันทุกประเภทครู**

---

## 1. รายชื่อครู (จากลูกค้า)

### Full-Time (7)

| ชื่อเล่น | ชื่อในแชท |
|---------|-----------|
| เอก | ครูเอก (Ek) |
| แบงค์ | ครูแบงค์ (Bank) |
| ฮาริส | ครูฮาริส (Haris) |
| ข้าวจ้าว | ครูข้าวจ้าว (Kowjoe) |
| แคมป์ | ครูแคมป์ (Camp) |
| เลวิส | ครูเลวิส (Lewis) |

### Part-Time (8)

| ชื่อเล่น |
|---------|
| ปริ้นท์ (Print) |
| กานต์ (Karn) |
| ซีด (Seed) |
| เจย์ (Jay) |
| คิด (Kid) |
| นิว (New) |
| โต๊ด (Toth) |

### Freelance (8)

| ชื่อเล่น |
|---------|
| มาร์ค (Mark) |
| โจ้ (Joe) |
| เก่ง (Keng) |
| ต๊าบ (Tarb) |
| มุ (Mu) |
| จิ (Ji) |
| เนย์ (Nay) |
| กอล์ฟ (Gof) |

**รวม 23 คน** — seed ปัจจุบันมีแค่ 6 คน demo ต้องแทนที่

---

## 2. กฎการจ่ายเงิน (สรุปจากลูกค้า)

### 2.1 Full-Time

| องค์ประกอบ | รายละเอียด |
|------------|------------|
| **Base salary** | มีเงินเดือนฐาน **รายคนไม่เท่ากัน** (ยังไม่ได้รับตัวเลข) |
| **ชั่วโมงสอนเกิน** | วันธรรมดา: เกิน **4 ชม./วัน** → ชม.ถัดไป **350 บาท/ชม.** |
| | เสาร์-อาทิตย์: เกิน **5 ชม./วัน** → ชม.ถัดไป **350 บาท/ชม.** |
| **ค่าน้ำมัน** | เมื่อออกไปสอนนอกสถานที่ |
| **OT** | ล่วงเวลางาน (นอกเหนือจากชม.สอนเกิน — ต้อง confirm นิยาม) |

### 2.2 Part-Time

| สถานการณ์ | การจ่าย |
|-----------|---------|
| เสาร์-อาทิตย์ (ปกติ) | **เหมาวัน** |
| วันธรรมดา | **รายชั่วโมง** |

เรทเหมา/ชม. **รายคนไม่เท่ากัน** (ยังไม่ได้รับตัวเลข)

### 2.3 Freelance — รายละเอียดค่าสอน (อัปเดต 11:25)

> **หลักการจากลูกค้า:** ค่าสอน **ล็อคกับตัวครู** (ผูก `party` / teacher) และ **แอดมินแก้มือได้** ผ่าน backoffice

#### Private ตัวต่อตัว (1:1)

| เงื่อนไข | อัตรา (บาท/ชม.) |
|----------|----------------|
| ค่าเริ่มต้น (Freelance) | **500** |
| **ครูโต๊ด (Toth)** วันธรรมดา (จ–ศ) | **400** |

> ⚠️ **ครูโต๊ด** อยู่ในรายชื่อ **Part-Time** ไม่ใช่ Freelance — ลูกค้าอ้างในข้อความ Freelance  
> ตีความชั่วคราว: เรท Private อาจใช้ข้ามประเภท หรือเป็น exception รายคน — **confirm กับลูกค้า**

#### Group / Camp (เหมาช่วง ไม่ใช่รายชม.)

| รูปแบบ | อัตรา (บาท) |
|--------|------------|
| ครึ่งวัน (เช้า **หรือ** บ่าย) | **625** |
| เต็มวัน | **1,250** |

#### ECA — ออกไปสอนในโรงเรียน

| เงื่อนไข | อัตรา |
|----------|-------|
| รายชั่วโมง | **กำหนดรายคนต่อครู** (ไม่มีค่า default ทั่วไป) |

#### อื่นๆ (จากข้อความก่อนหน้า)

| องค์ประกอบ | รายละเอียด |
|------------|------------|
| **ค่าคอมขาย** | หากขายสินค้าได้ — **แต่ละ SKU ค่าคอมไม่เท่ากัน** |
| **เพดานรายได้** | income cap + auto-disable บนปฏิทิน (ดึงเรทจาก backoffice — ยัง mock) |

#### สรุปประเภทเรทที่ระบบต้องรองรับ (ต่อครู)

| รหัส (แนะนำ) | ชื่อธุรกิจ | หน่วย | Default |
|--------------|-----------|------|---------|
| `PRIVATE_HOURLY` | สอน Private 1:1 | บาท/ชม. | 500 |
| `PRIVATE_WEEKDAY` | Private วันธรรมดา (exception) | บาท/ชม. | 400 (โต๊ด) |
| `GROUP_CAMP_HALF` | Group/Camp ครึ่งวัน | บาท/ครั้ง | 625 |
| `GROUP_CAMP_FULL` | Group/Camp เต็มวัน | บาท/ครั้ง | 1,250 |
| `ECA_HOURLY` | ECA โรงเรียน | บาท/ชม. | รายคน |

---

## 3. แมปกับระบบ (4 repo)

| กฎธุรกิจ | Repo / โมเดล | สถานะ |
|----------|--------------|--------|
| ประเภทครู 3 แบบ | `teachers.type` enum | ✅ |
| ลำดับความสำคัญจอง | `app_settings.teacher_type_order` | ✅ |
| ชม.สอนจริง (ATTENDED) | `bookings.status` | ✅ |
| เรทชม. Freelance | `ops.price_rules` (HOURLY) | ✅ API · ❌ seed เรทจริง |
| เรทหลายแบบต่อครู (Private/Group/Camp/ECA) | `ops.price_rules` + `metadata.teachingMode` | ❌ ต้อง implement |
| แก้เรทมือ (ล็อคกับครู) | backoffice UI + `PATCH /pricing/rules/:id` | ❌ UI ยังไม่มี |
| เพดานรายได้ Freelance | `ops.price_rules` (CAP) + scheduling FE | 🟡 mock |
| Base salary FT | `ops.settlement_lines` หรือ `price_rules` FIXED | ❌ |
| OT / ชม.เกิน 350 | settlement calculation job | ❌ |
| ค่าน้ำมันนอกสถานที่ | settlement line manual/adjustment | ❌ |
| เหมา PT เสาร์-อาทิตย์ | settlement — ต้องรู้ว่าคาบไหนเป็น "เหมาวัน" | ❌ |
| ค่าคอมขาย SKU | `commerce/sales` + commission rule per item | ❌ |
| รอบจ่ายสิ้นเดือน | `ops.settlement_runs` | ❌ schema only |

---

## 4. Logic ชม.เกิน Full-Time (สำหรับ implement settlement)

```
สำหรับแต่ละวัน แต่ละครู FULL_TIME:
  taught_hours = นับ bookings ที่ ATTENDED ในวันนั้น (หรือ CONFIRMED+ATTENDED ตามนิยาม payroll)
  threshold = 4 ถ้าวันจันทร์-ศุกร์, 5 ถ้าเสาร์-อาทิตย์
  if taught_hours > threshold:
    overtime_hours = taught_hours - threshold
    overtime_pay = overtime_hours * 350  // บาท
```

**คำถามเปิด:**

- นับชม.จาก booking 1 ชม. ต่อ slot หรือมีคาบยาวกว่า 1 ชม.?
- "ออกไปสอนนอกสถานที่" บันทึกที่ไหน? (flag บน booking / แยก expense line)
- OT งาน vs OT สอนเกิน — แยกประเภท line ใน settlement

---

## 5. งานที่ agent ถัดไปควรทำ

### Data
- [ ] อัปเดต `seed.ts` ด้วยรายชื่อ 23 คน + `type` ที่ถูกต้อง
- [ ] สร้าง `party` ใน `ops` ต่อครู (`external_source=smart-scheduler`, `external_ref=teacher.id`)
- [ ] กรอก `price_rules` ต่อครู — อย่างน้อย Freelance: PRIVATE 500, GROUP_CAMP_HALF 625, GROUP_CAMP_FULL 1250, ECA รายคน
- [ ] Exception ครูโต๊ด: PRIVATE_WEEKDAY 400 (หลัง confirm ประเภทครู)

### Backoffice API (`smart-scheduler-backoffice-back`)
- [ ] ขยาย `price_rules.metadata` — `teachingMode`: `PRIVATE` | `GROUP_CAMP_HALF` | `GROUP_CAMP_FULL` | `ECA` + optional `weekdaysOnly`
- [ ] Settlement runs API — เลือกเรทจาก booking context (ประเภทการสอน + ครู)
- [ ] Commission metadata บน `catalog_items`
- [ ] Income summary endpoint สำหรับ scheduling FE cap

### Backoffice UI (`smart-scheduler-backoffice-front`)
- [ ] หน้าตั้งเรทครูรายคน
- [ ] Payroll run สิ้นเดือน — draft / finalize / export

### Scheduling
- [ ] (Optional) `bookings.teaching_mode` หรือ metadata: `PRIVATE` | `GROUP_CAMP_HALF` | `GROUP_CAMP_FULL` | `ECA` — ใช้คิด payroll
- [ ] (Optional) flag `off_site` / `eca` บน booking สำหรับ ECA + ค่าน้ำมัน
- [ ] D.1 wire เรท/cap จาก backoffice แทน mock

---

## 6. อ้างอิง

- ข้อความดิบ: `../chat-requirement-detail.md`
- [business-domain.md](business-domain.md)
- [monorepo-overview.md](monorepo-overview.md) — § backoffice settlement
