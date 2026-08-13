import { describe, it, expect, beforeAll, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  mcpServerSpec,
  flairCliVersion,
  clearFlairCliVersionCache,
  FLAIR_MCP_PACKAGE,
} from "../../src/lib/mcp-spec.ts";
import {
  ALL_CLIENTS,
  clientConfigPath,
  codexConfigHasFlairSection,
  tomlSnippet,
  type ClientId,
  type WireEnv,
} from "../../src/install/clients.ts";

/**
 * flair#1135 — after `flair upgrade`, wired MCP client configs still pin the
 * OLD `@tpsdev-ai/flair-mcp@<version>`. Re-running `flair init` says "already
 * wired" and doesn't refresh. The fix makes all three "already wired" guards
 * version-aware: a stale pin triggers a re-write; a matching pin stays a no-op.
 *
 * These tests are MUTATION-PROVEN: the stale→refresh test MUST fail before the
 * guard change (it asserts the pin updates to the current version), and the
 * current-pin→no-op test confirms idempotency (byte-identical output).
 */

const PKG_VERSION: string = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "..", "package.json"), "utf-8"),
).version;

const CURRENT_SPEC = mcpServerSpec();
const STALE_SPEC = `${FLAIR_MCP_PACKAGE}@0.0.0`; // a version that will never match

const ENV: WireEnv = { FLAIR_AGENT_ID: "pinbot", FLAIR_URL: "http://127.0.0.1:19926" };

let isoHome: string;
let prevHome: string | undefined;

beforeEach(() => {
  isoHome = mkdtempSync(join(tmpdir(), "flair-pin-refresh-"));
  prevHome = process.env.HOME;
  process.env.HOME = isoHome;
});

afterEach(() => {
  if (prevHome !== undefined) process.env.HOME = prevHome;
  else delete process.env.HOME;
  rmSync(isoHome, { recursive: true, force: true });
});

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Write a JSON MCP config with a specific pinned spec in args. */
function writeJsonConfig(clientId: ClientId, spec: string) {
  const path = clientConfigPath(clientId);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify({
    mcpServers: {
      flair: {
        command: "npx",
        args: ["-y", spec],
        env: { FLAIR_AGENT_ID: ENV.FLAIR_AGENT_ID, FLAIR_URL: ENV.FLAIR_URL },
      },
    },
  }, null, 2) + "\n");
  return path;
}

/** Write a Codex TOML config with a specific pinned spec in args. */
function writeCodexConfig(spec: string) {
  const path = clientConfigPath("codex");
  mkdirSync(join(path, ".."), { recursive: true });
  const toml = [
    `[mcp_servers.flair]`,
    `command = "npx"`,
    `args = ["-y", "${spec}"]`,
    ``,
    `[mcp_servers.flair.env]`,
    `FLAIR_AGENT_ID = "${ENV.FLAIR_AGENT_ID}"`,
    `FLAIR_URL = "${ENV.FLAIR_URL}"`,
  ].join("\n") + "\n";
  writeFileSync(path, toml);
  return path;
}

/** Read the pinned spec from a JSON config's args array. */
function readJsonPin(clientId: ClientId): string | null {
  const raw = readFileSync(clientConfigPath(clientId), "utf-8");
  const cfg = JSON.parse(raw);
  const args = cfg.mcpServers?.flair?.args;
  if (!Array.isArray(args)) return null;
  return args.find((a: string) => a.startsWith(FLAIR_MCP_PACKAGE)) ?? null;
}

/** Read the pinned spec from a Codex TOML config. */
function readCodexPin(): string | null {
  const raw = readFileSync(clientConfigPath("codex"), "utf-8");
  const m = raw.match(/args = \["-y", "([^"]+)"\]/);
  return m ? m[1] : null;
}

// ── JSON clients (Gemini, Cursor, Claude Code fallback) ────────────────────

