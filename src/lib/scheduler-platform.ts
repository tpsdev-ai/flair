/**
 * Platform-scheduler primitives shared by every Flair-managed background job.
 *
 * Two modules install user-session scheduler entries today:
 *   - src/rem/scheduler.ts        (`flair rem nightly enable`)
 *   - src/federation/scheduler.ts (`flair federation sync enable`)
 *
 * They differ in what they schedule and how often; they do NOT differ in how
 * you ask launchd/systemd whether a job is really loaded, how you read the
 * answer, or how you render a template into a unit file. This module exists so
 * there is exactly ONE implementation of those — same reason src/lib/xml-escape.ts
 * exists (#918): the second copy of a subtle rule is where it goes wrong.
 *
 * `interpretActiveResult()` in particular encodes a production lesson
 * (flair#850) that took a real outage to learn. It must not be re-derived.
 * flair#1231 extended it one layer deeper: a load command exiting 0 proves the
 * service manager ACCEPTED the job, not that the job can RUN — two fleet
 * incidents (a stripped exec bit, a missing log directory) both passed the
 * load check and died on the first real run, invisibly. The rule now encoded
 * in `verifyFirstRun()`: success may not be claimed until the thing the
 * operator asked for has been observed to happen once.
 */
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { resolve, dirname, isAbsolute } from "node:path";
import { platform } from "node:os";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";

export type SchedulerPlatform = "darwin" | "linux";

/**
 * 30s ceiling on launchctl/systemctl invocations so a hung service manager
 * can't block the CLI indefinitely. Sherlock #415 follow-up.
 */
export const SPAWN_TIMEOUT_MS = 30_000;

/**
 * Status-check spawns (launchctl print / systemctl is-active) return
 * near-instantly when the service manager is reachable, and fail fast (no
 * hang) when it isn't (e.g. "Failed to connect to bus"). A short ceiling
 * keeps status commands and the Health endpoint responsive even when the
 * query is inconclusive.
 */
export const STATUS_CHECK_TIMEOUT_MS = 5_000;

export interface SpawnReport {
  code: number | null;
  stdout: string;
  stderr: string;
}

export function detectPlatform(label: string, override?: SchedulerPlatform): SchedulerPlatform {
  if (override) return override;
  const p = platform();
  if (p === "darwin") return "darwin";
  if (p === "linux") return "linux";
  throw new Error(`unsupported platform for ${label}: ${p} (only darwin and linux)`);
}

export function spawnReport(cmd: string[], timeoutMs: number = SPAWN_TIMEOUT_MS): SpawnReport {
  const r: SpawnSyncReturns<Buffer> = spawnSync(cmd[0], cmd.slice(1), {
    encoding: "buffer",
    timeout: timeoutMs,
  });
  return {
    code: r.status,
    stdout: r.stdout?.toString("utf-8") ?? "",
    stderr: r.stderr?.toString("utf-8") ?? "",
  };
}

/**
 * Interprets the result of a `launchctl print` / `systemctl --user is-active`
 * probe. Shared by the sync (CLI) and async (server) callers of both
 * schedulers.
 *
 * - true  — the service manager confirms the job is loaded/active.
 * - false — confirmed NOT active. This includes the "no session bus" case
 *   (flair#850): when `systemctl --user` can't reach a bus, it fails
 *   before printing a status word ("Failed to connect to bus: No medium
 *   found") — but nothing CAN be running without a bus, so `false` is the
 *   honest answer, not "unknown".
 * - null  — genuinely inconclusive (the command itself couldn't run at
 *   all — e.g. the binary is missing — with no output to interpret).
 */
export function interpretActiveResult(
  plat: SchedulerPlatform,
  code: number | null,
  stdout: string,
  stderr: string,
): boolean | null {
  const noOutput = !stdout.trim() && !stderr.trim();
  if (plat === "darwin") {
    if (code === 0) return true;
    if (code === null && noOutput) return null; // spawn itself failed — inconclusive
    return false; // launchctl ran and reported not-loaded
  }
  const out = stdout.trim();
  if (out === "active" || out === "activating") return true;
  if (out === "inactive" || out === "failed" || out === "unknown") return false;
  if (code === null && noOutput) return null; // spawn itself failed — inconclusive
  return false; // covers the no-bus case: empty stdout, nonzero/failed exit
}

/**
 * Human remedy text for a failed scheduler-load attempt (flair#850). Covers
 * the one root cause traced so far: a missing systemd user session bus,
 * which blocks `systemctl --user` entirely in ssh-without-lingering,
 * container, and CI contexts. Returns null when the failure doesn't match a
 * known pattern — the caller already prints the raw stderr, so the operator
 * still has something to go on.
 *
 * `enableCommand` is the caller's own enable invocation, named in the remedy
 * so the operator is told to re-run the command they actually ran.
 */
