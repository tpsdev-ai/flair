/**
 * json-client-pin-refresh-1834.test.ts — flair#1834 PR-A1.
 *
 * THE DEFECT (0.55.1 fleet). `flair upgrade`'s pin refresh REBUILT each wired
 * JSON MCP entry from a host-wide identity guess (the first non-node `.key` in
 * ~/.flair/keys). On the 0.55.1 deploy that rewrote every wired MCP client's
 * FLAIR_AGENT_ID to whichever key sorted first — corrupting identities that
 * cannot be recovered.
 *
 * THE INVARIANT (A1). A pin refresh changes ONLY the `@tpsdev-ai/flair-mcp`
 * element of the entry's `args`. The entry after the write is deep-equal to the
 * entry before, except that one array element: FLAIR_AGENT_ID, FLAIR_URL, other
 * env keys, `type`, `command`, other args and other fields are all untouched.
 *
 * These tests drive the ONE writer both upgrade call paths and doctor --fix use
 * (`refreshOwnedPins`). They are RED on 5aee3236 (the refresh skipped MCP when no
 * agent id was supplied — so nothing advanced) and GREEN after the pin-only
 * writer lands.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { refreshOwnedPins } from "../../src/lib/owned-pins.ts";
import { clientConfigPath, ALL_CLIENTS } from "../../src/install/clients.ts";
import { FLAIR_MCP_PACKAGE, flairCliVersion, mcpServerSpec } from "../../src/lib/mcp-spec.ts";
import { parseSemverCore } from "../../src/fabric-upgrade.ts";

const INSTALLED = flairCliVersion();
const CURRENT_SPEC = mcpServerSpec();
const core = parseSemverCore(INSTALLED);
if (!core) throw new Error(`CLI version is not semver: ${INSTALLED}`);
// One patch behind the running CLI — a stale pin the refresh must advance.
const STALE_VER = core[2] > 0 ? `${core[0]}.${core[1]}.${core[2] - 1}` : `${core[0]}.${core[1] - 1}.0`;
const STALE_SPEC = `${FLAIR_MCP_PACKAGE}@${STALE_VER}`;

let isoHome: string;
let prevHome: string | undefined;

beforeEach(() => {
  isoHome = mkdtempSync(join(tmpdir(), "flair-1834-a1-"));
  prevHome = process.env.HOME;
  process.env.HOME = isoHome;
});

afterEach(() => {
  if (prevHome !== undefined) process.env.HOME = prevHome;
  else delete process.env.HOME;
  rmSync(isoHome, { recursive: true, force: true });
});

function pathOf(id: string): string {
  return clientConfigPath(id as never);
}

function writeRaw(id: string, text: string): string {
  const p = pathOf(id);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, text);
  return p;
}

function writeConfig(id: string, entry: unknown): string {
  return writeRaw(id, JSON.stringify({ mcpServers: { flair: entry } }, null, 2) + "\n");
}

function readEntry(id: string): any {
  return JSON.parse(readFileSync(pathOf(id), "utf-8")).mcpServers?.flair;
}

/** Deep-clone an entry and set its args[index] — the ONLY change a refresh may make. */
function expectedAfterRefresh(entry: any, index: number, spec: string): any {
  const clone = JSON.parse(JSON.stringify(entry));
  clone.args[index] = spec;
  return clone;
}

const REFRESH = () => refreshOwnedPins({ homeDir: isoHome });

// ── T1 — the 0.55.1 attacker fixture, through the shared refresh ───────────

