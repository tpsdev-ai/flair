/**
 * doctor-run.test.ts — flair#1439.
 *
 * `flair upgrade` printed `✅ verified: healthy` while `flair doctor` exited 1
 * on a Codex SessionStart hook 0.49.0 never created. The earlier fix
 * special-cased launchd detach — a blacklist. This file pins the replacement:
 * an enumerable doctor catalog, success asserted positively, an unrun member
 * never rendering like a pass.
 *
 * Which assertions are which:
 *
 *   RED-ON-MAIN (known-answer — fails on today's main):
 *     A 0.49.0-shaped home (Codex wired in config.toml, no hooks.json)
 *     produces a failing session-start-hook check, and
 *     renderVerifiedSummary must not emit `✅ verified: healthy`.
 *
 *   REGRESSION LOCKS:
 *     Shape — a catalog member stubbed `unrun` withholds the success marker.
 *     Fresh-init — Codex MCP + hook (what 0.50.0 init now writes) is healthy.
 *     Consent — `--install-hooks` writes; silence does not. The composed
 *       applyUpgradeHookConsent path is what is asserted (file present/absent),
 *       not resolveHookInstallConsent literals alone.
 *     Catalog hole — an id with no runner is `unrun`, not a pass.
 *     One catalog — `flair doctor` calls runDoctorChecks; a new id widens both.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyUpgradeHookConsent,
  catalogBlockingCount,
  catalogIssueDelta,
  DOCTOR_CHECK_IDS,
  DOCTOR_CHECKS,
  missingHookPromptLines,
  missingHookWithoutConsentLines,
  renderCatalogDoctorLines,
  renderVerifiedSummary,
  resolveHookInstallConsent,
  resolveUpgradeHookInstall,
  runDoctorChecks,
  sessionStartHookMissing,
  summarizeDoctorRunResults,
} from "../../src/lib/doctor-run.ts";
import { installHook } from "../../src/hook-install.ts";
import { applyOrReportSessionStartHook, SESSION_START_HOOK_MARKER } from "../../src/doctor-client.ts";
import { hookSettingsPath } from "../../src/hook-install.ts";
import { tomlSnippet } from "../../src/install/clients.ts";

let isoHome: string;
let isoCwd: string;

beforeEach(() => {
  isoHome = mkdtempSync(join(tmpdir(), "flair-1439-home-"));
  isoCwd = mkdtempSync(join(tmpdir(), "flair-1439-cwd-"));
});

afterEach(() => {
  rmSync(isoHome, { recursive: true, force: true });
  rmSync(isoCwd, { recursive: true, force: true });
});

function write0490CodexHome(home: string, agentId = "local"): void {
  const dir = join(home, ".codex");
  mkdirSync(dir, { recursive: true });
  // 0.49.0 init wrote config.toml and nothing else — no hooks.json.
  writeFileSync(
    join(dir, "config.toml"),
    tomlSnippet({
      FLAIR_AGENT_ID: agentId,
      FLAIR_URL: "http://127.0.0.1:9926",
      FLAIR_CLIENT: "codex",
    }) + "\n",
  );
}

function write0490ClaudeCodeMcp(home: string, agentId = "local"): void {
  writeFileSync(
    join(home, ".claude.json"),
    JSON.stringify({
      mcpServers: {
        flair: {
          command: "npx",
          env: { FLAIR_AGENT_ID: agentId, FLAIR_URL: "http://127.0.0.1:9926" },
        },
      },
    }) + "\n",
  );
}

const linuxLaunchd = { state: "not-applicable" as const, detail: "linux does not use launchd" };

function runOn(home: string, detected: readonly string[] = ["codex"]) {
  return runDoctorChecks({
    homeDir: home,
    cwd: isoCwd,
    detectedClientIds: detected,
    launchd: linuxLaunchd,
  });
}

describe("flair#1439 — catalog is the contract", () => {
  test("Flint's six named checks plus launchd are in the catalog", () => {
    expect(DOCTOR_CHECK_IDS).toContain("mcp-block");
    expect(DOCTOR_CHECK_IDS).toContain("flair-url");
    expect(DOCTOR_CHECK_IDS).toContain("claude-md");
    expect(DOCTOR_CHECK_IDS).toContain("session-start-hook");
    expect(DOCTOR_CHECK_IDS).toContain("verified-read");
    expect(DOCTOR_CHECK_IDS).toContain("keys-prune");
    expect(DOCTOR_CHECK_IDS).toContain("launchd-management");
  });

  test("every default catalog id has a runner (positive control — not decorative)", () => {
    const implemented = new Set(DOCTOR_CHECKS.map((c) => c.id));
    for (const id of DOCTOR_CHECK_IDS) {
      expect(implemented.has(id)).toBe(true);
    }
  });

  test("flair doctor drives install-health through runDoctorChecks — one catalog widens both", () => {
    const src = readFileSync(join(import.meta.dirname, "../../src/cli.ts"), "utf-8");
    const doctorIdx = src.indexOf('.command("doctor")');
    expect(doctorIdx).toBeGreaterThan(-1);
    const nextCommand = src.indexOf(".command(\"", doctorIdx + '.command("doctor")'.length);
    const doctorBody = src.slice(doctorIdx, nextCommand === -1 ? undefined : nextCommand);
    expect(doctorBody).toContain("runDoctorChecks(");
    expect(doctorBody).toContain("catalogIssueDelta(");
    expect(doctorBody).toContain("Install health");
  });

  test("a new catalog id with no runner blocks doctor the same way it withholds upgrade ✅", () => {
    const run = runDoctorChecks(
      { homeDir: isoHome, cwd: isoCwd, detectedClientIds: [], launchd: linuxLaunchd },
      { catalogIds: [...DOCTOR_CHECK_IDS, "injected-future-check"] },
    );
    expect(catalogBlockingCount(run)).toBeGreaterThan(0);
    expect(run.results.some((r) => r.id === "injected-future-check" && r.status === "unrun")).toBe(true);
    expect(renderCatalogDoctorLines(run).some((row) => row.line.includes("injected-future-check"))).toBe(true);
    expect(renderVerifiedSummary("0.50.0", run).lines.join("\n")).not.toContain("✅ verified:");
  });
});

describe("flair#1439 — RED-ON-MAIN: 0.49.0-shaped Codex home is not verified-healthy", () => {
  test("session-start-hook fails when Codex is wired and hooks.json is absent", () => {
    write0490CodexHome(isoHome);
    const run = runOn(isoHome, ["codex"]);
    const hook = run.results.find((r) => r.id === "session-start-hook");
    expect(hook?.status).toBe("fail");
    expect(hook?.missingHarnesses).toEqual(["codex"]);
    expect(run.healthy).toBe(false);
    expect(sessionStartHookMissing(run)).toBe(true);
  });

  test("renderVerifiedSummary withholds the unqualified success marker", () => {
    write0490CodexHome(isoHome);
    const run = runOn(isoHome, ["codex"]);
    const s = renderVerifiedSummary("0.50.0", run);
    const text = s.lines.join("\n");
    expect(s.degraded).toBe(true);
    expect(text).not.toContain("✅ verified: healthy");
    expect(text).not.toContain("✅");
    expect(text).toContain("healthy, authenticated, running 0.50.0");
    expect(text).toMatch(/SessionStart hook \(codex\): not found/);
    expect(text).toContain("flair hook install --harness codex");
  });
});

describe("flair#1439 — REGRESSION LOCK: unrun never renders as passing", () => {
  test("a catalog member stubbed unrun withholds ✅ verified: healthy", () => {
    // Every other check would pass/skip on an empty home with no clients.
    const run = runDoctorChecks(
      {
        homeDir: isoHome,
        cwd: isoCwd,
        detectedClientIds: [],
        launchd: linuxLaunchd,
      },
      {
        stubs: {
          "verified-read": () => ({
            id: "verified-read",
            label: "per-agent verified-read",
            status: "unrun",
            detail: "stubbed unrun",
          }),
        },
      },
    );
    expect(run.incomplete).toBe(true);
    expect(run.healthy).toBe(false);
    const s = renderVerifiedSummary("0.50.0", run);
    const text = s.lines.join("\n");
    expect(text).not.toContain("✅ verified:");
    expect(text).not.toContain("✅");
    expect(text).toContain("UNRUN");
    expect(text).toContain("not yet checked");
  });

  test("an id with no runner is unrun, not a pass — a hole in the catalog cannot look healthy", () => {
    const run = runDoctorChecks(
      { homeDir: isoHome, cwd: isoCwd, detectedClientIds: [], launchd: linuxLaunchd },
      { catalogIds: [...DOCTOR_CHECK_IDS, "injected-future-check"] },
    );
    expect(run.results.some((r) => r.id === "injected-future-check" && r.status === "unrun")).toBe(true);
    expect(run.healthy).toBe(false);
    expect(renderVerifiedSummary("0.50.0", run).lines.join("\n")).not.toContain("✅ verified:");
  });

  test("summarizeDoctorRunResults fills missing ids as unrun so a partial list cannot look complete", () => {
    const run = summarizeDoctorRunResults([{ id: "mcp-block", label: "MCP", status: "pass" }]);
    expect(run.incomplete).toBe(true);
    expect(run.healthy).toBe(false);
    expect(run.results.filter((r) => r.status === "unrun").length).toBe(DOCTOR_CHECK_IDS.length - 1);
  });
});

describe("flair#1439 — REGRESSION LOCK: consented install then doctor-healthy", () => {
  test("installHook after a 0.49.0-shaped home makes the session-start-hook check pass", () => {
    write0490CodexHome(isoHome, "local");
    expect(runOn(isoHome, ["codex"]).healthy).toBe(false);

    const installed = installHook({
      homeDir: isoHome,
      harness: "codex",
      agentId: "local",
      flairUrl: "http://127.0.0.1:9926",
    });
    expect(installed.ok).toBe(true);
    expect(existsSync(join(isoHome, ".codex", "hooks.json"))).toBe(true);
    const raw = readFileSync(join(isoHome, ".codex", "hooks.json"), "utf-8");
    expect(raw).toContain(SESSION_START_HOOK_MARKER);

    const after = runOn(isoHome, ["codex"]);
    const hook = after.results.find((r) => r.id === "session-start-hook");
    expect(hook?.status).toBe("pass");
    expect(after.healthy).toBe(true);
    expect(renderVerifiedSummary("0.50.0", after).lines).toEqual([
      "✅ verified: healthy, authenticated, running 0.50.0",
    ]);
  });
});

describe("flair#1439 — REGRESSION LOCK: fresh 0.50.0 init shape still exits doctor-healthy", () => {
  test("wire Codex MCP + apply the hook (what init now does) → session-start-hook passes", () => {
    write0490CodexHome(isoHome, "local");
    const applied = applyOrReportSessionStartHook(
      isoHome,
      "local",
      false,
      hookSettingsPath(isoHome, "codex"),
    );
    expect(applied.ok).toBe(true);
    const run = runOn(isoHome, ["codex"]);
    expect(run.results.find((r) => r.id === "session-start-hook")?.status).toBe("pass");
    expect(run.healthy).toBe(true);
  });

  test("no hook-capable client → session-start-hook is skip, not fail (do not trade a false failure)", () => {
    const run = runOn(isoHome, []);
    expect(run.results.find((r) => r.id === "session-start-hook")?.status).toBe("skip");
    expect(run.healthy).toBe(true);
    expect(renderVerifiedSummary("0.50.0", run).degraded).toBe(false);
  });
});

describe("flair#1439 — REGRESSION LOCK: hook write is consent-bearing", () => {
  test("resolveHookInstallConsent: flag installs; silence does not; TTY prompts", () => {
    expect(resolveHookInstallConsent({ installHooksFlag: true, interactive: false })).toBe("install");
    expect(resolveHookInstallConsent({ installHooksFlag: false, interactive: false })).toBe("skip-noninteractive");
    expect(resolveHookInstallConsent({ installHooksFlag: false, interactive: true })).toBe("prompt");
    expect(resolveHookInstallConsent({ installHooksFlag: false, interactive: true, promptAccepted: true })).toBe("install");
    expect(resolveHookInstallConsent({ installHooksFlag: false, interactive: true, promptAccepted: false })).toBe("skip-declined");
  });

  test("non-interactive wording names the hook and the documented flag, and does not claim healthy", () => {
    const lines = missingHookWithoutConsentLines("codex", join(isoHome, ".codex", "hooks.json"));
    const text = lines.join("\n");
    expect(text).toContain("consent-bearing");
    expect(text).toContain("flair upgrade --install-hooks");
    expect(text).toContain("flair hook install --harness codex");
    expect(text).not.toContain("✅");
  });

  test("resolveUpgradeHookInstall reads the agent id from the Codex MCP block", () => {
    write0490CodexHome(isoHome, "local");
    const resolved = resolveUpgradeHookInstall(isoHome, "codex", { port: 9926 });
    expect(resolved).toEqual({ agentId: "local", flairUrl: "http://127.0.0.1:9926" });
  });

  test("interactive prompt names every missing harness — a yes is not consent to an unnamed extra", () => {
    const { preamble, question } = missingHookPromptLines(["claude-code", "codex"], isoHome);
    const text = [...preamble, question].join("\n");
    expect(text).toContain("claude-code");
    expect(text).toContain("codex");
    expect(text).toContain(hookSettingsPath(isoHome, "claude-code"));
    expect(text).toContain(hookSettingsPath(isoHome, "codex"));
    expect(question).toContain("claude-code and codex");
    expect(text).toContain("no CLAUDE.md alternative on Codex");
  });

  test("Claude-Code-only prompt does not use the Codex-only rationale", () => {
    const { preamble, question } = missingHookPromptLines(["claude-code"], isoHome);
    const text = [...preamble, question].join("\n");
    expect(text).toContain("claude-code");
    expect(text).not.toContain("Codex");
    expect(text).not.toContain("codex");
    expect(question).not.toContain("and");
  });
});

describe("flair#1439 — REGRESSION LOCK: consent→write composition actually writes (or does not)", () => {
  function ctxFor(detected: readonly string[]) {
    return {
      homeDir: isoHome,
      cwd: isoCwd,
      detectedClientIds: detected,
      launchd: linuxLaunchd,
    };
  }

  test("0.49.0-shaped home, installHooksFlag false, interactive false → ~/.codex/hooks.json is not created", () => {
    write0490CodexHome(isoHome, "local");
    const ctx = ctxFor(["codex"]);
    const run = runDoctorChecks(ctx);
    expect(sessionStartHookMissing(run)).toBe(true);
    expect(existsSync(join(isoHome, ".codex", "hooks.json"))).toBe(false);

    const outcome = applyUpgradeHookConsent({
      homeDir: isoHome,
      ctx,
      run,
      installHooksFlag: false,
      interactive: false,
    });
    expect(outcome.consent).toBe("skip-noninteractive");
    expect(outcome.written).toEqual([]);
    expect(existsSync(join(isoHome, ".codex", "hooks.json"))).toBe(false);
    expect(outcome.run.healthy).toBe(false);
  });

  test("same composed path with --install-hooks writes hooks.json (positive control — skip is not a no-op writer)", () => {
    write0490CodexHome(isoHome, "local");
    const ctx = ctxFor(["codex"]);
    const run = runDoctorChecks(ctx);
    const outcome = applyUpgradeHookConsent({
      homeDir: isoHome,
      ctx,
      run,
      installHooksFlag: true,
      interactive: false,
    });
    expect(outcome.consent).toBe("install");
    expect(outcome.written).toEqual(["codex"]);
    expect(existsSync(join(isoHome, ".codex", "hooks.json"))).toBe(true);
    expect(readFileSync(join(isoHome, ".codex", "hooks.json"), "utf-8")).toContain(SESSION_START_HOOK_MARKER);
    expect(outcome.run.results.find((r) => r.id === "session-start-hook")?.status).toBe("pass");
  });

  test("dual-harness: composed prompt names every harness a yes will write; silence writes neither file", () => {
    write0490CodexHome(isoHome, "local");
    write0490ClaudeCodeMcp(isoHome, "local");
    const ctx = ctxFor(["claude-code", "codex"]);
    const run = runDoctorChecks(ctx);
    expect(run.results.find((r) => r.id === "session-start-hook")?.missingHarnesses).toEqual([
      "claude-code",
      "codex",
    ]);

    const prompted = applyUpgradeHookConsent({
      homeDir: isoHome,
      ctx,
      run,
      installHooksFlag: false,
      interactive: true,
    });
    expect(prompted.consent).toBe("prompt");
    const promptText = [...(prompted.prompt?.preamble ?? []), prompted.prompt?.question ?? ""].join("\n");
    expect(promptText).toContain("claude-code");
    expect(promptText).toContain("codex");
    expect(promptText).toContain(hookSettingsPath(isoHome, "claude-code"));
    expect(promptText).toContain(hookSettingsPath(isoHome, "codex"));
    expect(existsSync(hookSettingsPath(isoHome, "claude-code"))).toBe(false);
    expect(existsSync(hookSettingsPath(isoHome, "codex"))).toBe(false);

    const silent = applyUpgradeHookConsent({
      homeDir: isoHome,
      ctx,
      run,
      installHooksFlag: false,
      interactive: false,
    });
    expect(silent.consent).toBe("skip-noninteractive");
    expect(existsSync(hookSettingsPath(isoHome, "claude-code"))).toBe(false);
    expect(existsSync(hookSettingsPath(isoHome, "codex"))).toBe(false);

    const accepted = applyUpgradeHookConsent({
      homeDir: isoHome,
      ctx,
      run,
      installHooksFlag: false,
      interactive: true,
      promptAccepted: true,
    });
    expect(accepted.consent).toBe("install");
    expect(accepted.written).toEqual(["claude-code", "codex"]);
    expect(existsSync(hookSettingsPath(isoHome, "claude-code"))).toBe(true);
    expect(existsSync(hookSettingsPath(isoHome, "codex"))).toBe(true);
  });

  test("catalogIssueDelta counts a catalog fail as found and a cleared fail as fixed", () => {
    write0490CodexHome(isoHome, "local");
    const ctx = ctxFor(["codex"]);
    const before = runDoctorChecks(ctx);
    expect(catalogIssueDelta(before, before)).toEqual({ found: 1, fixed: 0 });
    const after = applyUpgradeHookConsent({
      homeDir: isoHome,
      ctx,
      run: before,
      installHooksFlag: true,
      interactive: false,
    }).run;
    expect(catalogIssueDelta(before, after)).toEqual({ found: 1, fixed: 1 });
  });
});

describe("flair#1439 — Bugbot: healthy-unverified must not claim authenticated", () => {
  test("renderVerifiedSummary({ authenticated: false }) omits the authenticated fact", () => {
    write0490CodexHome(isoHome);
    const run = runOn(isoHome, ["codex"]);
    const s = renderVerifiedSummary("0.50.0", run, { authenticated: false });
    const text = s.lines.join("\n");
    expect(text).not.toContain("authenticated");
    expect(text).not.toContain("✅");
    expect(text).toContain("healthy");
  });
});
