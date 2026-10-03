import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { actionRecallHookStatus, hookSettingsPath, installActionRecall, installHook, uninstallActionRecall } from "../../src/hook-install.ts";
import { buildSessionStartHookCommand } from "../../src/doctor-client.ts";
import { resolveActionRecallRuntime, resolveBunPath } from "../../src/lib/action-recall-runtime.ts";

let home: string;
let runtime: { bunPath: string; artifactPath: string };
const url = "http://localhost:19926";
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "flair-recall-blockers-"));
  runtime = { bunPath: process.execPath, artifactPath: join(home, "action-recall-hook.js") };
  writeFileSync(runtime.artifactPath, "", { mode: 0o600 });
});
afterEach(() => rmSync(home, { recursive: true, force: true }));
const path = () => hookSettingsPath(home, "claude-code");
const install = () => installActionRecall({ homeDir: home, harness: "claude-code", agentId: "me", flairUrl: url, runtime });
const read = () => JSON.parse(readFileSync(path(), "utf8"));
function seed(config: unknown) {
  mkdirSync(dirname(path()), { recursive: true });
  writeFileSync(path(), JSON.stringify(config));
}

test("uninstall dry-run reports both removals without writing settings, backups or lock files", () => {
  installHook({ homeDir: home, harness: "claude-code", agentId: "me", flairUrl: url });
  expect(install().ok).toBe(true);
  writeFileSync(`${path()}.lock`, "held by another writer");
  const bytes = readFileSync(path());
  const files = readdirSync(dirname(path()));
  const snapshots = files.map(file => readFileSync(join(dirname(path()), file)));
  const result = uninstallActionRecall({ homeDir: home, harness: "claude-code", dryRun: true });
  expect(result.ok).toBe(true);
  expect(result.actions).toEqual({ preToolUse: "remove", sessionStart: "update" });
  expect(result.message).toContain("dry run");
  expect(result.backupPath).toBeNull();
  expect(readFileSync(path())).toEqual(bytes);
  expect(readdirSync(dirname(path()))).toEqual(files);
  expect(files.map(file => readFileSync(join(dirname(path()), file)))).toEqual(snapshots);
});

test("a fresh successful install includes a compatible SessionStart refresh", () => {
  expect(install().ok).toBe(true);
  expect(actionRecallHookStatus(home, "claude-code").refreshEnabled).toBe(true);
});

test("an incompatible SessionStart command refuses the whole install", () => {
  seed({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo flair-session-start" }] }] } });
  const bytes = readFileSync(path());
  expect(install().ok).toBe(false);
  expect(readFileSync(path())).toEqual(bytes);
});

test("a held SessionStart pin write is non-success and preserves settings", () => {
  seed({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: buildSessionStartHookCommand("me", url).replace(/flair-mcp@[^ ]+/, "flair-mcp@9.9.9") }] }] } });
  const bytes = readFileSync(path());
  expect(install().ok).toBe(false);
  expect(readFileSync(path())).toEqual(bytes);
});

test("status rejects a wrong hook type and installation repairs it", () => {
  expect(install().ok).toBe(true);
  const config = read();
  config.hooks.PreToolUse[0].hooks[0].type = "prompt";
  seed(config);
  expect(actionRecallHookStatus(home, "claude-code").installed).toBe(false);
  expect(install().actions?.preToolUse).toBe("update");
  expect(read().hooks.PreToolUse[0].hooks[0].type).toBe("command");
  expect(actionRecallHookStatus(home, "claude-code").installed).toBe(true);
});

test("status rejects a wrong Bash matcher and a marker-only command", () => {
  expect(install().ok).toBe(true);
  const config = read();
  config.hooks.PreToolUse[0].matcher = "Read";
  seed(config);
  expect(actionRecallHookStatus(home, "claude-code").installed).toBe(false);
  config.hooks.PreToolUse[0].matcher = "Bash";
  config.hooks.PreToolUse[0].hooks[0].command = "echo action-recall-hook.js";
  seed(config);
  expect(actionRecallHookStatus(home, "claude-code").installed).toBe(false);
});

test("runtime resolution and status refuse a non-executable Bun and a directory artifact", () => {
  const bun = join(home, "bun");
  writeFileSync(bun, "", { mode: 0o600 });
  const env = { HOME: home, PATH: home, FLAIR_BUN_PATH: bun, FLAIR_ACTION_RECALL_ARTIFACT: runtime.artifactPath };
  expect(resolveBunPath(env)).toBeNull();
  expect(resolveActionRecallRuntime({ env, fromUrl: import.meta.url }).ok).toBe(false);
  chmodSync(bun, 0o700);
  expect(resolveBunPath(env)).toBe(bun);
  runtime.bunPath = bun;
  expect(install().ok).toBe(true);
  chmodSync(bun, 0o600);
  expect(actionRecallHookStatus(home, "claude-code").installed).toBe(false);
  chmodSync(bun, 0o700);
  env.FLAIR_ACTION_RECALL_ARTIFACT = home;
  expect(resolveActionRecallRuntime({ env, fromUrl: import.meta.url }).ok).toBe(false);
});
