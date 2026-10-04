import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { hookSettingsPath, uninstallActionRecall } from "../../src/hook-install.ts";

let home: string;
let path: string;
beforeEach(() => {
  home = fs.mkdtempSync(join(tmpdir(), "flair-uninstall-held-"));
  path = hookSettingsPath(home, "claude-code");
  fs.mkdirSync(join(home, ".claude"));
  fs.writeFileSync(path, JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo action-recall-hook.js" }] }] } }));
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

test("uninstall refuses a held observation with removal pending and preserves settings", () => {
  const bytes = fs.readFileSync(path);
  const realStat = fs.lstatSync;
  const statSpy = spyOn(fs, "lstatSync").mockImplementation(((...args: Parameters<typeof fs.lstatSync>) => {
    if (String(args[0]) === path) throw Object.assign(new Error("settings became unreadable"), { code: "EACCES" });
    return realStat(...args);
  }) as typeof fs.lstatSync);
  try {
    const result = uninstallActionRecall({ homeDir: home, harness: "claude-code" });
    expect(result.message).toContain("cannot stat");
    expect(fs.readFileSync(path)).toEqual(bytes);
    expect(result.ok).toBe(false);
  } finally { statSpy.mockRestore(); }
});

test("the built CLI exits nonzero when action-recall uninstall is held", () => {
  const bytes = fs.readFileSync(path);
  const preload = join(home, "held.mjs");
  fs.writeFileSync(preload, `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const realStat = fs.lstatSync;
fs.lstatSync = (...args) => {
  if (String(args[0]) === ${JSON.stringify(path)}) throw Object.assign(new Error('settings became unreadable'), { code: 'EACCES' });
  return realStat(...args);
};
syncBuiltinESMExports();
`);
  const result = spawnSync("node", ["--import", preload, resolve(import.meta.dir, "../../dist/cli.js"), "hook", "uninstall", "--action-recall"], {
    env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: "utf8", timeout: 15_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.stdout).toContain("cannot stat");
  expect(fs.readFileSync(path)).toEqual(bytes);
  expect(result.status).toBe(1);
});
