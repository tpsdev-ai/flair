import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  installActionRecall,
  uninstallActionRecall,
  installCaptureHooks,
  uninstallCaptureHooks,
  hookSettingsPath,
  type ActionRecallRuntime,
} from "../../src/hook-install.ts";
import {
  ACTION_RECALL_PRE_TOOL_USE_MATCHER,
  CAPTURE_POST_TOOL_USE_MATCHER,
  buildActionRecallHookCommand,
  buildCaptureHookCommand,
  captureFlushSpec,
} from "../../src/doctor-client.ts";
import { createActionRecallRuntime } from "../helpers/action-recall-runtime.ts";
import { createCaptureRuntime } from "../helpers/capture-runtime.ts";

const AR_RUNTIME: ActionRecallRuntime = { bunPath: process.execPath, artifactPath: "" };
const CAP_RUNTIME: ActionRecallRuntime = { bunPath: process.execPath, artifactPath: "" };

/** The user's own hook, in a group whose matcher is the user's. */
const USER_HOOK = { type: "command", command: "sh -c 'echo user-hook'" };
/** The user group as it stands once Flair's own entry has moved out of it. */
const USER_GROUP_ONLY = { matcher: "*", hooks: [USER_HOOK] };

const AGENT = "me";
const URL = "http://localhost:19926";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "flair-matcher-2264-"));
  // The two runtimes need separate package roots: each helper writes a
  // package.json whose `bin` mapping its own probe checks, so sharing one root
  // makes the action-recall probe see the capture package's bin and fail.
  const arRoot = join(home, "ar-runtime");
  const capRoot = join(home, "cap-runtime");
  mkdirSync(arRoot, { recursive: true });
  mkdirSync(capRoot, { recursive: true });
  Object.assign(AR_RUNTIME, createActionRecallRuntime(arRoot));
  Object.assign(CAP_RUNTIME, createCaptureRuntime(capRoot));
}, 30_000);
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function settingsPath(): string {
  return hookSettingsPath(home, "claude-code");
}
function settings(): any {
  return JSON.parse(readFileSync(settingsPath(), "utf8"));
}
function writeSettings(config: any): void {
  const path = settingsPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2));
}
function actionRecallCommand(): string {
  return buildActionRecallHookCommand(AR_RUNTIME.bunPath, AR_RUNTIME.artifactPath, AGENT, URL);
}
function captureCommand(): string {
  return buildCaptureHookCommand(CAP_RUNTIME.bunPath, CAP_RUNTIME.artifactPath, AGENT, URL, captureFlushSpec());
}

