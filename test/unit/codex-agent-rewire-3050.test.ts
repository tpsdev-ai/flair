import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { wireCodex } from "../../src/install/clients.ts";
import { FLAIR_MCP_PACKAGE, mcpServerSpec } from "../../src/lib/mcp-spec.ts";

/**
 * flair#3050 — `flair init --agent <b>` must rewire Codex too.
 *
 * `_wireCodex` used to treat a `[mcp_servers.flair]` section carrying the
 * current pin as "already wired" without looking at its env, while the JSON
 * path no-ops only when the pin AND FLAIR_AGENT_ID AND FLAIR_URL all match.
 * A second init with a different agent therefore left Codex on the first one.
 */
const URL_A = "http://127.0.0.1:19926";
const ENV_A = { FLAIR_AGENT_ID: "agent-a", FLAIR_URL: URL_A };
const ENV_B = { FLAIR_AGENT_ID: "agent-b", FLAIR_URL: URL_A };

let isoHome: string;
let prevHome: string | undefined;

beforeEach(() => {
  isoHome = mkdtempSync(join(tmpdir(), "flair-3050-home-"));
  prevHome = process.env.HOME;
  process.env.HOME = isoHome;
});

afterEach(() => {
  if (prevHome !== undefined) process.env.HOME = prevHome;
  else delete process.env.HOME;
  rmSync(isoHome, { recursive: true, force: true });
});

function cfgPath(): string {
  return join(isoHome, ".codex", "config.toml");
}

function seed(section: string): string {
  mkdirSync(join(isoHome, ".codex"), { recursive: true });
  writeFileSync(cfgPath(), section);
  return section;
}

function section(spec: string, agent: string, url: string): string {
  return [
    "[other_server]",
    'command = "echo"',
    "",
    "[mcp_servers.flair]",
    'command = "npx"',
    `args = ["-y", "${spec}"]`,
    "",
    "[mcp_servers.flair.env]",
    `FLAIR_AGENT_ID = "${agent}"`,
    `FLAIR_URL = "${url}"`,
    "",
  ].join("\n");
}

describe("flair#3050 — Codex env is part of the already-wired check", () => {
  it("current pin + agent-a, called with agent-b → rewrites the env and reports wired", () => {
    seed(section(mcpServerSpec(), "agent-a", URL_A));
    const res = wireCodex(ENV_B);
    expect(res.ok).toBe(true);
    expect(res.message).toBe("Codex: wired ~/.codex/config.toml (restart Codex to pick it up)");
    const toml = readFileSync(cfgPath(), "utf-8");
    expect(toml).toContain('FLAIR_AGENT_ID = "agent-b"');
    expect(toml).not.toContain('FLAIR_AGENT_ID = "agent-a"');
    expect(toml.match(/^FLAIR_AGENT_ID/gm)?.length).toBe(1);
    // Siblings survive the section replace.
    expect(toml).toContain("[other_server]");
    expect(toml).toContain('command = "echo"');
  });

  it("current pin + a different FLAIR_URL → rewrites the URL and reports wired", () => {
    seed(section(mcpServerSpec(), ENV_A.FLAIR_AGENT_ID, "http://127.0.0.1:1111"));
    const res = wireCodex(ENV_A);
    expect(res.ok).toBe(true);
    expect(res.message).toBe("Codex: wired ~/.codex/config.toml (restart Codex to pick it up)");
    const toml = readFileSync(cfgPath(), "utf-8");
    expect(toml).toContain(`FLAIR_URL = "${URL_A}"`);
    expect(toml).not.toContain("http://127.0.0.1:1111");
    expect(toml).toContain('FLAIR_AGENT_ID = "agent-a"');
  });

  it("current pin + the same env → already wired, bytes unchanged", () => {
    const before = seed(section(mcpServerSpec(), ENV_A.FLAIR_AGENT_ID, URL_A));
    const res = wireCodex(ENV_A);
    expect(res.ok).toBe(true);
    expect(res.message).toBe("Codex: already wired in ~/.codex/config.toml");
    expect(readFileSync(cfgPath(), "utf-8")).toBe(before);
  });

  it("a pin the guard refuses to lower stays refused even when the agent differs", () => {
    const ahead = `${FLAIR_MCP_PACKAGE}@9.9.9`;
    const before = seed(section(ahead, "agent-a", URL_A));
    const res = wireCodex(ENV_B);
    expect(res.ok).toBe(true);
    expect(res.message).toContain("holding");
    expect(res.message).toContain("AHEAD");
    expect(readFileSync(cfgPath(), "utf-8")).toBe(before);
  });

  it("an unreadable env value is a mismatch, never a false already-wired", () => {
    const before = seed([
      "[mcp_servers.flair]",
      'command = "npx"',
      `args = ["-y", "${mcpServerSpec()}"]`,
      "",
      "[mcp_servers.flair.env]",
      'FLAIR_AGENT_ID = "agent-a',
      `FLAIR_URL = "${URL_A}"`,
      "",
    ].join("\n"));
    const res = wireCodex(ENV_A);
    expect(res.message).toBe("Codex: wired ~/.codex/config.toml (restart Codex to pick it up)");
    const toml = readFileSync(cfgPath(), "utf-8");
    expect(toml).not.toBe(before);
    expect(toml).toContain('FLAIR_AGENT_ID = "agent-a"');
  });

  it("conflicting duplicate agent values are ambiguous → rewrite, not a no-op on the first", () => {
    seed([
      "[mcp_servers.flair]",
      'command = "npx"',
      `args = ["-y", "${mcpServerSpec()}"]`,
      "",
      "[mcp_servers.flair.env]",
      'FLAIR_AGENT_ID = "agent-b"',
      `FLAIR_URL = "${URL_A}"`,
      "",
      "[mcp_servers.flair.extra]",
      'FLAIR_AGENT_ID = "agent-c"',
      "",
    ].join("\n"));
    const res = wireCodex(ENV_B);
    expect(res.message).toBe("Codex: wired ~/.codex/config.toml (restart Codex to pick it up)");
    const toml = readFileSync(cfgPath(), "utf-8");
    expect(toml.match(/^FLAIR_AGENT_ID/gm)?.length).toBe(1);
    expect(toml).toContain('FLAIR_AGENT_ID = "agent-b"');
  });
});
