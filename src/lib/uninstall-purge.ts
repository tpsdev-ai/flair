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

import { existsSync, lstatSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { resolveHome, withHome } from "./home.js";
import {
  ALL_CLIENTS,
  clientConfigBackupPath,
  clientConfigHasFlairEntry,
  type ClientId,
  type UnwireResult,
} from "../install/clients.js";
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
  /** `unverified`: purge could not decide this path (an unreadable file, a
   *  JSON config that is malformed, `null` or otherwise not an object, or a pi
   *  entry that mentions pi-flair without being Flair's own). It is
   *  left in place and reported by name — never claimed removed and never
   *  silently kept (flair#2886). */
  kind: "intentional" | "failed" | "unverified";
  reason: string;
  remedy?: string;
}

export interface PurgeResult {
  removed: string[];
  leftovers: PurgeLeftover[];
  /** Operator notes that are neither removals nor leftovers (e.g. an ignored
   *  environment override). */
  notes?: string[];
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
 * After a failed read: is the path genuinely absent? A dangling symlink also
 * reads as ENOENT but is an entry purge could not check — not a missing one.
 */
function backupEntryAbsent(path: string): boolean {
  try {
    lstatSync(path);
    return false;
  } catch (err: unknown) {
    return (err as NodeJS.ErrnoException).code === "ENOENT";
  }
}

/**
 * Client configs get the same sibling snapshot as hook settings: an unwire
 * that writes an existing config copies its pre-write bytes to `<config>.bak`
 * when that copy write succeeds. Purge removes a copy that
 * `clientConfigHasFlairEntry()` identifies as carrying a Flair entry and
 * reports the path like a hook backup. A copy with no Flair entry may be the
 * user's own file and stays — as does one whose wiring could not be decided,
 * which is reported as not checked (flair#2886).
 *
 * Call inside `withHome(homeDir, ...)`: `clientConfigBackupPath()` resolves `~`
 * at call time, so the sweep must run with the target home in the environment,
 * not the caller's (flair#2886). When the hold succeeds, a pre-existing copy is
 * read here instead of being replaced by the unwire's snapshot.
 */
function sweepClientConfigBackup(
  clientId: ClientId,
  homeDir: string,
  removed: string[],
  leftovers: PurgeLeftover[],
): void {
  const backup = clientConfigBackupPath(clientId);
  const display = displayUnderHome(homeDir, backup);
  let bytes: Uint8Array;
  try {
    bytes = readFileSync(backup);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" && backupEntryAbsent(backup)) return;
    leftovers.push({
      path: display,
      kind: "unverified",
      reason: `could not check for Flair wiring: could not read the file${code ? ` (${code})` : ""}`,
    });
    return;
  }
  const scan = clientConfigHasFlairEntry(clientId, bytes, display);
  if (scan.status === "unknown") {
    leftovers.push({
      path: display,
      kind: "unverified",
      reason: `could not check for Flair wiring: ${scan.reason}`,
    });
    return;
  }
  if (scan.status === "present") rmPath(backup, removed, leftovers, display);
}

export interface HeldClientBackup {
  clientId: ClientId;
  path: string;
  heldPath: string;
  display: string;
}

interface ClientBackupHold {
  held: HeldClientBackup[];
  /** Clients whose pre-existing backup could not be held: neither their
   *  unwire nor their backup sweep may run (flair#2886). */
  skipped: Set<ClientId>;
}

/** Pick a hold path no other entry occupies. The name is verified absent
 *  with `lstat` and carries this process's pid and a per-client sequence, so a
 *  user file already at a candidate is never overwritten. */
function reserveHoldPath(backup: string, seq: number): string {
  for (let attempt = 0; attempt < 16; attempt++) {
    const candidate = `${backup}.purge-hold-${process.pid}-${seq}${attempt === 0 ? "" : `-${attempt}`}`;
    try {
      lstatSync(candidate);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return candidate;
      throw err;
    }
  }
  throw new Error("no free hold path name after 16 attempts");
}

/**
 * A pre-existing `<config>.bak` is the user's copy until this purge decides
 * otherwise, but the unwire's snapshot write renames over it. Move it aside
 * first and put it back before the sweep, so its bytes — or, for a symlink,
 * the link itself — survive the unwire. This covers a copy that cannot be
 * read or parsed too: a failed read must never license its replacement. The
 * hold name is verified absent, so a file already there is never overwritten;
 * when no free name can be reserved, or the rename fails, the client is
 * reported and its unwire and sweep are skipped. Call inside
 * `withHome(homeDir, ...)`.
 */
function holdClientConfigBackups(homeDir: string, leftovers: PurgeLeftover[]): ClientBackupHold {
  const held: HeldClientBackup[] = [];
  const skipped = new Set<ClientId>();
  for (const client of ALL_CLIENTS) {
    const backup = clientConfigBackupPath(client.id);
    try {
      lstatSync(backup);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      const reason = err instanceof Error ? err.message : String(err);
      leftovers.push({
        path: displayUnderHome(homeDir, backup),
        kind: "failed",
        reason: `could not hold the backup across unwiring: ${reason}; skipped unwiring this client`,
      });
      skipped.add(client.id);
      continue;
    }
    let heldPath: string;
    try {
      heldPath = reserveHoldPath(backup, held.length);
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      leftovers.push({
        path: displayUnderHome(homeDir, backup),
        kind: "failed",
        reason: `could not reserve a hold path: ${reason}; skipped unwiring this client`,
      });
      skipped.add(client.id);
      continue;
    }
    try {
      renameSync(backup, heldPath);
      held.push({ clientId: client.id, path: backup, heldPath, display: displayUnderHome(homeDir, backup) });
    } catch (err: unknown) {
      rmSync(heldPath, { force: true });
      const reason = err instanceof Error ? err.message : String(err);
      leftovers.push({
        path: displayUnderHome(homeDir, backup),
        kind: "failed",
        reason: `could not hold the backup across unwiring: ${reason}; skipped unwiring this client`,
      });
      skipped.add(client.id);
    }
  }
  return { held, skipped };
}

/** Put a held entry back over the snapshot this purge's unwire attempts to
 *  write, then let the sweep decide it. A client whose restore fails is
 *  returned so its sweep is skipped and the reported path names the held
 *  copy that remains. Call inside `withHome(homeDir, ...)`. */
export function restoreHeldClientConfigBackups(
  homeDir: string,
  held: HeldClientBackup[],
  leftovers: PurgeLeftover[],
): Set<ClientId> {
  const unrestored = new Set<ClientId>();
  for (const item of held) {
    try {
      rmSync(item.path, { force: true });
      renameSync(item.heldPath, item.path);
    } catch (err: unknown) {
      unrestored.add(item.clientId);
      const reason = err instanceof Error ? err.message : String(err);
      leftovers.push({
        path: item.display,
        kind: "failed",
        reason: `could not restore the backup held across unwiring: ${reason}; skipped this backup's sweep; ` +
          `the held copy remains at ${displayUnderHome(homeDir, item.heldPath)}`,
      });
    }
  }
  return unrestored;
}

/** Run client-config work with `HOME` set to the home being purged, and —
 *  when that home is not the caller's — with `PI_CODING_AGENT_DIR` ignored, so
 *  pi resolves under the target home instead of the caller's pi directory. */
function withClientConfigHome(homeDir: string, ignorePiDirOverride: boolean, fn: () => void): void {
  if (!ignorePiDirOverride) {
    withHome(homeDir, fn);
    return;
  }
  const prevPiDir = process.env.PI_CODING_AGENT_DIR;
  withHome(homeDir, () => {
    delete process.env.PI_CODING_AGENT_DIR;
    try {
      fn();
    } finally {
      if (prevPiDir !== undefined) process.env.PI_CODING_AGENT_DIR = prevPiDir;
    }
  });
}

/**
 * Remove Flair-owned state under `homeDir`: the `~/.flair` tree (data, keys,
 * admin-pass, backups, logs, snapshots, shims), REM + federation scheduler
 * units on both platforms, SessionStart/continuity hooks, MCP/native
 * client wiring, and the client-config snapshots left by unwiring. The npm
 * package is listed as an intentional leftover unless `omitNpmLeftover` is set.
 */
export function purgeFlairInstall(opts: PurgeOptions = {}): PurgeResult {
  const callerHome = resolveHome();
  const homeDir = opts.homeDir ?? callerHome;
  const ignorePiDirOverride = homeDir !== callerHome && process.env.PI_CODING_AGENT_DIR !== undefined;
  const skipUnload = !!opts.skipSchedulerUnload;
  const removed: string[] = [];
  const leftovers: PurgeLeftover[] = [];
  const notes: string[] = [];
  if (ignorePiDirOverride) {
    notes.push(
      `ignored PI_CODING_AGENT_DIR while purging a different home: pi settings resolved under ${displayUnderHome(homeDir, join(homeDir, ".pi", "agent"))}`,
    );
  }

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

  const hold: ClientBackupHold = { held: [], skipped: new Set<ClientId>() };
  withClientConfigHome(homeDir, ignorePiDirOverride, () => {
    const found = holdClientConfigBackups(homeDir, leftovers);
    hold.held.push(...found.held);
    for (const id of found.skipped) hold.skipped.add(id);
  });

  const unwireResults: UnwireResult[] = [];
  withClientConfigHome(homeDir, ignorePiDirOverride, () => {
    unwireResults.push(...ALL_CLIENTS.filter((c) => !hold.skipped.has(c.id)).map((c) => c.unwire()));
  });
  for (const u of unwireResults) {
    if (!u.ok) {
      leftovers.push({ path: u.message, kind: "failed", reason: u.message });
    } else if (u.removed) {
      removed.push(u.message);
    }
  }

  // The unwire above snapshots each config before writing it; sweep those
  // snapshots (and any older one) after the unwire attempts, under the target
  // home the unwire ran in. A client whose backup was not held or not restored
  // keeps its entry and is skipped.
  withClientConfigHome(homeDir, ignorePiDirOverride, () => {
    const unrestored = restoreHeldClientConfigBackups(homeDir, hold.held, leftovers);
    for (const client of ALL_CLIENTS) {
      if (hold.skipped.has(client.id) || unrestored.has(client.id)) continue;
      sweepClientConfigBackup(client.id, homeDir, removed, leftovers);
    }
  });

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

  return { removed, leftovers, notes };
}

export function formatPurgeReport(result: PurgeResult): { lines: string[]; claimedFullyPurged: boolean } {
  const lines: string[] = [];
  for (const note of result.notes ?? []) {
    lines.push(`ℹ️  ${note}`);
  }
  for (const item of result.removed) {
    lines.push(`✅ Removed: ${item}`);
  }

  const failed = result.leftovers.filter((l) => l.kind === "failed");
  const unverified = result.leftovers.filter((l) => l.kind === "unverified");
  const intentional = result.leftovers.filter((l) => l.kind === "intentional");

  for (const item of failed) {
    lines.push(`⚠️  Left (failed): ${item.path} — ${item.reason}`);
  }

  for (const item of unverified) {
    lines.push(`❓ Not checked: ${item.path} — ${item.reason}`);
  }

  if (failed.length === 0 && unverified.length === 0 && intentional.length === 0) {
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
  // An unverified path means purge could not prove it was clean, so the run is
  // not a success either (flair#2886).
  return result.leftovers.some((l) => l.kind === "failed" || l.kind === "unverified");
}