describe("T1 — a pin refresh preserves every field but the pin (attacker fixture)", () => {
  it("Claude Code (agent b, remote URL, extra env + field, type stdio) and Gemini (no identity)", () => {
    // Claude Code: wired as agent "b" with a remote FLAIR_URL, an extra env key,
    // `type: "stdio"` and a further field. Keys a < b < c exist on the host; the
    // OLD refresh would have written "a" (the first key) into FLAIR_AGENT_ID.
    const claudeEntry = {
      type: "stdio",
      command: "npx",
      args: ["-y", STALE_SPEC],
      env: {
        FLAIR_AGENT_ID: "b",
        FLAIR_URL: "http://remote.invalid:9911",
        FLAIR_EXTRA: "keep-me",
      },
      disabled: false,
    };
    writeConfig("claude-code", claudeEntry);

    // Gemini: an entry with NO FLAIR_AGENT_ID at all — still one of ours.
    const geminiEntry = {
      command: "npx",
      args: ["-y", STALE_SPEC],
      env: { FLAIR_URL: "http://127.0.0.1:9926" },
    };
    writeConfig("gemini", geminiEntry);

    // Both upgrade call paths invoke the same refresh (post-install and the
    // stale-pin-only path); driving it twice is the seam both use.
    const results = REFRESH();

    const claudeAfter = readEntry("claude-code");
    expect(claudeAfter).toEqual(expectedAfterRefresh(claudeEntry, 1, CURRENT_SPEC));
    // The identity is UNTOUCHED — this is the whole bug.
    expect(claudeAfter.env.FLAIR_AGENT_ID).toBe("b");
    expect(claudeAfter.env.FLAIR_URL).toBe("http://remote.invalid:9911");
    expect(claudeAfter.env.FLAIR_EXTRA).toBe("keep-me");
    expect(claudeAfter.type).toBe("stdio");
    expect(claudeAfter.disabled).toBe(false);

    // Gemini's pin advances; its entry stays identity-less.
    const geminiAfter = readEntry("gemini");
    expect(geminiAfter.args[1]).toBe(CURRENT_SPEC);
    expect(geminiAfter.env?.FLAIR_AGENT_ID).toBeUndefined();

    // The report names the client advanced and the one with no identity.
    const claudeResult = results.find((r) => r.target.id === "claude-code")!;
    expect(claudeResult.action).toBe("update");
    expect(claudeResult.message).toContain("re-pinned");
    expect(claudeResult.message).toContain(STALE_SPEC);
    expect(claudeResult.message).toContain(CURRENT_SPEC);
    const geminiResult = results.find((r) => r.target.id === "gemini")!;
    expect(geminiResult.action).toBe("update");
    expect(geminiResult.message).toContain("no identity configured");
  });

  it("the upgrade refresh no longer resolves a host-wide identity (no first-key guess)", () => {
    const src = readFileSync(join(import.meta.dirname, "..", "..", "src", "commands", "upgrade.ts"), "utf-8");
    expect(src).not.toContain("resolveAgentIdOrEnv");
    expect(src).not.toContain("isNodeKeyId");
    expect(src).toContain("refreshOwnedPins(");
  });
});

// ── T2 — doctor --fix's targeted re-pin ────────────────────────────────────

describe("T2 — doctor --fix targeted re-pin preserves env/fields and honours the restriction", () => {
  it("only the restricted target is written; its extra env keys and fields survive", () => {
    const claudeEntry = {
      command: "npx",
      args: ["-y", STALE_SPEC],
      env: { FLAIR_AGENT_ID: "claude-agent", FLAIR_URL: "http://127.0.0.1:9926", KEEP: "1" },
      note: "hand-added",
    };
    writeConfig("claude-code", claudeEntry);
    // A second behind client that is NOT in the target restriction.
    const geminiEntry = { command: "npx", args: ["-y", STALE_SPEC], env: { FLAIR_AGENT_ID: "gemini-agent" } };
    writeConfig("gemini", geminiEntry);
    const geminiBefore = readFileSync(pathOf("gemini"), "utf-8");

    // doctor --fix passes only kind/id (the agentId/flairUrl overrides are gone).
    const results = refreshOwnedPins({
      homeDir: isoHome,
      targets: [{ kind: "mcp-client", id: "claude-code" }],
    });

    const claudeAfter = readEntry("claude-code");
    expect(claudeAfter).toEqual(expectedAfterRefresh(claudeEntry, 1, CURRENT_SPEC));
    expect(claudeAfter.env.FLAIR_AGENT_ID).toBe("claude-agent");
    expect(claudeAfter.env.KEEP).toBe("1");
    expect(claudeAfter.note).toBe("hand-added");

    // The unrestricted client was not visited.
    expect(readFileSync(pathOf("gemini"), "utf-8")).toBe(geminiBefore);
    expect(results.some((r) => r.target.id === "gemini")).toBe(false);
    expect(results.find((r) => r.target.id === "claude-code")?.action).toBe("update");
  });
});

// ── T4 — identity-bearing entry with no identifiable package ───────────────

describe("T4 — an entry with no identifiable package is HELD, byte-identical", () => {
  it("args with no flair-mcp element → HOLD, file unchanged", () => {
    const entry = {
      command: "npx",
      args: ["-y"],
      env: { FLAIR_AGENT_ID: "someone", FLAIR_URL: "http://127.0.0.1:9926" },
    };
    const p = writeConfig("claude-code", entry);
    const before = readFileSync(p, "utf-8");

    const results = REFRESH();
    expect(readFileSync(p, "utf-8")).toBe(before);
    const held = results.find((r) => r.target.id === "claude-code");
    expect(held?.action).toBe("hold");
    expect(held?.message).toContain("HOLD");
  });
});

// ── T9 — duplicate / ambiguous shapes → HOLD, byte-identical ───────────────

