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
import { accessSync, appendFileSync, chmodSync, constants, lstatSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
    // Fail closed on the append itself: a tripwire that cannot record must say so
    // and exit non-zero, never look like one that recorded (flair#2064).
    `printf '%s argc=%s argv=%s\\n' ${shellQuote(LAUNCHCTL_TRIPWIRE_EVENT)} "$#" "$*" >> ${shellQuote(logPath)} || {`,
    `  printf '%s: could not record this call in %s\\n' ${shellQuote(LAUNCHCTL_TRIPWIRE_MESSAGE)} ${shellQuote(logPath)} >&2`,
    "  exit 1",
    "}",
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

/** Named message for a tripwire log that cannot record calls. */
export const TRIPWIRE_LOG_CANNOT_RECORD = "tripwire log cannot record calls";

/** The log file's identity at setup: the ORIGINAL regular file the handle owns. */
interface LogIdentity {
  dev: number;
  ino: number;
}

function logIdentity(logPath: string): LogIdentity {
  const st = statSync(logPath);
  return { dev: st.dev, ino: st.ino };
}

/**
 * Read a tripwire log, refusing one that cannot record calls (flair#2062/#2064).
 *
 * A readable EMPTY log is NOT taken as "clear". Before accepting it:
 *
 *   (a) `lstat` it and require the ORIGINAL regular file created at setup — the
 *       same dev/inode (a symlink, e.g. to `/dev/null`, has another inode), so a
 *       replaced log is refused rather than read as empty; and
 *   (b) append a unique canary line, read it back, require it, then truncate the
 *       file to empty again — so a log that discards writes (unwritable, or a
 *       symlink that swallows the append) is refused rather than read as empty.
 *
 * Any failure throws {@link TRIPWIRE_LOG_CANNOT_RECORD}; a missing/unreadable log
 * throws the read error. Neither is ever read as "no calls".
 */
function readTripwireLog(logPath: string, identity: LogIdentity): string {
  let st;
  try {
    st = lstatSync(logPath);
  } catch (err) {
    throw new Error(
      `fake-launchctl: cannot read ${logPath} (${(err as Error).message}). The log is created at install, ` +
        `so a missing or unreadable log is a broken harness, not "no calls"`,
    );
  }
  // (a) require the original regular file (not a symlink; same dev/inode).
  if (!st.isFile() || st.isSymbolicLink() || st.dev !== identity.dev || st.ino !== identity.ino) {
    throw new Error(
      `${TRIPWIRE_LOG_CANNOT_RECORD}: cannot read ${logPath} as the original regular file (replaced or symlinked); ` +
        `a call it discarded would read as clear`,
    );
  }
  let content: string;
  try {
    content = readFileSync(logPath, "utf-8");
  } catch (err) {
    throw new Error(
      `fake-launchctl: cannot read ${logPath} (${(err as Error).message}). The log is created at install, ` +
        `so a missing or unreadable log is a broken harness, not "no calls"`,
    );
  }
  if (content.length > 0) return content;
  // (b) canary: append, read back, require, truncate.
  const canary = `__flair_tripwire_canary_${randomUUID()}__`;
  try {
    appendFileSync(logPath, canary + "\n");
  } catch (err) {
    throw new Error(
      `${TRIPWIRE_LOG_CANNOT_RECORD}: ${logPath} discards writes (could not append a canary: ${(err as Error).message})`,
    );
  }
  let back: string;
  try {
    back = readFileSync(logPath, "utf-8");
  } catch (err) {
    throw new Error(
      `fake-launchctl: cannot read ${logPath} (${(err as Error).message}). The log is created at install, ` +
        `so a missing or unreadable log is a broken harness, not "no calls"`,
    );
  }
  if (!back.includes(canary)) {
    throw new Error(`${TRIPWIRE_LOG_CANNOT_RECORD}: ${logPath} discards writes (the canary did not read back)`);
  }
  writeFileSync(logPath, "");
  return "";
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
  const identity = logIdentity(logPath);
  writeFileSync(binPath, tripwireScript(logPath));
  chmodSync(binPath, 0o755);
  return {
    dir,
    binPath,
    logPath,
    tripped: () => logLines(readTripwireLog(logPath, identity)),
    assertClear() {
      const raw = readTripwireLog(logPath, identity);
      if (raw.length > 0) {
        throw new Error(`${LAUNCHCTL_TRIPWIRE_MESSAGE} (reached by: ${JSON.stringify(logLines(raw))})`);
      }
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// ─── the unit-lane service-manager tripwire (flair#2062) ────────────────────
//
// The per-test fake above guards ONE test file. The unit lane itself needs the
// same guard on EVERY step it runs: `launchctl` (darwin) and `systemctl`
// (linux) act on HOST state, and a unit test must not reach a host service
// manager at all. `scripts/test-unit.ts` puts one directory holding both
// shims FIRST on each step's PATH; a test that supplies its own fake prepends
// it, which puts the fake ahead of the tripwire. Same fail-closed shape as the
// launchctl tripwire above: a nonempty log line for every call (a no-argument
// call included), the log path written INTO the script, the log created empty,
// and a read that throws rather than reporting "no calls".
//
// SCOPE (flair#2062): the guard catches a manager command resolved through the
// INHERITED PATH. It does not contain a child that rebuilds PATH (`/usr/bin:/bin`),
// runs under an empty environment (`env -i`), or calls the manager by an
// absolute path — those bypass PATH lookup entirely and are a named follow-up,
// not covered here.
//
// RECORDING IS CHECKED (flair#2062/#2064): before a readable EMPTY log is
// accepted as clear, it must still be the ORIGINAL regular file (same
// dev/inode, not a symlink) and must pass a canary round-trip; a log that
// discards writes or was replaced fails with `tripwire log cannot record calls`.

/** The service-manager binaries the unit-lane tripwire covers. */
export const SERVICE_MANAGER_BINARIES = ["launchctl", "systemctl"] as const;
export type ServiceManagerBinary = (typeof SERVICE_MANAGER_BINARIES)[number];

/**
 * The marker every service-manager tripwire log line starts with. The full line
 * is `${SERVICE_MANAGER_TRIPWIRE_EVENT} <name> argc=<n> argv=<args>`, so a call
 * with no arguments still leaves a nonempty line.
 */
export const SERVICE_MANAGER_TRIPWIRE_EVENT = "service-manager-tripwire-fired";

/**
 * The message the unit-lane tripwire prints, naming the binary invoked. Named so
 * a unit test that reaches a host service manager fails with something an
 * operator can act on, rather than an unexplained non-zero exit.
 */
export function serviceManagerTripwireMessage(name: string): string {
  return (
    `unit lane tripwire: ${name} was invoked by a unit test; ` +
    `a unit test must never reach the host service manager — give the test its own fake`
  );
}

/**
 * The unit-lane tripwire script: records a nonempty event naming itself plus
 * argc/argv, shouts the named message, exits non-zero. Never answers.
 */
function serviceManagerTripwireScript(name: string, logPath: string): string {
  return [
    "#!/bin/sh",
    // Fail closed on the append itself (flair#2064): a tripwire that cannot
    // record must say so and exit non-zero, never look like one that recorded.
    `printf '%s %s argc=%s argv=%s\\n' ${shellQuote(SERVICE_MANAGER_TRIPWIRE_EVENT)} ${shellQuote(name)} "$#" "$*" >> ${shellQuote(logPath)} || {`,
    `  printf '%s: could not record this call in %s\\n' ${shellQuote(serviceManagerTripwireMessage(name))} ${shellQuote(logPath)} >&2`,
    "  exit 1",
    "}",
    `printf '%s: %s\\n' ${shellQuote(serviceManagerTripwireMessage(name))} "$*" >&2`,
    "exit 1",
    "",
  ].join("\n");
}

/**
 * A recording fake for one service manager: logs `<binary> <args>` and exits 0.
 * The `systemctl` fake answers a `show` query with `MainPID=0` and empty
 * `FragmentPath`/`DropInPaths`/`WorkingDirectory` — what a host reports when
 * systemd says the unit has NO MAIN PROCESS. That leaves the serving tree
 * unproven (the same verdict the real host gives when it names a DIFFERENT
 * MainPID), which is all the unit tests rely on. If the log write fails, it
 * says so on stderr and exits 1: a fake that cannot record must not look like a
 * fake that answered.
 */
function serviceManagerFakeScript(name: string, logPath: string): string {
  const lines = [
    "#!/bin/sh",
    `printf '%s %s\\n' ${shellQuote(name)} "$*" >> ${shellQuote(logPath)} || {`,
    `  printf '%s\\n' ${shellQuote(`flair-test-fake-${name}: could not record this call in ${logPath}`)} >&2`,
    "  exit 1",
    "}",
  ];
  if (name === "systemctl") {
    lines.push(
      `case " $* " in`,
      `  *" show "*) printf 'MainPID=0\\nFragmentPath=\\nDropInPaths=\\nWorkingDirectory=\\n';;`,
      "esac",
    );
  }
  lines.push("exit 0", "");
  return lines.join("\n");
}

export interface ServiceManagerTripwire {
  /** Directory holding the tripwire shims. Put this FIRST on each step's PATH. */
  dir: string;
  /** Log of invocations that reached the tripwire. Created empty; must stay empty. */
  logPath: string;
  /** The tripwire executables, by binary name. */
  binPaths: Record<ServiceManagerBinary, string>;
  /** Lines the tripwire logged, oldest first. Throws if the log cannot be read. */
  tripped(): string[];
  /**
   * Read the log, then truncate it, so each caller attributes only the calls
   * that happened since its last read. Throws if the log cannot be read — a
   * missing or unreadable log is a broken harness, never "no calls".
   */
  takeTrips(): string[];
  /** Throw if the log holds anything at all (or cannot be read). */
  assertClear(): void;
  /** Best-effort removal of the scratch directory (tempDir also sweeps). */
  cleanup(): void;
}

/**
 * Install the unit-lane service-manager tripwire: one directory with a
 * `launchctl` and a `systemctl` shim sharing a single log. Put `dir` FIRST on
 * every step's PATH; a test that supplies its own fake prepends it, which puts
 * the fake ahead of this tripwire.
 */
export function installServiceManagerTripwire(prefix = "flair-service-manager-tripwire-"): ServiceManagerTripwire {
  const dir = tempDir(prefix);
  const logPath = join(dir, "tripwire.log");
  writeFileSync(logPath, "");
  const identity = logIdentity(logPath);
  const binPaths = {} as Record<ServiceManagerBinary, string>;
  for (const name of SERVICE_MANAGER_BINARIES) {
    const binPath = join(dir, name);
    writeFileSync(binPath, serviceManagerTripwireScript(name, logPath));
    chmodSync(binPath, 0o755);
    binPaths[name] = binPath;
  }
  return {
    dir,
    logPath,
    binPaths,
    tripped: () => logLines(readTripwireLog(logPath, identity)),
    takeTrips() {
      const lines = logLines(readTripwireLog(logPath, identity));
      if (lines.length) writeFileSync(logPath, "");
      return lines;
    },
    assertClear() {
      const raw = readTripwireLog(logPath, identity);
      if (raw.length > 0) {
        throw new Error(`${SERVICE_MANAGER_TRIPWIRE_EVENT} (reached by: ${JSON.stringify(logLines(raw))})`);
      }
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export interface FakeServiceManager {
  /** Directory holding the fake `launchctl` and `systemctl`. Put this FIRST on PATH. */
  fakeDir: string;
  /** Directory holding the tripwire shims, directly behind the fakes. */
  tripwireDir: string;
  /** `${fakeDir}:${tripwireDir}` — prepend this to a child's PATH. */
  pathEntry: string;
  /** The fakes' shared log: each line is `<binary> <space-joined args>`. Created empty. */
  logPath: string;
  /** Every recorded call across both binaries, oldest first. */
  invocations(): string[];
  /** Lines that reached the tripwire. A test asserts this stays empty. */
  tripped(): string[];
  /** Throw the tripwire message if the tripwire log holds anything at all. */
  assertClear(): void;
  /**
   * Prove the fake (not the tripwire, not the host binary) answers `binary`
   * for the process's own PATH. Throws the tripwire message when the tripwire
   * answered instead.
   */
  assertShadowed(binary?: ServiceManagerBinary): void;
  /** Best-effort removal of the scratch directories (tempDir also sweeps). */
  cleanup(): void;
}

/**
 * A recording fake for BOTH host service managers (flair#2062): a directory
 * holding `launchctl` and `systemctl` that log every call and exit 0 — the
 * `systemctl` fake answers the `show` query with `MainPID=0` and empty fields,
 * i.e. "systemd says this unit has no main process" (which leaves the serving
 * tree unproven, the same verdict the host gives when it names a DIFFERENT
 * MainPID) — plus the fail-closed tripwire behind them, so a call that somehow
 * misses the fake fails loudly instead of reaching the host.
 *
 * Unit tests that reach a service manager through their product code lay this
 * first on PATH. The launchctl half reuses the #2057 fake's contract; the
 * systemctl half answers the query `flair`'s Linux tree assessment and restart
 * plan actually run.
 */
export function installFakeServiceManager(prefix = "flair-fake-service-manager-"): FakeServiceManager {
  const root = tempDir(prefix);
  const fakeDir = join(root, "fake");
  mkdirSync(fakeDir, { recursive: true });
  const logPath = join(root, "fake.log");
  writeFileSync(logPath, "");
  const binPaths = {} as Record<ServiceManagerBinary, string>;
  for (const name of SERVICE_MANAGER_BINARIES) {
    const binPath = join(fakeDir, name);
    writeFileSync(binPath, serviceManagerFakeScript(name, logPath));
    chmodSync(binPath, 0o755);
    binPaths[name] = binPath;
  }
  const tripwire = installServiceManagerTripwire(prefix + "tripwire-");
  const invocations = () => logLines(readLog(logPath));
  return {
    fakeDir,
    tripwireDir: tripwire.dir,
    pathEntry: `${fakeDir}:${tripwire.dir}`,
    logPath,
    invocations,
    tripped: () => tripwire.tripped(),
    assertClear: () => tripwire.assertClear(),
    assertShadowed(binary: ServiceManagerBinary = "launchctl") {
      const probe = `__flair_fake_${binary}_probe_${randomUUID()}__`;
      const probePath = process.env.PATH ?? "";
      // Preflight: the first `binary` on this PATH must be one of THIS helper's
      // own shims (the fake or the tripwire, which never touches the host).
      const first = firstOnPath(binary, probePath);
      if (first !== binPaths[binary] && first !== tripwire.binPaths[binary]) {
        throw new Error(
          `fake-service-manager: the assertShadowed probe did not reach the fake — refusing to spawn it: ` +
            `the first ${binary} on this PATH is ${first ?? "none"}, not this helper's fake (${binPaths[binary]}) or tripwire`,
        );
      }
      const res = spawnSync(binary, [probe], {
        encoding: "utf-8",
        env: { ...process.env, PATH: probePath },
        timeout: 10_000,
      });
      const detail =
        `${binary} ${probe} exited ${res.status ?? "null"}` +
        `${res.error ? `, ${res.error.message}` : ""}; stderr: ${(res.stderr ?? "").trim()}`;
      if (readLog(tripwire.logPath).length > 0) {
        throw new Error(`${SERVICE_MANAGER_TRIPWIRE_EVENT} (${detail})`);
      }
      if (res.status !== 0 || !invocations().includes(`${binary} ${probe}`)) {
        throw new Error(
          `fake-service-manager: the assertShadowed probe did not reach the fake — something else answers ` +
            `${binary} on this PATH (${detail})`,
        );
      }
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
      tripwire.cleanup();
    },
  };
}

export interface FakeLaunchctl {
  /** Directory holding the fake shim. Put this FIRST on PATH. */
  fakeDir: string;  /** Directory holding the tripwire shim. Put this directly AFTER the fake. */
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
/** The first executable file named `name` on a PATH string ("" entries mean the current directory), or null. */
function firstOnPath(name: string, pathValue: string): string | null {
  for (const entry of pathValue.split(":")) {
    const candidate = join(entry === "" ? "." : entry, name);
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

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
      // Preflight: resolve the first `launchctl` on this PATH before spawning anything. The
      // probe runs only one of this helper's own shims: the fake, or the tripwire (which reports
      // the missing fake with its named message and never touches the host). Anything else could
      // be the host's own launchctl, so it is refused without running it.
      const first = firstOnPath("launchctl", probePath);
      if (first !== fakeBin && first !== join(tripwire.dir, "launchctl")) {
        throw new Error(
          `fake-launchctl: the assertShadowed probe did not reach the fake — refusing to spawn it: ` +
            `the first launchctl on this PATH is ${first ?? "none"}, not this helper's fake (${fakeBin}) or tripwire`,
        );
      }
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
