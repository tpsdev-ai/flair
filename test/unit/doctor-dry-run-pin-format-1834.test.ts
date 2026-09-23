/**
 * doctor-dry-run-pin-format-1834.test.ts — flair#1834 A2 round 2 (CodeRabbit MINOR).
 *
 * `flair doctor --fix --dry-run`'s MCP re-pin lines must match the REAL run's
 * format (`refreshOwnedPins`). Two defects on d8f04172:
 *   1. the would-re-pin line printed the package TWICE — `dec.result.oldPin` is
 *      already the full pinned spec (`@tpsdev-ai/flair-mcp@<ver>`), and the line
 *      re-prefixed `${FLAIR_MCP_PACKAGE}@`, yielding `@@tpsdev-ai/flair-mcp@...`;
 *   2. the HOLD line omitted the client label the real run prints
 *      (`HOLD <client.label>: <reason>`), so a multi-client dry-run did not say
 *      which client each hold applied to.
 *
 * Drives the real CLI with an isolated HOME and asserts the printed lines.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { clientConfigPath } from "../../src/install/clients.ts";
import { FLAIR_MCP_PACKAGE, mcpServerSpec, flairCliVersion } from "../../src/lib/mcp-spec.ts";
import { parseSemverCore } from "../../src/fabric-upgrade.ts";

const CLI_SOURCE = join(import.meta.dirname, "..", "..", "src", "cli.ts");
const CURRENT_SPEC = mcpServerSpec();
const core = parseSemverCore(flairCliVersion());
if (!core) throw new Error(`CLI version is not semver: ${flairCliVersion()}`);
const STALE_VER = core[2] > 0 ? `${core[0]}.${core[1]}.${core[2] - 1}` : `${core[0]}.${core[1] - 1}.0`;
const STALE_SPEC = `${FLAIR_MCP_PACKAGE}@${STALE_VER}`;
// A port nothing listens on — keeps doctor away from any real local Flair.
const DEAD_PORT = "59993";

let isoHome: string;
let isoCwd: string;
let prevHome: string | undefined;

beforeEach(() => {
  isoHome = mkdtempSync(join(tmpdir(), "flair-1834-dry-"));
  isoCwd = mkdtempSync(join(tmpdir(), "flair-1834-dry-cwd-"));
  prevHome = process.env.HOME;
  process.env.HOME = isoHome;
});
afterEach(() => {
  if (prevHome !== undefined) process.env.HOME = prevHome;
  else delete process.env.HOME;
  rmSync(isoHome, { recursive: true, force: true });
  rmSync(isoCwd, { recursive: true, force: true });
});

function writeClaudeConfig(entry: unknown): string {
  const p = clientConfigPath("claude-code");
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, JSON.stringify({ mcpServers: { flair: entry } }, null, 2) + "\n");
  return p;
}

function runDryRun(): { exitCode: number | null; stdout: string; stderr: string } {
  const r = spawnSync("bun", [CLI_SOURCE, "doctor", "--fix", "--dry-run", "--port", DEAD_PORT, "--agent", "dry-canary"], {
    cwd: isoCwd, // doctor --fix appends to ./CLAUDE.md — keep that off the repo
    env: {
      ...process.env,
      HOME: isoHome,
      USERPROFILE: isoHome,
      FLAIR_AGENT_ID: "",
      FLAIR_URL: "",
      FLAIR_TARGET: "",
    },
    timeout: 40_000,
    encoding: "utf8",
  });
  return { exitCode: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

describe("flair#1834 A2 round 2 — doctor --fix --dry-run matches the real run's format", () => {
  it("would-re-pin line prints '(<oldPin> -> <newPin>)' once, not the package twice", () => {
    writeClaudeConfig({ command: "npx", args: ["-y", STALE_SPEC], env: { FLAIR_AGENT_ID: "keepme" } });

    const r = runDryRun();
    expect(r.stdout).toContain(`(${STALE_SPEC} -> ${CURRENT_SPEC})`);
    // The doubled-package defect: `${FLAIR_MCP_PACKAGE}@${oldPin}` where oldPin
    // is already the full spec.
    expect(r.stdout).not.toContain("@@");
  }, 60_000);

  it("holds name the client: 'HOLD <client.label>: <reason>'", () => {
    // A behind entry whose args name the package twice → the classifier HOLDs.
    // (The reading still resolves a behind pin, so the dry-run visits it.)
    writeClaudeConfig({ command: "npx", args: ["-y", STALE_SPEC, STALE_SPEC], env: { FLAIR_AGENT_ID: "keepme" } });

    const r = runDryRun();
    expect(r.stdout).toContain("HOLD Claude Code:");
    expect(r.stdout).toContain("names the package more than once");
  }, 60_000);
});
