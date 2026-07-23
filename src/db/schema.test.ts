import { describe, expect, test } from "bun:test";
import {
  boCadence,
  boDirection,
  boItem,
  boItemTag,
  boMovement,
  boTagGroup,
  boTagValue,
} from "./schema";

describe("bo schema shape (TASK-021)", () => {
  test("enums carry the approved values", () => {
    expect(boDirection.enumValues).toEqual(["INCOME", "EXPENSE"]);
    expect(boCadence.enumValues).toEqual([
      "VARIABLE",
      "FIXED_MONTHLY",
      "FIXED_DAILY",
      "FIXED_QUARTERLY",
    ]);
  });

  test("all 5 bo tables are defined", () => {
    for (const t of [boItem, boMovement, boTagGroup, boTagValue, boItemTag]) {
      expect(t).toBeDefined();
    }
  });

  test("item exposes the universal-model columns", () => {
    for (const col of [
      "id",
      "name",
      "unit",
      "direction",
      "cadence",
      "ceilingQty",
      "remainingQty",
      "unitPriceMinor",
      "ownerRef",
      "active",
    ]) {
      expect(boItem[col as keyof typeof boItem]).toBeDefined();
    }
  });
});
