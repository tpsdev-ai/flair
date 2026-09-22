/**
 * doctor-readonly-no-lock.test.ts — flair#1778 slice 2c-i-c, fixture C5.
 *
 * READ-ONLY paths do NOT lock: `flair doctor` WITHOUT --fix reports only. It
 * must create no lock file, no staging temp and no `.bak` beside the hook
 * settings file, take no backup, and leave the file's bytes and its directory
 * listing EXACTLY as they were.
 *
 * Deterministic, no polling (a poll cannot prove a transient lock never
 * existed): the settings file's PARENT DIRECTORY is made read-only (chmod
 * 0555), so any attempt to create a lock / temp / `.bak` there would fail
 * loudly and change the run. The mode is restored in a finally.
 *
 * PRECONDITION: this test must NOT run as uid 0 (root ignores the mode, so the
 * guard could not fire) — that is a FAIL by name, never a skip.
 *
 * A REGRESSION guard, not a fails-on-main check.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { childOverranDeadline, cliLeg } from "../helpers/child-deadline.js";

const CLI_SOURCE = join(__dirname, "..", "..", "src", "cli.ts");
// A port nothing listens on — keeps doctor away from any real local Flair.
const DEAD_PORT = "59993";
const CHILD_DEADLINE_MS = 30_000;
const CASE_BUDGET_MS = 40_000;

let isoHome: string;
let isoCwd: string;
let fakeBin: string;

beforeEach(() => {
  isoHome = mkdtempSync(join(tmpdir(), "flair-2cic-ro-home-"));
  isoCwd = mkdtempSync(join(tmpdir(), "flair-2cic-ro-cwd-"));
  fakeBin = mkdtempSync(join(tmpdir(), "flair-2cic-ro-bin-"));
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

const settingsDir = () => join(isoHome, ".claude");
const settingsPath = () => join(settingsDir(), "settings.json");

function runDoctor(): { exitCode: number | null; stdout: string; stderr: string } {
  const startedAt = Date.now();
  const r = spawnSync("bun", [CLI_SOURCE, "doctor", "--port", DEAD_PORT], {
    cwd: isoCwd, // never the repo: doctor reads ./CLAUDE.md
    env: {
      ...process.env,
      HOME: isoHome,
      USERPROFILE: isoHome,
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      FLAIR_AGENT_ID: "",
      FLAIR_URL: "",
      FLAIR_TARGET: "",
    },
    timeout: CHILD_DEADLINE_MS,
    encoding: "utf8",
  });
  if (r.signal !== null) {
    throw new Error(
      childOverranDeadline("flair CLI", cliLeg(["doctor", "--port", DEAD_PORT]), CHILD_DEADLINE_MS, {
        status: r.status,
        signal: r.signal,
        elapsedMs: Date.now() - startedAt,
        stdout: r.stdout,
        stderr: r.stderr,
      }),
    );
  }
  return { exitCode: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

describe("C5 READ-ONLY WRITES NOTHING — a REGRESSION guard (not a fails-on-main check)", () => {
  it("doctor WITHOUT --fix in a read-only settings dir creates no lock/temp/.bak and changes nothing", () => {
    // Root ignores the 0555 mode, so the guard could not fire — FAIL by name.
    expect(
      process.getuid?.() ?? -1,
      "C5 requires a non-root uid: root ignores chmod 0555, so the read-only-dir guard could not fire",
    ).not.toBe(0);

    mkdirSync(settingsDir(), { recursive: true });
    // A hook-capable client IS wired, so doctor reaches the SessionStart section.
    writeFileSync(
      join(isoHome, ".claude.json"),
      JSON.stringify({ mcpServers: { flair: { command: "npx", args: ["-y", "@tpsdev-ai/flair-mcp"], env: { FLAIR_AGENT_ID: "local", FLAIR_URL: `http://127.0.0.1:${DEAD_PORT}` } } } }) + "\n",
    );
    // A custom (non-Flair) hook: doctor reports on it and does NOT probe-run it.
    const hookBytes = JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo hi" }] }] } }) + "\n";
    writeFileSync(settingsPath(), hookBytes);

    const bytesBefore = readFileSync(settingsPath(), "utf-8");
    const listingBefore = readdirSync(settingsDir()).sort();

    // Control run in a WRITABLE dir, so exit-code equality is asserted against
    // this same home rather than a hard-coded expectation.
    const control = runDoctor();

    const modeBefore = statSync(settingsDir()).mode & 0o777;
    chmodSync(settingsDir(), 0o555);
    try {
      const ro = runDoctor();

      // It reports as today: same exit code, and the report sections rendered.
      expect(ro.exitCode).toBe(control.exitCode);
      expect(ro.stdout).toContain("SessionStart hook");
      expect(ro.stdout).toContain("Continuity capture hooks");

      // The bytes are unchanged and NOTHING was created beside them.
      expect(readFileSync(settingsPath(), "utf-8")).toBe(bytesBefore);
      expect(readFileSync(settingsPath(), "utf-8")).toBe(hookBytes);
      expect(readdirSync(settingsDir()).sort()).toEqual(listingBefore);
      expect(listingBefore.some((f) => f.includes(".lock") || f.includes(".tmp-") || f.endsWith(".bak"))).toBe(false);
    } finally {
      chmodSync(settingsDir(), modeBefore);
    }
  }, CASE_BUDGET_MS);
});
