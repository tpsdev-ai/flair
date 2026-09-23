/**
 * json-clients-critical-section.test.ts — flair#1778 slice 2c-i-d1, fixtures
 * E3 (boundary + delegation) and E5 (parity + the declared byte shape).
 *
 * Every writer of the four JSON client-MCP config files (~/.claude.json,
 * ~/.gemini/settings.json, ~/.cursor/mcp.json, ~/.gemini/config/mcp_config.json)
 * must go through ONE critical section, and init's Claude Code wiring must
 * DELEGATE to the shared writer rather than write ~/.claude.json itself. E3
 * pins that boundary at the source (the four JSON writers are locked; the
 * remaining raw writers are exactly the Codex/pi ones, out of this slice). E5
 * pins the user-visible lines and the ONE byte shape both writers of
 * ~/.claude.json now emit.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { wireClaudeCode, wireClaudeCodeJson, unwireClaudeCode, wireGemini, wireCursor, wireAntigravity } from "../../src/install/clients.ts";
import { FLAIR_MCP_PACKAGE, mcpServerSpec } from "../../src/lib/mcp-spec.ts";

const repoRoot = join(import.meta.dirname, "..", "..");
const clientsSrc = readFileSync(join(repoRoot, "src", "install", "clients.ts"), "utf-8");
const initSrc = readFileSync(join(repoRoot, "src", "commands", "init.ts"), "utf-8");

const ENV = { FLAIR_AGENT_ID: "wirebot", FLAIR_URL: "http://127.0.0.1:19926", FLAIR_CLIENT: "claude-code" };

/** Extract a top-level `function <name>(...) { ... }` body by brace depth. */
function functionBody(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`no function ${name} in source`);
  // Skip the parameter list (its default values may contain braces), then take
  // the body's opening brace.
  let paren = 0;
  let i = src.indexOf("(", start);
  for (; i < src.length; i++) {
    if (src[i] === "(") paren++;
    else if (src[i] === ")") { paren--; if (paren === 0) { i++; break; } }
  }
  const open = src.indexOf("{", i);
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") {
      depth--;
      if (depth === 0) return src.slice(open, j + 1);
    }
  }
  throw new Error(`unbalanced braces in ${name}`);
}

