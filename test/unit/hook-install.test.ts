import { describe, it, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  installHook,
  uninstallHook,
  hookStatus,
  buildHookCommand,
  parseHookCommandEnv,
  hookSettingsPath,
  hookBackupPath,
  isSupportedHarness,
  SUPPORTED_HARNESSES,
} from "../../src/hook-install.ts";
import { SESSION_START_HOOK_MARKER, checkSessionStartHook } from "../../src/doctor-client.ts";
// NOTE: the degradation-timeout test (Sherlock condition 5, "mock the
// fetch") lives in packages/flair-mcp/test/session-start-hook.test.ts, NOT
// here. That file already imports runHook (which transitively imports
// @tpsdev-ai/flair-client, resolved via its BUILT dist/), and CI's
// `bun test test/unit/` step (this file's step) runs BEFORE the
// "Build flair-client" step — a runHook import here would pass locally
// (dist/ already built in this dev session) but break that CI gate. The
// TLS-bypass-pattern scan below reads source files as plain text (no module
// import), so it has no such ordering dependency and stays here.

/**
 * flair#745 — `flair hook install|uninstall|status`. Pure filesystem logic
 * (no network), so this mirrors doctor-client.test.ts's isolation technique:
 * a fresh temp dir stands in for HOME on every test, torn down after. Never
 * touches the real ~/.claude/settings.json or ~/.flair.
 *
 * Design record: https://github.com/tpsdev-ai/flair/issues/719 (the
 * `flair hook install` section) + Sherlock's binding review conditions on
 * that thread. See src/hook-install.ts's module doc for the full mapping.
 */

let isoHome: string;

beforeEach(() => {
  isoHome = mkdtempSync(join(tmpdir(), "flair-hook-home-"));
});

afterEach(() => {
  rmSync(isoHome, { recursive: true, force: true });
});

const AGENT = "flint";
const URL = "http://127.0.0.1:19926";

describe("harness registry", () => {
  it("claude-code is supported", () => {
    expect(isSupportedHarness("claude-code")).toBe(true);
    expect(SUPPORTED_HARNESSES).toContain("claude-code");
  });

  it("an unknown harness is rejected", () => {
    expect(isSupportedHarness("cursor")).toBe(false);
    expect(isSupportedHarness("gemini")).toBe(false);
    expect(isSupportedHarness("")).toBe(false);
  });
});

describe("buildHookCommand / parseHookCommandEnv", () => {
  it("round-trips agentId and flairUrl through the command string", () => {
    const command = buildHookCommand(AGENT, URL);
    expect(command).toContain(SESSION_START_HOOK_MARKER);
    expect(command).toContain("npx -y @tpsdev-ai/flair-mcp");
    const parsed = parseHookCommandEnv(command);
    expect(parsed.agentId).toBe(AGENT);
    expect(parsed.flairUrl).toBe(URL);
  });

  it("doctor's own marker constant is present verbatim (checkSessionStartHook compatibility)", () => {
    const command = buildHookCommand(AGENT, URL);
    expect(command.includes(SESSION_START_HOOK_MARKER)).toBe(true);
  });
});

describe("installHook — fresh install", () => {
  it("creates ~/.claude/settings.json and wires the hook when absent", () => {
    const result = installHook({ homeDir: isoHome, harness: "claude-code", agentId: AGENT, flairUrl: URL, dryRun: false });
    expect(result.ok).toBe(true);
    expect(result.delta?.action).toBe("add");
    expect(result.backupPath).toBeNull(); // nothing existed to back up

    const path = hookSettingsPath(isoHome, "claude-code");
    expect(existsSync(path)).toBe(true);
    const config = JSON.parse(readFileSync(path, "utf-8"));
    const commands = config.hooks.SessionStart.flatMap((g: any) => g.hooks.map((h: any) => h.command));
    expect(commands.some((c: string) => c.includes(SESSION_START_HOOK_MARKER) && c.includes(`FLAIR_AGENT_ID=${AGENT}`) && c.includes(`FLAIR_URL=${URL}`))).toBe(true);
  });

  it("creates the ~/.claude directory when it doesn't exist yet", () => {
    expect(existsSync(join(isoHome, ".claude"))).toBe(false);
    const result = installHook({ homeDir: isoHome, harness: "claude-code", agentId: AGENT, flairUrl: URL });
    expect(result.ok).toBe(true);
    expect(existsSync(join(isoHome, ".claude"))).toBe(true);
  });
});

