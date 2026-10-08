import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, openSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  HOOK_PROBE_MAX_OUTPUT_BYTES,
  classifyHookProbe,
  endProbeProcessGroup,
  probeSessionStartHookDelivery,
  runProbeInOwnGroup,
  type ProbeSignalSender,
} from "../../src/doctor-client.ts";
import { classifyHookDelivery } from "../../src/hook-install.ts";

/**
 * flair#2385 — the `flair hook status` SessionStart probe runs its command in a
 * process group of its own and signals that group (POSIX process groups; on
 * Windows `runProbeInOwnGroup` does no group handling).
 *
 * The real-process cases run a command that records the shell's own pid (`$$`,
 * the group id, because the shell is spawned detached) and, where it starts
 * one, the pid of a long-lived grandchild (`sleep 60 &`), and then check those
 * RECORDED pids — never a pattern. These cases run under Bun; the same
 * real-process checks under Node are in hook-probe-process-group-node.test.ts.
 */

// The shell writes its group id and the grandchild's pid here. Passed through
// the environment so the command needs no path quoting, and so the probe (which
// forwards the caller's environment) sees it.
const RECORD_DIR_ENV = "FLAIR_PROBE_RECORD_DIR";
const RECORD_PGID = `printf '%s' "$$" > "$FLAIR_PROBE_RECORD_DIR/pgid"`;
const RECORD_CHILD = `printf '%s' "$!" > "$FLAIR_PROBE_RECORD_DIR/child"`;

// Per-case budgets, above every spawn's own deadline (and the probe's bounded
// cleanup waits) so a slow case reports through its own assertions rather than
// bun's 5 s default.
const TIMEOUT_DEADLINE_MS = 800;
const CASE_BUDGET_MS = 15_000;

/** Backgrounds `sleep 60` and records both pids; `wait` keeps the shell alive
 *  until the probe's deadline. */
function probeCommand(): string {
  return `sleep 60 & ${RECORD_PGID}; ${RECORD_CHILD}; wait`;
}

/** Backgrounds `sleep 60`, records both pids, and exits at once, leaving the
 *  grandchild behind. */
function probeCommandShellExits(): string {
  return `sleep 60 & ${RECORD_PGID}; ${RECORD_CHILD}`;
}

const scratchDirs: string[] = [];

function freshDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

function freshRecordDir(): string {
  const dir = freshDir("flair-probe-rec-");
  process.env[RECORD_DIR_ENV] = dir;
  return dir;
}

