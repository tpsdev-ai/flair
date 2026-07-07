import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyOrReportClaudeMdBootstrap,
  applyOrReportSessionStartHook,
  checkClaudeMdBootstrap,
  checkSessionStartHook,
  CLAUDE_MD_BOOTSTRAP_MARKER,
  SESSION_START_HOOK_MARKER,
} from "../../src/doctor-client.ts";

/**
 * flair#597 — `flair init`'s claude-code wiring used to write the MCP block
 * into ~/.claude.json but leave the other two legs manual: the CLAUDE.md
 * bootstrap line was only ever printed as a copy-paste hint, and the
 * SessionStart hook wasn't mentioned by init at all. This tests the
 * apply-or-report orchestration (src/doctor-client.ts) that init now calls
 * for both legs, right after it wires the MCP block — same isolation
 * technique as doctor-client.test.ts: a temp dir stands in for both HOME and
 * cwd, torn down after every test, never touching the real filesystem.
 */

let isoHome: string;
let isoCwd: string;

beforeEach(() => {
  isoHome = mkdtempSync(join(tmpdir(), "flair-init-home-"));
  isoCwd = mkdtempSync(join(tmpdir(), "flair-init-cwd-"));
});

afterEach(() => {
  rmSync(isoHome, { recursive: true, force: true });
  rmSync(isoCwd, { recursive: true, force: true });
});

describe("applyOrReportClaudeMdBootstrap", () => {
  it("applies the fix when CLAUDE.md is absent and skip=false", () => {
    const res = applyOrReportClaudeMdBootstrap(isoCwd, isoHome, false);
    expect(res.applied).toBe(true);
    expect(res.ok).toBe(true);
    expect(res.hint).toBeUndefined();
    const content = readFileSync(join(isoCwd, "CLAUDE.md"), "utf-8");
    expect(content).toContain(CLAUDE_MD_BOOTSTRAP_MARKER);
  });

  it("reports already-present without writing when the marker already exists", () => {
    writeFileSync(join(isoCwd, "CLAUDE.md"), `# Project\n\nrun ${CLAUDE_MD_BOOTSTRAP_MARKER} first.\n`);
    const before = readFileSync(join(isoCwd, "CLAUDE.md"), "utf-8");
    const res = applyOrReportClaudeMdBootstrap(isoCwd, isoHome, false);
    expect(res.applied).toBe(false);
    expect(res.ok).toBe(true);
    expect(res.message).toContain("already has the bootstrap instruction");
    expect(res.hint).toBeUndefined();
    expect(readFileSync(join(isoCwd, "CLAUDE.md"), "utf-8")).toBe(before);
  });

  it("does not write and reports the exact missing line when skip=true", () => {
    const res = applyOrReportClaudeMdBootstrap(isoCwd, isoHome, true);
    expect(res.applied).toBe(false);
    expect(res.ok).toBe(false);
    expect(existsSync(join(isoCwd, "CLAUDE.md"))).toBe(false);
    expect(res.hint).toBeDefined();
    expect(res.hint).toContain(CLAUDE_MD_BOOTSTRAP_MARKER);
    expect(res.message).toContain("--skip-claude-md");
  });

  it("also honors a marker already present in ~/.claude/CLAUDE.md (checkClaudeMdBootstrap's fallback)", () => {
    mkdirSync(join(isoHome, ".claude"), { recursive: true });
    writeFileSync(join(isoHome, ".claude", "CLAUDE.md"), `run ${CLAUDE_MD_BOOTSTRAP_MARKER} first.\n`);
    const res = applyOrReportClaudeMdBootstrap(isoCwd, isoHome, false);
    expect(res.applied).toBe(false);
    expect(res.ok).toBe(true);
    expect(existsSync(join(isoCwd, "CLAUDE.md"))).toBe(false); // no redundant write
  });

  it("is idempotent — calling twice with skip=false does not double-append", () => {
    applyOrReportClaudeMdBootstrap(isoCwd, isoHome, false);
    const firstContent = readFileSync(join(isoCwd, "CLAUDE.md"), "utf-8");
    const res2 = applyOrReportClaudeMdBootstrap(isoCwd, isoHome, false);
    expect(res2.applied).toBe(false);
    expect(res2.ok).toBe(true);
    const secondContent = readFileSync(join(isoCwd, "CLAUDE.md"), "utf-8");
    expect(secondContent).toBe(firstContent);
    const occurrences = secondContent.split(CLAUDE_MD_BOOTSTRAP_MARKER).length - 1;
    expect(occurrences).toBe(1);
  });

  it("preserves existing CLAUDE.md content (merge-safe append, not overwrite)", () => {
    writeFileSync(join(isoCwd, "CLAUDE.md"), "# My Project\n\nExisting project instructions.\n");
    const res = applyOrReportClaudeMdBootstrap(isoCwd, isoHome, false);
    expect(res.applied).toBe(true);
    const content = readFileSync(join(isoCwd, "CLAUDE.md"), "utf-8");
    expect(content).toContain("# My Project");
    expect(content).toContain("Existing project instructions.");
    expect(content).toContain(CLAUDE_MD_BOOTSTRAP_MARKER);
  });

  it("simulated re-run of init (apply, then apply again) matches checkClaudeMdBootstrap's view", () => {
    applyOrReportClaudeMdBootstrap(isoCwd, isoHome, false);
    applyOrReportClaudeMdBootstrap(isoCwd, isoHome, false);
    const check = checkClaudeMdBootstrap(isoCwd, isoHome);
    expect(check.present).toBe(true);
    expect(check.path).toBe(join(isoCwd, "CLAUDE.md"));
  });
});

