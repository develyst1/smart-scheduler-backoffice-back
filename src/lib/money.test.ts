import { describe, expect, test } from "bun:test";
import { assertPositiveInt } from "./money";

describe("money", () => {
  test("assertPositiveInt accepts 1", () => {
    expect(() => assertPositiveInt(1, "q")).not.toThrow();
  });
  test("assertPositiveInt rejects 0", () => {
    expect(() => assertPositiveInt(0, "q")).toThrow();
  });
});
