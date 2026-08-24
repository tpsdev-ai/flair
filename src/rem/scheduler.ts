/**
 * REM nightly scheduler — platform-native scheduler install/uninstall.
 *
 * Per FLAIR-NIGHTLY-REM § 3 (`flair rem nightly enable|disable`). Renders
 * launchd plist (macOS) or systemd timer+service (Linux) from templates,
 * deploys a shim script to `~/.flair/bin/flair-rem-nightly`, and loads the
 * job into the user-session scheduler.
 *
 * Templates use `{{KEY}}` placeholders — single-pass substitution. The full
 * placeholder set is enumerated in `interface SchedulerSubstitutions` so
 * adding a new key requires touching both this module and the template.
 *
 * No daemon code lives here — the scheduler invokes the shim, the shim
 * invokes `flair rem nightly run-once`, the runner module does the work.
 */
import { existsSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync, statSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { escapeXml } from "../lib/xml-escape.js";
import {
  type SchedulerPlatform,
  type FirstRunVerification,
  detectPlatform as detectPlatformFor,
  spawnReport,
  readTemplate as readTemplateFrom,
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
  SPAWN_TIMEOUT_MS,
  STATUS_CHECK_TIMEOUT_MS,
  type UserBusSessionFacts,
} from "../lib/scheduler-platform.js";

// Re-exported so this module's public surface is unchanged by the extraction
// into src/lib/scheduler-platform.ts (a second scheduler — `flair federation
// sync enable` — needs the identical launchctl/systemctl interpretation, and
// flair#850's lesson must have exactly one implementation).
export { interpretActiveResult };
export type { SchedulerPlatform };

export const SHIM_PATH_DEFAULT = resolve(homedir(), ".flair", "bin", "flair-rem-nightly");
// Unit names, exported (flair#1278) so `flair doctor`'s scheduled-drivers
// section addresses the same job this module installs — same single-source
// rule as the federation scheduler's LAUNCHD_LABEL/SYSTEMD_*_UNIT constants.
export const LAUNCHD_LABEL = "dev.flair.rem.nightly";
export const SYSTEMD_TIMER_UNIT = "flair-rem-nightly.timer";
export const SYSTEMD_SERVICE_UNIT = "flair-rem-nightly.service";
export const LAUNCHD_PLIST_PATH = resolve(homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
export const SYSTEMD_USER_DIR = resolve(homedir(), ".config", "systemd", "user");
export const SYSTEMD_TIMER_PATH = resolve(SYSTEMD_USER_DIR, SYSTEMD_TIMER_UNIT);
export const SYSTEMD_SERVICE_PATH = resolve(SYSTEMD_USER_DIR, SYSTEMD_SERVICE_UNIT);

export interface SchedulerSubstitutions {
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
  /** Agent id passed via env. */
  AGENT_ID: string;
  /** Flair HTTP URL passed via env (e.g. http://127.0.0.1:19926). */
  FLAIR_URL: string;
  /** Hour (0-23). */
  HOUR: string;
  /** Zero-padded hour ("00"-"23") for systemd OnCalendar. */
  HOUR_PAD: string;
  /** Minute (0-59). */
  MINUTE: string;
  /** Zero-padded minute ("00"-"59") for systemd OnCalendar. */
  MINUTE_PAD: string;
}

export interface EnableOpts {
  agentId: string;
  flairUrl: string;
  /** Hour (0-23). */
  hour: number;
  /** Minute (0-59). */
  minute: number;
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
  return detectPlatformFor("REM nightly scheduler", override);
}

function defaultTemplateRoot(): string {
  // Templates live alongside dist/ in the published package and alongside
  // src/rem/ in the source tree. Walk up from this file until we find
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

export function renderTemplate(text: string, subs: SchedulerSubstitutions): string {
  return renderTemplateWith(text, { ...subs }, (v) => v);
}

/**
 * renderTemplate() for the launchd plist template specifically: substituted
 * values are XML-escaped.
 *
 * A launchd plist is XML, so a substitution carrying `&`, `<`, `>`, `"` or
 * `'` makes it malformed and `launchctl bootstrap` rejects it — the timer
 * silently never registers. FLAIR_URL is the realistic carrier (a URL with
 * more than one query parameter contains `&`), but HOME and SHIM_PATH are
 * arbitrary paths and equally capable of it. HOUR/MINUTE and AGENT_ID are
 * validated upstream in buildSubstitutions(), but they are escaped too
 * rather than exempted — the point of a chokepoint is that no value gets to
 * argue it is special.
 *
 * Deliberately NOT folded into renderTemplate(): the same substitutions are
 * rendered into the systemd unit files and the shell shim, where XML
 * escaping would be corruption rather than a fix.
 */
export function renderPlistTemplate(text: string, subs: SchedulerSubstitutions): string {
  return renderTemplateWith(text, { ...subs }, escapeXml);
}

export function readTemplate(rootDir: string, relativePath: string): string {
  return readTemplateFrom(rootDir, relativePath);
}

/**
 * Validates the hour:minute schedule. Throws on invalid input rather than
 * silently coercing — surface bad input at the install boundary.
 */
function validateSchedule(hour: number, minute: number): void {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new Error(`hour must be an integer 0-23, got ${hour}`);
  }
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
    throw new Error(`minute must be an integer 0-59, got ${minute}`);
  }
}

function buildSubstitutions(opts: EnableOpts, shimPath: string, flairBin: string, nodeBin: string): SchedulerSubstitutions {
  validateSchedule(opts.hour, opts.minute);
  if (!/^[a-zA-Z0-9_-]+$/.test(opts.agentId)) {
    throw new Error(`invalid agent id: ${opts.agentId}`);
  }
  return {
    FLAIR_BIN: flairBin,
    NODE_BIN: nodeBin,
    SHIM_PATH: shimPath,
    HOME: opts.homeOverride ?? homedir(),
    AGENT_ID: opts.agentId,
    FLAIR_URL: opts.flairUrl,
    HOUR: String(opts.hour),
    HOUR_PAD: String(opts.hour).padStart(2, "0"),
    MINUTE: String(opts.minute),
    MINUTE_PAD: String(opts.minute).padStart(2, "0"),
  };
}

/**
 * Command to genuinely query the platform scheduler's active/loaded state
 * for a given install (as opposed to the shape of `loadCommand`, which
 * *installs* it). Shared by the sync and async active-state checks below so
 * the two can't drift.
 */
function activeCheckCommand(plat: SchedulerPlatform): string[] {
  if (plat === "darwin") {
    return ["launchctl", "print", `gui/${process.getuid?.() ?? ""}/${LAUNCHD_LABEL}`];
  }
  return ["systemctl", "--user", "is-active", SYSTEMD_TIMER_UNIT];
}

/**
 * Synchronous active-state check for CLI use (`flair rem nightly status`).
 * Blocking is fine here — this is a one-shot process and the caller wants
 * the answer before printing anything.
 */
function queryActiveState(plat: SchedulerPlatform): boolean | null {
  const [cmd, ...args] = activeCheckCommand(plat);
  const r = spawnReport([cmd, ...args], STATUS_CHECK_TIMEOUT_MS);
  return interpretActiveResult(plat, r.code, r.stdout, r.stderr);
}

/**
 * Async, non-blocking equivalent for server contexts (the Health endpoint)
 * where a synchronous subprocess would stall the request-handling thread.
 * Same semantics as `queryActiveState()`.
 */
export async function queryActiveStateAsync(plat: SchedulerPlatform, timeoutMs: number = STATUS_CHECK_TIMEOUT_MS): Promise<boolean | null> {
  const [cmd, ...args] = activeCheckCommand(plat);
  return new Promise((resolvePromise) => {
    let settled = false;
    let child: ReturnType<typeof spawn>;
    const finish = (result: boolean | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(result);
    };
    const timer = setTimeout(() => {
      try { child?.kill("SIGKILL"); } catch { /* best-effort */ }
      finish(null);
    }, timeoutMs);
    try {
      child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      finish(null);
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => { stdout += d.toString("utf-8"); });
    child.stderr?.on("data", (d) => { stderr += d.toString("utf-8"); });
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(interpretActiveResult(plat, code, stdout, stderr)));
  });
}

