/**
 * uninstall-purge.ts — flair#853
 *
 * `flair uninstall --purge` used to delete only `~/.flair/data` and
 * `~/.flair/keys`, then print "Flair fully purged". That left the admin
 * password, backups/logs/upgrade-snapshots, the REM nightly shim, client
 * MCP/hook wiring, and the systemd/launchd scheduler units — a secret and
 * a job that can resurrect on reinstall.
 *
 * This module is the purge body. The CLI stops the Harper service, then
 * calls `purgeFlairInstall`. Docs say purge removes everything including
 * data and keys; this does that, plus secrets, schedulers, and client
 * wiring. The npm package is an intentional leftover: this CLI cannot
 * uninstall itself. The report always names leftovers instead of claiming
 * "fully purged" when anything remains.
 */

import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ALL_CLIENTS } from "../install/clients.js";
import {
  uninstallContinuityHooks,
  uninstallHook,
  harnessSupportsContinuity,
  hookBackupPath,
  hookSettingsPath,
  SUPPORTED_HARNESSES,
} from "../hook-install.js";
import {
  disableScheduler as disableRemScheduler,
  LAUNCHD_LABEL as REM_LAUNCHD_LABEL,
  SYSTEMD_SERVICE_UNIT as REM_SYSTEMD_SERVICE,
  SYSTEMD_TIMER_UNIT as REM_SYSTEMD_TIMER,
} from "../rem/scheduler.js";
import {
  disableScheduler as disableFederationScheduler,
  LAUNCHD_LABEL as FED_LAUNCHD_LABEL,
  SYSTEMD_SERVICE_UNIT as FED_SYSTEMD_SERVICE,
  SYSTEMD_TIMER_UNIT as FED_SYSTEMD_TIMER,
} from "../federation/scheduler.js";

/** The published CLI package. Named here so the leftover line cannot drift
 *  from the remedy command. */
export const FLAIR_NPM_PACKAGE = "@tpsdev-ai/flair";

export interface PurgeLeftover {
  path: string;
  kind: "intentional" | "failed";
  reason: string;
  remedy?: string;
}

export interface PurgeResult {
  removed: string[];
  leftovers: PurgeLeftover[];
}

export interface PurgeOptions {
  homeDir?: string;
  /**
   * Skip launchctl/systemctl unload (unit tests). Files are still removed.
   */
  skipSchedulerUnload?: boolean;
  /**
   * Test-only: omit the npm-package leftover so a complete-home fixture can
   * assert the "fully purged" headline. Production always lists the package.
   */
  omitNpmLeftover?: boolean;
}

function resolveHome(homeDir?: string): string {
  return homeDir ?? process.env.HOME ?? process.env.USERPROFILE ?? homedir();
}

function withHome<T>(homeDir: string, fn: () => T): T {
  const prev = process.env.HOME;
  process.env.HOME = homeDir;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.HOME;
    else process.env.HOME = prev;
  }
}

function displayUnderHome(homeDir: string, absPath: string): string {
  if (absPath.startsWith(homeDir)) return "~" + absPath.slice(homeDir.length);
  return absPath;
}

function rmPath(absPath: string, removed: string[], leftovers: PurgeLeftover[], display: string): void {
  if (!existsSync(absPath)) return;
  try {
    rmSync(absPath, { recursive: true, force: true });
    removed.push(display);
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    leftovers.push({
      path: display,
      kind: "failed",
      reason: `could not remove: ${reason}`,
    });
  }
}

function schedulerPaths(homeDir: string, spec: {
  shimName: string;
  launchdLabel: string;
  systemdTimer: string;
  systemdService: string;
}): string[] {
  return [
    join(homeDir, ".flair", "bin", spec.shimName),
    join(homeDir, "Library", "LaunchAgents", `${spec.launchdLabel}.plist`),
    join(homeDir, ".config", "systemd", "user", spec.systemdTimer),
    join(homeDir, ".config", "systemd", "user", spec.systemdService),
  ];
}

function disableAndSweepScheduler(
  homeDir: string,
  skipUnload: boolean,
  kind: "rem" | "federation",
  removed: string[],
  leftovers: PurgeLeftover[],
): void {
  const spec = kind === "rem"
    ? {
      shimName: "flair-rem-nightly",
      launchdLabel: REM_LAUNCHD_LABEL,
      systemdTimer: REM_SYSTEMD_TIMER,
      systemdService: REM_SYSTEMD_SERVICE,
      disable: disableRemScheduler,
    }
    : {
      shimName: "flair-federation-sync",
      launchdLabel: FED_LAUNCHD_LABEL,
      systemdTimer: FED_SYSTEMD_TIMER,
      systemdService: FED_SYSTEMD_SERVICE,
      disable: disableFederationScheduler,
    };

  const paths = schedulerPaths(homeDir, spec);
  try {
    spec.disable({
      skipUnload,
      removeShim: true,
      shimPathOverride: paths[0],
      launchdPlistOverride: paths[1],
      systemdTimerOverride: paths[2],
      systemdServiceOverride: paths[3],
    });
  } catch {
    // File sweep below still runs — unload failure must not keep units on disk.
  }

  for (const abs of paths) {
    rmPath(abs, removed, leftovers, displayUnderHome(homeDir, abs));
  }
}

