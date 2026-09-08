/**
 * flair#908 — MCP client wiring CI gate.
 *
 * The defect was not a wrong assertion. It was that `flair init --client`
 * was never invoked by any workflow, and no workflow read back a config
 * the command wrote. These tests pin the ways that gate has to be able
 * to go red — including the skip that used to look like a pass.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ALL_CLIENTS } from "../../src/install/clients.ts";
import {
  CLOBBER_MARKER_SERVER,
  EXIT_DID_NOT_RUN,
  EXIT_OK,
  FLAIR_MCP_PACKAGE,
  PI_FLAIR_PACKAGE,
  SUPPORTED_CLIENTS,
  classifyClientReport,
  clobberClaudeFixture,
  clobberSurvived,
  parseArgs,
  parseWiringSummary,
  pinCheck,
  readJsonMcpPin,
  readPiPin,
  readTomlMcpPin,
} from "../../scripts/ci/check-mcp-client-wiring.mjs";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const SCRIPT = join(REPO_ROOT, "scripts", "ci", "check-mcp-client-wiring.mjs");
const TEST_YML = readFileSync(join(REPO_ROOT, ".github", "workflows", "test.yml"), "utf8");

function runGate(args: string[]) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

function jobBlock(): string {
  const start = TEST_YML.indexOf("\n  mcp-client-wiring:");
  expect(start).toBeGreaterThan(-1);
  const rest = TEST_YML.slice(start + 1);
  const next = rest.search(/\n  [a-z0-9-]+:/);
  return next === -1 ? rest : rest.slice(0, next);
}

describe("SUPPORTED_CLIENTS stays locked to ALL_CLIENTS", () => {
  test("the inventory is non-empty (positive control)", () => {
    expect(SUPPORTED_CLIENTS.length).toBeGreaterThan(0);
    expect(ALL_CLIENTS.length).toBeGreaterThan(0);
  });

  test("every ALL_CLIENTS entry is in the gate inventory", () => {
    const ids = new Set(SUPPORTED_CLIENTS.map((c) => c.id));
    const missing = ALL_CLIENTS.filter((c) => !ids.has(c.id)).map((c) => c.id);
    expect(missing).toEqual([]);
  });

  test("the gate inventory does not name a client ALL_CLIENTS does not", () => {
    const ids = new Set(ALL_CLIENTS.map((c) => c.id));
    const extra = SUPPORTED_CLIENTS.filter((c) => !ids.has(c.id)).map((c) => c.id);
    expect(extra).toEqual([]);
  });

  test("label and bin match the registry (so summary parsing cannot drift)", () => {
    const byId = new Map(ALL_CLIENTS.map((c) => [c.id, c]));
    for (const c of SUPPORTED_CLIENTS) {
      const src = byId.get(c.id);
      expect(src, c.id).toBeDefined();
      expect(c.label).toBe(src!.label);
      expect(c.bin).toBe(src!.bin);
    }
  });

  test("an un-exerciseable client must name why — quiet 4-of-5 coverage is the defect", () => {
    for (const c of SUPPORTED_CLIENTS) {
      if (!c.exercise) {
        expect(c.skipReason && c.skipReason.length > 0).toBe(true);
      }
    }
  });

  test("claude-code and codex are exerciseable (the minimum #908 asked for)", () => {
    const claude = SUPPORTED_CLIENTS.find((c) => c.id === "claude-code");
    const codex = SUPPORTED_CLIENTS.find((c) => c.id === "codex");
    expect(claude?.exercise).toBe(true);
    expect(codex?.exercise).toBe(true);
  });
});

describe("parseWiringSummary — silence is a distinct outcome", () => {
  const summary = [
    "MCP clients",
    "   ✓ Wired: Codex",
    "   ✗ NOT wired: Claude Code — snippet printed (no ~/.claude.json)",
    "   • Not installed, skipped: Gemini, Cursor",
  ].join("\n");

  test("splits wired / not-wired / skipped by label", () => {
    const parsed = parseWiringSummary(summary);
    expect(parsed.hasHeading).toBe(true);
    expect(parsed.wired).toEqual(["Codex"]);
    expect(parsed.notWired).toEqual(["Claude Code"]);
    expect(parsed.skipped).toEqual(["Gemini", "Cursor"]);
  });

  test("a client in the summary is not silent", () => {
    const claude = SUPPORTED_CLIENTS.find((c) => c.id === "claude-code")!;
    const codex = SUPPORTED_CLIENTS.find((c) => c.id === "codex")!;
    const gemini = SUPPORTED_CLIENTS.find((c) => c.id === "gemini")!;
    expect(classifyClientReport(summary, claude).status).toBe("not-wired");
    expect(classifyClientReport(summary, codex).status).toBe("wired");
    expect(classifyClientReport(summary, gemini).status).toBe("skipped");
  });

  test("a client the summary never names is silent — the #908 failure", () => {
    const antigravity = SUPPORTED_CLIENTS.find((c) => c.id === "antigravity")!;
    expect(classifyClientReport(summary, antigravity).status).toBe("silent");
  });

  test("output with no MCP clients heading is no-summary, not a pass", () => {
    const claude = SUPPORTED_CLIENTS.find((c) => c.id === "claude-code")!;
    const cls = classifyClientReport("Harper already running\n✅ Flair initialized successfully\n", claude);
    expect(cls.status).toBe("no-summary");
    expect(parseWiringSummary("no wiring happened").hasHeading).toBe(false);
  });

  test("a client listed in two buckets is ambiguous, not a pass", () => {
    const messy = [
      "MCP clients",
      "   ✓ Wired: Claude Code",
      "   • Not installed, skipped: Claude Code",
    ].join("\n");
    const claude = SUPPORTED_CLIENTS.find((c) => c.id === "claude-code")!;
    expect(classifyClientReport(messy, claude).status).toBe("ambiguous");
  });
});

describe("pinCheck — unpinned and unknown are failures", () => {
  test("accepts the exact version under test", () => {
    expect(pinCheck(`${FLAIR_MCP_PACKAGE}@0.51.2`, FLAIR_MCP_PACKAGE, "0.51.2").ok).toBe(true);
    expect(pinCheck(`npm:${PI_FLAIR_PACKAGE}@0.51.2`, PI_FLAIR_PACKAGE, "0.51.2").ok).toBe(true);
  });

  test("rejects the bare spec (#907)", () => {
    expect(pinCheck(FLAIR_MCP_PACKAGE, FLAIR_MCP_PACKAGE, "0.51.2").ok).toBe(false);
    expect(pinCheck(`npm:${PI_FLAIR_PACKAGE}`, PI_FLAIR_PACKAGE, "0.51.2").ok).toBe(false);
  });

  test("rejects @unknown (#907)", () => {
    expect(pinCheck(`${FLAIR_MCP_PACKAGE}@unknown`, FLAIR_MCP_PACKAGE, "0.51.2").ok).toBe(false);
  });

  test("rejects a pin to a different version", () => {
    expect(pinCheck(`${FLAIR_MCP_PACKAGE}@0.1.0`, FLAIR_MCP_PACKAGE, "0.51.2").ok).toBe(false);
  });

  test("rejects a missing spec", () => {
    expect(pinCheck("", FLAIR_MCP_PACKAGE, "0.51.2").ok).toBe(false);
  });
});

describe("config readers", () => {
  test("readJsonMcpPin pulls the flair-mcp spec from args", () => {
    const raw = JSON.stringify({
      mcpServers: { flair: { command: "npx", args: ["-y", `${FLAIR_MCP_PACKAGE}@0.51.2`] } },
    });
    expect(readJsonMcpPin(raw)).toEqual({ spec: `${FLAIR_MCP_PACKAGE}@0.51.2`, error: null });
  });

  test("readTomlMcpPin pulls the Codex args spec", () => {
    const raw = [
      `[mcp_servers.flair]`,
      `command = "npx"`,
      `args = ["-y", "${FLAIR_MCP_PACKAGE}@0.51.2"]`,
    ].join("\n");
    expect(readTomlMcpPin(raw)).toEqual({ spec: `${FLAIR_MCP_PACKAGE}@0.51.2`, error: null });
  });

  test("readPiPin pulls the packages npm spec", () => {
    const raw = JSON.stringify({ packages: [`npm:${PI_FLAIR_PACKAGE}@0.51.2`] });
    expect(readPiPin(raw)).toEqual({ spec: `npm:${PI_FLAIR_PACKAGE}@0.51.2`, error: null });
  });
});

describe("clobber fixture — existing MCP servers must survive", () => {
  test("a merge that keeps the other server passes", () => {
    const before = clobberClaudeFixture();
    const after = {
      ...before,
      mcpServers: {
        ...before.mcpServers,
        flair: { command: "npx", args: ["-y", `${FLAIR_MCP_PACKAGE}@0.51.2`] },
      },
    };
    expect(clobberSurvived(JSON.stringify(after)).ok).toBe(true);
    expect(before.mcpServers[CLOBBER_MARKER_SERVER].args).toContain("not-flair-at-all");
  });

  test("dropping the other server fails", () => {
    const after = {
      numStartups: 7,
      theme: "keep-me",
      mcpServers: { flair: { command: "npx", args: ["-y", `${FLAIR_MCP_PACKAGE}@0.51.2`] } },
    };
    expect(clobberSurvived(JSON.stringify(after)).ok).toBe(false);
  });

  test("clobbering top-level keys fails", () => {
    const after = {
      numStartups: 1,
      theme: "keep-me",
      mcpServers: {
        [CLOBBER_MARKER_SERVER]: { command: "npx", args: ["-y", "not-flair-at-all"] },
        flair: { command: "npx" },
      },
    };
    expect(clobberSurvived(JSON.stringify(after)).ok).toBe(false);
  });
});

describe("CLI refuses to pass when it cannot run", () => {
  test("missing --flair is DID NOT RUN, not a pass", () => {
    const r = runGate(["--version", "0.51.2"]);
    expect(r.status).toBe(EXIT_DID_NOT_RUN);
    expect(r.out).toContain("DID NOT RUN");
  });

  test("missing --version is DID NOT RUN, not a pass", () => {
    const r = runGate(["--flair", SCRIPT]);
    expect(r.status).toBe(EXIT_DID_NOT_RUN);
    expect(r.out).toContain("DID NOT RUN");
  });

  test("--version unknown is DID NOT RUN (would make every pin assertion vacuous)", () => {
    const r = runGate(["--flair", SCRIPT, "--version", "unknown"]);
    expect(r.status).toBe(EXIT_DID_NOT_RUN);
    expect(r.out).toMatch(/unknown/i);
  });

  test("a missing --flair path is DID NOT RUN", () => {
    const r = runGate(["--flair", "/no/such/flair-cli.js", "--version", "0.51.2"]);
    expect(r.status).toBe(EXIT_DID_NOT_RUN);
  });

  test("--help exits 0 without running init", () => {
    const r = runGate(["--help"]);
    expect(r.status).toBe(EXIT_OK);
    expect(r.out).toContain("--flair");
  });

  test("parseArgs reads the required flags", () => {
    const a = parseArgs(["--flair", "/x/cli.js", "--version", "1.2.3", "--port", "1234", "--agent", "a"]);
    expect(a.flair).toBe("/x/cli.js");
    expect(a.version).toBe("1.2.3");
    expect(a.port).toBe("1234");
    expect(a.agent).toBe("a");
  });
});

describe("the CI job must remain able to fail", () => {
  const job = jobBlock();
  const directives = job
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");

  test("invokes the gate script against a packed tarball install", () => {
    expect(directives).toContain("scripts/ci/check-mcp-client-wiring.mjs");
    expect(directives).toContain("npm pack");
    expect(directives).toContain("npm install");
  });

  test("passes --client through the real CLI (not a unit-test stand-in)", () => {
    // The script is what invokes `--client all`; the workflow must not
    // bypass it with a hand-rolled assertion that never runs init.
    expect(readFileSync(SCRIPT, "utf8")).toContain('"--client", "all"');
    expect(readFileSync(SCRIPT, "utf8")).toContain('"--client", "claude-code"');
  });

  test("has no continue-on-error and does not swallow the exit code", () => {
    expect(directives).not.toContain("continue-on-error");
    const gateLine = directives.split("\n").find((l) => l.includes("check-mcp-client-wiring.mjs")) ?? "";
    expect(gateLine.length).toBeGreaterThan(0);
    expect(gateLine).not.toMatch(/\|\|\s*(true|echo|:)/);
  });

  test("is marked blocking, not advisory", () => {
    expect(job).toContain("BLOCKING");
    expect(job).not.toMatch(/PROMOTION CRITERION/);
  });

  test("isolates HOME (the new-user state #908 asked for)", () => {
    expect(readFileSync(SCRIPT, "utf8")).toContain("HOME: home");
    expect(readFileSync(SCRIPT, "utf8")).toContain('USERPROFILE: home');
  });
});
