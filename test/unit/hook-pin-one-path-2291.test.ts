/**
 * hook-pin-one-path-2291.test.ts — flair#2291.
 *
 * The fifth path of the same gap (#1485, #1516, #1571, #1779): `flair init`
 * re-pinned the MCP server blocks but treated a PRESENT SessionStart hook as
 * current, so a hook left on the previous `flair-mcp` version survived an
 * upgrade and `flair hook status` reported it configured. `doctor` used the
 * shared pin helpers; init and hook status did not.
 *
 * The acceptance test drives the same legs `flair init` drives (the real MCP
 * writers + the hook leg), simulates the upgrade by rewriting the pins the
 * files carry to one version behind the installed CLI, and asserts:
 *   - `hook status` sees the hook as stale BEFORE the second init (red), and
 *   - the second init leaves both hook pins (Claude Code and Codex) on the
 *     installed version.
 *
 * On unmodified origin/main the hook leg reports "already wired" and leaves the
 * stale pin, and hook status has no staleness notion, so both assertions fail.
 *
 * The guard test enumerates the commands that write or report hook state and
 * fails if one stops routing through the shared helpers in
 * src/lib/owned-pins.ts — so a sixth path added by hand trips the guard.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as ownedPins from "../../src/lib/owned-pins.ts";
import { applyOrReportSessionStartHook, hookHarnessFromSettingsPath, extractFlairMcpPin } from "../../src/doctor-client.ts";
import { hookSettingsPath, hookStatus, type Harness } from "../../src/hook-install.ts";
import { wireClaudeCode, wireCodex, clientConfigPath, type WireEnv } from "../../src/install/clients.ts";
import { FLAIR_MCP_PACKAGE, flairCliVersion } from "../../src/lib/mcp-spec.ts";
import { parseSemverCore } from "../../src/fabric-upgrade.ts";

/**
 * `flair init`'s SessionStart-hook leg. The fix moves the composition into
 * owned-pins (it can see both the shared finding and the guarded writer);
 * before the fix that helper is absent, so fall back to the present-means-ok
 * helper init used — the gap this test pins.
 */
type HookLeg = (home: string, agent: string, skip: boolean, path?: string) => { applied: boolean; ok: boolean; message: string; hint?: string };
const applyHookLeg: HookLeg =
  (ownedPins as { applyOrRepinSessionStartHook?: HookLeg }).applyOrRepinSessionStartHook ??
  ((home, agent, skip, path) => applyOrReportSessionStartHook(home, agent, skip, path));

const AGENT = "agent-a";
const URL = "http://127.0.0.1:19926";
const ENV: WireEnv = { FLAIR_AGENT_ID: AGENT, FLAIR_URL: URL };

const INSTALLED = flairCliVersion();

function oneVersionBehind(version: string): string {
  const core = parseSemverCore(version);
  if (!core) throw new Error(`CLI version is not semver: ${version}`);
  const [maj, min, pat] = core;
  if (pat > 0) return `${maj}.${min}.${pat - 1}`;
  if (min > 0) return `${maj}.${min - 1}.0`;
  throw new Error(`cannot compute one version behind ${version}`);
}

const STALE = oneVersionBehind(INSTALLED);

let isoHome: string;
let prevHome: string | undefined;

beforeEach(() => {
  isoHome = mkdtempSync(join(tmpdir(), "flair-2291-"));
  prevHome = process.env.HOME;
  process.env.HOME = isoHome;
});

afterEach(() => {
  if (prevHome !== undefined) process.env.HOME = prevHome;
  else delete process.env.HOME;
  rmSync(isoHome, { recursive: true, force: true });
});

/** The config files a Claude Code + Codex setup lives in. */
function clientFiles(): string[] {
  return [
    clientConfigPath("claude-code"),
    clientConfigPath("codex"),
    hookSettingsPath(isoHome, "claude-code"),
    hookSettingsPath(isoHome, "codex"),
  ];
}

/** One `flair init` hook+MCP wiring pass for both clients. */
function runInitPass(): void {
  wireClaudeCode(ENV);
  wireCodex(ENV);
  applyHookLeg(isoHome, AGENT, false);
  applyHookLeg(isoHome, AGENT, false, hookSettingsPath(isoHome, "codex"));
}

/** Simulate a CLI upgrade: the files still carry the pin the previous CLI wrote. */
function simulateUpgrade(): void {
  for (const path of clientFiles()) {
    const before = readFileSync(path, "utf-8");
    const after = before.split(`${FLAIR_MCP_PACKAGE}@${INSTALLED}`).join(`${FLAIR_MCP_PACKAGE}@${STALE}`);
    if (after === before) throw new Error(`no installed pin to age in ${path}`);
    writeFileSync(path, after);
  }
}

function hookPin(harness: Harness): string | null {
  const raw = readFileSync(hookSettingsPath(isoHome, harness), "utf-8");
  const cfg = JSON.parse(raw);
  const command = cfg?.hooks?.SessionStart?.[0]?.hooks?.[0]?.command ?? "";
  return extractFlairMcpPin(command);
}

