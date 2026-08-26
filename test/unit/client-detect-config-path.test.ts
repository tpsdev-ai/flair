// flair#1417 — detectClients() treats a known config path as presence, not
// only the CLI binary on PATH.
//
// Cursor is the field failure: it is a GUI app whose `cursor` shell command
// is an opt-in install step. Users with a working Cursor and ~/.cursor/mcp.json
// but no `cursor` on PATH were reported as not-detected, and `doctor --fix`
// skipped them.
//
// The same signal applies to every kind:"mcp" client that already has a
// known config path (claude-code, codex, gemini, antigravity). Per-client
// `detect` stays the exception (pi already uses it).
//
// POWERED CHECK: the Cursor config-only case MUST fail against current main,
// where detection is binary-only and returns detected:false.
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  ALL_CLIENTS,
  clientConfigPath,
  detectClients,
  type ClientId,
} from "../../src/install/clients.ts";

let isoHome: string;
let prevHome: string | undefined;
let prevPath: string | undefined;

beforeEach(() => {
  isoHome = mkdtempSync(join(tmpdir(), "flair-detect-home-"));
  prevHome = process.env.HOME;
  prevPath = process.env.PATH;
  process.env.HOME = isoHome;
  // Equivalent of stubbing binInPath false: an isolated PATH with no client
  // binaries. binInPath is not exported; PATH isolation is how this module's
  // tests already turn the binary signal off (see pi-client.test.ts).
  process.env.PATH = join(isoHome, "empty-bin");
  mkdirSync(process.env.PATH, { recursive: true });
});

afterEach(() => {
  if (prevHome !== undefined) process.env.HOME = prevHome;
  else delete process.env.HOME;
  if (prevPath !== undefined) process.env.PATH = prevPath;
  else delete process.env.PATH;
  rmSync(isoHome, { recursive: true, force: true });
});

function detected(id: ClientId): boolean {
  return detectClients().find((c) => c.id === id)!.detected;
}

function writeConfig(id: ClientId, body = "{}\n"): string {
  const path = clientConfigPath(id);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  return path;
}

describe("Cursor detection via ~/.cursor/mcp.json (flair#1417)", () => {
  it("POWERED: detected when binInPath is false and ~/.cursor/mcp.json exists", () => {
    writeConfig("cursor", JSON.stringify({ mcpServers: {} }, null, 2));
    expect(detected("cursor")).toBe(true);
  });

  it("NEGATIVE: not detected when neither the binary nor ~/.cursor/mcp.json is present", () => {
    expect(detected("cursor")).toBe(false);
  });
});

describe("config-path fallback is general for kind:mcp clients (flair#1417)", () => {
  const mcpIds = ALL_CLIENTS.filter((c) => c.kind === "mcp").map((c) => c.id);

  it("every MCP client has a known config path — none stay binary-only for lack of a helper", () => {
    for (const id of mcpIds) {
      expect(clientConfigPath(id).length).toBeGreaterThan(0);
    }
  });

  it("detects each MCP client from its config file alone when the binary is absent", () => {
    for (const id of mcpIds) {
      writeConfig(id);
      expect(`${id}=${detected(id)}`).toBe(`${id}=true`);
      rmSync(clientConfigPath(id));
    }
  });

  it("a sibling's config does not detect Cursor", () => {
    writeConfig("gemini");
    writeConfig("antigravity");
    expect(detected("cursor")).toBe(false);
    expect(detected("gemini")).toBe(true);
    expect(detected("antigravity")).toBe(true);
  });

  it("NEGATIVE: no MCP client is detected when PATH and every config path are empty", () => {
    for (const id of mcpIds) {
      expect(`${id}=${detected(id)}`).toBe(`${id}=false`);
    }
  });
});