describe("flair#1135 — JSON client pin refresh (wireJsonMcp)", () => {
  // Test every JSON-based client (all except Codex, which uses TOML).
  const jsonClients = ALL_CLIENTS.filter(c => c.id !== "codex");

  for (const client of jsonClients) {
    describe(client.label, () => {
      it("stale pin → refresh: updates to current version", () => {
        writeJsonConfig(client.id as ClientId, STALE_SPEC);
        const path = clientConfigPath(client.id as ClientId);

        // Pre-condition: the config has the stale pin.
        expect(readJsonPin(client.id as ClientId)).toBe(STALE_SPEC);

        // Wire — should refresh the pin.
        const res = client.wire({ ...ENV, FLAIR_CLIENT: client.id });
        expect(res.ok).toBe(true);
        expect(res.message).toContain("refreshed pin");

        // Post-condition: the config now has the current pin.
        expect(readJsonPin(client.id as ClientId)).toBe(CURRENT_SPEC);

        // The file should contain the current spec.
        const raw = readFileSync(path, "utf-8");
        expect(raw).toContain(CURRENT_SPEC);
      });

      it("current pin → no-op: byte-identical output", () => {
        writeJsonConfig(client.id as ClientId, CURRENT_SPEC);
        const path = clientConfigPath(client.id as ClientId);
        const before = readFileSync(path, "utf-8");

        // Wire — should be a no-op.
        const res = client.wire({ ...ENV, FLAIR_CLIENT: client.id });
        expect(res.ok).toBe(true);
        expect(res.message).toContain("already wired");

        // Post-condition: file is byte-identical.
        const after = readFileSync(path, "utf-8");
        expect(after).toBe(before);
      });

      it("no existing config → fresh wire (not a refresh)", () => {
        // No config file exists — should be a fresh wire.
        const res = client.wire({ ...ENV, FLAIR_CLIENT: client.id });
        expect(res.ok).toBe(true);
        expect(res.message).toContain("wired");
        expect(res.message).not.toContain("refreshed");
        expect(res.message).not.toContain("already wired");

        // The config should have the current pin.
        expect(readJsonPin(client.id as ClientId)).toBe(CURRENT_SPEC);
      });
    });
  }
});

// ── Codex TOML client ──────────────────────────────────────────────────────

describe("flair#1135 — Codex TOML pin refresh (_wireCodex)", () => {
  const codexClient = ALL_CLIENTS.find(c => c.id === "codex")!;

  it("stale pin → refresh: updates to current version", () => {
    writeCodexConfig(STALE_SPEC);
    const path = clientConfigPath("codex");

    // Pre-condition: the config has the stale pin.
    expect(readCodexPin()).toBe(STALE_SPEC);

    // Wire — should refresh the pin.
    const res = codexClient.wire({ ...ENV, FLAIR_CLIENT: "codex" });
    expect(res.ok).toBe(true);
    expect(res.message).toContain("refreshed pin");

    // Post-condition: the config now has the current pin.
    expect(readCodexPin()).toBe(CURRENT_SPEC);

    const raw = readFileSync(path, "utf-8");
    expect(raw).toContain(CURRENT_SPEC);
  });

  it("current pin → no-op: byte-identical output", () => {
    writeCodexConfig(CURRENT_SPEC);
    const path = clientConfigPath("codex");
    const before = readFileSync(path, "utf-8");

    // Wire — should be a no-op.
    const res = codexClient.wire({ ...ENV, FLAIR_CLIENT: "codex" });
    expect(res.ok).toBe(true);
    expect(res.message).toContain("already wired");

    // Post-condition: file is byte-identical.
    const after = readFileSync(path, "utf-8");
    expect(after).toBe(before);
  });

  it("no existing config → fresh wire (not a refresh)", () => {
    const res = codexClient.wire({ ...ENV, FLAIR_CLIENT: "codex" });
    expect(res.ok).toBe(true);
    expect(res.message).toContain("wired");
    expect(res.message).not.toContain("refreshed");
    expect(res.message).not.toContain("already wired");

    expect(readCodexPin()).toBe(CURRENT_SPEC);
  });

  it("stale pin → refresh preserves other TOML content", () => {
    const path = clientConfigPath("codex");
    mkdirSync(join(path, ".."), { recursive: true });
    const prefix = [
      `# Codex config`,
      `log_level = "info"`,
      ``,
    ].join("\n") + "\n";
    const suffix = [
      ``,
      `[other_server]`,
      `command = "echo"`,
    ].join("\n") + "\n";
    const toml = prefix +
      `[mcp_servers.flair]\ncommand = "npx"\nargs = ["-y", "${STALE_SPEC}"]\n\n[mcp_servers.flair.env]\nFLAIR_AGENT_ID = "${ENV.FLAIR_AGENT_ID}"\nFLAIR_URL = "${ENV.FLAIR_URL}"\n` +
      suffix;
    writeFileSync(path, toml);

    const res = codexClient.wire({ ...ENV, FLAIR_CLIENT: "codex" });
    expect(res.ok).toBe(true);
    expect(res.message).toContain("refreshed pin");

    const raw = readFileSync(path, "utf-8");
    // Prefix preserved.
    expect(raw).toContain("# Codex config");
    expect(raw).toContain('log_level = "info"');
    // Pin updated.
    expect(raw).toContain(CURRENT_SPEC);
    expect(raw).not.toContain(STALE_SPEC);
    // Suffix preserved.
    expect(raw).toContain("[other_server]");
    expect(raw).toContain('command = "echo"');
  });
});

