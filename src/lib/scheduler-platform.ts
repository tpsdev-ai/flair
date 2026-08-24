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
import { existsSync, mkdirSync, writeFileSync, readFileSync, realpathSync } from "node:fs";
import { resolve, dirname, isAbsolute, basename } from "node:path";
import { platform, userInfo } from "node:os";
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
 * Session facts used to pick the right "no user bus" remedy (flair#1107).
 * Passing them keeps `describeLoadFailure` a pure function of its inputs —
 * formatEnableReport / tests inject linger state so they never spawn
 * loginctl, and the CLI probes once on the real failure path.
 */
export interface UserBusSessionFacts {
  /**
   * Whether lingering is already on for this user.
   * true  — do not print `loginctl enable-linger` (the operator already ran it).
   * false — lingering is off; the linger remedy is still the right first step.
   * omitted/null — unknown; keep the linger remedy (do not invent linger-on).
   */
  lingerEnabled?: boolean | null;
  /** Session environment used to detect a missing user-bus env. */
  env?: NodeJS.Dict<string>;
}

/** True when this session already has the env `systemctl --user` needs. */
export function sessionHasUserBusEnv(env: NodeJS.Dict<string> = process.env): boolean {
  return Boolean(env.XDG_RUNTIME_DIR?.trim() && env.DBUS_SESSION_BUS_ADDRESS?.trim());
}

/**
 * Reads whether lingering is already enabled for the current user.
 * `loginctl show-user … Linger=yes` is the official answer; the stamp file
 * `loginctl enable-linger` creates is the fallback when loginctl is missing
 * or inconclusive. A failed probe is `null`, never linger-off — inventing
 * linger-off would repeat the linger remedy after it already ran (#1107).
 */
export function probeUserLingerEnabled(opts: {
  run?: (cmd: string[], timeoutMs: number) => SpawnReport;
  lingerStampExists?: (user: string) => boolean;
} = {}): boolean | null {
  const run = opts.run ?? spawnReport;
  const lingerStampExists = opts.lingerStampExists ?? ((u) => existsSync(`/var/lib/systemd/linger/${u}`));
  let user = "";
  try {
    user = userInfo().username;
  } catch {
    user = process.env.USER || process.env.LOGNAME || "";
  }
  if (!user) return null;
  const r = run(["loginctl", "show-user", user, "--property=Linger"], STATUS_CHECK_TIMEOUT_MS);
  const m = /^Linger=(yes|no)\s*$/m.exec(r.stdout ?? "");
  if (m) return m[1] === "yes";
  if (lingerStampExists(user)) return true;
  return null;
}

/**
 * Human remedy text for a failed scheduler-load attempt (flair#850, #1107).
 * Covers the traced "no systemd user session bus" failure, which blocks
 * `systemctl --user` entirely in ssh-without-lingering, container, and CI
 * contexts. Two cases that used to share one remedy:
 *   (a) lingering genuinely off — print `loginctl enable-linger`
 *   (b) linger already on, this session has no user-bus env — print the
 *       `XDG_RUNTIME_DIR` / `DBUS_SESSION_BUS_ADDRESS` export lines
 * Repeating (a) after the operator has applied it is the #1107 lie.
 * Returns null when the failure doesn't match a known pattern — the caller
 * already prints the raw stderr, so the operator still has something to go on.
 *
 * `enableCommand` is the caller's own enable invocation, named in the remedy
 * so the operator is told to re-run the command they actually ran.
 */
export function describeLoadFailure(
  plat: SchedulerPlatform,
  loadResult: { code: number | null; stderr: string },
  enableCommand: string,
  session?: UserBusSessionFacts,
): string | null {
  const stderr = loadResult.stderr || "";
  if (plat === "linux" && /failed to connect to bus/i.test(stderr)) {
    if (session?.lingerEnabled === true) {
      const env = session.env ?? process.env;
      if (!sessionHasUserBusEnv(env)) {
        return (
          "No systemd user session bus is available in this session. Lingering is already enabled — " +
          "do not re-run `loginctl enable-linger`. The remaining gap is this session's user-bus environment. " +
          "Export:\n" +
          "     export XDG_RUNTIME_DIR=/run/user/$(id -u)\n" +
          "     export DBUS_SESSION_BUS_ADDRESS=unix:path=$XDG_RUNTIME_DIR/bus\n" +
          `   then re-run \`${enableCommand}\`.`
        );
      }
      return (
        "No systemd user session bus is available in this session. Lingering is already enabled and " +
        "this session already has XDG_RUNTIME_DIR / DBUS_SESSION_BUS_ADDRESS — " +
        "do not re-run `loginctl enable-linger` or re-export those variables. " +
        "Check that `$XDG_RUNTIME_DIR/bus` exists (the systemd --user instance may not be running), " +
        `then re-run \`${enableCommand}\`.`
      );
    }
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

// ─── flair-bin capture (flair#1279) ─────────────────────────────────────────
// FLAIR_BIN is still captured at enable time and baked into the shim — #1231
// forbids a run-time PATH lookup of either node or flair. The hazard that
// remains is WHAT gets captured: `process.argv[1]` is whatever launched
// enable, so `node dist/cli.js` during a debug session (or a versioned
// blue/green tree) becomes the unit's permanent exec target and silently
// strands it when that path goes away.
//
// This module does not rewrite the shim and does not substitute a different
// binary. It (1) resolves a relative capture to an absolute path so the
// service manager's cwd cannot reinterpret it, and (2) tells enable to warn
// when the baked path is not the stable public `flair` entry. Fleet tar-swap
// deploys that run `node ~/agents/flair/dist/cli.js` keep working; they just
// hear about the swap risk instead of discovering it after the unit dies.

export interface FlairBinResolution {
  /** Absolute path baked into the shim as FLAIR_BIN. */
  path: string;
  /**
   * True when `path` is the stable public entry: a file named `flair`, or
   * the same file as `command -v flair`. Everything else (a working-tree
   * `dist/cli.js`, a versioned install root) is a capture of the enabling
   * process, not a public entry.
   */
  canonical: boolean;
  /** Absolute `command -v flair` when one was found; null otherwise. */
  publicBin: string | null;
}

export interface ResolveFlairBinHooks {
  /** Test override for `process.argv[1]` when no explicit path is passed. */
  argv1?: string;
  /**
   * Test override for the public `flair` lookup. `undefined` means "do the
   * real `command -v flair`"; `null` means "there is no public entry".
   */
  publicBin?: string | null;
}

/**
 * Resolves the path enable will bake as FLAIR_BIN, and whether that path is
 * the stable public `flair` entry (flair#1279).
 *
 * Resolution order:
 *   1. `explicit` — caller/test override. Relatives are resolved against cwd.
 *   2. `hooks.argv1` / `process.argv[1]` — whatever launched enable.
 *   3. The public `flair` on PATH, only when (1) and (2) are empty.
 * Nothing absolute resolvable ⇒ throw. A bare `"flair"` is not an exec
 * target under #1231's `exec <node> <script>` form (`node flair` looks in
 * cwd, not PATH).
 */
export function resolveFlairBin(explicit?: string, hooks?: ResolveFlairBinHooks): FlairBinResolution {
  const publicBin = hooks && "publicBin" in hooks ? (hooks.publicBin ?? null) : lookupPublicFlairBin();
  const captured = explicit ?? hooks?.argv1 ?? process.argv[1];

  let path: string;
  if (typeof captured === "string" && captured.length > 0) {
    path = isAbsolute(captured) ? captured : resolve(captured);
  } else if (publicBin) {
    path = publicBin;
  } else {
    throw new Error(
      "unable to resolve an absolute path to the flair CLI (process.argv[1] was empty and `command -v flair` " +
        "found nothing). The scheduler shim bakes this path in at enable time — refusing to install a shim " +
        "whose exec target is unknown. Re-run enable via the `flair` command.",
    );
  }

  return { path, publicBin, canonical: isCanonicalFlairBin(path, publicBin) };
}

/** True when `baked` is the public `flair` entry, not a working-tree capture. */
export function isCanonicalFlairBin(baked: string, publicBin: string | null): boolean {
  if (basename(baked) === "flair") return true;
  if (publicBin && pathsReferToSameFile(baked, publicBin)) return true;
  return false;
}

/**
 * The enable-report lines for a non-canonical FLAIR_BIN. Empty when the
 * baked path is the public entry — callers should not print a warning then.
 */
export function formatFlairBinWarning(baked: string, publicBin: string | null, enableCommand: string): string[] {
  if (isCanonicalFlairBin(baked, publicBin)) return [];
  const lines = [
    `⚠️  FLAIR_BIN is ${baked} — that is the process that ran enable, not a stable public entry.`,
    `   A later blue/green directory swap, or deleting this working tree, will strand the scheduler unit.`,
  ];
  if (publicBin) {
    lines.push(
      `   Public \`flair\` on PATH: ${publicBin}. Re-run \`${enableCommand}\` as the \`flair\` command to bake that path instead.`,
    );
  } else {
    lines.push(
      `   No \`flair\` on PATH. Re-run \`${enableCommand}\` via the installed \`flair\` command (or a stable symlink) so the baked path survives a tree swap.`,
    );
  }
  return lines;
}

function lookupPublicFlairBin(): string | null {
  const r = spawnReport(["/bin/sh", "-c", "command -v flair"], STATUS_CHECK_TIMEOUT_MS);
  const found = r.stdout.trim().split("\n")[0]?.trim() ?? "";
  if (r.code === 0 && found && isAbsolute(found) && existsSync(found)) return found;
  return null;
}

function pathsReferToSameFile(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return resolve(a) === resolve(b);
  }
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

// ─── last-run exit-status query (flair#1278) ────────────────────────────────
// `verifyFirstRun` above answers "did the first run work?" at ENABLE time;
// this answers "how did the most recent run end?" at DIAGNOSIS time (`flair
// doctor`), reusing the same #1282 parsers so the two can never drift on how
// a service manager's answer is read. Neither #1231 fleet incident (launchd
// spawn error 209 from a missing log dir, exit 126 from a stripped exec bit)
// was visible in doctor — driver health only surfaced in `flair federation
// sync status` / `flair rem nightly status`, commands an operator has to
// think to run.

export type LastExitState =
  /** A completed run's exit status was read back (see `exitCode`). */
  | "recorded"
  /** A run is in flight right now — no completed status to read yet. */
  | "running"
  /** The service manager answered, but has no completed run on record. */
  | "never-ran"
  /** The service manager could not be consulted, or its answer was unreadable. */
  | "unavailable";

export interface LastExitStatus {
  state: LastExitState;
  /** The recorded exit code. Non-null exactly when `state` is "recorded". */
  exitCode: number | null;
  /** Mechanical detail: which command said what. */
  detail: string;
}

export interface QueryLastExitOpts {
  plat: SchedulerPlatform;
  /** darwin: the `<domain>/<label>` target for `launchctl print`. */
  darwinTarget?: string;
  /** linux: the SERVICE unit (not the timer) whose last run is read. */
  linuxServiceUnit?: string;
  /** Injectable process hook so unit tests never touch a real service manager. */
  run?: (cmd: string[], timeoutMs: number) => SpawnReport;
}

/**
 * Reads how the job's most recent run ended, from the only vantage that
 * knows: the service manager itself.
 *
 * darwin: `launchctl print` carries `last exit code = N` once a run has
 * completed (parseLaunchdPrintExit). linux: `systemctl --user show` on the
 * service unit — with one trap encoded here rather than in every caller: a
 * unit that has NEVER completed a run still reports `ExecMainStatus=0,
 * Result=success` (systemd property defaults), so the exit properties are
 * only believed when `ExecMainExitTimestampMonotonic` proves a run actually
 * finished. Without that check, "never ran" renders as "last run succeeded"
 * — the exact skipped-check-looks-like-a-pass shape this feature exists to
 * kill.
 */
export function queryLastExitStatus(opts: QueryLastExitOpts): LastExitStatus {
  const run = opts.run ?? ((cmd: string[], timeoutMs: number) => spawnReport(cmd, timeoutMs));

  if (opts.plat === "darwin") {
    const target = opts.darwinTarget;
    if (!target) throw new Error("queryLastExitStatus: darwinTarget is required on darwin");
    const printCmd = ["launchctl", "print", target];
    const r = run(printCmd, STATUS_CHECK_TIMEOUT_MS);
    if (spawnedNothing(r)) {
      return { state: "unavailable", exitCode: null, detail: `launchctl could not be run (${printCmd.join(" ")})` };
    }
    if (r.code !== 0) {
      return { state: "unavailable", exitCode: null, detail: `${printCmd.join(" ")} → code ${r.code} (job not loaded — no run record to read)` };
    }
    const { running, lastExitCode } = parseLaunchdPrintExit(r.stdout);
    if (running) {
      return { state: "running", exitCode: null, detail: `${printCmd.join(" ")} → a run is in flight` };
    }
    if (lastExitCode === null) {
      return { state: "never-ran", exitCode: null, detail: `${printCmd.join(" ")} → no completed run recorded` };
    }
    return { state: "recorded", exitCode: lastExitCode, detail: `${printCmd.join(" ")} → last exit code = ${lastExitCode}` };
  }

  const unit = opts.linuxServiceUnit;
  if (!unit) throw new Error("queryLastExitStatus: linuxServiceUnit is required on linux");
  const showCmd = ["systemctl", "--user", "show", unit, "--property=ExecMainStatus,Result,ExecMainExitTimestampMonotonic"];
  const r = run(showCmd, STATUS_CHECK_TIMEOUT_MS);
  if (spawnedNothing(r)) {
    return { state: "unavailable", exitCode: null, detail: `systemctl could not be run (${showCmd.join(" ")})` };
  }
  if (/failed to connect to bus/i.test(r.stderr)) {
    return { state: "unavailable", exitCode: null, detail: `${showCmd.join(" ")} → ${r.stderr.trim()}` };
  }
  if (r.code !== 0) {
    return { state: "unavailable", exitCode: null, detail: `${showCmd.join(" ")} → code ${r.code}${r.stderr.trim() ? `: ${r.stderr.trim()}` : ""}` };
  }
  // Believe the exit properties only when a run has actually finished — see
  // the doc comment above for why this must be checked FIRST.
  const ts = /^ExecMainExitTimestampMonotonic=(\d+)\s*$/m.exec(r.stdout);
  if (ts && Number(ts[1]) === 0) {
    return { state: "never-ran", exitCode: null, detail: `${showCmd.join(" ")} → no completed run recorded` };
  }
  const parsed = parseSystemdShowExit(r.stdout);
  if (parsed.execMainStatus === null) {
    return { state: "unavailable", exitCode: null, detail: `${showCmd.join(" ")} → no ExecMainStatus in the reply` };
  }
  const resultTxt = parsed.result ? `, Result=${parsed.result}` : "";
  return {
    state: "recorded",
    exitCode: parsed.execMainStatus,
    detail: `${showCmd.join(" ")} → ExecMainStatus=${parsed.execMainStatus}${resultTxt}`,
  };
}

// ─── doctor finding for one scheduled driver (flair#1278) ───────────────────

export interface ScheduledDriverFacts {
  /** Human name, e.g. "Federation sync driver". */
  label: string;
  /** The command that enables this scheduler — named in remedies. */
  enableCommand: string;
  /** The scheduler's own status command — named in remedies. */
  statusCommand: string;
  /** Unit files present on disk (schedulerStatus().installed). */
  installed: boolean;
  /** Genuinely loaded per the service manager; null = query inconclusive. */
  active: boolean | null;
  /** Last-run read — null when it was not queried (nothing installed/loaded). */
  lastExit: LastExitStatus | null;
  /** The job's stderr log, named in the degraded remedy. */
  stderrLogPath: string;
}

export type ScheduledDriverFindingState = "healthy" | "degraded" | "not-enabled" | "unverified";

export interface ScheduledDriverFinding {
  state: ScheduledDriverFindingState;
  /**
   * Which doctor marker to render: "ok" is the pass marker, "error" the fail
   * marker. "info"/"warn" are NEITHER — the not-enabled and unverified states
   * must be visually distinct from both a pass and a failure.
   */
  icon: "ok" | "warn" | "error" | "info";
  /** true → doctor counts an issue and exits nonzero. */
  isIssue: boolean;
  message: string;
  /** Indented continuation lines (actor+state+remedy when degraded). */
  detail: string[];
}

/**
 * Pure decision logic for `flair doctor`'s "Scheduled drivers" section
 * (flair#1278) — extracted so it is unit-testable without spawning
 * launchctl/systemctl, same idiom as formatEnableReport/assessDriver in the
 * scheduler modules and summarizeDoctorRun in the CLI.
 *
 * The three load-bearing rules:
 *   - not-enabled is a CHOICE, not a defect: informational marker, never the
 *     pass marker, never the fail marker, never an issue (a skipped check
 *     must not look like a pass — flair#970's rule applied to schedulers).
 *   - a last-run failure IS a defect, reported loud with actor+state+remedy
 *     (embed-verify style): the service manager is firing the job, the runs
 *     themselves are dying, so the schedule looks alive while nothing is
 *     delivered — the #1231 incident shape.
 *   - "could not read" is UNVERIFIED, never a pass and never a hard failure
 *     — the same discipline as doctor's audit-log and embeddings probes.
 */
export function describeScheduledDriverFinding(f: ScheduledDriverFacts): ScheduledDriverFinding {
  if (!f.installed) {
    return {
      state: "not-enabled",
      icon: "info",
      isIssue: false,
      message: `${f.label}: not enabled`,
      detail: [`Opt-in — enable: ${f.enableCommand}`],
    };
  }
  if (f.active === false) {
    return {
      state: "degraded",
      icon: "error",
      isIssue: true,
      message: `${f.label}: INSTALLED BUT NOT LOADED — nothing will run it`,
      detail: [
        `The unit files are on disk, but the service manager does not have the job loaded, so it never fires.`,
        `Fix: ${f.enableCommand}   # then check: ${f.statusCommand}`,
      ],
    };
  }
  if (f.active === null) {
    return {
      state: "unverified",
      icon: "warn",
      isIssue: false,
      message: `${f.label}: UNVERIFIED — installed, but whether it is loaded could not be read`,
      detail: [`Querying the service manager was inconclusive. Check: ${f.statusCommand}`],
    };
  }
  // Loaded from here down.
  const le = f.lastExit;
  if (!le || le.state === "unavailable") {
    return {
      state: "unverified",
      icon: "warn",
      isIssue: false,
      message: `${f.label}: loaded, but its last-run status could not be read`,
      detail: [...(le ? [le.detail] : []), `Check: ${f.statusCommand}`],
    };
  }
  if (le.state === "recorded" && le.exitCode !== 0) {
    return {
      state: "degraded",
      icon: "error",
      isIssue: true,
      message: `${f.label} DEGRADED — loaded, but its last run failed (${describeExitCode(le.exitCode)})`,
      detail: [
        `The service manager has the job loaded and is firing it; the runs themselves are failing, so the schedule looks alive while nothing is delivered.`,
        `Check ${f.stderrLogPath}, then: ${f.statusCommand}`,
      ],
    };
  }
  if (le.state === "running") {
    return { state: "healthy", icon: "ok", isIssue: false, message: `${f.label}: loaded (a run is in flight now)`, detail: [] };
  }
  if (le.state === "never-ran") {
    return {
      state: "healthy",
      icon: "ok",
      isIssue: false,
      message: `${f.label}: loaded (no completed run on record yet)`,
      detail: [`Installed and loaded; the service manager has not recorded a completed run since it last (re)loaded the job.`],
    };
  }
  return { state: "healthy", icon: "ok", isIssue: false, message: `${f.label}: loaded (last run: exit 0)`, detail: [] };
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