/**
 * `uninstallHook` / `uninstallContinuityHooks` copy the settings file to a
 * sibling `.bak` whenever it exists — including on a no-op. Purge must not
 * leave that copy (or a pre-existing `.bak` it just overwrote). flair#853
 * Bugbot: only deleting the bak after an actual remove left
 * `~/.claude/settings.json.bak` / `~/.codex/hooks.json.bak` behind.
 */
function sweepHookBackup(
  settingsPath: string,
  reportedBackup: string | null,
  homeDir: string,
  removed: string[],
  leftovers: PurgeLeftover[],
): void {
  const candidates = new Set<string>();
  if (reportedBackup) candidates.add(reportedBackup);
  candidates.add(hookBackupPath(settingsPath));
  for (const bak of candidates) {
    rmPath(bak, removed, leftovers, displayUnderHome(homeDir, bak));
  }
}

/**
 * Remove Flair-owned state under `homeDir`: the `~/.flair` tree (data, keys,
 * admin-pass, backups, logs, snapshots, shims), REM + federation scheduler
 * units on both platforms, SessionStart/continuity hooks, and MCP/native
 * client wiring. The npm package is listed as an intentional leftover
 * unless `omitNpmLeftover` is set.
 */
export function purgeFlairInstall(opts: PurgeOptions = {}): PurgeResult {
  const homeDir = resolveHome(opts.homeDir);
  const skipUnload = !!opts.skipSchedulerUnload;
  const removed: string[] = [];
  const leftovers: PurgeLeftover[] = [];

  disableAndSweepScheduler(homeDir, skipUnload, "rem", removed, leftovers);
  disableAndSweepScheduler(homeDir, skipUnload, "federation", removed, leftovers);

  for (const harness of SUPPORTED_HARNESSES) {
    const hook = uninstallHook({ homeDir, harness });
    if (!hook.ok) {
      leftovers.push({ path: hook.path, kind: "failed", reason: hook.message });
    } else if (hook.delta && hook.delta.action !== "noop") {
      removed.push(displayUnderHome(homeDir, hook.path) + " (SessionStart hook)");
    }
    sweepHookBackup(hook.path, hook.backupPath, homeDir, removed, leftovers);
    if (!harnessSupportsContinuity(harness)) continue;
    const continuity = uninstallContinuityHooks({ homeDir, harness });
    if (!continuity.ok) {
      leftovers.push({ path: continuity.path, kind: "failed", reason: continuity.message });
    } else if (continuity.actions && (continuity.actions.PostToolUse === "remove" || continuity.actions.Stop === "remove")) {
      removed.push(displayUnderHome(homeDir, continuity.path) + " (continuity hooks)");
    }
    sweepHookBackup(continuity.path, continuity.backupPath, homeDir, removed, leftovers);
  }

  // Pre-existing sibling backups (or a harness we skipped) must not survive.
  for (const harness of SUPPORTED_HARNESSES) {
    sweepHookBackup(hookSettingsPath(homeDir, harness), null, homeDir, removed, leftovers);
  }

  const unwireResults = withHome(homeDir, () => ALL_CLIENTS.map((c) => c.unwire()));
  for (const u of unwireResults) {
    if (!u.ok) {
      leftovers.push({ path: u.message, kind: "failed", reason: u.message });
    } else if (u.removed) {
      removed.push(u.message);
    }
  }

  const flairDir = join(homeDir, ".flair");
  rmPath(flairDir, removed, leftovers, "~/.flair");

  if (existsSync(flairDir)) {
    leftovers.push({
      path: "~/.flair",
      kind: "failed",
      reason: "directory still present after purge",
    });
  }

  if (!opts.omitNpmLeftover) {
    leftovers.push({
      path: FLAIR_NPM_PACKAGE,
      kind: "intentional",
      reason: "this CLI cannot uninstall itself",
      remedy: `npm uninstall -g ${FLAIR_NPM_PACKAGE}`,
    });
  }

  return { removed, leftovers };
}

export function formatPurgeReport(result: PurgeResult): { lines: string[]; claimedFullyPurged: boolean } {
  const lines: string[] = [];
  for (const item of result.removed) {
    lines.push(`✅ Removed: ${item}`);
  }

  const failed = result.leftovers.filter((l) => l.kind === "failed");
  const intentional = result.leftovers.filter((l) => l.kind === "intentional");

  for (const item of failed) {
    lines.push(`⚠️  Left (failed): ${item.path} — ${item.reason}`);
  }

  if (failed.length === 0 && intentional.length === 0) {
    lines.push("");
    lines.push("🗑️  Flair fully purged");
    return { lines, claimedFullyPurged: true };
  }

  lines.push("");
  lines.push("🗑️  Flair purged (data, keys, secrets, schedulers, and client wiring)");
  if (intentional.length > 0) {
    lines.push("");
    lines.push("Intentionally left:");
    for (const item of intentional) {
      lines.push(`  • ${item.path} — ${item.reason}`);
      if (item.remedy) lines.push(`    Remove with: ${item.remedy}`);
    }
  }
  return { lines, claimedFullyPurged: false };
}

export function purgeHadFailures(result: PurgeResult): boolean {
  return result.leftovers.some((l) => l.kind === "failed");
}
