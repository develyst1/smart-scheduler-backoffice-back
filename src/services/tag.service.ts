// REQ-006 / TASK-022: badge-style grouping for bo items (tag_group → tag_value → item_tag).
import { asc, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { boItem, boItemTag, boTagGroup, boTagValue } from "../db/schema";
import { toBoTagGroupDTO, toBoTagValueDTO } from "../db/mappers";
import { badRequest, notFound } from "../lib/http";

export async function listTagGroups() {
  const groups = await db.query.boTagGroup.findMany({ orderBy: [asc(boTagGroup.sortOrder)] });
  const values = await db.query.boTagValue.findMany({ orderBy: [asc(boTagValue.sortOrder)] });
  return groups.map((g) => ({
    ...toBoTagGroupDTO(g),
    values: values.filter((v) => v.tagGroupId === g.id).map(toBoTagValueDTO),
  }));
}

export async function createTagGroup(input: { name: string; sortOrder?: number }) {
  const [row] = await db
    .insert(boTagGroup)
    .values({ name: input.name, sortOrder: input.sortOrder ?? 0 })
    .returning();
  return toBoTagGroupDTO(row);
}

export async function createTagValue(input: {
  tagGroupId: string;
  label: string;
  color?: string;
  sortOrder?: number;
}) {
  const group = await db.query.boTagGroup.findFirst({ where: eq(boTagGroup.id, input.tagGroupId) });
  if (!group) throw notFound("ไม่พบกลุ่มแท็ก");
  const [row] = await db
    .insert(boTagValue)
    .values({
      tagGroupId: input.tagGroupId,
      label: input.label,
      color: input.color ?? null,
      sortOrder: input.sortOrder ?? 0,
    })
    .returning();
  return toBoTagValueDTO(row);
}

/** Set an item's tag values — at most one value per group (UNIQUE(item, group)). Replaces all existing. */
export async function setItemTags(itemId: string, tagValueIds: string[]) {
  const item = await db.query.boItem.findFirst({ where: eq(boItem.id, itemId) });
  if (!item) throw notFound("ไม่พบ item");

  const values = tagValueIds.length
    ? await db.query.boTagValue.findMany({ where: inArray(boTagValue.id, tagValueIds) })
    : [];
  if (values.length !== tagValueIds.length) throw badRequest("มี tagValueId ที่ไม่ถูกต้อง");

  const groups = new Set<string>();
  for (const v of values) {
    if (groups.has(v.tagGroupId)) throw badRequest("เลือกได้กลุ่มละหนึ่งค่าเท่านั้น");
    groups.add(v.tagGroupId);
  }

  await db.transaction(async (tx) => {
    await tx.delete(boItemTag).where(eq(boItemTag.itemId, itemId));
    if (values.length)
      await tx
        .insert(boItemTag)
        .values(values.map((v) => ({ itemId, tagValueId: v.id, tagGroupId: v.tagGroupId })));
  });

  const rows = await db.query.boItemTag.findMany({ where: eq(boItemTag.itemId, itemId) });
  return { itemId, tagValueIds: rows.map((r) => r.tagValueId) };
}
