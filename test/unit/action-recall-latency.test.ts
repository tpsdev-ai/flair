import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "flair-latency-check-")));
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, "packages/flair-mcp/dist"), { recursive: true });
  copyFileSync(resolve(import.meta.dir, "../../scripts/action-recall-latency.mjs"), join(root, "scripts/action-recall-latency.mjs"));
  symlinkSync(resolve(import.meta.dir, "../../src"), join(root, "src"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

for (const [program, message] of [
  ['console.log("garbage")', "unrelated: unexpected stdout"],
  ['process.exit(7)', "matching: expected context-only output"],
]) {
  test(`latency gate rejects a fast broken hook: ${message}`, () => {
    writeFileSync(join(root, "packages/flair-mcp/dist/action-recall-hook.js"), program);
    const result = spawnSync("node", [join(root, "scripts/action-recall-latency.mjs"), "--runs", "1"], {
      env: { ...process.env, FLAIR_BUN_PATH: process.execPath }, encoding: "utf8", timeout: 10_000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(message);
  }, 15_000);
}
