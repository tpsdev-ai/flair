import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { flairCliVersion } from "../../src/lib/mcp-spec.ts";

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "flair-latency-check-")));
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, "packages/flair-mcp/dist"), { recursive: true });
  writeFileSync(join(root, "packages/flair-mcp/package.json"), JSON.stringify({ name: "@tpsdev-ai/flair-mcp", version: flairCliVersion(), bin: { "flair-action-recall": "dist/action-recall-hook.js" } }));
  copyFileSync(resolve(import.meta.dir, "../../scripts/action-recall-latency.mjs"), join(root, "scripts/action-recall-latency.mjs"));
  symlinkSync(resolve(import.meta.dir, "../../src"), join(root, "src"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

for (const [program, message] of [
  ['console.log("garbage")', "action-recall self-test failed"],
  ['process.exit(7)', "action-recall self-test failed"],
]) {
  test(`latency gate rejects a fast broken hook: ${message}`, () => {
    writeFileSync(join(root, "packages/flair-mcp/dist/action-recall-hook.js"), `#!/usr/bin/env bun\n// flair-action-recall-built@${flairCliVersion()}\n${program}`);
    const result = spawnSync("node", [join(root, "scripts/action-recall-latency.mjs"), "--runs", "1"], {
      env: { ...process.env, FLAIR_BUN_PATH: process.execPath }, encoding: "utf8", timeout: 10_000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(message);
  }, 15_000);
}