describe("installHook — idempotent re-run", () => {
  it("a second identical call is a byte-for-byte no-op", () => {
    installHook({ homeDir: isoHome, harness: "claude-code", agentId: AGENT, flairUrl: URL });
    const path = hookSettingsPath(isoHome, "claude-code");
    const firstContent = readFileSync(path, "utf-8");

    const result2 = installHook({ homeDir: isoHome, harness: "claude-code", agentId: AGENT, flairUrl: URL });
    expect(result2.ok).toBe(true);
    expect(result2.delta?.action).toBe("noop");

    const secondContent = readFileSync(path, "utf-8");
    expect(secondContent).toBe(firstContent);

    // No duplicate group/hook.
    const config = JSON.parse(secondContent);
    expect(config.hooks.SessionStart.length).toBe(1);
    expect(config.hooks.SessionStart[0].hooks.length).toBe(1);
  });

  it("re-running with a different agent/url UPDATES the one entry in place (no duplicate)", () => {
    installHook({ homeDir: isoHome, harness: "claude-code", agentId: AGENT, flairUrl: URL });
    const result2 = installHook({ homeDir: isoHome, harness: "claude-code", agentId: "other-agent", flairUrl: "http://127.0.0.1:9999" });
    expect(result2.ok).toBe(true);
    expect(result2.delta?.action).toBe("update");

    const path = hookSettingsPath(isoHome, "claude-code");
    const config = JSON.parse(readFileSync(path, "utf-8"));
    expect(config.hooks.SessionStart.length).toBe(1);
    expect(config.hooks.SessionStart[0].hooks.length).toBe(1);
    const command = config.hooks.SessionStart[0].hooks[0].command;
    expect(command).toContain("FLAIR_AGENT_ID=other-agent");
    expect(command).toContain("FLAIR_URL=http://127.0.0.1:9999");
  });

  it("merge-safe: preserves unrelated top-level keys and other hook types/groups", () => {
    mkdirSync(join(isoHome, ".claude"), { recursive: true });
    writeFileSync(
      join(isoHome, ".claude", "settings.json"),
      JSON.stringify({
        theme: "dark",
        hooks: {
          PreToolUse: [{ hooks: [{ type: "command", command: "some-other-hook" }] }],
          SessionStart: [{ hooks: [{ type: "command", command: "unrelated-session-hook" }] }],
        },
      }),
    );
    const result = installHook({ homeDir: isoHome, harness: "claude-code", agentId: AGENT, flairUrl: URL });
    expect(result.ok).toBe(true);
    expect(result.delta?.action).toBe("add");

    const config = JSON.parse(readFileSync(hookSettingsPath(isoHome, "claude-code"), "utf-8"));
    expect(config.theme).toBe("dark");
    expect(config.hooks.PreToolUse[0].hooks[0].command).toBe("some-other-hook");
    const sessionStartCommands = config.hooks.SessionStart.flatMap((g: any) => g.hooks.map((h: any) => h.command));
    expect(sessionStartCommands).toContain("unrelated-session-hook");
    expect(sessionStartCommands.some((c: string) => c.includes(SESSION_START_HOOK_MARKER))).toBe(true);
    expect(config.hooks.SessionStart.length).toBe(2); // unrelated group + ours, never merged into one
  });
});

describe("installHook — malformed settings.json fails CLOSED", () => {
  it("refuses to touch the file, backs it up first, and reports the error", () => {
    const path = hookSettingsPath(isoHome, "claude-code");
    mkdirSync(join(isoHome, ".claude"), { recursive: true });
    const malformed = "{ not valid json, definitely broken";
    writeFileSync(path, malformed);

    const result = installHook({ homeDir: isoHome, harness: "claude-code", agentId: AGENT, flairUrl: URL });
    expect(result.ok).toBe(false);
    expect(result.delta).toBeNull();

    // Original file is byte-for-byte untouched — never truncated, never a
    // partial replacement.
    expect(readFileSync(path, "utf-8")).toBe(malformed);

    // A backup was taken BEFORE the parse attempt, and it holds the same
    // (malformed) content — recovery insurance regardless of outcome.
    expect(result.backupPath).toBe(hookBackupPath(path));
    expect(existsSync(result.backupPath!)).toBe(true);
    expect(readFileSync(result.backupPath!, "utf-8")).toBe(malformed);
  });

  it("uninstall also fails closed on malformed JSON (backup exists, file untouched)", () => {
    const path = hookSettingsPath(isoHome, "claude-code");
    mkdirSync(join(isoHome, ".claude"), { recursive: true });
    const malformed = "not json at all {{{";
    writeFileSync(path, malformed);

    const result = uninstallHook({ homeDir: isoHome, harness: "claude-code" });
    expect(result.ok).toBe(false);
    expect(readFileSync(path, "utf-8")).toBe(malformed);
    expect(result.backupPath).toBe(hookBackupPath(path));
    expect(readFileSync(result.backupPath!, "utf-8")).toBe(malformed);
  });

  it("status never throws on malformed JSON — reports parseError instead", () => {
    const path = hookSettingsPath(isoHome, "claude-code");
    mkdirSync(join(isoHome, ".claude"), { recursive: true });
    writeFileSync(path, "{ broken");
    const status = hookStatus(isoHome, "claude-code");
    expect(status.wired).toBe(false);
    expect(status.parseError).toBeTruthy();
  });
});

