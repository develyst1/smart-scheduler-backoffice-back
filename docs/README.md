# docs/ — เอกสารประกอบความเข้าใจโปรเจค (Smart Tutoring Scheduler)

เอกสารสเปคของโปรเจค **ใช้ชุดเดียวกันทุก repo** เพื่อให้ทั้งคนและ AI อ่านเข้าใจบริบทธุรกิจ
ได้ก่อนลงมือทำงาน โดยไม่ต้องข้ามไปอ่านโฟลเดอร์อื่น

## ไฟล์ในชุดนี้ (มีเหมือนกันทุก repo)

1. **[requirement-timeline.md](requirement-timeline.md)** — ⭐ แหล่งความต้องการล่าสุด (living spec)
   จัดเป็น timeline เรียงใหม่→เก่า **entry บนสุดคือล่าสุดและยึดอันนั้นเมื่อขัดกัน**
   มี requirement ใหม่ ให้เพิ่ม entry ไว้บนสุดในไฟล์นี้ที่เดียว
2. **README.md** — ไฟล์นี้ (index)

## เอกสารอ้างอิง (เก็บที่ root `H:\scheduler\docs\` เท่านั้น ไม่ sync ลง repo)

- `propasal.md` — ข้อเสนอเชิงพาณิชย์ 3 ทางเลือก (A Lite / B Standard / C Ultimate)
- `start_phase.md` — สรุปมัดจำงวดที่ 1 (**ลูกค้าเลือก Option C** — ยืนยันแล้ว 2026-06-29)
- `pdf/` — ไฟล์ PDF ต้นฉบับ

## ขอบเขตสัญญา (ยืนยันแล้ว)

**Option C (Ultimate)** เป็นขอบเขตเดียวของโปรเจค — ครอบคลุม scheduling + inventory +
รายการใน requirement-timeline (CRM, LINE OA, backoffice API ฯลฯ) ทั้ง 4 repo อยู่ในสัญญานี้
ลำดับส่งมอบ: scheduling ก่อน → backoffice ตาม (ดู entry 2026-06-29 ใน timeline)

## วิธีดูแล (สำคัญ)

- ต้นฉบับอยู่ที่ **root `H:\scheduler\docs\`** สำเนาในแต่ละ repo (`<repo>/docs/`) sync มาจาก root
  **แก้ที่ root แล้ว sync ลง** อย่าแก้แยกในแต่ละ repo เพราะจะ drift
- `todo.md` ใน `smart-scheduler-front` เป็น task list เฉพาะ repo นั้น (ไม่ sync ข้าม)

## คำถามธุรกิจที่ยังเปิดอยู่

- `MAX_WEEK_BY_SIZE` คอร์ส 6 ครั้ง โค้ดไว้ week 8 แต่สเปคฟิกแค่ 4→week5, 10→week13
