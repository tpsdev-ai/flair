/**
 * upgrade-migrations.test.ts — flair#1439
 *
 * Regression test for the upgrade-doctor honesty bug:
 *
 *   Install 0.49.0 → `flair init --agent local --client codex`
 *   (wires ~/.codex/config.toml, no hooks.json — 0.49.0 had no hook concept)
 *   → `flair upgrade` → printed "✅ verified: healthy, authenticated, running 0.50.0"
 *   → `flair doctor` → exit 1: "✗ SessionStart hook (codex): not found"
 *
 * The root cause: upgrade's verification ran runDoctorChecks AFTER the package
 * swap but without first applying the pending version migration that installs
 * the hook for already-wired harnesses.
 *
 * RED-ON-MAIN assertions (marked below):
 *   The migration module did not exist on main — but the unit test
 *   demonstrates the INVARIANT that was violated: without the migration
 *   running, the 0.49.0-shaped home has a failing doctor check, yet the old
 *   upgrade path would have printed "✅ verified: healthy" — a contradiction.
 *   On main, if you removed the applyUpgradeMigrations call, these assertions
 *   would fail (the test is structured so the migration IS what makes them pass).
 *
 * AFTER-FIX assertions:
 *   applyUpgradeMigrations("0.49.0", "0.50.0", ctx) installs the hook →
 *   runDoctorChecks passes → renderVerifiedSummary emits "✅ verified: healthy".
 *   The same machine, one moment later — no contradiction.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyUpgradeMigrations,
  UPGRADE_MIGRATIONS,
  type UpgradeMigrationContext,
  type UpgradeMigration,
} from "../../src/lib/upgrade-migrations.ts";
import { runDoctorChecks, renderVerifiedSummary, sessionStartHookMissing } from "../../src/lib/doctor-run.ts";
import { hookSettingsPath } from "../../src/hook-install.ts";
import { tomlSnippet } from "../../src/install/clients.ts";
import { SESSION_START_HOOK_MARKER } from "../../src/doctor-client.ts";

let isoHome: string;
const linuxLaunchd = { state: "not-applicable" as const, detail: "linux does not use launchd" };

beforeEach(() => {
  isoHome = mkdtempSync(join(tmpdir(), "flair-1439-mig-"));
});

afterEach(() => {
  rmSync(isoHome, { recursive: true, force: true });
});

/** Write the state a 0.49.0 `flair init --agent local --client codex` left behind. */
function write0490CodexHome(home: string, agentId = "local"): void {
  const dir = join(home, ".codex");
  mkdirSync(dir, { recursive: true });
  // 0.49.0 wrote config.toml and nothing else — no hooks.json.
  writeFileSync(
    join(dir, "config.toml"),
    tomlSnippet({
      FLAIR_AGENT_ID: agentId,
      FLAIR_URL: "http://127.0.0.1:9926",
      FLAIR_CLIENT: "codex",
    }) + "\n",
  );
}

function migCtx(home: string, detectedClientIds: readonly string[] = ["codex"]): UpgradeMigrationContext {
  return { homeDir: home, port: 9926, detectedClientIds };
}

function doctorCtx(home: string, detectedClientIds: readonly string[] = ["codex"]) {
  return {
    homeDir: home,
    cwd: "/tmp",
    detectedClientIds,
    launchd: linuxLaunchd,
  };
}

// ─── Registry ─────────────────────────────────────────────────────────────────

describe("upgrade-migrations registry", () => {
  test("session-start-hook@0.50.0 migration is registered", () => {
    expect(UPGRADE_MIGRATIONS.some((m) => m.id === "session-start-hook@0.50.0")).toBe(true);
  });

  test("every migration has a non-empty id, description, fromBefore, toAtLeast, and apply fn", () => {
    for (const m of UPGRADE_MIGRATIONS) {
      expect(typeof m.id).toBe("string");
      expect(m.id.length).toBeGreaterThan(0);
      expect(typeof m.description).toBe("string");
      expect(m.description.length).toBeGreaterThan(0);
      expect(typeof m.fromBefore).toBe("string");
      expect(typeof m.toAtLeast).toBe("string");
      expect(typeof m.apply).toBe("function");
    }
  });
});

// ─── Version-window gating ────────────────────────────────────────────────────

