# docs/ — เอกสารประกอบความเข้าใจโปรเจค (Smart Scheduler)

เอกสารสเปคของโปรเจค **ใช้ชุดเดียวกันทุก repo** เพื่อให้ทั้งคนและ AI อ่านเข้าใจบริบทธุรกิจได้ก่อนลงมือทำงาน

> **ต้นฉบับอยู่ที่ `smart-scheduler/docs/` (root monorepo)** — สำเนาในแต่ละ repo (`<repo>/docs/`) sync มาจาก root  
> **แก้ที่ root แล้ว copy/sync ลงทุก repo** อย่าแก้แยกในแต่ละ repo เพราะจะ drift

---

## อ่านก่อนลงมือ (สำหรับ AI agent)

| ลำดับ | ไฟล์ | เนื้อหา |
|------|------|---------|
| 1 | **[business-domain.md](business-domain.md)** | ธุรกิจจริงของลูกค้า · แมปกับระบบ · gap ระหว่าง seed กับของจริง |
| 2 | **[product-catalog-pricing.md](product-catalog-pricing.md)** | โปรแกรม/แพ็กเกจ/ราคาขาย (จาก rate card ลูกค้า) |
| 3 | **[teacher-roster-payroll.md](teacher-roster-payroll.md)** | รายชื่อครู 3 ประเภท + กฎค่าจ้าง/คอม |
| 4 | **[monorepo-overview.md](monorepo-overview.md)** | สถาปัตยกรรม 4 repo · สถานะ implement · งานถัดไป |
| 5 | **[requirement-timeline.md](requirement-timeline.md)** | ⭐ living spec — entry บนสุดคือล่าสุด |

## ไฟล์เฉพาะ repo (ไม่ sync)

| Repo | ไฟล์เพิ่ม |
|------|-----------|
| `smart-scheduler-backoffice-back` | `requirement.md` — Operations API spec |
| `smart-scheduler-backoffice-front` | `requirement.md` — Backoffice UI spec |
| ทุก repo | *(ลบ todo.md แล้ว 2026-07-08)* งาน/สโคปดูที่ repo `smart-scheduler-requirement` → requirement.html |

## เอกสารอ้างอิง (root monorepo)

| ไฟล์ | คำอธิบาย |
|------|----------|
| `chat-requirement-detail.md` | ข้อความดิบจากลูกค้า (ครู + payroll) — ingest แล้วใน `teacher-roster-payroll.md` |
| `S__74989580.jpg` | รูป rate card โปรแกรม/ราคา — ingest แล้วใน `product-catalog-pricing.md` |
| `../CLAUDE.md` | คู่มือ monorepo สำหรับ AI agent |

## ขอบเขตสัญญา (ยืนยันแล้ว)

**Option C (Ultimate)** — ครอบคลุม scheduling + inventory + CRM/LINE OA + backoffice ทั้ง 4 deployables  
มัดจำ 73,000 บาท ยืนยัน 2026-06-29 · ลำดับส่งมอบ: scheduling ก่อน → backoffice ตาม

## คำถามธุรกิจที่ยังเปิดอยู่

- `MAX_WEEK_BY_SIZE` คอร์ส 6 ชม. โค้ดไว้ week 8 แต่สเปคฟิกแค่ 4→week5, 10→week13
- เรทชม. / base salary / ค่าคอมต่อ SKU — ลูกค้ายังไม่ส่งตัวเลขรายคน (มีแค่กฎทั่วไป)
- โปรแกรมใน rate card บางรายการใช้แพ็ก 4/6/10 ชม. ไม่ตรงกับ seed (คณิต/ฟิสิกส์) — ต้อง migrate master data
- Voucher 5/10/15 ชม. ในระบบ vs แพ็ก 1/4/6/10 ชม. ใน rate card — ต้อง confirm กับลูกค้า