describe("flair#2264 — shared hook groups", () => {
  it("action-recall install leaves the shared group's matcher and other hook serialized JSON unchanged and moves its entry to a dedicated group", () => {
    writeSettings({
      hooks: { PreToolUse: [{ matcher: "*", hooks: [USER_HOOK, { type: "command", command: actionRecallCommand() }] }] },
    });

    const result = installActionRecall({ homeDir: home, harness: "claude-code", agentId: AGENT, flairUrl: URL, runtime: AR_RUNTIME });
    expect(result.ok).toBe(true);

    const config = settings();
    expect(JSON.stringify(config.hooks.PreToolUse[0])).toBe(JSON.stringify(USER_GROUP_ONLY));
    const dedicated = config.hooks.PreToolUse.filter(
      (group: any) => group.hooks.some((hook: any) => typeof hook.command === "string" && hook.command.includes("action-recall-hook.js")),
    );
    expect(dedicated.length).toBe(1);
    expect(dedicated[0].matcher).toBe(ACTION_RECALL_PRE_TOOL_USE_MATCHER);
  });

  it("action-recall uninstall, after a shared-group install, leaves the user group serialized JSON unchanged", () => {
    writeSettings({
      hooks: { PreToolUse: [{ matcher: "*", hooks: [USER_HOOK, { type: "command", command: actionRecallCommand() }] }] },
    });
    installActionRecall({ homeDir: home, harness: "claude-code", agentId: AGENT, flairUrl: URL, runtime: AR_RUNTIME });

    const removed = uninstallActionRecall({ homeDir: home, harness: "claude-code" });
    expect(removed.ok).toBe(true);

    const config = settings();
    expect(JSON.stringify(config.hooks.PreToolUse)).toBe(JSON.stringify([USER_GROUP_ONLY]));
  });

  it("action-recall re-install from a shared group is idempotent (no second dedicated group)", () => {
    writeSettings({
      hooks: { PreToolUse: [{ matcher: "*", hooks: [USER_HOOK, { type: "command", command: actionRecallCommand() }] }] },
    });
    installActionRecall({ homeDir: home, harness: "claude-code", agentId: AGENT, flairUrl: URL, runtime: AR_RUNTIME });
    const again = installActionRecall({ homeDir: home, harness: "claude-code", agentId: AGENT, flairUrl: URL, runtime: AR_RUNTIME });

    expect(again.ok).toBe(true);
    expect(again.actions?.preToolUse).toBe("noop");
    const config = settings();
    expect(JSON.stringify(config.hooks.PreToolUse[0])).toBe(JSON.stringify(USER_GROUP_ONLY));
    expect(config.hooks.PreToolUse.filter((group: any) => group.matcher === ACTION_RECALL_PRE_TOOL_USE_MATCHER).length).toBe(1);
  });

  it("action-recall still repairs the matcher of a Flair-only group", () => {
    writeSettings({
      hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: actionRecallCommand() }] }] },
    });

    installActionRecall({ homeDir: home, harness: "claude-code", agentId: AGENT, flairUrl: URL, runtime: AR_RUNTIME });

    const config = settings();
    expect(config.hooks.PreToolUse.length).toBe(1);
    expect(config.hooks.PreToolUse[0].matcher).toBe(ACTION_RECALL_PRE_TOOL_USE_MATCHER);
  });

  it("capture install leaves a shared PostToolUse group's matcher and other hook serialized JSON unchanged and moves its entry", () => {
    writeSettings({
      hooks: { PostToolUse: [{ matcher: "*", hooks: [USER_HOOK, { type: "command", command: captureCommand() }] }] },
    });

    const result = installCaptureHooks({ homeDir: home, harness: "claude-code", agentId: AGENT, flairUrl: URL, runtime: CAP_RUNTIME });
    expect(result.ok).toBe(true);

    const config = settings();
    expect(JSON.stringify(config.hooks.PostToolUse[0])).toBe(JSON.stringify(USER_GROUP_ONLY));
    const dedicated = config.hooks.PostToolUse.filter((group: any) => group.matcher === CAPTURE_POST_TOOL_USE_MATCHER);
    expect(dedicated.length).toBe(1);
    expect(dedicated[0].hooks[0].command).toContain("capture-hook.js");
  });

  it("capture uninstall, after a shared-group install, leaves the user group serialized JSON unchanged", () => {
    writeSettings({
      hooks: { PostToolUse: [{ matcher: "*", hooks: [USER_HOOK, { type: "command", command: captureCommand() }] }] },
    });
    installCaptureHooks({ homeDir: home, harness: "claude-code", agentId: AGENT, flairUrl: URL, runtime: CAP_RUNTIME });

    const removed = uninstallCaptureHooks({ homeDir: home, harness: "claude-code" });
    expect(removed.ok).toBe(true);

    const config = settings();
    expect(JSON.stringify(config.hooks.PostToolUse)).toBe(JSON.stringify([USER_GROUP_ONLY]));
  });

  it("capture re-install from a shared group is idempotent (no second dedicated group)", () => {
    writeSettings({
      hooks: { PostToolUse: [{ matcher: "*", hooks: [USER_HOOK, { type: "command", command: captureCommand() }] }] },
    });
    installCaptureHooks({ homeDir: home, harness: "claude-code", agentId: AGENT, flairUrl: URL, runtime: CAP_RUNTIME });
    const again = installCaptureHooks({ homeDir: home, harness: "claude-code", agentId: AGENT, flairUrl: URL, runtime: CAP_RUNTIME });

    expect(again.ok).toBe(true);
    expect(again.actions?.PostToolUse).toBe("noop");
    const config = settings();
    expect(JSON.stringify(config.hooks.PostToolUse[0])).toBe(JSON.stringify(USER_GROUP_ONLY));
    expect(config.hooks.PostToolUse.filter((group: any) => group.matcher === CAPTURE_POST_TOOL_USE_MATCHER).length).toBe(1);
  });
});


for (const event of ["PreToolUse", "PostToolUseFailure", "PostToolUse", "Stop"] as const) {
  for (const fixture of ["marker-only", "appended-marker", "genuine-with-decoy", "edited-command"] as const) {
    it(`${event} ${fixture}: install, reinstall and uninstall preserve the user group's serialized JSON`, () => {
      const recall = event === "PreToolUse";
      const genuine = recall ? actionRecallCommand() : captureCommand();
      const marker = recall ? "action-recall-hook.js" : "capture-hook.js";
      const command = fixture === "marker-only" || fixture === "genuine-with-decoy"
        ? `echo ${marker}`
        : fixture === "appended-marker" ? `${USER_HOOK.command} # ${marker}` : `${genuine} `;
      const decoy = { type: "command", command, timeout: 17 };
      const userGroup = { matcher: "Read", hooks: [decoy] };
      writeSettings({ hooks: { [event]: [{
        ...userGroup,
        hooks: fixture === "genuine-with-decoy" ? [{ type: "command", command: genuine }, decoy] : [decoy],
      }] } });
      const runtime = recall ? AR_RUNTIME : CAP_RUNTIME;
      const options = { homeDir: home, harness: "claude-code" as const, agentId: AGENT, flairUrl: URL, runtime };
      const install = () => recall ? installActionRecall(options) : installCaptureHooks(options);
      const snapshots: string[] = [];
      const outcomes: Array<{ ok: boolean; message: string }> = [];
      for (let step = 0; step < 2; step++) {
        outcomes.push(install());
        snapshots.push(JSON.stringify(settings().hooks[event][0]));
      }
      outcomes.push(recall ? uninstallActionRecall(options) : uninstallCaptureHooks(options));
      snapshots.push(JSON.stringify(settings().hooks?.[event]?.[0]));
      expect(outcomes.map((result) => result.ok), outcomes.map((result) => result.message).join("\n")).toEqual([true, true, true]);
      expect(snapshots).toEqual(Array(3).fill(JSON.stringify(userGroup)));
      expect(settings().hooks[event]).toHaveLength(1);
    });
  }
}