describe("installHook — --dry-run writes nothing", () => {
  it("fresh install: no file is created, delta describes the add", () => {
    const result = installHook({ homeDir: isoHome, harness: "claude-code", agentId: AGENT, flairUrl: URL, dryRun: true });
    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.delta?.action).toBe("add");
    expect(result.delta?.after?.hooks[0].command).toContain(SESSION_START_HOOK_MARKER);
    expect(result.backupPath).toBeNull();

    expect(existsSync(hookSettingsPath(isoHome, "claude-code"))).toBe(false);
    expect(existsSync(join(isoHome, ".claude"))).toBe(false); // not even the parent dir
  });

  it("already-correct: delta is a noop, still nothing written", () => {
    installHook({ homeDir: isoHome, harness: "claude-code", agentId: AGENT, flairUrl: URL });
    const path = hookSettingsPath(isoHome, "claude-code");
    const before = readFileSync(path, "utf-8");

    const result = installHook({ homeDir: isoHome, harness: "claude-code", agentId: AGENT, flairUrl: URL, dryRun: true });
    expect(result.ok).toBe(true);
    expect(result.delta?.action).toBe("noop");
    expect(readFileSync(path, "utf-8")).toBe(before);
    expect(existsSync(hookBackupPath(path))).toBe(false); // dry-run never backs up either
  });

  it("dry-run on a malformed file reports the error without writing or backing up", () => {
    const path = hookSettingsPath(isoHome, "claude-code");
    mkdirSync(join(isoHome, ".claude"), { recursive: true });
    const malformed = "{{{ broken";
    writeFileSync(path, malformed);

    const result = installHook({ homeDir: isoHome, harness: "claude-code", agentId: AGENT, flairUrl: URL, dryRun: true });
    expect(result.ok).toBe(false);
    expect(readFileSync(path, "utf-8")).toBe(malformed);
    expect(existsSync(hookBackupPath(path))).toBe(false);
  });

  it("uninstall --dry-run also writes nothing", () => {
    installHook({ homeDir: isoHome, harness: "claude-code", agentId: AGENT, flairUrl: URL });
    const path = hookSettingsPath(isoHome, "claude-code");
    const before = readFileSync(path, "utf-8");

    const result = uninstallHook({ homeDir: isoHome, harness: "claude-code", dryRun: true });
    expect(result.ok).toBe(true);
    expect(result.delta?.action).toBe("remove");
    expect(readFileSync(path, "utf-8")).toBe(before);
  });
});

describe("uninstallHook — removes only ours", () => {
  it("no-op when nothing is installed — never creates a file", () => {
    const result = uninstallHook({ homeDir: isoHome, harness: "claude-code" });
    expect(result.ok).toBe(true);
    expect(result.delta?.action).toBe("noop");
    expect(existsSync(hookSettingsPath(isoHome, "claude-code"))).toBe(false);
  });

  it("removes ONLY the flair group, preserving unrelated hooks and top-level keys", () => {
    const path = hookSettingsPath(isoHome, "claude-code");
    mkdirSync(join(isoHome, ".claude"), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        theme: "dark",
        hooks: {
          PreToolUse: [{ hooks: [{ type: "command", command: "some-other-hook" }] }],
          SessionStart: [
            { hooks: [{ type: "command", command: "unrelated-session-hook" }] },
            { hooks: [{ type: "command", command: buildHookCommand(AGENT, URL) }] },
          ],
        },
      }),
    );

    const result = uninstallHook({ homeDir: isoHome, harness: "claude-code" });
    expect(result.ok).toBe(true);
    expect(result.delta?.action).toBe("remove");

    const config = JSON.parse(readFileSync(path, "utf-8"));
    expect(config.theme).toBe("dark");
    expect(config.hooks.PreToolUse[0].hooks[0].command).toBe("some-other-hook");
    expect(config.hooks.SessionStart.length).toBe(1);
    expect(config.hooks.SessionStart[0].hooks[0].command).toBe("unrelated-session-hook");
  });

  it("tidies up empty hooks/SessionStart when ours was the only entry", () => {
    installHook({ homeDir: isoHome, harness: "claude-code", agentId: AGENT, flairUrl: URL });
    const result = uninstallHook({ homeDir: isoHome, harness: "claude-code" });
    expect(result.ok).toBe(true);

    const path = hookSettingsPath(isoHome, "claude-code");
    const config = JSON.parse(readFileSync(path, "utf-8"));
    expect(config.hooks?.SessionStart).toBeUndefined();
  });

  it("a second uninstall is a clean no-op", () => {
    installHook({ homeDir: isoHome, harness: "claude-code", agentId: AGENT, flairUrl: URL });
    uninstallHook({ homeDir: isoHome, harness: "claude-code" });
    const result2 = uninstallHook({ homeDir: isoHome, harness: "claude-code" });
    expect(result2.ok).toBe(true);
    expect(result2.delta?.action).toBe("noop");
  });

  it("backup is taken before a real (non-dry-run) removal, even though it's redundant post-hoc insurance", () => {
    installHook({ homeDir: isoHome, harness: "claude-code", agentId: AGENT, flairUrl: URL });
    const result = uninstallHook({ homeDir: isoHome, harness: "claude-code" });
    expect(result.backupPath).toBe(hookBackupPath(hookSettingsPath(isoHome, "claude-code")));
    expect(existsSync(result.backupPath!)).toBe(true);
  });
});