/**
 * Human remedy text for a failed scheduler-load attempt (flair#850). Covers
 * the one root cause traced so far: a missing systemd user session bus,
 * which blocks `systemctl --user` entirely in ssh-without-lingering,
 * container, and CI contexts. Returns null when the failure doesn't match a
 * known pattern — the caller already prints the raw stderr, so the operator
 * still has something to go on.
 */
export function describeLoadFailure(
  plat: SchedulerPlatform,
  loadResult: { code: number | null; stderr: string },
  session?: UserBusSessionFacts,
): string | null {
  return describeLoadFailureFor(plat, loadResult, "flair rem nightly enable", session);
}

export interface EnableReportInput extends UserBusSessionFacts {
  hour: number;
  minute: number;
  agentId: string;
  flairUrl: string;
}

export interface FormattedReport {
  lines: string[];
  /** false means the caller should signal failure (nonzero exit). */
  ok: boolean;
}

/**
 * Formats the `flair rem nightly enable` report from an `EnableResult`.
 * Pulled out of the CLI action so the success-vs-failure decision (flair#850:
 * do not print a success headline before activation is known to have
 * succeeded) is unit-testable without spawning a real launchctl/systemctl or
 * parsing CLI argv.
 *
 * flair#1231 deepened the #850 rule by one layer: activation exiting 0 proves
 * the service manager ACCEPTED the job, not that the job can run — a stripped
 * exec bit and a missing log directory both passed activation and killed the
 * first real run invisibly. So the ✅ headline is now additionally gated on
 * `firstRunVerified`: success may not be claimed until the thing the operator
 * asked for — a REM run through the service manager — has been observed to
 * happen once. A missing `loadResult`/`firstRun` (test-only skipLoad shape)
 * therefore withholds the headline too, instead of being treated as success.
 */
