import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { signToken, verifyToken } from "./jwt";

const orig = process.env.JWT_SECRET;
beforeAll(() => {
  process.env.JWT_SECRET = "test-secret-abc";
});
afterAll(() => {
  if (orig === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = orig;
});

describe("jwt (TASK-013)", () => {
  test("sign → verify round-trips the claims with an exp in the future", async () => {
    const token = await signToken({ sub: "admin", role: "admin" });
    const claims = await verifyToken(token);
    expect(claims.sub).toBe("admin");
    expect(claims.role).toBe("admin");
    expect(claims.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  test("verify rejects a garbage token", async () => {
    await expect(verifyToken("not.a.jwt")).rejects.toBeDefined();
  });

  test("verify rejects a token signed with a different secret", async () => {
    const good = await signToken({ sub: "admin", role: "admin" });
    process.env.JWT_SECRET = "a-different-secret";
    await expect(verifyToken(good)).rejects.toBeDefined();
    process.env.JWT_SECRET = "test-secret-abc";
  });
});