export function describeLoadFailure(
  plat: SchedulerPlatform,
  loadResult: { code: number | null; stderr: string },
  enableCommand: string,
): string | null {
  const stderr = loadResult.stderr || "";
  if (plat === "linux" && /failed to connect to bus/i.test(stderr)) {
    return (
      "No systemd user session bus is available in this session (common over ssh without lingering, " +
      "in containers, or under CI). Fix: enable lingering for this user — `loginctl enable-linger <user>` " +
      `— then re-run \`${enableCommand}\`.`
    );
  }
  return null;
}

/** Single-pass `{{KEY}}` substitution, with a per-value escape hook. */
export function renderTemplateWith(
  text: string,
  subs: Record<string, string>,
  escape: (value: string) => string,
): string {
  return text.replace(/\{\{([A-Z_]+)\}\}/g, (_, key) => {
    const value = subs[key];
    if (value === undefined) throw new Error(`unknown template placeholder: ${key}`);
    return escape(String(value));
  });
}

export function readTemplate(rootDir: string, relativePath: string): string {
  const full = resolve(rootDir, relativePath);
  if (!existsSync(full)) {
    throw new Error(`template not found: ${full}`);
  }
  return readFileSync(full, "utf-8");
}

export function writeFileWithDir(path: string, contents: string, mode: number = 0o600): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(path, contents, { mode });
}

// ─── node binary resolution (flair#1231) ────────────────────────────────────

/**
 * Resolves the ABSOLUTE path to the node binary at enable time, so the shim
 * can `exec "<node>" "<script>"` with ZERO PATH lookups at run time.
 *
 * Why this exists: the shims switched from `exec "{{FLAIR_BIN}}"` (which
 * required an exec bit that tarball extraction strips — the #1231 regression)
 * to running the CLI under node, which needs read permission only. But a bare
 * `exec node …` would introduce a run-time PATH lookup the old absolute-path
 * form never had: whatever PATH the service manager's environment carries
 * would pick the `node` that runs with the operator's credentials. So the
 * node path is resolved HERE, once, from the enabling process's own
 * environment, and baked into the shim — symmetric with how FLAIR_BIN is
 * already handled.
 *
 * Resolution order:
 *   1. `explicit` — caller/test override.
 *   2. `process.execPath` when the enabling runtime IS node (the published
 *      CLI's case): absolute, known-good, already trusted to run this code.
 *   3. `command -v node` in the enabling shell environment (dev/test under
 *      bun): the one deliberate PATH consultation, made at enable time by the
 *      operator's own session, never later by the service manager.
 * Nothing resolvable ⇒ throw — enable must fail loudly rather than bake a
 * run-time lookup into the shim.
 */
export function resolveNodeBin(explicit?: string): string {
  if (explicit) return explicit;
  if (!process.versions.bun && process.execPath && isAbsolute(process.execPath)) {
    return process.execPath;
  }
  const r = spawnReport(["/bin/sh", "-c", "command -v node"], STATUS_CHECK_TIMEOUT_MS);
  const found = r.stdout.trim().split("\n")[0]?.trim() ?? "";
  if (r.code === 0 && found && isAbsolute(found) && existsSync(found)) return found;
  throw new Error(
    "unable to resolve an absolute path to a node binary (not running under node, and `command -v node` " +
      "found nothing). The scheduler shim runs `<node> <flair-script>` with the node path baked in at " +
      "enable time — refusing to install a shim that would resolve `node` from the service manager's PATH " +
      "at run time. Install node (or put it on PATH for this shell) and re-run enable.",
  );
}

// ─── first-run verification (flair#1231) ────────────────────────────────────
// A load/bootstrap command exiting 0 proves the service manager accepted the
// job — not that the job can run. The only vantage that exercises the real
// failure modes (launchd spawn error 209 from a missing log dir, exit 126
// from a stripped exec bit) is the service manager itself, so the first run
// is triggered and observed THROUGH it, never via a bare spawn of the shim.

/** Poll cadence for darwin `launchctl print` first-run polling. */
export const FIRST_RUN_POLL_INTERVAL_MS = 150;
/** Total budget for first-run verification on both platforms. */
export const FIRST_RUN_BUDGET_MS = 12_000;

