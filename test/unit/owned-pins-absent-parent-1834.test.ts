/**
 * owned-pins-absent-parent-1834.test.ts — flair#1834 A1 round 2 (Kern BLOCKING).
 *
 * refreshOwnedPins now calls the pin-only writer for all five JSON MCP targets.
 * On a home where a client's config PARENT does not exist (a Claude-Code-only
 * machine has no ~/.gemini, ~/.cursor or ~/.gemini/config), the primitive cannot
 * resolve the parent and refuses; the writer classified that as `failed`
 * (ok:false), which both upgrade paths PRINT — 2-3 failure-looking lines on most
 * machines. It was never a failure: there is nothing to visit. The old code
 * quietly skipped.
 *
 * RED on fa1fc3cb (the absent-parent case is printed as ok:false); the EACCES
 * control is green there (an unreadable parent was already reported).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { refreshOwnedPins, ownedPinRefreshShouldReport } from "../../src/lib/owned-pins.ts";
import { clientConfigPath } from "../../src/install/clients.ts";
import { FLAIR_MCP_PACKAGE } from "../../src/lib/mcp-spec.ts";

let isoHome: string;
let prevHome: string | undefined;
const chmods: Array<{ path: string; mode: number }> = [];

beforeEach(() => {
  isoHome = mkdtempSync(join(tmpdir(), "flair-1834-ap-"));
  prevHome = process.env.HOME;
  process.env.HOME = isoHome;
});

afterEach(() => {
  for (const c of chmods.splice(0)) { try { chmodSync(c.path, c.mode); } catch { /* gone */ } }
  if (prevHome !== undefined) process.env.HOME = prevHome;
  else delete process.env.HOME;
  rmSync(isoHome, { recursive: true, force: true });
});

function wireClaude(): void {
  const p = clientConfigPath("claude-code");
  writeFileSync(p, JSON.stringify({
    mcpServers: { flair: { command: "npx", args: ["-y", `${FLAIR_MCP_PACKAGE}@0.54.0`], env: { FLAIR_AGENT_ID: "x", FLAIR_URL: "http://127.0.0.1:9926" } } },
  }, null, 2) + "\n");
}

describe("flair#1834 round 2 — absent parent is a quiet skip", () => {
  it("a home with only ~/.claude.json wired: gemini/cursor/antigravity report nothing (no ok:false)", () => {
    wireClaude();
    const results = refreshOwnedPins({ homeDir: isoHome });
    for (const id of ["gemini", "cursor", "antigravity"]) {
      const r = results.find((x) => x.target.id === id);
      expect(r, `${id} should have a result`).toBeDefined();
      expect(r!.ok, `${id} must not be a failure`).toBe(true);
      expect(r!.action).toBe("skip");
      expect(ownedPinRefreshShouldReport(r!)).toBe(false);
    }
  });

  it("CONTROL: an unreadable parent (EACCES) is still reported (loud)", () => {
    const dir = join(isoHome, ".gemini");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "settings.json"), "{\n}\n");
    chmodSync(dir, 0o000);
    chmods.push({ path: dir, mode: 0o755 });

    const results = refreshOwnedPins({ homeDir: isoHome });
    const r = results.find((x) => x.target.id === "gemini");
    expect(r).toBeDefined();
    expect(r!.ok).toBe(false);
    expect(ownedPinRefreshShouldReport(r!)).toBe(true);
  });

  it("a DANGLING symlink parent is LOUD (broken config), naming the link", () => {
    // ~/.gemini is a symlink whose target does not exist. statSync would follow
    // it and report ENOENT, quiet-skipping a genuinely broken configuration.
    symlinkSync(join(isoHome, "missing-gemini-target"), join(isoHome, ".gemini"));
    const results = refreshOwnedPins({ homeDir: isoHome });
    const r = results.find((x) => x.target.id === "gemini");
    expect(r).toBeDefined();
    expect(r!.ok).toBe(false);
    expect(r!.message).toContain(".gemini");
    expect(ownedPinRefreshShouldReport(r!)).toBe(true);
  });
});
