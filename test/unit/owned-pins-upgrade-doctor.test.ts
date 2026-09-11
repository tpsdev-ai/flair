import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  listOwnedPinTargets,
  refreshOwnedPins,
  staleSessionStartHookPins,
  staleHookRemedy,
} from "../../src/lib/owned-pins.ts";
import {
  runDoctorChecks,
  renderCatalogDoctorLines,
  renderVerifiedSummary,
} from "../../src/lib/doctor-run.ts";
import { hookSettingsPath } from "../../src/hook-install.ts";
import { clientConfigPath } from "../../src/install/clients.ts";
import { extractFlairMcpPin } from "../../src/doctor-client.ts";
import { FLAIR_MCP_PACKAGE, flairCliVersion, mcpServerSpec } from "../../src/lib/mcp-spec.ts";
import { parseSemverCore } from "../../src/fabric-upgrade.ts";

/**
 * flair#1485 — must-fail first.
 *
 * `flair upgrade` refreshed MCP server pins and left SessionStart hook pins
 * on the old `@tpsdev-ai/flair-mcp@<ver>`. `flair doctor` then reported the
 * hook as ✓ because "it still runs" / the hook pin matched the (also stale,
 * or just-refreshed) client pin. Pin currency is pin === installed CLI
 * version, and the files we own live in one catalogue shared by upgrade
 * and doctor.
 *
 *   1. Install a hook pinned to <installed>-0.0.1, run the upgrade refresh
 *      (refreshOwnedPins — the function `flair upgrade` must call), assert
 *      the pin moved to the installed version.
 *   2. Doctor catalog with that stale pin asserts fail (✗), remedy
 *      `flair hook install`, never a pass.
 *
 * Both are RED on main before the fix: refreshOwnedPins is MCP-only, and
 * runSessionStartHook does not compare the hook pin to the CLI version.
 */

const INSTALLED = flairCliVersion();
const CURRENT_SPEC = mcpServerSpec();

function installedMinus001(version: string): string {
  const parsed = parseSemverCore(version);
  if (!parsed) throw new Error(`CLI version is not semver: ${version}`);
  const [maj, min, pat] = parsed;
  // <installed>-0.0.1. When patch is 0, borrow from minor (0.53.0 → 0.52.0).
  if (pat > 0) return `${maj}.${min}.${pat - 1}`;
  if (min > 0) return `${maj}.${min - 1}.0`;
  throw new Error(`cannot compute <installed>-0.0.1 from ${version}`);
}

const STALE_VER = installedMinus001(INSTALLED);
const STALE_SPEC = `${FLAIR_MCP_PACKAGE}@${STALE_VER}`;

let isoHome: string;
let isoCwd: string;
let prevHome: string | undefined;

beforeEach(() => {
  isoHome = mkdtempSync(join(tmpdir(), "flair-1485-"));
  isoCwd = mkdtempSync(join(tmpdir(), "flair-1485-cwd-"));
  prevHome = process.env.HOME;
  process.env.HOME = isoHome;
});

afterEach(() => {
  if (prevHome !== undefined) process.env.HOME = prevHome;
  else delete process.env.HOME;
  rmSync(isoHome, { recursive: true, force: true });
  rmSync(isoCwd, { recursive: true, force: true });
});

function hookCommand(agentId: string, version: string): string {
  return `sh -c 'out=$(FLAIR_AGENT_ID=${agentId} npx -y -p ${FLAIR_MCP_PACKAGE}@${version} flair-session-start 2>/dev/null) && printf %s "$out" || true'`;
}

function writeHook(home: string, harness: "claude-code" | "codex", command: string): string {
  const path = hookSettingsPath(home, harness);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command }] }] } }, null, 2) + "\n",
  );
  return path;
}

