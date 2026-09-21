/**
 * upgrade.ts — extracted from src/cli.ts (flair#1636, epic #1618).
 *
 * Pure move, ZERO behavior change: `flair snapshot` (pre-upgrade data snapshot create/list/restore, flair#637) and `flair upgrade` (incl. `--target <fabric>`); shares stampEngineVersionIfRunning() with the lifecycle sections left in cli.ts.
 * Shared cli-locals stay in cli.ts and are injected via bindCli() before
 * register(); this module never imports src/cli.ts. Top-level imports only
 * (no require(), #1653). Compiled strictly via tsconfig.check.src.json.
 */
import { Command } from "commander";
import { detectWiredFlairMcp, isNodeKeyId } from "../doctor-client.js";
import { UPGRADE_SNAPSHOT_ROOT, fetchDeclaredHarperVersion, readInstalledHarperVersion } from "../engine-version.js";
import { fabricUpgrade } from "../fabric-upgrade.js";
import { renderFleetSweepTable, sweepFleet } from "../fleet-verify.js";
import { resolveNpmGlobalPrefix } from "../install/global-bin-path.js";
import { defaultKeysDir } from "../lib/auth-resolve.js";
import { renderVerifiedSummary } from "../lib/doctor-run.js";
import { isDetached, renderDetachedWarning } from "../lib/launchd-management.js";
import { FLAIR_MCP_PACKAGE, clearFlairCliVersionCache } from "../lib/mcp-spec.js";
import { createRegistryNoticePrinter, fetchLatestVersion, isStrictSemver } from "../lib/npm-registry.js";
import { ownedPinRefreshShouldReport, refreshOwnedPins } from "../lib/owned-pins.js";
import { extractSnapshotSafely, validateSnapshotArchive } from "../lib/safe-snapshot-extract.js";
import { collectUpgradeExecPathWarning, findFlairPackageDir, resolveNpmGlobalFlairPackage, resolveServingFlairPackage } from "../lib/upgrade-exec-path.js";
import { PlainTreeUpgradePlan, applyPlainTreeUpgrade, decidePlainTreeRollback, discardPlainTreePrevious, findSystemdUnitsForTree, formatPlainTreeBanner, formatPlainTreePlan, formatPlainTreeScopeFooter, planPlainTreeUpgrade, resolvePlainTreeListingTarget, resolvePlainTreeTarget, restartSystemdUnits, restorePlainTreePrevious } from "../lib/upgrade-plain-tree.js";
import { probeInstance } from "../probe.js";
import * as render from "../render.js";
import { FLAIR_PKG_NAME, primeVersionCheckCache } from "../version-check.js";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { create as tarCreate } from "tar";

// The status set is defined ONCE in src/lib/upgrade-status.ts and shared with
// src/cli.ts (flair#1778) — this module never imports src/cli.ts, so the set
// cannot live there.
import type { UpgradeStatus } from "../lib/upgrade-status.js";
import { classifyInstalledVersion, formatUpgradeStatusLine } from "../lib/upgrade-status.js";

export type UpgradeCli = {
  decideAfterRollbackVerify: (...args: any[]) => any;
  decideAfterVerify: (...args: any[]) => any;
  defaultDataDir: (...args: any[]) => any;
  doctorRunAfterUpgrade: (...args: any[]) => any;
  flairPackageDir: (...args: any[]) => any;
  fleetSweepCallerExitMessage: (...args: any[]) => any;
  humanBytes: (...args: any[]) => any;
  isCredentialOnlyFailure: (...args: any[]) => any;
  observeLaunchdManagement: (...args: any[]) => any;
  printVerifiedSummary: (...args: any[]) => any;
  probeBinVersion: (...args: any[]) => any;
  probeLibVersion: (...args: any[]) => any;
  probeOpenclawPluginVersion: (...args: any[]) => any;
  relativeTime: (...args: any[]) => any;
  resolveAgentIdOrEnv: (...args: any[]) => any;
  resolveFabricCredentials: (...args: any[]) => any;
  resolveFlairMcpFinding: (...args: any[]) => any;
  resolveHttpPort: (...args: any[]) => any;
  resolveInstalledFlairCli: (...args: any[]) => any;
  resolveInstanceServingPid: (...args: any[]) => any;
  resolveUpgradeRestartVerify: (...args: any[]) => any;
  restartAfterUpgrade: (...args: any[]) => any;
  shouldPrintUpgradeLine: (...args: any[]) => any;
  shouldRunFleetVerify: (...args: any[]) => any;
  startFlairProcess: (...args: any[]) => any;
  stopFlairProcess: (...args: any[]) => any;
  upgradeStatusSuffix: (...args: any[]) => any;
  verifyAuthedGet: (...args: any[]) => any;
  STARTUP_TIMEOUT_MS: any;
};

let cli: UpgradeCli;

/** Bind the cli-locals this module depends on. */
export function bindCli(fns: UpgradeCli): void {
  cli = fns;
}

function decideAfterRollbackVerify(...args: any[]): any {
  return cli.decideAfterRollbackVerify(...args);
}

function decideAfterVerify(...args: any[]): any {
  return cli.decideAfterVerify(...args);
}

function defaultDataDir(...args: any[]): any {
  return cli.defaultDataDir(...args);
}

function doctorRunAfterUpgrade(...args: any[]): any {
  return cli.doctorRunAfterUpgrade(...args);
}

function flairPackageDir(...args: any[]): any {
  return cli.flairPackageDir(...args);
}

function fleetSweepCallerExitMessage(...args: any[]): any {
  return cli.fleetSweepCallerExitMessage(...args);
}

function humanBytes(...args: any[]): any {
  return cli.humanBytes(...args);
}

function isCredentialOnlyFailure(...args: any[]): any {
  return cli.isCredentialOnlyFailure(...args);
}

function observeLaunchdManagement(...args: any[]): any {
  return cli.observeLaunchdManagement(...args);
}

function printVerifiedSummary(...args: any[]): any {
  return cli.printVerifiedSummary(...args);
}

function probeBinVersion(...args: any[]): any {
  return cli.probeBinVersion(...args);
}

function probeLibVersion(...args: any[]): any {
  return cli.probeLibVersion(...args);
}

function probeOpenclawPluginVersion(...args: any[]): any {
  return cli.probeOpenclawPluginVersion(...args);
}

function relativeTime(...args: any[]): any {
  return cli.relativeTime(...args);
}

function resolveAgentIdOrEnv(...args: any[]): any {
  return cli.resolveAgentIdOrEnv(...args);
}

function resolveFabricCredentials(...args: any[]): any {
  return cli.resolveFabricCredentials(...args);
}

function resolveFlairMcpFinding(...args: any[]): any {
  return cli.resolveFlairMcpFinding(...args);
}

function resolveHttpPort(...args: any[]): any {
  return cli.resolveHttpPort(...args);
}

function resolveInstalledFlairCli(...args: any[]): any {
  return cli.resolveInstalledFlairCli(...args);
}

function resolveInstanceServingPid(...args: any[]): any {
  return cli.resolveInstanceServingPid(...args);
}

function resolveUpgradeRestartVerify(...args: any[]): any {
  return cli.resolveUpgradeRestartVerify(...args);
}

function restartAfterUpgrade(...args: any[]): any {
  return cli.restartAfterUpgrade(...args);
}

function shouldPrintUpgradeLine(...args: any[]): any {
  return cli.shouldPrintUpgradeLine(...args);
}

function shouldRunFleetVerify(...args: any[]): any {
  return cli.shouldRunFleetVerify(...args);
}

function startFlairProcess(...args: any[]): any {
  return cli.startFlairProcess(...args);
}

function stopFlairProcess(...args: any[]): any {
  return cli.stopFlairProcess(...args);
}

function upgradeStatusSuffix(...args: any[]): any {
  return cli.upgradeStatusSuffix(...args);
}

function verifyAuthedGet(...args: any[]): any {
  return cli.verifyAuthedGet(...args);
}

async function runFabricUpgrade(opts: any): Promise<void> {
  const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
  const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
  const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
  const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

  let fabricUser: string | undefined;
  let fabricPassword: string | undefined;
  let credWarnings: string[] = [];
  try {
    ({ fabricUser, fabricPassword, warnings: credWarnings } = resolveFabricCredentials(opts));
  } catch (err: any) {
    console.error(red(`Error: ${err.message}`));
    process.exit(1);
  }
  const check = opts.check ?? false;

  // Creds are not required for --check (read-only registry + best-effort GET),
  // but ARE required to actually deploy.
  if (!check && !(fabricUser && fabricPassword)) {
    console.error(red("flair upgrade --target: credentials required to deploy"));
    console.error(
      "  set FABRIC_USER + FABRIC_PASSWORD env (safest), or pass --fabric-user + --fabric-password-file <path>",
    );
    console.error(
      "  inline --fabric-user/--fabric-password also work but leak to shell history — avoid on shared/multi-user hosts",
    );
    console.error("  or use --check to preview the plan without credentials");
    process.exit(1);
  }

  // Never log the credential VALUES — only the flag names, via the
  // resolver's own warning strings.
  for (const w of credWarnings) console.error(dim(w));

  const upgradeOpts = {
    target: opts.target as string,
    project: opts.project,
    // flair#926: `--flair-version`, never `opts.version` — that attribute name
    // belongs to the program's `-v, --version` and never reaches this action.
    version: opts.flairVersion,
    harperVersion: opts.harperVersion,
    fabricUser,
    fabricPassword,
    check,
    restart: opts.restart !== false,
    replicated: opts.replicated !== false,
    // flair#878 — previously unreachable from this command; see
    // FabricUpgradeOptions.
    deployRetries: Number(opts.deployRetries ?? 0),
    ignoreReplicationErrors: opts.ignoreReplicationErrors ?? false,
    convergenceCheck: opts.convergenceCheck !== false,
    convergenceTimeoutMs: opts.convergenceTimeout != null ? Number(opts.convergenceTimeout) : undefined,
  };

  console.log(`${green("→")} Upgrading Fabric Flair at ${upgradeOpts.target}`);
  if (check) console.log(dim("  (--check: plan only, no deploy)"));

  try {
    // For a real (non-check) run, confirm first unless --yes. Building the plan
    // up front would double the registry round-trips; the plan prints inside
    // fabricUpgrade. We confirm BEFORE invoking when interactive and not --yes.
    if (!check && !opts.yes && process.stdin.isTTY) {
      const { createInterface } = await import("node:readline");
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer: string = await new Promise((res) =>
        rl.question(
          `Deploy a fresh ${green("@tpsdev-ai/flair")} to ${upgradeOpts.target}? [y/N] `,
          (a) => { rl.close(); res(a); },
        ),
      );
      if (!/^y(es)?$/i.test(answer.trim())) {
        console.log("Aborted.");
        return;
      }
    }

    const result = await fabricUpgrade(upgradeOpts);

    if (check) {
      console.log(
        `\n${green("✓")} check complete — run without --check to deploy.`,
      );
      return;
    }
    if (result.plan.upToDate && !result.deployed) {
      console.log(`\n${green("✓")} already up to date.`);
      return;
    }
    if (result.convergedAfterReplicationError) {
      // flair#878: this deploy is a SUCCESS that harper's own exit code called
      // a failure. Say both halves out loud — an operator who saw the
      // replication error scroll past needs to know it resolved, and an
      // operator reading only this line needs to know it happened at all.
      console.log(
        `\n${yellow("⚠")} harper reported a peer-replication failure during this upgrade, but the component ` +
          `tree on every named peer node matched the origin when checked afterwards — replication converged ` +
          `on its own. Harper replicates components asynchronously, so a replication error at deploy time is ` +
          `a snapshot, not a verdict.`,
      );
    }
    if (result.replicationWarning) {
      console.log(
        `\n${yellow("⚠")} Deployed to the ORIGIN NODE ONLY — peer replication did not converge and ` +
          `--ignore-replication-errors was set. The peer will need to catch up via federation sync or a later deploy.`,
      );
    }
    console.log(`\n${green("✓")} Fabric upgrade complete.`);

    // ── Post-upgrade fleet sweep (flair#636) ────────────────────────────────
    // "deploy complete" from harper's own CLI means "origin took it" — this
    // confirms every known federation peer actually converged on the version
    // we just deployed, instead of trusting a single boolean. Skippable with
    // --no-fleet-verify. fabricUser/fabricPassword are guaranteed set here —
    // the !check branch above already required both.
    if (!shouldRunFleetVerify(opts)) {
      console.log(dim("(--no-fleet-verify: skipping post-upgrade fleet sweep)"));
    } else {
      console.log(`\n${green("→")} Fleet verify`);
      const sweep = await sweepFleet({
        target: upgradeOpts.target,
        fabricUser: fabricUser as string,
        fabricPassword: fabricPassword as string,
        expectVersion: result.plan.targetVersion,
      });
      console.log(renderFleetSweepTable(sweep));
      const upgradeSweepFail = fleetSweepCallerExitMessage(sweep);
      if (upgradeSweepFail) {
        console.error(red(`\n✗ ${upgradeSweepFail}`));
        process.exit(sweep.exitCode);
      }
    }
  } catch (err: any) {
    console.error(red(`\n✗ fabric upgrade failed: ${err.message}`));
    const hint = err.message?.toLowerCase() ?? "";
    if (hint.includes("401") || hint.includes("unauthoriz")) {
      console.error(dim("  hint: check Fabric Studio → Cluster Settings → Admin for the admin password"));
    }
    // flair#878: harper's own replication error tells the operator to "pass
    // ignore_replication_errors: true" — until now there was no way to do that
    // through `flair upgrade`. Name the flag that actually does it, and the
    // one that turns off the retry that can make things worse.
    if (hint.includes("peer replication") || hint.includes("ignore_replication_errors")) {
      console.error(
        dim(
          "  hint: --ignore-replication-errors accepts an origin-only upgrade (the peer catches up via federation sync or a later deploy)",
        ),
      );
      console.error(
        dim(
          "  hint: --convergence-timeout <ms> waits longer for asynchronous replication before giving up (default 180000)",
        ),
      );
      console.error(
        dim(
          "  hint: --deploy-retries defaults to 0 — a retry can turn a transient replication warning into a hard install failure (flair#878)",
        ),
      );
    }
    process.exit(1);
  }
}