/** For every `writeFileSync(` call, the nearest preceding `function <name>(`. */
function rawWriteSites(src: string): string[] {
  const lines = src.split("\n");
  const sites: string[] = [];
  let current = "<top level>";
  for (const line of lines) {
    const fn = line.match(/^(?:export )?(?:async )?function (\w+)\s*\(/);
    if (fn) current = fn[1];
    if (line.includes("writeFileSync(")) sites.push(current);
  }
  return sites;
}

let isoHome: string;
let prevHome: string | undefined;
beforeEach(() => {
  isoHome = mkdtempSync(join(tmpdir(), "flair-2cid-home-"));
  prevHome = process.env.HOME;
  process.env.HOME = isoHome;
});
afterEach(() => {
  if (prevHome !== undefined) process.env.HOME = prevHome;
  else delete process.env.HOME;
  rmSync(isoHome, { recursive: true, force: true });
});

const claudeJsonPath = () => join(isoHome, ".claude.json");

describe("E3 — the JSON writers are on the critical section; the rest are exactly Codex/pi", () => {
  it("every JSON client-MCP writer calls the shared critical section", () => {
    expect(functionBody(clientsSrc, "wireJsonMcpCore")).toContain("withConfigCriticalSection(");
    expect(functionBody(clientsSrc, "unwireJsonMcp")).toContain("withConfigCriticalSection(");
    // And it is the shared primitive, not a private lock.
    expect(clientsSrc).toContain('from "../lib/config-critical-section.js"');
  });

  it("the writer builds its bytes with the shared encoder/backup/parser", () => {
    const body = functionBody(clientsSrc, "wireJsonMcpCore");
    expect(body).toContain("parseSettingsBytes(");
    expect(body).toContain("encodeConfig(");
    expect(body).toContain("backupBytesTo(");
  });

  it("init DELEGATES its Claude Code wiring to the shared writer — it no longer writes ~/.claude.json itself", () => {
    expect(initSrc).toContain('wireClaudeCodeJson');
    expect(initSrc).toContain("wireClaudeCodeJson(claudeEnv)");
    // The old inline writer is gone: no raw write and no hand-built entry keyed
    // into claudeJson.
    expect(initSrc).not.toContain("writeFileSync(claudeJsonPath");
    expect(initSrc).not.toContain("claudeJson.mcpServers.flair =");
    expect(initSrc).not.toContain('join(homedir(), ".claude.json")');
  });

  it("the ONLY remaining raw writeFileSync sites in clients.ts are the pi writers (out of this slice)", () => {
    const sites = rawWriteSites(clientsSrc).sort();
    // 2c-i-d2 has since migrated the Codex writers too, so with both slices in
    // the tree the only raw writeFileSync left is the pi writers (2c-i-d3).
    expect(sites).toEqual(["_unwirePi", "_wirePi"]);
  });
});

describe("E5 — parity: one byte shape for the two writers of ~/.claude.json", () => {
  it("wireClaudeCode and init's delegated writer produce byte-identical files (ONE shape)", () => {
    const homeA = mkdtempSync(join(tmpdir(), "flair-2cid-a-"));
    const homeB = mkdtempSync(join(tmpdir(), "flair-2cid-b-"));
    try {
      process.env.HOME = homeA;
      expect(wireClaudeCode(ENV).ok).toBe(true);
      process.env.HOME = homeB;
      const r = wireClaudeCodeJson(ENV);
      expect(r.kind).toBe("written");
      const a = readFileSync(join(homeA, ".claude.json"), "utf-8");
      const b = readFileSync(join(homeB, ".claude.json"), "utf-8");
      expect(b).toBe(a);
      // The declared shape: trailing newline + type:"stdio" kept.
      expect(b.endsWith("\n")).toBe(true);
      const entry = JSON.parse(b).mcpServers.flair;
      expect(entry.type).toBe("stdio");
      expect(entry.args).toEqual(["-y", mcpServerSpec()]);
    } finally {
      process.env.HOME = isoHome;
      rmSync(homeA, { recursive: true, force: true });
      rmSync(homeB, { recursive: true, force: true });
    }
  });

  it("the Gemini / Cursor / Antigravity entries are byte-for-byte unchanged (no type added, the trailing newline stays)", () => {
    // The unified `type: "stdio"` addition is scoped to Claude Code: the other
    // three JSON clients keep their existing shape.
    for (const [label, fn] of [["Gemini", wireGemini], ["Cursor", wireCursor], ["Antigravity", wireAntigravity]] as const) {
      const home = mkdtempSync(join(tmpdir(), "flair-2cid-other-"));
      try {
        process.env.HOME = home;
        expect(fn({ ...ENV, FLAIR_CLIENT: label.toLowerCase() }).ok).toBe(true);
        const cfgPath = fn === wireGemini ? join(home, ".gemini", "settings.json")
          : fn === wireCursor ? join(home, ".cursor", "mcp.json")
          : join(home, ".gemini", "config", "mcp_config.json");
        const bytes = readFileSync(cfgPath, "utf-8");
        expect(bytes.endsWith("\n")).toBe(true);
        expect("type" in JSON.parse(bytes).mcpServers.flair).toBe(false);
      } finally {
        process.env.HOME = isoHome;
        rmSync(home, { recursive: true, force: true });
      }
    }
  });

  it("report lines (init / doctor --fix / upgrade refresh share wireClaudeCode; uninstall --purge shares unwireClaudeCode)", () => {
    // fresh create (the init "created" line comes from this structured outcome)
    expect(wireClaudeCode(ENV).message).toBe("Claude Code: wired ~/.claude.json (restart Claude Code to pick it up)");
    // idempotent re-run (the init "already wired" branch)
    expect(wireClaudeCode(ENV).message).toBe("Claude Code: already wired in ~/.claude.json");
    // uninstall --purge
    expect(unwireClaudeCode().message).toBe("Claude Code: unwired ~/.claude.json");
    expect(unwireClaudeCode().message).toBe("Claude Code: no Flair MCP entry in ~/.claude.json");
  });

  it("the init rendering distinguishes created / refreshed / held / already from the STRUCTURED outcome", () => {
    // created
    const created = wireClaudeCodeJson(ENV);
    expect(created.kind).toBe("written");
    expect(created.existed).toBe(false);
    expect(created.refreshed).toBe(false);
    // already
    expect(wireClaudeCodeJson(ENV).kind).toBe("already");
    // refreshed: same env, stale pin → repin up
    const stale = { ...ENV, FLAIR_URL: ENV.FLAIR_URL, FLAIR_AGENT_ID: ENV.FLAIR_AGENT_ID };
    writeFileSync(claudeJsonPath(), JSON.stringify({ mcpServers: { flair: { command: "npx", args: ["-y", `${FLAIR_MCP_PACKAGE}@0.0.1`], env: { FLAIR_URL: ENV.FLAIR_URL, FLAIR_AGENT_ID: ENV.FLAIR_AGENT_ID } } } }, null, 2) + "\n");
    const refreshed = wireClaudeCodeJson(stale);
    expect(refreshed.kind).toBe("written");
    expect(refreshed.existed).toBe(true);
    expect(refreshed.refreshed).toBe(true);
    // held: AHEAD pin
    writeFileSync(claudeJsonPath(), JSON.stringify({ mcpServers: { flair: { command: "npx", args: ["-y", `${FLAIR_MCP_PACKAGE}@9.9.9`], env: { FLAIR_URL: ENV.FLAIR_URL, FLAIR_AGENT_ID: ENV.FLAIR_AGENT_ID } } } }, null, 2) + "\n");
    const before = readFileSync(claudeJsonPath(), "utf-8");
    const held = wireClaudeCodeJson(stale);
    expect(held.kind).toBe("held");
    expect(held.entryPresent).toBe(true);
    expect(readFileSync(claudeJsonPath(), "utf-8")).toBe(before);
  });

  it("declared byte change: an EMPTY ~/.claude.json now reads as {} and is wired (it used to throw → snippet)", () => {
    writeFileSync(claudeJsonPath(), "");
    const r = wireClaudeCodeJson(ENV);
    expect(r.kind).toBe("written");
    const cfg = JSON.parse(readFileSync(claudeJsonPath(), "utf-8"));
    expect(cfg.mcpServers.flair.type).toBe("stdio");
  });
});
