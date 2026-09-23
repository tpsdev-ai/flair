import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  findUnsafeWiredPins,
  listOwnedPinTargets,
  ownedPinRefreshShouldReport,
  pinDirection,
  refreshOwnedPins,
  staleMcpClientPins,
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
    // flair#1636 (epic #1618): the `flair upgrade` registration moved to
    // src/commands/upgrade.ts; follow it there.
    const src = readFileSync(join(import.meta.dirname, "../../src/commands/upgrade.ts"), "utf-8");
    const upgradeIdx = src.indexOf(".command(\"upgrade\")");
    expect(upgradeIdx).toBeGreaterThan(-1);
    const nextCommand = src.indexOf(".command(\"", upgradeIdx + ".command(\"upgrade\")".length);
    const upgradeBody = src.slice(upgradeIdx, nextCommand === -1 ? undefined : nextCommand);
    expect(upgradeBody).toContain("refreshOwnedPins(");
    expect(upgradeBody).toContain("ownedPinRefreshShouldReport");
  });
});

describe("flair#1485 — failed MCP pin refresh is not silent", () => {
  it("ownedPinRefreshShouldReport is true for skip+ok:false (a failed client.wire)", () => {
    const failed = {
      target: {
        kind: "mcp-client" as const,
        id: "claude-code",
        path: "/tmp/.claude.json",
        displayPath: "~/.claude.json",
      },
      action: "skip" as const,
      ok: false,
      message: "Claude Code: manual wiring needed (could not write ~/.claude.json: EACCES)",
    };
    expect(ownedPinRefreshShouldReport(failed)).toBe(true);
    expect(ownedPinRefreshShouldReport({ ...failed, ok: true, message: "not wired — skip" })).toBe(false);
  });

  it("a write failure from client.wire stays ok:false and is reportable", () => {
    const path = writeClaudeMcp(isoHome, STALE_SPEC, "local");
    // flair#1778 2c-i-d1: the writer now stages a temp and renames it over the
    // config, so a read-only FILE no longer blocks it (rename needs write on the
    // DIRECTORY, not the file). Make the parent dir read-only so the critical
    // section's lock cannot be created — the write failure this test pins.
    chmodSync(isoHome, 0o555);
    let results: ReturnType<typeof refreshOwnedPins>;
    try {
      results = refreshOwnedPins({
        homeDir: isoHome,
      });
    } finally {
      chmodSync(isoHome, 0o755);
    }
    const mcp = results.find((r) => r.target.kind === "mcp-client" && r.target.id === "claude-code");
    expect(mcp?.ok).toBe(false);
    expect(mcp?.action).toBe("skip");
    expect(mcp && ownedPinRefreshShouldReport(mcp)).toBe(true);
    expect(readFileSync(path, "utf-8")).toContain(STALE_SPEC);
  });

  it("doctor catalog fails a stale MCP pin (the leftover after a silent refresh miss)", () => {
    writeClaudeMcp(isoHome, STALE_SPEC, "local");
    writeHook(isoHome, "claude-code", hookCommand("local", INSTALLED));
    const run = doctorOn(isoHome, ["claude-code"]);
    const mcp = run.results.find((r) => r.id === "mcp-block");
    expect(mcp?.status).toBe("fail");
    expect(mcp?.detail ?? "").toContain(STALE_VER);
    expect(mcp?.detail ?? "").toContain(INSTALLED);
    expect(mcp?.remedy).toBe("flair doctor --fix");
    expect(run.healthy).toBe(false);
    expect(staleMcpClientPins(isoHome, INSTALLED).map((r) => r.pin)).toEqual([STALE_VER]);
    const lines = renderCatalogDoctorLines(run);
    const mcpLine = lines.find((row) => row.line.includes("MCP server"));
    expect(mcpLine?.icon).toBe("error");
  });

  it("flair#1383: a flair-mcp@0.17.0 pin fails with the silent-drop hazard, not generic staleness", () => {
    writeClaudeMcp(isoHome, `${FLAIR_MCP_PACKAGE}@0.17.0`, "local");
    writeHook(isoHome, "claude-code", hookCommand("local", INSTALLED));
    const run = doctorOn(isoHome, ["claude-code"]);
    const mcp = run.results.find((r) => r.id === "mcp-block");
    expect(mcp?.status).toBe("fail");
    expect(mcp?.detail ?? "").toContain("flair-mcp@0.17.0");
    expect(mcp?.detail ?? "").toContain("silently drops writes");
    expect(mcp?.detail ?? "").toContain("another agent's shared memories");
    expect(mcp?.detail ?? "").toContain("Upgrade the adapter, not the server");
    expect(mcp?.detail ?? "").not.toContain(`installed CLI is ${INSTALLED}`);
    expect(mcp?.remedy).toBe("flair upgrade");
    expect(run.healthy).toBe(false);
  });

  it("flair#1383: current MCP pin + flair-client@0.17.0 in cwd package.json fails with silently drops writes", () => {
    writeClaudeMcp(isoHome, CURRENT_SPEC, "local");
    writeHook(isoHome, "claude-code", hookCommand("local", INSTALLED));
    writeFileSync(
      join(isoCwd, "package.json"),
      JSON.stringify({
        name: "host-app",
        dependencies: { "@tpsdev-ai/flair-client": "0.17.0" },
      }, null, 2) + "\n",
    );
    expect(staleMcpClientPins(isoHome, INSTALLED)).toEqual([]);
    const pins = findUnsafeWiredPins(isoHome, isoCwd);
    expect(pins.some((p) => p.package === "flair-client" && p.version === "0.17.0")).toBe(true);
    const run = doctorOn(isoHome, ["claude-code"]);
    const mcp = run.results.find((r) => r.id === "mcp-block");
    expect(mcp?.status).toBe("fail");
    expect(mcp?.detail ?? "").toContain("flair-client@0.17.0");
    expect(mcp?.detail ?? "").toContain("silently drops writes");
    expect(mcp?.detail ?? "").toContain("another agent's shared memories");
    expect(mcp?.remedy).toBe("flair upgrade");
    expect(run.healthy).toBe(false);
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

describe("flair#1778 — the pin refresh never LOWERS an owned pin", () => {
  const core = parseSemverCore(INSTALLED);
  if (!core) throw new Error(`CLI version is not semver: ${INSTALLED}`);
  // One patch ahead of the running CLI: the refresh would write INSTALLED over
  // it, which is a downgrade. It must be HELD, not rewritten.
  const AHEAD_VER = `${core[0]}.${core[1]}.${core[2] + 1}`;
  const AHEAD_SPEC = `${FLAIR_MCP_PACKAGE}@${AHEAD_VER}`;

  it("MCP pin ahead of the running CLI is held, not rewritten down", () => {
    const mcpPath = writeClaudeMcp(isoHome, AHEAD_SPEC, "local");
    const results = refreshOwnedPins({ homeDir: isoHome });
    expect(extractFlairMcpPin(readFileSync(mcpPath, "utf-8"))).toBe(AHEAD_VER);
    const held = results.find((r) => r.target.id === "claude-code" && r.action === "hold");
    expect(held).toBeDefined();
    expect(held?.message).toContain(AHEAD_VER);
    expect(held?.message).toContain(INSTALLED);
    expect(ownedPinRefreshShouldReport(held!)).toBe(true);
  });

  it("hook pin ahead of the running CLI is held, not rewritten down", () => {
    writeHook(isoHome, "claude-code", hookCommand("local", AHEAD_VER));
    const results = refreshOwnedPins({ homeDir: isoHome });
    expect(readHookPin(isoHome, "claude-code")).toBe(AHEAD_VER);
    const held = results.find((r) => r.target.kind === "session-start-hook" && r.action === "hold");
    expect(held).toBeDefined();
    expect(held?.message).toContain(AHEAD_VER);
  });

  it("an unrelated behind pin still advances while an ahead pin is held (mixed)", () => {
    const mcpPath = writeClaudeMcp(isoHome, AHEAD_SPEC, "local");
    writeHook(isoHome, "codex", hookCommand("local", STALE_VER));
    const results = refreshOwnedPins({ homeDir: isoHome });
    // The ahead MCP pin is untouched...
    expect(extractFlairMcpPin(readFileSync(mcpPath, "utf-8"))).toBe(AHEAD_VER);
    // ...while the behind hook pin still advances to the running CLI version.
    expect(readHookPin(isoHome, "codex")).toBe(INSTALLED);
    expect(results.some((r) => r.action === "hold")).toBe(true);
    expect(results.some((r) => r.target.kind === "session-start-hook" && r.action === "update")).toBe(true);
  });
});

describe("flair#1778 follow-up — doctor classifies SessionStart-hook pin DIRECTION (catalog)", () => {
  const dirCore = parseSemverCore(INSTALLED);
  if (!dirCore) throw new Error(`CLI version is not semver: ${INSTALLED}`);
  const AHEAD_VER = `${dirCore[0]}.${dirCore[1]}.${dirCore[2] + 1}`;

  function blockingIds(home: string): string[] {
    return doctorOn(home, ["claude-code"]).results
      .filter((r) => r.status === "fail" || r.status === "unrun")
      .map((r) => r.id);
  }

  it("a hook pin AHEAD of the running CLI is a PASS, not a blocking catalog failure", () => {
    writeClaudeMcp(isoHome, CURRENT_SPEC, "local");
    writeHook(isoHome, "claude-code", hookCommand("local", AHEAD_VER));
    const run = doctorOn(isoHome, ["claude-code"]);
    const hook = run.results.find((r) => r.id === "session-start-hook");
    expect(hook?.status).toBe("pass");
    expect(hook?.detail ?? "").toContain("ahead of the installed CLI");
    // The exit-code source (`issues += catalogDelta.found`): an ahead hook must
    // not be counted as a blocking check.
    expect(blockingIds(isoHome)).not.toContain("session-start-hook");
  });

  it("a hook pin BEHIND the running CLI is still a blocking failure", () => {
    writeClaudeMcp(isoHome, CURRENT_SPEC, "local");
    writeHook(isoHome, "claude-code", hookCommand("local", STALE_VER));
    const run = doctorOn(isoHome, ["claude-code"]);
    const hook = run.results.find((r) => r.id === "session-start-hook");
    expect(hook?.status).toBe("fail");
    expect(hook?.remedy).toBe("flair hook install");
    expect(blockingIds(isoHome)).toContain("session-start-hook");
  });
});

describe("pinDirection — three-valued, unknown when not comparable (flair#1778)", () => {
  it("ahead/behind for strict semver; unknown for every unreadable-side case", () => {
    expect(pinDirection("0.55.0", "0.54.2")).toBe("ahead");
    expect(pinDirection("0.54.2", "0.55.0")).toBe("behind");
    expect(pinDirection("0.55.1.rc", "0.55.1")).toBe("unknown"); // invalid pin
    expect(pinDirection("0.55.1", "0.55.1.rc")).toBe("unknown"); // invalid target
    expect(pinDirection("not-a-version", "garbage")).toBe("unknown"); // both invalid
  });
});

describe("flair#1778 — an UNREADABLE pin FAILS CLOSED (never silently overwritten)", () => {
  const RAW = "0.55.1.rc";
  const RAW_SPEC = `${FLAIR_MCP_PACKAGE}@${RAW}`;

  it("hook refresh: an unreadable pin is HELD, byte-identical, and the line names the raw value", () => {
    const p = writeHook(isoHome, "claude-code", hookCommand("local", RAW));
    const before = readFileSync(p, "utf-8");
    const results = refreshOwnedPins({ homeDir: isoHome });
    expect(readFileSync(p, "utf-8")).toBe(before);
    const held = results.find((r) => r.target.kind === "session-start-hook" && r.action === "hold");
    expect(held).toBeDefined();
    expect(held?.message).toContain(RAW);
    expect(held?.message).toContain("not a version I can compare");
  });

  it("MCP refresh: an unreadable pin is HELD, byte-identical, and the line names the raw value", () => {
    const p = writeClaudeMcp(isoHome, RAW_SPEC, "local");
    const before = readFileSync(p, "utf-8");
    const results = refreshOwnedPins({ homeDir: isoHome });
    expect(readFileSync(p, "utf-8")).toBe(before);
    const held = results.find((r) => r.target.kind === "mcp-client" && r.action === "hold");
    expect(held).toBeDefined();
    expect(held?.message).toContain(RAW);
    expect(held?.message).toContain("not a version I can compare");
  });

  it("catalog: an unreadable hook pin is a NON-BLOCKING warn, not a stale failure", () => {
    writeClaudeMcp(isoHome, CURRENT_SPEC, "local");
    writeHook(isoHome, "claude-code", hookCommand("local", RAW));
    const run = doctorOn(isoHome, ["claude-code"]);
    const hook = run.results.find((r) => r.id === "session-start-hook");
    expect(hook?.status).toBe("warn");
    expect(hook?.detail ?? "").toContain(RAW);
    expect(hook?.detail ?? "").toContain("not a version I can compare");
    expect(hook?.remedy).toBeUndefined();
    // Not counted as blocking (the exit-code source).
    expect(run.results.filter((r) => r.status === "fail" || r.status === "unrun").map((r) => r.id)).not.toContain("session-start-hook");
    // Rendered with the warn icon, never the error one.
    const row = renderCatalogDoctorLines(run).find((r) => r.line.includes("SessionStart hook"));
    expect(row?.icon).toBe("warn");
  });
});

describe("flair#1789 — doctor classifies the MCP-block pin DIRECTION", () => {
  const dirCore = parseSemverCore(INSTALLED);
  if (!dirCore) throw new Error(`CLI version is not semver: ${INSTALLED}`);
  const AHEAD_VER = `${dirCore[0]}.${dirCore[1]}.${dirCore[2] + 1}`;
  const RAW = "0.55.1.rc";

  function mcpBlocking(home: string): boolean {
    return doctorOn(home, ["claude-code"]).results
      .filter((r) => r.status === "fail" || r.status === "unrun")
      .some((r) => r.id === "mcp-block");
  }

  it("an MCP pin AHEAD of the running CLI is a held PASS (no remedy, not blocking)", () => {
    writeClaudeMcp(isoHome, `${FLAIR_MCP_PACKAGE}@${AHEAD_VER}`, "local");
    const run = doctorOn(isoHome, ["claude-code"]);
    const mcp = run.results.find((r) => r.id === "mcp-block");
    expect(mcp?.status).toBe("pass");
    expect(mcp?.detail ?? "").toContain("ahead of the installed CLI");
    expect(mcp?.remedy).toBeUndefined();
    expect(mcpBlocking(isoHome)).toBe(false);
  });

  it("an UNREADABLE MCP pin is a NON-BLOCKING warn naming the raw value", () => {
    writeClaudeMcp(isoHome, `${FLAIR_MCP_PACKAGE}@${RAW}`, "local");
    const run = doctorOn(isoHome, ["claude-code"]);
    const mcp = run.results.find((r) => r.id === "mcp-block");
    expect(mcp?.status).toBe("warn");
    expect(mcp?.detail ?? "").toContain(RAW);
    expect(mcp?.detail ?? "").toContain("not a version I can compare");
    expect(mcp?.remedy).toBeUndefined();
    expect(mcpBlocking(isoHome)).toBe(false);
    const row = renderCatalogDoctorLines(run).find((r) => r.line.includes("MCP server block"));
    expect(row?.icon).toBe("warn");
  });

  it("an MCP pin BEHIND the running CLI is still a blocking fail + flair doctor --fix", () => {
    writeClaudeMcp(isoHome, STALE_SPEC, "local");
    const run = doctorOn(isoHome, ["claude-code"]);
    const mcp = run.results.find((r) => r.id === "mcp-block");
    expect(mcp?.status).toBe("fail");
    expect(mcp?.remedy).toBe("flair doctor --fix");
    expect(mcpBlocking(isoHome)).toBe(true);
  });
});
