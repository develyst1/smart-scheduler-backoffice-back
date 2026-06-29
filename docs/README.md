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
- `start_phase.md` — สรุปมัดจำงวดที่ 1 (ลูกค้าเลือก Option C)
- `pdf/` — ไฟล์ PDF ต้นฉบับ

## วิธีดูแล (สำคัญ)

- ต้นฉบับอยู่ที่ **root `H:\scheduler\docs\`** สำเนาในแต่ละ repo (`<repo>/docs/`) sync มาจาก root
  **แก้ที่ root แล้ว sync ลง** อย่าแก้แยกในแต่ละ repo เพราะจะ drift
- `todo.md` ใน `smart-scheduler-front` เป็น task list เฉพาะ repo นั้น (ไม่ sync ข้าม)

> ⚠️ จุดต้องยืนยันกับลูกค้า:
> - `propasal.md`/`start_phase.md` ระบุลูกค้าเลือก **Option C (Ultimate)** จ่ายมัดจำแล้ว
>   แต่ root `CLAUDE.md` ยังเขียน **Phase 1 = Option B** — ต้องยืนยันขอบเขตเฟส 1
> - `MAX_WEEK_BY_SIZE` คอร์ส 6 ครั้ง โค้ดไว้ week 8 แต่สเปคฟิกแค่ 4→week5, 10→week13
