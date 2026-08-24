/**
 * Federation sync driver — platform-native scheduler install/uninstall.
 *
 * Backs `flair federation sync enable|disable|status`. Mirrors
 * src/rem/scheduler.ts (`flair rem nightly enable`) in structure, verbs and
 * platform handling; the shared launchd/systemd primitives live in
 * src/lib/scheduler-platform.ts so flair#850's active-state lesson has one
 * implementation.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 * Federation had no automatic driver. `flair federation sync` is one-shot and
 * `flair federation watch` is a foreground loop that dies with its terminal,
 * so a freshly paired spoke syncs exactly once and then never again — which
 * presents as a broken pairing rather than as a missing scheduler.
 *
 * ── Why a periodic one-shot, not a supervised watcher ──────────────────────
 * Both shapes were built by hand on our own hub (one launchd job wrapping the
 * watch loop with KeepAlive/SuccessfulExit=false, one running one-shot sync on
 * StartInterval=900) and neither was ever shipped. This module ships exactly
 * one of them: the periodic one-shot. The argument is not aesthetic:
 *
 *   1. The watch loop carries NO state across iterations. It is literally
 *      `while (!stopped) { await runFederationSyncOnce(opts); sleep(interval) }`
 *      — every cycle re-reads the peer list, re-loads the instance key and
 *      opens fresh HTTP connections. A long-lived process is worth its cost
 *      when it holds warm state or a persistent connection. This one holds
 *      neither, so supervision buys only the ~300ms of process startup a
 *      one-shot pays per cycle — at a 300s interval, a 0.1% duty cycle.
 *
 *   2. A supervised watcher's worst failure is invisible. KeepAlive restarts a
 *      process that EXITS; it does nothing for one that HANGS. A hung watcher
 *      stops syncing forever while `launchctl list` still shows it happily
 *      running — the exact "looks fine, is dead" shape supervision was
 *      supposed to remove. Every network call inside runFederationSyncOnce is
 *      bounded by an AbortSignal.timeout (10s ops, 15s query, 45s per batch),
 *      so a one-shot always terminates and the scheduler always gets to start
 *      the next one.
 *
 *   3. Crash safety is free. The sync cursor (peer.lastSyncAt) only advances
 *      after a successful push, and the hub merges by id, so an interrupted
 *      run re-sends rather than losing records. There is no partial-failure
 *      state for a supervisor to reason about.
 *
 * The cost is latency, and latency is the knob: --interval, default 300s.
 * (Not 30s like `federation watch`: a scheduler-spawned process per cycle
 * makes very short intervals mostly process startup. Not 900s like the
 * hand-built job either — five minutes is a defensible upper bound on how
 * stale a spoke should look on the hub dashboard.)
 *
 * `federation watch` is NOT removed — it is still the right tool for an
 * interactive "watch it sync while I debug this" session. It is simply no
 * longer the answer to "how do I keep this synced".
 *
 * ── Secrets ────────────────────────────────────────────────────────────────
 * The scheduler unit NEVER contains a password. It carries
 * FLAIR_ADMIN_PASS_FILE — a PATH — and the shim passes that path to
 * `flair federation sync --admin-pass-file`, which reads it through
 * readAdminPassFileSecure() and refuses a file that is not owner-only.
 */
