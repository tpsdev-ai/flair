/**
 * cli-startup-errors.test.ts — Assert the CLI produces good errors + nonzero
 * exit codes when users mess up common things.
 *
 * Covers the failure modes a real user is most likely to hit:
 *   - wrong subcommand name
 *   - `flair start` with no prior `flair init`
 *   - missing required options (--content, --admin-pass)
 *
 * Tests spawn the CLI as a subprocess (via bun on the TS source) rather than
 * driving Commander in-process. That costs ~400ms per case but catches exit
 * codes, process.exit paths, and stderr formatting — all user-visible things
 * in-process tests can't see.
 */

import { describe, test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { childOverranDeadline } from "../helpers/child-deadline.js";

const CLI_SOURCE = join(__dirname, "..", "..", "src", "cli.ts");

// flair#1807: the child's OWN deadline (spawnSync timeout) and a per-test
// budget ABOVE it (deadline + 5 s for setup/assertions), so a hung child is
// reported by the child's deadline, by name, with its output — never as bun's
// bare per-test "timed out".
const CHILD_DEADLINE_MS = 20_000;
const CASE_BUDGET_MS = 25_000;

interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

function runCLI(args: string[], leg: string, opts: { env?: Record<string, string> } = {}): RunResult {
  const r = spawnSync("bun", [CLI_SOURCE, ...args], {
    env: { ...process.env, ...opts.env },
    timeout: CHILD_DEADLINE_MS,
    encoding: "utf8",
  });
  // spawnSync reports a child killed at its deadline as status === null with a
  // signal — surface it by name (with the child's output), not as a bare null.
  if (r.status === null && r.signal) {
    throw new Error(
      childOverranDeadline("flair CLI", leg, CHILD_DEADLINE_MS, {
        status: r.status,
        signal: r.signal,
        stdout: r.stdout,
        stderr: r.stderr,
      }),
    );
  }
  return {
    exitCode: r.status,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}

function makeIsolatedHome(): string {
  const dir = join(tmpdir(), `flair-cli-errors-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("CLI startup failure modes", () => {
  test("flair --version prints version and exits 0", () => {
    const r = runCLI(["--version"], "version");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/\d+\.\d+\.\d+/);
  }, CASE_BUDGET_MS);

  test("unknown subcommand exits nonzero with helpful error", () => {
    const r = runCLI(["this-is-not-a-real-command"], "unknown subcommand");
    expect(r.exitCode).not.toBe(0);
    // Commander writes "unknown command" / "see --help" to stderr
    expect((r.stderr + r.stdout).toLowerCase()).toMatch(/unknown|command|help/);
  }, CASE_BUDGET_MS);

  test("flair start without prior init fails cleanly", () => {
    // Point HOME at a scratch dir so defaultDataDir() (~/.flair/data) doesn't exist.
    // Picking a port far from the CI defaults to avoid collisions.
    const home = makeIsolatedHome();
    try {
      const r = runCLI(["start", "--port", "59997"], "start without prior init", {
        env: { HOME: home, USERPROFILE: home },
      });
      expect(r.exitCode).not.toBe(0);
      expect((r.stderr + r.stdout).toLowerCase()).toMatch(/init|data directory|flair init/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, CASE_BUDGET_MS);

  test("memory add without --content errors with required-option message", () => {
    const r = runCLI(["memory", "add", "--agent", "does-not-matter"], "memory add without content");
    expect(r.exitCode).not.toBe(0);
    expect((r.stderr + r.stdout).toLowerCase()).toMatch(/content|required/);
  }, CASE_BUDGET_MS);

  test("agent add without admin-pass reports a clear actionable error", () => {
    // Use an isolated HOME so nothing in the runner's real ~/.flair interferes.
    const home = makeIsolatedHome();
    try {
      const r = runCLI(["agent", "add", "test-agent", "--name", "Test"], "agent add without admin-pass", {
        env: {
          HOME: home,
          USERPROFILE: home,
          // Explicitly unset FLAIR_ADMIN_PASS / HDB_ADMIN_PASSWORD so the
          // fallback doesn't quietly satisfy the check.
          FLAIR_ADMIN_PASS: "",
          HDB_ADMIN_PASSWORD: "",
        },
      });
      expect(r.exitCode).not.toBe(0);
      expect((r.stderr + r.stdout).toLowerCase()).toMatch(/admin-pass|flair_admin_pass/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, CASE_BUDGET_MS);
});
