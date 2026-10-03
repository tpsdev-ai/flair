/**
 * Capture installer (flair#2068) — `flair hook install|uninstall|status
 * --capture`. A fresh temp dir stands in for HOME on every test, torn down
 * after. Never touches the real ~/.claude or ~/.flair.
 *
 * The modules under test (installCaptureHooks / uninstallCaptureHooks /
 * captureHookStatus) did not exist on main, so this file is red there by
 * construction.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  installHook,
  installCaptureHooks,
  uninstallCaptureHooks,
  captureHookStatus,
  hookSettingsPath,
  type ActionRecallRuntime,
} from "../../src/hook-install.ts";
import { CAPTURE_HOOK_MARKER, CAPTURE_POST_TOOL_USE_MATCHER, parseCaptureCommand } from "../../src/doctor-client.ts";
import { captureInstallRoot } from "../../src/lib/capture-runtime.ts";
import { flairCliVersion } from "../../src/lib/mcp-spec.ts";
import { createCaptureRuntime } from "../helpers/capture-runtime.ts";

const RUNTIME: ActionRecallRuntime = { bunPath: process.execPath, artifactPath: "" };

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "flair-capture-install-"));
  Object.assign(RUNTIME, createCaptureRuntime(home));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function settings(): any {
  return JSON.parse(readFileSync(hookSettingsPath(home, "claude-code"), "utf8"));
}
function installedArtifact(): string {
  const command = settings().hooks.PostToolUse[0].hooks[0].command as string;
  return parseCaptureCommand(command)!.artifactPath;
}
const install = (over: Record<string, unknown> = {}) =>
  installCaptureHooks({ homeDir: home, harness: "claude-code", agentId: "me", flairUrl: "http://localhost:19926", runtime: RUNTIME, ...over });

describe("flair hook install --capture", () => {
  it("dry-run leaves settings unchanged and provisions nothing", () => {
    const path = hookSettingsPath(home, "claude-code");
    const result = install({ dryRun: true });
    expect(result.ok).toBe(true);
    expect(result.actions?.PostToolUse).toBe("add");
    expect(result.actions?.Stop).toBe("add");
    expect(existsSync(path)).toBe(false);
    expect(existsSync(captureInstallRoot(home))).toBe(false);
  });

  it("wires a PostToolUse group with the matcher and a Stop group, then uninstall removes both", () => {
    const first = install();
    expect(first.ok).toBe(true);
    const config = settings();
    expect(config.hooks.PostToolUse[0].matcher).toBe(CAPTURE_POST_TOOL_USE_MATCHER);
    expect(config.hooks.Stop[0].hooks[0].command).toContain(CAPTURE_HOOK_MARKER);
    const command = config.hooks.PostToolUse[0].hooks[0].command as string;
    expect(command).toContain(join(home, ".flair/hooks/capture"));
    expect(command).toContain(RUNTIME.bunPath);
    expect(command).toContain("FLAIR_CAPTURE_FLUSH_SPEC=@tpsdev-ai/flair-mcp@");
    expect(command).not.toContain("npx -y -p");

    const status = captureHookStatus(home, "claude-code");
    expect(status.installed).toBe(true);
    expect(status.state).toBe("installed");

    expect(uninstallCaptureHooks({ homeDir: home, harness: "codex" }).ok).toBe(false);
    expect(captureHookStatus(home, "claude-code").installed).toBe(true);

    const removed = uninstallCaptureHooks({ homeDir: home, harness: "claude-code" });
    expect(removed.ok).toBe(true);
    const after = settings();
    expect(after.hooks?.PostToolUse ?? []).toEqual([]);
    expect(after.hooks?.Stop ?? []).toEqual([]);
    expect(existsSync(captureInstallRoot(home))).toBe(false);
  });

  it("refuses a non-Claude harness", () => {
    const result = install({ harness: "codex" });
    expect(result.ok).toBe(false);
    expect(existsSync(hookSettingsPath(home, "codex"))).toBe(false);
  });

  it("is idempotent, including the dry-run preview", () => {
    install();
    const again = install();
    expect(again.ok).toBe(true);
    expect(again.actions?.PostToolUse).toBe("noop");
    expect(again.actions?.Stop).toBe("noop");
    const preview = install({ dryRun: true });
    expect(preview.ok).toBe(true);
    expect(preview.actions?.PostToolUse).toBe("noop");
    expect(preview.actions?.Stop).toBe("noop");
  });

  it("provisioned files are private and the runtime dir is owner-only", () => {
    install();
    const durable = installedArtifact();
    expect(durable.startsWith(join(captureInstallRoot(home), `${flairCliVersion()}-`))).toBe(true);
    expect(statSync(dirname(dirname(durable))).mode & 0o777).toBe(0o700);
    expect(statSync(durable).mode & 0o777).toBe(0o600);
  });

  it("also wires alongside the SessionStart hook without disturbing it", () => {
    installHook({ homeDir: home, harness: "claude-code", agentId: "me", flairUrl: "http://localhost:19926" });
    install();
    const config = settings();
    expect(config.hooks.SessionStart[0].hooks[0].command).toContain("flair-session-start");
    expect(config.hooks.PostToolUse.length).toBe(1);
  });

  it("status re-probes the provisioned artifact and reports a broken one", () => {
    install();
    const durable = installedArtifact();
    const original = readFileSync(durable, "utf8");
    writeFileSync(durable, `#!/usr/bin/env bun\n// flair-capture-built@${flairCliVersion()}\nprocess.exit(0);\n`);
    const observed = captureHookStatus(home, "claude-code");
    expect(observed.installed).toBe(false);
    expect(observed.runtimeFailure).toContain("capture self-test failed");
    expect(observed.runtimeFailure).toContain(durable);
    // restore for the teardown sanity check
    writeFileSync(durable, original);
    expect(captureHookStatus(home, "claude-code").installed).toBe(true);
  });

  it("install upgrades a stale versioned hook and uninstall removes every version", () => {
    const oldPackage = join(captureInstallRoot(home), "0.0.1-old");
    mkdirSync(dirname(oldPackage), { recursive: true, mode: 0o700 });
    cpSync(dirname(dirname(RUNTIME.artifactPath)), oldPackage, { recursive: true });
    const oldArtifact = join(oldPackage, "dist/capture-hook.js");
    const pkgPath = join(oldPackage, "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    pkg.version = "0.0.1";
    writeFileSync(pkgPath, JSON.stringify(pkg));
    writeFileSync(oldArtifact, readFileSync(oldArtifact, "utf8").replace(`flair-capture-built@${flairCliVersion()}`, "flair-capture-built@0.0.1"));
    expect(install().ok).toBe(true);
    expect(installedArtifact()).not.toBe(oldArtifact);
    expect(captureHookStatus(home, "claude-code").installed).toBe(true);
    expect(uninstallCaptureHooks({ homeDir: home, harness: "claude-code" }).ok).toBe(true);
    expect(existsSync(oldPackage)).toBe(false);
  });

  it("status reports a half-install as partial, not installed", () => {
    install();
    const config = settings();
    delete config.hooks.Stop;
    writeFileSync(hookSettingsPath(home, "claude-code"), JSON.stringify(config));
    const observed = captureHookStatus(home, "claude-code");
    expect(observed.installed).toBe(false);
    expect(observed.state).toBe("partial");
  });
});