function writeClaudeMcp(home: string, spec: string, agentId = "local"): string {
  const path = withHome(home, () => clientConfigPath("claude-code"));
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      mcpServers: {
        flair: {
          command: "npx",
          args: ["-y", spec],
          type: "stdio",
          env: { FLAIR_AGENT_ID: agentId, FLAIR_URL: "http://127.0.0.1:9926" },
        },
      },
    }, null, 2) + "\n",
  );
  return path;
}

function writeCodexMcp(home: string, spec: string, agentId = "local"): string {
  const path = withHome(home, () => clientConfigPath("codex"));
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(
    path,
    [
      "[mcp_servers.flair]",
      `command = "npx"`,
      `args = ["-y", "${spec}"]`,
      "",
      "[mcp_servers.flair.env]",
      `FLAIR_AGENT_ID = "${agentId}"`,
      `FLAIR_URL = "http://127.0.0.1:9926"`,
      "",
    ].join("\n"),
  );
  return path;
}

function withHome<T>(home: string, fn: () => T): T {
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.HOME;
    else process.env.HOME = prev;
  }
}

function readHookPin(home: string, harness: "claude-code" | "codex"): string | null {
  const path = hookSettingsPath(home, harness);
  const cfg = JSON.parse(readFileSync(path, "utf-8"));
  const cmd = cfg?.hooks?.SessionStart?.[0]?.hooks?.[0]?.command ?? "";
  return extractFlairMcpPin(cmd);
}

const linuxLaunchd = { state: "not-applicable" as const, detail: "linux does not use launchd" };

function doctorOn(home: string, detected: readonly string[] = ["claude-code", "codex"]) {
  return runDoctorChecks({
    homeDir: home,
    cwd: isoCwd,
    detectedClientIds: detected,
    launchd: linuxLaunchd,
  });
}

describe("flair#1485 — one catalogue of files we own and pin", () => {
  it("lists MCP client configs AND SessionStart hook files from the same registries upgrade/doctor use", () => {
    const targets = listOwnedPinTargets(isoHome);
    const kinds = new Set(targets.map((t) => t.kind));
    expect(kinds.has("mcp-client")).toBe(true);
    expect(kinds.has("session-start-hook")).toBe(true);
    const ids = targets.map((t) => `${t.kind}:${t.id}`);
    expect(ids).toContain("mcp-client:claude-code");
    expect(ids).toContain("mcp-client:codex");
    expect(ids).toContain("session-start-hook:claude-code");
    expect(ids).toContain("session-start-hook:codex");
    expect(targets.some((t) => t.path.endsWith(".claude.json") || t.displayPath === "~/.claude.json")).toBe(true);
    expect(targets.some((t) => t.path.includes(".claude/settings.json"))).toBe(true);
    expect(targets.some((t) => t.path.includes(".codex/config.toml"))).toBe(true);
    expect(targets.some((t) => t.path.includes(".codex/hooks.json"))).toBe(true);
  });

  it("flair upgrade's pin refresh calls refreshOwnedPins — one function, not a second list", () => {
    const src = readFileSync(join(import.meta.dirname, "../../src/cli.ts"), "utf-8");
    const upgradeIdx = src.indexOf(".command(\"upgrade\")");
    expect(upgradeIdx).toBeGreaterThan(-1);
    const nextCommand = src.indexOf(".command(\"", upgradeIdx + ".command(\"upgrade\")".length);
    const upgradeBody = src.slice(upgradeIdx, nextCommand === -1 ? undefined : nextCommand);
    expect(upgradeBody).toContain("refreshOwnedPins(");
  });
});