import { existsSync, chmodSync, rmSync, readFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { escapeXml } from "../lib/xml-escape.js";
import {
  type SchedulerPlatform,
  type FirstRunVerification,
  detectPlatform as detectPlatformFor,
  spawnReport,
  readTemplate,
  renderTemplateWith,
  writeFileWithDir,
  interpretActiveResult,
  describeLoadFailure as describeLoadFailureFor,
  describeExitCode,
  resolveNodeBin,
  resolveFlairBin,
  formatFlairBinWarning,
  verifyFirstRun,
  STATUS_CHECK_TIMEOUT_MS,
} from "../lib/scheduler-platform.js";

export type { SchedulerPlatform };

export const LAUNCHD_LABEL = "dev.flair.federation.sync";
export const SYSTEMD_TIMER_UNIT = "flair-federation-sync.timer";
export const SYSTEMD_SERVICE_UNIT = "flair-federation-sync.service";

export const SHIM_PATH_DEFAULT = resolve(homedir(), ".flair", "bin", "flair-federation-sync");
export const LAUNCHD_PLIST_PATH = resolve(homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
export const SYSTEMD_USER_DIR = resolve(homedir(), ".config", "systemd", "user");
export const SYSTEMD_TIMER_PATH = resolve(SYSTEMD_USER_DIR, SYSTEMD_TIMER_UNIT);
export const SYSTEMD_SERVICE_PATH = resolve(SYSTEMD_USER_DIR, SYSTEMD_SERVICE_UNIT);

/** Default seconds between one-shot syncs. See the module header for why 300. */
export const DEFAULT_INTERVAL_SECONDS = 300;

/**
 * Floor on --interval. Below a minute the per-cycle process startup starts to
 * dominate the actual work, and systemd's default timer accuracy is a minute
 * anyway — a smaller number would be a promise the scheduler cannot keep.
 * Sub-minute latency is what `flair federation watch` is for.
 */
export const MIN_INTERVAL_SECONDS = 60;
/** Ceiling on --interval: a day. Past this, use `flair rem nightly`'s shape. */
export const MAX_INTERVAL_SECONDS = 86_400;

export interface FederationSchedulerSubstitutions {
  /** Absolute path to the flair binary the shim should invoke. */
  FLAIR_BIN: string;
  /**
   * Absolute path to the node binary that runs FLAIR_BIN, resolved at enable
   * time (#1231). Baked in so the shim performs zero PATH lookups at run time.
   */
  NODE_BIN: string;
  /** Absolute path to the shim script the scheduler should call. */
  SHIM_PATH: string;
  /** Operator's home directory (HOME env var value). */
  HOME: string;
  /** Seconds between one-shot syncs. */
  INTERVAL_SECONDS: string;
  /**
   * Path to the admin-password FILE (never the password). Empty string when
   * no credential file was configured — the shim then invokes plain
   * `flair federation sync` and the CLI's own auth ladder applies.
   */
  ADMIN_PASS_FILE: string;
  /**
   * Remote Flair URL to sync from, as FLAIR_TARGET. Empty for the normal
   * case (the local instance).
   */
  FLAIR_TARGET: string;
}

export interface EnableOpts {
  /** Seconds between one-shot syncs. */
  intervalSeconds: number;
  /** Path to a 0600 file holding the admin password. Never the password. */
  adminPassFile?: string;
  /** Remote Flair URL (FLAIR_TARGET). Omit for the local instance. */
  target?: string;
  /**
   * Absolute path to the flair binary. Defaults to argv[1], resolved to an
   * absolute path. A warning is attached when that path is not the public
   * `flair` entry (flair#1279).
   */
  flairBin?: string;
  /**
   * Absolute path to the node binary baked into the shim. Defaults to
   * resolveNodeBin() — the enabling runtime's own binary, or `command -v
   * node` resolved once at enable time (#1231).
   */
  nodeBin?: string;
  /** Override platform for testing. */
  platformOverride?: SchedulerPlatform;
  /** Override target paths for testing. */
  shimPathOverride?: string;
  launchdPlistOverride?: string;
  systemdTimerOverride?: string;
  systemdServiceOverride?: string;
  /** Override HOME written into the units (testing). */
  homeOverride?: string;
  /** Override the template root for testing. */
  templateRootOverride?: string;
  /** Skip the launchctl/systemctl invocation (testing). */
  skipLoad?: boolean;
}

export interface EnableResult {
  platform: SchedulerPlatform;
  shimPath: string;
  schedulerPath: string;
  intervalSeconds: number;
  loadCommand: string[];
  loadResult?: { code: number | null; stdout: string; stderr: string };
  /**
   * True ONLY when the service manager was observed to run the job once and
   * it exited 0 (#1231). formatEnableReport() refuses the success headline
   * without it — a load command exiting 0 proves the job was ACCEPTED, not
   * that it can RUN.
   */
  firstRunVerified: boolean;
  /**
   * How verification concluded. Absent when it was never attempted: load
   * skipped (tests) or load failed (a load failure is its own failure mode —
   * verification is only attempted after the load exits 0).
   */
  firstRun?: FirstRunVerification;
  /**
   * Path baked into the shim as FLAIR_BIN. Always set by enableScheduler;
   * optional on hand-built fixtures so existing formatEnableReport tests
   * keep compiling.
   */
  flairBin?: string;
  /**
   * False when the baked path is not the stable public `flair` entry
   * (flair#1279). formatEnableReport prints a warning even on a verified
   * success — a working first run does not mean the unit will survive a
   * tree swap. Absent/`true` on hand-built fixtures means no warning.
   */
  flairBinCanonical?: boolean;
  /** Absolute `command -v flair` when one was found at enable time. */
  flairBinPublic?: string | null;
}

export interface DisableOpts {
  platformOverride?: SchedulerPlatform;
  shimPathOverride?: string;
  launchdPlistOverride?: string;
  systemdTimerOverride?: string;
  systemdServiceOverride?: string;
  skipUnload?: boolean;
  /** When true, remove the shim too. Default false to keep state minimal. */
  removeShim?: boolean;
}

export interface DisableResult {
  platform: SchedulerPlatform;
  removed: string[];
  unloadCommand: string[];
  unloadResult?: { code: number | null; stdout: string; stderr: string };
}

function detectPlatform(override?: SchedulerPlatform): SchedulerPlatform {
  return detectPlatformFor("federation sync scheduler", override);
}

function defaultTemplateRoot(): string {
  // Templates live alongside dist/ in the published package and alongside
  // src/federation/ in the source tree. Walk up from this file until we find
  // a directory containing templates/.
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, "..", "..", "templates"),
    resolve(here, "..", "..", "..", "templates"),
    resolve(here, "..", "templates"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error(`unable to locate templates directory (looked in: ${candidates.join(", ")})`);
}

export function renderTemplate(text: string, subs: FederationSchedulerSubstitutions): string {
  return renderTemplateWith(text, { ...subs }, (v) => v);
}

/**
 * renderTemplate() for the launchd plist specifically: substituted values are
 * XML-escaped (#918). A plist is XML, so a value carrying `&`, `<`, `>`, `"`
 * or `'` makes it malformed and `launchctl bootstrap` rejects it — the job
 * silently never registers. HOME, SHIM_PATH, ADMIN_PASS_FILE and FLAIR_TARGET
 * are all arbitrary operator-supplied strings and every one of them can carry
 * an ampersand.
 *
 * Deliberately NOT folded into renderTemplate(): the same substitutions are
 * rendered into the systemd units and the shell shim, where XML escaping
 * would be corruption rather than a fix.
 */
export function renderPlistTemplate(text: string, subs: FederationSchedulerSubstitutions): string {
  return renderTemplateWith(text, { ...subs }, escapeXml);
}

/**
 * Validates the interval. Throws rather than silently coercing — surface bad
 * input at the install boundary, where the operator is still watching.
 */
export function validateInterval(intervalSeconds: number): void {
  if (!Number.isInteger(intervalSeconds)) {
    throw new Error(`interval must be a whole number of seconds, got ${intervalSeconds}`);
  }
  if (intervalSeconds < MIN_INTERVAL_SECONDS || intervalSeconds > MAX_INTERVAL_SECONDS) {
    throw new Error(
      `interval must be ${MIN_INTERVAL_SECONDS}-${MAX_INTERVAL_SECONDS} seconds, got ${intervalSeconds}. ` +
        `For sub-minute latency use \`flair federation watch --interval <s>\` in a foreground session instead.`,
    );
  }
}

function buildSubstitutions(opts: EnableOpts, shimPath: string, flairBin: string, nodeBin: string): FederationSchedulerSubstitutions {
  validateInterval(opts.intervalSeconds);
  const adminPassFile = opts.adminPassFile ?? "";
  if (adminPassFile && !existsSync(adminPassFile)) {
    throw new Error(
      `--admin-pass-file path does not exist: ${adminPassFile}. ` +
        `The scheduler stores the PATH, not the password, so the file must exist before enabling.`,
    );
  }
  return {
    FLAIR_BIN: flairBin,
    NODE_BIN: nodeBin,
    SHIM_PATH: shimPath,
    HOME: opts.homeOverride ?? homedir(),
    INTERVAL_SECONDS: String(opts.intervalSeconds),
    ADMIN_PASS_FILE: adminPassFile,
    FLAIR_TARGET: opts.target ?? "",
  };
}

function launchdDomain(): string {
  return `gui/${process.getuid?.() ?? ""}`;
}

/**
 * Installs the platform-native scheduler entry and the shim script.
 *
 * macOS: writes ~/Library/LaunchAgents/dev.flair.federation.sync.plist and
 *   bootstraps it (StartInterval + RunAtLoad).
 * Linux: writes ~/.config/systemd/user/flair-federation-sync.{timer,service}
 *   and enables the timer (OnActiveSec + OnUnitActiveSec).
 *
 * Idempotent: re-running overwrites the unit in place and re-bootstraps, so
 * `enable --interval 600` after `enable` is how you change the interval.
 */
export function enableScheduler(opts: EnableOpts): EnableResult {
  const plat = detectPlatform(opts.platformOverride);
  const resolvedFlair = resolveFlairBin(opts.flairBin);
  const flairBin = resolvedFlair.path;
  const nodeBin = resolveNodeBin(opts.nodeBin);
  const shimPath = opts.shimPathOverride ?? SHIM_PATH_DEFAULT;
  const templateRoot = opts.templateRootOverride ?? defaultTemplateRoot();
  const subs = buildSubstitutions(opts, shimPath, flairBin, nodeBin);

  // 0. Create the log directory the unit files point stdout/stderr at.
  // Nothing else ever creates it — launchd kills a job whose StandardOutPath
  // directory is missing (spawn error 209) and systemd fails the unit (#1231).
  //
  // Mode 0700 is load-bearing, NOT cosmetic: this directory also receives
  // REM's nightly log, which carries distillation CANDIDATE CONTENT — actual
  // memory text, not just sync counts and errors. Relaxing it to 0755 (e.g.
  // "for shared debugging") would expose memory content to every local user.
  const logsDir = resolve(subs.HOME, ".flair", "logs");
  try {
    mkdirSync(logsDir, { recursive: true, mode: 0o700 });
  } catch (err: any) {
    throw new Error(
      `could not create the scheduler log directory ${logsDir}: ${err?.message ?? err}. ` +
        `The service manager writes the job's stdout/stderr there; without it the first run dies ` +
        `before producing any output. Fix whatever blocks creating that directory, then re-run ` +
        `\`flair federation sync enable\`.`,
    );
  }
  const stderrLogPath = resolve(logsDir, "federation-sync.stderr.log");

  // 1. Deploy the shim (always — both platforms invoke it).
  const shimContents = renderTemplate(readTemplate(templateRoot, "bin/flair-federation-sync.sh.tmpl"), subs);
  writeFileWithDir(shimPath, shimContents, 0o700);
  chmodSync(shimPath, 0o700);

  // 2. Write the scheduler entry.
  if (plat === "darwin") {
    const plistPath = opts.launchdPlistOverride ?? LAUNCHD_PLIST_PATH;
    const plistContents = renderPlistTemplate(
      readTemplate(templateRoot, `launchd/${LAUNCHD_LABEL}.plist.tmpl`),
      subs,
    );
    writeFileWithDir(plistPath, plistContents, 0o600);

    const loadCommand = ["launchctl", "bootstrap", launchdDomain(), plistPath];
    let loadResult: EnableResult["loadResult"];
    let firstRun: FirstRunVerification | undefined;
    if (!opts.skipLoad) {
      // Bootout first in case a prior install left the job loaded — this is
      // what makes re-running enable (e.g. to change --interval) idempotent
      // rather than a "service already loaded" failure.
      spawnReport(["launchctl", "bootout", launchdDomain(), plistPath]);
      loadResult = spawnReport(loadCommand);
      if (loadResult.code === 0) {
        // Ordering gate (#1231): verify the first run ONLY after the load
        // exited 0. A load failure is its own failure mode with its own
        // remedy — kickstarting on top of it would blur which actor failed.
        firstRun = verifyFirstRun({
          plat,
          darwinTarget: `${launchdDomain()}/${LAUNCHD_LABEL}`,
          stderrLogPath,
        });
      }
    }
    return {
      platform: plat, shimPath, schedulerPath: plistPath, intervalSeconds: opts.intervalSeconds,
      loadCommand, loadResult, firstRunVerified: firstRun?.verified === true, firstRun,
      flairBin, flairBinCanonical: resolvedFlair.canonical, flairBinPublic: resolvedFlair.publicBin,
    };
  }

  // Linux: systemd user units.
  const timerPath = opts.systemdTimerOverride ?? SYSTEMD_TIMER_PATH;
  const servicePath = opts.systemdServiceOverride ?? SYSTEMD_SERVICE_PATH;

  const serviceContents = renderTemplate(readTemplate(templateRoot, `systemd/${SYSTEMD_SERVICE_UNIT}.tmpl`), subs);
  const timerContents = renderTemplate(readTemplate(templateRoot, `systemd/${SYSTEMD_TIMER_UNIT}.tmpl`), subs);
  writeFileWithDir(servicePath, serviceContents, 0o600);
  writeFileWithDir(timerPath, timerContents, 0o600);

  const loadCommand = ["systemctl", "--user", "enable", "--now", SYSTEMD_TIMER_UNIT];
  let loadResult: EnableResult["loadResult"];
  let firstRun: FirstRunVerification | undefined;
  if (!opts.skipLoad) {
    spawnReport(["systemctl", "--user", "daemon-reload"]);
    // Restart so a changed --interval takes effect on re-enable; `enable
    // --now` alone leaves an already-running timer on its old schedule.
    loadResult = spawnReport(loadCommand);
    if (loadResult.code === 0) {
      spawnReport(["systemctl", "--user", "restart", SYSTEMD_TIMER_UNIT]);
      // Ordering gate (#1231): only after the load exited 0. Starts the
      // SERVICE unit directly (oneshot ⇒ blocks until the run exits) rather
      // than waiting out the timer.
      firstRun = verifyFirstRun({ plat, linuxServiceUnit: SYSTEMD_SERVICE_UNIT, stderrLogPath });
    }
  }
  return {
    platform: plat, shimPath, schedulerPath: timerPath, intervalSeconds: opts.intervalSeconds,
    loadCommand, loadResult, firstRunVerified: firstRun?.verified === true, firstRun,
    flairBin, flairBinCanonical: resolvedFlair.canonical, flairBinPublic: resolvedFlair.publicBin,
  };
}

/** Removes the scheduler entry. Peer records and sync history are untouched. */
export function disableScheduler(opts: DisableOpts = {}): DisableResult {
  const plat = detectPlatform(opts.platformOverride);
  const removed: string[] = [];

  if (plat === "darwin") {
    const plistPath = opts.launchdPlistOverride ?? LAUNCHD_PLIST_PATH;
    const unloadCommand = ["launchctl", "bootout", launchdDomain(), plistPath];
    let unloadResult: DisableResult["unloadResult"];
    if (existsSync(plistPath)) {
      if (!opts.skipUnload) {
        unloadResult = spawnReport(unloadCommand);
      }
      rmSync(plistPath, { force: true });
      removed.push(plistPath);
    }
    if (opts.removeShim) {
      const shim = opts.shimPathOverride ?? SHIM_PATH_DEFAULT;
      if (existsSync(shim)) {
        rmSync(shim, { force: true });
        removed.push(shim);
      }
    }
    return { platform: plat, removed, unloadCommand, unloadResult };
  }

  const timerPath = opts.systemdTimerOverride ?? SYSTEMD_TIMER_PATH;
  const servicePath = opts.systemdServiceOverride ?? SYSTEMD_SERVICE_PATH;
  const unloadCommand = ["systemctl", "--user", "disable", "--now", SYSTEMD_TIMER_UNIT];
  let unloadResult: DisableResult["unloadResult"];
  if (existsSync(timerPath) || existsSync(servicePath)) {
    if (!opts.skipUnload) {
      unloadResult = spawnReport(unloadCommand);
      spawnReport(["systemctl", "--user", "daemon-reload"]);
    }
    if (existsSync(timerPath)) { rmSync(timerPath, { force: true }); removed.push(timerPath); }
    if (existsSync(servicePath)) { rmSync(servicePath, { force: true }); removed.push(servicePath); }
  }
  if (opts.removeShim) {
    const shim = opts.shimPathOverride ?? SHIM_PATH_DEFAULT;
    if (existsSync(shim)) {
      rmSync(shim, { force: true });
      removed.push(shim);
    }
  }
  return { platform: plat, removed, unloadCommand, unloadResult };
}

// ─── Status ─────────────────────────────────────────────────────────────────

export interface SchedulerStatus {
  platform: SchedulerPlatform;
  /** Whether the scheduler entry files were written to disk. */
  installed: boolean;
  /**
   * Whether the service manager genuinely has the job loaded/active — NOT
   * inferred from file presence (flair#850). `null` when the query itself was
   * inconclusive or was explicitly skipped.
   */
  active: boolean | null;
  /**
   * The interval read back OUT of the installed unit, not out of the caller's
   * flags — status must describe what is installed, not what someone meant to
   * install. `null` when nothing is installed or the value can't be parsed.
   */
  intervalSeconds: number | null;
  schedulerPath: string;
  shimPath: string;
  shimExists: boolean;
}

export interface SchedulerStatusOpts {
  platformOverride?: SchedulerPlatform;
  shimPathOverride?: string;
  launchdPlistOverride?: string;
  systemdTimerOverride?: string;
  systemdServiceOverride?: string;
  /** Skip the launchctl/systemctl active-state query (testing). */
  skipActiveCheck?: boolean;
}

function activeCheckCommand(plat: SchedulerPlatform): string[] {
  if (plat === "darwin") {
    return ["launchctl", "print", `${launchdDomain()}/${LAUNCHD_LABEL}`];
  }
  return ["systemctl", "--user", "is-active", SYSTEMD_TIMER_UNIT];
}

function queryActiveState(plat: SchedulerPlatform): boolean | null {
  const [cmd, ...args] = activeCheckCommand(plat);
  const r = spawnReport([cmd, ...args], STATUS_CHECK_TIMEOUT_MS);
  return interpretActiveResult(plat, r.code, r.stdout, r.stderr);
}

/**
 * Reads the configured interval back out of an installed unit file.
 *
 * Exported for testing, and deliberately parses the file rather than trusting
 * a remembered value: an operator who hand-edits the plist has changed the
 * real schedule, and status should say what is actually installed.
 */
export function parseInstalledInterval(plat: SchedulerPlatform, unitText: string): number | null {
  const m = plat === "darwin"
    ? /<key>\s*StartInterval\s*<\/key>\s*<integer>\s*(\d+)\s*<\/integer>/.exec(unitText)
    : /^\s*OnUnitActiveSec\s*=\s*(\d+)s\s*$/m.exec(unitText);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function schedulerStatus(opts: SchedulerStatusOpts = {}): SchedulerStatus {
  const plat = detectPlatform(opts.platformOverride);
  const shimPath = opts.shimPathOverride ?? SHIM_PATH_DEFAULT;

  let schedulerPath: string;
  let installed: boolean;
  if (plat === "darwin") {
    schedulerPath = opts.launchdPlistOverride ?? LAUNCHD_PLIST_PATH;
    installed = existsSync(schedulerPath);
  } else {
    schedulerPath = opts.systemdTimerOverride ?? SYSTEMD_TIMER_PATH;
    const servicePath = opts.systemdServiceOverride ?? SYSTEMD_SERVICE_PATH;
    installed = existsSync(schedulerPath) && existsSync(servicePath);
  }

  let intervalSeconds: number | null = null;
  if (installed) {
    try {
      intervalSeconds = parseInstalledInterval(plat, readFileSync(schedulerPath, "utf-8"));
    } catch {
      intervalSeconds = null;
    }
  }

  let active: boolean | null;
  if (!installed) {
    active = false; // nothing written — definitely nothing active
  } else if (opts.skipActiveCheck) {
    active = null; // caller opted out — unknown, not a claim either way
  } else {
    active = queryActiveState(plat);
  }

  return {
    platform: plat,
    installed,
    active,
    intervalSeconds,
    schedulerPath,
    shimPath,
    shimExists: existsSync(shimPath),
  };
}

// ─── Driver assessment ──────────────────────────────────────────────────────
// The point of the whole feature. `flair federation status` used to warn "no
// peer has merged in >24h" whether the cause was an unreachable peer or the
// complete absence of anything running sync. Those need opposite actions, so
// the warning named the wrong problem roughly half the time it fired.
//
// Two INDEPENDENT signals disambiguate them:
//   - the service manager     → is a Flair-managed driver loaded?
//   - peer.lastSyncAt         → has ANY sync contacted a peer recently?
// Neither alone is sufficient. The driver check alone would call a hand-rolled
// cron "no driver"; the timestamp alone cannot tell "never started" from
// "started, can't reach the peer".

export type DriverVerdict =
  /** Managed driver loaded, and syncs are landing. */
  | "driving"
  /** Managed driver loaded, but nothing has reached a peer in the window. */
  | "driver-stalled"
  /** Unit files on disk, but the service manager does not have them loaded. */
  | "driver-inactive"
  /** No managed driver — but syncs ARE landing, so something else drives it. */
  | "external-driver"
  /** No managed driver and nothing has synced. THE bug this issue is about. */
  | "no-driver"
  /** The service-manager query itself was inconclusive. */
  | "unknown";

export interface DriverAssessmentInput {
  installed: boolean;
  active: boolean | null;
  intervalSeconds: number | null;
  /**
   * The most recent peer CONTACT across all peers (max of peer.lastSyncAt).
   * Contact, not merge: a sync that reaches the peer and legitimately has
   * nothing to send still proves the driver ran. Gating on lastMergeAt here
   * would re-create the original bug in a new place — an idle-but-healthy
   * federation would read as "nothing is driving sync".
   */
  lastSyncAt: string | null;
  now: number;
}

export interface DriverAssessment {
  verdict: DriverVerdict;
  /** A Flair-managed driver is loaded in the service manager. */
  driverActive: boolean;
  /** At least one peer was contacted inside the freshness window. */
  contactFresh: boolean;
  freshnessWindowMs: number;
  headline: string;
  detail: string;
  /** What to run to fix it, or null when nothing needs fixing. */
  remedy: string | null;
}

/** Freshness window when no managed interval is known (nothing installed). */
export const DEFAULT_FRESHNESS_MS = 3_600_000;

/**
 * How long peer silence has to last before it counts as "not syncing".
 *
 * Three consecutive missed cycles — one miss is a blip, three is a pattern —
 * with a five-minute floor so a tight interval doesn't produce a hair trigger
 * that fires on a single slow run.
 */
export function freshnessWindowMs(intervalSeconds: number | null): number {
  if (intervalSeconds == null) return DEFAULT_FRESHNESS_MS;
  return Math.max(intervalSeconds * 3 * 1000, 300_000);
}

function humanAge(ms: number): string {
  if (ms < 60_000) return "<1m";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`;
  return `${Math.floor(ms / 86_400_000)}d`;
}

const LOG_HINT = "~/.flair/logs/federation-sync.stderr.log";

export function assessDriver(input: DriverAssessmentInput): DriverAssessment {
  const windowMs = freshnessWindowMs(input.intervalSeconds);
  const t = input.lastSyncAt ? Date.parse(input.lastSyncAt) : NaN;
  const haveContact = Number.isFinite(t);
  const contactAgeMs = haveContact ? input.now - t : Number.POSITIVE_INFINITY;
  const contactFresh = haveContact && contactAgeMs <= windowMs;
  const driverActive = input.installed && input.active === true;
  const agoText = haveContact ? `${humanAge(contactAgeMs)} ago` : "never";
  const everyText = input.intervalSeconds ? `every ${input.intervalSeconds}s` : "on its installed schedule";

  const base = { driverActive, contactFresh, freshnessWindowMs: windowMs };

  // Inconclusive service-manager query — say so rather than guessing. Note
  // this is checked BEFORE driverActive: `active === null` can never satisfy
  // `active === true`, so without this branch an inconclusive query would be
  // silently reported as "no driver".
  if (input.installed && input.active === null) {
    return {
      ...base,
      verdict: "unknown",
      headline: "Sync driver: installed, but its state could not be read",
      detail:
        `The scheduler unit is on disk, but querying the service manager was inconclusive, ` +
        `so whether it is actually loaded is unknown. Last peer contact: ${agoText}.`,
      remedy: "flair federation sync status",
    };
  }

  if (driverActive) {
    if (contactFresh) {
      return {
        ...base,
        verdict: "driving",
        headline: `Sync driver: active (${everyText})`,
        detail: `Last peer contact ${agoText}.`,
        remedy: null,
      };
    }
    return {
      ...base,
      verdict: "driver-stalled",
      headline: `Sync driver: active (${everyText}) — but no peer contact in ${humanAge(windowMs)}`,
      detail:
        `Sync IS scheduled and the service manager has it loaded, so this is not a missing driver — ` +
        `the runs themselves are failing to reach a peer (unreachable endpoint, expired credential, ` +
        `or a revoked pairing). Last peer contact: ${agoText}.`,
      remedy: `flair federation reachability   # then check ${LOG_HINT}`,
    };
  }

  // No managed driver from here down.
  if (contactFresh) {
    return {
      ...base,
      verdict: "external-driver",
      headline: "Sync driver: none managed by Flair — but syncs are landing",
      detail:
        `No Flair-managed scheduler is loaded, yet a peer was contacted ${agoText}. Something else is ` +
        `driving sync — a cron entry, a hand-written unit, or a \`flair federation watch\` session. ` +
        `Nothing is broken; enable the managed driver only if you want Flair to own it.`,
      remedy: null,
    };
  }

  if (input.installed) {
    return {
      ...base,
      verdict: "driver-inactive",
      headline: "Sync driver: INSTALLED BUT NOT LOADED — nothing is running federation sync",
      detail:
        `The scheduler unit is on disk but the service manager does not have it loaded, so it never ` +
        `fires. Last peer contact: ${agoText}.`,
      remedy: "flair federation sync enable",
    };
  }

  return {
    ...base,
    verdict: "no-driver",
    headline: "Sync driver: NONE — nothing is running federation sync",
    detail:
      `\`flair federation sync\` is one-shot and \`flair federation watch\` only runs while its terminal ` +
      `is open, so a paired spoke syncs once and then stops. Last peer contact: ${agoText}.`,
    remedy: "flair federation sync enable",
  };
}

// ─── Report formatting ──────────────────────────────────────────────────────

export interface FormattedReport {
  lines: string[];
  /** false means the caller should signal failure (nonzero exit). */
  ok: boolean;
}

/**
 * Formats the `flair federation sync enable` report. Owns the
 * success-vs-failure decision (flair#850: never print a success headline
 * before activation is known to have succeeded), extracted from the CLI
 * action so it is unit-testable without spawning launchctl/systemctl.
 *
 * flair#1231 deepened the #850 rule by one layer: activation exiting 0 proves
 * the service manager ACCEPTED the job, not that the job can run — a stripped
 * exec bit and a missing log directory both passed activation and killed the
 * first real run invisibly. So the ✅ headline is now additionally gated on
 * `firstRunVerified`: success may not be claimed until the thing the operator
 * asked for — a sync run through the service manager — has been observed to
 * happen once.
 */
function appendFlairBinWarning(lines: string[], r: EnableResult): void {
  if (r.flairBinCanonical !== false || !r.flairBin) return;
  const warning = formatFlairBinWarning(r.flairBin, r.flairBinPublic ?? null, "flair federation sync enable");
  if (warning.length === 0) return;
  lines.push("");
  lines.push(...warning);
}

export function formatEnableReport(r: EnableResult, input: { adminPassFile?: string; target?: string }): FormattedReport {
  const activationFailed = !!r.loadResult && r.loadResult.code !== 0;
  const credLine = input.adminPassFile
    ? `   Credential:  ${input.adminPassFile} ${"(path only — the password is never written into the unit)"}`
    : `   Credential:  none configured — sync will use the CLI's default auth resolution`;

  if (activationFailed) {
    const lr = r.loadResult!;
    const lines = [
      `⚠️  Federation sync driver files written but NOT activated (${r.platform})`,
      `   Interval:    every ${r.intervalSeconds}s — NOT scheduled (see below)`,
      `   Scheduler:   ${r.schedulerPath}`,
      `   Shim:        ${r.shimPath}`,
      credLine,
    ];
    if (input.target) lines.push(`   Target:      ${input.target}`);
    lines.push(`   Activation:  ${r.loadCommand.join(" ")} → code ${lr.code}`);
    if (lr.stderr) lines.push(`     stderr: ${lr.stderr.trim()}`);
    const remedy = describeLoadFailureFor(r.platform, lr, "flair federation sync enable");
    lines.push("");
    lines.push(remedy ? `   ${remedy}` : `   Re-run the activation command above manually to see the full diagnostic.`);
    lines.push("");
    lines.push(`   Nothing is scheduled until activation succeeds. Check anytime with: flair federation sync status`);
    appendFlairBinWarning(lines, r);
    return { lines, ok: false };
  }

  if (!r.firstRunVerified) {
    const fr = r.firstRun;
    const headline =
      fr?.outcome === "run-failed"
        ? `⚠️  Federation sync driver installed but the first run FAILED (${describeExitCode(fr.exitCode)})`
        : fr?.outcome === "timeout"
          ? `⚠️  Federation sync driver installed but the first run did not complete within ${Math.round(fr.budgetMs / 1000)}s — cannot confirm it works`
          : fr?.outcome === "manager-unavailable"
            ? `⚠️  Federation sync driver installed but the service manager is unreachable — cannot verify the first run`
            : fr?.outcome === "start-failed"
              ? `⚠️  Federation sync driver installed but the first run could not be started`
              : `⚠️  Federation sync driver installed but the first run was never verified`;
    const lines = [
      headline,
      `   Interval:    every ${r.intervalSeconds}s`,
      `   Scheduler:   ${r.schedulerPath}`,
      `   Shim:        ${r.shimPath}`,
      credLine,
    ];
    if (input.target) lines.push(`   Target:      ${input.target}`);
    if (r.loadResult) lines.push(`   Load:        ${r.loadCommand.join(" ")} → ok`);
    if (fr) {
      lines.push(`   First run:   ${fr.detail}`);
      if (fr.stderrTail) {
        lines.push(`   Log tail (${fr.logPath}):`);
        for (const l of fr.stderrTail.split("\n")) lines.push(`     ${l}`);
      } else if (fr.logEmpty) {
        lines.push(`   Log file ${fr.logPath} exists but is EMPTY — the run died before writing anything.`);
      } else {
        lines.push(`   No log file at ${fr.logPath}.`);
      }
    }
    lines.push("");
    if (fr?.outcome === "timeout") {
      lines.push(`   The run may legitimately still be going. Check the log above and \`flair federation status\`;`);
      lines.push(`   nothing has been CONFIRMED to sync yet.`);
    } else if (fr?.outcome === "manager-unavailable") {
      lines.push(`   The driver files are installed, but launchctl/systemctl could not be consulted, so whether`);
      lines.push(`   sync runs is UNKNOWN. Fix the service manager for this session, then re-run \`flair federation sync enable\`.`);
    } else {
      lines.push(`   Nothing has synced. Fix the cause above, then re-run \`flair federation sync enable\`.`);
    }
    lines.push("");
    lines.push(`   Check anytime with: flair federation sync status`);
    appendFlairBinWarning(lines, r);
    return { lines, ok: false };
  }

  const lines = [
    `✅ Federation sync driver enabled (${r.platform})`,
    `   Interval:    every ${r.intervalSeconds}s`,
    `   Scheduler:   ${r.schedulerPath}`,
    `   Shim:        ${r.shimPath}`,
    credLine,
  ];
  if (input.target) lines.push(`   Target:      ${input.target}`);
  if (r.loadResult) lines.push(`   Load:        ${r.loadCommand.join(" ")} → ok`);
  lines.push(`   First run:   completed through the service manager, exit 0`);
  lines.push("");
  lines.push(`Confirm anytime with \`flair federation status\`,`);
  lines.push(`which reports whether anything is actually driving sync.`);
  lines.push(`Disable with \`flair federation sync disable\`.`);
  appendFlairBinWarning(lines, r);
  return { lines, ok: true };
}

/** Formats the `flair federation sync status` report. */
export function formatStatusReport(s: SchedulerStatus, a: DriverAssessment): FormattedReport {
  const activeTxt = s.active === true ? "yes" : s.active === false ? "no" : "unknown";
  const lines = [
    `Federation sync driver (${s.platform}):`,
    `  Active:      ${activeTxt}`,
    `  Installed:   ${s.installed ? "yes" : "no"}`,
    `  Interval:    ${s.intervalSeconds ? `every ${s.intervalSeconds}s` : "—"}`,
    `  Scheduler:   ${s.schedulerPath}`,
    `  Shim:        ${s.shimPath}${s.shimExists ? "" : " (missing)"}`,
    "",
    `  ${a.headline}`,
    `  ${a.detail}`,
  ];
  if (a.remedy) {
    lines.push("");
    lines.push(`  Run: ${a.remedy}`);
  }
  // Status is informational — it does not itself signal process failure.
  // `ok` reflects only whether the headline claims a working driver.
  return { lines, ok: a.verdict !== "driver-stalled" && a.verdict !== "driver-inactive" && a.verdict !== "no-driver" };
}