describe("applyUpgradeMigrations — version-window gating", () => {
  test("null fromVersion → no migrations run (cannot gate without a known previous version)", () => {
    write0490CodexHome(isoHome);
    const result = applyUpgradeMigrations(null, "0.50.0", migCtx(isoHome));
    expect(result.applied).toHaveLength(0);
    expect(existsSync(hookSettingsPath(isoHome, "codex"))).toBe(false);
  });

  test("null toVersion → no migrations run (cannot gate without a known target version)", () => {
    write0490CodexHome(isoHome);
    const result = applyUpgradeMigrations("0.49.0", null, migCtx(isoHome));
    expect(result.applied).toHaveLength(0);
    expect(existsSync(hookSettingsPath(isoHome, "codex"))).toBe(false);
  });

  test("0.48.0 → 0.49.x: session-start-hook@0.50.0 does NOT apply (toVersion < 0.50.0)", () => {
    write0490CodexHome(isoHome);
    const result = applyUpgradeMigrations("0.48.0", "0.49.3", migCtx(isoHome));
    expect(result.applied).toHaveLength(0);
    expect(existsSync(hookSettingsPath(isoHome, "codex"))).toBe(false);
  });

  test("0.50.0 → 0.51.0: session-start-hook@0.50.0 does NOT apply (fromVersion >= 0.50.0 — hook existed already)", () => {
    write0490CodexHome(isoHome);
    const result = applyUpgradeMigrations("0.50.0", "0.51.0", migCtx(isoHome));
    // fromVersion is NOT < fromBefore (0.50.0 < 0.50.0 is false) → skip
    expect(result.applied).toHaveLength(0);
  });

  test("same-version upgrade (0.50.0 → 0.50.0) does NOT apply", () => {
    write0490CodexHome(isoHome);
    const result = applyUpgradeMigrations("0.50.0", "0.50.0", migCtx(isoHome));
    expect(result.applied).toHaveLength(0);
  });
});

// ─── RED-ON-MAIN: the honesty violation ───────────────────────────────────────
//
// These tests capture the invariant that was VIOLATED on main:
//   - 0.49.0-shaped home → doctor fails (session-start-hook missing)
//   - Without the migration, upgrade would have printed "✅ verified: healthy"
//   - That's the contradiction this fix resolves.

describe("flair#1439 — RED-ON-MAIN: 0.49.0→0.50.0 upgrade without migrations = contradiction", () => {
  test("pre-migration: 0.49.0-shaped home has a failing session-start-hook check", () => {
    write0490CodexHome(isoHome);
    const run = runDoctorChecks(doctorCtx(isoHome));
    // The check fails — hook is missing.
    expect(run.healthy).toBe(false);
    expect(sessionStartHookMissing(run)).toBe(true);
  });

  test("pre-migration: renderVerifiedSummary on failing run would NOT have printed '✅ verified: healthy'", () => {
    // This is what the OLD upgrade path should have printed but DIDN'T —
    // it was printing the unqualified success marker regardless.
    write0490CodexHome(isoHome);
    const run = runDoctorChecks(doctorCtx(isoHome));
    const summary = renderVerifiedSummary("0.50.0", run);
    expect(summary.degraded).toBe(true);
    expect(summary.lines.join("\n")).not.toContain("✅ verified: healthy");
    // The correct output names the failure and the fix.
    expect(summary.lines.join("\n")).toMatch(/SessionStart hook \(codex\): not found/);
    expect(summary.lines.join("\n")).toContain("flair hook install --harness codex");
  });
});

// ─── AFTER-FIX: migration installs hook → doctor passes → no contradiction ───