describe("flair#1485 — MUST-FAIL FIRST: upgrade moves a hook pinned to <installed>-0.0.1", () => {
  it("refreshOwnedPins advances Claude Code and Codex hook pins to the installed CLI version", () => {
    expect(STALE_VER).not.toBe(INSTALLED);
    writeClaudeMcp(isoHome, STALE_SPEC, "local");
    writeCodexMcp(isoHome, STALE_SPEC, "local");
    writeHook(isoHome, "claude-code", hookCommand("local", STALE_VER));
    writeHook(isoHome, "codex", hookCommand("local", STALE_VER));
    expect(readHookPin(isoHome, "claude-code")).toBe(STALE_VER);
    expect(readHookPin(isoHome, "codex")).toBe(STALE_VER);

    const results = refreshOwnedPins({
      homeDir: isoHome,
      agentId: "local",
      flairUrl: "http://127.0.0.1:9926",
    });

    expect(readHookPin(isoHome, "claude-code")).toBe(INSTALLED);
    expect(readHookPin(isoHome, "codex")).toBe(INSTALLED);
    expect(readFileSync(hookSettingsPath(isoHome, "claude-code"), "utf-8")).toContain(CURRENT_SPEC);
    expect(readFileSync(hookSettingsPath(isoHome, "claude-code"), "utf-8")).not.toContain(STALE_SPEC);
    expect(results.some((r) => r.target.kind === "session-start-hook" && r.action === "update")).toBe(true);
  });

  it("hook re-pin does not depend on agentId — missing agent still moves the hook", () => {
    writeHook(isoHome, "claude-code", hookCommand("local", STALE_VER));
    expect(readHookPin(isoHome, "claude-code")).toBe(STALE_VER);

    refreshOwnedPins({
      homeDir: isoHome,
      agentId: null,
      flairUrl: "http://127.0.0.1:9926",
    });

    expect(readHookPin(isoHome, "claude-code")).toBe(INSTALLED);
  });
});

describe("flair#1485 — MUST-FAIL FIRST: doctor reports a stale hook pin as ✗", () => {
  it("catalog fails when the hook pin is <installed>-0.0.1, even if the MCP pin matches it", () => {
    // Both pins equally stale — #1516's hook-vs-client skew is false, so
    // doctor used to pass. Currency is pin === installed CLI version.
    writeClaudeMcp(isoHome, STALE_SPEC, "local");
    writeHook(isoHome, "claude-code", hookCommand("local", STALE_VER));

    const run = doctorOn(isoHome, ["claude-code"]);
    const hook = run.results.find((r) => r.id === "session-start-hook");
    expect(hook?.status).toBe("fail");
    expect(hook?.detail ?? "").toContain(STALE_VER);
    expect(hook?.detail ?? "").toContain(INSTALLED);
    expect(hook?.remedy).toBe("flair hook install");
    expect(run.healthy).toBe(false);

    const lines = renderCatalogDoctorLines(run);
    const hookLine = lines.find((row) => row.line.includes("SessionStart hook"));
    expect(hookLine?.icon).toBe("error");
    expect(hookLine?.line).not.toMatch(/pass/);

    const summary = renderVerifiedSummary(INSTALLED, run);
    expect(summary.degraded).toBe(true);
    expect(summary.lines.join("\n")).not.toContain("✅ verified:");
    expect(summary.lines.join("\n")).toContain("✗");
    expect(summary.lines.join("\n")).toContain("flair hook install");
  });

  it("staleSessionStartHookPins names the stale pin and the hook-install remedy", () => {
    writeClaudeMcp(isoHome, STALE_SPEC, "local");
    writeHook(isoHome, "claude-code", hookCommand("local", STALE_VER));
    const stale = staleSessionStartHookPins(isoHome, INSTALLED);
    expect(stale).toHaveLength(1);
    expect(stale[0]!.pin).toBe(STALE_VER);
    expect(staleHookRemedy(stale)).toBe("flair hook install");
  });

  it("a hook pinned to the installed CLI version is not a catalog failure", () => {
    writeClaudeMcp(isoHome, CURRENT_SPEC, "local");
    writeHook(isoHome, "claude-code", hookCommand("local", INSTALLED));
    const run = doctorOn(isoHome, ["claude-code"]);
    const hook = run.results.find((r) => r.id === "session-start-hook");
    expect(hook?.status).toBe("pass");
    expect(staleSessionStartHookPins(isoHome, INSTALLED)).toEqual([]);
  });
});
