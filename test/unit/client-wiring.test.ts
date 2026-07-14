import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  wireGemini,
  wireCursor,
  wireCodex,
  tomlSnippet,
  codexConfigHasFlairSection,
  appendCodexFlairBlock,
} from "../../src/install/clients.ts";
import { resolveWireFlairUrl } from "../../src/doctor-client.ts";

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

  // flair#727 — an existing config.toml used to force manual mode
  // unconditionally. Appending a `[mcp_servers.flair]` table at EOF is safe
  // TOML when that exact header isn't already present, so this is now the
  // same "append-if-missing, report already-wired if present" idempotency
  // the JSON clients (wireGemini/wireCursor above) use — never a blind
  // overwrite, never a lie that manual wiring is needed just because *some*
  // file exists.
  it("Codex: appends the block when config.toml exists but has no [mcp_servers.flair] section, preserving prior content", () => {
    const cfgPath = join(isoHome, ".codex", "config.toml");
    mkdirSync(join(isoHome, ".codex"), { recursive: true });
    writeFileSync(cfgPath, "[some_other_table]\nkey = 1\n");
    const res = wireCodex(ENV);
    expect(res.ok).toBe(true);
    expect(res.message).toContain("wired");
    const toml = readFileSync(cfgPath, "utf-8");
    expect(toml).toContain("[some_other_table]");   // preserved
    expect(toml).toContain("key = 1");               // preserved
    expect(toml).toContain("[mcp_servers.flair]");   // added
    expect(toml).toContain(`FLAIR_AGENT_ID = "wirebot"`);
    expect(toml).toContain(`FLAIR_URL = "${ENV.FLAIR_URL}"`);
  });

  it("Codex: skip-when-present — reports already-wired (ok:true, no write) when [mcp_servers.flair] already exists, and doesn't touch the file", () => {
    const cfgPath = join(isoHome, ".codex", "config.toml");
    mkdirSync(join(isoHome, ".codex"), { recursive: true });
    const existingToml = tomlSnippet({ FLAIR_AGENT_ID: "someoneelse", FLAIR_URL: "http://127.0.0.1:1111" }) + "\n";
    writeFileSync(cfgPath, existingToml);
    const res = wireCodex(ENV);
    expect(res.ok).toBe(true);
    expect(res.message).toContain("already wired");
    // File must be byte-for-byte untouched — no TOML parser, no safe rewrite.
    expect(readFileSync(cfgPath, "utf-8")).toBe(existingToml);
  });

  it("Codex: manual-fallback only for the genuinely unreadable case — never for 'file exists'", () => {
    // A directory in place of the config file makes readFileSync throw
    // (EISDIR) regardless of process UID — a portable way to force the
    // catch-block fallback without relying on chmod (which no-ops for root).
    const cfgPath = join(isoHome, ".codex", "config.toml");
    mkdirSync(cfgPath, { recursive: true });
    const res = wireCodex(ENV);
    expect(res.ok).toBe(false);
    expect(res.message).toContain("manual wiring needed");
    expect(res.message).toContain("could not write");
    expect(res.message).toContain("[mcp_servers.flair]"); // correct snippet still printed
    expect(res.message).toContain(ENV.FLAIR_URL);          // and it's the real URL, not a bare host
  });

  // flair#727 bug 1 — the manual-print block (and the auto-write path, which
  // shares the same template) rendered a bare host with no scheme/port. Cover
  // the exact regression: a properly configured port renders a full URL.
  it("tomlSnippet: renders the full scheme+port URL, never a bare host", () => {
    const rendered = tomlSnippet({ FLAIR_AGENT_ID: "wirebot", FLAIR_URL: "http://127.0.0.1:19926" });
    expect(rendered).toContain('FLAIR_URL = "http://127.0.0.1:19926"');
    expect(rendered).not.toContain('FLAIR_URL = "127.0.0.1"');
  });

  describe("codexConfigHasFlairSection (append-decision, pure)", () => {
    it("false on empty content", () => {
      expect(codexConfigHasFlairSection("")).toBe(false);
    });
    it("false when only an unrelated table is present", () => {
      expect(codexConfigHasFlairSection("[some_other_table]\nkey = 1\n")).toBe(false);
    });
    it("true when [mcp_servers.flair] header is present", () => {
      expect(codexConfigHasFlairSection("[mcp_servers.flair]\ncommand = \"npx\"\n")).toBe(true);
    });
  });

  describe("appendCodexFlairBlock (pure merge)", () => {
    it("adds a blank-line separator when the existing content doesn't end in one", () => {
      const merged = appendCodexFlairBlock("[some_other_table]\nkey = 1", ENV);
      expect(merged).toBe("[some_other_table]\nkey = 1\n\n" + tomlSnippet(ENV) + "\n");
    });
    it("doesn't add a redundant blank line when content already ends in one", () => {
      const merged = appendCodexFlairBlock("[some_other_table]\nkey = 1\n\n", ENV);
      expect(merged).toBe("[some_other_table]\nkey = 1\n\n" + tomlSnippet(ENV) + "\n");
    });
    it("handles empty existing content (equivalent to a clean create)", () => {
      const merged = appendCodexFlairBlock("", ENV);
      expect(merged).toBe(tomlSnippet(ENV) + "\n");
    });
  });
});

// flair#727 bug 1 — resolveWireFlairUrl (src/doctor-client.ts) decides which
// FLAIR_URL doctor's client-integration --fix feeds into wire*(): a
// pre-existing but malformed value (bare host, no scheme/port) must never
// flow through into a freshly suggested block.
describe("resolveWireFlairUrl (flair#727 — never propagate a malformed existing URL)", () => {
  it("URL rendering with a configured port: falls back to baseUrl when no existing value", () => {
    expect(resolveWireFlairUrl(undefined, "http://127.0.0.1:19926")).toBe("http://127.0.0.1:19926");
  });

  it("rejects a bare host with no scheme/port — the exact flair#727 regression shape", () => {
    expect(resolveWireFlairUrl("127.0.0.1", "http://127.0.0.1:19926")).toBe("http://127.0.0.1:19926");
  });

  it("rejects an empty string", () => {
    expect(resolveWireFlairUrl("", "http://127.0.0.1:19926")).toBe("http://127.0.0.1:19926");
  });

  it("preserves a well-formed existing http(s) URL instead of overriding it with baseUrl", () => {
    expect(resolveWireFlairUrl("http://127.0.0.1:9999", "http://127.0.0.1:19926")).toBe("http://127.0.0.1:9999");
    expect(resolveWireFlairUrl("https://flair.example.com", "http://127.0.0.1:19926")).toBe("https://flair.example.com");
  });

  it("rejects a non-http(s) scheme", () => {
    expect(resolveWireFlairUrl("ftp://127.0.0.1:19926", "http://127.0.0.1:19926")).toBe("http://127.0.0.1:19926");
  });
});
