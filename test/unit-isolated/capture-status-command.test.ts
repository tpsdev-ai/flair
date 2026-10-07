import { afterEach, beforeAll, beforeEach, expect, it } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  captureHookStatus,
  hookSettingsPath,
  installCaptureHooks,
  installHook,
} from "../../src/hook-install.ts";
import { isFlairCaptureCommand } from "../../src/doctor-client.ts";
import { createCaptureRuntime } from "../helpers/capture-runtime.ts";

const root = resolve(import.meta.dir, "../..");
let home: string;
let runtime: ReturnType<typeof createCaptureRuntime>;
const events = ["PostToolUseFailure", "PostToolUse", "Stop"] as const;

beforeAll(() => {
  execFileSync(process.execPath, ["run", "build:cli"], { cwd: root, timeout: 30_000, stdio: "pipe" });
}, 40_000);
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "flair-capture-status-"));
  runtime = createCaptureRuntime(home);
  expect(installHook({ homeDir: home, harness: "claude-code", agentId: "me", flairUrl: "http://localhost:19926" }).ok).toBe(true);
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function install() {
  return installCaptureHooks({ homeDir: home, harness: "claude-code", agentId: "me", flairUrl: "http://localhost:19926", runtime });
}
function settings(): any {
  return JSON.parse(readFileSync(hookSettingsPath(home, "claude-code"), "utf8"));
}
function save(config: any) {
  writeFileSync(hookSettingsPath(home, "claude-code"), JSON.stringify(config));
}
function status() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("FLAIR_")));
  const result = spawnSync("node", ["dist/cli.js", "hook", "status", "--capture", "--harness", "claude-code"], {
    cwd: root, env: { ...env, HOME: home, USERPROFILE: home }, encoding: "utf8", timeout: 10_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  return result;
}

for (const variant of ["group", "nested", "drifted", "drifted first"] as const) {
  it(`install normalizes ${variant} duplicates in settings`, () => {
    expect(install().ok).toBe(true);
    const config = settings();
    for (const event of events) {
      const duplicate = JSON.parse(JSON.stringify(config.hooks[event][0]));
      if (variant === "drifted first") {
        config.hooks[event][0].matcher = "Read";
        config.hooks[event][0].hooks[0].command = config.hooks[event][0].hooks[0].command.replace("FLAIR_AGENT_ID=me", "FLAIR_AGENT_ID=other");
      }
      if (variant === "drifted") {
        duplicate.matcher = "Read";
        duplicate.hooks[0].command = duplicate.hooks[0].command.replace("FLAIR_AGENT_ID=me", "FLAIR_AGENT_ID=other");
      }
      if (variant === "nested") config.hooks[event][0].hooks.push(duplicate.hooks[0]);
      else config.hooks[event].push(duplicate);
      config.hooks[event].push({ matcher: "Read", hooks: [{ type: "command", command: "echo unrelated" }] });
    }
    save(config);
    const preview = installCaptureHooks({ homeDir: home, harness: "claude-code", agentId: "me", flairUrl: "http://localhost:19926", runtime, dryRun: true });
    for (const event of events) expect(preview.actions?.[event]).toBe("update");
    expect(install().ok).toBe(true);
    const after = settings();
    for (const event of events) {
      expect(after.hooks[event].flatMap((group: any) => group.hooks).filter((hook: any) => isFlairCaptureCommand(hook.command))).toHaveLength(1);
      expect(after.hooks[event].some((group: any) => group.hooks.some((hook: any) => hook.command === "echo unrelated"))).toBe(true);
    }
    expect(captureHookStatus(home, "claude-code").state).toBe("installed");
    const result = status();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("capture: PostToolUseFailure + PostToolUse + Stop wired");
  }, 30_000);
}

for (const event of events) {
  it(`capture status rejects a non-command ${event} entry in settings`, () => {
    expect(install().ok).toBe(true);
    const config = settings();
    config.hooks[event][0].hooks[0].type = "prompt";
    save(config);
    const observed = captureHookStatus(home, "claude-code");
    expect(observed.state).toBe("stale");
    expect(observed.problems).toContain(`${event} carries an unexpected type`);
    const result = status();
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(`capture: stale (${event} carries an unexpected type)`);
  }, 30_000);
}

for (const state of ["stale", "partial", "absent", "runtime failure"] as const) {
  it(`capture CLI exit code for ${state} settings`, () => {
    if (state !== "absent") {
      expect(install().ok).toBe(true);
      const config = settings();
      if (state === "stale") config.hooks.PostToolUseFailure[0].matcher = "Write";
      if (state === "partial") delete config.hooks.Stop;
      if (state === "runtime failure") {
        for (const event of events) config.hooks[event][0].hooks[0].command = "echo capture-hook.js";
      }
      save(config);
    }
    const observed = captureHookStatus(home, "claude-code");
    if (state === "runtime failure") expect(observed.runtimeFailure).toBeTruthy();
    else {
      expect(observed.state).toBe(state);
      expect(observed.runtimeFailure).toBeUndefined();
    }
    const result = status();
    expect(result.status).toBe(state === "absent" ? 0 : 1);
    expect(result.stdout).toContain(state === "absent" ? "capture: not enabled" : `capture: ${observed.state}`);
  }, 30_000);
}
