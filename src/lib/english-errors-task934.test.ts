// TASK-934 (D-150-1 (c)): the back office is English, including the API's own error sentences, which the FE shows verbatim via error.message.
// Scans the salary / period / profile / entries / my-slip / transport route + service + lib files: no Thai character may appear in any non-comment line, except the cited allow-list.
// (The ฿ sign, U+0E3F, is a currency symbol and is not text.) Error CODES and statuses are untouched; only the sentences changed.
import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { readFileSync } from "node:fs";

const DOMAIN = /^src\/(routes\/(salary|salary-internal|transport|users|auth)|services\/(bo-user-admin[^/]*|salary[^/]*|bonus-[^/]*|commission-lines[^/]*|transport[^/]*|slip-[^/]*|hours-reader)|lib\/(pay-period|pay-rules|bonus-rules|commission-split|transport-pricing|salary-reports|slip-sections|month|money|satang|bo-money))\.ts$/;
/** Thai that is NOT an error sentence, cited. `looksLikeMoney` matches the Thai money words so that a LINE text can never carry an amount (TASK-920). */
const KEEP: { file: string; contains: string; why: string }[] = [{ file: "src/services/salary-notify.ts", contains: "looksLikeMoney", why: "a money-word detector (บาท / สตางค์), not a message" }];
const THAI = /[฀-฾เ-๿]/; // the Thai block minus ฿ (U+0E3F)

describe("TASK-934 no Thai in the back-office error sentences of the salary domain", () => {
  const files = [...new Glob("src/**/*.ts").scanSync(".")].map((f) => f.replaceAll("\\", "/")).filter((p) => DOMAIN.test(p) && !/\.test\.ts$/.test(p));
  test("the scan covers the domain files (a moved file must not silently drop out)", () => {
    expect(files.length).toBeGreaterThanOrEqual(15);
    for (const must of ["src/routes/salary.ts", "src/services/salary.service.ts", "src/services/slip-confirm.service.ts", "src/services/transport.service.ts", "src/routes/transport.ts", "src/routes/users.ts", "src/routes/auth.ts", "src/services/bo-user-admin.service.ts"]) expect(files).toContain(must);
  });
  test("no non-comment line carries a Thai character (except the cited keep-list)", () => {
    const hits: string[] = [];
    for (const p of files) {
      readFileSync(p, "utf8").split("\n").forEach((line, i) => {
        if (!THAI.test(line) || /^\s*(\/\/|\*|\/\*)/.test(line)) return;
        if (KEEP.some((k) => k.file === p && line.includes(k.contains))) return;
        hits.push(`${p}:${i + 1}: ${line.trim().slice(0, 120)}`);
      });
    }
    expect(hits).toEqual([]);
  });
  test("the listed sentences are English now (spot pins), codes unchanged", () => {
    const sal = readFileSync("src/services/salary.service.ts", "utf8");
    expect(sal).toContain('conflict("PERIOD_EXISTS", "This month\'s pay period already exists")');
    expect(sal).toContain('notFound("Pay period not found")');
    expect(sal).toContain('notFound("Slip not found")');
    expect(sal).toContain('badRequest("A reason is required")');
    expect(readFileSync("src/routes/auth.ts", "utf8")).toContain('const WRONG = "Wrong username or password."'); // the ONE sign-in failure sentence (the 401 is unchanged)
    expect(readFileSync("src/routes/salary.ts", "utf8")).toContain('new ApiException(403, "NO_TEACHER", "This account has no coach salary slip")');
  });
});