function appendFlairBinWarning(lines: string[], r: EnableResult): void {
  if (r.flairBinCanonical !== false || !r.flairBin) return;
  const warning = formatFlairBinWarning(r.flairBin, r.flairBinPublic ?? null, "flair rem nightly enable");
  if (warning.length === 0) return;
  lines.push("");
  lines.push(...warning);
}

export function formatEnableReport(r: EnableResult, input: EnableReportInput): FormattedReport {
  const { hour, minute, agentId, flairUrl } = input;
  const scheduleTime = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  const activationFailed = !!r.loadResult && r.loadResult.code !== 0;

  if (activationFailed) {
    const lr = r.loadResult!;
    const lines = [
      `⚠️  REM nightly scheduler files written but NOT activated (${r.platform})`,
      `   Schedule:    ${scheduleTime} local time — NOT scheduled (see below)`,
      `   Scheduler:   ${r.schedulerPath}`,
      `   Shim:        ${r.shimPath}`,
      `   Agent:       ${agentId}`,
      `   Flair URL:   ${flairUrl}`,
      `   Activation:  ${r.loadCommand.join(" ")} → code ${lr.code}`,
    ];
    if (lr.stderr) lines.push(`     stderr: ${lr.stderr.trim()}`);
    const lingerEnabled = input.lingerEnabled !== undefined
      ? input.lingerEnabled
      : (r.platform === "linux" ? probeUserLingerEnabled() : undefined);
    const remedy = describeLoadFailure(r.platform, lr, { lingerEnabled, env: input.env });
    lines.push("");
    lines.push(remedy ? `   ${remedy}` : `   Re-run the activation command above manually to see the full diagnostic.`);
    lines.push("");
    lines.push(`   Nothing is scheduled until activation succeeds. Check anytime with: flair rem nightly status`);
    appendFlairBinWarning(lines, r);
    return { lines, ok: false };
  }

  if (!r.firstRunVerified) {
    const fr = r.firstRun;
    const headline =
      fr?.outcome === "run-failed"
        ? `⚠️  REM nightly scheduler installed but the first run FAILED (${describeExitCode(fr.exitCode)})`
        : fr?.outcome === "timeout"
          ? `⚠️  REM nightly scheduler installed but the first run did not complete within ${Math.round(fr.budgetMs / 1000)}s — cannot confirm it works`
          : fr?.outcome === "manager-unavailable"
            ? `⚠️  REM nightly scheduler installed but the service manager is unreachable — cannot verify the first run`
            : fr?.outcome === "start-failed"
              ? `⚠️  REM nightly scheduler installed but the first run could not be started`
              : `⚠️  REM nightly scheduler installed but the first run was never verified`;
    const lines = [
      headline,
      `   Schedule:    ${scheduleTime} local time`,
      `   Scheduler:   ${r.schedulerPath}`,
      `   Shim:        ${r.shimPath}`,
      `   Agent:       ${agentId}`,
      `   Flair URL:   ${flairUrl}`,
    ];
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
      lines.push(`   The run may legitimately still be going (a REM cycle can be slow). Check the log above and`);
      lines.push(`   \`flair rem nightly status\`; no cycle has been CONFIRMED to work yet.`);
    } else if (fr?.outcome === "manager-unavailable") {
      lines.push(`   The scheduler files are installed, but launchctl/systemctl could not be consulted, so whether`);
      lines.push(`   the nightly cycle runs is UNKNOWN. Fix the service manager for this session, then re-run \`flair rem nightly enable\`.`);
    } else {
      lines.push(`   No REM cycle has run. Fix the cause above, then re-run \`flair rem nightly enable\`.`);
    }
    lines.push("");
    lines.push(`   Check anytime with: flair rem nightly status`);
    appendFlairBinWarning(lines, r);
    return { lines, ok: false };
  }

  const lines = [
    `✅ REM nightly scheduler enabled (${r.platform})`,
    `   Schedule:    ${scheduleTime} local time`,
    `   Scheduler:   ${r.schedulerPath}`,
    `   Shim:        ${r.shimPath}`,
    `   Agent:       ${agentId}`,
    `   Flair URL:   ${flairUrl}`,
  ];
  if (r.loadResult) {
    lines.push(`   Load:        ${r.loadCommand.join(" ")} → ok`);
  }
  lines.push(`   First run:   completed through the service manager, exit 0`);
  lines.push("");
  lines.push(`Disable with \`flair rem nightly disable\`.`);
  appendFlairBinWarning(lines, r);
  return { lines, ok: true };
}

