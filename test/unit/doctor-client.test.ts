import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  readClientMcpBlock,
  checkClaudeMdBootstrap,
  checkSessionStartHook,
  fixClaudeMdBootstrap,
  fixSessionStartHook,
  CLAUDE_MD_BOOTSTRAP_MARKER,
  SESSION_START_HOOK_MARKER,
} from "../../src/doctor-client.ts";

/**
 * flair#588 — `flair doctor` client-integration checks. Pure filesystem
 * logic (no network, no crypto), so this mirrors client-wiring.test.ts's
 * isolation technique: a temp dir stands in for both HOME and cwd, and is
 * torn down after every test. Never touches the real ~/.claude.json,
 * ~/.claude/settings.json, ~/.claude/CLAUDE.md, etc.
 */

let isoHome: string;
let isoCwd: string;

beforeEach(() => {
  isoHome = mkdtempSync(join(tmpdir(), "flair-doctor-home-"));
  isoCwd = mkdtempSync(join(tmpdir(), "flair-doctor-cwd-"));
});

afterEach(() => {
  rmSync(isoHome, { recursive: true, force: true });
  rmSync(isoCwd, { recursive: true, force: true });
});

describe("readClientMcpBlock", () => {
  it("claude-code: absent when ~/.claude.json doesn't exist", () => {
    const res = readClientMcpBlock("claude-code", isoHome);
    expect(res.present).toBe(false);
    expect(res.configPath).toBe(join(isoHome, ".claude.json"));
  });

  it("claude-code: present when ~/.claude.json has mcpServers.flair with both env vars", () => {
    writeFileSync(
      join(isoHome, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          flair: {
            command: "npx",
            args: ["-y", "@tpsdev-ai/flair-mcp"],
            env: { FLAIR_AGENT_ID: "me", FLAIR_URL: "http://127.0.0.1:9926" },
          },
        },
      }),
    );
    const res = readClientMcpBlock("claude-code", isoHome);
    expect(res.present).toBe(true);
    expect(res.agentId).toBe("me");
    expect(res.flairUrl).toBe("http://127.0.0.1:9926");
  });

  it("claude-code: not present when the block exists but is missing FLAIR_URL", () => {
    writeFileSync(
      join(isoHome, ".claude.json"),
      JSON.stringify({ mcpServers: { flair: { command: "npx", env: { FLAIR_AGENT_ID: "me" } } } }),
    );
    const res = readClientMcpBlock("claude-code", isoHome);
    expect(res.present).toBe(false);
    // Partial info still surfaced.
    expect(res.agentId).toBe("me");
    expect(res.flairUrl).toBeUndefined();
  });

  it("claude-code: not present (never throws) on malformed JSON", () => {
    writeFileSync(join(isoHome, ".claude.json"), "{ not valid json");
    const res = readClientMcpBlock("claude-code", isoHome);
    expect(res.present).toBe(false);
  });

  it("gemini: absent when ~/.gemini/settings.json doesn't exist", () => {
    const res = readClientMcpBlock("gemini", isoHome);
    expect(res.present).toBe(false);
    expect(res.configPath).toBe(join(isoHome, ".gemini", "settings.json"));
  });

  it("gemini: present when ~/.gemini/settings.json has mcpServers.flair with both env vars", () => {
    mkdirSync(join(isoHome, ".gemini"), { recursive: true });
    writeFileSync(
      join(isoHome, ".gemini", "settings.json"),
      JSON.stringify({ mcpServers: { flair: { env: { FLAIR_AGENT_ID: "geminibot", FLAIR_URL: "http://127.0.0.1:9926" } } } }),
    );
    const res = readClientMcpBlock("gemini", isoHome);
    expect(res.present).toBe(true);
    expect(res.agentId).toBe("geminibot");
    expect(res.flairUrl).toBe("http://127.0.0.1:9926");
  });

  it("codex: absent when ~/.codex/config.toml doesn't exist", () => {
    const res = readClientMcpBlock("codex", isoHome);
    expect(res.present).toBe(false);
    expect(res.configPath).toBe(join(isoHome, ".codex", "config.toml"));
  });

  it("codex: present when config.toml has the exact [mcp_servers.flair] + [mcp_servers.flair.env] shape _wireCodex writes", () => {
    mkdirSync(join(isoHome, ".codex"), { recursive: true });
    const toml = [
      "[mcp_servers.flair]",
      'command = "npx"',
      'args = ["-y", "@tpsdev-ai/flair-mcp"]',
      "",
      "[mcp_servers.flair.env]",
      'FLAIR_AGENT_ID = "codexbot"',
      'FLAIR_URL = "http://127.0.0.1:9926"',
      "",
    ].join("\n");
    writeFileSync(join(isoHome, ".codex", "config.toml"), toml);
    const res = readClientMcpBlock("codex", isoHome);
    expect(res.present).toBe(true);
    expect(res.agentId).toBe("codexbot");
    expect(res.flairUrl).toBe("http://127.0.0.1:9926");
  });

  it("codex: absent when config.toml has an unrelated table only", () => {
    mkdirSync(join(isoHome, ".codex"), { recursive: true });
    writeFileSync(join(isoHome, ".codex", "config.toml"), '[some_other_table]\nkey = 1\n');
    const res = readClientMcpBlock("codex", isoHome);
    expect(res.present).toBe(false);
  });

  it("codex: scan stops at the next unrelated table (doesn't leak keys from a sibling section)", () => {
    mkdirSync(join(isoHome, ".codex"), { recursive: true });
    const toml = [
      "[mcp_servers.flair]",
      'command = "npx"',
      "",
      "[mcp_servers.flair.env]",
      'FLAIR_AGENT_ID = "codexbot"',
      'FLAIR_URL = "http://127.0.0.1:9926"',
      "",
      "[some_other_table]",
      'FLAIR_AGENT_ID = "decoy"',
      "",
    ].join("\n");
    writeFileSync(join(isoHome, ".codex", "config.toml"), toml);
    const res = readClientMcpBlock("codex", isoHome);
    expect(res.present).toBe(true);
    expect(res.agentId).toBe("codexbot");
  });

  it("does not mutate process.env.HOME as an observable side effect", () => {
    const prevHome = process.env.HOME;
    readClientMcpBlock("claude-code", isoHome);
    expect(process.env.HOME).toBe(prevHome);
  });
});

