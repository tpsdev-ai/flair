/**
 * flair#1324 — `doctor --fix` must never ENABLE the opt-in continuity capture
 * hooks; it may only REPAIR an install the user evidently opted into before.
 *
 * The canary repro this guards against:
 *
 *   flair init --agent canary-test --no-mcp
 *   flair doctor --fix --agent canary-test    # wrote PostToolUse + Stop hooks
 *
 * Doctor's own surface labels continuity "opt-in — enable: `flair hook
 * install --continuity`", and installing the pair IS the opt-in (see
 * src/doctor-client.ts, "INSTALLING THESE HOOKS IS THE OPT-IN"). A --fix that
 * initiates that opt-in as a side effect is a consent defect, not a fix.
 *
 * These tests spawn the real CLI against an isolated HOME (the
 * cli-startup-errors.test.ts technique) because the defect lives in doctor's
 * fix-set WIRING in cli.ts, not in the pure write helpers — a pure-function
 * test of fixContinuityCaptureHooks cannot see which states doctor calls it
 * from. claude-code detection is forced deterministically by prepending a
 * fake `claude` executable to the child PATH (detectClients() is a pure
 * PATH scan — see binInPath in src/install/clients.ts).
 *
 * Every doctor assertion first proves the continuity section actually
 * RENDERED in stdout — without that, "no hooks were written" would also pass
 * if doctor crashed (or skipped the section) before reaching it, and the
 * guard could never fire.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CONTINUITY_CAPTURE_HOOK_MARKER,
  buildContinuityCaptureHookCommand,
  checkContinuityCaptureHooks,
} from "../../src/doctor-client.ts";
import { upgradeStatusSuffix } from "../../src/cli.ts";
import { FLAIR_MCP_PACKAGE } from "../../src/lib/mcp-spec.ts";

const CLI_SOURCE = join(__dirname, "..", "..", "src", "cli.ts");
const AGENT = "canary-test";
// A port nothing listens on — keeps doctor away from any real local Flair.
const DEAD_PORT = "59993";
const URL = `http://127.0.0.1:${DEAD_PORT}`;
// Generous: each case cold-starts the CLI under bun and lets doctor walk all
// of its (offline-failing) probes on a shared CI runner.
const SPAWN_TEST_TIMEOUT = 120_000;

let isoHome: string;
let isoCwd: string;
let fakeBin: string;

beforeEach(() => {
  isoHome = mkdtempSync(join(tmpdir(), "flair-1324-home-"));
  isoCwd = mkdtempSync(join(tmpdir(), "flair-1324-cwd-"));
  fakeBin = mkdtempSync(join(tmpdir(), "flair-1324-bin-"));
  // Deterministic claude-code detection: an executable named `claude` on PATH.
  const fakeClaude = join(fakeBin, "claude");
  writeFileSync(fakeClaude, "#!/bin/sh\nexit 0\n");
  chmodSync(fakeClaude, 0o755);
});

afterEach(() => {
  rmSync(isoHome, { recursive: true, force: true });
  rmSync(isoCwd, { recursive: true, force: true });
  rmSync(fakeBin, { recursive: true, force: true });
});

function runCLI(args: string[]): { exitCode: number | null; stdout: string; stderr: string } {
  const r = spawnSync("bun", [CLI_SOURCE, ...args], {
    cwd: isoCwd, // doctor --fix appends to ./CLAUDE.md — keep that off the repo
    env: {
      ...process.env,
      HOME: isoHome,
      USERPROFILE: isoHome,
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      // Scrub ambient Flair identity/target so only the flags decide.
      FLAIR_AGENT_ID: "",
      FLAIR_URL: "",
      FLAIR_TARGET: "",
    },
    timeout: SPAWN_TEST_TIMEOUT - 10_000,
    encoding: "utf8",
  });
  return { exitCode: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function settingsPath(): string {
  return join(isoHome, ".claude", "settings.json");
}

function settingsContainsContinuityMarker(): boolean {
  if (!existsSync(settingsPath())) return false;
  return readFileSync(settingsPath(), "utf-8").includes(CONTINUITY_CAPTURE_HOOK_MARKER);
}

function writePartialInstall(): void {
  // One of the two entries (Stop only) — the evident-prior-opt-in state the
  // issue rules repairable.
  const command = buildContinuityCaptureHookCommand(AGENT, URL);
  mkdirSync(join(isoHome, ".claude"), { recursive: true });
  writeFileSync(
    settingsPath(),
    JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command }] }] } }, null, 2) + "\n",
  );
  expect(checkContinuityCaptureHooks(isoHome).state).toBe("partial");
}

describe("doctor --fix and the opt-in continuity capture hooks (flair#1324)", () => {
  it(
    "GUARD: --fix on a clean install leaves the continuity hooks NOT enabled",
    () => {
      const r = runCLI(["doctor", "--fix", "--agent", AGENT, "--port", DEAD_PORT]);
      // Non-vacuous: doctor must have reached and rendered the continuity
      // section, and the opt-in hint must still be there (it is the product's
      // own statement that this is opt-in).
      expect(r.stdout).toContain("Continuity capture hooks: not enabled");
      expect(r.stdout).toContain("flair hook install --continuity");
      // The defect: --fix used to wire PostToolUse + Stop right here.
      expect(settingsContainsContinuityMarker()).toBe(false);
      expect(checkContinuityCaptureHooks(isoHome).state).toBe("absent");
    },
    SPAWN_TEST_TIMEOUT,
  );

  it(
    "POSITIVE CONTROL: the same fixture, spawn env and detector DO see hooks when the user opts in",
    () => {
      // Same spawn environment as the guard — proving the guard's "no hooks
      // were written" cannot be explained by an environment where hooks
      // simply can't be written or detected.
      const r = runCLI(["hook", "install", "--continuity", "--agent", AGENT, "--url", URL]);
      expect(r.exitCode).toBe(0);
      expect(settingsContainsContinuityMarker()).toBe(true);
      expect(checkContinuityCaptureHooks(isoHome).state).toBe("installed");
    },
    SPAWN_TEST_TIMEOUT,
  );

  it(
    "--fix --dry-run on a clean install does not announce continuity wiring",
    () => {
      const r = runCLI(["doctor", "--fix", "--dry-run", "--port", DEAD_PORT]);
      expect(r.stdout).toContain("Continuity capture hooks: not enabled");
      expect(r.stdout).not.toContain("Would wire the continuity capture hooks");
      expect(settingsContainsContinuityMarker()).toBe(false);
    },
    SPAWN_TEST_TIMEOUT,
  );

  it(
    "REPAIR: --fix completes a PARTIAL install (prior opt-in evidence) to the full pair",
    () => {
      writePartialInstall();
      const r = runCLI(["doctor", "--fix", "--agent", AGENT, "--port", DEAD_PORT]);
      expect(r.stdout).toContain("Continuity capture hooks: partial");
      const after = checkContinuityCaptureHooks(isoHome);
      expect(after.state).toBe("installed");
      expect(after.postToolUse.present).toBe(true);
      expect(after.stop.present).toBe(true);
      // The repair keeps the instance the user opted into — no silent re-point.
      expect(after.postToolUse.command).toContain(`FLAIR_URL=${URL}`);
    },
    SPAWN_TEST_TIMEOUT,
  );

  it(
    "--fix --dry-run on a PARTIAL install still announces the repair (and writes nothing)",
    () => {
      writePartialInstall();
      const r = runCLI(["doctor", "--fix", "--dry-run", "--port", DEAD_PORT]);
      expect(r.stdout).toContain("Would rewrite the continuity capture hooks");
      expect(checkContinuityCaptureHooks(isoHome).state).toBe("partial");
    },
    SPAWN_TEST_TIMEOUT,
  );
});

describe("upgrade --check re-pin advice (flair#1324)", () => {
  it("an outdated npx-wired flair-mcp is flair upgrade's job, not doctor --fix's", () => {
    const suffix = upgradeStatusSuffix(FLAIR_MCP_PACKAGE, "outdated");
    expect(suffix).not.toContain("doctor --fix");
    expect(suffix).toContain("flair upgrade");
  });

  it("POSITIVE CONTROL: the missing (never-wired) case still points at doctor --fix, so the assertion above is not blind to the phrase", () => {
    expect(upgradeStatusSuffix(FLAIR_MCP_PACKAGE, "missing")).toContain("doctor --fix");
  });
});
