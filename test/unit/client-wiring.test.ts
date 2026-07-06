import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { wireGemini, wireCursor, wireCodex } from "../../src/install/clients.ts";

/**
 * FIX 4 (onboarding dogfood round 1):
 * "wired" MUST mean a config file was actually written. The Codex/Gemini/Cursor
 * wire functions used to ALWAYS return "Manual wiring required" while the run
 * elsewhere claimed the client was wired. They now write the real client config
 * cross-platform, return ok:true only when a file was written, and say "manual
 * wiring needed" with the correct snippet otherwise.
 *
 * We isolate HOME to a temp dir so real ~/.gemini, ~/.cursor, ~/.codex are never
 * touched. (homedir() honors the HOME env in a fresh process; bun re-reads it.)
 */

const ENV = { FLAIR_AGENT_ID: "wirebot", FLAIR_URL: "http://127.0.0.1:19926" };
let isoHome: string;
let prevHome: string | undefined;

beforeEach(() => {
  isoHome = mkdtempSync(join(tmpdir(), "flair-wire-home-"));
  prevHome = process.env.HOME;
  process.env.HOME = isoHome;
});

afterEach(() => {
  if (prevHome !== undefined) process.env.HOME = prevHome;
  else delete process.env.HOME;
  rmSync(isoHome, { recursive: true, force: true });
});

describe("client wiring (FIX 4: 'wired' means a file was written)", () => {
  it("Gemini: writes ~/.gemini/settings.json with the flair MCP server", () => {
    const res = wireGemini(ENV);
    expect(res.ok).toBe(true);
    const cfgPath = join(isoHome, ".gemini", "settings.json");
    expect(existsSync(cfgPath)).toBe(true);
    const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
    expect(cfg.mcpServers.flair.command).toBe("npx");
    expect(cfg.mcpServers.flair.args).toEqual(["-y", "@tpsdev-ai/flair-mcp"]);
    expect(cfg.mcpServers.flair.env.FLAIR_AGENT_ID).toBe("wirebot");
    expect(cfg.mcpServers.flair.env.FLAIR_URL).toBe(ENV.FLAIR_URL);
  });

  it("Gemini: preserves existing mcpServers and is idempotent on re-run", () => {
    const cfgPath = join(isoHome, ".gemini", "settings.json");
    mkdirSync(join(isoHome, ".gemini"), { recursive: true });
    writeFileSync(cfgPath, JSON.stringify({ mcpServers: { other: { command: "x" } }, theme: "dark" }));
    const res1 = wireGemini(ENV);
    expect(res1.ok).toBe(true);
    const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
    expect(cfg.mcpServers.other).toBeDefined();         // preserved
    expect(cfg.theme).toBe("dark");                      // other keys preserved
    expect(cfg.mcpServers.flair).toBeDefined();          // added
    const res2 = wireGemini(ENV);
    expect(res2.ok).toBe(true);
    expect(res2.message).toContain("already wired");     // idempotent
  });

  it("Cursor: writes ~/.cursor/mcp.json with the flair MCP server", () => {
    const res = wireCursor(ENV);
    expect(res.ok).toBe(true);
    const cfgPath = join(isoHome, ".cursor", "mcp.json");
    expect(existsSync(cfgPath)).toBe(true);
    const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
    expect(cfg.mcpServers.flair.command).toBe("npx");
  });

  it("Codex: writes ~/.codex/config.toml on a clean box", () => {
    const res = wireCodex(ENV);
    expect(res.ok).toBe(true);
    const cfgPath = join(isoHome, ".codex", "config.toml");
    expect(existsSync(cfgPath)).toBe(true);
    const toml = readFileSync(cfgPath, "utf-8");
    expect(toml).toContain("[mcp_servers.flair]");
    expect(toml).toContain(`FLAIR_AGENT_ID = "wirebot"`);
  });

  it("Codex: says 'manual wiring needed' (ok:false) with the snippet when config.toml already exists — never lies 'wired'", () => {
    const cfgPath = join(isoHome, ".codex", "config.toml");
    mkdirSync(join(isoHome, ".codex"), { recursive: true });
    writeFileSync(cfgPath, "[some_other_table]\nkey = 1\n");
    const res = wireCodex(ENV);
    expect(res.ok).toBe(false);
    expect(res.message).toContain("manual wiring needed");
    expect(res.message).toContain("[mcp_servers.flair]"); // the correct snippet to paste
    // Must NOT have clobbered the existing file.
    expect(readFileSync(cfgPath, "utf-8")).toContain("[some_other_table]");
  });
});