describe("checkClaudeMdBootstrap", () => {
  it("absent when neither cwd/CLAUDE.md nor ~/.claude/CLAUDE.md exist", () => {
    const res = checkClaudeMdBootstrap(isoCwd, isoHome);
    expect(res.present).toBe(false);
    expect(res.path).toBeNull();
  });

  it("present when cwd/CLAUDE.md contains the marker", () => {
    writeFileSync(join(isoCwd, "CLAUDE.md"), `# Project\n\nAt the start of every session, run ${CLAUDE_MD_BOOTSTRAP_MARKER} before responding.\n`);
    const res = checkClaudeMdBootstrap(isoCwd, isoHome);
    expect(res.present).toBe(true);
    expect(res.path).toBe(join(isoCwd, "CLAUDE.md"));
  });

  it("falls back to ~/.claude/CLAUDE.md when cwd/CLAUDE.md is absent", () => {
    mkdirSync(join(isoHome, ".claude"), { recursive: true });
    writeFileSync(join(isoHome, ".claude", "CLAUDE.md"), `run ${CLAUDE_MD_BOOTSTRAP_MARKER} before responding.\n`);
    const res = checkClaudeMdBootstrap(isoCwd, isoHome);
    expect(res.present).toBe(true);
    expect(res.path).toBe(join(isoHome, ".claude", "CLAUDE.md"));
  });

  it("falls back to ~/.claude/CLAUDE.md when cwd/CLAUDE.md exists but lacks the marker", () => {
    writeFileSync(join(isoCwd, "CLAUDE.md"), "# Project\n\nSome other instructions.\n");
    mkdirSync(join(isoHome, ".claude"), { recursive: true });
    writeFileSync(join(isoHome, ".claude", "CLAUDE.md"), `run ${CLAUDE_MD_BOOTSTRAP_MARKER} before responding.\n`);
    const res = checkClaudeMdBootstrap(isoCwd, isoHome);
    expect(res.present).toBe(true);
    expect(res.path).toBe(join(isoHome, ".claude", "CLAUDE.md"));
  });

  it("absent when both files exist but neither contains the marker", () => {
    writeFileSync(join(isoCwd, "CLAUDE.md"), "# Project\n");
    mkdirSync(join(isoHome, ".claude"), { recursive: true });
    writeFileSync(join(isoHome, ".claude", "CLAUDE.md"), "# Global\n");
    const res = checkClaudeMdBootstrap(isoCwd, isoHome);
    expect(res.present).toBe(false);
  });
});

describe("fixClaudeMdBootstrap", () => {
  it("creates CLAUDE.md when absent and appends the bootstrap line", () => {
    const res = fixClaudeMdBootstrap(isoCwd);
    expect(res.ok).toBe(true);
    expect(res.path).toBe(join(isoCwd, "CLAUDE.md"));
    const content = readFileSync(res.path, "utf-8");
    expect(content).toContain(CLAUDE_MD_BOOTSTRAP_MARKER);
    expect(content).toContain("At the start of every session, run mcp__flair__bootstrap before responding.");
  });

  it("appends to an existing CLAUDE.md, preserving prior content", () => {
    writeFileSync(join(isoCwd, "CLAUDE.md"), "# My Project\n\nSome existing instructions.\n");
    const res = fixClaudeMdBootstrap(isoCwd);
    expect(res.ok).toBe(true);
    const content = readFileSync(res.path, "utf-8");
    expect(content).toContain("# My Project");
    expect(content).toContain("Some existing instructions.");
    expect(content).toContain(CLAUDE_MD_BOOTSTRAP_MARKER);
  });

  it("is idempotent — a second call does not double-append", () => {
    fixClaudeMdBootstrap(isoCwd);
    const firstContent = readFileSync(join(isoCwd, "CLAUDE.md"), "utf-8");
    const res2 = fixClaudeMdBootstrap(isoCwd);
    expect(res2.ok).toBe(true);
    const secondContent = readFileSync(join(isoCwd, "CLAUDE.md"), "utf-8");
    expect(secondContent).toBe(firstContent);
    const occurrences = secondContent.split(CLAUDE_MD_BOOTSTRAP_MARKER).length - 1;
    expect(occurrences).toBe(1);
  });

  it("checkClaudeMdBootstrap sees the fix's output as present", () => {
    fixClaudeMdBootstrap(isoCwd);
    const res = checkClaudeMdBootstrap(isoCwd, isoHome);
    expect(res.present).toBe(true);
    expect(res.path).toBe(join(isoCwd, "CLAUDE.md"));
  });
});

