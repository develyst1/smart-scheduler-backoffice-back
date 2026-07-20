import { describe, expect, test } from "bun:test";
import { mergeMetadata } from "./inventory.service";

describe("mergeMetadata — catalog item edit (TASK-009)", () => {
  test("shallow-merges: editing monthlyBudgetMinor preserves kind", () => {
    expect(
      mergeMetadata(
        { kind: "FREELANCE_BUDGET", monthlyBudgetMinor: 100000 },
        { monthlyBudgetMinor: 250000 },
      ),
    ).toEqual({ kind: "FREELANCE_BUDGET", monthlyBudgetMinor: 250000 });
  });

  test("undefined incoming leaves existing untouched", () => {
    expect(mergeMetadata({ kind: "FREELANCE_BUDGET" }, undefined)).toEqual({
      kind: "FREELANCE_BUDGET",
    });
  });

  test("null existing + incoming → incoming", () => {
    expect(mergeMetadata(null, { kind: "FREELANCE_BUDGET", monthlyBudgetMinor: 5000 })).toEqual({
      kind: "FREELANCE_BUDGET",
      monthlyBudgetMinor: 5000,
    });
  });

  test("null existing + undefined incoming → null", () => {
    expect(mergeMetadata(null, undefined)).toBeNull();
  });
});
