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
import { existsSync, chmodSync, rmSync, readFileSync, mkdirSync, realpathSync } from "node:fs";
import { resolve, dirname, isAbsolute } from "node:path";

import { fileURLToPath } from "node:url";
import { escapeXml, unescapeXml } from "../lib/xml-escape.js";
import { snapshotRegularFile, writeFilesAtomically, type AtomicWriteHooks, type FileSnapshot } from "../lib/atomic-write.js";
import { preferVersionManagerAlias, type AliasHooks } from "../lib/node-alias-path.js";
import { compareVersions, isNpmGlobalFlairTree } from "../lib/tree-divergence.js";
import { findFlairPackageDir } from "../lib/upgrade-exec-path.js";
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
  probeUserLingerEnabled,
  STATUS_CHECK_TIMEOUT_MS,
  type UserBusSessionFacts,
} from "../lib/scheduler-platform.js";
import { resolveHome } from "../lib/home.js";

export type { SchedulerPlatform };

export const LAUNCHD_LABEL = "dev.flair.federation.sync";
export const SYSTEMD_TIMER_UNIT = "flair-federation-sync.timer";
export const SYSTEMD_SERVICE_UNIT = "flair-federation-sync.service";

export const SHIM_PATH_DEFAULT = resolve(resolveHome(), ".flair", "bin", "flair-federation-sync");
export const LAUNCHD_PLIST_PATH = resolve(resolveHome(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
export const SYSTEMD_USER_DIR = resolve(resolveHome(), ".config", "systemd", "user");
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
   * Absolute path to the node binary baked into the shim, used verbatim.
   * Defaults to resolveNodeBin() — the enabling runtime's own binary, or
   * `command -v node` resolved once at enable time (#1231) — written through
   * the same version-manager alias policy `flair init` uses when it re-points
   * the shim (preferVersionManagerAlias, flair#2034), so enable and init agree
   * on the path.
   */
  nodeBin?: string;
  /** The runtime to resolve when nodeBin is not given (testing). Defaults to resolveNodeBin(). */
  defaultNodeBin?: string;
  /** Filesystem hooks for the alias policy (testing). */
  aliasHooks?: AliasHooks;
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
    HOME: opts.homeOverride ?? resolveHome(),
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
  const nodeBin = opts.nodeBin
    ? resolveNodeBin(opts.nodeBin)
    : preferVersionManagerAlias(opts.defaultNodeBin ?? resolveNodeBin(), opts.aliasHooks);
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

export function formatEnableReport(
  r: EnableResult,
  input: { adminPassFile?: string; target?: string } & UserBusSessionFacts,
): FormattedReport {
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
    const lingerEnabled = input.lingerEnabled !== undefined
      ? input.lingerEnabled
      : (r.platform === "linux" ? (input.probeLinger ?? probeUserLingerEnabled)() : undefined);
    const remedy = describeLoadFailureFor(r.platform, lr, "flair federation sync enable", {
      lingerEnabled,
      env: input.env,
    });
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

// ─── runtime re-point (flair#2034 §2) ───────────────────────────────────────
//
// After a Node bump the shim's baked NODE_BIN/FLAIR_BIN keep running the flair
// of the OLD runtime's install tree. `flair init` and `flair doctor --fix`
// re-point them at this CLI's tree.
//
// ONLY THE SHIM'S EXEC LINE CHANGES. The runtime lives in exactly one place:
// the shim's `exec "<NODE_BIN>" "<FLAIR_BIN>" federation sync "$@"` line. The
// launchd plist / systemd unit exec the SHIM by path and carry no runtime path
// at all (templates/launchd/dev.flair.federation.sync.plist.tmpl and
// templates/systemd/flair-federation-sync.service.tmpl), so the unit is never
// rewritten: the operator's interval, target, pass-file, PATH, RunAtLoad and
// anything else they set stay byte-for-byte as they are. The unit is only READ,
// to establish that the scheduler is enabled and that it execs this shim.
//
// Refused, never guessed: an unreadable unit or shim, a unit that does not exec
// the shim, a shim that is a symlink or not a regular file, and a shim whose
// COMMANDS differ from what `flair federation sync enable` writes — compared
// line by line with the template, where the only difference allowed is the two
// paths on the exec line (comment lines are not compared). A shim with no unit
// (the leftover of `federation sync disable`) is not an enabled scheduler and is
// left alone. The write is atomic (temp file + fsync + rename) and lands only
// over the bytes it was planned from: the shim is re-checked immediately before
// the rename, and an edit made in between refuses the write.

export type FederationRuntimeStatus =
  | "not-enabled"
  | "current"
  | "pinned-node"
  | "separate"
  | "would-rewrite"
  | "rewritten"
  | "refused";

export interface RewriteFederationRuntimeOpts {
  /** The node binary to bake. Defaults to the enable policy: preferVersionManagerAlias(resolveNodeBin()). */
  nodeBin?: string;
  /** The flair CLI script to bake. Defaults to resolveFlairBin(). */
  flairBin?: string;
  /** This CLI's install tree. Defaults to the tree the baked flair script belongs to. */
  cliTree?: string;
  /** This CLI's flair version, for the no-downgrade rule. */
  cliVersion?: string | null;
  /** Classify and report what would change, without writing. */
  dryRun?: boolean;
  platformOverride?: SchedulerPlatform;
  shimPathOverride?: string;
  launchdPlistOverride?: string;
  /** The systemd SERVICE unit path (the one that execs the shim). */
  systemdServiceOverride?: string;
  read?: (p: string) => string;
  exists?: (p: string) => boolean;
  realpath?: (p: string) => string;
  /** The @tpsdev-ai/flair package a file belongs to ({dir, version}), or null. */
  packageOf?: (p: string) => { dir: string; version: string | null } | null;
  modeOf?: (p: string) => number;
  /** Filesystem hooks for the shim's snapshot, re-check and atomic write (tests inject failures here). */
  atomic?: AtomicWriteHooks;
  /** Where the shim template is read from, for the shape check (testing). */
  templateRootOverride?: string;
}

export interface RewriteFederationRuntimeResult {
  status: FederationRuntimeStatus;
  platform: SchedulerPlatform;
  shimPath: string;
  unitPath: string;
  detail: string;
  from?: { nodeBin: string; flairBin: string };
  to?: { nodeBin: string; flairBin: string };
}

const SHIM_MARKER = "# Deployed by `flair federation sync enable`";
const SHIM_EXEC_LINE_RE = /^exec "([^"\n]*)" "([^"\n]*)" federation sync "\$@"$/gm;
const UNSAFE_SHIM_VALUE = /["$`\\\n]/;

/** A shell command line of the shim (not blank, not a `#` comment at column 0). */
function shimCommandLines(text: string): Array<{ n: number; line: string }> {
  return text
    .split("\n")
    .map((line, i) => ({ n: i + 1, line }))
    .filter(({ line, n }) => n === 1 || (line !== "" && !line.startsWith("#")));
}

/**
 * Does `shimText` run exactly the commands the enable template writes? The
 * first line (the interpreter) and every non-comment line are compared, in
 * order, with the template's; the exec line may differ only in its two quoted
 * paths. Returns the reason it does not match (naming a line number, never the
 * line's content — a hand edit may hold a secret), or null.
 */
export function federationShimShapeProblem(shimText: string, templateText: string): string | null {
  const want = shimCommandLines(templateText);
  const have = shimCommandLines(shimText);
  const execTemplate = /^exec "\{\{NODE_BIN\}\}" "\{\{FLAIR_BIN\}\}" federation sync "\$@"$/;
  for (let i = 0; i < Math.max(want.length, have.length); i++) {
    const w = want[i];
    const h = have[i];
    if (!h) return `it ends after line ${have.length ? have[have.length - 1]!.n : 0}, before the generated commands do`;
    if (!w) return `line ${h.n} is a command the generated shim does not have`;
    const matches = execTemplate.test(w.line)
      ? new RegExp(SHIM_EXEC_LINE_RE.source).test(h.line)
      : h.line === w.line;
    if (!matches) return `line ${h.n} is not the generated command at that position`;
  }
  return null;
}

/** Does the federation-sync unit exec `shimPath`? Returns the reason it does not, or null. */
function federationUnitExecsShim(plat: SchedulerPlatform, text: string, shimPath: string): string | null {
  if (plat === "darwin") {
    const label = /<key>Label<\/key>\s*<string>([^<]*)<\/string>/.exec(text);
    if (!label || unescapeXml(label[1]!) !== LAUNCHD_LABEL) return `its Label is not ${LAUNCHD_LABEL}`;
    const block = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text);
    const args = block ? [...block[1]!.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => unescapeXml(m[1]!)) : [];
    if (args.length !== 1 || resolve(args[0]!) !== resolve(shimPath)) {
      return `its ProgramArguments are ${JSON.stringify(args)}, not [${JSON.stringify(shimPath)}]`;
    }
    return null;
  }
  let section = "";
  const execs: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
    if (line.startsWith("[")) {
      section = line.slice(1).replace(/\].*$/, "").trim().toLowerCase();
      continue;
    }
    if (section === "service" && /^ExecStart\s*=/.test(line)) execs.push(line.replace(/^ExecStart\s*=\s*/, "").replace(/^[-@:+!]+/, ""));
  }
  if (execs.length !== 1 || resolve(execs[0]!) !== resolve(shimPath)) {
    return `its ExecStart is ${JSON.stringify(execs)}, not ${JSON.stringify(shimPath)}`;
  }
  return null;
}

/**
 * Re-point the federation-sync shim at this CLI's install tree. See the block
 * comment above for what is — and is never — changed.
 */
export function rewriteFederationSchedulerRuntime(
  opts: RewriteFederationRuntimeOpts = {},
): RewriteFederationRuntimeResult {
  const read = opts.read ?? ((p: string) => readFileSync(p, "utf-8"));
  const exists = opts.exists ?? existsSync;
  const realpath = opts.realpath ?? ((p: string) => realpathSync(p));
  const canonical = (p: string): string => {
    try {
      return realpath(p);
    } catch {
      return resolve(p);
    }
  };
  const packageOf = opts.packageOf ?? ((p: string) => {
    try {
      return findFlairPackageDir(realpath(p));
    } catch {
      return null;
    }
  });
  const plat = detectPlatform(opts.platformOverride);
  const shimPath = opts.shimPathOverride ?? SHIM_PATH_DEFAULT;
  const unitPath = plat === "darwin"
    ? (opts.launchdPlistOverride ?? LAUNCHD_PLIST_PATH)
    : (opts.systemdServiceOverride ?? SYSTEMD_SERVICE_PATH);
  const base = { platform: plat, shimPath, unitPath };
  const refused = (detail: string): RewriteFederationRuntimeResult => ({
    ...base,
    status: "refused",
    detail: `${detail} The federation-sync shim was not changed; to regenerate the pair: flair federation sync enable`,
  });

  if (!exists(unitPath)) {
    return {
      ...base,
      status: "not-enabled",
      detail: `federation sync is not enabled (no ${unitPath})${exists(shimPath) ? `; the leftover shim ${shimPath} is left as it is` : ""}.`,
    };
  }
  let unitText: string;
  try {
    unitText = read(unitPath);
  } catch (err: any) {
    return refused(`could not read ${unitPath} (${err?.message ?? err}).`);
  }
  const notOurs = federationUnitExecsShim(plat, unitText, shimPath);
  if (notOurs) return refused(`${unitPath} does not exec the flair-generated shim: ${notOurs}.`);
  if (!exists(shimPath)) return refused(`${unitPath} execs ${shimPath}, which does not exist.`);
  // A regular file (never followed through a symlink), read once: the plan and
  // the pre-rename re-check both use these bytes.
  let planned: FileSnapshot;
  try {
    planned = snapshotRegularFile(shimPath, { lstat: opts.atomic?.lstat, read });
  } catch (err: any) {
    return refused(`could not read ${shimPath} as a regular file (${err?.message ?? err}).`);
  }
  const shimText = planned.content;
  const execLines = [...shimText.matchAll(SHIM_EXEC_LINE_RE)];
  if (!shimText.includes(SHIM_MARKER) || execLines.length !== 1) {
    return refused(`${shimPath} is not in the shape \`flair federation sync enable\` writes (one \`exec "<node>" "<flair>" federation sync\` line).`);
  }
  let templateText: string;
  try {
    templateText = readTemplate(opts.templateRootOverride ?? defaultTemplateRoot(), "bin/flair-federation-sync.sh.tmpl");
  } catch (err: any) {
    return refused(`could not read the shim template to compare ${shimPath} with (${err?.message ?? err}).`);
  }
  const shapeProblem = federationShimShapeProblem(shimText, templateText);
  if (shapeProblem) {
    return refused(
      `${shimPath} does not run exactly the commands \`flair federation sync enable\` writes (${shapeProblem}), so it ` +
        "was hand-changed and flair does not rewrite it.",
    );
  }
  const oldNode = execLines[0]![1]!;
  const oldFlair = execLines[0]![2]!;
  if (!isAbsolute(oldNode) || !isAbsolute(oldFlair)) {
    return refused(`${shimPath} names a relative node or flair path (${oldNode}, ${oldFlair}).`);
  }

  const newFlair = resolveFlairBin(opts.flairBin).path;
  const newNode = opts.nodeBin ?? preferVersionManagerAlias(resolveNodeBin());
  const newPkg = packageOf(newFlair);
  const cliTree = opts.cliTree ?? newPkg?.dir ?? null;
  const cliVersion = opts.cliVersion !== undefined ? opts.cliVersion : (newPkg?.version ?? null);
  if (!cliTree) return refused(`cannot tell which install tree this CLI's script ${newFlair} belongs to.`);

  const oldPkg = exists(oldFlair) ? packageOf(oldFlair) : null;
  const oldNodeMissing = !exists(oldNode);
  let nextNode = oldNode;
  let nextFlair = oldFlair;
  if (oldPkg && canonical(oldPkg.dir) === canonical(cliTree)) {
    // Same install tree as this CLI.
    if (oldNodeMissing) {
      nextNode = newNode;
    } else if (canonical(oldNode) === canonical(newNode)) {
      return { ...base, status: "current", detail: `${shimPath} already runs this CLI's tree (${cliTree}).` };
    } else {
      return {
        ...base,
        status: "pinned-node",
        detail:
          `${shimPath} runs this CLI's tree with node ${oldNode} (this CLI runs ${newNode}); a deliberate runtime ` +
          "pin is left as it is.",
      };
    }
  } else {
    if (exists(oldFlair) && !oldPkg) {
      return refused(`${shimPath} runs ${oldFlair}, which is not inside a @tpsdev-ai/flair install, so its tree cannot be judged.`);
    }
    if (oldPkg && !isNpmGlobalFlairTree(oldPkg.dir)) {
      return {
        ...base,
        status: "separate",
        detail:
          `${shimPath} runs flair from ${oldPkg.dir}, which is not an npm-global install (a plain tree or a checkout); ` +
          "flair treats it as separately managed and does not re-point it.",
      };
    }
    if (oldPkg?.version && cliVersion && compareVersions(cliVersion, oldPkg.version) < 0) {
      return refused(
        `${shimPath} runs flair ${oldPkg.version} from ${oldPkg.dir}; this CLI's tree has the older ${cliVersion}, so ` +
          "re-pointing would downgrade it. Update this CLI's tree first (npm i -g @tpsdev-ai/flair).",
      );
    }
    nextNode = newNode;
    nextFlair = newFlair;
  }

  for (const [what, p] of [["node", nextNode], ["flair", nextFlair]] as const) {
    if (!isAbsolute(p) || UNSAFE_SHIM_VALUE.test(p)) return refused(`the ${what} path ${JSON.stringify(p)} cannot be written into a shell shim safely.`);
    if (!exists(p)) return refused(`the ${what} path ${p} does not exist.`);
  }
  const from = { nodeBin: oldNode, flairBin: oldFlair };
  const to = { nodeBin: nextNode, flairBin: nextFlair };
  const detail =
    `re-point ${shimPath}: node ${oldNode} → ${nextNode}` + (nextFlair !== oldFlair ? `, flair ${oldFlair} → ${nextFlair}` : "");
  if (opts.dryRun) return { ...base, status: "would-rewrite", detail, from, to };

  const nextLine = `exec "${nextNode}" "${nextFlair}" federation sync "$@"`;
  const execMatch = execLines[0]!;
  const nextText = shimText.slice(0, execMatch.index!) + nextLine + shimText.slice(execMatch.index! + execMatch[0].length);
  let mode = planned.mode;
  if (opts.modeOf) {
    try {
      mode = opts.modeOf(shimPath);
    } catch { /* keep the snapshot's mode */ }
  }
  try {
    writeFilesAtomically([{ path: shimPath, content: nextText, mode, expect: planned }], opts.atomic);
  } catch (err: any) {
    return refused(`could not write ${shimPath}: ${err?.message ?? err}.`);
  }
  let after = "";
  try {
    after = read(shimPath);
  } catch { /* verified below */ }
  if (after !== nextText) return refused(`${shimPath} did not read back as written.`);
  return { ...base, status: "rewritten", detail: detail.replace(/^re-point/, "re-pointed"), from, to };
}