describe("hookStatus", () => {
  it("not wired when settings.json doesn't exist", () => {
    const status = hookStatus(isoHome, "claude-code");
    expect(status.wired).toBe(false);
    expect(status.correctShape).toBe(false);
    expect(status.parseError).toBeNull();
  });

  it("wired + correctShape + recovers agentId/flairUrl after a real install", () => {
    installHook({ homeDir: isoHome, harness: "claude-code", agentId: AGENT, flairUrl: URL });
    const status = hookStatus(isoHome, "claude-code");
    expect(status.wired).toBe(true);
    expect(status.correctShape).toBe(true);
    expect(status.agentId).toBe(AGENT);
    expect(status.flairUrl).toBe(URL);
  });

  it("wired but NOT correctShape for a hand-edited command that merely contains the marker", () => {
    const path = hookSettingsPath(isoHome, "claude-code");
    mkdirSync(join(isoHome, ".claude"), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: `echo ${SESSION_START_HOOK_MARKER}-decoy` }] }] } }),
    );
    const status = hookStatus(isoHome, "claude-code");
    expect(status.wired).toBe(true);
    expect(status.correctShape).toBe(false);
  });
});

describe("doctor compatibility — checkSessionStartHook recognizes what installHook writes", () => {
  it("flair doctor's existing marker-substring check sees a fresh install as present, with zero changes to that check", () => {
    installHook({ homeDir: isoHome, harness: "claude-code", agentId: AGENT, flairUrl: URL });
    const doctorView = checkSessionStartHook(isoHome);
    expect(doctorView.present).toBe(true);
  });

  it("and sees an uninstall as absent again", () => {
    installHook({ homeDir: isoHome, harness: "claude-code", agentId: AGENT, flairUrl: URL });
    uninstallHook({ homeDir: isoHome, harness: "claude-code" });
    const doctorView = checkSessionStartHook(isoHome);
    expect(doctorView.present).toBe(false);
  });
});

describe("TLS-bypass-pattern scan (Sherlock condition 4)", () => {
  // Static source scan — the hook shells out via packages/flair-mcp's
  // session-start-hook.ts, which authenticates through FlairClient
  // (packages/flair-client). None of that chain may EVER disable TLS
  // certificate validation, on a local OR a remote FLAIR_URL.
  const SCANNED_FILES = [
    "packages/flair-mcp/src/session-start-hook.ts",
    "packages/flair-mcp/src/presence.ts",
    "packages/flair-client/src/client.ts",
    "packages/flair-client/src/auth.ts",
    "src/hook-install.ts",
  ];

  const FORBIDDEN_PATTERNS = [
    /NODE_TLS_REJECT_UNAUTHORIZED/,
    /rejectUnauthorized\s*[:=]\s*false/i,
    /checkServerIdentity\s*[:=]\s*\(\s*\)\s*=>\s*(undefined|true)/,
    /\bhttps\.Agent\s*\(\s*\{\s*rejectUnauthorized/i,
  ];

  const ROOT = join(__dirname, "..", "..");

  for (const rel of SCANNED_FILES) {
    test(`${rel} contains no TLS-bypass pattern`, () => {
      const path = join(ROOT, rel);
      expect(existsSync(path)).toBe(true);
      const source = readFileSync(path, "utf-8");
      for (const pattern of FORBIDDEN_PATTERNS) {
        expect(pattern.test(source)).toBe(false);
      }
    });
  }
});
