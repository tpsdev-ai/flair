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
  classifyKeyFile,
  resolveCollisionSafeName,
  pruneDateStamp,
  PRUNED_DIR_NAME,
  CONTINUITY_CAPTURE_HOOK_MARKER,
  CONTINUITY_POST_TOOL_USE_MATCHER,
  buildContinuityCaptureHookCommand,
  checkContinuityCaptureHooks,
  fixContinuityCaptureHooks,
  removeContinuityCaptureHooks,
  hookCommandIsSilenced,
} from "../../src/doctor-client.ts";
import { mcpServerSpec } from "../../src/lib/mcp-spec.ts";

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

  it("claude-code: PRESENT (URL defaulted) when the block has FLAIR_AGENT_ID but no FLAIR_URL (flair#1287)", () => {
    // This test used to assert present:false — encoding the flair#1287
    // false-negative: flair-client treats FLAIR_URL as optional (falls back
    // to its DEFAULT_URL), so a URL-less block is a working setup and doctor
    // must not demand a var the client doesn't need.
    writeFileSync(
      join(isoHome, ".claude.json"),
      JSON.stringify({ mcpServers: { flair: { command: "npx", env: { FLAIR_AGENT_ID: "me" } } } }),
    );
    const res = readClientMcpBlock("claude-code", isoHome);
    expect(res.present).toBe(true);
    expect(res.urlDefaulted).toBe(true);
    expect(res.agentId).toBe("me");
    expect(res.flairUrl).toBeUndefined();
  });

  it("claude-code: NOT present when the block is missing FLAIR_AGENT_ID (URL alone is not a working setup)", () => {
    // Positive control for the flair#1287 relaxation: only FLAIR_URL became
    // optional. FLAIR_AGENT_ID is genuinely required (flair-mcp refuses to
    // start without one), so a block carrying only a URL stays not-present.
    writeFileSync(
      join(isoHome, ".claude.json"),
      JSON.stringify({ mcpServers: { flair: { command: "npx", env: { FLAIR_URL: "http://127.0.0.1:9926" } } } }),
    );
    const res = readClientMcpBlock("claude-code", isoHome);
    expect(res.present).toBe(false);
    expect(res.urlDefaulted).toBeFalsy();
    // Partial info still surfaced.
    expect(res.flairUrl).toBe("http://127.0.0.1:9926");
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
    // flair#1143: doctor --fix writes the same pin as flair init / hook install.
    expect(commands.some((c: string) => c.includes(`npx -y -p ${mcpServerSpec()} ${SESSION_START_HOOK_MARKER}`))).toBe(true);
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

  it("codex path: fix + check write and read ~/.codex/hooks.json (flair#1148)", () => {
    const path = join(isoHome, ".codex", "hooks.json");
    const res = fixSessionStartHook(isoHome, "codexbot", path);
    expect(res.ok).toBe(true);
    expect(res.path).toBe(path);
    expect(res.message).toContain(path);
    expect(existsSync(join(isoHome, ".claude", "settings.json"))).toBe(false);

    const check = checkSessionStartHook(isoHome, path);
    expect(check.present).toBe(true);
    expect(check.path).toBe(path);
    expect(check.command).toContain("FLAIR_AGENT_ID=codexbot");
    expect(checkSessionStartHook(isoHome).present).toBe(false);
  });
});

/**
 * flair#734 — pure decision logic behind `flair keys prune`. No fs, no
 * network, no crypto: the actual file reads, seed parsing, and signed
 * registration checks live in src/cli.ts's classifyKeysDir (see
 * test/unit/keys-prune.test.ts for those, mirroring how checkAgentRegistered
 * is unit-tested with a mocked fetch rather than a real Harper).
 */