export type FirstRunOutcome =
  /** The service manager ran the job once and it exited 0. */
  | "success"
  /** The job ran and exited nonzero (or systemd recorded a failure Result). */
  | "run-failed"
  /** The kickstart/start request itself was rejected by the service manager. */
  | "start-failed"
  /** The run did not complete inside the budget — it may still be running. */
  | "timeout"
  /** launchctl/systemctl could not be consulted at all — CANNOT VERIFY. */
  | "manager-unavailable";

export interface FirstRunVerification {
  /** True ONLY for outcome "success". Everything else withholds the claim. */
  verified: boolean;
  outcome: FirstRunOutcome;
  /** The run's recorded exit status, when one was recorded. */
  exitCode: number | null;
  /** Mechanical detail: which command said what. */
  detail: string;
  /** The stderr log consulted for the failure tail. */
  logPath: string;
  /** Last lines of the log, when the file exists and is non-empty. */
  stderrTail: string;
  /** The log file exists but is EMPTY — the run died before writing. */
  logEmpty: boolean;
  /** Budget the verification ran under (for honest timeout wording). */
  budgetMs: number;
}

/** Injectable process/clock hooks so unit tests never touch a real service manager. */
export interface FirstRunHooks {
  run?: (cmd: string[], timeoutMs: number) => SpawnReport;
  sleep?: (ms: number) => void;
  now?: () => number;
}

/** Synchronous sleep without spawning anything. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Parses `launchctl print <domain>/<label>` for run state. `last exit code`
 * is absent (or "(never exited)") until a run has completed, and `pid =` /
 * `state = running` are present only while one is in flight.
 */
export function parseLaunchdPrintExit(output: string): { running: boolean; lastExitCode: number | null } {
  const running = /^\s*state\s*=\s*(?:running|spawn)/m.test(output) || /^\s*pid\s*=\s*\d+/m.test(output);
  const m = /last exit (?:code|status)\s*=\s*(-?\d+)/.exec(output);
  return { running, lastExitCode: m ? Number(m[1]) : null };
}

/** Parses `systemctl --user show <unit> --property=ExecMainStatus,Result`. */
export function parseSystemdShowExit(output: string): { execMainStatus: number | null; result: string | null } {
  const m = /^ExecMainStatus=(-?\d+)\s*$/m.exec(output);
  const r = /^Result=(\S+)\s*$/m.exec(output);
  return { execMainStatus: m ? Number(m[1]) : null, result: r ? r[1] : null };
}

/** Reads the last lines of a log file for failure diagnostics. Never throws. */
export function readLogTail(path: string, maxLines = 12, maxChars = 1500): { exists: boolean; empty: boolean; tail: string } {
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    return { exists: false, empty: false, tail: "" };
  }
  const trimmed = text.trimEnd();
  if (!trimmed) return { exists: true, empty: true, tail: "" };
  let tail = trimmed.split("\n").slice(-maxLines).join("\n");
  if (tail.length > maxChars) tail = tail.slice(-maxChars);
  return { exists: true, empty: false, tail };
}

/**
 * Names the failure class for a recorded exit status, so the report can lead
 * with actor+state instead of a bare number.
 */
export function describeExitCode(code: number | null): string {
  if (code === null) return "no exit status recorded";
  if (code === 126) return "exit 126 — found but not runnable (permission denied / exec format)";
  if (code === 127) return "exit 127 — command not found";
  if (code === 209) return "exit 209 — launchd could not spawn the job (a missing/unwritable log directory produces this)";
  return `exit ${code}`;
}

export interface VerifyFirstRunOpts {
  plat: SchedulerPlatform;
  /** darwin: the `<domain>/<label>` target for kickstart/print. */
  darwinTarget?: string;
  /** linux: the SERVICE unit (not the timer) to start-and-read. */
  linuxServiceUnit?: string;
  /** The job's stderr log file, consulted for the failure-path tail. */
  stderrLogPath: string;
  pollIntervalMs?: number;
  budgetMs?: number;
  hooks?: FirstRunHooks;
}

function spawnedNothing(r: SpawnReport): boolean {
  return r.code === null && !r.stdout.trim() && !r.stderr.trim();
}

/**
 * Triggers the job's first run through the service manager and reads back how
 * it ended (flair#1231). Call ONLY after the load/bootstrap command exited 0 —
 * a load failure is its own failure mode with its own remedy, and layering a
 * kickstart on top of it would blur which actor failed.
 *
 * darwin: `launchctl kickstart -k` returns immediately (it does NOT block for
 * exit), so the recorded exit status is POLLED out of `launchctl print` until
 * a completed run is visible or the budget lapses. linux: `systemctl --user
 * start` on a oneshot blocks until the run exits, so a single
 * `systemctl --user show` read afterwards suffices.
 *
 * "Can't tell" is its own state: a missing/unreachable service manager yields
 * outcome "manager-unavailable", distinct from "run-failed" — the remedy
 * points at the service manager, not at the job.
 */
