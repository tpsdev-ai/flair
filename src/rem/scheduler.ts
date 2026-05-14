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
import { homedir, platform } from "node:os";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { fileURLToPath } from "node:url";

export const SHIM_PATH_DEFAULT = resolve(homedir(), ".flair", "bin", "flair-rem-nightly");
export const LAUNCHD_PLIST_PATH = resolve(homedir(), "Library", "LaunchAgents", "dev.flair.rem.nightly.plist");
export const SYSTEMD_USER_DIR = resolve(homedir(), ".config", "systemd", "user");
export const SYSTEMD_TIMER_PATH = resolve(SYSTEMD_USER_DIR, "flair-rem-nightly.timer");
export const SYSTEMD_SERVICE_PATH = resolve(SYSTEMD_USER_DIR, "flair-rem-nightly.service");

export type SchedulerPlatform = "darwin" | "linux";

export interface SchedulerSubstitutions {
  /** Absolute path to the flair binary the shim should invoke. */
  FLAIR_BIN: string;
  /** Absolute path to the shim script the scheduler should call. */
  SHIM_PATH: string;
  /** Operator's home directory (HOME env var value). */
  HOME: string;
  /** Agent id passed via env. */
  AGENT_ID: string;
  /** Flair HTTP URL passed via env (e.g. http://127.0.0.1:9926). */
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
  /** Absolute path to the flair binary. Defaults to argv[0]'s nearest bin dir. */
  flairBin?: string;
  /** Override platform for testing. */
  platformOverride?: SchedulerPlatform;
  /** Override target paths for testing. */
  shimPathOverride?: string;
  launchdPlistOverride?: string;
  systemdTimerOverride?: string;
  systemdServiceOverride?: string;
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
  if (override) return override;
  const p = platform();
  if (p === "darwin") return "darwin";
  if (p === "linux") return "linux";
  throw new Error(`unsupported platform for REM nightly scheduler: ${p} (only darwin and linux)`);
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
  return text.replace(/\{\{([A-Z_]+)\}\}/g, (_, key) => {
    const value = (subs as any)[key];
    if (value === undefined) throw new Error(`unknown template placeholder: ${key}`);
    return String(value);
  });
}

export function readTemplate(rootDir: string, relativePath: string): string {
  const full = resolve(rootDir, relativePath);
  if (!existsSync(full)) {
    throw new Error(`template not found: ${full}`);
  }
  return readFileSync(full, "utf-8");
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

function buildSubstitutions(opts: EnableOpts, shimPath: string, flairBin: string): SchedulerSubstitutions {
  validateSchedule(opts.hour, opts.minute);
  if (!/^[a-zA-Z0-9_-]+$/.test(opts.agentId)) {
    throw new Error(`invalid agent id: ${opts.agentId}`);
  }
  return {
    FLAIR_BIN: flairBin,
    SHIM_PATH: shimPath,
    HOME: homedir(),
    AGENT_ID: opts.agentId,
    FLAIR_URL: opts.flairUrl,
    HOUR: String(opts.hour),
    HOUR_PAD: String(opts.hour).padStart(2, "0"),
    MINUTE: String(opts.minute),
    MINUTE_PAD: String(opts.minute).padStart(2, "0"),
  };
}

function writeFileWithDir(path: string, contents: string, mode: number = 0o600): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(path, contents, { mode });
}

function spawnReport(cmd: string[]): { code: number | null; stdout: string; stderr: string } {
  const r: SpawnSyncReturns<Buffer> = spawnSync(cmd[0], cmd.slice(1), { encoding: "buffer" });
  return {
    code: r.status,
    stdout: r.stdout?.toString("utf-8") ?? "",
    stderr: r.stderr?.toString("utf-8") ?? "",
  };
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
  const flairBin = opts.flairBin ?? process.argv[1] ?? "flair";
  const shimPath = opts.shimPathOverride ?? SHIM_PATH_DEFAULT;
  const templateRoot = opts.templateRootOverride ?? defaultTemplateRoot();
  const subs = buildSubstitutions(opts, shimPath, flairBin);

  // 1. Deploy the shim (always — both platforms invoke it).
  const shimContents = renderTemplate(readTemplate(templateRoot, "bin/flair-rem-nightly.sh.tmpl"), subs);
  writeFileWithDir(shimPath, shimContents, 0o700);
  chmodSync(shimPath, 0o700);

  // 2. Write the scheduler entry.
  if (plat === "darwin") {
    const plistPath = opts.launchdPlistOverride ?? LAUNCHD_PLIST_PATH;
    const plistContents = renderTemplate(readTemplate(templateRoot, "launchd/dev.flair.rem.nightly.plist.tmpl"), subs);
    writeFileWithDir(plistPath, plistContents, 0o600);

    const loadCommand = ["launchctl", "bootstrap", `gui/${process.getuid?.() ?? ""}`, plistPath];
    let loadResult: EnableResult["loadResult"];
    if (!opts.skipLoad) {
      // Bootout first in case a prior install left the job loaded.
      spawnReport(["launchctl", "bootout", `gui/${process.getuid?.() ?? ""}`, plistPath]);
      loadResult = spawnReport(loadCommand);
    }
    return { platform: plat, shimPath, schedulerPath: plistPath, loadCommand, loadResult };
  }

  // Linux: systemd user units.
  const timerPath = opts.systemdTimerOverride ?? SYSTEMD_TIMER_PATH;
  const servicePath = opts.systemdServiceOverride ?? SYSTEMD_SERVICE_PATH;

  const serviceContents = renderTemplate(readTemplate(templateRoot, "systemd/flair-rem-nightly.service.tmpl"), subs);
  const timerContents = renderTemplate(readTemplate(templateRoot, "systemd/flair-rem-nightly.timer.tmpl"), subs);
  writeFileWithDir(servicePath, serviceContents, 0o600);
  writeFileWithDir(timerPath, timerContents, 0o600);

  const loadCommand = ["systemctl", "--user", "enable", "--now", "flair-rem-nightly.timer"];
  let loadResult: EnableResult["loadResult"];
  if (!opts.skipLoad) {
    spawnReport(["systemctl", "--user", "daemon-reload"]);
    loadResult = spawnReport(loadCommand);
  }
  return { platform: plat, shimPath, schedulerPath: timerPath, loadCommand, loadResult };
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
  const unloadCommand = ["systemctl", "--user", "disable", "--now", "flair-rem-nightly.timer"];
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
  installed: boolean;
  schedulerPath: string;
  shimPath: string;
  shimExists: boolean;
}

/**
 * Reports whether the scheduler is installed. Filesystem-only — does not
 * shell out to launchctl/systemctl to query active state. The Health
 * endpoint already does that via existence checks; same approach here.
 */
export function schedulerStatus(opts: { platformOverride?: SchedulerPlatform } = {}): SchedulerStatus {
  const plat = detectPlatform(opts.platformOverride);
  if (plat === "darwin") {
    return {
      platform: plat,
      installed: existsSync(LAUNCHD_PLIST_PATH),
      schedulerPath: LAUNCHD_PLIST_PATH,
      shimPath: SHIM_PATH_DEFAULT,
      shimExists: existsSync(SHIM_PATH_DEFAULT),
    };
  }
  return {
    platform: plat,
    installed: existsSync(SYSTEMD_TIMER_PATH) && existsSync(SYSTEMD_SERVICE_PATH),
    schedulerPath: SYSTEMD_TIMER_PATH,
    shimPath: SHIM_PATH_DEFAULT,
    shimExists: existsSync(SHIM_PATH_DEFAULT),
  };
}
