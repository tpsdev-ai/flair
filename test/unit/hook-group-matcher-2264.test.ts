/**
 * flair#2264 — install and uninstall never change the matcher of a hook group
 * Flair does not exclusively own. A group that also holds the user's hook is
 * SHARED: its matcher is theirs, so Flair leaves it alone and moves its own
 * entry into a dedicated group. A Flair-only group may still have its matcher
 * repaired.
 *
 * The matcher assertions here are red on origin/main, where the action-recall
 * and capture installers set the found group's matcher unconditionally; the
 * "Flair-only group still repairs" case passes on both (it guards this change
 * against a regression).
 *
 * A fresh temp dir stands in for HOME on every test. Never touches the real
 * ~/.claude or ~/.flair.
 */
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

describe("flair#2264 — a shared hook group's matcher is never changed", () => {
  it("action-recall install leaves the shared group's matcher and other hook byte-identical and moves its entry to a dedicated group", () => {
    writeSettings({
      hooks: { PreToolUse: [{ matcher: "*", hooks: [USER_HOOK, { type: "command", command: actionRecallCommand() }] }] },
    });

    const result = installActionRecall({ homeDir: home, harness: "claude-code", agentId: AGENT, flairUrl: URL, runtime: AR_RUNTIME });
    expect(result.ok).toBe(true);

    const config = settings();
    // The user's group keeps its matcher and its other hook, byte for byte —
    // serialized comparison, not a parsed equality (flair#2264).
    expect(JSON.stringify(config.hooks.PreToolUse[0])).toBe(JSON.stringify(USER_GROUP_ONLY));
    const dedicated = config.hooks.PreToolUse.filter(
      (group: any) => group.hooks.some((hook: any) => typeof hook.command === "string" && hook.command.includes("action-recall-hook.js")),
    );
    expect(dedicated.length).toBe(1);
    expect(dedicated[0].matcher).toBe(ACTION_RECALL_PRE_TOOL_USE_MATCHER);
  });

  it("action-recall uninstall, after a shared-group install, leaves the user group byte-identical", () => {
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

  it("capture install leaves a shared PostToolUse group's matcher and other hook byte-identical and moves its entry", () => {
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

  it("capture uninstall, after a shared-group install, leaves the user group byte-identical", () => {
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
