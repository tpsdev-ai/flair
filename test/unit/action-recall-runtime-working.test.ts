import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { actionRecallHookStatus, hookSettingsPath, installActionRecall } from "../../src/hook-install.ts";
import { buildActionRecallHookCommand } from "../../src/doctor-client.ts";
import { resolveActionRecallRuntime } from "../../src/lib/action-recall-runtime.ts";
import { flairCliVersion } from "../../src/lib/mcp-spec.ts";

let home: string;
let artifact: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "flair-runtime-working-"));
  artifact = join(home, "dist/action-recall-hook.js");
  mkdirSync(join(home, "dist"));
  writeFileSync(join(home, "package.json"), JSON.stringify({ name: "@tpsdev-ai/flair-mcp", version: flairCliVersion(), bin: { "flair-action-recall": "dist/action-recall-hook.js" } }));
  writeFileSync(artifact, `#!/usr/bin/env bun\n// flair-action-recall-built@${flairCliVersion()}\nprocess.exit(0);\n`);
});
afterEach(() => rmSync(home, { recursive: true, force: true }));
const resolveRuntime = (bunPath = process.execPath, artifactPath = artifact) => resolveActionRecallRuntime({ fromUrl: import.meta.url, env: { PATH: process.env.PATH, HOME: home, FLAIR_BUN_PATH: bunPath, FLAIR_ACTION_RECALL_ARTIFACT: artifactPath } });
function status(bunPath: string, artifactPath: string) {
  const path = hookSettingsPath(home, "claude-code");
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(path, JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: buildActionRecallHookCommand(bunPath, artifactPath, "me") }] }] } }));
  return actionRecallHookStatus(home, "claude-code");
}

test("runtime and status reject an executable that is not Bun, even with Bun on PATH", () => {
  expect(resolveRuntime("/usr/bin/true").ok).toBe(false);
  expect(status("/usr/bin/true", artifact).installed).toBe(false);
});
test("runtime and status reject a regular nonscript override", () => {
  expect(resolveRuntime(process.execPath, "/etc/hosts").ok).toBe(false);
  expect(status(process.execPath, "/etc/hosts").installed).toBe(false);
});
test("runtime and status reject missing or stale embedded build versions", () => {
  for (const text of ["process.exit(0);", "// flair-action-recall-built@0.0.1\nprocess.exit(0);"]) {
    writeFileSync(artifact, text);
    expect(resolveRuntime().ok).toBe(false);
    expect(status(process.execPath, artifact).installed).toBe(false);
  }
});
test("runtime rejects a package version that differs from its built hook", () => {
  const pkg = JSON.parse(readFileSync(join(home, "package.json"), "utf8"));
  pkg.version = "0.0.1";
  writeFileSync(join(home, "package.json"), JSON.stringify(pkg));
  expect(resolveRuntime().ok).toBe(false);
});
test("runtime rejects Bun versions outside the supported range or malformed version output", () => {
  const bun = join(home, "bun");
  for (const version of ["1.3.9", "2.0.0", "v1.3.10", "not Bun"]) {
    writeFileSync(bun, `#!/bin/sh\nprintf '%s\\n' '${version}'\n`, { mode: 0o700 });
    expect(resolveRuntime(bun).ok).toBe(false);
    expect(status(bun, artifact).installed).toBe(false);
  }
});
test("runtime accepts Bun and a matching built hook", () => {
  expect(resolveRuntime().ok).toBe(true);
  expect(status(process.execPath, artifact).installed).toBe(true);
});
test("installation refuses invalid direct runtime inputs without writing settings", () => {
  for (const runtime of [{ bunPath: "/usr/bin/true", artifactPath: artifact }, { bunPath: process.execPath, artifactPath: "/etc/hosts" }]) {
    expect(installActionRecall({ homeDir: home, harness: "claude-code", agentId: "me", flairUrl: "http://localhost:19926", runtime }).ok).toBe(false);
  }
});
test("the package build stamps a hook that Bun can execute", () => {
  const packageDir = resolve(import.meta.dir, "../../packages/flair-mcp");
  execFileSync(process.execPath, ["run", "build"], { cwd: packageDir, timeout: 15_000, stdio: "pipe" });
  const result = resolveRuntime(process.execPath, join(packageDir, "dist/action-recall-hook.js"));
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.reason);
  const hook = spawnSync(result.runtime.bunPath, [result.runtime.artifactPath], { input: "{}", encoding: "utf8", timeout: 5000, env: { ...process.env, FLAIR_ACTION_RECALL_DIR: home } });
  expect(hook.status).toBe(0);
  expect(hook.stdout).toBe("");
  expect(hook.stderr).toBe("");
});