function mcpPin(claudeOrCodex: "claude-code" | "codex"): string | null {
  const raw = readFileSync(clientConfigPath(claudeOrCodex), "utf-8");
  if (claudeOrCodex === "claude-code") {
    const args = JSON.parse(raw)?.mcpServers?.flair?.args;
    const spec = Array.isArray(args) ? args.find((a: string) => a.startsWith(FLAIR_MCP_PACKAGE)) : undefined;
    return spec ? extractFlairMcpPin(spec) : null;
  }
  const m = raw.match(/args = \["-y", "([^"]+)"\]/);
  return m ? extractFlairMcpPin(m[1]!) : null;
}

/** The same finding `hook status` hands to hookStatus (src/commands/hook.ts). */
function statusWithSharedFinding(harness: Harness) {
  const finding = ownedPins.sessionStartHookPinFindings(isoHome).find((f) => f.reading.target.id === harness) ?? null;
  return hookStatus(isoHome, harness, {
    stalePinFinding: finding ? { pin: finding.reading.pin, direction: finding.direction } : null,
  });
}

describe("flair#2291 — init/upgrade/init leaves the Claude Code and Codex hook pins on the installed version", () => {
  it("hook status is stale before the second init and current after it", () => {
    runInitPass();
    expect(hookPin("claude-code")).toBe(INSTALLED);
    expect(hookPin("codex")).toBe(INSTALLED);

    simulateUpgrade();
    expect(hookPin("claude-code")).toBe(STALE);
    expect(hookPin("codex")).toBe(STALE);

    // The upgrade step: `hook status` must call the stale hook stale, through
    // the one shared finding.
    const staleBefore = statusWithSharedFinding("claude-code");
    expect(staleBefore.pinStale).toBe(true);
    expect(staleBefore.stalePin).toBe(STALE);

    runInitPass();

    expect(hookPin("claude-code")).toBe(INSTALLED);
    expect(hookPin("codex")).toBe(INSTALLED);
    expect(mcpPin("claude-code")).toBe(INSTALLED);
    expect(mcpPin("codex")).toBe(INSTALLED);

    const currentAfter = statusWithSharedFinding("claude-code");
    expect(currentAfter.pinStale).toBe(false);
    expect(currentAfter.stalePin).toBeNull();
  });

  it("re-running init with nothing stale is a byte-identical no-op (no churn)", () => {
    runInitPass();
    const before = clientFiles().map((p) => readFileSync(p, "utf-8"));
    runInitPass();
    const after = clientFiles().map((p) => readFileSync(p, "utf-8"));
    expect(after).toEqual(before);
  });
});

// ── the shape guard ─────────────────────────────────────────────────────────

const repoRoot = join(import.meta.dirname, "..", "..");
const readSource = (rel: string): string => readFileSync(join(repoRoot, rel), "utf-8");

/** Commands that WRITE SessionStart hook wiring, and the shared helper each
 *  must route through. `hook install` writes through installHook, whose write
 *  decision is the shared never-lower guard (the same one the re-pin uses). */
const WRITE_PATHS: ReadonlyArray<{ command: string; file: string; helper: string }> = [
  { command: "flair init", file: "src/commands/init.ts", helper: "applyOrRepinSessionStartHook" },
  { command: "flair upgrade", file: "src/commands/upgrade.ts", helper: "refreshOwnedPins" },
  { command: "flair doctor --fix", file: "src/commands/doctor.ts", helper: "repinSessionStartHookGuarded" },
  { command: "flair hook install", file: "src/hook-install.ts", helper: "decidePinWrite" },
];

/** Commands that REPORT SessionStart hook state, and the shared finding each
 *  must read. */
const REPORT_PATHS: ReadonlyArray<{ command: string; file: string; helper: string }> = [
  { command: "flair doctor", file: "src/commands/doctor.ts", helper: "sessionStartHookPinFindings" },
  { command: "flair hook status", file: "src/commands/hook.ts", helper: "sessionStartHookPinFindings" },
];

describe("flair#2291 — hook-state commands route through the shared helpers", () => {
  for (const { command, file, helper } of WRITE_PATHS) {
    it(`${command} writes hook wiring through ${helper}`, () => {
      expect(readSource(file)).toContain(helper);
    });
  }

  for (const { command, file, helper } of REPORT_PATHS) {
    it(`${command} reports hook state through ${helper}`, () => {
      expect(readSource(file)).toContain(helper);
    });
  }

  it("the shared hook composition uses the finding AND the guarded writer", () => {
    const owned = readSource("src/lib/owned-pins.ts");
    expect(owned).toContain("sessionStartHookPinFindings");
    expect(owned).toContain("repinSessionStartHookGuarded");
  });

  it("init no longer calls the present-means-ok helper", () => {
    expect(readSource("src/commands/init.ts")).not.toContain("applyOrReportSessionStartHook(");
  });

  it("hook status hands the shared finding to hookStatus", () => {
    expect(readSource("src/commands/hook.ts")).toContain("stalePinFinding");
  });

  it("hookHarnessFromSettingsPath is the harness decode used by the composition", () => {
    expect(hookHarnessFromSettingsPath(hookSettingsPath(isoHome, "codex"))).toBe("codex");
    expect(hookHarnessFromSettingsPath(hookSettingsPath(isoHome, "claude-code"))).toBe("claude-code");
  });
});