/**
 * Formats the `flair rem nightly status` report from a `SchedulerStatus`.
 * Extracted for the same testability reason as `formatEnableReport()`
 * (flair#850): status must report genuine active state, not file presence.
 */
export function formatStatusReport(s: SchedulerStatus): FormattedReport {
  const activeTxt = s.active === true ? "yes" : s.active === false ? "no" : "unknown";
  const lines = [
    `REM nightly scheduler (${s.platform}):`,
    `  Active:      ${activeTxt}`,
    `  Installed:   ${s.installed ? "yes" : "no"}`,
    `  Scheduler:   ${s.schedulerPath}`,
    `  Shim:        ${s.shimPath}${s.shimExists ? "" : " (missing)"}`,
  ];
  if (!s.installed) {
    lines.push("");
    lines.push(`Enable with: flair rem nightly enable --agent <id> [--at HH:MM]`);
  } else if (s.active === false) {
    lines.push("");
    lines.push(`Files are written but nothing is scheduled — the job is not loaded/active.`);
    lines.push(`Re-run: flair rem nightly enable --agent <id> [--at HH:MM]`);
  }
  // Status is informational — it does not itself signal process failure,
  // consistent with the pre-existing "not installed" case never exiting
  // nonzero. `ok` here only reflects whether the headline claims success.
  return { lines, ok: s.active !== false };
}

