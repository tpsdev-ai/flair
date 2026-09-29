/**
 * fake-launchctl.ts — a `launchctl` that a unit test can put on PATH, plus a
 * tripwire that fails the test if anything reaches a launchctl that is NOT the
 * fake (flair#2057).
 *
 * Why: `launchctl` acts on the caller's per-user GUI launchd domain, which is
 * host state, not fixture state. A unit test that drives a darwin launchd code
 * path without a fake on PATH reaches the developer's real launchd — and those
 * paths do not only read: `flair init` can `launchctl unload` a legacy plist it
 * owns, and other commands run `load`, `bootstrap`, `bootout` and `kickstart`.
 * A unit test must not talk to the host's service manager at all.
 *
 * Two pieces, both reusable:
 *
 *   - `installFakeLaunchctl()` — a recording fake (logs each call's
 *     arguments and exits 0; exits non-zero if it cannot log the call), plus
 *     the tripwire, pre-arranged so `${pathEntry}:<real PATH>` is the correct
 *     PATH order.
 *   - `installLaunchctlTripwire()` — just the tripwire, for a test that already
 *     has its own fake and only needs the guard.
 *
 * The tripwire is a second `launchctl` placed on PATH BEHIND the fake, ahead of
 * the real binary: if the fake is ever missing from PATH, the invocation lands
 * on the tripwire, which records the call, prints `LAUNCHCTL_TRIPWIRE_MESSAGE`
 * and exits non-zero instead of silently touching the host. `assertShadowed()`
 * proves the fake really is first — which is also what makes the tripwire
 * mutation-testable: drop the fake and the check throws the tripwire's message
 * rather than passing silently.
 *
 * Fail-closed by construction:
 *
 *   - Every tripwire call writes a NONEMPTY line starting with
 *     `LAUNCHCTL_TRIPWIRE_EVENT`, a call with no arguments included.
 *   - Both log paths are written into the scripts themselves, so a caller that
 *     scrubs its child's environment still records.
 *   - Both logs are created empty at install. A log that cannot be read is a
 *     broken harness, so reading it throws — it never reads as "no calls".
 *   - `assertClear()` treats ANY byte in the tripwire log as a call; a blank
 *     line cannot hide one.
 *
 * Scratch directories come from `tempDir`, so their removal is registered with
 * the process-global unit-lane sweep.
 */

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./temp-dir.ts";

/**
 * The message the tripwire prints. Named so a test (or an operator reading CI)
 * can tell a real-launchctl reach apart from an ordinary launchd failure.
 */
export const LAUNCHCTL_TRIPWIRE_MESSAGE =
  "flair-test-tripwire: unit test invoked launchctl with the fake missing from PATH; " +
  "a unit test must never reach the host service manager (put test/helpers/fake-launchctl.ts " +
  "ahead of the real launchctl on PATH)";

/**
 * The marker every tripwire log line starts with. The full line is
 * `${LAUNCHCTL_TRIPWIRE_EVENT} argc=<n> argv=<args>`, so a call with no
 * arguments still leaves a nonempty line.
 */
export const LAUNCHCTL_TRIPWIRE_EVENT = "launchctl-tripwire-fired";

/** Quote `value` as one POSIX-shell word. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Logs its arguments, space-joined, and exits 0. If the log write fails, it
 * says so on stderr and exits 1: a fake that cannot record must not look like
 * a fake that answered.
 */
function fakeScript(logPath: string): string {
  return [
    "#!/bin/sh",
    `printf '%s\\n' "$*" >> ${shellQuote(logPath)} || {`,
    `  printf '%s\\n' ${shellQuote(`flair-test-fake-launchctl: could not record this call in ${logPath}`)} >&2`,
    "  exit 1",
    "}",
    "exit 0",
    "",
  ].join("\n");
}

/** Records a nonempty event line, shouts the named message, exits non-zero. Never answers. */
function tripwireScript(logPath: string): string {
  return [
    "#!/bin/sh",
    `printf '%s argc=%s argv=%s\\n' ${shellQuote(LAUNCHCTL_TRIPWIRE_EVENT)} "$#" "$*" >> ${shellQuote(logPath)}`,
    `printf '%s: %s\\n' ${shellQuote(LAUNCHCTL_TRIPWIRE_MESSAGE)} "$*" >&2`,
    "exit 1",
    "",
  ].join("\n");
}

/**
 * Read a shim's log. The log is created empty at install, so ANY read failure
 * (missing, unreadable, not a file) means the harness is broken — throw rather
 * than report "no calls".
 */
function readLog(path: string): string {
  try {
    return readFileSync(path, "utf-8");
  } catch (err) {
    throw new Error(
      `fake-launchctl: cannot read ${path} (${(err as Error).message}). The log is created at install, ` +
        `so a missing or unreadable log is a broken harness, not "no launchctl calls"`,
    );
  }
}

/** One entry per log line, oldest first. Blank lines are kept, never dropped. */
function logLines(content: string): string[] {
  if (content === "") return [];
  return (content.endsWith("\n") ? content.slice(0, -1) : content).split("\n");
}