// ─── Pre-upgrade data snapshot (flair#637) ─────────────────────────────────
// `flair upgrade` used to swap @tpsdev-ai/flair's own package with no backup
// of ~/.flair/data — if an upgrade broke something past the package level
// (schema/data, not just code), there was no tested way back. This is cheap
// insurance: a timestamped tar.gz of the whole data directory taken right
// before the package swap, with a keep-last-3 retention policy.
//
// Native-backup alternative considered and rejected: Harper ships a
// `get_backup` operation (harper's dataLayer/getBackup.ts,
// wired in server/serverHelpers/serverUtilities.ts, documented in
// components/mcp/tools/schemas/operationDescriptions.ts) that streams a
// live backup over the running HTTP operations API. It's available in this
// OSS tier (no license/tier gate found in operation_authorization.ts — just
// `requires_su`), but it backs up ONE database/table at a time
// (GetBackupObject requires `schema`/`table`, or defaults to a single "data"
// database) — not the whole `~/.flair/data` tree: no config, no
// users/roles, no keys, no other schemas. Using it here would mean
// enumerating every schema/table and making N authenticated HTTP calls
// against a server this same command is about to take down — for a LESS
// complete result than a plain recursive file copy, and one that can't run
// at all once the server is stopped (it's an operations-API call, not a
// standalone filesystem utility). Rejected in favor of the file-level
// snapshot below. See docs/upgrade.md for the restore procedure this
// produces.
// UPGRADE_SNAPSHOT_ROOT is defined in engine-version.ts (the module that owns the path)
// and imported from there for all callers.

const UPGRADE_SNAPSHOT_RETAIN = 3;


function upgradeSnapshotFileName(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return `flair-data-${ts}.tar.gz`;
}

/**
 * Snapshot `dataDir` (normally ~/.flair/data) into a timestamped tar.gz
 * under ~/.flair/upgrade-snapshots/.
 *
 * Consistency: the caller is expected to have stopped Flair first (a
 * running Harper's data dir can be mid-write, and a plain file copy of a
 * live database directory isn't guaranteed point-in-time consistent —
 * Harper 5.x's engine is RocksDB, verified from the .sst/WAL/MANIFEST
 * layout under database/*, and a torn WAL/SST set won't open) — this
 * function itself doesn't stop anything, it just archives whatever is on
 * disk right now.
 *
 * Preserves file modes exactly — deliberately NOT using tar's `portable`
 * option (used elsewhere in this file for the deploy tarball and session
 * snapshots), which flattens every entry's mode to a umask-based "reasonable
 * default" and would turn 0600 key/admin-pass files into whatever that
 * default is. Never follows symlinks out of `dataDir`: node-tar already
 * archives symlinks as symlinks by default (no `follow` option set here),
 * and the filter below additionally skips any symlink whose resolved target
 * falls outside `dataDir`, plus any non-regular file (sockets, FIFOs, device
 * nodes — e.g. a stale `operations-server` domain socket left behind by a
 * prior run) that tar can't meaningfully archive anyway.
 *
 * Throws on any failure — `flair upgrade` treats a snapshot failure as
 * abort-the-upgrade by default (safe default; --no-snapshot is the opt-out
 * for hosts that can't spare the time/disk).
 *
 * `snapshotRoot` defaults to UPGRADE_SNAPSHOT_ROOT (~/.flair/upgrade-snapshots)
 * but is an explicit parameter — not read from homedir() internally — so
 * unit tests can point it at a throwaway temp dir instead of this machine's
 * real ~/.flair (test/unit/upgrade-data-snapshot.test.ts).
 */

export async function createDataSnapshot(
  dataDir: string,
  snapshotRoot: string = UPGRADE_SNAPSHOT_ROOT,
): Promise<{ path: string; bytes: number }> {
  mkdirSync(snapshotRoot, { recursive: true, mode: 0o700 });
  const snapshotPath = join(snapshotRoot, upgradeSnapshotFileName());
  // realpath, not just resolve() — on macOS (and some Linux distros) the
  // system temp dir itself sits behind a symlink (/tmp -> /private/tmp), so
  // a plain lexical resolve() of `dataDir` would never equal the realpath()
  // of a symlink target genuinely INSIDE it, misclassifying every in-bounds
  // symlink as an escape.
  const resolvedDataDir = realpathSync(resolve(dataDir));

  const filter = (entryPath: string): boolean => {
    // entryPath is relative to `cwd` (dataDir) per tar's create() contract.
    const abs = resolve(resolvedDataDir, entryPath);
    let st;
    try {
      st = lstatSync(abs);
    } catch {
      return false; // vanished between readdir and stat — skip, don't crash the snapshot
    }
    if (st.isSocket() || st.isFIFO() || st.isCharacterDevice() || st.isBlockDevice()) {
      console.error(`  (skipping non-regular file in snapshot: ${entryPath})`);
      return false;
    }
    if (st.isSymbolicLink()) {
      let real: string;
      try {
        real = realpathSync(abs);
      } catch {
        console.error(`  (skipping broken symlink in snapshot: ${entryPath})`);
        return false;
      }
      const withinDataDir = real === resolvedDataDir || real.startsWith(resolvedDataDir + sep);
      if (!withinDataDir) {
        console.error(`  (skipping symlink pointing outside the data dir: ${entryPath})`);
        return false;
      }
    }
    return true;
  };

  // preservePaths: true — WITHOUT it, node-tar strips the leading `/` off
  // any absolute symlink target it archives (found the hard way: an
  // in-bounds symlink pointing at an absolute path under `dataDir` came
  // back on extraction as a nonsense RELATIVE path, silently broken). Every
  // entry path here is already relative (fileList is `["."]`, cwd is
  // `dataDir`) — this only affects symlink target text, restoring it
  // verbatim, which is exactly what a same-host restore into the original
  // ~/.flair/data path needs.
  await tarCreate({ gzip: true, cwd: resolvedDataDir, file: snapshotPath, filter, preservePaths: true }, ["."]);
  // Owner-only — the archive can contain 0600 key/admin-pass material.
  chmodSync(snapshotPath, 0o600);
  return { path: snapshotPath, bytes: statSync(snapshotPath).size };
}

/**
 * Keep only the newest `retain` upgrade snapshots, deleting older ones.
 * Best-effort: a pruning failure is logged, not thrown — it must never
 * un-succeed an upgrade whose snapshot already landed safely on disk.
 * Returns the paths removed.
 *
 * `snapshotRoot` is explicit for the same testability reason as
 * `createDataSnapshot` above.
 */

export function pruneOldSnapshots(
  retain: number = UPGRADE_SNAPSHOT_RETAIN,
  snapshotRoot: string = UPGRADE_SNAPSHOT_ROOT,
): string[] {
  if (!existsSync(snapshotRoot)) return [];
  const removed: string[] = [];
  try {
    const files = readdirSync(snapshotRoot)
      .filter((f) => f.startsWith("flair-data-") && f.endsWith(".tar.gz"))
      .map((f) => join(snapshotRoot, f))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    for (const stale of files.slice(retain)) {
      try {
        rmSync(stale, { force: true });
        removed.push(stale);
      } catch (err: any) {
        console.error(`  (could not prune old snapshot ${stale}: ${err.message})`);
      }
    }
  } catch (err: any) {
    console.error(`  (snapshot retention check failed: ${err.message})`);
  }
  return removed;
}

/**
 * Decide what `flair upgrade`'s pre-upgrade snapshot step should do (opt-in
 * rewrite, 2026-07-08). Pure — takes the booleans the action already
 * computes and returns the branch to take, without performing any I/O. Pulled
 * out of the action itself so the gating logic (default = no snapshot, no
 * abort; --snapshot = same abort-on-failure mechanism as before) is directly
 * unit-testable instead of only reachable via a full `flair upgrade` run
 * (test/unit/upgrade-data-snapshot.test.ts).
 *
 * flair#1047 / flair#1050: the opt-in default is correct for same-engine
 * upgrades — the downgrade-boot test (test/compat/downgrade-boot.test.ts)
 * covers those, and the restated invariant ("no silent bad outcome") holds.
 * When the engine (Harper) version is changing, the snapshot is unconditional
 * — the tested-downgrade guarantee does not hold across engine version
 * boundaries, and the backwards-boot refusal + snapshot recovery path is the
 * invariant that applies. Opting out of the engine-change snapshot requires
 * `--no-engine-snapshot` and prints what is being given up.
 *
 *   - "not-upgrading": @tpsdev-ai/flair isn't one of the packages being
 *     upgraded (or --snapshot wasn't requested and there's no data dir to
 *     nudge about) — nothing to do, no output.
 *   - "nudge": --snapshot wasn't passed (the default) and a data dir exists —
 *     print the non-blocking recommendation, do NOT snapshot, do NOT abort.
 *   - "no-data": --snapshot was passed but there's no data dir yet — nothing
 *     to snapshot.
 *   - "snapshot": --snapshot was passed and there's data — run the real
 *     stop/snapshot/prune/restart flow, aborting the upgrade on failure.
 *   - "engine-version-change": the engine version is changing and the operator
 *     did not pass --no-engine-snapshot — same as "snapshot" but the message
 *     names the reason (engine version change, not --snapshot flag).
 */

