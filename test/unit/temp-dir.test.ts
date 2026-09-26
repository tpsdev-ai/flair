/**
 * tempDir — the one scratch-dir helper, and its guarantee that a directory it
 * hands out is removed (flair#1889).
 *
 * `bun test` does NOT run Node's `exit`/`beforeExit` listeners (measured on bun
 * 1.3.10), so a helper that cleaned up only on process exit would leak every
 * directory it made. The helper registers the removal through bun:test's
 * `afterEach`/`afterAll` hooks instead — those fire — and the case below proves
 * it: the directory the first test creates is gone by `afterAll`.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "../helpers/temp-dir.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

let handedOut: string | null = null;

describe("tempDir", () => {
  test("returns a real, writable directory under the OS temp dir", () => {
    const dir = tempDir("flair-tempdir-helper-");
    handedOut = dir;
    expect(existsSync(dir)).toBe(true);
    writeFileSync(join(dir, "scratch.txt"), "scratch");
    expect(existsSync(join(dir, "scratch.txt"))).toBe(true);
  });

  test("each call returns a distinct directory", () => {
    const a = tempDir("flair-tempdir-helper-");
    const b = tempDir("flair-tempdir-helper-");
    expect(a).not.toBe(b);
    expect(existsSync(a)).toBe(true);
    expect(existsSync(b)).toBe(true);
  });

  test("a directory created OUTSIDE a test context is removed at process exit", () => {
    // A plain `bun -e` process (not the test runner) DOES run the exit hook, so
    // the helper is safe there too. The child prints the path, then exits; the
    // directory must be gone by the time it has.
    const helper = join(HERE, "..", "helpers", "temp-dir.ts");
    const script = [
      `const { tempDir } = await import(${JSON.stringify(helper)});`,
      `process.stdout.write(tempDir("flair-tempdir-exit-"));`,
    ].join("\n");
    const r = spawnSync("bun", ["-e", script], { encoding: "utf8" });
    expect(r.error).toBeUndefined();
    expect(r.status).toBe(0);
    const dir = (r.stdout ?? "").trim();
    expect(dir).toContain("flair-tempdir-exit-");
    expect(existsSync(dir)).toBe(false);
  });
});

// This runs after the helper's own `afterEach`/`afterAll` have swept the
// directories the tests above created. If that hook did NOT fire, this is where
// the leak would show up — as a directory that still exists.
afterAll(() => {
  expect(handedOut).not.toBeNull();
  expect(existsSync(handedOut as string)).toBe(false);
});
