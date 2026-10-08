import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { probeSessionStartHookDelivery } from "../../src/doctor-client.ts";

/**
 * flair#2385 — the `flair hook status` SessionStart probe must end EVERY
 * process it started, not only the direct `/bin/sh`.
 *
 * The probe runs the wired command in its own process group and, on the timeout
 * path and after a normal exit, terminates the whole group. These cases run a
 * real command that backgrounds a long-lived grandchild (`sleep 60 &`), record
 * the shell's own pid (`$$`, which is the group id because the shell is spawned
 * detached) and the grandchild's pid, and assert that NEITHER the group nor the
 * grandchild is alive once the probe returns — checked by the RECORDED pids,
 * never by pattern.
 */

// The shell writes its group id and the grandchild's pid here. Passed through
// the environment so the command needs no path quoting, and so the probe (which
// forwards the caller's environment) sees it.
const RECORD_DIR_ENV = "FLAIR_PROBE_RECORD_DIR";

// Per-case budgets, above every spawn's own deadline so a case that is slow but
// not hung reports through its own assertions rather than bun's 5 s default.
const TIMEOUT_DEADLINE_MS = 800;
const TIMEOUT_CASE_BUDGET_MS = 15_000;
const NORMAL_CASE_BUDGET_MS = 15_000;

/** A command that backgrounds `sleep 60` and records both pids. With `wait`,
 *  the shell stays alive until its own deadline; without it, the shell exits
 *  immediately and leaves the grandchild behind — the normal-exit case. */
function probeCommand(): string {
  const record = `printf '%s' "$$" > "$FLAIR_PROBE_RECORD_DIR/pgid"; printf '%s' "$!" > "$FLAIR_PROBE_RECORD_DIR/child"`;
  return `sleep 60 & ${record}; wait`;
}

function probeCommandShellExits(): string {
  const record = `printf '%s' "$$" > "$FLAIR_PROBE_RECORD_DIR/pgid"; printf '%s' "$!" > "$FLAIR_PROBE_RECORD_DIR/child"`;
  return `sleep 60 & ${record}`;
}

const recDirs: string[] = [];

function freshRecordDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "flair-probe-rec-"));
  recDirs.push(dir);
  return dir;
}

function recordedInt(dir: string, name: string): number {
  const raw = readFileSync(join(dir, name), "utf-8").trim();
  const value = Number(raw);
  expect(Number.isInteger(value) && value > 0).toBe(true);
  return value;
}

/** Is the process `pid` alive? ESRCH (and only ESRCH) means gone. */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** Is any process still in group `pgid`? */
function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

afterEach(() => {
  delete process.env[RECORD_DIR_ENV];
  // Best-effort cleanup of anything a case left behind: only the pids a case
  // recorded, never a pattern. Under the fix these are already gone.
  for (const dir of recDirs.splice(0)) {
    for (const name of ["pgid", "child"]) {
      try {
        const pid = Number(readFileSync(join(dir, name), "utf-8").trim());
        if (Number.isInteger(pid) && pid > 0) {
          try {
            process.kill(-pid, "SIGKILL");
          } catch {
            // Not a live group.
          }
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // Not a live pid.
          }
        }
      } catch {
        // No recorded pid.
      }
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("flair#2385 — the hook-status probe ends the whole process group", () => {
  it(
    "on the timeout path, no process from the group the command started is alive",
    () => {
      const dir = freshRecordDir();
      process.env[RECORD_DIR_ENV] = dir;

      const outcome = probeSessionStartHookDelivery(probeCommand(), { timeoutMs: TIMEOUT_DEADLINE_MS });

      // The probe still reports the timeout it always did.
      expect(outcome.timedOut).toBe(true);
      const pgid = recordedInt(dir, "pgid");
      const child = recordedInt(dir, "child");
      // The grandchild the shell backgrounded, and its whole group, are gone.
      expect(processAlive(child)).toBe(false);
      expect(groupAlive(pgid)).toBe(false);
    },
    TIMEOUT_CASE_BUDGET_MS,
  );

  it(
    "after a normal exit, no process from the group the command started is alive",
    () => {
      const dir = freshRecordDir();
      process.env[RECORD_DIR_ENV] = dir;

      const outcome = probeSessionStartHookDelivery(probeCommandShellExits(), { timeoutMs: 8_000 });

      // The shell exited on its own; the probe did not time out.
      expect(outcome.timedOut).toBe(false);
      const pgid = recordedInt(dir, "pgid");
      const child = recordedInt(dir, "child");
      expect(processAlive(child)).toBe(false);
      expect(groupAlive(pgid)).toBe(false);
    },
    NORMAL_CASE_BUDGET_MS,
  );
});
