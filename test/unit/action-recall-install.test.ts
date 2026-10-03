/**
 * Action-recall installer (flair#2067 slice 2) — `flair hook install|uninstall
 * --action-recall`. A fresh temp dir stands in for HOME
 * on every test, torn down after. Never touches the real ~/.claude or ~/.flair.
 *
 * The modules under test (installActionRecall / uninstallActionRecall /
 * actionRecallHookStatus) did not exist on main, so this file is red there by
 * construction.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  installHook,
  installActionRecall,
  uninstallActionRecall,
  actionRecallHookStatus,
  hookSettingsPath,
  type ActionRecallRuntime,
} from "../../src/hook-install.ts";
import { ACTION_RECALL_PRE_TOOL_USE_MATCHER, sessionStartEnablesActionRecall } from "../../src/doctor-client.ts";
import { createActionRecallRuntime } from "../helpers/action-recall-runtime.ts";

const RUNTIME: ActionRecallRuntime = {
  bunPath: process.execPath,
  artifactPath: "",
};

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "flair-action-recall-home-"));
  Object.assign(RUNTIME, createActionRecallRuntime(home));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function settings(): any {
  return JSON.parse(readFileSync(hookSettingsPath(home, "claude-code"), "utf8"));
}

describe("flair hook install --action-recall", () => {
  it("dry-run leaves settings unchanged and reports the delta", () => {
    const path = hookSettingsPath(home, "claude-code");
    const result = installActionRecall({ homeDir: home, harness: "claude-code", agentId: "me", flairUrl: "http://localhost:19926", dryRun: true, runtime: RUNTIME });
    expect(result.ok).toBe(true);
    expect(result.actions?.preToolUse).toBe("add");
    expect(existsSync(path)).toBe(false);
  });

  it("install wires a Bash PreToolUse group with an absolute runtime, then uninstall removes it", () => {
    const first = installActionRecall({ homeDir: home, harness: "claude-code", agentId: "me", flairUrl: "http://localhost:19926", runtime: RUNTIME });
    expect(first.ok).toBe(true);
    const config = settings();
    const group = config.hooks.PreToolUse[0];
    expect(group.matcher).toBe(ACTION_RECALL_PRE_TOOL_USE_MATCHER);
    const command = group.hooks[0].command as string;
    expect(command).toContain(RUNTIME.artifactPath);
    expect(command).toContain(RUNTIME.bunPath);
    expect(command).not.toContain("npx");

    const status = actionRecallHookStatus(home, "claude-code");
    expect(status.installed).toBe(true);

    const removed = uninstallActionRecall({ homeDir: home, harness: "claude-code" });
    expect(removed.ok).toBe(true);
    const after = settings();
    expect(after.hooks?.PreToolUse ?? []).toEqual([]);
  });

  it("enables the refresh flag on an existing SessionStart entry and clears it on uninstall", () => {
    installHook({ homeDir: home, harness: "claude-code", agentId: "me", flairUrl: "http://localhost:19926" });
    installActionRecall({ homeDir: home, harness: "claude-code", agentId: "me", flairUrl: "http://localhost:19926", runtime: RUNTIME });
    const enabled = settings();
    const cmd = enabled.hooks.SessionStart[0].hooks[0].command as string;
    expect(sessionStartEnablesActionRecall(cmd)).toBe(true);
    expect(actionRecallHookStatus(home, "claude-code").refreshEnabled).toBe(true);

    uninstallActionRecall({ homeDir: home, harness: "claude-code" });
    const cleared = settings();
    expect(sessionStartEnablesActionRecall(cleared.hooks.SessionStart[0].hooks[0].command)).toBe(false);
    expect(cleared.hooks.SessionStart[0].hooks[0].command).toContain("flair-session-start");
  });

  it("refuses a non-Claude harness", () => {
    const result = installActionRecall({ homeDir: home, harness: "codex", agentId: "me", flairUrl: "http://localhost:19926", runtime: RUNTIME });
    expect(result.ok).toBe(false);
    expect(existsSync(hookSettingsPath(home, "codex"))).toBe(false);
  });

  it("is idempotent", () => {
    installActionRecall({ homeDir: home, harness: "claude-code", agentId: "me", flairUrl: "http://localhost:19926", runtime: RUNTIME });
    const again = installActionRecall({ homeDir: home, harness: "claude-code", agentId: "me", flairUrl: "http://localhost:19926", runtime: RUNTIME });
    expect(again.ok).toBe(true);
    expect(again.actions?.preToolUse).toBe("noop");
    expect(again.actions?.sessionStart).toBe("noop");
  });
});