describe("applyOrReportSessionStartHook", () => {
  it("applies the fix when the hook is absent and skip=false", () => {
    const res = applyOrReportSessionStartHook(isoHome, "my-agent", false);
    expect(res.applied).toBe(true);
    expect(res.ok).toBe(true);
    expect(res.hint).toBeUndefined();
    const config = JSON.parse(readFileSync(join(isoHome, ".claude", "settings.json"), "utf-8"));
    const commands = config.hooks.SessionStart.flatMap((g: any) => g.hooks.map((h: any) => h.command));
    expect(commands.some((c: string) => c.includes(SESSION_START_HOOK_MARKER) && c.includes("FLAIR_AGENT_ID=my-agent"))).toBe(true);
  });

  it("reports already-present without writing when the hook already exists", () => {
    mkdirSync(join(isoHome, ".claude"), { recursive: true });
    const settingsPath = join(isoHome, ".claude", "settings.json");
    writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: { SessionStart: [{ hooks: [{ type: "command", command: `FLAIR_AGENT_ID=my-agent npx -y @tpsdev-ai/flair-mcp ${SESSION_START_HOOK_MARKER}` }] }] },
      }),
    );
    const before = readFileSync(settingsPath, "utf-8");
    const res = applyOrReportSessionStartHook(isoHome, "my-agent", false);
    expect(res.applied).toBe(false);
    expect(res.ok).toBe(true);
    expect(res.message).toContain("already wired");
    expect(readFileSync(settingsPath, "utf-8")).toBe(before);
  });

  it("does not write and reports the exact missing JSON when skip=true", () => {
    const res = applyOrReportSessionStartHook(isoHome, "my-agent", true);
    expect(res.applied).toBe(false);
    expect(res.ok).toBe(false);
    expect(existsSync(join(isoHome, ".claude", "settings.json"))).toBe(false);
    expect(res.hint).toBeDefined();
    expect(res.hint).toContain(SESSION_START_HOOK_MARKER);
    expect(res.hint).toContain("my-agent");
    expect(res.message).toContain("--skip-hook");
  });

  it("is idempotent — calling twice with skip=false does not duplicate the hook group", () => {
    applyOrReportSessionStartHook(isoHome, "my-agent", false);
    const path = join(isoHome, ".claude", "settings.json");
    const firstConfig = JSON.parse(readFileSync(path, "utf-8"));
    const firstCount = firstConfig.hooks.SessionStart.length;

    const res2 = applyOrReportSessionStartHook(isoHome, "my-agent", false);
    expect(res2.applied).toBe(false);
    expect(res2.ok).toBe(true);
    const secondConfig = JSON.parse(readFileSync(path, "utf-8"));
    expect(secondConfig.hooks.SessionStart.length).toBe(firstCount);
  });

  it("merge-safe: preserves other top-level keys and other hook types in settings.json", () => {
    mkdirSync(join(isoHome, ".claude"), { recursive: true });
    const settingsPath = join(isoHome, ".claude", "settings.json");
    writeFileSync(
      settingsPath,
      JSON.stringify({
        theme: "dark",
        hooks: {
          PreToolUse: [{ hooks: [{ type: "command", command: "some-other-hook" }] }],
          SessionStart: [{ hooks: [{ type: "command", command: "unrelated-session-hook" }] }],
        },
      }),
    );
    const res = applyOrReportSessionStartHook(isoHome, "my-agent", false);
    expect(res.applied).toBe(true);
    const config = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(config.theme).toBe("dark");
    expect(config.hooks.PreToolUse[0].hooks[0].command).toBe("some-other-hook");
    const sessionStartCommands = config.hooks.SessionStart.flatMap((g: any) => g.hooks.map((h: any) => h.command));
    expect(sessionStartCommands).toContain("unrelated-session-hook");
    expect(sessionStartCommands.some((c: string) => c.includes(SESSION_START_HOOK_MARKER))).toBe(true);
  });

  it("simulated re-run of init (apply, then apply again) matches checkSessionStartHook's view", () => {
    applyOrReportSessionStartHook(isoHome, "my-agent", false);
    applyOrReportSessionStartHook(isoHome, "my-agent", false);
    const check = checkSessionStartHook(isoHome);
    expect(check.present).toBe(true);
  });
});

describe("init re-run simulation (both legs together)", () => {
  it("running init-shaped wiring twice in a row is a fully idempotent no-op the second time", () => {
    const first = {
      claudeMd: applyOrReportClaudeMdBootstrap(isoCwd, isoHome, false),
      hook: applyOrReportSessionStartHook(isoHome, "my-agent", false),
    };
    expect(first.claudeMd.applied).toBe(true);
    expect(first.hook.applied).toBe(true);

    const claudeMdSnapshot = readFileSync(join(isoCwd, "CLAUDE.md"), "utf-8");
    const settingsSnapshot = readFileSync(join(isoHome, ".claude", "settings.json"), "utf-8");

    const second = {
      claudeMd: applyOrReportClaudeMdBootstrap(isoCwd, isoHome, false),
      hook: applyOrReportSessionStartHook(isoHome, "my-agent", false),
    };
    expect(second.claudeMd.applied).toBe(false);
    expect(second.claudeMd.ok).toBe(true);
    expect(second.hook.applied).toBe(false);
    expect(second.hook.ok).toBe(true);

    expect(readFileSync(join(isoCwd, "CLAUDE.md"), "utf-8")).toBe(claudeMdSnapshot);
    expect(readFileSync(join(isoHome, ".claude", "settings.json"), "utf-8")).toBe(settingsSnapshot);
  });
});
