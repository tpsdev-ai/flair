import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { spawnSync } from "node:child_process";
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
import {
  CAPTURE_HOOK_MARKER,
  CAPTURE_POST_TOOL_USE_FAILURE_MATCHER,
  CAPTURE_POST_TOOL_USE_MATCHER,
  buildCaptureHookCommand,
  captureFlushSpec,
  parseCaptureCommand,
} from "../../src/doctor-client.ts";
import { captureInstallRoot } from "../../src/lib/capture-runtime.ts";
import { flairCliVersion } from "../../src/lib/mcp-spec.ts";
import { createCaptureRuntime } from "../helpers/capture-runtime.ts";
import { lockPath, pendingPath } from "../../packages/flair-mcp/src/capture-spool.ts";

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
  for (const refusal of ["lock-busy", "write-failed"] as const) {
    it(`the installed command reports ${refusal} on stderr with empty stdout and exit 0`, () => {
      expect(install().ok).toBe(true);
      const config = settings();
      for (const event of ["PostToolUseFailure", "PostToolUse", "Stop"] as const) {
        config.hooks[event][0].hooks[0].command = config.hooks[event][0].hooks[0].command.replace(" >/dev/null || true'", " >/dev/null 2>/dev/null || true'");
      }
      writeFileSync(hookSettingsPath(home, "claude-code"), JSON.stringify(config));
      const repaired = install();
      expect(repaired.ok).toBe(true);
      const command = settings().hooks.PostToolUseFailure[0].hooks[0].command as string;
      const dir = join(home, ".flair", "capture");
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      if (refusal === "lock-busy") {
        writeFileSync(lockPath(dir, "me"), JSON.stringify({ pid: process.pid, nonce: "held" }), { flag: "wx", mode: 0o600 });
      } else {
        mkdirSync(pendingPath(dir, "me"));
      }
      const result = spawnSync("sh", ["-c", command], {
        env: { HOME: home, PATH: process.env.PATH, FLAIR_CAPTURE_DIR: dir },
        input: JSON.stringify({
          hook_event_name: "PostToolUseFailure",
          tool_name: "Bash",
          tool_input: { command: "bun test foo" },
          error: "Exit code 1\nError: boom",
        }),
        encoding: "utf8",
        timeout: 10_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(refusal === "lock-busy"
        ? "capture: a failed call was not recorded; append lock busy for 2000 ms"
        : "capture: could not write pending error: EISDIR");
      for (const event of ["PostToolUseFailure", "PostToolUse", "Stop"] as const) {
        expect(repaired.actions?.[event]).toBe("update");
        expect(settings().hooks[event]).toHaveLength(1);
      }
    }, 20_000);
  }

  it("dry-run leaves settings unchanged and provisions nothing", () => {
    const path = hookSettingsPath(home, "claude-code");
    const result = install({ dryRun: true });
    expect(result.ok).toBe(true);
    expect(result.actions?.PostToolUseFailure).toBe("add");
    expect(result.actions?.PostToolUse).toBe("add");
    expect(result.actions?.Stop).toBe("add");
    expect(existsSync(path)).toBe(false);
    expect(existsSync(captureInstallRoot(home))).toBe(false);
  });

  it("wires PostToolUseFailure and PostToolUse groups with their matchers and a Stop group, then uninstall removes all three", () => {
    const first = install();
    expect(first.ok).toBe(true);
    const config = settings();
    expect(config.hooks.PostToolUseFailure[0].matcher).toBe(CAPTURE_POST_TOOL_USE_FAILURE_MATCHER);
    expect(config.hooks.PostToolUseFailure[0].hooks[0].command).toBe(config.hooks.PostToolUse[0].hooks[0].command);
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
    expect(after.hooks?.PostToolUseFailure ?? []).toEqual([]);
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
    expect(again.actions?.PostToolUseFailure).toBe("noop");
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

  it("status probes the artifact named in settings and reports a broken one", () => {
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

  it("status accepts a probed artifact outside the provisioned directory", () => {
    expect(install().ok).toBe(true);
    expect(RUNTIME.artifactPath.startsWith(`${captureInstallRoot(home)}/`)).toBe(false);
    const config = settings();
    const command = buildCaptureHookCommand(RUNTIME.bunPath, RUNTIME.artifactPath, "me", "http://localhost:19926", captureFlushSpec());
    for (const event of ["PostToolUseFailure", "PostToolUse", "Stop"]) {
      config.hooks[event][0].hooks[0].command = command;
    }
    writeFileSync(hookSettingsPath(home, "claude-code"), JSON.stringify(config));
    expect(captureHookStatus(home, "claude-code").state).toBe("installed");
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

  it("status reports an install without PostToolUseFailure as partial, and install repairs it", () => {
    install();
    const config = settings();
    delete config.hooks.PostToolUseFailure;
    writeFileSync(hookSettingsPath(home, "claude-code"), JSON.stringify(config));
    expect(captureHookStatus(home, "claude-code").state).toBe("partial");
    const repaired = install();
    expect(repaired.actions?.PostToolUseFailure).toBe("add");
    expect(repaired.actions?.PostToolUse).toBe("noop");
    expect(captureHookStatus(home, "claude-code").installed).toBe(true);
  });

  it("status reports a drifted PostToolUseFailure matcher as stale", () => {
    install();
    const config = settings();
    config.hooks.PostToolUseFailure[0].matcher = "Write";
    writeFileSync(hookSettingsPath(home, "claude-code"), JSON.stringify(config));
    expect(captureHookStatus(home, "claude-code").state).toBe("stale");
  });

  it("status names an event whose command differs, and reports not installed", () => {
    install();
    const config = settings();
    config.hooks.PostToolUse[0].hooks[0].command = config.hooks.PostToolUse[0].hooks[0].command.replace("FLAIR_AGENT_ID=me", "FLAIR_AGENT_ID=other");
    writeFileSync(hookSettingsPath(home, "claude-code"), JSON.stringify(config));
    const observed = captureHookStatus(home, "claude-code");
    expect(observed.installed).toBe(false);
    expect(observed.state).toBe("stale");
    expect(observed.problems.some((problem) => problem.includes("PostToolUse") && problem.includes("different"))).toBe(true);
  });

  it("status names a missing event", () => {
    install();
    const config = settings();
    delete config.hooks.PostToolUseFailure;
    writeFileSync(hookSettingsPath(home, "claude-code"), JSON.stringify(config));
    const observed = captureHookStatus(home, "claude-code");
    expect(observed.state).toBe("partial");
    expect(observed.problems).toContain("PostToolUseFailure missing");
  });

  it("uninstall removes every matching capture entry for each event, including duplicates", () => {
    install();
    const config = settings();
    config.hooks.PostToolUse.push(JSON.parse(JSON.stringify(config.hooks.PostToolUse[0])));
    config.hooks.Stop[0].hooks.push({ type: "command", command: config.hooks.Stop[0].hooks[0].command });
    writeFileSync(hookSettingsPath(home, "claude-code"), JSON.stringify(config));
    const removed = uninstallCaptureHooks({ homeDir: home, harness: "claude-code" });
    expect(removed.ok).toBe(true);
    const after = settings();
    expect(after.hooks?.PostToolUse ?? []).toEqual([]);
    expect(after.hooks?.Stop ?? []).toEqual([]);
    expect(after.hooks?.PostToolUseFailure ?? []).toEqual([]);
  });
  for (const spec of ["missing", "@tpsdev-ai/flair-mcp@0.0.1", "@other/package@0.59.0"]) {
    it(`status rejects the ${spec} flush spec in a settings file`, () => {
      expect(install().ok).toBe(true);
      const config = settings();
      for (const event of ["PostToolUseFailure", "PostToolUse", "Stop"]) {
        const command = config.hooks[event][0].hooks[0].command;
        config.hooks[event][0].hooks[0].command = command.replace(
          / FLAIR_CAPTURE_FLUSH_SPEC=\S+/,
          spec === "missing" ? "" : ` FLAIR_CAPTURE_FLUSH_SPEC=${spec}`,
        );
      }
      writeFileSync(hookSettingsPath(home, "claude-code"), JSON.stringify(config));
      const observed = captureHookStatus(home, "claude-code");
      expect(observed.installed).toBe(false);
      expect(observed.runtimeFailure).toContain("current flush spec");
    });
  }

  for (const variant of ["identical", "different command", "different matcher"]) {
    it(`status rejects a duplicate with ${variant} in a settings file`, () => {
      expect(install().ok).toBe(true);
      const config = settings();
      const duplicate = JSON.parse(JSON.stringify(config.hooks.PostToolUse[0]));
      if (variant === "different command") duplicate.hooks[0].command = duplicate.hooks[0].command.replace("FLAIR_AGENT_ID=me", "FLAIR_AGENT_ID=other");
      if (variant === "different matcher") duplicate.matcher = "Read";
      config.hooks.PostToolUse.push(duplicate);
      config.hooks.Stop[0].hooks.push({ ...config.hooks.Stop[0].hooks[0] });
      writeFileSync(hookSettingsPath(home, "claude-code"), JSON.stringify(config));
      const observed = captureHookStatus(home, "claude-code");
      expect(observed.installed).toBe(false);
      expect(observed.problems).toContain("PostToolUse has duplicate capture entries");
      expect(observed.problems).toContain("Stop has duplicate capture entries");
      if (variant === "different command") expect(observed.problems).toContain("PostToolUse carries a different command");
      if (variant === "different matcher") expect(observed.problems).toContain("PostToolUse carries an unexpected matcher");
    });
  }

});
