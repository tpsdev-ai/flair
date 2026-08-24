import { describe, it, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  installHook,
  uninstallHook,
  hookStatus,
  hookStatusIdentityLines,
  HOOK_STATUS_UNPARSED,
  buildHookCommand,
  buildContinuityHookCommand,
  installContinuityHooks,
  uninstallContinuityHooks,
  continuityHookStatus,
  parseHookCommandEnv,
  hookSettingsPath,
  hookBackupPath,
  isSupportedHarness,
  SUPPORTED_HARNESSES,
} from "../../src/hook-install.ts";
import {
  SESSION_START_HOOK_MARKER,
  CONTINUITY_CAPTURE_HOOK_MARKER,
  buildContinuityCaptureHookCommand,
  buildSessionStartHookCommand,
  checkSessionStartHook,
  fixSessionStartHook,
} from "../../src/doctor-client.ts";
import { mcpServerSpec } from "../../src/lib/mcp-spec.ts";
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

  it("codex is supported (flair#1148) and writes ~/.codex/hooks.json", () => {
    expect(isSupportedHarness("codex")).toBe(true);
    expect(SUPPORTED_HARNESSES).toContain("codex");
    expect(hookSettingsPath(isoHome, "codex")).toBe(join(isoHome, ".codex", "hooks.json"));
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
    expect(command).toContain(`npx -y -p ${mcpServerSpec()} ${SESSION_START_HOOK_MARKER}`);
    const parsed = parseHookCommandEnv(command);
    expect(parsed.agentId).toBe(AGENT);
    expect(parsed.flairUrl).toBe(URL);
  });

  it("reads agentId from the installer sh -c wrapper when FLAIR_URL is omitted (flair init / docs form)", () => {
    // flair#1325: `flair init` and docs/mcp-clients.md write this exact
    // command — sh -c, FLAIR_AGENT_ID, no FLAIR_URL. Missing URL is
    // intentional (hook falls back to flair-client's localhost default),
    // not a parse failure, and must not produce a garbage capture from
    // the wrapper's `$(...)`.
    const command = buildSessionStartHookCommand("canary");
    expect(command.startsWith("sh -c '")).toBe(true);
    expect(command).not.toContain("FLAIR_URL=");
    const parsed = parseHookCommandEnv(command);
    expect(parsed.agentId).toBe("canary");
    expect(parsed.flairUrl).toBeUndefined();
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

  it("re-running upgrades a pre-#1143 unpinned hook to the current pin", () => {
    const path = hookSettingsPath(isoHome, "claude-code");
    mkdirSync(join(isoHome, ".claude"), { recursive: true });
    const unpinned = `sh -c 'out=$(FLAIR_AGENT_ID=${AGENT} FLAIR_URL=${URL} npx -y -p @tpsdev-ai/flair-mcp ${SESSION_START_HOOK_MARKER} 2>/dev/null) && printf %s "$out" || true'`;
    writeFileSync(
      path,
      JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: unpinned }] }] } }),
    );
    const result = installHook({ homeDir: isoHome, harness: "claude-code", agentId: AGENT, flairUrl: URL });
    expect(result.ok).toBe(true);
    expect(result.delta?.action).toBe("update");
    const config = JSON.parse(readFileSync(path, "utf-8"));
    const command = config.hooks.SessionStart[0].hooks[0].command;
    expect(command).toContain(`npx -y -p ${mcpServerSpec()} ${SESSION_START_HOOK_MARKER}`);
    expect(command).not.toBe(unpinned);
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
    expect(status.command).toContain(`npx -y -p ${mcpServerSpec()} ${SESSION_START_HOOK_MARKER}`);
  });

  it("still treats a pre-#1143 unpinned -p invocation as correctShape", () => {
    const path = hookSettingsPath(isoHome, "claude-code");
    mkdirSync(join(isoHome, ".claude"), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        hooks: {
          SessionStart: [
            {
              hooks: [
                {
                  type: "command",
                  command: `sh -c 'out=$(FLAIR_AGENT_ID=${AGENT} npx -y -p @tpsdev-ai/flair-mcp ${SESSION_START_HOOK_MARKER} 2>/dev/null) && printf %s "$out" || true'`,
                },
              ],
            },
          ],
        },
      }),
    );
    const status = hookStatus(isoHome, "claude-code");
    expect(status.wired).toBe(true);
    expect(status.correctShape).toBe(true);
    expect(status.agentId).toBe(AGENT);
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

  it("wired but NOT correctShape for the pre-#1166 form (missing -p) — doctor must still flag it", () => {
    // flair#1166: the old form `npx -y @tpsdev-ai/flair-mcp flair-session-start`
    // runs the shim, not the binary. correctShape must reject it so doctor
    // flags it and --fix re-wires to the -p form.
    const path = hookSettingsPath(isoHome, "claude-code");
    mkdirSync(join(isoHome, ".claude"), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: `FLAIR_AGENT_ID=${AGENT} npx -y @tpsdev-ai/flair-mcp ${SESSION_START_HOOK_MARKER}` }] }] } }),
    );
    const status = hookStatus(isoHome, "claude-code");
    expect(status.wired).toBe(true);
    expect(status.correctShape).toBe(false);
  });

  it("after a docs-faithful flair init install, status does not emit the unknown-URL line (flair#1325)", () => {
    // `flair init --agent canary` writes via fixSessionStartHook →
    // buildSessionStartHookCommand(agentId) — the sh -c wrapper, no
    // FLAIR_URL. Wired-detection already saw this as ours; the identity
    // lines must not claim the command was unparseable.
    const fix = fixSessionStartHook(isoHome, "canary");
    expect(fix.ok).toBe(true);

    const status = hookStatus(isoHome, "claude-code");
    expect(status.wired).toBe(true);
    expect(status.correctShape).toBe(true);
    expect(status.agentId).toBe("canary");
    expect(status.flairUrl).toBeUndefined();
    expect(status.command?.startsWith("sh -c '")).toBe(true);

    const lines = hookStatusIdentityLines(status);
    const rendered = lines.map((l) => `${l.label}: ${l.value}`).join("\n");
    expect(rendered).not.toContain(HOOK_STATUS_UNPARSED);
    expect(lines).toEqual([{ label: "Agent", value: "canary" }]);
  });

  it("hook install (URL present) still prints the recovered Flair URL", () => {
    installHook({ homeDir: isoHome, harness: "claude-code", agentId: AGENT, flairUrl: URL });
    const lines = hookStatusIdentityLines(hookStatus(isoHome, "claude-code"));
    expect(lines).toEqual([
      { label: "Agent", value: AGENT },
      { label: "Flair URL", value: URL },
    ]);
  });

  it("an unrelated SessionStart hook is not a false all-clear", () => {
    const path = hookSettingsPath(isoHome, "claude-code");
    mkdirSync(join(isoHome, ".claude"), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "unrelated-session-hook" }] }] } }),
    );
    const status = hookStatus(isoHome, "claude-code");
    expect(status.wired).toBe(false);
    expect(status.correctShape).toBe(false);
  });

  it("a marker-only decoy stays wired-but-unparsed (unknown lines, not a silent omit)", () => {
    const path = hookSettingsPath(isoHome, "claude-code");
    mkdirSync(join(isoHome, ".claude"), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: `echo ${SESSION_START_HOOK_MARKER}-decoy` }] }] } }),
    );
    const status = hookStatus(isoHome, "claude-code");
    expect(status.wired).toBe(true);
    expect(status.correctShape).toBe(false);
    expect(hookStatusIdentityLines(status)).toEqual([
      { label: "Agent", value: HOOK_STATUS_UNPARSED },
      { label: "Flair URL", value: HOOK_STATUS_UNPARSED },
    ]);
  });

  it("wired correct-shape with no env assignments is not a silent all-clear", () => {
    // correctShape is the `npx -y -p` invocation (pinned or not). A command
    // that matches that but carries no FLAIR_AGENT_ID is not the
    // installer-no-URL form; omitting the unknown lines would print a clean
    // wired result with neither values nor a parse warning.
    const path = hookSettingsPath(isoHome, "claude-code");
    mkdirSync(join(isoHome, ".claude"), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        hooks: {
          SessionStart: [
            {
              hooks: [
                {
                  type: "command",
                  command: `npx -y -p @tpsdev-ai/flair-mcp ${SESSION_START_HOOK_MARKER}`,
                },
              ],
            },
          ],
        },
      }),
    );
    const status = hookStatus(isoHome, "claude-code");
    expect(status.wired).toBe(true);
    expect(status.correctShape).toBe(true);
    expect(status.agentId).toBeUndefined();
    expect(status.flairUrl).toBeUndefined();
    expect(hookStatusIdentityLines(status)).toEqual([
      { label: "Agent", value: HOOK_STATUS_UNPARSED },
      { label: "Flair URL", value: HOOK_STATUS_UNPARSED },
    ]);
  });
});

