import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
function runCase(title: string): void {
  const result = spawnSync(process.execPath, [
    "test", "test/unit-isolated/memory-reindex-bookkeeping-2139.test.ts", "--test-name-pattern", title,
  ], { cwd: root, encoding: "utf8", timeout: 30_000 });
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(result.stderr).toMatch(/1 pass/);
}

describe("_reindex declared field refusals", () => {
  for (const field of ["summary", "subject", "entities", "parentId", "derivedFrom", "source", "type", "sessionId", "lastReflected", "createdAt", "_safetyFlags"]) {
    test(`declared drift ${field}`, () => runCase(`declared drift ${field}$`));
  }
  test("declared schema defaults to refusal", () => runCase("declared schema defaults to refusal$"));
  test("bookkeeping changes return 200", () => runCase("bookkeeping changes return 200$"));
});
