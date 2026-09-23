/**
 * json-duplicate-key-hardening-1834.test.ts — flair#1834 A1 round 2 (item 5).
 *
 * The literal raw scan (/"flair"\s*:/) counts ZERO for UNICODE-ESCAPED keys
 * ("\u0066lair" decodes to "flair"). JSON.parse keeps the last duplicate, so the
 * writer re-pinned and silently dropped the shadowed entry's bytes — evading the
 * "duplicate => HOLD, bytes untouched" contract.
 *
 * FIX: detect duplicate object keys by DECODED key name, per object, on the path
 * root -> mcpServers -> flair -> env. These are RED on fa1fc3cb (the escaped
 * duplicates are not detected, so the file is rewritten).
 *
 * The attack detail lives here (a unit test), not in the public PR body.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { refreshOwnedPins } from "../../src/lib/owned-pins.ts";
import { clientConfigPath } from "../../src/install/clients.ts";
import { FLAIR_MCP_PACKAGE, mcpServerSpec } from "../../src/lib/mcp-spec.ts";

const STALE_SPEC = `${FLAIR_MCP_PACKAGE}@0.54.0`;

let isoHome: string;
let prevHome: string | undefined;

beforeEach(() => {
  isoHome = mkdtempSync(join(tmpdir(), "flair-1834-dup-"));
  prevHome = process.env.HOME;
  process.env.HOME = isoHome;
});

afterEach(() => {
  if (prevHome !== undefined) process.env.HOME = prevHome;
  else delete process.env.HOME;
  rmSync(isoHome, { recursive: true, force: true });
});

function writeRaw(text: string): string {
  const p = clientConfigPath("claude-code");
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, text);
  return p;
}

function refresh() {
  return refreshOwnedPins({ homeDir: isoHome });
}

describe("flair#1834 round 2 — duplicate detection compares DECODED key names", () => {
  it("two escaped `flair` keys under mcpServers -> HOLD, byte-identical", () => {
    const raw =
      `{\n  "mcpServers": {\n` +
      `    "\\u0066lair": { "command": "npx", "args": ["-y", "${STALE_SPEC}"], "env": { "FLAIR_URL": "http://127.0.0.1:9926" } },\n` +
      `    "flair": { "command": "npx", "args": ["-y", "${STALE_SPEC}"], "env": { "FLAIR_AGENT_ID": "y" } }\n` +
      `  }\n}\n`;
    const p = writeRaw(raw);
    const before = readFileSync(p, "utf-8");
    const r = refresh().find((x) => x.target.id === "claude-code")!;
    expect(readFileSync(p, "utf-8")).toBe(before);
    expect(r.action).toBe("hold");
  });

  it("an escaped duplicate FLAIR_AGENT_ID in the entry -> HOLD, byte-identical", () => {
    const raw =
      `{\n  "mcpServers": {\n    "flair": {\n      "command": "npx",\n` +
      `      "args": ["-y", "${STALE_SPEC}"],\n` +
      `      "env": { "FLAIR_AGENT_ID": "x", "\\u0046LAIR_AGENT_ID": "y" }\n    }\n  }\n}\n`;
    const p = writeRaw(raw);
    const before = readFileSync(p, "utf-8");
    const r = refresh().find((x) => x.target.id === "claude-code")!;
    expect(readFileSync(p, "utf-8")).toBe(before);
    expect(r.action).toBe("hold");
  });

  it("a legitimate escaped key that is NOT a duplicate -> normal re-pin", () => {
    const raw =
      `{\n  "mcpServers": {\n    "flair": {\n      "command": "npx",\n` +
      `      "args": ["-y", "${STALE_SPEC}"],\n` +
      `      "env": { "FLAIR_AGENT_ID": "x", "\\u0046LAIR_URL": "http://127.0.0.1:9926" }\n    }\n  }\n}\n`;
    const p = writeRaw(raw);
    const r = refresh().find((x) => x.target.id === "claude-code")!;
    expect(r.action).toBe("update");
    expect(readFileSync(p, "utf-8")).toContain(mcpServerSpec());
  });
});
