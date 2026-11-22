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
    // The sibling table BEFORE the Flair section survives the replace.
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

  it("conflicting duplicate agent values in the env table are ambiguous → rewrite", () => {
    seed([
      "[mcp_servers.flair]",
      'command = "npx"',
      `args = ["-y", "${mcpServerSpec()}"]`,
      "",
      "[mcp_servers.flair.env]",
      'FLAIR_AGENT_ID = "agent-b"',
      `FLAIR_URL = "${URL_A}"`,
      'FLAIR_AGENT_ID = "agent-c"',
      "",
    ].join("\n"));
    const res = wireCodex(ENV_B);
    expect(res.message).toBe("Codex: wired ~/.codex/config.toml (restart Codex to pick it up)");
    const toml = readFileSync(cfgPath(), "utf-8");
    expect(toml.match(/^FLAIR_AGENT_ID/gm)?.length).toBe(1);
    expect(toml).toContain('FLAIR_AGENT_ID = "agent-b"');
  });

  it("an identical duplicate env assignment is a mismatch: a real parser rejects the file", () => {
    const raw = seed([
      "[mcp_servers.flair]",
      'command = "npx"',
      `args = ["-y", "${mcpServerSpec()}"]`,
      "",
      "[mcp_servers.flair.env]",
      `FLAIR_AGENT_ID = "${ENV_A.FLAIR_AGENT_ID}"`,
      `FLAIR_URL = "${URL_A}"`,
      `FLAIR_AGENT_ID = "${ENV_A.FLAIR_AGENT_ID}"`,
      "",
    ].join("\n"));
    // The fixture is what it claims: Bun's TOML parser rejects a duplicate key.
    expect(() => Bun.TOML.parse(raw)).toThrow();

    const res = wireCodex(ENV_A);
    expect(res.message).toBe("Codex: wired ~/.codex/config.toml (restart Codex to pick it up)");
    const toml = readFileSync(cfgPath(), "utf-8");
    expect(toml.match(/^FLAIR_AGENT_ID/gm)?.length).toBe(1);
    const after = Bun.TOML.parse(toml) as any;
    expect(after.mcp_servers.flair.env.FLAIR_AGENT_ID).toBe(ENV_A.FLAIR_AGENT_ID);
  });

  it("an indented sibling table after the Flair section survives the replace", () => {
    const raw = seed([
      "[mcp_servers.flair]",
      'command = "npx"',
      `args = ["-y", "${mcpServerSpec()}"]`,
      "",
      "[mcp_servers.flair.env]",
      `FLAIR_AGENT_ID = "${ENV_A.FLAIR_AGENT_ID}"`,
      `FLAIR_URL = "${URL_A}"`,
      "",
      "  [mcp_servers.other]",
      '  command = "echo"',
      '  args = ["hello"]',
      "",
    ].join("\n"));
    // A real TOML parser reads the indented header as its own table.
    const before = Bun.TOML.parse(raw) as any;
    expect(before.mcp_servers.other.command).toBe("echo");

    const res = wireCodex(ENV_B);
    expect(res.message).toBe("Codex: wired ~/.codex/config.toml (restart Codex to pick it up)");
    const toml = readFileSync(cfgPath(), "utf-8");
    const after = Bun.TOML.parse(toml) as any;
    expect(after.mcp_servers.flair.env.FLAIR_AGENT_ID).toBe(ENV_B.FLAIR_AGENT_ID);
    expect(after.mcp_servers.other.command).toBe("echo");
    expect(after.mcp_servers.other.args).toEqual(["hello"]);
    expect(toml).toContain('\n  [mcp_servers.other]\n  command = "echo"\n  args = ["hello"]\n');
  });
});

describe("flair#3050 round 3 — the comparison reads the env table Codex reads", () => {
  it("matching values only in [mcp_servers.flair.extra] and no env table → rewrite, not already wired", () => {
    const raw = seed([
      "[other_server]",
      'command = "echo"',
      "",
      "[mcp_servers.flair]",
      'command = "npx"',
      `args = ["-y", "${mcpServerSpec()}"]`,
      "",
      "[mcp_servers.flair.extra]",
      `FLAIR_AGENT_ID = "${ENV_A.FLAIR_AGENT_ID}"`,
      `FLAIR_URL = "${URL_A}"`,
      "",
    ].join("\n"));
    // The fixture is what it claims: a real TOML parser sees the values in
    // `extra` and no `env` table at all.
    const before = Bun.TOML.parse(raw) as any;
    expect(before.mcp_servers.flair.extra.FLAIR_AGENT_ID).toBe(ENV_A.FLAIR_AGENT_ID);
    expect(before.mcp_servers.flair.extra.FLAIR_URL).toBe(URL_A);
    expect(before.mcp_servers.flair.env).toBeUndefined();

    const res = wireCodex(ENV_A);
    expect(res.message).toBe("Codex: wired ~/.codex/config.toml (restart Codex to pick it up)");
    const toml = readFileSync(cfgPath(), "utf-8");
    const after = Bun.TOML.parse(toml) as any;
    expect(after.mcp_servers.flair.env.FLAIR_AGENT_ID).toBe(ENV_A.FLAIR_AGENT_ID);
    expect(after.mcp_servers.flair.env.FLAIR_URL).toBe(URL_A);
    expect(after.mcp_servers.flair.extra).toBeUndefined();
    expect(after.other_server.command).toBe("echo");
  });

  it("inline env with agent-a, wired for agent-b → rewritten (real TOML parse)", () => {
    const raw = seed([
      "[mcp_servers.flair]",
      'command = "npx"',
      `args = ["-y", "${mcpServerSpec()}"]`,
      `env = { FLAIR_AGENT_ID = "${ENV_A.FLAIR_AGENT_ID}", FLAIR_URL = "${URL_A}" }`,
      "",
    ].join("\n"));
    const before = Bun.TOML.parse(raw) as any;
    expect(before.mcp_servers.flair.env.FLAIR_AGENT_ID).toBe(ENV_A.FLAIR_AGENT_ID);

    const res = wireCodex(ENV_B);
    expect(res.message).toBe("Codex: wired ~/.codex/config.toml (restart Codex to pick it up)");
    const toml = readFileSync(cfgPath(), "utf-8");
    expect(toml).not.toBe(raw);
    const after = Bun.TOML.parse(toml) as any;
    expect(after.mcp_servers.flair.env.FLAIR_AGENT_ID).toBe("agent-b");
    expect(after.mcp_servers.flair.env.FLAIR_URL).toBe(URL_A);
  });

  it("inline env already carrying the same values → already wired, bytes unchanged", () => {
    const raw = seed([
      "[mcp_servers.flair]",
      'command = "npx"',
      `args = ["-y", "${mcpServerSpec()}"]`,
      `env = { FLAIR_AGENT_ID = "${ENV_A.FLAIR_AGENT_ID}", FLAIR_URL = "${URL_A}" }`,
      "",
    ].join("\n"));
    const res = wireCodex(ENV_A);
    expect(res.message).toBe("Codex: already wired in ~/.codex/config.toml");
    expect(readFileSync(cfgPath(), "utf-8")).toBe(raw);
  });
});