describe("checkSessionStartHook", () => {
  it("absent when ~/.claude/settings.json doesn't exist", () => {
    const res = checkSessionStartHook(isoHome);
    expect(res.present).toBe(false);
    expect(res.path).toBe(join(isoHome, ".claude", "settings.json"));
  });

  it("present when a SessionStart hook command contains the flair-session-start marker", () => {
    mkdirSync(join(isoHome, ".claude"), { recursive: true });
    writeFileSync(
      join(isoHome, ".claude", "settings.json"),
      JSON.stringify({
        hooks: {
          SessionStart: [
            { hooks: [{ type: "command", command: `FLAIR_AGENT_ID=me npx -y @tpsdev-ai/flair-mcp ${SESSION_START_HOOK_MARKER}` }] },
          ],
        },
      }),
    );
    const res = checkSessionStartHook(isoHome);
    expect(res.present).toBe(true);
  });

  it("absent when settings.json exists but has other hooks / no SessionStart", () => {
    mkdirSync(join(isoHome, ".claude"), { recursive: true });
    writeFileSync(
      join(isoHome, ".claude", "settings.json"),
      JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "some-other-hook" }] }] } }),
    );
    const res = checkSessionStartHook(isoHome);
    expect(res.present).toBe(false);
  });

  it("absent when a SessionStart hook exists but none of the commands match", () => {
    mkdirSync(join(isoHome, ".claude"), { recursive: true });
    writeFileSync(
      join(isoHome, ".claude", "settings.json"),
      JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "some-other-thing" }] }] } }),
    );
    const res = checkSessionStartHook(isoHome);
    expect(res.present).toBe(false);
  });

  it("never throws on malformed JSON", () => {
    mkdirSync(join(isoHome, ".claude"), { recursive: true });
    writeFileSync(join(isoHome, ".claude", "settings.json"), "{ not valid json");
    const res = checkSessionStartHook(isoHome);
    expect(res.present).toBe(false);
  });
});

describe("fixSessionStartHook", () => {
  it("creates settings.json and the SessionStart hook when absent", () => {
    const res = fixSessionStartHook(isoHome, "me");
    expect(res.ok).toBe(true);
    expect(existsSync(res.path)).toBe(true);
    const config = JSON.parse(readFileSync(res.path, "utf-8"));
    const commands = config.hooks.SessionStart.flatMap((g: any) => g.hooks.map((h: any) => h.command));
    expect(commands.some((c: string) => c.includes(SESSION_START_HOOK_MARKER) && c.includes("FLAIR_AGENT_ID=me"))).toBe(true);
  });

  it("merge-safe: preserves other top-level keys and other hook types", () => {
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
    const res = fixSessionStartHook(isoHome, "me");
    expect(res.ok).toBe(true);
    const config = JSON.parse(readFileSync(res.path, "utf-8"));
    expect(config.theme).toBe("dark"); // preserved
    expect(config.hooks.PreToolUse[0].hooks[0].command).toBe("some-other-hook"); // preserved
    const sessionStartCommands = config.hooks.SessionStart.flatMap((g: any) => g.hooks.map((h: any) => h.command));
    expect(sessionStartCommands).toContain("unrelated-session-hook"); // preserved, not clobbered
    expect(sessionStartCommands.some((c: string) => c.includes(SESSION_START_HOOK_MARKER))).toBe(true); // added
  });

  it("is idempotent / dedupes — a second call does not add a duplicate hook group", () => {
    fixSessionStartHook(isoHome, "me");
    const path = join(isoHome, ".claude", "settings.json");
    const firstConfig = JSON.parse(readFileSync(path, "utf-8"));
    const firstCount = firstConfig.hooks.SessionStart.length;

    const res2 = fixSessionStartHook(isoHome, "me");
    expect(res2.ok).toBe(true);
    expect(res2.message).toContain("already present");
    const secondConfig = JSON.parse(readFileSync(path, "utf-8"));
    expect(secondConfig.hooks.SessionStart.length).toBe(firstCount);
  });

  it("returns ok:false and a clear message (never crashes) when agentId is unknown", () => {
    const res = fixSessionStartHook(isoHome, undefined);
    expect(res.ok).toBe(false);
    expect(res.message.length).toBeGreaterThan(0);
    expect(existsSync(res.path)).toBe(false);
  });

  it("checkSessionStartHook sees the fix's output as present", () => {
    fixSessionStartHook(isoHome, "me");
    const res = checkSessionStartHook(isoHome);
    expect(res.present).toBe(true);
  });
});