// ── codexFlairSectionHasCurrentPin (internal, tested via _wireCodex) ────────

describe("flair#1135 — codexConfigHasFlairSection (existing, unchanged)", () => {
  it("detects the section header", () => {
    expect(codexConfigHasFlairSection("[mcp_servers.flair]\ncommand = \"npx\"\n")).toBe(true);
  });

  it("does not false-positive on a sub-table header", () => {
    expect(codexConfigHasFlairSection("[mcp_servers.flair.env]\nFLAIR_URL = \"...\"\n")).toBe(false);
  });

  it("does not false-positive on a different server", () => {
    expect(codexConfigHasFlairSection("[mcp_servers.other]\ncommand = \"echo\"\n")).toBe(false);
  });
});

// ── tomlSnippet (existing, unchanged — regression guard) ────────────────────

describe("flair#1135 — tomlSnippet still pins (regression guard)", () => {
  it("pins to the current version", () => {
    const snippet = tomlSnippet(ENV);
    expect(snippet).toContain(CURRENT_SPEC);
    expect(snippet).not.toContain(`"${FLAIR_MCP_PACKAGE}"`);
  });
});

// ── flair#1167 — clearFlairCliVersionCache prevents stale-cache no-op ─────

describe("flair#1167 — clearFlairCliVersionCache prevents stale-cache no-op", () => {
  const PKG_PATH = join(import.meta.dirname, "..", "..", "package.json");
  let originalPkg: string;
  let realVersion: string;

  beforeAll(() => {
    originalPkg = readFileSync(PKG_PATH, "utf-8");
    realVersion = JSON.parse(originalPkg).version;
  });

  afterEach(() => {
    // Restore the real package.json after every test that might mutate it.
    if (originalPkg) writeFileSync(PKG_PATH, originalPkg);
    clearFlairCliVersionCache();
  });

  it("stale cache → no-op without clear; refresh with clear", () => {
    const FAKE_VERSION = "99.99.99";

    // Prime the cache with the real version (simulating module-load before upgrade).
    expect(flairCliVersion()).toBe(realVersion);

    // Simulate an in-process upgrade: bump package.json to a fake newer version.
    const fakePkg = JSON.parse(originalPkg);
    fakePkg.version = FAKE_VERSION;
    writeFileSync(PKG_PATH, JSON.stringify(fakePkg, null, 2) + "\n");

    // Write a config with the OLD (real) version as the pin — this is what a
    // pre-upgrade wired config looks like.
    const oldSpec = `${FLAIR_MCP_PACKAGE}@${realVersion}`;
    writeJsonConfig("claude-code", oldSpec);

    const client = ALL_CLIENTS.find(c => c.id === "claude-code")!;

    // WITHOUT clearing the cache: mcpServerSpec() still returns the OLD cached
    // version. The pin matches → wire should no-op. This IS the bug — the
    // upgrade installed new packages but the stale cache hides the new version.
    const resStale = client.wire({ ...ENV, FLAIR_CLIENT: "claude-code" });
    expect(resStale.ok).toBe(true);
    expect(resStale.message).toContain("already wired");
    expect(readJsonPin("claude-code")).toBe(oldSpec); // Pin unchanged — BUG.

    // NOW clear the cache (simulating the fix: clearFlairCliVersionCache()
    // called after npm install -g).
    clearFlairCliVersionCache();

    // After clearing: mcpServerSpec() re-resolves from the (now bumped)
    // package.json and returns the NEW version. The pin is stale → wire
    // should refresh.
    const resFresh = client.wire({ ...ENV, FLAIR_CLIENT: "claude-code" });
    expect(resFresh.ok).toBe(true);
    expect(resFresh.message).toContain("refreshed pin");
    expect(readJsonPin("claude-code")).toBe(`${FLAIR_MCP_PACKAGE}@${FAKE_VERSION}`);
  });

  it("clearFlairCliVersionCache re-resolves from disk", () => {
    // Prime the cache.
    const v1 = flairCliVersion();
    expect(v1).toBe(realVersion);

    // Clear it.
    clearFlairCliVersionCache();

    // Re-resolve — package.json hasn't changed, so same version.
    const v2 = flairCliVersion();
    expect(v2).toBe(realVersion);
  });

  it("mcpServerSpec uses re-resolved version after cache clear", () => {
    // Prime the cache.
    flairCliVersion();

    // Clear it.
    clearFlairCliVersionCache();

    // mcpServerSpec should use the re-resolved version.
    const spec = mcpServerSpec();
    expect(spec).toBe(`${FLAIR_MCP_PACKAGE}@${realVersion}`);
  });
});