export type UpgradeSnapshotDecision = "not-upgrading" | "nudge" | "no-data" | "snapshot" | "engine-version-change";


export function decideUpgradeSnapshotAction(
  flairIsUpgrading: boolean,
  snapshotRequested: boolean,
  hasDataDir: boolean,
  engineVersionChanging?: boolean,
  engineSnapshotOptOut?: boolean,
): UpgradeSnapshotDecision {
  if (!flairIsUpgrading) return "not-upgrading";
  // Engine version change forces a snapshot unless explicitly opted out.
  if (engineVersionChanging && hasDataDir && !engineSnapshotOptOut) return "engine-version-change";
  if (!snapshotRequested) return hasDataDir ? "nudge" : "not-upgrading";
  return hasDataDir ? "snapshot" : "no-data";
}

/**
 * The exact non-blocking recommendation nudge printed when `flair upgrade`
 * runs without --snapshot (the default) and a data dir exists to snapshot.
 * Exported as a constant — not inlined in two places — so the CLI output and
 * its unit test assertion can't drift apart. Modeled on Harper's own
 * upgrade prompt ("if you have not created a backup of your data, we
 * recommend you cancel and back up before proceeding") but informational,
 * never blocking: this must stay safe for non-interactive/scripted upgrades.
 */

export const UPGRADE_SNAPSHOT_NUDGE_LINES: readonly string[] = [
  "No pre-upgrade snapshot will be taken.",
  "To capture one first: `flair snapshot create` (physical) or `flair backup` (logical export), or re-run with --snapshot.",
];

/**
 * Run the stop → snapshot → prune → restart dance for a pre-upgrade snapshot.
 * Extracted from the upgrade action so the --snapshot and engine-version-change
 * branches share the same mechanism (flair#1047).
 *
 * On snapshot failure: aborts the upgrade (process.exit(1)), restarting Flair
 * first if it was stopped. On restart-after-snapshot failure: also exits.
 */

async function runUpgradeSnapshot(port: number, dataDir: string): Promise<void> {
  // Consistency: a running Harper's data dir can be mid-write, and a
  // plain file copy of a live database directory isn't guaranteed
  // point-in-time consistent (Harper 5.x = RocksDB: WAL/SST/MANIFEST
  // can tear under a live copy). Stopping first — then immediately
  // restarting the OLD version, before any package changes — gives a
  // quiesced, safe-to-copy directory with only a brief blip, even for
  // --no-restart (the snapshot's correctness doesn't depend on
  // whether the caller wants a restart AFTER the upgrade — those are
  // orthogonal). See docs/upgrade.md for the native-backup alternative
  // considered and rejected (Harper's `get_backup` op backs up one
  // table/schema at a time over the running HTTP API — not the whole
  // data dir — and rejecting it here means this path never depends on
  // the server being up).
  let stoppedForSnapshot = false;
  let snapshotPath: string | null = null;
  try {
    await stopFlairProcess(port, dataDir);
    stoppedForSnapshot = true;
    const snapshot = await createDataSnapshot(dataDir);
    snapshotPath = snapshot.path;
    const removed = pruneOldSnapshots();
    console.log(`✅ Snapshot: ${snapshotPath} (${humanBytes(snapshot.bytes)})`);
    console.log(`   Restore: flair snapshot restore "${snapshotPath}"`);
    if (removed.length > 0) {
      console.log(`   Pruned ${removed.length} older snapshot${removed.length > 1 ? "s" : ""} (keeping last ${UPGRADE_SNAPSHOT_RETAIN})`);
    }
  } catch (err: any) {
    console.error(`❌ snapshot failed: ${err.message}`);
    console.error("   Aborting upgrade — no packages were changed.");
    if (stoppedForSnapshot) {
      try { await startFlairProcess(port, dataDir); } catch { /* best effort — surface the original snapshot error, not this */ }
    }
    process.exit(1);
  }
  try {
    await startFlairProcess(port, dataDir);
  } catch (err: any) {
    console.error(`❌ failed to restart Flair after the pre-upgrade snapshot: ${err.message}`);
    console.error(`   The snapshot itself succeeded (${snapshotPath}) — no packages were changed. Check: flair doctor`);
    process.exit(1);
  }
}


function resolveHttpPortForDataDir(opts: { port?: string | number; dataDir?: string }): number {
  try {
    return resolveHttpPort(opts);
  } catch (err: any) {
    console.error(`❌ ${err?.message ?? err}`);
    process.exit(1);
  }
}


