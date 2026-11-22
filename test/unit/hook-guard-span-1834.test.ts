/**
 * hook-guard-span-1834.test.ts — flair#1834 PR-H round 2 (Kern BLOCKING).
 *
 * THE DEFECT. The SessionStart hook writers handed the never-lower guard the
 * FULL command (`existingText: current` / `existingCommand`), and the guard
 * decodes the FIRST `<pkg>@<ver>` occurrence in whatever text it receives. The
 * installer-form id and URL charsets admit `@`, `/`, `.` and digits, so a
 * hand-edited id (or URL) can EMBED a `<pkg>@<ver>` string — a DECOY that
 * decodes BEFORE the real `-p` pin. The guard then proves the DECOY safe while
 * the writer replaces the real pin, so an AHEAD real pin is LOWERED (or a stale
 * real pin is needlessly HELD).
 *
 * Source values containing package decoys are now refused before rebuilding.
 * The pin reader still captures the package argument rather than a decoy.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { repinSessionStartHook, installHook, hookSettingsPath } from "../../src/hook-install.ts";
import { FLAIR_MCP_PACKAGE } from "../../src/lib/mcp-spec.ts";

const STALE_VER = "0.0.0"; // behind the running CLI
const AHEAD_VER = "9.9.9"; // ahead of the running CLI
const AGENT = "hookbot";
const URL = "http://127.0.0.1:19926";

let isoHome: string;
let prevHome: string | undefined;

beforeEach(() => {
  isoHome = mkdtempSync(join(tmpdir(), "flair-1834-h-guardspan-"));
  prevHome = process.env.HOME;
  process.env.HOME = isoHome;
});
afterEach(() => {
  if (prevHome !== undefined) process.env.HOME = prevHome;
  else delete process.env.HOME;
  rmSync(isoHome, { recursive: true, force: true });
});

/** The exact Claude Code installer form (`buildSessionStartHookCommand`). */
function claudeCmd(envParts: string, ver: string): string {
  return `sh -c 'out=$(${envParts} npx -y -p ${FLAIR_MCP_PACKAGE}@${ver} flair-session-start 2>/dev/null) && printf %s "$out" || true'`;
}

function writeHook(command: string): string {
  const path = hookSettingsPath(isoHome, "claude-code");
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command }] }] } }, null, 2) + "\n");
  return path;
}

function readHookCommand(): string {
  const cfg = JSON.parse(readFileSync(hookSettingsPath(isoHome, "claude-code"), "utf-8"));
  return cfg?.hooks?.SessionStart?.[0]?.hooks?.[0]?.command ?? "";
}

const install = () => installHook({ homeDir: isoHome, harness: "claude-code", agentId: AGENT, flairUrl: URL });

// ── the guard must read the CAPTURED span, not a decoy in the id ────────────

describe("flair#1834 PR-H round 2 — repinSessionStartHook: unsafe source ids are refused", () => {
  it("decoy BEHIND in the id + real pin AHEAD → source refusal", () => {
    const id = `ghost@${FLAIR_MCP_PACKAGE}@${STALE_VER}`;
    const before = claudeCmd(`FLAIR_AGENT_ID=${id}`, AHEAD_VER);
    writeHook(before);
    const original = readFileSync(hookSettingsPath(isoHome, "claude-code"), "utf-8");

    const res = repinSessionStartHook(isoHome, "claude-code");

    expect(res.action).toBe("hold");
    expect(res.ok).toBe(false);
    expect(res.message).toContain("cannot be safely written");
    expect(readFileSync(hookSettingsPath(isoHome, "claude-code"), "utf-8")).toBe(original);
    expect(readHookCommand()).toContain(`-p ${FLAIR_MCP_PACKAGE}@${AHEAD_VER} `);
  });

  it("decoy AHEAD in the id + real pin stale → source refusal", () => {
    const id = `ghost@${FLAIR_MCP_PACKAGE}@${AHEAD_VER}`;
    const before = claudeCmd(`FLAIR_AGENT_ID=${id}`, STALE_VER);
    writeHook(before);

    const res = repinSessionStartHook(isoHome, "claude-code");

    expect(res.action).toBe("hold");
    expect(res.ok).toBe(false);
    expect(res.message).toContain("cannot be safely written");
    expect(readHookCommand()).toBe(before);
    expect(readHookCommand()).toContain(`FLAIR_AGENT_ID=${id} `);
  });
});

describe("flair#1834 PR-H round 2 — installHook: unsafe source ids are refused", () => {
  it("decoy BEHIND in the id + real pin AHEAD → source refusal", () => {
    const id = `ghost@${FLAIR_MCP_PACKAGE}@${STALE_VER}`;
    const before = claudeCmd(`FLAIR_AGENT_ID=${id}`, AHEAD_VER);
    const path = writeHook(before);
    const original = readFileSync(path, "utf-8");

    const res = install();

    expect(res.ok).toBe(false);
    expect(res.message).toContain("cannot be safely written");
    expect(readdirSync(join(isoHome, ".claude"))).toEqual(["settings.json"]);
    expect(readFileSync(path, "utf-8")).toBe(original);
    expect(readHookCommand()).toContain(`-p ${FLAIR_MCP_PACKAGE}@${AHEAD_VER} `);
  });

  it("decoy AHEAD in the id + real pin stale → source refusal", () => {
    const id = `ghost@${FLAIR_MCP_PACKAGE}@${AHEAD_VER}`;
    const before = claudeCmd(`FLAIR_AGENT_ID=${id}`, STALE_VER);
    writeHook(before);

    const res = install();

    expect(res.ok).toBe(false);
    expect(res.message).toContain("cannot be safely written");
    expect(readdirSync(join(isoHome, ".claude"))).toEqual(["settings.json"]);
    expect(readHookCommand()).toBe(before);
  });
});
