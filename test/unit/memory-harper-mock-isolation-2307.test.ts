/**
 * memory-harper-mock-isolation-2307.test.ts — flair#2307 item 6.
 *
 * `test/unit/memory-selection-middleware-1940.test.ts` and
 * `test/unit-isolated/memory-integrity.test.ts` both mock the `harper` module
 * (bun's `mock.module` is process-global). Each must keep its own in-memory
 * state, so one `bun test` invocation that loads BOTH files is green. This runs
 * that combined invocation in a child process and pins the guarantee.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const FILES = [
  "test/unit/memory-selection-middleware-1940.test.ts",
  "test/unit-isolated/memory-integrity.test.ts",
];

describe("flair#2307 item 6 — two harper-mocking files in one bun test invocation", () => {
  test("both files pass together, in either load order", () => {
    for (const order of [FILES, [...FILES].reverse()]) {
      const result = spawnSync(process.execPath, ["test", ...order.map((f) => join(root, f))], {
        cwd: root,
        encoding: "utf8",
        timeout: 120_000,
      });
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      // Report the real output on failure (never a bare "failed").
      expect(result.status, output.slice(-2000)).toBe(0);
      expect(output).toContain("0 fail");
    }
  }, 150_000);
});