describe("classifyKeyFile", () => {
  const BASE_URL = "http://127.0.0.1:19926";

  // flair#1026: an unparseable file is NOT prunable. `~/.flair/keys/<id>.key`
  // is a namespace shared by two writers — plaintext Ed25519 seeds and
  // AES-256-GCM keystore blobs — so "will not parse as a seed" does not imply
  // "junk". It previously classified as "invalid", which prune archives, so a
  // LIVE federation key could be moved.
  it("unparseable seed → class 'unidentified', which prune must not act on", () => {
    const d = classifyKeyFile("stray", false, null, BASE_URL);
    expect(d.class).toBe("unidentified");
    expect(d.class).not.toBe("invalid");
    expect(d.reason).toContain("not a parseable Ed25519");
    expect(d.reason).toContain("left in place");
  });

  // POSITIVE CONTROL for the above: the classifier must still be *able* to
  // return a prunable class. A change that made everything unidentified would
  // satisfy the assertion above while silently disabling prune entirely.
  it("POSITIVE CONTROL: a parseable but unregistered key is still prunable ('stale')", () => {
    const d = classifyKeyFile("stray", true, { state: "not-registered" }, BASE_URL);
    expect(d.class).toBe("stale");
  });

  it("valid seed + registered → class 'keep'", () => {
    const d = classifyKeyFile("local", true, { state: "registered" }, BASE_URL);
    expect(d.class).toBe("keep");
    expect(d.reason).toContain("local");
    expect(d.reason).toContain(BASE_URL);
  });

  it("valid seed + not-registered → class 'stale', reason names the agent and instance", () => {
    const d = classifyKeyFile("stray", true, { state: "not-registered" }, BASE_URL);
    expect(d.class).toBe("stale");
    expect(d.reason).toContain("stray");
    expect(d.reason).toContain(BASE_URL);
  });

  it("valid seed + not-registered carries the detail string when given", () => {
    const d = classifyKeyFile("stray", true, { state: "not-registered", detail: "HTTP 401 unknown_agent" }, BASE_URL);
    expect(d.reason).toContain("HTTP 401 unknown_agent");
  });

  it("valid seed + no-key (defensive edge case) still classifies as 'stale', not a crash", () => {
    const d = classifyKeyFile("stray", true, { state: "no-key" }, BASE_URL);
    expect(d.class).toBe("stale");
  });

  it("valid seed + null registration (defensive edge case) still classifies as 'stale'", () => {
    const d = classifyKeyFile("stray", true, null, BASE_URL);
    expect(d.class).toBe("stale");
  });

  it("a registered agent's key is NEVER classified as prunable", () => {
    const d = classifyKeyFile("local", true, { state: "registered" }, BASE_URL);
    expect(d.class).not.toBe("stale");
    expect(d.class).not.toBe("invalid");
  });
});