/**
 * Installs the platform-native scheduler entry and the shim script.
 *
 * macOS: writes ~/Library/LaunchAgents/dev.flair.rem.nightly.plist + bootstraps it via launchctl.
 * Linux: writes ~/.config/systemd/user/flair-rem-nightly.{timer,service} + enables the timer.
 *
 * In both cases, also deploys ~/.flair/bin/flair-rem-nightly as the shim
 * the scheduler invokes.
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
  // Mode 0700 is load-bearing, NOT cosmetic: REM's nightly log carries
  // distillation CANDIDATE CONTENT — actual memory text, not just counts.
  // Relaxing it to 0755 (e.g. "for shared debugging") would expose memory
  // content to every local user.
  const logsDir = resolve(subs.HOME, ".flair", "logs");
  try {
    mkdirSync(logsDir, { recursive: true, mode: 0o700 });
  } catch (err: any) {
    throw new Error(
      `could not create the scheduler log directory ${logsDir}: ${err?.message ?? err}. ` +
        `The service manager writes the job's stdout/stderr there; without it the first run dies ` +
        `before producing any output. Fix whatever blocks creating that directory, then re-run ` +
        `\`flair rem nightly enable\`.`,
    );
  }
  const stderrLogPath = resolve(logsDir, "rem-nightly.stderr.log");

  // 1. Deploy the shim (always — both platforms invoke it).
  const shimContents = renderTemplate(readTemplate(templateRoot, "bin/flair-rem-nightly.sh.tmpl"), subs);
  writeFileWithDir(shimPath, shimContents, 0o700);
  chmodSync(shimPath, 0o700);

  // 2. Write the scheduler entry.
  if (plat === "darwin") {
    const plistPath = opts.launchdPlistOverride ?? LAUNCHD_PLIST_PATH;
    const plistContents = renderPlistTemplate(readTemplate(templateRoot, "launchd/dev.flair.rem.nightly.plist.tmpl"), subs);
    writeFileWithDir(plistPath, plistContents, 0o600);

    const loadCommand = ["launchctl", "bootstrap", `gui/${process.getuid?.() ?? ""}`, plistPath];
    let loadResult: EnableResult["loadResult"];
    let firstRun: FirstRunVerification | undefined;
    if (!opts.skipLoad) {
      // Bootout first in case a prior install left the job loaded.
      spawnReport(["launchctl", "bootout", `gui/${process.getuid?.() ?? ""}`, plistPath]);
      loadResult = spawnReport(loadCommand);
      if (loadResult.code === 0) {
        // Ordering gate (#1231): verify the first run ONLY after the load
        // exited 0. A load failure is its own failure mode with its own
        // remedy — kickstarting on top of it would blur which actor failed.
        firstRun = verifyFirstRun({
          plat,
          darwinTarget: `gui/${process.getuid?.() ?? ""}/${LAUNCHD_LABEL}`,
          stderrLogPath,
        });
      }
    }
    return {
      platform: plat, shimPath, schedulerPath: plistPath, loadCommand, loadResult,
      firstRunVerified: firstRun?.verified === true, firstRun,
      flairBin, flairBinCanonical: resolvedFlair.canonical, flairBinPublic: resolvedFlair.publicBin,
    };
  }

  // Linux: systemd user units.
  const timerPath = opts.systemdTimerOverride ?? SYSTEMD_TIMER_PATH;
  const servicePath = opts.systemdServiceOverride ?? SYSTEMD_SERVICE_PATH;

  const serviceContents = renderTemplate(readTemplate(templateRoot, "systemd/flair-rem-nightly.service.tmpl"), subs);
  const timerContents = renderTemplate(readTemplate(templateRoot, "systemd/flair-rem-nightly.timer.tmpl"), subs);
  writeFileWithDir(servicePath, serviceContents, 0o600);
  writeFileWithDir(timerPath, timerContents, 0o600);

  const loadCommand = ["systemctl", "--user", "enable", "--now", SYSTEMD_TIMER_UNIT];
  let loadResult: EnableResult["loadResult"];
  let firstRun: FirstRunVerification | undefined;
  if (!opts.skipLoad) {
    spawnReport(["systemctl", "--user", "daemon-reload"]);
    loadResult = spawnReport(loadCommand);
    if (loadResult.code === 0) {
      // Ordering gate (#1231): only after the load exited 0. Starts the
      // SERVICE unit directly (oneshot ⇒ blocks until the run exits) rather
      // than waiting for the nightly timer to fire.
      firstRun = verifyFirstRun({ plat, linuxServiceUnit: SYSTEMD_SERVICE_UNIT, stderrLogPath });
    }
  }
  return {
    platform: plat, shimPath, schedulerPath: timerPath, loadCommand, loadResult,
    firstRunVerified: firstRun?.verified === true, firstRun,
    flairBin, flairBinCanonical: resolvedFlair.canonical, flairBinPublic: resolvedFlair.publicBin,
  };
}

/**
 * Removes the scheduler entry. Audit log + snapshots are preserved.
 */
export function disableScheduler(opts: DisableOpts = {}): DisableResult {
  const plat = detectPlatform(opts.platformOverride);
  const removed: string[] = [];

  if (plat === "darwin") {
    const plistPath = opts.launchdPlistOverride ?? LAUNCHD_PLIST_PATH;
    const unloadCommand = ["launchctl", "bootout", `gui/${process.getuid?.() ?? ""}`, plistPath];
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

export interface SchedulerStatus {
  platform: SchedulerPlatform;
  /** Whether the scheduler entry files were written to disk. */
  installed: boolean;
  /**
   * Whether the scheduler genuinely has the job loaded/active per
   * launchctl/systemctl — NOT inferred from file presence (flair#850: a
   * `systemctl --user enable --now` that fails leaves `installed: true`
   * but nothing scheduled). `null` when this could not be determined
   * (files absent — nothing to check — or the query itself was
   * inconclusive) or when the check was explicitly skipped.
   */
  active: boolean | null;
  schedulerPath: string;
  shimPath: string;
  shimExists: boolean;
}

export interface SchedulerStatusOpts {
  platformOverride?: SchedulerPlatform;
  /** Override target paths for testing. */
  shimPathOverride?: string;
  launchdPlistOverride?: string;
  systemdTimerOverride?: string;
  systemdServiceOverride?: string;
  /**
   * Skip the launchctl/systemctl active-state query (testing, or callers
   * that only want file-presence). When skipped, `active` is `null` if
   * `installed` is true (unknown) and `false` if `installed` is false
   * (nothing to be active).
   */
  skipActiveCheck?: boolean;
}

/**
 * Reports whether the scheduler is installed AND whether it is genuinely
 * active. File presence alone proves the templates were written — it does
 * NOT prove `launchctl`/`systemctl` successfully loaded the job (flair#850).
 */
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
    schedulerPath,
    shimPath,
    shimExists: existsSync(shimPath),
  };
}
