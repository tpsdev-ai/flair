import { afterEach, beforeAll, beforeEach, expect, it } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import {
  actionRecallHookStatus,
  captureHookStatus,
  hookSettingsPath,
  installActionRecall,
  installCaptureHooks,
  installHook,
  uninstallActionRecall,
  uninstallCaptureHooks,
} from "../../src/hook-install.ts";
import { createActionRecallRuntime } from "../helpers/action-recall-runtime.ts";
import { createCaptureRuntime } from "../helpers/capture-runtime.ts";

const root = resolve(import.meta.dir, "../..");
let home: string;
beforeAll(() => {
  execFileSync(process.execPath, ["run", "build:cli"], { cwd: root, timeout: 30_000, stdio: "pipe" });
}, 40_000);
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "flair-edited-hook-status-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

for (const feature of ["capture", "action-recall"] as const) {
  const events = feature === "capture" ? ["PostToolUseFailure", "PostToolUse", "Stop"] : ["PreToolUse"];
  function fixture(edit = (command: string) => `${command} `) {
    expect(installHook({ homeDir: home, harness: "claude-code", agentId: "me", flairUrl: "http://localhost:19926" }).ok).toBe(true);
    const runtime = feature === "capture" ? createCaptureRuntime(home) : createActionRecallRuntime(home);
    const options = { homeDir: home, harness: "claude-code" as const, agentId: "me", flairUrl: "http://localhost:19926", runtime };
    const install = () => feature === "capture" ? installCaptureHooks(options) : installActionRecall(options);
    expect(install().ok).toBe(true);
    const path = hookSettingsPath(home, "claude-code");
    const config = JSON.parse(readFileSync(path, "utf8"));
    for (const event of events) {
      for (const group of config.hooks[event]) {
        for (const hook of group.hooks) hook.command = edit(hook.command);
      }
    }
    writeFileSync(path, JSON.stringify(config, null, 2));
    return { options, install, path, config };
  }

  it(`${feature} status reports all trailing-space entries while writers preserve their serialized bytes`, () => {
    const { options, install, path, config } = fixture();
    const snapshots = events.map(event => JSON.stringify(config.hooks[event][0]));
    const entryBytes = events.map(event => JSON.stringify(config.hooks[event][0], null, 2).split("\n").map((line, index) => index === 0 ? line : `      ${line}`).join("\n"));
    for (const bytes of entryBytes) expect(readFileSync(path, "utf8")).toContain(bytes);
    const observed = feature === "capture" ? captureHookStatus(home, "claude-code") : actionRecallHookStatus(home, "claude-code");
    const observe = () => feature === "capture" ? captureHookStatus(home, "claude-code") : actionRecallHookStatus(home, "claude-code");
    const outcomes = [];
    for (let step = 0; step < 2; step++) {
      outcomes.push(install());
      const after = JSON.parse(readFileSync(path, "utf8"));
      expect(events.map(event => JSON.stringify(after.hooks[event][0]))).toEqual(snapshots);
      for (const bytes of entryBytes) expect(readFileSync(path, "utf8")).toContain(bytes);
      const status = observe();
      expect(status.installed).toBe(false);
      for (const event of events) expect(status.problems?.join("; ")).toContain(`${event}[0].hooks[0]`);
    }
    outcomes.push(feature === "capture" ? uninstallCaptureHooks(options) : uninstallActionRecall(options));
    expect(outcomes.map(result => result.ok)).toEqual([true, true, true]);
    const after = JSON.parse(readFileSync(path, "utf8"));
    expect(events.map(event => JSON.stringify(after.hooks[event][0]))).toEqual(snapshots);
    for (const bytes of entryBytes) expect(readFileSync(path, "utf8")).toContain(bytes);
    expect(observed.installed).toBe(false);
    const diagnostic = observed.problems?.join("; ");
    for (const event of events) expect(diagnostic).toContain(`${event}[0].hooks[0]`);
    if (feature === "capture") expect((observed as ReturnType<typeof captureHookStatus>).state).toBe("stale");
  }, 30_000);

  it(`${feature} CLI status exits nonzero and names all trailing-space entries`, () => {
    fixture();
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("FLAIR_")));
    const result = spawnSync("node", ["dist/cli.js", "hook", "status", `--${feature}`, "--harness", "claude-code"], {
      cwd: root, env: { ...env, HOME: home, USERPROFILE: home }, encoding: "utf8", timeout: 10_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(1);
    for (const event of events) expect(result.stdout).toContain(`${event}[0].hooks[0]`);
    expect(result.stdout).toContain(feature === "capture" ? "capture: stale" : "noncanonical action-recall command");
  }, 30_000);

  it(`${feature} CLI status flags an edited agent assignment`, () => {
    fixture(command => command.replace("FLAIR_AGENT_ID=me", "FLAIR_AGENT=me"));
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("FLAIR_")));
    const result = spawnSync("node", ["dist/cli.js", "hook", "status", `--${feature}`, "--harness", "claude-code"], {
      cwd: root, env: { ...env, HOME: home, USERPROFILE: home }, encoding: "utf8", timeout: 10_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(1);
    for (const event of events) expect(result.stdout).toContain(`${event}[0].hooks[0]`);
    const observed = feature === "capture" ? captureHookStatus(home, "claude-code") : actionRecallHookStatus(home, "claude-code");
    expect(observed.installed).toBe(false);
    for (const event of events) expect(observed.problems.join("; ")).toContain(`${event}[0].hooks[0]`);
  }, 30_000);

  it(`${feature} CLI status excludes a marker-only user command`, () => {
    const marker = feature === "capture" ? "capture-hook.js" : "action-recall-hook.js";
    fixture(() => `echo FLAIR_AGENT_ID=me ${marker}`);
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("FLAIR_")));
    const result = spawnSync("node", ["dist/cli.js", "hook", "status", `--${feature}`, "--harness", "claude-code"], {
      cwd: root, env: { ...env, HOME: home, USERPROFILE: home }, encoding: "utf8", timeout: 10_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(0);
    for (const event of events) expect(result.stdout).not.toContain(`${event}[0].hooks[0]`);
    const observed = feature === "capture" ? captureHookStatus(home, "claude-code") : actionRecallHookStatus(home, "claude-code");
    expect(observed.installed).toBe(false);
    expect(observed.problems).toEqual([]);
    if (feature === "capture") expect((observed as ReturnType<typeof captureHookStatus>).state).toBe("absent");
  }, 30_000);
}