describe("pruneDateStamp", () => {
  it("formats as YYYY-MM-DD in UTC", () => {
    const d = new Date("2026-07-18T23:45:00.000Z");
    expect(pruneDateStamp(d)).toBe("2026-07-18");
  });

  it("uses UTC, not local time — a date that would roll over in a negative-offset zone stays UTC's day", () => {
    // 2026-01-01T00:30:00Z is still Dec 31 in e.g. US Pacific, but the stamp
    // must be the UTC day so prune's archive bucketing is host-timezone-independent.
    const d = new Date("2026-01-01T00:30:00.000Z");
    expect(pruneDateStamp(d)).toBe("2026-01-01");
  });

  it("defaults to now() when no date is given", () => {
    const stamp = pruneDateStamp();
    expect(stamp).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("resolveCollisionSafeName", () => {
  it("returns the original filename when nothing exists yet", () => {
    expect(resolveCollisionSafeName([], "stray.key")).toBe("stray.key");
    expect(resolveCollisionSafeName(new Set(), "stray.key")).toBe("stray.key");
  });

  it("appends .2 on a single collision", () => {
    expect(resolveCollisionSafeName(["stray.key"], "stray.key")).toBe("stray.key.2");
  });

  it("keeps incrementing past existing numbered collisions", () => {
    expect(resolveCollisionSafeName(["stray.key", "stray.key.2", "stray.key.3"], "stray.key")).toBe("stray.key.4");
  });

  it("is unaffected by unrelated filenames in the existing set", () => {
    expect(resolveCollisionSafeName(["other.key", "another.key"], "stray.key")).toBe("stray.key");
  });

  it("PRUNED_DIR_NAME is the literal '.pruned' the scanner must skip", () => {
    expect(PRUNED_DIR_NAME).toBe(".pruned");
  });
});

// ─── flair#1257 slice 2 — continuity capture hooks (check-5 twin) ───────────

describe("buildContinuityCaptureHookCommand", () => {
  it("carries the marker, both env vars when a URL is given, and the silenced wrapper", () => {
    const cmd = buildContinuityCaptureHookCommand("flint", "http://harper.local:19926");
    expect(cmd).toContain(CONTINUITY_CAPTURE_HOOK_MARKER);
    expect(cmd).toContain("FLAIR_AGENT_ID=flint");
    expect(cmd).toContain("FLAIR_URL=http://harper.local:19926");
    expect(cmd).toContain("npx -y -p @tpsdev-ai/flair-mcp flair-continuity-capture");
    // Same silence property doctor's SessionStart check recognizes: a broken
    // npx resolution must never print an error on every tool call.
    expect(hookCommandIsSilenced(cmd)).toBe(true);
  });

  it("omits FLAIR_URL when none is given", () => {
    const cmd = buildContinuityCaptureHookCommand("flint");
    expect(cmd).toContain("FLAIR_AGENT_ID=flint");
    expect(cmd).not.toContain("FLAIR_URL=");
  });

  it("REFUSES values that cannot be represented safely in a shell command (never escapes)", () => {
    expect(() => buildContinuityCaptureHookCommand("bad agent")).toThrow();
    expect(() => buildContinuityCaptureHookCommand("a'; rm -rf ~;'")).toThrow();
    expect(() => buildContinuityCaptureHookCommand("flint", "http://x/'$(boom)'")).toThrow();
  });
});

describe("checkContinuityCaptureHooks / fixContinuityCaptureHooks / removeContinuityCaptureHooks", () => {
  const settingsPath = () => join(isoHome, ".claude", "settings.json");

  it("absent when settings.json does not exist — 'not enabled', which is neither a pass nor a failure", () => {
    const report = checkContinuityCaptureHooks(isoHome);
    expect(report.state).toBe("absent");
    expect(report.postToolUse.present).toBe(false);
    expect(report.stop.present).toBe(false);
  });

  it("registration round-trip: fix wires BOTH events (PostToolUse with the allowlist matcher), check reads installed", () => {
    const fix = fixContinuityCaptureHooks(isoHome, "flint", "http://localhost:19926");
    expect(fix.ok).toBe(true);
    expect(fix.changed).toBe(true);

    const report = checkContinuityCaptureHooks(isoHome);
    expect(report.state).toBe("installed");
    expect(report.postToolUse.currentForm).toBe(true);
    expect(report.stop.currentForm).toBe(true);
    expect(report.postToolUse.matcher).toBe(CONTINUITY_POST_TOOL_USE_MATCHER);

    // Idempotent: a second run is a structural no-op.
    const again = fixContinuityCaptureHooks(isoHome, "flint", "http://localhost:19926");
    expect(again.ok).toBe(true);
    expect(again.changed).toBe(false);
  });

  it("the PostToolUse matcher written is EXACTLY the capture binary's mutating allowlist", () => {
    expect(CONTINUITY_POST_TOOL_USE_MATCHER).toBe("Write|Edit|NotebookEdit|Bash");
    fixContinuityCaptureHooks(isoHome, "flint");
    const config = JSON.parse(readFileSync(settingsPath(), "utf-8"));
    expect(config.hooks.PostToolUse[0].matcher).toBe("Write|Edit|NotebookEdit|Bash");
  });

  it("merge-safe: unrelated hooks and keys survive install AND removal byte-identically", () => {
    mkdirSync(join(isoHome, ".claude"), { recursive: true });
    const existing = {
      model: "opus",
      hooks: {
        PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "my-linter --fix" }] }],
        SessionStart: [{ hooks: [{ type: "command", command: "echo hi" }] }],
      },
    };
    writeFileSync(settingsPath(), JSON.stringify(existing, null, 2));

    fixContinuityCaptureHooks(isoHome, "flint");
    const afterInstall = JSON.parse(readFileSync(settingsPath(), "utf-8"));
    expect(afterInstall.model).toBe("opus");
    expect(afterInstall.hooks.PostToolUse[0]).toEqual(existing.hooks.PostToolUse[0]);
    expect(afterInstall.hooks.SessionStart).toEqual(existing.hooks.SessionStart);
    expect(checkContinuityCaptureHooks(isoHome).state).toBe("installed");

    const removal = removeContinuityCaptureHooks(isoHome);
    expect(removal.ok).toBe(true);
    expect(removal.changed).toBe(true);
    const afterRemoval = JSON.parse(readFileSync(settingsPath(), "utf-8"));
    expect(afterRemoval).toEqual(existing); // ONLY our entries were removed
    expect(checkContinuityCaptureHooks(isoHome).state).toBe("absent");
  });

  it("stale-form detection: an unsilenced command reads stale, and fix repairs it to current form", () => {
    mkdirSync(join(isoHome, ".claude"), { recursive: true });
    writeFileSync(
      settingsPath(),
      JSON.stringify({
        hooks: {
          PostToolUse: [{ matcher: CONTINUITY_POST_TOOL_USE_MATCHER, hooks: [{ type: "command", command: "FLAIR_AGENT_ID=flint npx -y @tpsdev-ai/flair-mcp flair-continuity-capture" }] }],
          Stop: [{ hooks: [{ type: "command", command: "FLAIR_AGENT_ID=flint npx -y @tpsdev-ai/flair-mcp flair-continuity-capture" }] }],
        },
      }),
    );
    expect(checkContinuityCaptureHooks(isoHome).state).toBe("stale");

    const fix = fixContinuityCaptureHooks(isoHome, "flint");
    expect(fix.ok).toBe(true);
    expect(fix.changed).toBe(true);
    expect(checkContinuityCaptureHooks(isoHome).state).toBe("installed");
  });

  it("stale-form detection: a drifted PostToolUse matcher reads stale (the allowlist mirror matters)", () => {
    fixContinuityCaptureHooks(isoHome, "flint");
    const config = JSON.parse(readFileSync(settingsPath(), "utf-8"));
    config.hooks.PostToolUse[0].matcher = "Bash"; // hand-narrowed
    writeFileSync(settingsPath(), JSON.stringify(config, null, 2));
    expect(checkContinuityCaptureHooks(isoHome).state).toBe("stale");
  });

  it("partial detection: only one of the two events wired", () => {
    fixContinuityCaptureHooks(isoHome, "flint");
    const config = JSON.parse(readFileSync(settingsPath(), "utf-8"));
    delete config.hooks.Stop;
    writeFileSync(settingsPath(), JSON.stringify(config, null, 2));
    const report = checkContinuityCaptureHooks(isoHome);
    expect(report.state).toBe("partial");
    expect(report.postToolUse.present).toBe(true);
    expect(report.stop.present).toBe(false);

    // fix completes the pair.
    const fix = fixContinuityCaptureHooks(isoHome, "flint");
    expect(fix.changed).toBe(true);
    expect(checkContinuityCaptureHooks(isoHome).state).toBe("installed");
  });

  it("removal on a machine with nothing wired is a clean no-op that creates no file", () => {
    const removal = removeContinuityCaptureHooks(isoHome);
    expect(removal.ok).toBe(true);
    expect(removal.changed).toBe(false);
    expect(existsSync(settingsPath())).toBe(false);
  });

  it("fix refuses an unsafe agent id / URL instead of writing a mangled command", () => {
    expect(fixContinuityCaptureHooks(isoHome, "bad agent").ok).toBe(false);
    expect(fixContinuityCaptureHooks(isoHome, "flint", "http://x/'$(boom)'").ok).toBe(false);
    expect(fixContinuityCaptureHooks(isoHome, undefined).ok).toBe(false);
    expect(existsSync(settingsPath())).toBe(false); // nothing was half-written
  });
});