describe("codex harness — installer + doctor output (flair#1148)", () => {
  it("fresh install creates ~/.codex/hooks.json and reports the add", () => {
    const result = installHook({ homeDir: isoHome, harness: "codex", agentId: AGENT, flairUrl: URL });
    expect(result.ok).toBe(true);
    expect(result.delta?.action).toBe("add");
    expect(result.message).toContain(join(isoHome, ".codex", "hooks.json"));
    expect(result.message).toMatch(/added the SessionStart hook/);

    const path = hookSettingsPath(isoHome, "codex");
    expect(existsSync(path)).toBe(true);
    expect(existsSync(join(isoHome, ".claude"))).toBe(false); // never touches Claude Code
    const config = JSON.parse(readFileSync(path, "utf-8"));
    const commands = config.hooks.SessionStart.flatMap((g: any) => g.hooks.map((h: any) => h.command));
    expect(commands.some((c: string) => c.includes(SESSION_START_HOOK_MARKER) && c.includes(`FLAIR_AGENT_ID=${AGENT}`) && c.includes(`FLAIR_URL=${URL}`))).toBe(true);
  });

  it("status recovers agent/url and doctor sees the Codex path as present", () => {
    installHook({ homeDir: isoHome, harness: "codex", agentId: AGENT, flairUrl: URL });
    const status = hookStatus(isoHome, "codex");
    expect(status.harness).toBe("codex");
    expect(status.path).toBe(join(isoHome, ".codex", "hooks.json"));
    expect(status.wired).toBe(true);
    expect(status.correctShape).toBe(true);
    expect(status.agentId).toBe(AGENT);
    expect(status.flairUrl).toBe(URL);

    const doctorView = checkSessionStartHook(isoHome, status.path);
    expect(doctorView.present).toBe(true);
    expect(doctorView.path).toBe(status.path);
    expect(doctorView.command).toContain(SESSION_START_HOOK_MARKER);

    // Default doctor check stays Claude-Code-scoped — a Codex-only install
    // must not look like a Claude Code hook.
    expect(checkSessionStartHook(isoHome).present).toBe(false);
  });

  it("uninstall removes only the Codex hook file entry and doctor then reports absent", () => {
    installHook({ homeDir: isoHome, harness: "codex", agentId: AGENT, flairUrl: URL });
    const result = uninstallHook({ homeDir: isoHome, harness: "codex" });
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/removed the Flair SessionStart hook/);
    expect(result.message).toContain(join(isoHome, ".codex", "hooks.json"));

    const status = hookStatus(isoHome, "codex");
    expect(status.wired).toBe(false);
    expect(checkSessionStartHook(isoHome, hookSettingsPath(isoHome, "codex")).present).toBe(false);
  });

  it("a Codex install does not satisfy a Claude Code status check (and vice versa)", () => {
    installHook({ homeDir: isoHome, harness: "codex", agentId: AGENT, flairUrl: URL });
    expect(hookStatus(isoHome, "claude-code").wired).toBe(false);
    installHook({ homeDir: isoHome, harness: "claude-code", agentId: AGENT, flairUrl: URL });
    expect(hookStatus(isoHome, "claude-code").wired).toBe(true);
    expect(hookStatus(isoHome, "codex").wired).toBe(true);
    expect(hookSettingsPath(isoHome, "claude-code")).not.toBe(hookSettingsPath(isoHome, "codex"));
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

// ─── flair#1257 slice 2 — `flair hook install|uninstall --continuity` ────────
// Same Sherlock conditions as the SessionStart family above: fail-closed on
// malformed settings.json, backup before any real mutation, idempotent merge,
// dry-run computes without writing, symmetric removal.

describe("continuity hook install/uninstall/status wrappers", () => {
  const settingsPath = () => hookSettingsPath(isoHome, "claude-code");

  it("buildContinuityHookCommand delegates to the ONE doctor-client builder (no second literal)", () => {
    expect(buildContinuityHookCommand(AGENT, URL)).toBe(buildContinuityCaptureHookCommand(AGENT, URL));
    expect(buildContinuityHookCommand(AGENT, URL)).toContain(CONTINUITY_CAPTURE_HOOK_MARKER);
  });

  it("fresh install wires both events; status reads installed; re-run is a no-op", () => {
    const first = installContinuityHooks({ homeDir: isoHome, harness: "claude-code", agentId: AGENT, flairUrl: URL });
    expect(first.ok).toBe(true);
    expect(first.actions).toEqual({ PostToolUse: "add", Stop: "add" });
    expect(first.backupPath).toBeNull(); // nothing existed to back up

    expect(continuityHookStatus(isoHome, "claude-code").state).toBe("installed");

    const again = installContinuityHooks({ homeDir: isoHome, harness: "claude-code", agentId: AGENT, flairUrl: URL });
    expect(again.ok).toBe(true);
    expect(again.actions).toEqual({ PostToolUse: "noop", Stop: "noop" });
  });

  it("--dry-run computes the delta and writes NOTHING (no file, no backup)", () => {
    const dry = installContinuityHooks({ homeDir: isoHome, harness: "claude-code", agentId: AGENT, flairUrl: URL, dryRun: true });
    expect(dry.ok).toBe(true);
    expect(dry.actions).toEqual({ PostToolUse: "add", Stop: "add" });
    expect(existsSync(settingsPath())).toBe(false);
    expect(existsSync(hookBackupPath(settingsPath()))).toBe(false);
  });

  it("a real mutation of an existing file takes a backup FIRST", () => {
    mkdirSync(join(isoHome, ".claude"), { recursive: true });
    writeFileSync(settingsPath(), JSON.stringify({ model: "opus" }));
    const res = installContinuityHooks({ homeDir: isoHome, harness: "claude-code", agentId: AGENT, flairUrl: URL });
    expect(res.ok).toBe(true);
    expect(res.backupPath).toBe(hookBackupPath(settingsPath()));
    expect(JSON.parse(readFileSync(res.backupPath!, "utf-8"))).toEqual({ model: "opus" });
  });

  it("malformed settings.json FAILS CLOSED — refuses to touch the file, backup already taken", () => {
    mkdirSync(join(isoHome, ".claude"), { recursive: true });
    writeFileSync(settingsPath(), "{ this is not json");
    const res = installContinuityHooks({ homeDir: isoHome, harness: "claude-code", agentId: AGENT, flairUrl: URL });
    expect(res.ok).toBe(false);
    expect(readFileSync(settingsPath(), "utf-8")).toBe("{ this is not json"); // untouched
    expect(res.backupPath).toBe(hookBackupPath(settingsPath()));
  });

  it("unsafe agent id / URL is REFUSED before any write or backup", () => {
    const res = installContinuityHooks({ homeDir: isoHome, harness: "claude-code", agentId: "bad agent", flairUrl: URL });
    expect(res.ok).toBe(false);
    expect(existsSync(settingsPath())).toBe(false);
    const res2 = installContinuityHooks({ homeDir: isoHome, harness: "claude-code", agentId: AGENT, flairUrl: "http://x/'$(boom)'" });
    expect(res2.ok).toBe(false);
  });

  it("uninstall removes ONLY our entries and is symmetric with install; a second uninstall is a no-op", () => {
    mkdirSync(join(isoHome, ".claude"), { recursive: true });
    const foreign = {
      hooks: { PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "my-linter" }] }] },
    };
    writeFileSync(settingsPath(), JSON.stringify(foreign, null, 2));

    installContinuityHooks({ homeDir: isoHome, harness: "claude-code", agentId: AGENT, flairUrl: URL });
    expect(continuityHookStatus(isoHome, "claude-code").state).toBe("installed");

    const removed = uninstallContinuityHooks({ homeDir: isoHome, harness: "claude-code" });
    expect(removed.ok).toBe(true);
    expect(removed.actions).toEqual({ PostToolUse: "remove", Stop: "remove" });
    expect(JSON.parse(readFileSync(settingsPath(), "utf-8"))).toEqual(foreign);

    const again = uninstallContinuityHooks({ homeDir: isoHome, harness: "claude-code" });
    expect(again.ok).toBe(true);
    expect(again.actions).toEqual({ PostToolUse: "noop", Stop: "noop" });
    expect(continuityHookStatus(isoHome, "claude-code").state).toBe("absent");
  });

  it("uninstall --dry-run reports the removal without writing", () => {
    installContinuityHooks({ homeDir: isoHome, harness: "claude-code", agentId: AGENT, flairUrl: URL });
    const before = readFileSync(settingsPath(), "utf-8");
    const dry = uninstallContinuityHooks({ homeDir: isoHome, harness: "claude-code", dryRun: true });
    expect(dry.ok).toBe(true);
    expect(dry.actions).toEqual({ PostToolUse: "remove", Stop: "remove" });
    expect(readFileSync(settingsPath(), "utf-8")).toBe(before);
  });

  it("continuity install never disturbs an existing SessionStart hook (and vice versa)", () => {
    installHook({ homeDir: isoHome, harness: "claude-code", agentId: AGENT, flairUrl: URL });
    installContinuityHooks({ homeDir: isoHome, harness: "claude-code", agentId: AGENT, flairUrl: URL });
    expect(checkSessionStartHook(isoHome).present).toBe(true);
    expect(continuityHookStatus(isoHome, "claude-code").state).toBe("installed");

    uninstallContinuityHooks({ homeDir: isoHome, harness: "claude-code" });
    expect(checkSessionStartHook(isoHome).present).toBe(true); // SessionStart untouched
    expect(continuityHookStatus(isoHome, "claude-code").state).toBe("absent");
  });
});