export interface LaunchctlTripwire {
  /** Directory holding the tripwire shim. Put this directly after the fake. */
  dir: string;
  /** The tripwire executable (`dir/launchctl`). */
  binPath: string;
  /** Log of invocations that reached the tripwire. Created empty; must stay empty. */
  logPath: string;
  /** Lines the tripwire logged (`${LAUNCHCTL_TRIPWIRE_EVENT} argc=<n> argv=<args>`), oldest first. */
  tripped(): string[];
  /** Throw `LAUNCHCTL_TRIPWIRE_MESSAGE` if the tripwire log holds anything at all. */
  assertClear(): void;
  /** Best-effort removal of the scratch directory (tempDir also sweeps). */
  cleanup(): void;
}

/**
 * Install just the tripwire. Put `dir` on PATH behind your own fake; if your
 * fake is ever missing, any `launchctl` call lands here and fails loudly.
 */
export function installLaunchctlTripwire(prefix = "flair-launchctl-tripwire-"): LaunchctlTripwire {
  const dir = tempDir(prefix);
  const binPath = join(dir, "launchctl");
  const logPath = join(dir, "tripwire.log");
  writeFileSync(logPath, "");
  writeFileSync(binPath, tripwireScript(logPath));
  chmodSync(binPath, 0o755);
  return {
    dir,
    binPath,
    logPath,
    tripped: () => logLines(readLog(logPath)),
    assertClear() {
      const raw = readLog(logPath);
      if (raw.length > 0) {
        throw new Error(`${LAUNCHCTL_TRIPWIRE_MESSAGE} (reached by: ${JSON.stringify(logLines(raw))})`);
      }
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export interface FakeLaunchctl {
  /** Directory holding the fake shim. Put this FIRST on PATH. */
  fakeDir: string;
  /** Directory holding the tripwire shim. Put this directly AFTER the fake. */
  tripwireDir: string;
  /** `${fakeDir}:${tripwireDir}` — prepend this to a child's PATH. */
  pathEntry: string;
  /** The fake's log: each call's arguments, space-joined. Created empty. */
  logPath: string;
  /**
   * Lines the fake recorded, oldest first: a call's arguments space-joined, a
   * no-argument call as "". Includes the probe of every `assertShadowed()` call.
   */
  invocations(): string[];
  /** Lines that reached the tripwire. A test asserts this stays empty. */
  tripped(): string[];
  /** Throw `LAUNCHCTL_TRIPWIRE_MESSAGE` if the tripwire log holds anything at all. */
  assertClear(): void;
  /**
   * Prove the fake, not the tripwire and not the host binary, answers
   * `launchctl` for `path` (defaults to the process's own `PATH`, which the
   * caller is expected to have laid the fake onto first): a probe with a
   * unique argument must exit 0 AND appear in the fake's log, and the
   * tripwire must be clear. Throws `LAUNCHCTL_TRIPWIRE_MESSAGE` when the
   * tripwire answered instead, and a "did not reach the fake" error when
   * anything else did.
   */
  assertShadowed(path?: string): void;
  /** Best-effort removal of the scratch directories (tempDir also sweeps). */
  cleanup(): void;
}

/**
 * Install the fake and the tripwire together. Call from a `beforeEach` (each
 * test gets a fresh pair), lay `pathEntry` on the PATH of every subprocess the
 * test spawns AND on the process's own `process.env.PATH` when the CLI runs
 * in-process, then call `assertShadowed()`. No environment variables are
 * needed: both log paths are written into the scripts.
 */
export function installFakeLaunchctl(prefix = "flair-fake-launchctl-"): FakeLaunchctl {
  const root = tempDir(prefix);
  const fakeDir = join(root, "fake");
  mkdirSync(fakeDir, { recursive: true });
  const logPath = join(root, "fake.log");
  writeFileSync(logPath, "");
  const fakeBin = join(fakeDir, "launchctl");
  writeFileSync(fakeBin, fakeScript(logPath));
  chmodSync(fakeBin, 0o755);
  const tripwire = installLaunchctlTripwire(prefix + "tripwire-");
  const invocations = () => logLines(readLog(logPath));

  return {
    fakeDir,
    tripwireDir: tripwire.dir,
    pathEntry: `${fakeDir}:${tripwire.dir}`,
    logPath,
    invocations,
    tripped: () => tripwire.tripped(),
    assertClear: () => tripwire.assertClear(),
    assertShadowed(path?: string) {
      const probe = `__flair_fake_launchctl_probe_${randomUUID()}__`;
      const probePath = path ?? process.env.PATH ?? "";
      const res = spawnSync("launchctl", [probe], {
        encoding: "utf-8",
        env: { ...process.env, PATH: probePath },
        timeout: 10_000,
      });
      const detail =
        `launchctl ${probe} exited ${res.status ?? "null"}` +
        `${res.error ? `, ${res.error.message}` : ""}; stderr: ${(res.stderr ?? "").trim()}`;
      if (readLog(tripwire.logPath).length > 0) {
        throw new Error(`${LAUNCHCTL_TRIPWIRE_MESSAGE} (${detail})`);
      }
      const reachedFake = invocations().includes(probe);
      if (res.status !== 0 || !reachedFake) {
        throw new Error(
          `fake-launchctl: the assertShadowed probe did not reach the fake — something else answers ` +
            `launchctl on this PATH (${detail}; probe in fake log: ${reachedFake})`,
        );
      }
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
      tripwire.cleanup();
    },
  };
}