describe("T9 — duplicated keys and ambiguous args are HELD, byte-identical", () => {
  it("two `flair` keys under mcpServers", () => {
    const raw =
      `{\n  "mcpServers": {\n` +
      `    "flair": { "command": "npx", "args": ["-y", "${STALE_SPEC}"], "env": { "FLAIR_AGENT_ID": "x" } },\n` +
      `    "flair": { "command": "npx", "args": ["-y", "${STALE_SPEC}"], "env": { "FLAIR_AGENT_ID": "y" } }\n` +
      `  }\n}\n`;
    const p = writeRaw("claude-code", raw);
    const before = readFileSync(p, "utf-8");
    const results = REFRESH();
    expect(readFileSync(p, "utf-8")).toBe(before);
    expect(results.find((r) => r.target.id === "claude-code")?.action).toBe("hold");
  });

  it("two FLAIR_AGENT_ID keys in one entry", () => {
    const raw =
      `{\n  "mcpServers": {\n    "flair": {\n      "command": "npx",\n` +
      `      "args": ["-y", "${STALE_SPEC}"],\n` +
      `      "env": { "FLAIR_AGENT_ID": "x", "FLAIR_AGENT_ID": "y" }\n    }\n  }\n}\n`;
    const p = writeRaw("claude-code", raw);
    const before = readFileSync(p, "utf-8");
    const results = REFRESH();
    expect(readFileSync(p, "utf-8")).toBe(before);
    expect(results.find((r) => r.target.id === "claude-code")?.action).toBe("hold");
  });

  it("a bare and a pinned package argument in one entry", () => {
    const entry = {
      command: "npx",
      args: ["-y", FLAIR_MCP_PACKAGE, STALE_SPEC],
      env: { FLAIR_AGENT_ID: "x" },
    };
    const p = writeConfig("claude-code", entry);
    const before = readFileSync(p, "utf-8");
    const results = REFRESH();
    expect(readFileSync(p, "utf-8")).toBe(before);
    expect(results.find((r) => r.target.id === "claude-code")?.action).toBe("hold");
  });
});

// ── T10 — Cursor and Antigravity preservation ──────────────────────────────

describe("T10 — Cursor and Antigravity entries are preserved", () => {
  it("Cursor: pin advances, extra env keys and fields preserved", () => {
    const entry = {
      command: "npx",
      args: ["-y", STALE_SPEC],
      env: { FLAIR_AGENT_ID: "cursor-agent", FLAIR_URL: "http://127.0.0.1:1234", EXTRA: "keep" },
      custom: { nested: true },
    };
    writeConfig("cursor", entry);
    REFRESH();
    const after = readEntry("cursor");
    expect(after).toEqual(expectedAfterRefresh(entry, 1, CURRENT_SPEC));
    expect(after.env.FLAIR_AGENT_ID).toBe("cursor-agent");
    expect(after.custom).toEqual({ nested: true });
  });

  it("Antigravity: pin advances, entry preserved, and a full wire keeps the 'unverified' wording", () => {
    const entry = { command: "npx", args: ["-y", STALE_SPEC], env: { FLAIR_AGENT_ID: "ag-agent" } };
    writeConfig("antigravity", entry);
    REFRESH();
    const after = readEntry("antigravity");
    expect(after).toEqual(expectedAfterRefresh(entry, 1, CURRENT_SPEC));

    // The full wire (init / doctor's explicit wire) keeps its honest note.
    const antigravity = ALL_CLIENTS.find((c) => c.id === "antigravity")!;
    const wire = antigravity.wire({ FLAIR_AGENT_ID: "ag-agent", FLAIR_URL: "http://127.0.0.1:9926" });
    expect(wire.message).toContain("unverified");
    expect(wire.message).not.toContain("restart Antigravity to pick it up");
  });
});

// ── T12b — the documented path's shape: two identities, all pins advance ───

describe("T12b — two distinct identities survive a refresh; every pin advances", () => {
  it("claude (b) + cursor (c) with extra keys: identities intact, both pins advance", () => {
    const claudeEntry = {
      command: "npx",
      args: ["-y", STALE_SPEC],
      env: { FLAIR_AGENT_ID: "b", FLAIR_URL: "http://127.0.0.1:9926", KEEP_A: "1" },
    };
    const cursorEntry = {
      command: "npx",
      args: ["-y", STALE_SPEC],
      env: { FLAIR_AGENT_ID: "c", FLAIR_URL: "http://other.invalid:1", KEEP_B: "2" },
    };
    writeConfig("claude-code", claudeEntry);
    writeConfig("cursor", cursorEntry);

    // Upgrade refresh, then doctor --fix's targeted re-pin (both paths).
    REFRESH();
    refreshOwnedPins({ homeDir: isoHome, targets: [{ kind: "mcp-client", id: "claude-code" }, { kind: "mcp-client", id: "cursor" }] });

    const claudeAfter = readEntry("claude-code");
    const cursorAfter = readEntry("cursor");
    expect(claudeAfter).toEqual(expectedAfterRefresh(claudeEntry, 1, CURRENT_SPEC));
    expect(cursorAfter).toEqual(expectedAfterRefresh(cursorEntry, 1, CURRENT_SPEC));
    expect(claudeAfter.env.FLAIR_AGENT_ID).toBe("b");
    expect(cursorAfter.env.FLAIR_AGENT_ID).toBe("c");
    expect(cursorAfter.env.FLAIR_URL).toBe("http://other.invalid:1");
  });
});