export function verifyFirstRun(opts: VerifyFirstRunOpts): FirstRunVerification {
  const run = opts.hooks?.run ?? ((cmd: string[], timeoutMs: number) => spawnReport(cmd, timeoutMs));
  const sleep = opts.hooks?.sleep ?? sleepSync;
  const now = opts.hooks?.now ?? Date.now;
  const pollIntervalMs = opts.pollIntervalMs ?? FIRST_RUN_POLL_INTERVAL_MS;
  const budgetMs = opts.budgetMs ?? FIRST_RUN_BUDGET_MS;

  const finish = (outcome: FirstRunOutcome, exitCode: number | null, detail: string): FirstRunVerification => {
    const log = outcome === "success"
      ? { exists: false, empty: false, tail: "" } // no diagnostics needed on success
      : readLogTail(opts.stderrLogPath);
    return {
      verified: outcome === "success",
      outcome,
      exitCode,
      detail,
      logPath: opts.stderrLogPath,
      stderrTail: log.tail,
      logEmpty: log.exists && log.empty,
      budgetMs,
    };
  };

  if (opts.plat === "darwin") {
    const target = opts.darwinTarget;
    if (!target) throw new Error("verifyFirstRun: darwinTarget is required on darwin");
    const kickCmd = ["launchctl", "kickstart", "-k", target];
    const kick = run(kickCmd, SPAWN_TIMEOUT_MS);
    if (spawnedNothing(kick)) {
      return finish("manager-unavailable", null, `launchctl could not be run (${kickCmd.join(" ")})`);
    }
    if (kick.code !== 0) {
      return finish("start-failed", null, `${kickCmd.join(" ")} → code ${kick.code}${kick.stderr.trim() ? `: ${kick.stderr.trim()}` : ""}`);
    }
    const deadline = now() + budgetMs;
    // Poll: kickstart returned immediately, so watch `launchctl print` until a
    // COMPLETED run (not running + a recorded exit code) is visible.
    for (;;) {
      const printCmd = ["launchctl", "print", target];
      const r = run(printCmd, STATUS_CHECK_TIMEOUT_MS);
      if (spawnedNothing(r)) {
        return finish("manager-unavailable", null, `launchctl could not be run (${printCmd.join(" ")})`);
      }
      if (r.code === 0) {
        const { running, lastExitCode } = parseLaunchdPrintExit(r.stdout);
        if (!running && lastExitCode !== null) {
          return lastExitCode === 0
            ? finish("success", 0, `${printCmd.join(" ")} → last exit code = 0`)
            : finish("run-failed", lastExitCode, `${printCmd.join(" ")} → last exit code = ${lastExitCode}`);
        }
      }
      if (now() >= deadline) {
        return finish("timeout", null, `no completed run visible in ${printCmd.join(" ")} within ${Math.round(budgetMs / 1000)}s`);
      }
      sleep(pollIntervalMs);
    }
  }

  // linux
  const unit = opts.linuxServiceUnit;
  if (!unit) throw new Error("verifyFirstRun: linuxServiceUnit is required on linux");
  const startCmd = ["systemctl", "--user", "start", unit];
  const start = run(startCmd, budgetMs);
  if (spawnedNothing(start)) {
    return finish("manager-unavailable", null, `systemctl could not be run (${startCmd.join(" ")})`);
  }
  if (/failed to connect to bus/i.test(start.stderr)) {
    return finish("manager-unavailable", null, `${startCmd.join(" ")} → ${start.stderr.trim()}`);
  }
  if (start.code === null) {
    return finish("timeout", null, `${startCmd.join(" ")} did not return within ${Math.round(budgetMs / 1000)}s`);
  }
  const showCmd = ["systemctl", "--user", "show", unit, "--property=ExecMainStatus,Result"];
  const show = run(showCmd, STATUS_CHECK_TIMEOUT_MS);
  const parsed = parseSystemdShowExit(show.stdout);
  if (start.code === 0) {
    // A blocking start of a oneshot exits 0 only when the run succeeded; the
    // show read supplies the recorded status for the report.
    return finish("success", parsed.execMainStatus ?? 0, `${startCmd.join(" ")} → ok`);
  }
  const resultTxt = parsed.result ? `, Result=${parsed.result}` : "";
  return finish(
    "run-failed",
    parsed.execMainStatus,
    `${startCmd.join(" ")} → code ${start.code}${resultTxt}${start.stderr.trim() ? `: ${start.stderr.trim()}` : ""}`,
  );
}