export function register(program: Command): void {
  const STARTUP_TIMEOUT_MS = cli.STARTUP_TIMEOUT_MS;

// ─── flair upgrade --target <fabric> ────────────────────────────────────────
//
// One-command upgrade of a Flair instance DEPLOYED to a Harper Fabric cluster.
// Mirrors `flair deploy`'s credential handling (FABRIC_USER/FABRIC_PASSWORD env
// fallbacks, password-via-flag warning, --fabric-password-file — see
// resolveFabricCredentials above) and NEVER prints credentials. The
// version-resolution + harper pin + reuse of deploy() lives in
// src/fabric-upgrade.ts; this wrapper only does CLI plumbing + the confirm.


// ─── flair snapshot ─────────────────────────────────────────────────────────
// Explicit, first-class surface for the physical data-dir snapshot mechanism
// above (createDataSnapshot / pruneOldSnapshots / UPGRADE_SNAPSHOT_ROOT).
// Added alongside the opt-in rewrite of `flair upgrade`'s snapshot trigger
// (2026-07-08) so taking one is a real command, not just a side effect of
// upgrading with --snapshot.
//
// Deliberately NOT named/shaped like `flair backup` / `flair restore`
// (further below) — those are a LOGICAL export/import of Agent/Memory/Soul
// records as JSON over the HTTP API, portable across hosts and versions.
// `flair snapshot` is a PHYSICAL, byte-exact tar.gz of the whole
// ~/.flair/data directory (RocksDB files, keys, config, admin-pass — every
// byte, same host, same version) taken with Flair stopped for consistency.
// Different mechanism, different restore procedure, different failure
// modes — hence its own namespace (`snapshot create|list|restore`) instead
// of overloading the JSON one. Mirrors the `rem snapshot` / `session
// snapshot` subcommand idiom used elsewhere in this file.

const snapshotCmd = program
  .command("snapshot")
  .description("Physical ~/.flair/data snapshots (byte-exact tar.gz, local-only — see `flair backup`/`flair restore` for the logical JSON export/import)");

/**
 * `resolveHttpPort` for a command that takes `--data-dir`, reported as a
 * message rather than a stack trace (flair#914).
 *
 * The throw is a refusal to guess which instance a directory is, and a refusal
 * has to tell the operator what to pass instead — a stack trace does not.
 */

snapshotCmd
  .command("create")
  .description("Take a physical snapshot of the Flair data directory now (briefly stops Flair for a consistent copy — use `flair backup` for a no-downtime logical export)")
  .option("--data-dir <path>", "Data directory to snapshot (default: ~/.flair/data)")
  .option("--port <port>", "Harper HTTP port (used to quiesce Flair around the snapshot)")
  .action(async (opts) => {
    const dataDir = opts.dataDir ? resolve(opts.dataDir) : defaultDataDir();
    // Existence first, THEN the port. A directory that isn't there has a more
    // specific diagnosis than "it doesn't say which port it serves", and the
    // caller should get the one that names the actual problem (flair#914).
    if (!existsSync(dataDir)) {
      console.error(`Error: data directory does not exist: ${dataDir}`);
      process.exit(1);
    }
    // flair#914: the port of the instance NAMED here, never the per-user
    // file's — refuses rather than guessing when that directory has no record.
    const port = resolveHttpPortForDataDir(opts);

    console.log(`Snapshotting ${dataDir}...`);
    console.log("(Flair will be briefly stopped for a point-in-time-consistent copy, then restarted.)");
    // Same consistency requirement as the upgrade path's snapshot step: a
    // live RocksDB directory (WAL/MANIFEST/SST) isn't safe to copy while
    // Flair is running, so this stops Flair, snapshots, and restarts it —
    // same stop/start helpers `flair upgrade`'s snapshot step uses, so a
    // standalone `flair snapshot create` gives the exact same
    // point-in-time-consistent guarantee, not a weaker one.
    let stoppedForSnapshot = false;
    try {
      // `dataDir`, not the default (flair#902) — quiesce the instance this
      // command was pointed at, never whichever one owns ~/.flair/data.
      await stopFlairProcess(port, dataDir);
      stoppedForSnapshot = true;
      const snapshot = await createDataSnapshot(dataDir);
      const removed = pruneOldSnapshots();
      console.log(`✅ Snapshot: ${snapshot.path} (${humanBytes(snapshot.bytes)})`);
      if (removed.length > 0) {
        console.log(`   Pruned ${removed.length} older snapshot${removed.length > 1 ? "s" : ""} (keeping last ${UPGRADE_SNAPSHOT_RETAIN})`);
      }
    } catch (err: any) {
      console.error(`❌ snapshot failed: ${err.message}`);
      if (stoppedForSnapshot) {
        try { await startFlairProcess(port, dataDir); } catch { /* best effort — surface the original snapshot error, not this */ }
      }
      process.exit(1);
    }
    try {
      await startFlairProcess(port, dataDir);
    } catch (err: any) {
      console.error(`❌ the snapshot succeeded but Flair failed to restart: ${err.message}`);
      console.error("   Check: flair doctor");
      process.exit(1);
    }
  });


snapshotCmd
  .command("list")
  .description("List physical data snapshots under ~/.flair/upgrade-snapshots/")
  .option("--json", "Output as JSON")
  .action((opts) => {
    if (!existsSync(UPGRADE_SNAPSHOT_ROOT)) {
      if (opts.json) { console.log("[]"); return; }
      console.log(`(no snapshots — ${UPGRADE_SNAPSHOT_ROOT} does not exist yet)`);
      console.log("Run `flair snapshot create` to make one, or `flair upgrade --snapshot` to take one automatically before an upgrade.");
      return;
    }
    const rows = readdirSync(UPGRADE_SNAPSHOT_ROOT)
      .filter((f) => f.startsWith("flair-data-") && f.endsWith(".tar.gz"))
      .map((f) => {
        const p = join(UPGRADE_SNAPSHOT_ROOT, f);
        const s = statSync(p);
        return { file: f, path: p, size: s.size, mtime: s.mtime.toISOString() };
      })
      .sort((a, b) => b.mtime.localeCompare(a.mtime));

    if (opts.json) { console.log(JSON.stringify(rows, null, 2)); return; }
    if (rows.length === 0) {
      console.log("(no snapshots)");
      return;
    }
    const fileW = Math.max(20, ...rows.map((r) => r.file.length));
    console.log(`  ${"file".padEnd(fileW)}  size      age`);
    for (const r of rows) {
      console.log(`  ${r.file.padEnd(fileW)}  ${humanBytes(r.size).padEnd(8)}  ${relativeTime(r.mtime)}`);
    }
    console.log(`\n${rows.length} snapshot${rows.length > 1 ? "s" : ""}.`);
  });


snapshotCmd
  .command("restore <path>")
  .description("Restore a physical snapshot: stops Flair, replaces the data directory, restarts")
  .option("--data-dir <path>", "Data directory to replace (default: ~/.flair/data)")
  .option("--port <port>", "Harper HTTP port")
  .option("--yes", "Skip the confirmation prompt (this destroys the current data directory)")
  .action(async (snapshotArg: string, opts) => {
    const snapshotPath = resolve(snapshotArg);
    if (!existsSync(snapshotPath)) {
      console.error(`Error: snapshot does not exist: ${snapshotPath}`);
      process.exit(1);
    }
    const dataDir = opts.dataDir ? resolve(opts.dataDir) : defaultDataDir();
    // flair#914: the port of the instance NAMED here, never the per-user
    // file's — refuses rather than guessing when that directory has no record.
    const port = resolveHttpPortForDataDir(opts);

    console.log("This will STOP Flair, DELETE the current data directory, and replace it with:");
    console.log(`  snapshot: ${snapshotPath}`);
    console.log(`  target:   ${dataDir}`);

    if (!opts.yes) {
      if (!process.stdin.isTTY) {
        console.error("\nError: refusing to destroy the data directory in a non-interactive shell without --yes.");
        process.exit(1);
      }
      const { createInterface } = await import("node:readline");
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer: string = await new Promise((res) =>
        rl.question(`\nDestroy ${dataDir} and restore from this snapshot? [y/N] `, (a) => { rl.close(); res(a); }),
      );
      if (!/^y(es)?$/i.test(answer.trim())) {
        console.log("Aborted.");
        return;
      }
    }

    try {
      // `dataDir`, not the default (flair#902) — the whole point of this
      // command's --data-dir is that it may name a scratch directory, and
      // stopping the default instance instead is how a cautious inspect-a-
      // snapshot-somewhere-else took production down.
      await stopFlairProcess(port, dataDir);
    } catch (err: any) {
      console.error(`❌ failed to stop Flair: ${err.message}`);
      process.exit(1);
    }

    // Validate the archive BEFORE the destructive rmSync below. Restore
    // accepts snapshots this CLI did not create — copied off another machine,
    // downloaded, handed over during a migration — so the archive is untrusted
    // input, and a hostile one must not cost the operator their data directory
    // on its way to being refused.
    try {
      await validateSnapshotArchive({ file: snapshotPath, targetDir: dataDir });
    } catch (err: any) {
      console.error(`❌ ${err.message}`);
      console.error(`   ${dataDir} was NOT modified.`);
      process.exit(1);
    }

    try {
      rmSync(dataDir, { recursive: true, force: true });
      mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      // extractSnapshotSafely keeps preservePaths: true — load-bearing for
      // symlink TARGET fidelity, mirroring createDataSnapshot — while doing
      // the entry-path containment that flag disables. See
      // src/lib/safe-snapshot-extract.ts for why the flag cannot simply be
      // dropped. No `follow` option, so symlinks extract as symlinks (never
      // their targets' contents), and file modes extract exactly as stored.
      await extractSnapshotSafely({ file: snapshotPath, targetDir: dataDir });
    } catch (err: any) {
      console.error(`❌ restore failed: ${err.message}`);
      console.error(`   ${dataDir} may be partially restored or empty — do not start Flair until this is resolved.`);
      process.exit(1);
    }

    // flair#914: a snapshot is a byte-exact copy of a data directory, so it
    // carries the SOURCE instance's harper-config.yaml, and the extract just
    // wrote it over this instance's. Between here and the boot below, that file
    // names the SOURCE's port — but nothing re-resolves in that window: `port`
    // was resolved before the extract and is handed to startFlairProcess
    // explicitly, and Harper rewrites http.port / operationsApi.network.port
    // from that spawn's environment as it boots. So the directory is
    // self-describing again the moment it is serving, without flair writing into
    // Harper's config to make it so.
    //
    // The port is a property of the instance, not of the data it serves. That
    // is also what keeps a snapshot from somewhere else out of the business of
    // naming ports on this host: restoring one to look at it cannot hand the
    // restored directory a port it did not have — the boot immediately below is
    // what settles the question, on this host's terms.
    try {
      await startFlairProcess(port, dataDir);
    } catch (err: any) {
      console.error(`❌ restore succeeded but Flair failed to restart: ${err.message}`);
      console.error("   Check: flair doctor");
      process.exit(1);
    }

    console.log(`✅ Restored ${dataDir} from ${snapshotPath}`);
    console.log("   Flair restarted. Verify: flair status && flair doctor");
  });

// ─── flair upgrade ────────────────────────────────────────────────────────────


program
  .command("upgrade")
  .description("Upgrade Flair — local packages by default, or a deployed Fabric with --target")
  .option("--check", "Only check for updates / show the plan, don't install or deploy")
  .option("--tree <dir>", "Upgrade this extracted package tree in place (npm pack / plain-tree lane). Default: the serving instance's packed tree when that is not the npm-global install")
  .option("--restart", "[deprecated] no-op — restart now happens automatically after upgrade; use --no-restart to opt out")
  .option("--no-restart", "Skip the restart after upgrade (stage new packages now, restart later)")
  .option("--no-verify", "Skip post-restart health/version/auth verification (default: verify — so a broken upgrade can't report success; see flair#635)")
  .option("--snapshot", "Take a pre-upgrade ~/.flair/data snapshot before the package swap, keep-last-3 retention (default: off — see `flair snapshot create` to take one by hand, or `flair backup` for a logical export; flair#637)")
  .option("--no-engine-snapshot", "Skip the pre-upgrade snapshot even when the Harper engine version is changing (flair#1047). The snapshot is automatic on engine-version changes because the tested-downgrade guarantee does not hold across engine boundaries. Opting out prints what is being given up.")
  .option("--all", "Show transitive packages (e.g. flair-client) in the listing — verbose mode for debugging dep versions")
  // ── Fabric upgrade (--target) ────────────────────────────────────────────
  // When --target is passed, upgrade the Flair component DEPLOYED to that
  // Harper Fabric URL instead of the local npm install. Reuses `flair deploy`
  // under the hood with the harper pin baked in (flair#513).
  .option("--target <url>", "Upgrade the Flair deployed to this Fabric URL (not the local install)")
  .option("--fabric-user <user>", "Fabric admin username — for --target (env: FABRIC_USER preferred; inline leaks to shell history)")
  .option("--fabric-password <pass>", "Fabric admin password — for --target (prefer FABRIC_PASSWORD env or --fabric-password-file; inline leaks to shell history)")
  .option("--fabric-password-file <path>", "Read the Fabric admin password from a file (chmod 600) — for --target")
  // NOT `--version` (flair#926). The program declares `-v, --version`, and
  // commander matches an option against the PARENT's list before dispatching to
  // the subcommand — so `flair upgrade --target X --version 1.2.3` printed the
  // CLI's own version and exited 0, never running the Fabric upgrade at all.
  // A colliding name is normally recoverable via optsWithGlobals(); this one is
  // not, because commander's version listener exits the process. The name had
  // to change. `--harper-version` below is the symmetry this follows.
  .option("--flair-version <semver>", "Flair version to deploy with --target, or to pin the plain-tree tarball swap (default: latest published @tpsdev-ai/flair)")
  .option("--harper-version <semver>", "Pin harper to this version for --target (default: registry latest, floored at the flair#513 fix)")
  .option("--project <name>", "Fabric component name for --target", "flair")
  .option("--no-replicated", "Disable cluster-wide replication for --target (default: replicated=true)")
  .option("--yes", "Skip the confirmation prompt for --target")
  .option("--install-hooks", "Consent to installing missing SessionStart hooks (claude-code / Codex) during upgrade. The hook executes at every session start — upgrade will not write it unprompted. Interactive runs prompt; non-interactive runs state the gap and withhold ✅ unless this flag is passed.")
  .option("--no-fleet-verify", "Skip the automatic post-upgrade fleet convergence sweep for --target (default: sweep runs — see flair#636)")
  // ── flair#878 ─────────────────────────────────────────────────────────────
  // These existed on `flair deploy` but stopped at the upgrade boundary, so
  // harper's own remedy ("pass ignore_replication_errors: true") was not
  // actually reachable through `flair upgrade --target`.
  .option("--deploy-retries <n>", "Retry the full harper deploy this many times for --target, ONLY when peer replication is positively observed not to converge (default: 0 — a retry can escalate a transient replication warning into a hard install failure; see flair#878)", "0")
  .option("--ignore-replication-errors", "For --target: if peer replication still hasn't converged, accept an origin-only deploy instead of failing (the peer catches up via federation sync or a later deploy)")
  .option("--no-convergence-check", "For --target: skip the post-replication-error convergence poll and fail on harper's error verbatim (default: poll — Harper replicates asynchronously, so its error is a snapshot, not a verdict; flair#878)")
  .option("--convergence-timeout <ms>", "For --target: how long to wait for peer replication to converge before reporting a replication failure (default: 180000)")
  .action(async (opts) => {
    // ── Fabric-upgrade branch ───────────────────────────────────────────────
    if (opts.target) {
      await runFabricUpgrade(opts);
      return;
    }

    const { execFileSync } = await import("node:child_process");
    const checkOnly = opts.check ?? false;
    const showAll = opts.all ?? false;

    console.log("Checking for updates...\n");

    // flair#1109 (a): if the serving tree (or --tree) is a packed extract,
    // take the in-place tarball lane instead of upgrading a leftover
    // npm-global relic. (b) still probes — and still prints — when we are
    // not taking that lane (git checkout, unknown path). Detection is
    // best-effort and never fails the command except an explicit --tree
    // that does not name a packed install (refuse, don't silently fall through).
    const upgradeServingPid = resolveInstanceServingPid(defaultDataDir(), resolveHttpPort({}));
    const upgradeNpmPrefix = await resolveNpmGlobalPrefix();
    let treeDecision: ReturnType<typeof resolvePlainTreeTarget> = { kind: "skip" };
    try {
      treeDecision = resolvePlainTreeTarget({
        treeFlag: typeof opts.tree === "string" && opts.tree.trim() !== "" ? opts.tree.trim() : null,
        serving: upgradeServingPid != null ? resolveServingFlairPackage(upgradeServingPid) : null,
        cli: findFlairPackageDir(flairPackageDir()),
        global: resolveNpmGlobalFlairPackage(upgradeNpmPrefix, process.platform),
      });
    } catch { /* treat as skip — never fail the probe */ }
    if (treeDecision.kind === "refuse") {
      console.error(`❌ ${treeDecision.message}`);
      process.exit(1);
    }
    const treeLane = treeDecision.kind === "use" ? treeDecision.inspection : null;

    // flair#1109 (b): print the mismatch warning only when this run will
    // still treat npm-global as the install. Collect always, so the (b)
    // wiring test keeps seeing the call.
    try {
      const execPathWarning = collectUpgradeExecPathWarning({
        servingPid: upgradeServingPid,
        cliPackageDir: flairPackageDir(),
        npmGlobalPrefix: upgradeNpmPrefix,
      });
      if (execPathWarning && !treeLane) {
        console.log(execPathWarning);
        console.log("");
      }
    } catch { /* never fail upgrade over a path probe */ }

    if (treeLane) {
      console.log(formatPlainTreeBanner(treeLane));
      console.log("");
    }

    // Per-package install probes. `npm list -g` assumed the default global
    // prefix and silently mis-reported "not installed" for anyone using
    // mise / fnm / nvm / volta / non-default-prefix npm — including the
    // running flair binary itself, which was obviously installed. Each
    // entry now has a locator that works regardless of install path:
    //
    //   - For packages with a bin: shell out to the bin with --version
    //     (same PATH lookup that got them invokable in the first place).
    //   - For library packages: require.resolve the package.json from the
    //     running flair's module graph (works whether it's a sibling
    //     global install or a bundled dep).
    //   - For openclaw plugins: read ~/.openclaw/extensions/<name>/package.json
    //     directly (the OpenClaw plugin install layout — not on $PATH, not in
    //     flair's module graph).
    //
    // Default UI shows the npm-global packages (flair, flair-mcp) plus
    // openclaw-flair WHEN openclaw is installed. On machines without openclaw
    // the openclaw-flair line is suppressed entirely rather than
    // nagging with an install hint for a plugin the user can't use. flair-client
    // is a transitive dep of flair-mcp and showing it as a top-level upgrade
    // item invites a misleading "❔ missing — install with npm install -g"
    // suggestion for users who installed flair without flair-mcp.
    // --all opts in to both flair-client and the suppressed openclaw line.
    type ProbeKind = "bin" | "lib" | "openclaw-plugin";
    const packages: Array<{
      name: string;
      probe: () => string | null;
      kind: ProbeKind;
      transitive?: boolean; // hide from default UI; shown only with --all
    }> = [
      {
        name: "@tpsdev-ai/flair",
        kind: "bin",
        // Same PATH-independence fix as flair-mcp below: when `flair` isn't on
        // PATH (a custom npm prefix — mise/fnm/nvm/volta, or the sudo-less
        // user-prefix install the README recommends), the bin probe returns
        // null even though the package IS globally installed, and `flair
        // upgrade` mis-reports "not detected → run npm install -g". Fall back
        // to the lib probe, which require.resolves the package.json regardless
        // of PATH or `--version` support. (Canary's 0.25.3 dogfooding caught
        // this — the fallback existed for flair-mcp but not for flair itself.)
        probe: () => probeBinVersion(execFileSync, "flair") ?? probeLibVersion("@tpsdev-ai/flair"),
      },
      {
        name: "@tpsdev-ai/flair-mcp",
        kind: "bin",
        // Older flair-mcp installs (e.g. 0.10.0) either aren't on PATH or
        // don't support `--version`, so the bin probe returns null even when
        // the package IS globally installed. Fall back to the lib
        // probe, which require.resolves the package.json from a sibling global
        // install regardless of PATH or --version support. kind stays "bin" so
        // it remains npm-upgradeable (npm install -g), not the openclaw path.
        probe: () => probeBinVersion(execFileSync, "flair-mcp") ?? probeLibVersion("@tpsdev-ai/flair-mcp"),
      },
      {
        name: "@tpsdev-ai/openclaw-flair",
        kind: "openclaw-plugin",
        probe: () => probeOpenclawPluginVersion("openclaw-flair"),
      },
      {
        name: "@tpsdev-ai/flair-client",
        kind: "lib",
        probe: () => probeLibVersion("@tpsdev-ai/flair-client"),
        transitive: true,
      },
    ];

    // Per-package status — see the UpgradeStatus type for the four states.
    type Status = UpgradeStatus;
    const findings: Array<{ name: string; installed: string | null; latest: string; status: Status; kind: ProbeKind }> = [];

    // flair#1692: name the registry (and where it came from) the moment it is
    // resolved, so a redirected registry is visible to the operator before
    // anything is fetched or installed. One line per distinct registry.
    const noticeRegistry = createRegistryNoticePrinter();

    // An explicit --flair-version pin is the operator's requested target (its
    // downgrade semantics are slice 2, flair#1778 D7) — when set, the
    // plain-tree lane keeps its existing explicit-target behaviour rather than
    // the direction-aware "ahead" gate.
    const flairVersionPin = typeof opts.flairVersion === "string" && opts.flairVersion.trim() !== ""
      ? opts.flairVersion
      : null;

    for (const { name, probe, kind, transitive } of packages) {
      if (transitive && !showAll) continue;
      try {
        let registryLatest: string | null = null;
        try {
          // flair#1688: resolve the registry npm is configured to use for this
          // package (scope mapping + .npmrc + env) instead of a hardcoded host.
          // flair#1692: print it, refuse disallowed schemes, disable redirects,
          // and validate the returned value as strict semver before it can be
          // used as an `npm install` spec.
          const lookup = await fetchLatestVersion(name, {
            timeoutMs: 5000,
            onRegistry: noticeRegistry,
          });
          if (lookup.kind === "ok") {
            registryLatest = lookup.version;
          } else if (lookup.kind === "invalid") {
            console.error(
              `  ⚠ ${name}: registry returned a non-semver "latest" (${JSON.stringify(lookup.value)}) ` +
                `from ${lookup.registry.url} — refusing to use it as an install spec.`,
            );
          } else if (lookup.kind === "refused") {
            console.error(lookup.message);
          }
          // kind === "unavailable": offline/timed out — the pin path must still work.
        } catch { /* /latest timed out or failed — pin path must still work */ }

        let latest: string;
        if (treeLane && name === FLAIR_PKG_NAME) {
          // Consult registry latest, then apply --flair-version as the swap
          // target. A pin still applies when /latest is unavailable; without
          // that, a requested tarball swap reports up to date and does nothing.
          const listing = resolvePlainTreeListingTarget({
            registryLatest,
            pin: flairVersionPin,
          });
          if (!listing) continue;
          latest = listing.version;
        } else {
          if (!registryLatest) continue;
          latest = registryLatest;
        }
        // flair#1692: a non-semver target must never reach an install spec
        // (npm treats `pkg@<url>` as a remote tarball). This also covers the
        // operator pin on the plain-tree lane.
        if (!isStrictSemver(latest)) {
          console.error(
            `  ⚠ ${name}: refusing non-semver install target ${JSON.stringify(latest)} — expected a version like 1.2.3.`,
          );
          continue;
        }

        const globalProbe = probe();
        let installed: string | null;
        let status: Status;
        if (treeLane && name === FLAIR_PKG_NAME) {
          // The serving/CLI packed tree is the install. A PATH or
          // require.resolve probe would report the npm-global relic.
          installed = treeLane.version;
          if (installed === null) status = "missing";
          // An explicit --flair-version pin IS the requested target (slice 2
          // owns its downgrade semantics) — do not gate it. Without a pin,
          // classify by semver direction so an install ahead of registry
          // latest is never mistaken for an upgrade (flair#1778).
          else if (flairVersionPin !== null) status = installed === latest ? "current" : "outdated";
          else status = classifyInstalledVersion(installed, latest);
        } else if (name === FLAIR_MCP_PACKAGE) {
          // flair-mcp is zero-install via npx (#1168) — a null global probe is
          // the NORMAL state, not "missing". Resolve it from its actual wiring
          // (the pin in a client MCP config / the SessionStart hook) so the
          // listing is truthful and the remedy actually works (flair#1208).
          const home = process.env.HOME ?? homedir();
          ({ installed, status } = resolveFlairMcpFinding(globalProbe, latest, detectWiredFlairMcp(home)));
        } else {
          installed = globalProbe;
          if (installed === null) {
            // openclaw-plugin packages are optional — if openclaw isn't
            // installed, don't surface a misleading "install with npm" advice.
            status = kind === "openclaw-plugin" ? "optional" : "missing";
          } else {
            // Direction-aware (flair#1778): an install ahead of latest is a
            // distinct state, never rendered as an upgrade, never installed.
            status = classifyInstalledVersion(installed, latest);
          }
        }
        findings.push({ name, installed, latest, status, kind });

        // flair#1778 D5: prime the version-check cache with the EFFECTIVE
        // target. When the install is AHEAD of latest nothing will be installed,
        // so priming `latest` would make a later version check nudge a
        // downgrade.
        if (name === FLAIR_PKG_NAME) {
          const effectiveTarget = status === "ahead" ? installed : latest;
          if (effectiveTarget) {
            try { primeVersionCheckCache(effectiveTarget); } catch { /* best-effort */ }
          }
        }

        // Suppress the line for openclaw plugins that are optional-because-
        // openclaw-is-absent: on machines without openclaw the
        // "○ … not installed (openclaw not detected) → … (install via …)"
        // line is pure noise. Still print it when openclaw IS installed
        // (current/outdated) or under --all.
        if (!shouldPrintUpgradeLine(status, showAll)) continue;

        // ONE renderer (src/lib/upgrade-status.ts). An install AHEAD of latest
        // prints with NO arrow and NO remedy (flair#1778); an unparseable
        // installed version prints the raw string as "❔ unknown".
        const suffix = upgradeStatusSuffix(name, status);
        console.log(formatUpgradeStatusLine({ name, installed, latest, status, suffix }));
      } catch { /* skip unavailable packages */ }
    }

    // Scope footer: make explicit what `flair upgrade` does and
    // doesn't cover, so "were the others checked?" has a one-line answer.
    if (treeLane) {
      console.log(`\n${formatPlainTreeScopeFooter(treeLane)}`);
    } else {
      console.log("\nScope: npm-global packages (flair, flair-mcp) + openclaw plugins. Other integrations (pi-flair, langgraph-flair, n8n-nodes-flair, hermes-flair) upgrade in their own ecosystems (pi / pip / n8n).");
    }

    const outdated = findings.filter((f) => f.status === "outdated");
    const missing = findings.filter((f) => f.status === "missing");
    // flair-mcp is refreshed by re-pinning its wiring (`flair doctor --fix` /
    // the post-upgrade pin refresh below), NEVER `npm install -g` — a global
    // bin does nothing for an `npx -y -p @tpsdev-ai/flair-mcp` invocation
    // (#1168/#1208). So a stale-pinned flair-mcp drives a remedy line, not the
    // npm-install + restart transaction. It is kept out of npmUpgrades here and
    // surfaced separately below.
    const flairMcpOutdated = outdated.find((f) => f.name === FLAIR_MCP_PACKAGE) ?? null;
    // openclaw plugins upgrade through `openclaw plugins install`, not `npm
    // install -g` (npm-installed wouldn't connect to OpenClaw's gateway slot).
    // Split outdated into npm-upgradeable vs openclaw-plugin so we can use
    // the right command for each.
    const npmUpgrades = outdated
      .filter((f) => f.kind !== "openclaw-plugin" && f.name !== FLAIR_MCP_PACKAGE)
      .map(({ name, installed, latest }) => ({ pkg: name, installed: installed ?? "unknown", latest }));
    const openclawUpgrades = outdated
      .filter((f) => f.kind === "openclaw-plugin")
      .map(({ name, installed, latest }) => ({ pkg: name, installed: installed ?? "unknown", latest }));
    const totalUpgrades = npmUpgrades.length + openclawUpgrades.length;

    let treePlan: PlainTreeUpgradePlan | null = null;
    if (treeLane) {
      const flairFindingForPlan = findings.find((f) => f.name === FLAIR_PKG_NAME);
      // flair#1778 D3: CONSTRUCT the plan only when flair is actually being
      // upgraded. Downstream restart/rollback/cleanup key on `treePlan`'s
      // presence, so a plan built for an install that is not changing would
      // stage a swap that never happens.
      if (flairFindingForPlan?.status === "outdated") {
        // flair#1758: unit discovery is captured HERE, into the plan, while
        // apply later renames the selected canonical tree
        // (applyPlainTreeUpgrade). A concurrent symlink retarget between
        // discovery and apply can therefore make the restart launch a
        // DIFFERENT tree than the one that matched. Resolving both sides fresh
        // narrows the window; it is not transaction locking.
        treePlan = planPlainTreeUpgrade({
          treeDir: treeLane.dir,
          fromVersion: treeLane.version,
          toVersion: flairFindingForPlan.latest,
          systemdUnits: findSystemdUnitsForTree(treeLane.dir),
        });
        console.log("");
        console.log(formatPlainTreePlan(treePlan));
      }
    }

    if (outdated.length === 0 && missing.length === 0) {
      // An install AHEAD of latest is not an upgrade (flair#1778): say "No
      // upgrades available" rather than "Everything is up to date", which would
      // claim a convergence we cannot see.
      const anyAhead = findings.some((f) => f.status === "ahead");
      console.log(anyAhead ? "\nNo upgrades available." : "\n✅ Everything is up to date.");
      return;
    }

    // ONE pin-refresh implementation, two callers (flair#1324): the post-
    // install refresh below (#1135/#1167), and the stale-pin-only path — when
    // flair-mcp's wired pin is behind latest but no package needs installing,
    // `flair upgrade` refreshes the pin itself instead of advising a
    // `doctor --fix` round-trip. Only refreshes clients that are ALREADY
    // wired — never wires new ones. Best-effort: failures warn but never fail
    // the upgrade.
    async function refreshWiredMcpClientPins(targetPort: number): Promise<void> {
      const agentId = resolveAgentIdOrEnv({}) ?? (() => {
        try {
          const kd = defaultKeysDir();
          const keyFiles = readdirSync(kd).filter((f) => f.endsWith(".key"));
          // Node-scoped federation keys aren't agents (flair#1193) — never
          // pin-refresh a connector as one.
          const agentKeyFile = keyFiles.find((f) => !isNodeKeyId(f.replace(/\.key$/, ""), kd));
          return agentKeyFile ? agentKeyFile.replace(/\.key$/, "") : null;
        } catch { return null; }
      })();
      // flair#1485: one catalogue (listOwnedPinTargets) for every file we
      // pin — MCP client configs AND SessionStart hooks. A missing agent id
      // skips MCP only; hook re-pin reads the agent from the existing command
      // and must still run (the early return here used to leave hooks stale).
      if (!agentId) {
        console.log("\n   (no agent id known — skip MCP client pin refresh; SessionStart hooks still re-pin)");
      }
      const homeDir = process.env.HOME || process.env.USERPROFILE || homedir();
      const results = refreshOwnedPins({
        homeDir,
        agentId: agentId ?? null,
        flairUrl: `http://127.0.0.1:${targetPort}`,
      });
      const noteworthy = results.filter(ownedPinRefreshShouldReport);
      if (noteworthy.length === 0) return;
      console.log("\n   Refreshing MCP client and SessionStart hook pins...");
      for (const r of noteworthy) {
        console.log(`   ${r.ok ? "✓" : "•"} ${r.message}`);
      }
    }

    // Nothing to install via npm/openclaw. What is left is advisory (packages
    // not detected) and/or a flair-mcp whose wired pin is behind latest. The
    // stale pin is `flair upgrade`'s OWN job (flair#1324): refresh it right
    // here rather than bouncing the user to `flair doctor --fix` — advice
    // that was both roundabout and, until #1324, routed every upgrading user
    // through doctor's consent hazard. Under --check, only say what a real
    // run will do. `npm install -g` remains wrong for flair-mcp either way
    // (#1168/#1208).
    if (totalUpgrades === 0) {
      if (missing.length > 0) {
        const npmMissing = missing.filter((f) => f.name !== FLAIR_MCP_PACKAGE);
        const mcpMissing = missing.some((f) => f.name === FLAIR_MCP_PACKAGE);
        console.log(`\n❔ ${missing.length} package${missing.length > 1 ? "s" : ""} not detected — all detected packages are up to date.`);
        if (npmMissing.length > 0) {
          console.log(`   Install missing: npm install -g ${npmMissing.map((f) => f.name).join(" ")}`);
        }
        if (mcpMissing) {
          console.log(`   flair-mcp is zero-install via npx — run: flair doctor --fix to wire the hook`);
        }
      }
      if (flairMcpOutdated) {
        console.log(`\n⬆️  flair-mcp is wired via npx (pinned ${flairMcpOutdated.installed} → latest ${flairMcpOutdated.latest}).`);
        if (checkOnly) {
          console.log("   Run: flair upgrade (refreshes the pin)");
        } else {
          await refreshWiredMcpClientPins(resolveHttpPort({}));
        }
      }
      return;
    }

    if (checkOnly) {
      const treeHint = typeof opts.tree === "string" && opts.tree.trim() !== ""
        ? ` --tree ${opts.tree.trim()}`
        : treeLane ? ` --tree ${treeLane.dir}` : "";
      console.log(`\n${outdated.length} update${outdated.length > 1 ? "s" : ""} available. Run: flair upgrade${treeHint}`);
      if (missing.length > 0) {
        console.log(`${missing.length} package${missing.length > 1 ? "s" : ""} not detected${missing.length > 0 ? ": " + missing.map((f) => f.name).join(", ") : ""}.`);
      }
      return;
    }

    // Hoisted here (was previously computed after install/restart) — the
    // pre-upgrade snapshot below needs to know the target port AND whether a
    // restart is coming, before any package is touched. Pure function of
    // `opts` — safe to call this early.
    const { restart: shouldRestart, verify: shouldVerify, deprecatedRestartFlagUsed } =
      resolveUpgradeRestartVerify(opts);
    const upgradePort = resolveHttpPort({});
    // The instance this upgrade is about, named once next to its port
    // (flair#902). `flair upgrade` has no --data-dir, so this IS the default
    // install — but stop/start/restart now take the directory explicitly, so
    // the choice is made here in the open rather than assumed inside them.
    // A default that happens to be right is the same defect waiting for the
    // next caller.
    const upgradeDataDir = defaultDataDir();
    // Hoisted so the pre-flight check (below) and the post-restart/rollback
    // verification steps (further down) all target the same URL — upgrade
    // never restarts Flair onto a different port.
    const baseUrl = `http://127.0.0.1:${upgradePort}`;

    // ── Credential pre-flight (flair#741 fix #1) ────────────────────────────
    // Post-restart verification (below) needs to authenticate against the
    // running instance. If it can't do that RIGHT NOW, against the CURRENT,
    // pre-upgrade instance, every upgrade on this machine is structurally
    // doomed before a single package is touched: post-restart verify fails
    // for the exact same credential reason, the rollback fires, and the
    // rollback's own re-verify fails identically — producing "ROLLBACK ALSO
    // FAILED VERIFICATION / state UNKNOWN" for an instance that was healthy
    // the entire time. That is exactly the flair#741 incident report (a
    // real 0.22.0→0.22.1 upgrade, healthy Flair, no ~/.flair/admin-pass, no
    // FLAIR_ADMIN_PASS). Catch it here, before any mutation, with a message
    // that says plainly: nothing was touched.
    //
    // Runs the SAME verification call (probeInstance + the agent-key-aware
    // verifyAuthedGet, fix #2) that post-restart verification uses below —
    // just against the pre-upgrade instance, with no expectVersion (there's
    // no target version to compare against yet; the question here is purely
    // "does an authenticated read work at all").
    //
    // Gated on --verify (shouldVerify): this check exists ONLY to keep
    // post-restart verification honest. A user who already opted out of
    // that verification with --no-verify has no use for a pre-flight that
    // protects it, and blocking their upgrade on a check they didn't ask
    // for would be a new, surprising failure mode of its own.
    //
    // Deliberately does NOT abort when the pre-flight instance is merely
    // UNREACHABLE (down/timeout) rather than reachable-but-unauthenticated.
    // `flair upgrade` may be the user's way of FIXING a down instance (bad
    // code on disk that a newer version resolves) — today's behavior
    // (pre-flair#741, no pre-flight at all) already lets that proceed, and
    // a new hard block here would take away a legitimate recovery path for
    // a failure mode this issue was never about. Only the specific
    // "server responded, credentials didn't work" case is structurally
    // doomed in a way a fresh install/restart can't fix on its own — so
    // only that case aborts. (If a down instance turns out to ALSO lack
    // credentials, that surfaces the normal way: post-restart verification
    // fails and rolls back, same as any other post-restart failure.)
    if (shouldVerify) {
      const preflight = await probeInstance(baseUrl, {
        // A short, bounded budget — this instance is presumed already
        // running (upgrade's normal case); doctor's probePort convention
        // (probeFlairReachable's doc comment) uses the same ~3s ballpark
        // for "is anything there at all" checks.
        timeoutMs: 3000,
        pollIntervalMs: 300,
        authedGet: (path) => verifyAuthedGet(baseUrl, path, defaultKeysDir()),
      });
      if (isCredentialOnlyFailure(preflight)) {
        console.error(`❌ pre-flight check failed: ${preflight.error}`);
        console.error("   Nothing has been touched — no packages were installed, no restart happened.");
        console.error("   The current instance is up and responded; the verifier just has no way to authenticate against it.");
        console.error("   Set FLAIR_ADMIN_PASS, or run `flair init` to provision ~/.flair/admin-pass or an agent key — then re-run flair upgrade.");
        console.error("   (--no-verify skips this check too, but post-restart verification would then fail the exact same way.)");
        process.exit(1);
      }
    }

    // ── Pre-upgrade data snapshot (flair#637, opt-in as of the 2026-07-08 rewire) ──
    // Only an @tpsdev-ai/flair package swap touches the code that reads/
    // writes ~/.flair/data — an flair-mcp-only or openclaw-plugin-only
    // upgrade never runs different Harper/Flair code against the data, so
    // there's nothing at risk and nothing to snapshot.
    //
    // Decision (Nathan, 2026-07-08): the physical snapshot used to run
    // automatically on every local upgrade (opt-out via --no-snapshot). That
    // defaulted every upgrade into tarring the entire data dir (can be
    // 800MB+, keep-last-3 retention ~2.5GB) for a failure mode the
    // tested-downgrade guarantee (docs/upgrade.md, test/compat/downgrade-
    // boot.test.ts) already covers — and it diverged from Harper's own
    // upgrade CLI, which recommends a backup before proceeding but never
    // auto-tars the data directory itself. `--snapshot` is now opt-in, off
    // by default; opting out gets a non-blocking recommendation nudge
    // instead of a silent skip. The underlying mechanism (createDataSnapshot
    // / pruneOldSnapshots, the stop-snapshot-restart quiesce dance, and
    // abort-the-upgrade-on-snapshot-failure) is unchanged — only the trigger
    // moved from opt-out to opt-in. `flair snapshot create` (below) exposes
    // the exact same mechanism as a standalone command for anyone who wants
    // one without wrapping it around an upgrade.
    //
    // flair#1047: the tested-downgrade guarantee does not hold across engine
    // version boundaries — a Harper bump is the only realistic source of a
    // cross-version boot break. When the engine version is changing, the
    // snapshot is unconditional. Opting out requires --no-engine-snapshot
    // and prints what is being given up.
    const flairIsUpgrading = npmUpgrades.some((u) => u.pkg === "@tpsdev-ai/flair");
    const hasDataDir = existsSync(upgradeDataDir);
    const flairFinding = findings.find((f) => f.name === "@tpsdev-ai/flair");

    // Determine whether the engine (Harper) version is changing.
    let engineVersionChanging = false;
    let currentEngineVersion: string | null = null;
    let targetEngineVersion: string | null = null;
    if (flairIsUpgrading && hasDataDir) {
      currentEngineVersion = readInstalledHarperVersion(treeLane?.dir ?? flairPackageDir());
      const targetFlairVersion = flairFinding?.latest;
      if (targetFlairVersion && currentEngineVersion) {
        targetEngineVersion = await fetchDeclaredHarperVersion(targetFlairVersion);
        if (targetEngineVersion === null) {
          // Registry lookup failed — cannot determine the target Harper
          // version. Assume it might change (safe default) and print why.
          engineVersionChanging = true;
          console.log(render.wrap(render.c.dim,
            `Could not determine the target Harper version from the npm registry — forcing a pre-upgrade snapshot as a precaution.`));
        } else {
          engineVersionChanging = targetEngineVersion !== currentEngineVersion;
        }
      } else {
        // Cannot determine — assume it might change (safe default).
        engineVersionChanging = true;
      }
    }

    const snapshotDecision = decideUpgradeSnapshotAction(
      flairIsUpgrading,
      !!opts.snapshot,
      hasDataDir,
      engineVersionChanging,
      !!opts.noEngineSnapshot,
    );
    let snapshotPath: string | null = null;
    if (snapshotDecision === "nudge") {
      // Non-blocking nudge only — never prompt/block here, this must stay
      // safe for non-interactive/scripted upgrades. Modeled on Harper's own
      // upgrade prompt ("if you have not created a backup ... we recommend
      // you cancel and back up before proceeding") but informational, not a
      // gate.
      console.log("");
      for (const line of UPGRADE_SNAPSHOT_NUDGE_LINES) console.log(render.wrap(render.c.dim, line));
    } else if (snapshotDecision === "no-data") {
      console.log(`\n(no data directory at ${upgradeDataDir} yet — nothing to snapshot)`);
    } else if (snapshotDecision === "engine-version-change") {
      // Engine version is changing — snapshot is unconditional (flair#1047).
      // The operator can opt out with --no-engine-snapshot, which prints what
      // is being given up (handled in the nudge branch above).
      const fromLabel = currentEngineVersion ?? "unknown";
      const toLabel = targetEngineVersion ?? "unknown";
      console.log(`\nHarper engine version changing (${fromLabel} → ${toLabel}) — snapshotting data before upgrade...`);
      console.log(render.wrap(render.c.dim, "The tested-downgrade guarantee does not hold across engine version boundaries."));
      console.log(render.wrap(render.c.dim, "Pass --no-engine-snapshot to skip this (not recommended)."));
      await runUpgradeSnapshot(upgradePort, upgradeDataDir);
    } else if (snapshotDecision === "snapshot") {
      console.log("\nSnapshotting data before upgrade...");
      await runUpgradeSnapshot(upgradePort, upgradeDataDir);
    }

    // Perform upgrade. `latest` comes from the npm registry's HTTP
    // response, so CodeQL (correctly) treats it as untrusted input.
    // Use execFileSync with argv — the spec `<name>@<version>` becomes a
    // single argument to the upgrade command, no shell to inject into.
    console.log(`\nUpgrading ${totalUpgrades} package${totalUpgrades > 1 ? "s" : ""}...\n`);
    // Tracked separately (rather than inferred from findings alone) because the
    // post-restart verify/rollback step below needs to know whether @tpsdev-ai/flair's
    // OWN install actually succeeded — if it failed, the running version is still the
    // OLD one and verification should expect that, not the target we failed to reach.
    let flairInstallFailed = false;
    for (const { pkg, latest } of npmUpgrades) {
      try {
        // flair#1692 backstop: the listing validated this, but the install is
        // the point of no return. npm accepts `pkg@<url>` as a remote-tarball
        // spec, so a non-semver target must never reach this argv.
        if (!isStrictSemver(latest)) {
          console.error(`  ❌ ${pkg} upgrade skipped: non-semver target ${JSON.stringify(latest)}`);
          if (pkg === FLAIR_PKG_NAME) flairInstallFailed = true;
          continue;
        }
        if (treePlan && pkg === FLAIR_PKG_NAME) {
          console.log(`  Fetching ${pkg}@${latest} (npm pack) and swapping ${treePlan.treeDir}...`);
          await applyPlainTreeUpgrade(treePlan);
          console.log(`  ✅ ${pkg}@${latest} installed (plain-tree swap; previous tree at ${treePlan.previousDir})`);
          continue;
        }
        console.log(`  Installing ${pkg}@${latest}...`);
        execFileSync("npm", ["install", "-g", `${pkg}@${latest}`], { stdio: "pipe" });
        console.log(`  ✅ ${pkg}@${latest} installed`);
      } catch (err: any) {
        console.error(`  ❌ ${pkg} upgrade failed: ${err.message}`);
        if (pkg === "@tpsdev-ai/flair") flairInstallFailed = true;
      }
    }
    for (const { pkg, latest } of openclawUpgrades) {
      // OpenClaw plugins upgrade via `openclaw plugins install --force --pin`.
      // Requires openclaw on PATH; if not, surface the manual recipe instead
      // of a confusing failure.
      try {
        execFileSync("openclaw", ["--version"], { stdio: "pipe", timeout: 2000 });
      } catch {
        console.error(`  ❌ ${pkg} upgrade skipped: openclaw not on PATH. Install manually: openclaw plugins install ${pkg}@${latest} --force --pin`);
        continue;
      }
      try {
        console.log(`  Installing ${pkg}@${latest} via openclaw...`);
        execFileSync("openclaw", ["plugins", "install", `${pkg}@${latest}`, "--force", "--pin"], { stdio: "pipe" });
        console.log(`  ✅ ${pkg}@${latest} installed`);
      } catch (err: any) {
        console.error(`  ❌ ${pkg} upgrade failed: ${err.message}`);
      }
    }

    // flair#1167: `npm install -g` replaced package.json in-place, so the
    // module-load-cached CLI version is stale. Clear it so mcpServerSpec()
    // resolves the NEW version for the pin refresh below.
    clearFlairCliVersionCache();

    // ── Refresh wired MCP client configs (flair#1135, flair#1167) ──────────
    // After a successful package install, the flair-mcp package on disk is
    // newer than the pinned version in wired client configs. Re-run wiring for
    // already-wired clients so the pin stays in lockstep with the installed
    // version. Runs BEFORE the restart so --no-restart and --no-verify paths
    // also get the refresh (flair#1167). Best-effort: failures warn but never
    // fail the upgrade.
    await refreshWiredMcpClientPins(upgradePort);

    // ── Restart + verify + rollback (flair#635) ─────────────────────────────
    // Decision (2026-07-08): restart is now the default post-upgrade step —
    // installing new code without restarting leaves the OLD process serving
    // while the version on disk lies about what's actually running.
    // --no-restart opts back out for the "stage now, bounce later" case.
    // --restart is kept as a deprecated no-op for old muscle memory.
    // Upgrade = install → restart → verify → (rollback on failure), one
    // transaction — never report success on a broken restart.
    const previousFlairVersion = flairFinding?.installed ?? null;
    const expectedFlairVersion =
      flairFinding?.status === "outdated" && !flairInstallFailed
        ? flairFinding.latest
        : flairFinding?.installed ?? null;

    // shouldRestart/shouldVerify/deprecatedRestartFlagUsed were hoisted above
    // the pre-upgrade snapshot block — it needs to know these before any
    // package is touched.
    if (deprecatedRestartFlagUsed) {
      console.error("warning: --restart is deprecated and is now a no-op — flair upgrade restarts by default. Use --no-restart to skip it.");
    }

    if (!shouldRestart) {
      console.log("\nRun: flair restart to use the new version");
      if (treePlan) {
        console.log(`Previous tree kept at ${treePlan.previousDir} until you restart and verify.`);
      }
      return;
    }

    console.log("\nRestarting Flair...");
    const port = upgradePort;
    // baseUrl was hoisted above (pre-flight, fix #1) — same URL, no redeclaration.

    /**
     * Roll @tpsdev-ai/flair back to `toVersion`, restart on it, re-verify, and
     * exit. Shared by the two ways an upgrade can fail after the package swap:
     * the restart itself (flair#905) and post-restart verification (flair#635).
     *
     * flair#905 found the restart leg wired straight to `process.exit(1)` — so
     * `docs/upgrade.md`'s "install → restart → verify → rollback-on-failure, in
     * one step" was only ever true for the verify leg. An upgrade that installed
     * new packages and then failed to start them left the operator on the new
     * version with nothing running and no rollback, which is the one outcome the
     * whole transaction exists to prevent.
     */
    const rollbackTo = async (toVersion: string, reason: string): Promise<never> => {
      console.log(`\nRolling back @tpsdev-ai/flair to ${toVersion}...`);
      try {
        if (treePlan) {
          const rollbackDecision = decidePlainTreeRollback(existsSync(treePlan.previousDir));
          if (rollbackDecision.kind === "restore") {
            if (!restorePlainTreePrevious(treePlan)) {
              throw new Error(`no previous tree at ${treePlan.previousDir} to restore`);
            }
            console.log(`  ✅ restored previous tree from ${treePlan.previousDir}`);
          } else {
            console.log(`   (${rollbackDecision.reason})`);
          }
        } else {
          execFileSync("npm", ["install", "-g", `@tpsdev-ai/flair@${toVersion}`], { stdio: "pipe" });
        }
      } catch (err: any) {
        console.error(`❌ rollback install failed: ${err.message}`);
        console.error(`   Flair is currently on the FAILED version (${expectedFlairVersion ?? "unknown"}) and is NOT running.`);
        const prevExists = !!(treePlan && existsSync(treePlan.previousDir));
        console.error(treePlan
          ? (prevExists
            ? `   Recover by hand: restore ${treePlan.previousDir} to ${treePlan.treeDir} && flair start`
            : `   The live tree at ${treePlan.treeDir} was not swapped; there is no .upgrade-prev to restore. Start it with: flair start`)
          : `   Recover by hand: npm install -g @tpsdev-ai/flair@${toVersion} && flair start`);
        process.exit(1);
      }

      // flair#1053: when the engine (Harper) version changed, the pre-upgrade
      // snapshot is the ONLY way back — the old Harper cannot read data written
      // by the new one (e.g. 5.2 LZ4-compressed storage is unreadable by 5.1).
      // Restore it before restarting, or refuse loudly when none exists.
      if (engineVersionChanging) {
        if (snapshotPath) {
          console.log(`\nEngine version changed — restoring pre-upgrade snapshot before rollback...`);
          console.log(`  snapshot: ${snapshotPath}`);
          console.log(`  target:   ${upgradeDataDir}`);
          try {
            await validateSnapshotArchive({ file: snapshotPath, targetDir: upgradeDataDir });
            rmSync(upgradeDataDir, { recursive: true, force: true });
            mkdirSync(upgradeDataDir, { recursive: true, mode: 0o700 });
            await extractSnapshotSafely({ file: snapshotPath, targetDir: upgradeDataDir });
            console.log(`  ✅ snapshot restored`);
          } catch (err: any) {
            console.error(`❌ snapshot restore failed: ${err.message}`);
            console.error(`   @tpsdev-ai/flair@${toVersion} is installed but the data directory could not be restored.`);
            console.error(`   The snapshot itself is intact at ${snapshotPath} — restore it by hand:`);
            console.error(`   flair snapshot restore "${snapshotPath}"`);
            console.error(`   Then: flair start`);
            process.exit(1);
          }
        } else {
          // No snapshot exists — the old Harper WILL NOT BOOT against the new
          // data. Refuse loudly rather than attempting a guaranteed failure.
          console.error(`\n❌ Cannot roll back: the Harper engine version changed (${currentEngineVersion ?? "?"} → ${targetEngineVersion ?? "?"}) and no pre-upgrade snapshot exists.`);
          console.error(`   The old Harper cannot read data written by the new engine — restarting without a snapshot restore would fail.`);
          console.error(`   @tpsdev-ai/flair@${toVersion} is installed but NOT running.`);
          if (snapshotDecision === "nudge") {
            console.error(`   A snapshot was skipped because --no-engine-snapshot was passed.`);
            console.error(`   Recovery options:`);
            console.error(`   1. Re-upgrade to the version that wrote this data: npm install -g @tpsdev-ai/flair@${expectedFlairVersion ?? "latest"} && flair start`);
            console.error(`   2. Restore from a ` + "`flair backup`" + ` JSON export on a fresh data directory.`);
          } else {
            console.error(`   No snapshot was taken (data directory may not have existed, or the snapshot step was skipped).`);
            console.error(`   Recovery: re-upgrade to the version that wrote this data, or restore from a ` + "`flair backup`" + ` JSON export.`);
          }
          process.exit(1);
        }
      }

      // Same post-swap rule as the upgrade restart above: the rolled-back
      // version's own CLI is the thing that knows how to start it.
      const rolledBackRoot = treePlan?.treeDir ?? flairPackageDir();
      const rolledBackCli = resolveInstalledFlairCli(rolledBackRoot, toVersion);
      try {
        if (treePlan && treePlan.systemdUnits.length > 0) {
          console.log(`  (restarting systemd unit: ${treePlan.systemdUnits.map((u) => u.name).join(", ")})`);
          restartSystemdUnits(treePlan.systemdUnits);
        } else {
          await restartAfterUpgrade(port, upgradeDataDir, rolledBackCli.ok ? rolledBackCli : null);
        }
      } catch (err: any) {
        console.error(`❌ rollback restart failed: ${err.message}`);
        console.error(`   @tpsdev-ai/flair@${toVersion} is installed but NOT running. Start it with: flair start`);
        console.error("   Then check: flair status");
        process.exit(1);
      }

      const rollbackVerify = await probeInstance(baseUrl, {
        expectVersion: toVersion,
        timeoutMs: STARTUP_TIMEOUT_MS,
        authedGet: (path) => verifyAuthedGet(baseUrl, path, defaultKeysDir()),
      });
      const rollbackVerdict = decideAfterRollbackVerify(rollbackVerify);
      if (rollbackVerdict.kind === "rolled-back") {
        console.error(`❌ upgrade failed and was rolled back to @tpsdev-ai/flair@${toVersion} (running, verified).`);
        console.error(`   Original failure: ${reason}`);
        process.exit(1);
      }

      console.error(`❌❌ ROLLBACK ALSO FAILED VERIFICATION: ${rollbackVerdict.reason}`);
      // flair#741 fix #3: this is the exact incident report — a 403 from a
      // responding, healthy server (credentials-only failure) was printed as
      // "state UNKNOWN — do not assume data integrity" for BOTH the upgrade
      // verify AND the rollback re-verify, because the same missing-auth-
      // material condition rejects both. Reserve the UNKNOWN/do-not-assume
      // text for failures where the instance's real state genuinely can't be
      // determined (connection refused, timeout, 5xx) — a credential-only
      // failure here means the rollback likely landed fine and the checker
      // simply can't prove it.
      if (isCredentialOnlyFailure(rollbackVerify)) {
        console.error("   The instance is up and responding — the verifier could not authenticate (credentials, not the rollback, are the problem).");
        console.error("   Set FLAIR_ADMIN_PASS, or run `flair init` to provision ~/.flair/admin-pass or an agent key, then check: flair doctor");
      } else {
        console.error("   Instance state is UNKNOWN — do not assume data integrity.");
      }
      // This double-failure isn't auto-recoverable yet (flair#637) — but if a
      // pre-upgrade snapshot landed, point at the CONCRETE path instead of
      // just the issue number, so recovery doesn't start with a GitHub search.
      if (snapshotPath) {
        console.error(`   A pre-upgrade snapshot is available: ${snapshotPath}`);
        console.error(`   Restore: flair snapshot restore "${snapshotPath}" (or see docs/upgrade.md#downgrade).`);
      } else {
        console.error("   No pre-upgrade snapshot was taken for this run (snapshot is opt-in — pass --snapshot next time, or ~/.flair/data didn't exist yet).");
        console.error("   Check `flair snapshot list` for a manual one, or restore from a `flair backup` JSON export. See docs/upgrade.md#downgrade.");
      }
      process.exit(1);
    };

    // flair#905: hand the restart to the CLI that was just installed, resolved
    // from disk AFTER the swap. `null` (flair itself wasn't swapped, or the new
    // tree can't be verified) falls back to an in-process restart, announced.
    const flairWasSwapped = flairIsUpgrading && !flairInstallFailed;
    const swappedPackageRoot = treePlan?.treeDir ?? flairPackageDir();
    let newCli: { cliPath: string; version: string } | null = null;
    if (flairWasSwapped) {
      const resolved = resolveInstalledFlairCli(swappedPackageRoot, expectedFlairVersion);
      if (resolved.ok === false) {
        console.error(`warning: could not verify the newly installed CLI (${resolved.reason}) — restarting with this process's own code instead.`);
      } else {
        newCli = { cliPath: resolved.cliPath, version: resolved.version };
      }
    }

    let restartWasDelegated = false;
    try {
      if (treePlan && treePlan.systemdUnits.length > 0) {
        console.log(`  (restarting systemd unit: ${treePlan.systemdUnits.map((u) => u.name).join(", ")})`);
        restartSystemdUnits(treePlan.systemdUnits);
        restartWasDelegated = true;
        console.log("✅ Flair restarted (systemd unit)");
      } else {
        restartWasDelegated = await restartAfterUpgrade(port, upgradeDataDir, newCli);
      }
    } catch (err: any) {
      console.error(`❌ restart failed: ${err.message}`);
      console.error("   Flair is NOT running. Your data in ~/.flair was not touched by this upgrade.");
      if (flairWasSwapped && previousFlairVersion) {
        await rollbackTo(previousFlairVersion, `restart failed: ${err.message}`);
      }
      // Not reached when a rollback ran — rollbackTo always exits. Say WHICH of
      // the two "no rollback" cases this is; "nothing to roll back" is not the
      // same statement as "we don't know what to roll back to".
      console.error(flairWasSwapped
        ? "   Cannot roll back automatically: the previously-installed @tpsdev-ai/flair version is unknown."
        : "   Nothing to roll back: @tpsdev-ai/flair itself was not changed by this upgrade.");
      console.error("   Start it with: flair start   — then check: flair status");
      process.exit(1);
    }
    // The delegated `flair restart` printed its own success line; don't say it twice.
    if (!restartWasDelegated) console.log("✅ Flair restarted");

    // flair#1022 — the headline defect. The restart above is allowed to fall
    // back off launchd to a plain detached spawn, and SHOULD be: a running
    // instance beats a down one. What was missing is that the fallback changes
    // whether anything brings this instance back after a reboot, and the
    // verification below made no claim about it. `healthy, authenticated,
    // running <new version>` was every word true of an instance that had just
    // been orphaned.
    //
    // Observed here rather than reported by the restart, because
    // `restartAfterUpgrade` may have delegated to the newly installed CLI in a
    // CHILD PROCESS (flair#905) — no in-process flag crosses that boundary.
    // Asking launchd is the one form of this check that is correct on both
    // paths.
    const management = observeLaunchdManagement(upgradeDataDir, port);
    const detached = isDetached(management);

    if (!shouldVerify) {
      console.log("  (--no-verify: skipping post-restart verification)");
      if (treePlan) {
        console.log(`  Previous tree kept at ${treePlan.previousDir} (rollback source; not discarded without verify).`);
      }
      if (detached) {
        for (const line of renderDetachedWarning(management, "Flair is running, but NOT under launchd.")) {
          console.error(line);
        }
      }
      return;
    }

    console.log("\nVerifying...");
    // The authenticated leg reuses verifyAuthedGet (flair#741 fix #2): api()'s
    // local-credential resolution (flair#640: env > agent key when an agentId
    // is already known > ~/.flair/admin-pass file), PLUS an Ed25519 agent-key
    // fallback when none of that resolves anything — see verifyAuthedGet's
    // doc comment. probeInstance itself never resolves credentials, it just
    // calls whatever's handed to it.
    const verify = await probeInstance(baseUrl, {
      expectVersion: expectedFlairVersion ?? undefined,
      timeoutMs: STARTUP_TIMEOUT_MS,
      authedGet: (path) => verifyAuthedGet(baseUrl, path, defaultKeysDir()),
    });

    const verdict = decideAfterVerify(verify, previousFlairVersion);

    if (verdict.kind === "ok") {
      // flair#1439: the success marker is the doctor runner's verdict, not
      // a second, narrower notion of "verified". Launchd detach is one
      // catalog member; the Codex SessionStart hook is another. Adding a
      // doctor check widens this claim automatically.
      const run = await doctorRunAfterUpgrade({
        management,
        port,
        installHooksFlag: !!opts.installHooks,
        fromVersion: previousFlairVersion,
        toVersion: expectedFlairVersion,
      });
      printVerifiedSummary(renderVerifiedSummary(verify.version, run));
      if (treePlan) discardPlainTreePrevious(treePlan.previousDir);
      return;
    }

    // flair#741 follow-through: a healthy instance the verifier just couldn't
    // authenticate against. The upgrade SUCCEEDED — the new version's server is
    // up (public /Health passed); we simply couldn't read its version over the
    // authenticated /HealthDetail. Report the caveat and STOP — never roll back
    // a running instance over a credentials gap. (decideAfterVerify only
    // returns this for isCredentialOnlyFailure(verify), so the old
    // "print an honest note but roll back anyway" branch that used to sit below
    // is gone — that credentials case can no longer reach the rollback path.)
    if (verdict.kind === "healthy-unverified") {
      // Same doctor runner as the "ok" branch — an unverified version must
      // not restore the unqualified ✅ while a catalog member is failing.
      const run = await doctorRunAfterUpgrade({
        management,
        port,
        installHooksFlag: !!opts.installHooks,
        fromVersion: previousFlairVersion,
        toVersion: expectedFlairVersion,
      });
      const versionNote = expectedFlairVersion ? ` on @tpsdev-ai/flair@${expectedFlairVersion}` : "";
      if (run.healthy) {
        console.log(`✅ upgrade complete: the instance is up and healthy${versionNote}.`);
      } else {
        printVerifiedSummary(renderVerifiedSummary(verify.version, run, { authenticated: false }));
      }
      console.log(`   The version could not be verified — the checker couldn't authenticate to /HealthDetail (${verdict.reason}).`);
      console.log("   The server is confirmed running (public /Health passed); this is a verification gap, not an upgrade failure — nothing was rolled back.");
      console.log("   To enable full post-upgrade verification: set FLAIR_ADMIN_PASS, or run `flair init` to provision ~/.flair/admin-pass or an agent key.");
      if (treePlan) discardPlainTreePrevious(treePlan.previousDir);
      return;
    }

    console.error(`❌ post-restart verification failed: ${verdict.reason}`);

    if (verdict.kind === "cannot-rollback") {
      console.error("   Cannot roll back automatically: the previously-installed @tpsdev-ai/flair version is unknown.");
      console.error("   Check the instance now: flair doctor");
      process.exit(1);
    }

    await rollbackTo(verdict.toVersion, verdict.reason);
  });

}
