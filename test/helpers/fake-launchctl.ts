/**
 * fake-launchctl.ts — a `launchctl` that a unit test can put on PATH, plus a
 * tripwire that fails the test if anything reaches a launchctl that is NOT the
 * fake (flair#2057).
 *
 * Why: `launchctl` acts on the caller's per-user GUI launchd domain, which is
 * host state, not fixture state. A unit test that drives a darwin launchd code
 * path without a fake on PATH therefore makes REAL read-only `launchctl list` /
 * `launchctl print` / `launchctl print-disabled` calls against the developer's
 * own session. They only read — but a unit test must not talk to the host's
 * service manager at all, and once a path stops being read-only (`bootstrap`,
 * `bootout`, `kickstart`) the same gap stops being harmless.
 *
 * Two pieces, both reusable:
 *
 *   - `installFakeLaunchctl()` — the recording shim the command-level launchd
 *     tests already write inline (records argv, exits 0), plus the tripwire,
 *     pre-arranged so `${pathEntry}:<real PATH>` is the correct PATH order.
 *   - `installLaunchctlTripwire()` — just the tripwire, for a test that already
 *     has its own fake and only needs the guard.
 *
 * The tripwire is a second `launchctl` placed on PATH BEHIND the fake, ahead of
 * the real binary: if the fake is ever missing from PATH, the invocation lands
 * on the tripwire, which prints `LAUNCHCTL_TRIPWIRE_MESSAGE` and exits non-zero
 * instead of silently touching the host. `assertShadowed()` proves the fake
 * really is first — which is also what makes the tripwire mutation-testable:
 * drop the fake and the check throws the tripwire's message rather than passing
 * silently.
 *
 * Scratch directories come from `tempDir`, so their removal is registered with
 * the process-global unit-lane sweep.
 */

import { spawnSync } from "node:child_process";
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

/** Records argv and exits 0 — the shim the command-level launchd tests use. */
const FAKE_SCRIPT = [
  "#!/bin/sh",
  'printf "%s\\n" "$*" >> "$FAKE_LAUNCHCTL_LOG"',
  "exit 0",
  "",
].join("\n");

/** Records argv, shouts the named message, exits non-zero. Never answers. */
const TRIPWIRE_SCRIPT = [
  "#!/bin/sh",
  'printf "%s\\n" "$*" >> "$FAKE_LAUNCHCTL_TRIPWIRE_LOG"',
  `printf "%s\\n" "${LAUNCHCTL_TRIPWIRE_MESSAGE}: $*" >&2`,
  "exit 1",
  "",
].join("\n");

function readLines(path: string): string[] {
  try {
    return readFileSync(path, "utf-8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

export interface LaunchctlTripwire {
  /** Directory holding the tripwire shim. Put this directly after the fake. */
  dir: string;
  /** The tripwire executable (`dir/launchctl`). */
  binPath: string;
  /** Log of invocations that reached the tripwire. Must stay empty. */
  logPath: string;
  /** Env a child needs so the tripwire can record. */
  env: Record<string, string>;
  /** argv lines that reached the tripwire, oldest first. */
  tripped(): string[];
  /** Throw `LAUNCHCTL_TRIPWIRE_MESSAGE` if the tripwire has fired. */
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
  writeFileSync(binPath, TRIPWIRE_SCRIPT);
  chmodSync(binPath, 0o755);
  const tripwire: LaunchctlTripwire = {
    dir,
    binPath,
    logPath,
    env: { FAKE_LAUNCHCTL_TRIPWIRE_LOG: logPath },
    tripped: () => readLines(logPath),
    assertClear() {
      const fired = this.tripped();
      if (fired.length > 0) {
        throw new Error(`${LAUNCHCTL_TRIPWIRE_MESSAGE} (reached by: ${fired.join(" | ")})`);
      }
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return tripwire;
}

export interface FakeLaunchctl {
  /** Directory holding the fake shim. Put this FIRST on PATH. */
  fakeDir: string;
  /** Directory holding the tripwire shim. Put this directly AFTER the fake. */
  tripwireDir: string;
  /** `${fakeDir}:${tripwireDir}` — prepend this to a child's PATH. */
  pathEntry: string;
  /** Env a child needs so both shims can record (fake log + tripwire log). */
  env: Record<string, string>;
  /** argv lines the fake recorded, oldest first. */
  invocations(): string[];
  /** argv lines that reached the tripwire. A test asserts this stays empty. */
  tripped(): string[];
  /**
   * Prove the fake, not the tripwire and not the host binary, answers
   * `launchctl` for `path` (defaults to the process's own `PATH`, which the
   * caller is expected to have laid the fake onto first). Throws
   * `LAUNCHCTL_TRIPWIRE_MESSAGE` when the tripwire answered instead.
   */
  assertShadowed(path?: string): void;
  /** Best-effort removal of the scratch directories (tempDir also sweeps). */
  cleanup(): void;
}

/**
 * Install the fake and the tripwire together. Call from a `beforeEach` (each
 * test gets a fresh pair), lay `pathEntry` on the PATH of every subprocess the
 * test spawns AND on the process's own `process.env.PATH` when the CLI runs
 * in-process, then call `assertShadowed()`.
 */
export function installFakeLaunchctl(prefix = "flair-fake-launchctl-"): FakeLaunchctl {
  const root = tempDir(prefix);
  const fakeDir = join(root, "fake");
  mkdirSync(fakeDir, { recursive: true });
  const fakeLog = join(root, "fake.log");
  const fakeBin = join(fakeDir, "launchctl");
  writeFileSync(fakeBin, FAKE_SCRIPT);
  chmodSync(fakeBin, 0o755);
  const tripwire = installLaunchctlTripwire(prefix + "tripwire-");

  const env = { FAKE_LAUNCHCTL_LOG: fakeLog, ...tripwire.env };
  const pathEntry = `${fakeDir}:${tripwire.dir}`;

  return {
    fakeDir,
    tripwireDir: tripwire.dir,
    pathEntry,
    env,
    invocations: () => readLines(fakeLog),
    tripped: () => tripwire.tripped(),
    assertShadowed(path?: string) {
      const probe = "__flair_fake_launchctl_selftest__";
      const probePath = path ?? process.env.PATH ?? "";
      const res = spawnSync("launchctl", [probe], {
        encoding: "utf-8",
        env: { ...process.env, ...env, PATH: probePath },
        timeout: 10_000,
      });
      const fired = tripwire.tripped();
      if (fired.length > 0 || res.status !== 0) {
        throw new Error(
          `${LAUNCHCTL_TRIPWIRE_MESSAGE} (launchctl ${probe} exited ${res.status ?? "null"}` +
            `${res.error ? `, ${res.error.message}` : ""}; stderr: ${(res.stderr ?? "").trim()})`,
        );
      }
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
      tripwire.cleanup();
    },
  };
}
