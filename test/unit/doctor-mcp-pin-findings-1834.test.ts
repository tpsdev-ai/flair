/**
 * doctor-mcp-pin-findings-1834.test.ts — flair#1834 A1 round 2 (item 4).
 *
 * The install-health catalog filtered pin findings by the present-keyed `wired`
 * list (present = FLAIR_AGENT_ID set). So a BEHIND entry WITHOUT an identity is
 * repaired by `doctor --fix` (which now keys on entryExists) but never flagged —
 * the repair and the report disagree. Key the pin finding on entryExists; keep
 * `present` for the identity-keyed checks.
 *
 * RED on fa1fc3cb: the identity-less behind entry is not flagged.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runDoctorChecks } from "../../src/lib/doctor-run.ts";
import * as doctorRun from "../../src/lib/doctor-run.ts";
import { clientConfigPath } from "../../src/install/clients.ts";
import { FLAIR_MCP_PACKAGE, mcpServerSpec } from "../../src/lib/mcp-spec.ts";

const STALE_SPEC = `${FLAIR_MCP_PACKAGE}@0.54.0`;

let isoHome: string;
let isoCwd: string;
let prevHome: string | undefined;

beforeEach(() => {
  isoHome = mkdtempSync(join(tmpdir(), "flair-1834-pf-"));
  isoCwd = mkdtempSync(join(tmpdir(), "flair-1834-pf-cwd-"));
  prevHome = process.env.HOME;
  process.env.HOME = isoHome;
});

afterEach(() => {
  if (prevHome !== undefined) process.env.HOME = prevHome;
  else delete process.env.HOME;
  rmSync(isoHome, { recursive: true, force: true });
  rmSync(isoCwd, { recursive: true, force: true });
});

const linuxLaunchd = { state: "not-applicable" as const, detail: "linux does not use launchd" };

describe("flair#1834 round 2 — an identity-less BEHIND MCP entry is flagged", () => {
  it("catalog fails the mcp-block when the entry has a stale pin but no FLAIR_AGENT_ID", () => {
    const p = clientConfigPath("claude-code");
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, JSON.stringify({
      mcpServers: { flair: { command: "npx", args: ["-y", STALE_SPEC], env: { FLAIR_URL: "http://127.0.0.1:9926" } } },
    }, null, 2) + "\n");

    const run = runDoctorChecks({
      homeDir: isoHome,
      cwd: isoCwd,
      detectedClientIds: ["claude-code"],
      launchd: linuxLaunchd,
    });
    const mcp = run.results.find((r) => r.id === "mcp-block");
    expect(mcp?.status).toBe("fail");
    expect(mcp?.remedy).toBe("flair doctor --fix");
  });
});

// ── round 3 ────────────────────────────────────────────────────────────────

describe("flair#1834 round 3 — an identity-less CURRENT entry is INCOMPLETE, not configured", () => {
  it("warns (not pass) and names the remedy", () => {
    const p = clientConfigPath("claude-code");
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, JSON.stringify({
      mcpServers: { flair: { command: "npx", args: ["-y", mcpServerSpec()], env: { FLAIR_URL: "http://127.0.0.1:9926" } } },
    }, null, 2) + "\n");
    const run = runDoctorChecks({ homeDir: isoHome, cwd: isoCwd, detectedClientIds: ["claude-code"], launchd: linuxLaunchd });
    const mcp = run.results.find((r) => r.id === "mcp-block");
    expect(mcp?.status).toBe("warn");
    expect(mcp?.detail ?? "").toContain("FLAIR_AGENT_ID");
    expect(mcp?.detail ?? "").not.toContain("configured for");
  });

  it("an identity-less entry with an UNSAFE pin is still flagged", () => {
    const p = clientConfigPath("claude-code");
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, JSON.stringify({
      mcpServers: { flair: { command: "npx", args: ["-y", `${FLAIR_MCP_PACKAGE}@0.17.0`], env: { FLAIR_URL: "http://127.0.0.1:9926" } } },
    }, null, 2) + "\n");
    const run = runDoctorChecks({ homeDir: isoHome, cwd: isoCwd, detectedClientIds: ["claude-code"], launchd: linuxLaunchd });
    const mcp = run.results.find((r) => r.id === "mcp-block");
    expect(mcp?.status).toBe("fail");
    expect(mcp?.remedy).toBe("flair upgrade");
  });
});

describe("flair#1834 round 3 — an attempted-but-skipped re-pin renders with warn, never ok", () => {
  it("skip -> warn; update/noop -> ok; hold -> warn", () => {
    const icon = (doctorRun as any).mcpRepinIcon;
    expect(typeof icon).toBe("function");
    expect(icon("skip", true)).toBe("warn");
    expect(icon("hold", true)).toBe("warn");
    expect(icon("update", true)).toBe("ok");
    expect(icon("noop", true)).toBe("ok");
    expect(icon("update", false)).toBe("warn");
  });
});