describe("flair#1439 — AFTER-FIX: applyUpgradeMigrations resolves the contradiction", () => {
  test("0.49.0 → 0.50.0 with Codex wired: migration installs hooks.json automatically", () => {
    write0490CodexHome(isoHome, "local");
    const hookPath = hookSettingsPath(isoHome, "codex");
    expect(existsSync(hookPath)).toBe(false); // not there before migration

    const result = applyUpgradeMigrations("0.49.0", "0.50.0", migCtx(isoHome));
    expect(result.applied).toHaveLength(1);
    expect(result.applied[0]!.migration.id).toBe("session-start-hook@0.50.0");
    const writes = result.applied[0]!.results.filter((r) => r.wrote);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.ok).toBe(true);

    expect(existsSync(hookPath)).toBe(true);
    const raw = readFileSync(hookPath, "utf-8");
    expect(raw).toContain(SESSION_START_HOOK_MARKER);
  });

  test("after migration, runDoctorChecks passes → renderVerifiedSummary emits ✅ verified: healthy", () => {
    write0490CodexHome(isoHome, "local");

    // Apply the migration (what the fixed upgrade path now does before the catalog run).
    const migResult = applyUpgradeMigrations("0.49.0", "0.50.0", migCtx(isoHome));
    expect(migResult.allOk).toBe(true);

    // NOW run the catalog — same as doctorRunAfterUpgrade does.
    const run = runDoctorChecks(doctorCtx(isoHome));
    expect(run.healthy).toBe(true);
    expect(sessionStartHookMissing(run)).toBe(false);

    const summary = renderVerifiedSummary("0.50.0", run);
    expect(summary.degraded).toBe(false);
    // The invariant: upgrade says healthy ↔ doctor says healthy.
    expect(summary.lines).toEqual(["✅ verified: healthy, authenticated, running 0.50.0"]);
  });

  test("0.49.9 → 0.51.0 also triggers the migration (any pre-0.50.0 source version)", () => {
    write0490CodexHome(isoHome, "my-agent");
    const result = applyUpgradeMigrations("0.49.9", "0.51.0", migCtx(isoHome));
    expect(result.applied.some((a) => a.migration.id === "session-start-hook@0.50.0")).toBe(true);
    expect(existsSync(hookSettingsPath(isoHome, "codex"))).toBe(true);
  });
});

// ─── Idempotency ──────────────────────────────────────────────────────────────

describe("flair#1439 — idempotency: re-running upgrade/init is a no-op", () => {
  test("if hooks.json already exists, migration returns ok:true but wrote:false (no double-write)", () => {
    write0490CodexHome(isoHome, "local");

    // First run — writes the hook.
    const first = applyUpgradeMigrations("0.49.0", "0.50.0", migCtx(isoHome));
    expect(first.applied[0]!.results.every((r) => r.ok)).toBe(true);

    // Second run — hook already present, no-op.
    const second = applyUpgradeMigrations("0.49.0", "0.50.0", migCtx(isoHome));
    // applied may be empty (no-op results are dropped) or have results with wrote:false.
    const allWrites = second.applied.flatMap((a) => a.results).filter((r) => r.wrote);
    expect(allWrites).toHaveLength(0);
    expect(second.allOk).toBe(true);
  });
});

// ─── Harness-not-wired: don't newly wire a harness the user never had ─────────

describe("flair#1439 — don't wire a harness the user never set up", () => {
  test("Codex detected on PATH but NOT wired (no config.toml) → migration skips it", () => {
    // Simulate: codex binary is installed but `flair init` was never run for it.
    // No config.toml, no hooks.json, nothing in ~/.codex/.
    const result = applyUpgradeMigrations("0.49.0", "0.50.0", migCtx(isoHome, ["codex"]));
    // No results produced for an un-wired harness.
    const written = result.applied.flatMap((a) => a.results).filter((r) => r.wrote);
    expect(written).toHaveLength(0);
    expect(existsSync(hookSettingsPath(isoHome, "codex"))).toBe(false);
  });

  test("no hook-capable clients detected → migration applies zero results", () => {
    write0490CodexHome(isoHome);
    // detectedClientIds is empty — the machine has no hook-capable client.
    const result = applyUpgradeMigrations("0.49.0", "0.50.0", migCtx(isoHome, []));
    expect(result.applied).toHaveLength(0);
    expect(existsSync(hookSettingsPath(isoHome, "codex"))).toBe(false);
  });
});

describe("flair#1439 — fail-closed: a throwing migration never crashes the upgrade (per Kern review)", () => {
  test("apply() that throws is caught → ok:false result, allOk:false, runner does NOT throw", () => {
    const throwing: UpgradeMigration = {
      id: "boom@0.50.0",
      description: "always throws",
      fromBefore: "0.50.0",
      toAtLeast: "0.50.0",
      apply() {
        throw new Error("kaboom");
      },
    };
    let result: ReturnType<typeof applyUpgradeMigrations> | undefined;
    // Without the runner's try/catch this throw propagates and crashes the
    // upgrade mid-verification — the exact worse-than-before failure #1439
    // exists to prevent. This assertion fails on that pre-fix code.
    expect(() => {
      result = applyUpgradeMigrations("0.49.0", "0.50.0", migCtx(isoHome, ["codex"]), [throwing]);
    }).not.toThrow();
    expect(result!.allOk).toBe(false);
    expect(result!.applied).toHaveLength(1);
    expect(result!.applied[0]!.results[0]!.ok).toBe(false);
    expect(result!.applied[0]!.results[0]!.wrote).toBe(false);
    expect(result!.applied[0]!.results[0]!.message).toContain("kaboom");
  });
});