function recordedInt(dir: string, name: string): number {
  const raw = readFileSync(join(dir, name), "utf-8").trim();
  const value = Number(raw);
  expect(Number.isInteger(value) && value > 1).toBe(true);
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

/** A real `kill` that records each non-zero signal sent to a group, and whether
 *  that group still had a member at the moment it was sent. */
function recordingKill(sent: Array<{ target: number; signal: string; groupPresent: boolean }>): ProbeSignalSender {
  return (pid, signal) => {
    if (signal !== 0 && pid < 0) sent.push({ target: pid, signal, groupPresent: groupAlive(-pid) });
    process.kill(pid, signal);
  };
}

afterEach(() => {
  delete process.env[RECORD_DIR_ENV];
  // Cleanup of anything a case left behind: only the pids a case recorded,
  // never a pattern. Under the fix these are already gone, except in the case
  // that drops SIGKILL on purpose, whose group is still held by the probe's pin.
  for (const dir of scratchDirs.splice(0)) {
    for (const name of ["pgid", "child"]) {
      let pid = 0;
      try {
        pid = Number(readFileSync(join(dir, name), "utf-8").trim());
      } catch {
        // No recorded pid.
      }
      if (!Number.isInteger(pid) || pid <= 1) continue;
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
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("flair#2385 — the hook-status probe's process-group cleanup", () => {
  it(
    "on the timeout path, no process from the group the command started is alive",
    () => {
      const dir = freshRecordDir();

      const outcome = probeSessionStartHookDelivery(probeCommand(), { timeoutMs: TIMEOUT_DEADLINE_MS });

      // The probe still reports the timeout it always did.
      expect(outcome.timedOut).toBe(true);
      expect(outcome.cleanupError ?? null).toBeNull();
      const pgid = recordedInt(dir, "pgid");
      const child = recordedInt(dir, "child");
      // The grandchild the shell backgrounded, and its whole group, are gone.
      expect(processAlive(child)).toBe(false);
      expect(groupAlive(pgid)).toBe(false);
    },
    CASE_BUDGET_MS,
  );

  it(
    "after a normal exit, no process from the group the command started is alive",
    () => {
      const dir = freshRecordDir();

      const outcome = probeSessionStartHookDelivery(probeCommandShellExits(), { timeoutMs: 8_000 });

      // The shell exited on its own; the probe did not time out.
      expect(outcome.timedOut).toBe(false);
      expect(outcome.cleanupError ?? null).toBeNull();
      const pgid = recordedInt(dir, "pgid");
      const child = recordedInt(dir, "child");
      expect(processAlive(child)).toBe(false);
      expect(groupAlive(pgid)).toBe(false);
    },
    CASE_BUDGET_MS,
  );

  it(
    "a command that leaves no child keeps its ordinary outcome, and each group signal is sent while the group has a member",
    () => {
      const dir = freshRecordDir();
      const sent: Array<{ target: number; signal: string; groupPresent: boolean }> = [];

      const outcome = runProbeInOwnGroup(`${RECORD_PGID}; printf '{}'`, 8_000, {
        input: "{}",
        env: process.env,
        kill: recordingKill(sent),
      });

      expect(outcome).toMatchObject({ exitCode: 0, stdout: "{}", timedOut: false, spawnError: null, cleanupError: null, outputOverflow: false });
      const pgid = recordedInt(dir, "pgid");
      // The shell had exited and been reaped before the probe signalled, yet the
      // group still had a member each time: the pin the probe placed in it.
      expect(sent.length).toBeGreaterThan(0);
      for (const s of sent) {
        expect(s.target).toBe(-pgid);
        expect(s.groupPresent).toBe(true);
      }
      // ...and the pin went with the rest of the group.
      expect(groupAlive(pgid)).toBe(false);
    },
    CASE_BUDGET_MS,
  );

  it(
    "a group still present after cleanup is reported as a named cleanup failure, not as the command's own result",
    () => {
      const dir = freshRecordDir();
      // A grandchild that ignores SIGTERM, and a sender that drops SIGKILL: the
      // group outlives the probe's cleanup.
      const dropKill: ProbeSignalSender = (pid, signal) => {
        if (signal === "SIGKILL") return;
        process.kill(pid, signal);
      };
      const delivered = JSON.stringify({ hookSpecificOutput: { additionalContext: "context" } });

      const outcome = runProbeInOwnGroup(
        `(trap '' TERM; exec sleep 60) & ${RECORD_PGID}; ${RECORD_CHILD}; printf '%s' '${delivered}'`,
        8_000,
        { input: "{}", env: process.env, kill: dropKill },
      );

      const child = recordedInt(dir, "child");
      expect(processAlive(child)).toBe(true);
      expect(outcome.exitCode).toBe(0);
      expect(outcome.stdout).toBe(delivered);
      expect(outcome.cleanupError ?? "").toContain("still present");

      // Without the cleanup failure the same outcome reads as a pass...
      expect(classifyHookProbe({ ...outcome, cleanupError: null }).execution).toBe("runs");
      expect(classifyHookDelivery({ ...outcome, cleanupError: null }).delivered).toBe(true);
      // ...with it, both classifiers name the failure instead.
      const probe = classifyHookProbe(outcome);
      expect(probe.execution).toBe("unknown");
      expect(probe.detail).toContain("process group");
      const delivery = classifyHookDelivery(outcome);
      expect(delivery.delivered).toBe(false);
      expect(delivery.reason).toContain("process group");
    },
    CASE_BUDGET_MS,
  );

  it(
    "with no pin present, the group is only checked with signal 0 and is reported, not signalled",
    async () => {
      const sent: Array<{ target: number; signal: string; groupPresent: boolean }> = [];
      // A real group this test owns: a detached `sleep` is the leader of its own.
      const leader = Bun.spawn(["sleep", "30"], { detached: true, stdio: ["ignore", "ignore", "ignore"] });
      try {
        expect(groupAlive(leader.pid)).toBe(true);
        // A pid that has already exited and been reaped stands in for a pin that is gone.
        const goneReaped = Bun.spawnSync(["true"]).pid;

        for (const pin of [null, goneReaped]) {
          const reason = endProbeProcessGroup(leader.pid, pin, recordingKill(sent));
          expect(reason).toContain("not signalled");
        }
        expect(sent).toEqual([]);
        expect(processAlive(leader.pid)).toBe(true);
      } finally {
        leader.kill("SIGKILL");
        await leader.exited;
      }
    },
    CASE_BUDGET_MS,
  );
});

describe("flair#2385 — the probe's captured output and temp directory", () => {
  it(
    `output over ${HOOK_PROBE_MAX_OUTPUT_BYTES} bytes on stdout or stderr is reported as an overflow; exactly that many is not`,
    () => {
      const tmpRoot = freshDir("flair-probe-tmp-");
      const run = (cmd: string) => runProbeInOwnGroup(cmd, 8_000, { input: "", env: process.env, tmpRoot });

      const exact = run(`head -c ${HOOK_PROBE_MAX_OUTPUT_BYTES} /dev/zero`);
      expect(exact.outputOverflow).toBe(false);
      expect(exact.stdout.length).toBe(HOOK_PROBE_MAX_OUTPUT_BYTES);

      for (const redirect of ["", " >&2"]) {
        const over = run(`head -c ${HOOK_PROBE_MAX_OUTPUT_BYTES + 1} /dev/zero${redirect}`);
        expect(over.exitCode).toBe(0);
        expect(over.outputOverflow).toBe(true);
        expect((redirect ? over.stderr : over.stdout).length).toBe(HOOK_PROBE_MAX_OUTPUT_BYTES);
        const probe = classifyHookProbe(over);
        expect(probe.execution).toBe("unknown");
        expect(probe.detail).toContain(`${HOOK_PROBE_MAX_OUTPUT_BYTES}-byte limit`);
        const delivery = classifyHookDelivery(over);
        expect(delivery.delivered).toBe(false);
        expect(delivery.reason).toContain("size limit");
      }
      // Each run removed its temp directory.
      expect(readdirSync(tmpRoot)).toEqual([]);
    },
    CASE_BUDGET_MS,
  );

  it(
    "the temp directory is removed when opening an output file throws",
    () => {
      const tmpRoot = freshDir("flair-probe-tmp-");
      let opens = 0;
      const openOutput = (path: string): number => {
        opens += 1;
        if (opens === 2) throw Object.assign(new Error("EMFILE: too many open files"), { code: "EMFILE" });
        return openSync(path, "w+");
      };

      expect(() => runProbeInOwnGroup("printf '{}'", 8_000, { input: "", env: process.env, tmpRoot, openOutput })).toThrow("EMFILE");
      expect(opens).toBe(2);
      expect(readdirSync(tmpRoot)).toEqual([]);
    },
    CASE_BUDGET_MS,
  );
});
