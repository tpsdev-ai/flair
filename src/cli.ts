#!/usr/bin/env node
import { Command } from "commander";
import nacl from "tweetnacl";
import { load as parseYaml } from "js-yaml";
import * as render from "./render.js";
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  openSync,
  closeSync,
  chmodSync,
  renameSync,
  cpSync,
  rmSync,
  mkdtempSync,
  readdirSync,
  statSync,
  lstatSync,
  realpathSync,
  unlinkSync,
  chownSync,
  constants as fsConstants,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join, resolve, sep, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execFileSync, spawnSync, execSync } from "node:child_process";
import { createConnection } from "node:net";
import { createRequire } from "node:module";
import { createHash, randomUUID, randomBytes } from "node:crypto";
import { create as tarCreate } from "tar";
// flair#901 — tar listings/extracts type their entry callbacks against
// node-tar's own export so an upstream property rename fails compilation.
import { deploy as deployToFabric, validateOptions as validateDeployOptions, buildTargetUrl as buildDeployUrl, resolveDeployPublicUrl } from "./deploy.js";
import {
  COMPONENT_ENV_FILENAME,
  PUBLIC_URL_KEY,
  assertNoSecretKeysAdded,
  describePublicUrlFinding,
  planComponentEnv,
  readEnvValue,
} from "./component-env.js";
import { fabricUpgrade } from "./fabric-upgrade.js";
import {
  describeStampOutstanding,
  EMBEDDING_STAMP_ID,
  resolveCurrentModelId,
} from "./stamp-outstanding.js";
import { checkVersion, formatVersionNudge, primeVersionCheckCache, probeInstanceVersion, FLAIR_PKG_NAME } from "./version-check.js";
import {
  readInstalledHarperVersion,
  fetchDeclaredHarperVersion,
  writeEngineVersionStamp,
  checkEngineVersionBackwards,
  UPGRADE_SNAPSHOT_ROOT,
} from "./engine-version.js";
import { checkServerHandshake, formatHandshakeNudge, invalidateHandshakeCache } from "./version-handshake.js";
import { probeInstance, type ProbeResult } from "./probe.js";
import {
  sweepFleet,
  renderFleetSweepTable,
  fleetSweepShouldAbort,
  type FleetSweepResult,
} from "./fleet-verify.js";
import { markStale, sortOldestVersionFirst, type FleetPresenceRow } from "./fleet-presence.js";
import { detectClients, renderWiringSummary, wireClaudeCode, wireCodex, wireGemini, wireCursor, wireAntigravity, wirePi, clientConfigPath, codexConfigHasFlairSection, type ClientId } from "./install/clients.js";
import { flairCliVersion, clearFlairCliVersionCache, mcpServerSpec, unpinnedSpecWarning } from "./lib/mcp-spec.js";
import { harperPortValue } from "./lib/harper-port-value.js";
import { flairConfigPath, flairDataDir } from "./lib/flair-paths.js";
import {
  httpBind,
  httpCorsAccessList,
  preserveHttpPortValue,
  preserveSecurePort,
  qualifySecureBindValue,
  DEFAULT_HTTP_BIND_HOST,
  type HarperHttpBind,
} from "./lib/http-bind.js";
import {
  readClientMcpBlock,
  effectiveFlairUrl,
  checkClaudeMdBootstrap,
  detectWiredFlairMcp,
  inspectSessionStartHook,
  upgradeSessionStartHookCommand,
  fixClaudeMdBootstrap,
  fixSessionStartHook,
  applyOrReportClaudeMdBootstrap,
  applyOrReportSessionStartHook,
  resolveWireFlairUrl,
  planAgentIterations,
  fixCommandAgentHint,
  isNodeKeyId,
  partitionKeyIds,
  resolveFixAgentId,
  describeAgentGateFinding,
  embeddingsSkipRemedy,
  classifyKeyFile,
  resolveCollisionSafeName,
  pruneDateStamp,
  PRUNED_DIR_NAME,
  checkContinuityCaptureHooks,
  fixContinuityCaptureHooks,
  type AgentGateState,
  type SemanticSkipReason,
} from "./doctor-client.js";
import {
  checkGlobalBinOnPath,
  cliBootPathWarning,
  resolveNpmGlobalPrefix,
} from "./install/global-bin-path.js";
import {
  repinSessionStartHook,
  hookSettingsPath,
  resolveHookAgentId,
} from "./hook-install.js";
import {
  ApiHttpError,
  readSecretFileSecure,
  readAdminPassFileSecure,
  defaultAdminPassPath,
  defaultKeysDir,
  resolveLocalAdminPass,
  DEFAULT_ADMIN_USER,
  resolveAdminUser,
  resolveKeyPath,
  buildEd25519Auth,
  authFetch,
  KeyLoadError,
  isLocalBase,
  authedRequest,
} from "./lib/auth-resolve.js";
import {
  resolveSigningIdentity,
  emitSigningIdentityDebug,
  type ResolvedSigningIdentity,
  type SigningIdentitySource,
} from "./lib/signing-identity.js";
import { validateSnapshotArchive, extractSnapshotSafely } from "./lib/safe-snapshot-extract.js";
import { entityFormatHint, parseEntitiesCsv } from "./lib/entity-vocab-cli.js";
import { escapeXml, unescapeXml } from "./lib/xml-escape.js";
import {
  assessLaunchdManagement,
  diagnoseLaunchdPlistPaths,
  isDetached,
  pickInstancePid,
  plistCarriesInlineAdminPassword,
  readLaunchctlJobState,
  readPlistProgramRefs,
  renderDetachedWarning,
  LAUNCHCTL_QUERY_TIMEOUT_MS,
  type LaunchctlLister,
  type LaunchdManagement,
} from "./lib/launchd-management.js";
import {
  classifyPlist,
  planLaunchdRepair,
  mapRepairThrow,
  decideAdoptStopWithWait,
  verifyAdoptServingWithWait,
  type AdminPassAvailability,
  type LaunchdRepairResult,
  type RepairPlan,
} from "./lib/launchd-repair.js";
import { stabilizeMqttNetworkKeyOrder } from "./lib/stabilize-mqtt-network.js";
import { detectOpsApiAllInterfacesBind } from "./lib/ops-api-bind.js";
import {
  applyUpgradeHookConsent,
  catalogIssueDelta,
  DOCTOR_CHECK_IDS,
  renderCatalogDoctorLines,
  renderVerifiedSummary,
  runDoctorChecks,
  type DoctorRun,
} from "./lib/doctor-run.js";
import { ownedPinRefreshShouldReport, refreshOwnedPins, staleSessionStartHookPins } from "./lib/owned-pins.js";
import { classifyInstalledVersion, shouldPrintUpgradeLine, upgradeStatusSuffix, type UpgradeStatus } from "./lib/upgrade-status.js";
import {
  classifyDaemonState,
  verifyIdentity,
  parseSidecarJson,
  classifyHealthProbe,
  classifyPortOwner,
  classifyInstanceMatch,
  shouldAdoptMissingSidecar,
  parseNullSeparatedEnviron,
  extractRootPath,
  type DaemonEvidence,
  type PidLiveness,
  type HealthResult,
  type PidfileRead,
  type SidecarRead,
  type PortOwnerResult,
  type InstanceMatch,
} from "./lib/daemon-liveness.js";
import { readProcessStartTimeMs } from "./lib/process-start-time.js";
import {
  bindCli as bindFederationCli,
  register as registerFederation,
  signRequestBody,
  parseTokenFromFile,
  runFederationSyncOnce,
  persistLocalPeerLastSyncAt,
  runFederationWatch,
  federationStatusUrlSetting,
  describeFederationStatusFetchFailed,
  isFederationStatusConnectFailure,
  rewriteFederationStatusFetchFailed,
  isFederationStatusAuthFailure,
  isFederationStatusAuthRemedy,
} from "./commands/federation.js";
import {
  describeFederationPairHubAccessError,
  describeFederationPairLocalAccessError,
  rewriteFederationPairHubAccessError,
  rewriteFederationPairLocalAccessError,
} from "./lib/federation-pair-access.js";
import {
  bindCli as bindMemoryCli,
  register as registerMemory,
  categorizeForHygiene,
  HYGIENE_TEST_CONTENT_PATTERNS,
} from "./commands/memory.js";
import {
  bindCli as bindSoulCli,
  register as registerSoul,
} from "./commands/soul.js";
import {
  bindCli as bindRemCli,
  register as registerRem,
} from "./commands/rem.js";
import {
  bindCli as bindFleetCli,
  register as registerFleet,
} from "./commands/fleet.js";
import {
  bindCli as bindMcpCli,
  register as registerMcp,
} from "./commands/mcp.js";
import {
  bindCli as bindIdpCli,
  register as registerIdp,
} from "./commands/idp.js";
import {
  bindCli as bindHookCli,
  register as registerHook,
} from "./commands/hook.js";
import {
  bindCli as bindBridgeCli,
  register as registerBridge,
} from "./commands/bridge.js";
import {
  bindCli as bindKeysCli,
  register as registerKeys,
} from "./commands/keys.js";
import {
  bindCli as bindAgentCli,
  register as registerAgent,
} from "./commands/agent.js";
import {
  bindCli as bindSessionCli,
  register as registerSession,
} from "./commands/session.js";
import {
  bindCli as bindPrincipalCli,
  register as registerPrincipal,
  agentRecordIsAdmin,
} from "./commands/principal.js";
import {
  bindCli as bindPresenceCli,
  register as registerPresence,
  VALID_PRESENCE_ACTIVITIES,
  MAX_TASK_LENGTH,
} from "./commands/presence.js";
import {
  bindCli as bindRelationshipCli,
  register as registerRelationship,
} from "./commands/relationship.js";
import {
  bindCli as bindWorkspaceCli,
  register as registerWorkspace,
  MAX_WORKSPACE_FIELD_LENGTH,
} from "./commands/workspace.js";
import { flairConfigYamlCandidates, readPortFromYamlFile, resolveFlairConfigYaml } from "./lib/doctor-config-path.js";
import {
  decideHubReconcile,
  instanceWriteNotVerifiedMessage,
  multipleInstanceRowsMessage,
  readInstanceRows,
  updateInstanceRole,
  verifyInstanceWrite,
  type OpsEndpoint,
} from "./lib/instance-identity-row.js";
import {
  collectFederationEnv,
  describeFederationDriverFinding,
  federationPeersConfigured,
  loadYamlDoc,
} from "./lib/doctor-federation-driver.js";
import { applyUpgradeMigrations, type UpgradeMigrationContext } from "./lib/upgrade-migrations.js";
import { formatPurgeReport, purgeFlairInstall, purgeHadFailures } from "./lib/uninstall-purge.js";
import {
  collectUpgradeExecPathWarning,
  defaultReadProcessCmdline,
  defaultReadProcessCwd,
  findFlairPackageDir,
  resolveNpmGlobalFlairPackage,
  resolveServingFlairPackage,
} from "./lib/upgrade-exec-path.js";
import {
  applyPlainTreeUpgrade,
  decidePlainTreeRollback,
  discardPlainTreePrevious,
  findSystemdUnitsForTree,
  formatPlainTreeBanner,
  formatPlainTreePlan,
  formatPlainTreeScopeFooter,
  planPlainTreeUpgrade,
  resolvePlainTreeListingTarget,
  resolvePlainTreeTarget,
  restartSystemdUnits,
  restorePlainTreePrevious,
  type PlainTreeUpgradePlan,
} from "./lib/upgrade-plain-tree.js";

import {
  bindCli as bindOrgeventCli,
  register as registerOrgevent,
  MAX_ORGEVENT_DETAIL_LENGTH,
  MAX_ORGEVENT_SUMMARY_LENGTH,
  publishOrgEvent,
} from "./commands/orgevent.js";
import {
  bindCli as bindAttentionCli,
  register as registerAttention,
} from "./commands/attention.js";
import {
  bindCli as bindBootstrapCli,
  register as registerBootstrap,
} from "./commands/bootstrap.js";
import {
  bindCli as bindTestCli,
  register as registerTest,
} from "./commands/test.js";
import {
  bindCli as bindReembedCli,
  register as registerReembed,
} from "./commands/reembed.js";
import {
  bindCli as bindDeployCli,
  register as registerDeploy,
} from "./commands/deploy.js";
import {
  bindCli as bindUninstallCli,
  register as registerUninstall,
} from "./commands/uninstall.js";
import {
  bindCli as bindMigrateHarnessMemoryCli,
  register as registerMigrateHarnessMemory,
} from "./commands/migrate-harness-memory.js";
import {
  bindCli as bindSearchCli,
  register as registerSearch,
} from "./commands/search.js";
import {
  bindCli as bindBackupCli,
  register as registerBackup,
} from "./commands/backup.js";
import {
  bindCli as bindRestoreCli,
  register as registerRestore,
} from "./commands/restore.js";
import {
  bindCli as bindExportCli,
  register as registerExport,
} from "./commands/export.js";
import {
  bindCli as bindImportCli,
  register as registerImport,
} from "./commands/import.js";
import {
  register as registerInspect,
} from "./commands/inspect.js";
import {
  bindCli as bindInitCli,
  register as registerInit,
} from "./commands/init.js";
import {
  bindCli as bindStatusCli,
  register as registerStatus,
} from "./commands/status.js";
import {
  bindCli as bindUpgradeCli,
  register as registerUpgrade,
} from "./commands/upgrade.js";
import {
  bindCli as bindServiceCli,
  register as registerService,
} from "./commands/service.js";
import {
  bindCli as bindDoctorCli,
  register as registerDoctor,
} from "./commands/doctor.js";
import {
  bindCli as bindQualityCli,
  register as registerQuality,
} from "./commands/quality.js";
import {
  bindCli as bindGrantCli,
  register as registerGrant,
} from "./commands/grant.js";
import { resolveHome } from "./lib/home.js";

// Federation crypto helpers + private-visibility filter live with the
// federation command group (src/commands/federation.ts, flair#1620). Inlined
// there for the same packaging reason: src/ must not import resources/.

// ─── Secret detection helpers ────────────────────────

/**
 * Check if a value looks like a real secret/password/token.
 * Triggers warning when:
 *   - length >= 8
 *   - contains only alphanumerics and URL-safe punctuation (._-)
 *   - NOT a URL (doesn't contain ://)
 */
function isLikelyRealSecret(value: string): boolean {
  if (!value || value.length < 8) return false;
  if (value.includes("://")) return false; // exclude URLs
  // Match typical password/token format: alphanumerics + URL-safe punct
  const pattern = /^[A-Za-z0-9._-]+$/;
  return pattern.test(value);
}

/**
 * Determine if we should show an inline-secret warning.
 * 
 * @param optValue - The value from the command line option
 * @param fromEnv - Whether the value came from an environment variable (true = no warning)
 * @param secretFlagNames - Set of flag names that carry secrets
 * @param flagName - The flag being checked
 * @returns true if warning should be shown
 */
function shouldShowInlineSecretWarning(
  optValue: string | undefined,
  fromEnv: boolean,
  secretFlagNames: Set<string>,
  flagName: string
): boolean {
  // Skip if no value provided
  if (!optValue || optValue === "") return false;

  // Skip URLs (not secrets)
  if (flagName === "--target" || flagName === "--url") return false;

  // Only warn for secret-bearing flags
  if (!secretFlagNames.has(flagName)) return false;

  // Skip if value came from env (not argv)
  if (fromEnv) return false;

  // Check if value looks like a real secret
  if (!isLikelyRealSecret(optValue)) return false;

  return true;
}

// ─── Defaults ────────────────────────────────────────────────────────────────

const DEFAULT_PORT = 19926;
const DEFAULT_OPS_PORT = 19925;
const FABRIC_OPS_PORT = 9925;
// DEFAULT_ADMIN_USER + resolveAdminUser (flag > FLAIR_ADMIN_USER env > "admin")
// live in src/lib/auth-resolve.ts — imported above (flair#1345).
const STARTUP_TIMEOUT_MS = 60_000;
const HEALTH_POLL_INTERVAL_MS = 500;

// flair#670 — single-host default for the Harper ops API bind address.
// Loopback-only (+ the domain socket, always provisioned) shrinks the
// network-exposure surface: single-host installs don't need :9925 reachable
// from any interface but the box itself, so an accidentally-exposed port
// (misconfigured firewall/container networking) can't be reached remotely.
const DEFAULT_OPS_BIND_HOST = "127.0.0.1";

// readSecretFileSecure / readAdminPassFileSecure / defaultAdminPassPath /
// resolveLocalAdminPass / defaultKeysDir now live in src/lib/auth-resolve.ts
// (flair#747) — imported above, re-exported at the bottom of this file so
// the public CLI module surface is unchanged.

function defaultDataDir(): string {
  return flairDataDir();
}

// ─── launchd label (flair#693) ─────────────────────────────────────────────
// A bare "ai.tpsdev.flair" label is global to the current macOS user's
// launchd session. A second Flair instance on one host (dev + prod, a
// second user, the Harper-app embedded-component shape) used to collide on
// that SAME label — `flair start`/`stop`/`restart` from either instance
// could silently unload/replace the OTHER instance's daemon (see
// test/unit/upgrade-data-snapshot.test.ts's header for the exact hazard
// this caused, pre-fix).
//
// The label now incorporates instance identity: a short deterministic hash
// of the RESOLVED data dir. Same data dir -> same label every run
// (idempotent init/start/stop); different data dirs -> different labels,
// so two instances can never collide. Every code path that touches the
// label goes through the helpers below — no scattered label string
// literals — and resolveLaunchdLabel()/migrateLegacyLaunchdLabel() handle
// finding + cleanly migrating a pre-flair#693 install off the bare legacy
// label so it is never orphaned.
const LEGACY_LAUNCHD_LABEL = "ai.tpsdev.flair";

function defaultLaunchAgentsDir(): string {
  return join(resolveHome(), "Library", "LaunchAgents");
}

/** Instance-scoped launchd label for `dataDir`: ai.tpsdev.flair.<8-hex-char sha256 of the resolved data dir>. */
function launchdLabel(dataDir: string): string {
  const hash = createHash("sha256").update(resolve(dataDir), "utf8").digest("hex").slice(0, 8);
  return `${LEGACY_LAUNCHD_LABEL}.${hash}`;
}

function launchdPlistPath(label: string, launchAgentsDir: string = defaultLaunchAgentsDir()): string {
  return join(launchAgentsDir, `${label}.plist`);
}

/** Every value buildLaunchdPlist() interpolates into the plist XML. */
export interface LaunchdPlistOptions {
  label: string;
  /** node binary that launchd execs (process.execPath). */
  execPath: string;
  /** harper.js entrypoint passed to node. */
  harperBinPath: string;
  /** cwd for the service — the installed flair package dir. */
  workingDirectory: string;
  dataDir: string;
  modelsDir: string;
  /** HARPER_SET_CONFIG payload; already JSON-stringified by the caller. */
  setConfig: string;
  adminUser: string;
  httpPort: number | string;
  /** OPERATIONSAPI_NETWORK_PORT value from opsNetworkPortValue(). */
  opsNetworkPort: string;
  /**
   * The pass-file launcher (flair#1573 slice a) — REQUIRED (flair#1693).
   *
   * There is no inline mode. The plist NEVER embeds HDB_ADMIN_PASSWORD:
   * ProgramArguments point at `launcher`, which reads the password from
   * `adminPassFile` (a 0600 file) at start time. `home` and `path` are the
   * HOME/PATH the launcher needs under launchd's minimal environment to start
   * Harper non-interactively.
   *
   * This is required so an inline plist (the shape `flair init` used to write,
   * putting the admin password into a config file) cannot be constructed at
   * all — a caller without a satisfiable pass file is a compile error, not a
   * silently downgraded plist (flair#1693, incident flair#1685).
   */
  passFile: {
    /** Absolute path to the product launcher script. */
    launcher: string;
    /** Absolute path to the 0600 admin-pass file. */
    adminPassFile: string;
    /** HOME value for the launchd environment. */
    home: string;
    /** PATH value for the launchd environment. */
    path: string;
  };
}

/**
 * Build the launchd plist for a Flair instance.
 *
 * Extracted from the `init` command so the XML escaping is unit-testable
 * without touching real launchd or ~/Library/LaunchAgents. EVERY interpolated
 * value goes through escapeXml() — including ones that look safe today (the
 * label is a hash, the ports are numbers), because "this field can't contain
 * a special character" is exactly the assumption that rots when a field's
 * source changes. A future key added to this template that skips escapeXml()
 * is the bug reappearing.
 *
 * Never log the return value: it embeds HDB_ADMIN_PASSWORD.
 */
export function buildLaunchdPlist(opts: LaunchdPlistOptions): string {
  const e = escapeXml;
  const passFile = opts.passFile;

  // ProgramArguments: exec the launcher, which reads the secret from a 0600
  // file and then execs node itself (so launchd still tracks Harper as the
  // job). There is deliberately no inline branch (flair#1693).
  const programArguments = `<array>
    <string>${e(passFile.launcher)}</string>
    <string>${e(passFile.adminPassFile)}</string>
    <string>${e(opts.execPath)}</string>
    <string>${e(opts.harperBinPath)}</string>
  </array>`;

  // EnvironmentVariables: no HDB_ADMIN_PASSWORD (the secret is read from the
  // file by the launcher), plus HOME + PATH, which the launcher needs under
  // launchd's minimal env to start Harper non-interactively.
  const environmentVariables = `<dict>
    <key>ROOTPATH</key><string>${e(opts.dataDir)}</string>
    <key>FLAIR_MODELS_DIR</key><string>${e(opts.modelsDir)}</string>
    <key>HARPER_SET_CONFIG</key><string>${e(opts.setConfig)}</string>
    <key>DEFAULTS_MODE</key><string>dev</string>
    <key>HDB_ADMIN_USERNAME</key><string>${e(opts.adminUser)}</string>
    <key>THREADS_COUNT</key><string>1</string>
    <key>NODE_HOSTNAME</key><string>localhost</string>
    <key>HTTP_PORT</key><string>${e(String(opts.httpPort))}</string>
    <key>OPERATIONSAPI_NETWORK_PORT</key><string>${e(opts.opsNetworkPort)}</string>
    <key>LOCAL_STUDIO</key><string>false</string>
    <key>MQTT_NETWORK_PORT</key><string>null</string>
    <key>MQTT_NETWORK_SECUREPORT</key><string>null</string>
    <key>MQTT_WEBSOCKET</key><string>false</string>
    <key>HOME</key><string>${e(passFile.home)}</string>
    <key>PATH</key><string>${e(passFile.path)}</string>
  </dict>`;

  // Umask 077 (decimal 63): Harper bind()s operations-server at
  // 0777 & ~umask = 0700. Darwin #1704: chmod on that AF_UNIX inode
  // does not persist 0600. 0700 is owner-only; doctor classify is clean.
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${e(opts.label)}</string>
  <key>ProgramArguments</key>
  ${programArguments}
  <key>WorkingDirectory</key><string>${e(opts.workingDirectory)}</string>
  <key>EnvironmentVariables</key>
  ${environmentVariables}
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>Umask</key>
  <integer>63</integer>
  <key>StandardOutPath</key><string>${e(join(opts.dataDir, "log", "launchd-stdout.log"))}</string>
  <key>StandardErrorPath</key><string>${e(join(opts.dataDir, "log", "launchd-stderr.log"))}</string>
</dict>
</plist>`;
}

/**
 * Absolute path to the product-owned launchd launcher (flair#1573 slice a).
 * Shipped in the package under templates/launchd/; the plist's
 * ProgramArguments point at it in pass-file mode. `packageRoot` is injectable
 * so tests can point this at a fixture tree instead of the real package dir.
 */
export function launchdLauncherPath(packageRoot: string = flairPackageDir()): string {
  return join(packageRoot, "templates", "launchd", "start-flair-with-admin-pass.sh");
}

/**
 * Write `content` to `path` atomically: write to a temp file in the SAME
 * directory, then rename over the target. Same-fs rename is atomic on POSIX,
 * so a reader never observes a half-written file. `mode` is applied to the
 * temp file from creation — pass 0o600 when `content` holds a secret, so the
 * secret is never briefly world-readable on disk (flair#1573 slice a).
 */
export function writeFileAtomic(path: string, content: string, mode: number): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmpPath = join(dir, `.${basename(path)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  try {
    writeFileSync(tmpPath, content, { mode });
    renameSync(tmpPath, path);
  } catch (err) {
    try { unlinkSync(tmpPath); } catch { /* best effort */ }
    throw err;
  }
}

/**
 * Write the admin password to `path` with mode 0600 from creation (flair#1573
 * slice a). The secret is written to a temp file in the same dir (0600) and
 * renamed into place, so it is never briefly world-readable.
 */
export function writeAdminPassFile(path: string, content: string): void {
  writeFileAtomic(path, content, 0o600);
}

/**
 * Which launchd label an existing installation for `dataDir` is actually
 * registered under right now. Prefers the new instance-scoped label if its
 * plist is present; falls back to the pre-flair#693 bare
 * LEGACY_LAUNCHD_LABEL if only THAT plist is present (so start/stop/
 * uninstall against an old install still find and manage it instead of
 * silently no-op'ing and orphaning it); otherwise returns the new label
 * with nothing registered yet (e.g. before the first `init`).
 * `launchAgentsDir` is injectable so tests can point this at a temp dir
 * instead of the real ~/Library/LaunchAgents.
 */
function resolveLaunchdLabel(
  dataDir: string,
  launchAgentsDir: string = defaultLaunchAgentsDir(),
): { label: string; plistPath: string; isLegacy: boolean } {
  const newLabel = launchdLabel(dataDir);
  const newPlistPath = launchdPlistPath(newLabel, launchAgentsDir);
  if (existsSync(newPlistPath)) return { label: newLabel, plistPath: newPlistPath, isLegacy: false };

  const legacyPlistPath = launchdPlistPath(LEGACY_LAUNCHD_LABEL, launchAgentsDir);
  if (existsSync(legacyPlistPath)) return { label: LEGACY_LAUNCHD_LABEL, plistPath: legacyPlistPath, isLegacy: true };

  return { label: newLabel, plistPath: newPlistPath, isLegacy: false };
}

/** Runs one `launchctl ...` shell command; injected so tests can record/mock without touching real launchd. */
type LaunchctlRunner = (cmd: string) => void;

/**
 * Migrate a pre-flair#693 legacy-labeled launchd service to the new
 * instance-scoped label for `dataDir`: unload the legacy service FIRST,
 * then rewrite its plist content under the new label/path (same content,
 * only the <Label> value and filename change) and remove the legacy plist
 * file. There is never a moment where both the legacy and new labels are
 * registered for the same data dir. No-op (migrated: false) if there's
 * nothing legacy to migrate, or the new label is already registered.
 */
function migrateLegacyLaunchdLabel(
  dataDir: string,
  runLaunchctl: LaunchctlRunner,
  launchAgentsDir: string = defaultLaunchAgentsDir(),
): { migrated: boolean; label: string; plistPath: string } {
  const resolved = resolveLaunchdLabel(dataDir, launchAgentsDir);
  if (!resolved.isLegacy) {
    return { migrated: false, label: resolved.label, plistPath: resolved.plistPath };
  }

  const newLabel = launchdLabel(dataDir);
  const newPlistPath = launchdPlistPath(newLabel, launchAgentsDir);

  try { runLaunchctl(`launchctl unload "${resolved.plistPath}"`); } catch { /* best effort */ }

  const legacyContent = readFileSync(resolved.plistPath, "utf-8");
  // Use a function replacer to avoid $-sensitivity in the replacement
  // string (flair#919). String.prototype.replace interprets $&, $', $`
  // etc. in the replacement even when the search value is a plain string.
  const labelSearch = `<key>Label</key><string>${LEGACY_LAUNCHD_LABEL}</string>`;
  const labelReplacement = `<key>Label</key><string>${newLabel}</string>`;
  const newContent = legacyContent.replace(labelSearch, () => labelReplacement);
  // Refuse to propagate a malformed plist: if the Label wasn't found,
  // the plist is not what we expect and migration must not write it.
  if (newContent === legacyContent) {
    throw new Error(
      `Legacy plist at ${resolved.plistPath} does not contain the expected ` +
      `Label key — it may be malformed or from an unknown Flair version. ` +
      `Remove it manually and re-run 'flair init'.`,
    );
  }
  writeFileSync(newPlistPath, newContent);
  try { unlinkSync(resolved.plistPath); } catch { /* best effort */ }

  return { migrated: true, label: newLabel, plistPath: newPlistPath };
}

/**
 * Result of attempting to clean up a legacy (pre-flair#693) launchd plist
 * during init. The plist is only touched when it belongs to this data dir.
 */
type LegacyCleanupResult =
  | { action: "none" }
  | { action: "unloaded"; unloadFailed?: string; deleteFailed?: string }
  | { action: "skipped-foreign"; foreignDataDir: string }
  | { action: "skipped-unknown" };

/**
 * Clean up a pre-flair#693 legacy launchd plist (ai.tpsdev.flair) during
 * init, but ONLY when it belongs to the data dir being initialised.
 *
 * flair#966: the legacy plist is a single global label — init must not
 * unload/delete it unless ROOTPATH proves it serves this data dir.
 *
 * `runLaunchctl` is injected so tests can record/mock without touching
 * real launchd. The caller (init) passes a real execSync wrapper; tests
 * pass a recording stub.
 */
function cleanupLegacyLaunchdPlist(
  dataDir: string,
  plistDir: string,
  runLaunchctl: LaunchctlRunner,
): LegacyCleanupResult {
  const legacyPlistPath = launchdPlistPath(LEGACY_LAUNCHD_LABEL, plistDir);
  if (!existsSync(legacyPlistPath)) return { action: "none" };

  const legacyRootPath = readPlistRootPath(legacyPlistPath);
  const legacyOwnedByUs = legacyRootPath !== null && resolve(legacyRootPath) === resolve(dataDir);

  if (legacyOwnedByUs) {
    let unloadFailed: string | undefined;
    let deleteFailed: string | undefined;
    try {
      runLaunchctl(`launchctl unload "${legacyPlistPath}"`);
    } catch (err: any) {
      unloadFailed = err?.message ?? String(err);
      console.error(
        `Failed to unload legacy launchd service (${LEGACY_LAUNCHD_LABEL}): ` +
          `${unloadFailed}. ` +
          `The plist at ${legacyPlistPath} may still be loaded — ` +
          `unload it manually with: launchctl unload "${legacyPlistPath}"`,
      );
    }
    try {
      unlinkSync(legacyPlistPath);
      console.log(`Migrated off legacy launchd label (${LEGACY_LAUNCHD_LABEL}) ✓`);
    } catch (err: any) {
      deleteFailed = err?.message ?? String(err);
      console.error(
        `Failed to remove legacy launchd plist at ${legacyPlistPath}: ` +
          `${deleteFailed}. Remove it manually.`,
      );
    }
    return { action: "unloaded", unloadFailed, deleteFailed };
  }

  if (legacyRootPath !== null) {
    console.log(
      `Skipped legacy launchd cleanup: the plist at ${legacyPlistPath} ` +
        `belongs to data dir ${resolve(legacyRootPath)}, not ${resolve(dataDir)} — ` +
        `that is a different Flair instance.`,
    );
    return { action: "skipped-foreign", foreignDataDir: resolve(legacyRootPath) };
  }

  console.log(
    `Skipped legacy launchd cleanup: could not determine which data dir ` +
      `the plist at ${legacyPlistPath} serves. ` +
      `If it is yours, remove it manually with: rm "${legacyPlistPath}"`,
  );
  return { action: "skipped-unknown" };
}

/**
 * Load + start `dataDir`'s launchd service, migrating off a pre-flair#693
 * legacy registration FIRST if one is found (migrateLegacyLaunchdLabel
 * above). Call order is load-bearing — unload legacy -> load new -> start
 * new, never a window with both registered — and pinned by
 * test/unit/launchd-label.test.ts. `load` failure is tolerated (e.g.
 * "already loaded" is a common, harmless nonzero exit); `start` failure
 * propagates so callers can fall back to a direct (non-launchd) start.
 * Shared by the `start` command and startFlairProcess() (used by restart/
 * upgrade/snapshot) so this sequence is expressed in exactly one place.
 */
function ensureLaunchdServiceLoaded(
  dataDir: string,
  runLaunchctl: LaunchctlRunner,
  launchAgentsDir: string = defaultLaunchAgentsDir(),
): { label: string; plistPath: string; migrated: boolean } {
  const migration = migrateLegacyLaunchdLabel(dataDir, runLaunchctl, launchAgentsDir);
  // Unload first so a rewritten plist is re-read (flair#872).
  // launchd caches the environment of an already-loaded job; load
  // alone does not pick up changes to the plist on disk.
  try { runLaunchctl(`launchctl unload "${migration.plistPath}"`); } catch { /* not loaded, etc. — best effort */ }
  try { runLaunchctl(`launchctl load "${migration.plistPath}"`); } catch { /* already loaded, etc. — best effort */ }
  runLaunchctl(`launchctl start ${migration.label}`);
  return migration;
}

function configPath(): string {
  // Check both .yaml and .yml extensions
  return flairConfigPath();
}

/**
 * `~/.flair/config.yaml`'s `port:` — the PER-USER file, which describes the
 * default install and only the default install (flair#914).
 *
 * Kept for the commands that have no `--data-dir` of their own and therefore
 * genuinely mean the default instance, and as the source the instance-local
 * migration reads from. Anything that resolves a port for a NAMED instance
 * must go through `resolveHttpPort`, not this.
 *
 * Parsed as YAML, never regex-matched (flair#1719). A line-anchored
 * `/port:\s*(\d+)/` misses valid configs the moment the value is quoted
 * (`port: "9926"`), has whitespace before the colon (`port : 9926`), or a
 * commented-out prior value appears first (`# port: 19926`) — in those cases
 * the reader silently fell through to DEFAULT_PORT and the CLI talked to
 * 19926 while the file said 9926. Parsing the document reads the value the
 * user actually wrote, regardless of quoting or surrounding comments.
 */
function readPortFromConfig(path: string = configPath()): number | null {
  try {
    if (existsSync(path)) {
      const parsed = parseYaml(readFileSync(path, "utf-8"));
      if (parsed && typeof parsed === "object") {
        return harperPortValue((parsed as Record<string, any>).port);
      }
    }
  } catch { /* ignore */ }
  return null;
}

// ─── Harper's own config: where an instance's port actually lives (flair#914) ─
//
// `~/.flair/config.yaml` records ONE port for the whole user. `flair init
// --data-dir X --port P` wrote it unconditionally, so a second instance
// overwrote the first's recorded port and `resolveHttpPort()` then answered a
// per-instance question from a file that cannot tell instances apart — with no
// data dir as input at all.
//
// This is the dual of flair#902 (fixed in flair#910): that one resolved the
// INSTANCE from the wrong directory; this one resolved the PORT from a file
// that has no notion of instances. The fix is the same shape flair#910
// established — the data directory IS the instance identity, and everything
// else derives from it.
//
// The port is read from HARPER'S config, not a Flair-owned file beside it.
// Harper writes `<dataDir>/harper-config.yaml` at install (configUtils'
// `createConfigFile`) and rewrites it from its environment on EVERY boot, so it
// records `rootPath`, `http.port` and `operationsApi.network.port` for the
// instance served from this directory — written by the process that actually
// binds the sockets. That is what makes it authoritative.
//
// A Flair-owned file recording the same three facts (the `flair-instance.yaml`
// this replaces) was a fourth artefact duplicating the first, with nothing to
// reconcile the two. It does not stay true: boot an existing data directory on
// a different port and Harper updates its own config while the Flair copy keeps
// the old number — a silent wrong answer that looks authoritative. Measured, not
// theorised.
//
// The layering this restores: Harper core owns the data root and the ports, the
// Flair component owns memory semantics, local wrappers own convenience.
//
// Everything here is a PLAIN FILE READ. Resolution must work while the instance
// is DOWN — locating a stopped instance is most of what `flair start`, `stop`
// and `doctor` are for — so it must never require the process it is trying to
// find.
//
// Enumeration (`flair instances`) is deliberately NOT accommodated here. If it
// ever lands it is a DERIVED registry written by a scan, never by `init`, so
// that it can be stale without being wrong.

/**
 * Harper's config filenames, in Harper's own resolution order — current name
 * first, pre-rename legacy name second (harper `bin/run.js` and
 * `config/configUtils.js` both fall back this way, and `docs/rem.md` documents
 * the pair). An install predating the rename still serves from the legacy name,
 * so reading only the current one would make a working instance unaddressable.
 */
const HARPER_CONFIG_FILENAMES = ["harper-config.yaml", "harperdb-config.yaml"] as const;

/** Harper's config file for `dataDir`, or null when Harper has written none there yet. */
function harperConfigPath(dataDir: string): string | null {
  const dir = resolve(dataDir);
  for (const name of HARPER_CONFIG_FILENAMES) {
    const p = join(dir, name);
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * Parse Harper's config for `dataDir`. Returns null when absent or unreadable —
 * a malformed config is Harper's problem to report, and resolution falling back
 * to its next rung beats a crash in an unrelated command.
 *
 * Parsed as YAML, never regex-matched. The values wanted here are NESTED
 * (`http.port`, `operationsApi.network.port`), so line-anchored matching on a
 * bare key name would find `port:` under whichever block came first — wrong
 * answer, not just an ugly one. It is also how the predecessor earned a
 * blocking `detect-non-literal-regexp` SAST finding for building a RegExp from
 * a key name.
 */
function readHarperConfig(dataDir: string): Record<string, any> | null {
  try {
    const p = harperConfigPath(dataDir);
    if (!p) return null;
    const parsed = parseYaml(readFileSync(p, "utf-8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, any>) : null;
  } catch { /* ignore — see doc comment */ }
  return null;
}

// `harperPortValue` lives in `./lib/harper-port-value.js` so the runtime
// resources under `resources/` share the ONE parser with the CLI, rather than
// each interpolating `HTTP_PORT` by hand. Re-exported here for existing
// importers of this module (e.g. the launchd doctor integration test).
export { harperPortValue };

/** This instance's HTTP port, from Harper's own config in its data directory. */
function readPortFromHarperConfig(dataDir: string): number | null {
  return harperPortValue(readHarperConfig(dataDir)?.http?.port);
}

/** Which instance a command is addressing: `--data-dir` if given, else the default install. */
function instanceDataDir(opts: { dataDir?: string }): string {
  return opts.dataDir ? resolve(opts.dataDir) : defaultDataDir();
}

function isDefaultDataDir(dataDir: string): boolean {
  return resolve(dataDir) === resolve(defaultDataDir());
}

/**
 * Read the persisted ops-API bind host from ~/.flair/config.yaml (flair#863).
 * Line-anchored so it can't be satisfied by some other key that merely ends
 * in `opsBind`, and quote-tolerant because a hand-edited config may quote it.
 *
 * `path` is injected the same way launchdPlistPath's `launchAgentsDir` is —
 * so tests exercise the real parse against a temp file instead of the
 * developer's own ~/.flair.
 */
function readOpsBindFromConfig(path: string = configPath()): string | null {
  try {
    if (existsSync(path)) {
      const yaml = readFileSync(path, "utf-8");
      const m = yaml.match(/^\s*opsBind:\s*["']?([^"'\s#]+)["']?/m);
      if (m && m[1]) return m[1];
    }
  } catch { /* ignore */ }
  return null;
}

/**
 * Read the persisted HTTP bind host from ~/.flair/config.yaml.
 *
 * Same shape and rationale as `readOpsBindFromConfig`: line-anchored so another
 * key ending in `httpBind` cannot satisfy it, quote-tolerant because a
 * hand-edited config may quote it. `path` is injectable so tests exercise the
 * real parse against a temp file.
 */
export function readHttpBindFromConfig(path: string = configPath()): string | null {
  try {
    if (existsSync(path)) {
      const yaml = readFileSync(path, "utf-8");
      const m = yaml.match(/^\s*httpBind:\s*["']?([^"'\s#]+)["']?/m);
      if (m && m[1]) return m[1];
    }
  } catch { /* ignore */ }
  return null;
}

/** Read the persisted ops-API port from ~/.flair/config.yaml (flair#863). */
function readOpsPortFromConfig(path: string = configPath()): number | null {
  try {
    if (existsSync(path)) {
      const yaml = readFileSync(path, "utf-8");
      const m = yaml.match(/^\s*opsPort:\s*(\d+)/m);
      if (m) return Number(m[1]);
    }
  } catch { /* ignore */ }
  return null;
}

/**
 * Unified port resolution: `--port` flag > `FLAIR_URL` env > Harper's own config
 * in the instance's data directory > (default install only) the per-user config
 * > default.
 *
 * Every command that talks to Harper MUST use this helper.
 *
 * `opts.dataDir` names the instance (flair#914). Commands without a
 * `--data-dir` flag do not carry one and therefore mean the default install,
 * which is what they have always meant.
 *
 * `mode` distinguishes ADDRESSING an instance that is expected to exist from
 * CREATING one:
 *
 *   - `"address"` (default) — a non-default data directory Harper has never
 *     written a config into is a hard error. That case is precisely the bug
 *     this fixes: falling back to the per-user file would answer with some
 *     OTHER instance's port, which is a silent wrong answer wearing a
 *     migration. The default install keeps today's behaviour exactly.
 *   - `"create"` — `flair init`, which is establishing the instance rather
 *     than looking one up. An unknown instance takes DEFAULT_PORT, the same as
 *     a clean install has always done, instead of the refusal that would make
 *     `flair init --data-dir <new>` impossible.
 *
 * The "create" rung is load-bearing rather than hypothetical (flair#928).
 * `init`'s `--port` used to carry a commander default of DEFAULT_PORT, so
 * `opts.port` was ALWAYS set there and this function returned on the first rung
 * — including when re-initialising an instance already serving a different
 * port, which was silently renumbered to DEFAULT_PORT. Commander cannot tell
 * "the user passed the default" from "the user passed nothing", so the default
 * was the bug. It is gone; a bare `init` now falls through to the ladder, and
 * only a directory no instance has ever been served from reaches DEFAULT_PORT.
 *
 * Nothing is copied, migrated or written here. Harper's config already IS the
 * per-instance record, so there is no second file to keep in step — which is
 * the whole reason the port is read from it. The per-user file stays exactly as
 * it is for the default install that has always relied on it.
 */
function resolveHttpPort(opts: { port?: string | number; dataDir?: string }, mode: "address" | "create" = "address"): number {
  if (opts.port !== undefined && opts.port !== null) {
    const n = Number(opts.port);
    if (!isNaN(n) && n > 0) return n;
  }
  const envUrl = process.env.FLAIR_URL;
  if (envUrl) {
    const m = envUrl.match(/:(\d+)/);
    if (m) return Number(m[1]);
  }

  const dataDir = instanceDataDir(opts);

  // 1. Harper's own config for this instance. Once Harper has written one it is
  //    the only answer — it is maintained by the process that binds the socket.
  const harperPort = readPortFromHarperConfig(dataDir);
  if (harperPort !== null) return harperPort;

  // 2. Harper has written nothing here. For the DEFAULT install the per-user
  //    file is about this instance by definition — a single-instance install is
  //    the overwhelmingly common case and its recorded port is correct — so it
  //    stays the answer for existing installs. Read, never rewritten.
  if (isDefaultDataDir(dataDir)) {
    return readPortFromConfig() ?? DEFAULT_PORT;
  }

  // 3. A non-default directory Harper has never written to. `init` may go on to
  //    create the instance; nothing else may guess.
  if (mode === "create") return DEFAULT_PORT;

  throw new Error(
    `cannot determine which port ${dataDir} serves: Harper has written no config there `
      + `(no ${HARPER_CONFIG_FILENAMES.join(" or ")}), so that directory does not hold an instance yet. `
      + `Falling back to ~/.flair/config.yaml would answer with the port of a DIFFERENT instance — that file records one port `
      + `for the whole user, not one per data directory. `
      + `Pass --port <port> to say which port that instance serves, or run 'flair init --data-dir ${dataDir} --port <port>' to create it.`,
  );
}

// Unified base URL resolution. Precedence:
//   --target > --url > FLAIR_TARGET env > FLAIR_URL env > http://127.0.0.1:<resolveHttpPort>
//
// Every user-facing command that talks to a Flair instance should call this
// instead of hand-rolling the precedence. Keeps remote-target switching
// (e.g. CI hitting Fabric) consistent across `flair status`, `flair search`,
// `flair bootstrap`, etc.
function resolveBaseUrl(opts: { target?: string; url?: string; port?: string | number }): string {
  return (
    opts.target
    || opts.url
    || process.env.FLAIR_TARGET
    || process.env.FLAIR_URL
    || `http://127.0.0.1:${resolveHttpPort(opts)}`
  );
}

/**
 * The `~/.flair/config.yaml` port when it differs from the port
 * `resolveHttpPort` would use — the fallback candidate for flair#1719.
 *
 * For the default install `resolveHttpPort` reads Harper's own boot record
 * (`<dataDir>/harper-config.yaml`), which is authoritative for the port the
 * instance *last* bound but can be stale relative to the per-user config the
 * operator edits (the config says 9926 while Harper's record still says
 * 19926 from an earlier boot). When the recorded port has no daemon and the
 * configured port does, callers use this to reach the daemon the operator
 * actually configured instead of reporting the recorded port unreachable.
 *
 * Returns `null` when an explicit override is in play (nothing to fall back
 * from) or when the two ports already agree.
 */
function alternateConfiguredLocalPort(opts: { target?: string; url?: string; port?: string | number }): number | null {
  if (opts.target || opts.url || process.env.FLAIR_TARGET || process.env.FLAIR_URL) return null;
  const configured = readPortFromConfig();
  if (configured === null) return null;
  const resolved = resolveHttpPort(opts);
  return configured === resolved ? null : configured;
}

// Resolve agent id from --agent flag or FLAIR_AGENT_ID env (flag > env).
// The low-level helper with no debug line — used where only the flag/env pair
// is wanted (e.g. the upgrade path that then applies its own key-dir floor).
// Delegates to the canonical core so the flag>env precedence lives in exactly
// one place (flair#1183). Returns null if neither is set; caller decides
// whether that's fatal.
function resolveAgentIdOrEnv(opts: { agent?: string }): string | null {
  return resolveSigningIdentity(opts).agentId;
}

// ── The ONE signing-identity seam every user-facing command family calls ──────
//
// Precedence (flair#1183): --agent flag > FLAIR_AGENT_ID env > config profile.
//
// This seam pins the top two tiers — the flag and the env — and resolves the
// signer ONCE, at the command boundary, threading the result down to
// api()/authedRequest as an AUTHORITATIVE value. That is the whole fix: a lower
// layer must never re-derive the signer from the environment behind the
// command's back (api() used to, signing as FLAIR_AGENT_ID even when --agent
// named someone else).
//
// The third tier — the "config profile" — is the machine's ambient credential
// (the ~/.flair/admin-pass file and the Ed25519 agent-key FLOOR), applied BELOW
// this by authedRequest (src/lib/auth-resolve.ts tiers 4-5) when this seam
// resolves nothing. It is deliberately NOT a name lookup here: making a
// forgotten --agent silently resolve to some configured identity is the exact
// silent-substitution this issue is about, and it would also turn every
// "identity required" command into one that guesses. So when neither flag nor
// env is set this returns null, and the caller either demands an explicit
// identity (agent-scoped commands) or lets authedRequest apply the ambient
// config-profile credential. Emits the FLAIR_DEBUG line naming the resolved
// agentId + which source won, so operator, CLI, and server cannot silently
// disagree about who's calling.
function resolveSigningIdentityFor(
  opts: { agent?: string },
  command?: string,
): ResolvedSigningIdentity {
  const resolved = resolveSigningIdentity(opts);
  emitSigningIdentityDebug(resolved, command);
  return resolved;
}

// Same seam, returning the full ResolvedSigningIdentity (agentId + source) so
// callers can thread the source down to api()/authedRequest. The source is what
// lets authedRequest distinguish a flag-pinned agent (--agent X, flair#1500)
// from an env-pinned one (FLAIR_AGENT_ID) — the flag must sign as itself BEFORE
// env admin, while the env keeps its legacy Basic behavior. Still emits the
// debug line via resolveSigningIdentityFor.
function resolveSigningAgentId(opts: { agent?: string }, command?: string): ResolvedSigningIdentity {
  return resolveSigningIdentityFor(opts, command);
}

// ── Shared credential/identity flag surface (flair#1106) ─────────────────────
// Sibling commands (memory add, backup, federation sync) used to drift on
// the same concepts: `--admin-pass-file` existed on backup/sync but was an
// unknown option on `memory add`, and `memory add --agent` was a commander
// requiredOption so FLAIR_AGENT_ID could never satisfy it. One helper owns
// the credential flag names/shapes; identity (`--agent`) stays optional so
// the env fallback can actually apply. This does not invent a new auth
// model — it only declares the flags authedRequest already resolves.

/** Flag strings the sibling commands must share (name + argument shape). */
export const SHARED_CREDENTIAL_FLAGS = {
  adminPass: "--admin-pass <pass>",
  adminPassFile: "--admin-pass-file <path>",
  adminUser: "--admin-user <name>",
} as const;

export const SHARED_IDENTITY_FLAGS = {
  agent: "--agent <id>",
} as const;

function addSharedCredentialOptions(cmd: Command): Command {
  return cmd
    .option(SHARED_CREDENTIAL_FLAGS.adminPass, "Admin password (or set FLAIR_ADMIN_PASS env, or use --admin-pass-file)")
    .option(SHARED_CREDENTIAL_FLAGS.adminPassFile, "Read admin password from a file (e.g., ~/.flair/admin-pass). Preferred over --admin-pass for launchd/cron — keeps the secret out of ps and shell history.")
    .option(SHARED_CREDENTIAL_FLAGS.adminUser, "Admin username for Basic auth (env: FLAIR_ADMIN_USER; default: admin)");
}

function addSharedIdentityOption(cmd: Command): Command {
  return cmd.option(SHARED_IDENTITY_FLAGS.agent, "Agent ID (or set FLAIR_AGENT_ID env)");
}

/**
 * Resolve `--admin-pass-file` into the same `adminPass` slot the inline flag
 * uses. Shared so sibling commands cannot drift on how the file is read
 * (mode 0600 via readAdminPassFileSecure).
 */
function applyAdminPassFile(opts: { adminPass?: string; adminPassFile?: string }): void {
  if (!opts.adminPass && opts.adminPassFile) {
    try {
      opts.adminPass = readAdminPassFileSecure(opts.adminPassFile);
    } catch (err: any) {
      console.error(`Error reading --admin-pass-file ${opts.adminPassFile}: ${err.message}`);
      process.exit(1);
    }
  }
}

// Ops port resolution: --ops-port flag > FLAIR_OPS_PORT env > config opsPort > httpPort - 1
//
// Deliberately NOT routed through Harper's per-instance config the way
// resolveHttpPort is (flair#914). The last rung couples the ops port to the HTTP
// port the CALLER named, and that coupling is what makes `flair init --port N`
// land its ops API at N-1 on a host that already runs an instance. A Harper rung
// above it would answer that call with the EXISTING instance's ops port instead,
// which is the bug flair#914 fixed pointing the other way. The ops port becomes
// per-instance when the lifecycle commands grow `--data-dir` and there is a
// named instance to attribute it to.
function resolveOpsPort(opts: { opsPort?: string | number; port?: string | number }): number {
  if (opts.opsPort !== undefined && opts.opsPort !== null) {
    const n = Number(opts.opsPort);
    if (!isNaN(n) && n > 0) return n;
  }
  const envOps = process.env.FLAIR_OPS_PORT;
  if (envOps) return Number(envOps);
  // Try reading from config
  try {
    const p = configPath();
    if (existsSync(p)) {
      const yaml = readFileSync(p, "utf-8");
      const m = yaml.match(/opsPort:\s*(\d+)/);
      if (m) return Number(m[1]);
    }
  } catch { /* ignore */ }
  // Default: httpPort - 1
  return resolveHttpPort(opts) - 1;
}

// Ops API bind-host resolution (flair#670, #863): --ops-bind flag >
// FLAIR_OPS_BIND env > persisted `opsBind` in ~/.flair/config.yaml > loopback
// default. This is the escape hatch — deployments that genuinely need remote
// ops access (multi-host / Fabric) pass an explicit wider address (e.g.
// `--ops-bind 0.0.0.0`) to opt back in; everything else gets the loopback-only
// single-host default.
//
// The config-file rung (flair#863) is what makes `--ops-bind` durable. Every
// Harper spawn re-asserts the bind (see opsNetworkPortValue's doc comment for
// why it MUST), and those spawns happen in `flair start` / `flair restart` /
// `flair upgrade`, none of which take an `--ops-bind` flag. Without a
// flair-owned persisted value, a one-off `flair init --ops-bind 0.0.0.0` would
// be silently reverted to the loopback default by the very next restart — the
// widening case would be as broken as the narrowing one. Mirrors
// resolveOpsPort's config rung.
export function resolveOpsBindHostFrom(
  flag: string | undefined | null,
  envBind: string | undefined | null,
  configuredBind: string | undefined | null,
): string {
  if (flag !== undefined && flag !== null && String(flag).trim() !== "") return String(flag).trim();
  if (envBind && envBind.trim() !== "") return envBind.trim();
  if (configuredBind && configuredBind.trim() !== "") return configuredBind.trim();
  return DEFAULT_OPS_BIND_HOST;
}

function resolveOpsBindHost(opts: { opsBind?: string }): string {
  return resolveOpsBindHostFrom(opts.opsBind, process.env.FLAIR_OPS_BIND, readOpsBindFromConfig());
}

// HTTP bind-host resolution (ops-nv9d slice 2): --http-bind flag >
// FLAIR_HTTP_BIND env > persisted `httpBind` in ~/.flair/config.yaml > loopback
// default. Mirrors the ops-API escape hatch (resolveOpsBindHostFrom) so the two
// binds cannot drift in how a deliberate widening is recorded, with ONE
// deliberate difference: the ops resolver accepts an arbitrary string (Harper
// parses whatever it can from `host:port`), while this one VALIDATES. The value
// is built through `httpBind()`, which refuses any host that does not guarantee
// IPv4-loopback reachability — a specific non-loopback host or an IPv6-only
// loopback would leave every hardcoded `127.0.0.1` self-call pointing at a dead
// port while the bind itself looked fine. Widening is still available, but only
// to a wildcard.
//
// The config-file rung is what makes `--http-bind` durable: every Harper spawn
// re-asserts the bind, and those spawns happen in `flair start` / `restart` /
// `upgrade`, none of which take an `--http-bind` flag.
export function resolveHttpBindHostFrom(
  flag: string | undefined | null,
  envBind: string | undefined | null,
  configuredBind: string | undefined | null,
): string | null {
  if (flag !== undefined && flag !== null && String(flag).trim() !== "") return String(flag).trim();
  if (envBind && envBind.trim() !== "") return envBind.trim();
  if (configuredBind && configuredBind.trim() !== "") return configuredBind.trim();
  return null;
}

function resolveHttpBindHost(opts: { httpBind?: string }): string {
  return resolveHttpBindHostFrom(opts.httpBind, process.env.FLAIR_HTTP_BIND, readHttpBindFromConfig())
    ?? DEFAULT_HTTP_BIND_HOST;
}

/**
 * The validated HTTP bind (host-qualified string + its two halves) for a spawn
 * env, a launchd plist, or a `HARPER_SET_CONFIG` payload. Throws
 * `UnreachableHttpBindHostError` for a host outside {loopback, wildcard}; the
 * caller must refuse before writing anything.
 */
export function resolveHttpBindFor(port: number, opts: { httpBind?: string }): HarperHttpBind {
  return httpBind(resolveHttpBindHost(opts), port);
}

/**
 * The one place that renders Harper's `operationsApi.network.port` value
 * (flair#863). Used by both the HARPER_SET_CONFIG block
 * (buildOperationsApiConfig) and every `OPERATIONSAPI_NETWORK_PORT` env var
 * flair sets, so the two can never disagree about whether the bind host is
 * present.
 *
 * Why every spawn has to carry the host-qualified form, not a bare number:
 * Harper's HARPER_SET_CONFIG handling (harper
 * config/harperConfigEnvVars.ts) records, for each key it force-sets, the
 * value that key had BEFORE the force — `state.originalValues` in
 * `<rootPath>/backup/.harper-config-state.json` — and on the next boot where
 * HARPER_SET_CONFIG is absent, `cleanupRemovedEnvVar` RESTORES those
 * originals into harper-config.yaml. So a bare `OPERATIONSAPI_NETWORK_PORT`
 * anywhere in flair's spawn chain doesn't just lose on that boot: it is
 * latched as the "original" and silently re-widens the bind to all interfaces
 * on the first later boot that omits HARPER_SET_CONFIG. That is exactly what
 * `flair restart` / `flair upgrade` do on the non-launchd path.
 */
export function opsNetworkPortValue(opsBindHost: string, opsPort: number | string): string {
  return `${opsBindHost}:${opsPort}`;
}

/**
 * Build the `operationsApi` block for Harper's HARPER_SET_CONFIG (flair#670).
 *
 * `network.port` uses Harper's "host:port" string form — Harper's server
 * bootstrap (harper dist/server/threads/threadServer.js,
 * listenOnPorts/listenOnPortsBun) splits a config port value on its last
 * `:` into an explicit bind host + port when present, and falls back to
 * binding all interfaces (0.0.0.0 / ::) when given a bare number. A colon-free
 * numeric port is exactly the pre-#670 behavior (all-interfaces); prefixing
 * it with a host is the only config-level way to narrow the bind.
 *
 * `domainSocket` lives under `network` per Harper's own config schema
 * (harper/config-root.schema.json → properties.operationsApi
 * .properties.network.properties.domainSocket, and
 * dist/validation/configValidator.js's `operationsApi.network.domainSocket`
 * Joi path) — nested here, not as a sibling of `network`.
 */
export function buildOperationsApiConfig(
  opsPort: number,
  opsSocket: string,
  opsBindHost: string,
): { network: { port: string; cors: boolean; domainSocket: string } } {
  return {
    network: { port: opsNetworkPortValue(opsBindHost, opsPort), cors: true, domainSocket: opsSocket },
  };
}

/**
 * Harper config that fully disables the MQTT broker (flair#1586).
 *
 * Flair does not use MQTT. Harper's mqtt component (server/mqtt.ts
 * `handleApplication`) binds a TCP listener on `mqtt.network.port` (1883) and
 * a TLS listener on `mqtt.network.securePort` (8883) whenever EITHER is truthy
 * (`if (port || securePort)`), plus a WebSocket upgrade path when
 * `mqtt.webSocket` is true. Nulling only `network.port` leaves
 * `network.securePort` at its 8883 default, so the TLS listener still binds.
 * Fully disabling MQTT requires nulling BOTH ports and turning off the
 * WebSocket path.
 *
 * Note: config-root.schema.json still documents a flat `mqtt.port` /
 * `mqtt.securePort`, but the runtime reads the nested `mqtt.network.*` form
 * (see static/defaultConfig.yaml) — the flat keys are stale.
 */
const MQTT_DISABLED_CONFIG = {
  network: { port: null, securePort: null },
  webSocket: false,
};

/**
 * Build the flair-owned environment overrides for a DIRECT (non-launchd)
 * Harper spawn (flair#863) — shared by `flair start`'s fallback path and
 * startFlairProcess() (which backs `flair restart` and `flair upgrade`).
 * Callers spread this over `process.env`.
 *
 * These two sites used to build the env inline and had drifted: `start` set a
 * host-qualified OPERATIONSAPI_NETWORK_PORT, `startFlairProcess` set none at
 * all. Neither path sets HARPER_SET_CONFIG, and Harper restores the
 * pre-SET_CONFIG original for every key SET_CONFIG had forced whenever that
 * variable is absent — so the site that omitted the var silently re-widened
 * the ops API to all interfaces on every restart/upgrade, and persisted it.
 * One builder means the next spawn site cannot reintroduce that gap.
 *
 * MQTT (flair#1586): the direct-spawn path re-asserts the mqtt disable via the
 * individual MQTT_* env vars (the same channel as OPERATIONSAPI_NETWORK_PORT /
 * HTTP_PORT) rather than HARPER_SET_CONFIG, so it cannot reintroduce the
 * SET_CONFIG drift/restore gap. "null" casts to a null port (Harper's
 * castConfigValue), which passes config validation (portConstraints
 * `.empty(null)`) and is falsy, so Harper's mqtt component (server/mqtt.ts
 * `if (port || securePort)`) binds neither the TCP (1883) nor TLS (8883)
 * listener, and MQTT_WEBSOCKET=false turns off the WebSocket upgrade path.
 *
 * Deliberately omits HDB_ADMIN_PASSWORD when no password is in hand: an empty
 * string would strip Harper's auth on an existing install.
 */
export function buildDirectSpawnEnv(opts: {
  dataDir: string;
  modelsDir: string;
  httpPort: number;
  /** HTTP bind host (ops-nv9d slice 2). Defaults to 127.0.0.1; a wildcard widens for the self-calls that hardcode IPv4 loopback. */
  httpBindHost?: string;
  opsPort: number;
  opsBindHost: string;
  adminUser: string;
  adminPass?: string;
}): Record<string, string> {
  const env: Record<string, string> = {
    ROOTPATH: opts.dataDir,
    // The embedding backend self-registers in-process at boot
    // (resources/embeddings-boot.ts); this only tells it where the model lives.
    FLAIR_MODELS_DIR: opts.modelsDir,
    DEFAULTS_MODE: "dev",
    HDB_ADMIN_USERNAME: opts.adminUser,
    // Host-qualified through the ONE bind constructor (ops-nv9d slice 2). A bare
    // number here would bind all interfaces, which is exactly the widening this
    // slice removes; qualification is what narrows it. The value is the same
    // shape the consumers parse (slice 1). Refuses a host that cannot reach
    // IPv4 loopback rather than silently producing an unreachable bind.
    HTTP_PORT: httpBind(opts.httpBindHost, opts.httpPort).bindValue,
    OPERATIONSAPI_NETWORK_PORT: opsNetworkPortValue(opts.opsBindHost, opts.opsPort),
    // flair#1586: fully disable the MQTT broker (Flair does not use it). "null"
    // casts to a null port (Harper's castConfigValue), which passes config
    // validation (portConstraints `.empty(null)`) and is falsy, so Harper binds
    // neither the TCP (1883) nor TLS (8883) listener; MQTT_WEBSOCKET=false turns
    // off the WebSocket upgrade path.
    MQTT_NETWORK_PORT: "null",
    MQTT_NETWORK_SECUREPORT: "null",
    MQTT_WEBSOCKET: "false",
    LOCAL_STUDIO: "false",
    // flair#905 / lrf5: Harper's forceDowngradePrompt reads CONFIRM_DOWNGRADE
    // from the environment (via the `prompt` npm package's assignCmdEnvVariables
    // override). Under launchd/systemd stdin is not a TTY, so the prompt gets
    // EOF and Harper exits 0 without starting — leaving the instance DOWN with
    // no error. Setting this to "yes" makes the prompt non-interactive: Harper
    // proceeds without blocking, which is the correct default for a managed
    // restart where the operator already chose to proceed.
    CONFIRM_DOWNGRADE: "yes",
  };
  if (opts.adminPass) env.HDB_ADMIN_PASSWORD = opts.adminPass;
  return env;
}

/**
 * Harper config env vars that outrank the individual bind vars. Harper filters
 * its env/argv against `HARPER_SET_CONFIG` before applying anything
 * (`filterArgsAgainstRuntimeConfig`), and `http.port` is a key flair's own
 * SET_CONFIG names — so an ambient `HARPER_SET_CONFIG` left in `process.env`
 * would DROP the qualified `HTTP_PORT` the direct-spawn path writes, bind the
 * port wide, and leave every bind assertion green.
 */
export const HARPER_CONFIG_ENV_VARS = ["HARPER_DEFAULT_CONFIG", "HARPER_CONFIG", "HARPER_SET_CONFIG"] as const;

/**
 * A CLOSED direct-spawn environment: `base` with every Harper config env var
 * removed, then `overrides` applied. The direct-spawn paths (`flair start`'s
 * fallback, `restart`, `upgrade`) do not set `HARPER_SET_CONFIG` themselves and
 * their whole contract is the INDIVIDUAL vars — so an inherited SET_CONFIG from
 * the operator's shell must not survive into the spawn and outrank them. (The
 * `init` install path DOES set SET_CONFIG deliberately and does not use this.)
 */
export function closedDirectSpawnEnv(
  base: NodeJS.ProcessEnv,
  overrides: Record<string, string>,
): Record<string, string> {
  const env = { ...(base as Record<string, string>) };
  for (const key of HARPER_CONFIG_ENV_VARS) delete env[key];
  return { ...env, ...overrides };
}

// detectOpsApiAllInterfacesBind now lives in src/lib/ops-api-bind.ts so
// `flair doctor` and `flair status` share one decision (flair#852). Re-exported
// at the bottom of this file to preserve the public CLI module surface.

/**
 * Decide the source `flair init` should use for the admin password
 * (flair#827 + flair#837). Implementation lives in `src/lib/init-admin-pass.ts`
 * so the persisted-user / rotate / refuse branches stay strictly typed and
 * unit-tested without expanding this file. Re-exported here so existing
 * imports of the CLI module surface keep working.
 */
export {
  resolveInitAdminPasswordSource,
  detectPersistedAdminUser,
  initAdminPassRefusalMessage,
  adminPassDesyncFinding,
  rotateAdminPasswordViaOpsSocket,
  prepareAdminPasswordRotate,
  formatAdminPasswordRotatePreflight,
  assertExplicitAdminPasswordRotate,
  assertOwnerOnlyOpsSocket,
  isOwnerOnlyOpsSocketPosture,
  callOpsSocket,
  waitForOpsSocketReady,
  executeAdminPasswordRotate,
  probeOpsSocketAccepting,
  INIT_RESET_ADMIN_PASS_COMMAND,
  INIT_ADMIN_PASS_FILE_COMMAND,
  INIT_STOP_FOREIGN_COMMAND,
  ADMIN_PASS_DESYNC_REMEDY,
} from "./lib/init-admin-pass.js";
export type {
  InitAdminPasswordDecision,
  InitAdminPasswordContext,
  InitAdminPasswordRefuseReason,
} from "./lib/init-admin-pass.js";

// ─── Ops-socket permission posture (flair#763) ─────────────────────────────────
//
// The ops API domain socket (dataDir/operations-server) is protected by a
// two-layer posture, with the socket's IMMEDIATE PARENT DIRECTORY as the
// primary, load-bearing gate (resolved from the socket path — never a
// hardcoded ~/.flair, so custom --data-dir installs get the same gate):
//
//   FLAIR_SOCKET_GROUP unset → parent dir 0700, socket 0600 (owner-only).
//   FLAIR_SOCKET_GROUP set    → parent dir 0750 (owner+group traverse — else
//                               the group grant is unreachable behind the dir
//                               gate), socket 0660 + chgrp to that group.
//
// The two layers move in lockstep BOTH directions: a later UNSET returns the
// dir to 0700 and the socket to 0600. The directory gate is race-free
// (checked on every connect(2) traversal), umask-independent (explicit
// chmod), and cross-platform (VFS-level, unlike socket-file permission
// enforcement on connect(2) which varies across BSD lineage); the socket-file
// mode is defense-in-depth within it. Split from #670 (network bind shipped
// in #762); same local-admin-surface axis as #654 (authorizeLocal off).

/** Group names allowed for FLAIR_SOCKET_GROUP — validated BEFORE existence
 *  resolution (Sherlock #763): rejects path-traversal / whitespace / any
 *  weird-but-"valid" name before it reaches getgrnam/chgrp. */
export const SOCKET_GROUP_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9._-]*$/;

export function isValidSocketGroupName(name: string): boolean {
  return SOCKET_GROUP_NAME_RE.test(name);
}

/** System groups broad enough that opting the ops socket into them silently
 *  grants access to a wide set of accounts (macOS `staff` = every human user
 *  on the box). Not a gate — a warning (Sherlock #763). */
const BROAD_SYSTEM_GROUPS = new Set(["staff", "wheel", "users", "admin", "everyone", "adm"]);

/** The posture (parent-dir + socket file modes) for a given FLAIR_SOCKET_GROUP
 *  value. Pure — the single source of truth for the two lockstep states. */
export function resolveSocketPosture(group: string | undefined | null): {
  dirMode: number;
  socketMode: number;
  group: string | null;
} {
  const g = (group ?? "").trim();
  if (g.length > 0) return { dirMode: 0o750, socketMode: 0o660, group: g };
  return { dirMode: 0o700, socketMode: 0o600, group: null };
}

export interface OpsSocketPostureFs {
  chmodSync(path: string, mode: number): void;
  statSync(path: string): { mode: number; uid: number; gid: number };
  existsSync(path: string): boolean;
  chownSync(path: string, uid: number, gid: number): void;
}

const NODE_SOCKET_FS: OpsSocketPostureFs = {
  chmodSync,
  statSync: (p) => {
    const s = statSync(p);
    return { mode: s.mode, uid: s.uid, gid: s.gid };
  },
  existsSync,
  chownSync,
};

/** Resolve a group NAME to its numeric gid, cross-platform, or null if the
 *  group does not exist. Uses execFileSync (arg vector — no shell) and the
 *  name is regex-validated by the caller before it gets here. */
function resolveGroupGid(name: string): number | null {
  try {
    if (process.platform === "darwin") {
      // dscl reads Directory Services (macOS groups don't live in /etc/group).
      const out = execFileSync("dscl", [".", "-read", `/Groups/${name}`, "PrimaryGroupID"], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      const m = out.match(/PrimaryGroupID:\s*(\d+)/);
      return m ? Number(m[1]) : null;
    }
    // Linux / other POSIX: getent resolves NSS (files, LDAP, …).
    const out = execFileSync("getent", ["group", name], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const parts = out.trim().split(":");
    return parts.length >= 3 && parts[2] !== "" ? Number(parts[2]) : null;
  } catch {
    return null; // command failed / group not found → treated as missing
  }
}

export interface ApplyOpsSocketPostureOptions {
  socketPath: string;
  group?: string | null;
  fs?: OpsSocketPostureFs;
  resolveGid?: (name: string) => number | null;
}

export interface OpsSocketPostureResult {
  dirMode: number;
  socketMode: number;
  group: string | null;
  gid: number | null;
  dirApplied: boolean;
  socketApplied: boolean; // false when the socket didn't exist yet (pre-boot)
  broadGroup: boolean;
}

/**
 * Apply the ops-socket permission posture (flair#763). Idempotent: safe to
 * call before Harper spawns (dir gate only — socket not present yet) and again
 * after the socket appears (socket mode + optional chgrp). fs and resolveGid
 * are injectable for unit tests (temp dirs / mocked group resolution).
 *
 * Fail-closed: an invalid OR missing FLAIR_SOCKET_GROUP is a hard error — NEVER
 * a silent fallback to 0600. The group name is regex-validated BEFORE
 * existence resolution.
 */
export function applyOpsSocketPosture(opts: ApplyOpsSocketPostureOptions): OpsSocketPostureResult {
  const fs = opts.fs ?? NODE_SOCKET_FS;
  const resolveGid = opts.resolveGid ?? resolveGroupGid;
  const posture = resolveSocketPosture(opts.group);

  let gid: number | null = null;
  let broadGroup = false;
  if (posture.group !== null) {
    if (!isValidSocketGroupName(posture.group)) {
      throw new Error(
        `Invalid FLAIR_SOCKET_GROUP '${posture.group}': group names must match ${SOCKET_GROUP_NAME_RE.source}.`,
      );
    }
    gid = resolveGid(posture.group);
    if (gid === null) {
      throw new Error(
        `FLAIR_SOCKET_GROUP '${posture.group}' does not exist on this system. ` +
          `Create the group first, or unset FLAIR_SOCKET_GROUP to use the owner-only default (dir 0700 / socket 0600).`,
      );
    }
    broadGroup = BROAD_SYSTEM_GROUPS.has(posture.group);
  }

  const parentDir = dirname(opts.socketPath);
  // Directory gate — the race-free primary control. Applied whether or not the
  // socket exists yet, so it is in place BEFORE Harper creates the socket.
  fs.chmodSync(parentDir, posture.dirMode);

  // Socket file: defense-in-depth mode + optional chgrp — only once it exists.
  let socketApplied = false;
  if (fs.existsSync(opts.socketPath)) {
    fs.chmodSync(opts.socketPath, posture.socketMode);
    // Darwin: Node chmodSync on a unix socket can report success while
    // stat still shows 0777 & ~umask. `/bin/chmod` is the same tool the
    // operator would use; only on the real fs (tests inject FakeFs).
    if (fs === NODE_SOCKET_FS) {
      enforceSocketMode(opts.socketPath, posture.socketMode);
    }
    if (gid !== null) {
      const st = fs.statSync(opts.socketPath);
      try {
        // uid unchanged (we own it); only the group moves.
        fs.chownSync(opts.socketPath, st.uid, gid);
      } catch (err: any) {
        throw new Error(
          `Failed to chgrp the ops socket to group '${posture.group}' (gid ${gid}): ${err?.code ?? err?.message ?? err}. ` +
            `chgrp requires membership in the target group — join '${posture.group}' or pick a different FLAIR_SOCKET_GROUP.`,
        );
      }
    }
    socketApplied = true;
  }

  return {
    dirMode: posture.dirMode,
    socketMode: posture.socketMode,
    group: posture.group,
    gid,
    dirApplied: true,
    socketApplied,
    broadGroup,
  };
}

/** If Node chmodSync did not stick (Darwin unix sockets), use /bin/chmod. */
function enforceSocketMode(path: string, mode: number): void {
  const wanted = mode & 0o777;
  const got = statSync(path).mode & 0o777;
  if (got === wanted) return;
  execFileSync("chmod", [wanted.toString(8).padStart(3, "0"), path], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * Resolve + apply the ops-socket posture for a data dir, with the right
 * fatal-vs-warn handling. A broken FLAIR_SOCKET_GROUP opt-in is a hard error
 * (fail closed, no silent fallback); a failure of the owner-only default is
 * non-fatal defense-in-depth (warn — the dir gate remains the load-bearing
 * control). Returns the applied posture, or null on a non-fatal default-path
 * failure. The socket path is derived from dataDir so a --data-dir install is
 * gated at its own root, never a hardcoded ~/.flair.
 */
function readyOpsSocketPosture(dataDir: string): OpsSocketPostureResult | null {
  const socketPath = join(dataDir, "operations-server");
  const group = process.env.FLAIR_SOCKET_GROUP;
  const optedIn = !!(group && group.trim().length > 0);
  try {
    const res = applyOpsSocketPosture({ socketPath, group });
    if (res.broadGroup) {
      console.error(
        `warning: FLAIR_SOCKET_GROUP='${res.group}' is a broad system group — every member gets ops-socket access. Prefer a dedicated group.`,
      );
    }
    return res;
  } catch (err: any) {
    if (optedIn) throw err; // opt-in misconfiguration — fail closed
    console.error(
      `warning: could not tighten ops-socket permissions (${err?.message ?? err}); ` +
        `the ${dataDir} directory gate remains the primary control.`,
    );
    return null;
  }
}

/** How long the first-start path waits for Harper to create operations-server. */
export const OPS_SOCKET_AFTER_START_TIMEOUT_MS = 10_000;
const OPS_SOCKET_AFTER_START_POLL_MS = 50;

export interface ReadyOpsSocketPostureAfterStartOptions {
  timeoutMs?: number;
  pollMs?: number;
  /** After the wanted mode is observed, keep watching this long for a replace. */
  holdMs?: number;
  /** Socket mtime older than this is leftover; unlink and wait for Harper. */
  notBeforeMs?: number;
  /** True when a process is accepting on the socket (not a dead leftover). */
  isLive?: (path: string) => boolean | Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
  exists?: (path: string) => boolean;
  ready?: (dataDir: string) => OpsSocketPostureResult | null;
  stat?: (path: string) => { mode: number; ino: number; mtimeMs: number } | null;
  unlink?: (path: string) => void;
}

const OPS_SOCKET_AFTER_START_HOLD_MS = 500;

function statOpsSocket(path: string): { mode: number; ino: number; mtimeMs: number } | null {
  try {
    const s = statSync(path);
    return { mode: s.mode & 0o777, ino: s.ino, mtimeMs: s.mtimeMs };
  } catch {
    return null;
  }
}

/**
 * Drop `operations-server` while no process owns it (after the adopt stop,
 * before launchd load). Darwin #1704: chmod on the leftover inode never
 * became 0600 (`9413a80` burned the 10s wait, test still saw 0755). Harper
 * bind()s a new file; the helper must wait for that one.
 */
export function unlinkStaleOpsSocket(dataDir: string): void {
  try {
    unlinkSync(join(dataDir, "operations-server"));
  } catch {
    /* ENOENT or busy — helper waits for a post-bounce inode */
  }
}

/** True when something is accepting on `path` (dead leftover → false). */
export function probeOpsSocketListening(
  socketPath: string,
  timeoutMs = 250,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      sock.removeAllListeners();
      sock.destroy();
      resolve(ok);
    };
    const sock = createConnection(socketPath);
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => finish(true));
    sock.once("error", () => finish(false));
    sock.once("timeout", () => finish(false));
  });
}

/**
 * Apply the ops-socket posture after a start that did not go through
 * `waitForHealth` in this process (the launchd adopt/regenerate bounce).
 *
 * Darwin adopt CI on #1704 measured two races:
 *   1. HTTP can answer before Harper bind()s `operations-server`.
 *   2. A leftover socket from the pre-adopt direct process makes
 *      exists() true immediately; chmod'ing that inode is wasted —
 *      Harper unlinks and bind()s a new file at 0777 & ~umask (0755
 *      on the canary host). `76a9a15` hit (2): dir 0700, socket 0755.
 *
 * Keep applying while the socket exists until the wanted mode *holds*
 * for `holdMs` (Harper replacing the file during the hold restarts it).
 * A socket older than `notBeforeMs` is leftover — unlink it, do not chmod it.
 * A path that exists but is not accepting connections is leftover too
 * (`b381b5b` Darwin: chmod'd a dead inode to 0600, held 500ms, returned;
 * Harper then bind()d 0755).
 */
export async function readyOpsSocketPostureAfterStart(
  dataDir: string,
  opts: ReadyOpsSocketPostureAfterStartOptions = {},
): Promise<OpsSocketPostureResult | null> {
  const socketPath = join(dataDir, "operations-server");
  const timeoutMs = opts.timeoutMs ?? OPS_SOCKET_AFTER_START_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? OPS_SOCKET_AFTER_START_POLL_MS;
  const holdMs = opts.holdMs ?? OPS_SOCKET_AFTER_START_HOLD_MS;
  const notBeforeMs = opts.notBeforeMs;
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const exists = opts.exists ?? existsSync;
  const ready = opts.ready ?? readyOpsSocketPosture;
  const stat = opts.stat ?? statOpsSocket;
  const unlink = opts.unlink ?? ((p: string) => { try { unlinkSync(p); } catch { /* leftover busy */ } });
  const isLive = opts.isLive ?? ((p: string) => probeOpsSocketListening(p));
  const wanted = resolveSocketPosture(process.env.FLAIR_SOCKET_GROUP).socketMode;

  ready(dataDir); // dir gate now — the live socket may not exist yet
  const deadline = Date.now() + timeoutMs;
  let last: OpsSocketPostureResult | null = null;

  while (Date.now() < deadline) {
    if (exists(socketPath)) {
      const seen = stat(socketPath);
      const live = await isLive(socketPath);
      if (!live || (seen && notBeforeMs != null && seen.mtimeMs < notBeforeMs)) {
        unlink(socketPath);
        await sleep(pollMs);
        continue;
      }
      last = ready(dataDir);
      const applied = stat(socketPath);
      if (applied && applied.mode === wanted) {
        const holdDeadline = Date.now() + holdMs;
        let held = true;
        while (Date.now() < holdDeadline) {
          await sleep(pollMs);
          const now = exists(socketPath) ? stat(socketPath) : null;
          const stillLive = now ? await isLive(socketPath) : false;
          if (!now || now.mode !== wanted || !stillLive || (notBeforeMs != null && now.mtimeMs < notBeforeMs)) {
            held = false;
            break;
          }
        }
        if (held) return last;
        continue;
      }
    }
    await sleep(pollMs);
  }
  return last ?? ready(dataDir);
}

/**
 * The `flair doctor` detection matrix for the ops-socket posture (flair#763,
 * Sherlock's exact six rows). Report-only — never auto-remediated (changing a
 * live socket's mode needs a restart). Pure: takes the parent-dir mode, the
 * socket mode, and whether FLAIR_SOCKET_GROUP is set (the opt-in signal).
 */
export function classifyOpsSocketPosture(
  dirMode: number,
  socketMode: number,
  groupOptIn: boolean,
): { flagged: boolean; row: string; reason: string } {
  const dm = dirMode & 0o777;
  const sm = socketMode & 0o777;
  const dirWorld = (dm & 0o007) !== 0;
  const sockWorld = (sm & 0o007) !== 0;
  const dirGroup = (dm & 0o070) !== 0;
  const sockGroup = (sm & 0o070) !== 0;

  if (groupOptIn) {
    // Deliberate multi-user posture (dir 0750 / socket 0660). Clean as long as
    // no WORLD access leaked onto either — a world bit means a regressed mode.
    if (!dirWorld && !sockWorld) {
      return {
        flagged: false,
        row: "deliberate-group-clean",
        reason: "deliberate FLAIR_SOCKET_GROUP posture (dir 0750 / socket 0660) — no world access",
      };
    }
    return {
      flagged: true,
      row: "group-opt-in-world-open",
      reason: "FLAIR_SOCKET_GROUP is set but the parent directory or socket is world-accessible",
    };
  }

  // No opt-in. World access is the worst and takes precedence.
  if (dirWorld && sockWorld) {
    return {
      flagged: true,
      row: "both-open",
      reason: "both the socket's parent directory and the socket itself are group/world-accessible",
    };
  }
  if (dirWorld) {
    return {
      flagged: true,
      row: "root-open",
      reason: "the socket's parent directory is group/world-traversable — the primary access gate is breached",
    };
  }
  if (sockWorld) {
    return {
      flagged: true,
      row: "socket-open",
      reason: "the ops socket is group/world-accessible",
    };
  }
  // No world bits, but group bits present without the opt-in.
  if (dirGroup || sockGroup) {
    return {
      flagged: true,
      row: "group-mode-without-opt-in",
      reason: "the socket carries group permissions but FLAIR_SOCKET_GROUP is not set (unintended group access)",
    };
  }
  return {
    flagged: false,
    row: "default-clean",
    reason: "owner-only posture (dir 0700 / socket 0600)",
  };
}

// ─── Target resolution (remote Flair instance) ─────────────────────────────────
// --target <url> (or FLAIR_TARGET env) points all CLI operations at a remote
// Flair instance instead of localhost. This enables bootstrapping and
// managing Fabric-deployed Flair instances.

function resolveTarget(opts: { target?: string }): string | undefined {
  return opts.target || process.env.FLAIR_TARGET || undefined;
}

/** Resolve the ops API target URL from --ops-target flag or FLAIR_OPS_TARGET env.
 *  Returns undefined if neither is set (caller should fall back to derivation or localhost).
 */
function resolveOpsTarget(opts: { opsTarget?: string }): string | undefined {
  return opts.opsTarget || process.env.FLAIR_OPS_TARGET || undefined;
}

/** Derive the ops API URL from a Flair base URL.
 *  https with effective port 443 (no explicit port, or explicit :443): returns
 *    <host>:9925 (FABRIC_OPS_PORT) — the Fabric managed case where port-1/:442
 *    is a dead-end.
 *  All other cases unchanged:
 *    https with non-443 explicit port → port-1 (self-hosted TLS: 19926→19925, 8443→8442)
 *    http with explicit port → port-1 (19926→19925)
 *    http with no port → DEFAULT_OPS_PORT (19925)
 *  Bare hosts are normalised to https:// (effective-443 → Fabric path).
 *  Throws on unparseable URLs or out-of-range ports.
 */
/** Compute the effective ops API URL for remote commands.
 *  - If --ops-target is set, use it directly (no derivation).
 *  - Else if --target is set, derive ops URL via resolveOpsUrlFromTarget.
 *  - Else return undefined (fall back to localhost resolution).
 */
function resolveEffectiveOpsUrl(opts: { target?: string; opsTarget?: string }): string | undefined {
  const opsTarget = resolveOpsTarget(opts);
  if (opsTarget) return opsTarget.replace(/\/$/, "");
  const target = resolveTarget(opts);
  if (target) return resolveOpsUrlFromTarget(target);
  return undefined;
}

function resolveOpsUrlFromTarget(targetUrl: string): string {
  // Normalise bare hosts: add https:// prefix so URL parser can handle them.
  const normalised = targetUrl.includes("://") ? targetUrl : `https://${targetUrl}`;
  const url = new URL(normalised);

  // https target with effective port 443 (no explicit port, or explicit :443):
  // this is the Fabric managed case — the ops API is on the well-known Fabric
  // ops port, never REST-adjacent. The port-1 / :442 logic is a dead-end here.
  if (url.protocol === "https:" && (url.port === "" || url.port === "443")) {
    url.port = String(FABRIC_OPS_PORT);
    return url.toString().replace(/\/$/, "");
  }

  // All other cases: unchanged port-1 convention.
  //   https with non-443 explicit port → port-1 (self-hosted TLS: 19926→19925, 8443→8442)
  //   http with explicit port → port-1 (19926→19925)
  //   http with no port → DEFAULT_OPS_PORT (19925)
  const port = parseInt(url.port, 10);
  if (!isNaN(port) && port > 0 && port <= 65535) {
    const opsPort = port - 1;
    if (opsPort < 1) throw new Error(`Derived ops port ${opsPort} is out of range; target port must be > 1`);
    url.port = String(opsPort);
    return url.toString().replace(/\/$/, "");
  }
  // No valid explicit port — reject port 0 or out-of-range
  if (url.port !== "" && url.port !== undefined) {
    throw new Error(`Invalid target port: ${url.port} (must be 1-65535)`);
  }
  // No explicit port on http — use the default ops port.
  url.port = String(DEFAULT_OPS_PORT);
  return url.toString().replace(/\/$/, "");
}

/**
 * Persist the instance coordinates other commands need to find and re-assert
 * this install (flair#863).
 *
 * This rewrites the file wholesale, so `opsPort`/`opsBind`/`httpBind` default to
 * whatever is already persisted rather than being dropped — otherwise an
 * unrelated caller (e.g. `flair doctor --fix` correcting a drifted HTTP port)
 * would silently erase the operator's `--ops-bind` or `--http-bind` choice and
 * the next restart would revert the bind.
 */
function writeConfig(port: number, opsPort?: number, opsBind?: string, path: string = configPath(), httpBind?: string): void {
  const resolvedOpsPort = opsPort ?? readOpsPortFromConfig(path);
  const resolvedOpsBind = opsBind ?? readOpsBindFromConfig(path);
  const resolvedHttpBind = httpBind ?? readHttpBindFromConfig(path);
  mkdirSync(dirname(path), { recursive: true });
  let body = `# Flair configuration\nport: ${port}\n`;
  if (resolvedOpsPort !== null && resolvedOpsPort !== undefined) body += `opsPort: ${resolvedOpsPort}\n`;
  if (resolvedOpsBind) body += `opsBind: ${resolvedOpsBind}\n`;
  if (resolvedHttpBind) body += `httpBind: ${resolvedHttpBind}\n`;
  writeFileSync(path, body);
}

/**
 * Persist the coordinates of the instance served from `dataDir` (flair#914).
 *
 * Harper records its OWN coordinates — `rootPath`, `http.port`,
 * `operationsApi.network.port` — into `<dataDir>/harper-config.yaml` on every
 * boot, and that is what `resolveHttpPort` reads. So there is nothing
 * instance-local for flair to write: the instance already describes itself, and
 * a second copy is a drift source, not a record (flair#937).
 *
 * What remains is the per-user file, and the GUARD on it is the whole of the
 * flair#914 fix. `init` used to write `~/.flair/config.yaml` unconditionally, so
 * `flair init --data-dir X --port P` overwrote whatever port the DEFAULT install
 * had recorded, and every later lookup answered with P. Writing it only for the
 * default install is what makes one instance's `init` unable to renumber
 * another's.
 *
 * The guard lives HERE rather than at the call sites: a caller that forgets it
 * reintroduces flair#914 silently, and there is no test that would notice at the
 * call site it was forgotten in.
 *
 * It keeps the readers that have no `--data-dir` of their own
 * (`readPortFromConfig` — `flair uninstall`, the `rem` scheduler, `api()`,
 * doctor's config line) correct for the one instance they are able to address.
 * Those read Harper's config directly when the lifecycle commands grow the flag,
 * and this file goes with them.
 */
function persistDefaultInstallCoordinates(dataDir: string, port: number, opsPort?: number, opsBind?: string, httpBind?: string): void {
  if (isDefaultDataDir(dataDir)) writeConfig(port, opsPort, opsBind, configPath(), httpBind);
}

function privKeyPath(agentId: string, keysDir: string): string {
  return join(keysDir, `${agentId}.key`);
}

function pubKeyPath(agentId: string, keysDir: string): string {
  return join(keysDir, `${agentId}.pub`);
}


function flairPackageDir(): string {
  // dist/cli.js → package root (one level up from dist/)
  return join(import.meta.dirname ?? __dirname, "..");
}

/**
 * Harper npm package names this build knows about, newest-convention first.
 *
 * flair#870: flair depends on the BARE `harper` package name. The scoped
 * `@harperfast/harper` name is kept as a fallback so an in-place upgrade over
 * a pre-#870 install (whose node_modules still holds the scoped copy, and
 * whose Harper is the one currently serving the data dir) keeps booting until
 * the next clean install. Bare name is tried first so a tree that has BOTH
 * resolves to the one flair actually declares.
 *
 * This list is a FALLBACK, not the authority — see declaredHarperPackageNames.
 */
const KNOWN_HARPER_PACKAGE_NAMES = ["harper", "@harperfast/harper"] as const;

/**
 * The Harper package name(s) the install at `packageRoot` actually declares,
 * read fresh off disk on every call.
 *
 * flair#905: `flair upgrade` replaces this package tree while the CLI is
 * executing out of it, so anything the running code "knows" about the tree
 * describes the tree that WAS there, not the one that is. That is exactly how
 * the 0.29.0 → 0.30.0 upgrade broke: 0.30.0 renamed its Harper dependency
 * `@harperfast/harper` → `harper` (flair#870), 0.29.0's resolver only ever
 * probed the scoped name, and the post-swap tree no longer had it — so the
 * restart reported "Harper binary not found" against an install that was
 * perfectly intact. Deriving the name from the package.json sitting at
 * `packageRoot` reads the POST-swap truth instead of a compiled-in guess, so a
 * future rename cannot break the same way.
 *
 * Matches `harper` and `@scope/harper` only — never `harper-fabric-embeddings`
 * or any other `harper`-prefixed dependency.
 */
export function declaredHarperPackageNames(packageRoot: string): string[] {
  try {
    const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf-8")) as {
      dependencies?: Record<string, string>;
    };
    return Object.keys(pkg.dependencies ?? {}).filter((n) => /^(@[^/]+\/)?harper$/.test(n));
  } catch {
    return [];
  }
}

/**
 * Locate a Harper binary under `roots`, and report every path that was tried.
 *
 * The `searched` list is not decoration: "Harper binary not found" with no
 * paths is unactionable, and the message it replaced named the wrong remedy
 * (flair#905). Callers surface these paths verbatim.
 */
export function resolveHarperBin(roots: string[]): { path: string | null; searched: string[] } {
  const searched: string[] = [];
  for (const root of roots) {
    const names = [...declaredHarperPackageNames(root), ...KNOWN_HARPER_PACKAGE_NAMES];
    for (const name of names) {
      const candidate = join(root, "node_modules", ...name.split("/"), "dist", "bin", "harper.js");
      if (searched.includes(candidate)) continue;
      searched.push(candidate);
      if (existsSync(candidate)) return { path: candidate, searched };
    }
  }
  return { path: null, searched };
}

/**
 * Roots under which a Harper install is looked for: this package's own
 * directory (dist/cli.js → ../node_modules/...) then the caller's cwd.
 *
 * Recomputed per call rather than captured at module load — see
 * declaredHarperPackageNames for why anything cached across a package swap is
 * a bug waiting to happen.
 */
function harperSearchRoots(): string[] {
  return [flairPackageDir(), process.cwd()];
}

/**
 * The operator-facing message for "we looked for Harper and it isn't there".
 *
 * flair#905: the text this replaces was `Harper binary not found. Run 'flair
 * init' first.` — which is wrong twice over on an initialised instance. It
 * names no path, so there is nothing to check; and `flair init` cannot fix a
 * missing Harper (init resolves the same binary the same way) while it CAN be
 * mistaken for "re-provision my instance" by someone reading it at 3am. A
 * missing binary is an incomplete package tree, so the remedy is a reinstall.
 */
export function harperBinNotFoundMessage(searched: string[]): string {
  return [
    "Harper binary not found — this Flair package tree looks incomplete.",
    "   Searched:",
    ...searched.map((p) => `     ${p}`),
    "   Reinstall the package: npm install -g @tpsdev-ai/flair@latest",
    "   Your data in ~/.flair is untouched — `flair init` will NOT fix this (it resolves the same binary).",
  ].join("\n");
}

function harperBin(): string | null {
  return resolveHarperBin(harperSearchRoots()).path;
}

/**
 * Parse `lsof -ti` output into PIDs safe to signal as "the thing on this port".
 *
 * Two filters, both load-bearing (flair#800, extended by flair#905):
 *
 * A bare `lsof -ti :<port>` matches CLIENT sockets as well as the listening
 * server — including the calling process's OWN keep-alive connections, left by
 * anything that has spoken HTTP to that port in this run (the version-handshake
 * nudge on every command, a health probe, a caller's `fetch`). `-sTCP:LISTEN`
 * on the command narrows it to the server; this function is the second half:
 * never return our own PID, whatever lsof said. flair#800 was that exact
 * self-SIGTERM in `flair upgrade`'s stop step; the same unfiltered pattern
 * survived in `flair stop`, `flair uninstall` and `flair doctor`, where it can
 * kill the caller, kill an unrelated client, or tell an operator to `kill` the
 * PID of the shell they are typing into.
 */
export function parseListeningPids(lsofOutput: string, selfPid: number): number[] {
  return (lsofOutput ?? "")
    .trim()
    .split("\n")
    .map((s) => Number(s.trim()))
    .filter((pid) => Number.isFinite(pid) && pid > 0 && pid !== selfPid);
}

/**
 * PIDs LISTENING on `port`, never this process. Empty when nothing is there or
 * lsof is unavailable — callers treat that as "not running".
 */
function listeningPidsOnPort(port: number, exec: (cmd: string) => string): number[] {
  try {
    return parseListeningPids(exec(`lsof -ti :${port} -sTCP:LISTEN`), process.pid);
  } catch {
    return [];
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

// isLocalBase / ApiHttpError / resolveKeyPath / buildEd25519Auth / authFetch
// now live in src/lib/auth-resolve.ts (flair#747) — imported above.

/**
 * api() resolves the request's Harper HTTP/REST auth via the shared
 * `authedRequest` (src/lib/auth-resolve.ts — see that module's header for
 * the full 5-tier resolution order, including tier 5, the Ed25519 agent-key
 * FLOOR this used to lack entirely).
 *
 * SIGNING IDENTITY (flair#1183): a caller that has already resolved the signer
 * — every user-facing command does, via `resolveSigningAgentId` (flag > env >
 * config profile) — passes it as `options.agentId`, and that value is
 * AUTHORITATIVE. api() does NOT re-derive it from the environment in that case.
 * That re-derivation was the bug: api() used to compute the signer as
 * `FLAIR_AGENT_ID env > body.agentId`, so a command run with `--agent X` while
 * `FLAIR_AGENT_ID=Y` was exported signed as Y — inverting the documented
 * precedence and silently disagreeing with the record/query, which both named X.
 *
 * Only when the caller passes NO agentId (the `"agentId" in options` check
 * distinguishes an omitted key from an explicit `null`) does api() fall back to
 * the legacy request-shape extraction — FLAIR_AGENT_ID env, then an agentId
 * embedded in the body/query string. That path serves the admin/federation
 * callers that resolve no identity of their own and lean on admin-pass / the
 * floor, so their behavior is unchanged.
 *
 * NOTE: this function is for the Harper HTTP/REST API only. The Harper
 * operations API (used by seedAgentViaOpsApi / seedFederationInstanceViaOpsApi)
 * ALSO honors authorizeLocal: a header-less loopback request to the ops port
 * is auto-authorized as super_user (verified by live probe — flair#610). Those
 * helpers nonetheless send Basic admin auth UNCONDITIONALLY, so they never
 * depend on that ambient elevation and behave identically against a remote or
 * hardened instance. Hardening the ops-API loopback posture itself (bind scope
 * / disabling authorizeLocal there) is tracked separately in flair#654 and is
 * out of scope for this HTTP/REST auth path.
 */
async function api(method: string, path: string, body?: any, options?: { baseUrl?: string; keysDir?: string; agentId?: string | null; agentIdSource?: SigningIdentitySource; explicitAdminPass?: string; adminUser?: string }): Promise<any> {
  // Resolve port via the canonical path (flair#1129): options.baseUrl > FLAIR_URL > resolveHttpPort.
  // api() callers mean the default install, so resolveHttpPort({}) with no --data-dir is correct.
  const hasExplicitBase = !!(options?.baseUrl || process.env.FLAIR_URL);
  const base = options?.baseUrl ?? (process.env.FLAIR_URL || `http://127.0.0.1:${resolveHttpPort({})}`);

  let agentId: string | undefined;
  if (options && "agentId" in options) {
    // The caller resolved the signing identity (flag > env > config profile)
    // and it is AUTHORITATIVE — never override it with FLAIR_AGENT_ID here
    // (that inversion is flair#1183). An explicit null means "no identity
    // resolved"; honor it and let authedRequest fall to admin-pass / the floor.
    agentId = options.agentId ?? undefined;
  } else {
    // Legacy request-shape extraction for callers that resolve no identity of
    // their own (admin/federation ops): FLAIR_AGENT_ID env, then the body
    // (POST/PUT) / URL query params (GET).
    agentId = process.env.FLAIR_AGENT_ID || (body && typeof body === "object" ? body.agentId : undefined);
    if (!agentId && path.includes("agentId=")) {
      const match = path.match(/agentId=([^&]+)/);
      if (match) agentId = decodeURIComponent(match[1]);
    }
  }

  const requestOptions = {
    baseUrl: base,
    agentId,
    keysDir: options?.keysDir,
    explicitAdminPass: options?.explicitAdminPass,
    adminUser: options?.adminUser,
    agentIdSource: options?.agentIdSource,
  };

  try {
    return await authedRequest(method, path, body, requestOptions);
  } catch (err) {
    // flair#1719: the resolved port came from Harper's boot record, which can
    // be stale for the default install. Before surfacing a connect failure,
    // try the port the operator actually wrote in ~/.flair/config.yaml.
    const altPort = hasExplicitBase ? null : alternateConfiguredLocalPort({});
    if (altPort !== null && isFederationStatusConnectFailure(err)) {
      const altUrl = `http://127.0.0.1:${altPort}`;
      try {
        return await authedRequest(method, path, body, { ...requestOptions, baseUrl: altUrl });
      } catch (altErr) {
        throw describeApiConnectFailure(altErr, altUrl);
      }
    }
    throw describeApiConnectFailure(err, base);
  }
}

/**
 * Turn undici/Node's bare `TypeError: fetch failed` into a sentence naming the
 * actor (the Flair instance URL), the state (no HTTP response) and a remedy
 * the operator can act on — flair#1719 requirement 3. Non-connect errors
 * (HTTP 401/403/5xx, auth failures) pass through unchanged so callers keep
 * their own handling. The `flairFriendly` marker lets the top-level CLI entry
 * print just the message instead of a stack.
 */
function describeApiConnectFailure(err: unknown, url: string): unknown {
  if (!isFederationStatusConnectFailure(err)) return err;
  const friendly = new Error(
    `Cannot reach the Flair instance at ${url} — the connection failed (no HTTP response).\n`
    + `  Start it with \`flair start\`, or point this command at the right instance with `
    + `FLAIR_URL=http://127.0.0.1:<port> (or --url on commands that accept it).`,
  );
  (friendly as { flairFriendly?: boolean }).flairFriendly = true;
  (friendly as { cause?: unknown }).cause = err;
  return friendly;
}

/**
 * The authedGet `flair upgrade` verification (flair#635/#741) hands to
 * probeInstance() — now a one-line delegation to api(), since api() itself
 * carries the tier-5 agent-key floor this wrapper used to implement
 * standalone (flair#747 generalized flair#742's fix from "upgrade
 * verification only" into api()'s own resolution chain, so every api()
 * caller gets it, not just this one).
 *
 * Auth requirement of the verification target itself: /HealthDetail
 * (probeInstance's default versionPath) is NOT admin-gated — its
 * `allowRead()` is `allowVerified()` (resources/health.ts, resources/agent-
 * auth.ts), which permits ANY registered agent, not just admins. So a
 * signed request from any registered agent's key is sufficient; there's no
 * need to special-case a different, more-public endpoint.
 */
export async function verifyAuthedGet(baseUrl: string, path: string, keysDir: string): Promise<any> {
  return api("GET", path, undefined, { baseUrl, keysDir });
}

/**
 * flair#741 fix #3: does this ProbeResult's failure mean "the server
 * responded but rejected the verifier's credentials" — proof of liveness,
 * NOT a data-integrity risk — as opposed to a genuine down/unreachable/5xx
 * failure where the instance's real state can't be determined? Pure.
 *
 * This is the single predicate behind three call sites in the `upgrade`
 * command: whether the pre-upgrade credential pre-flight aborts (fix #1),
 * and whether the post-restart / post-rollback verification failure
 * messages claim "instance state UNKNOWN — do not assume data integrity"
 * (they must NOT, for this case — that's the flair#741 incident itself) or
 * explain the real, much less scary situation instead.
 */
export function isCredentialOnlyFailure(result: ProbeResult): boolean {
  return result.healthy === true && result.authFailureKind === "credentials";
}

async function waitForHealth(httpPort: number, adminUser: string, adminPass: string, timeoutMs: number): Promise<void> {
  const url = `http://127.0.0.1:${httpPort}/Health`;
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt++;
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Basic ${Buffer.from(`${adminUser}:${adminPass}`).toString("base64")}` },
        signal: AbortSignal.timeout(2000),
      });
      // 2xx = healthy; 401 = Harper up but credentials wrong — still "reachable"
      // enough for restart success. Anything else (5xx, 502 during shutdown) keeps polling.
      if (res.ok || res.status === 401) return;
    } catch { /* not ready yet */ }
    await new Promise((r) => setTimeout(r, HEALTH_POLL_INTERVAL_MS));
  }
  throw new Error(`Harper at port ${httpPort} did not respond within ${timeoutMs}ms (${attempt} attempts)`);
}

/**
 * Result of a real embed→search round-trip:
 *   - ok:       semantic recall verified (paraphrase, no keyword overlap, matched by meaning)
 *   - degraded: embeddings are NOT loaded — recall-by-meaning is dead (LOUD failure)
 *   - failed:   the instance REJECTED the probe's signature (HTTP 401/403) — a
 *               real auth defect (stale/unregistered key) or a doctor defect.
 *               flair#1501: this must be loud (✗ + remedy), never a soft
 *               "not verified".
 *   - skipped:  could not run the check (no agent / no key / write failed for unrelated reasons)
 */
export type SemanticVerifyResult =
  | { state: "ok"; score: number }
  | { state: "degraded"; detail: string }
  | { state: "failed"; detail: string }
  // flair#1023: `skipped` covers several unrelated situations, and the
  // renderer used to print ONE remedy ("pass --agent") for all of them —
  // advice that cannot fix a key that won't decode, or an HTTP 500 from the
  // probe. `reason` is what lets the caller pick a remedy that is actually
  // reachable from the failure, instead of a remedy-shaped sentence.
  | { state: "skipped"; reason: SemanticSkipReason; detail: string };

/**
 * A probe's signing identity, resolved the way a real CLI command resolves it
 * (flair#1501).
 *
 * `source` records which tier won so the probe's warning line can name it:
 *   - "flag" / "env"       — an explicit `--agent` / `FLAIR_AGENT_ID`. That
 *                            identity is used VERBATIM, registered or not: a
 *                            named identity is never silently substituted
 *                            (flair#1500), and if the server rejects it the
 *                            probe says so loudly rather than quietly trying
 *                            a different key.
 *   - "local-registered"   — nothing was named, so this is the first agent key
 *                            under `keysDir` that the instance actually
 *                            ACCEPTS (checkAgentRegistered). Before #1501 the
 *                            probe signed with whatever `.key` sorted first,
 *                            so a leftover/unregistered key turned a healthy
 *                            instance into a spurious 401 invalid_signature.
 *   - "none"               — no usable identity at all (`agentId: null`). The
 *                            caller renders this as "not verified", never as
 *                            a pass.
 */
export interface ProbeSigningIdentity {
  agentId: string | null;
  source: SigningIdentitySource | "local-registered";
  /** The key file the identity will sign with (agent identities only). */
  keyPath?: string;
  /** Human-readable reason when `agentId` is null (or the candidate list a
   *  caller wants in a warning). */
  detail?: string;
}

/** `<keysDir>/<id>.key` — the fallback key location for tests and non-standard
 *  key dirs; the standard `resolveKeyPath` lookup is always tried first. */
function fallbackKeyPath(keysDir: string, agentId: string): string | null {
  const candidate = join(keysDir, `${agentId}.key`);
  return existsSync(candidate) ? candidate : null;
}

/**
 * Resolve the identity a doctor/init probe signs with (flair#1501).
 *
 * Precedence is the SAME as every real command (`resolveSigningIdentity`:
 * `--agent` flag > `FLAIR_AGENT_ID` env) so doctor and `flair memory add`
 * cannot disagree about who is calling. The difference is what happens when
 * NOTHING is named: the old probe blindly used the first `.key` in the
 * directory — an assumption that a local key is a registered one. This instead
 * picks the first agent key the instance ACCEPTS, which is the only assumption
 * a healthy agent-keyed instance can satisfy. Node-scoped federation keys are
 * skipped (they cannot sign — flair#1193).
 *
 * Deliberately NOT falling through to an admin credential when nothing is
 * named: the embeddings/audit probes verify the agent-keyed write path, and a
 * silent admin substitution would report a healthy instance even when the
 * agent identity is broken — the exact class of false green this check exists
 * to prevent. A genuinely broken named identity still reaches the network and
 * is reported as `failed` (HTTP 401/403), not papered over.
 */
export async function resolveProbeSigningIdentity(
  baseUrl: string,
  agentIdOpt: string | undefined,
  keysDir: string,
): Promise<ProbeSigningIdentity> {
  const named = resolveSigningIdentity({ agent: agentIdOpt });
  if (named.agentId) {
    const keyPath = resolveKeyPath(named.agentId) ?? fallbackKeyPath(keysDir, named.agentId);
    return { agentId: named.agentId, source: named.source, keyPath: keyPath ?? undefined };
  }
  let keyFiles: string[] = [];
  try {
    keyFiles = readdirSync(keysDir).filter((f) => f.endsWith(".key")).sort();
  } catch { /* keysDir missing */ }
  const candidates = keyFiles
    .map((f) => f.replace(/\.key$/, ""))
    .filter((id) => !isNodeKeyId(id, keysDir));
  if (candidates.length === 0) {
    return { agentId: null, source: "none", detail: "no agent id or key found" };
  }
  const rejected: string[] = [];
  for (const id of candidates) {
    const reg = await checkAgentRegistered(baseUrl, id, keysDir);
    if (reg.state === "registered") {
      const keyPath = resolveKeyPath(id) ?? fallbackKeyPath(keysDir, id);
      return { agentId: id, source: "local-registered", keyPath: keyPath ?? undefined };
    }
    rejected.push(`${id} (${reg.state}${reg.detail ? `: ${reg.detail}` : ""})`);
  }
  return {
    agentId: null,
    source: "none",
    detail: `no local agent key is registered on this instance — tried: ${rejected.join(", ")}`,
  };
}

/**
 * Verify that semantic search ACTUALLY works by storing a memory with a
 * distinctive phrase and searching for a PARAPHRASE (different words, same
 * meaning). If embeddings are loaded, the paraphrase recovers the memory by
 * meaning with a genuine semantic score. If embeddings are NOT loaded,
 * SemanticSearch falls back to keyword-only scan: the paraphrase shares no
 * keywords with the stored content, so the memory is NOT recovered (or only via
 * the `_warning` keyword-fallback marker) → "degraded".
 *
 * The probe is authenticated as a real agent (Ed25519) because SemanticSearch
 * rejects anonymous callers (401) and per-agent scoping requires it. The
 * identity is resolved the same way a real command resolves it (flair#1501):
 * `--agent` flag > `FLAIR_AGENT_ID` env, else the first local agent key the
 * instance ACCEPTS (never merely the first `.key` on disk).
 *
 * Exported so the init smoke test and unit tests can reuse the exact same gate.
 */
export async function verifySemanticSearch(
  baseUrl: string,
  agentIdOpt: string | undefined,
  keysDir: string,
): Promise<SemanticVerifyResult> {
  // Resolve an agent + key to sign with (flair#1501 — see
  // resolveProbeSigningIdentity for why the first `.key` is no longer trusted).
  const identity = await resolveProbeSigningIdentity(baseUrl, agentIdOpt, keysDir);
  const agentId = identity.agentId;
  if (!agentId) {
    return { state: "skipped", reason: "no-agent", detail: identity.detail ?? "no agent id or key found" };
  }
  const keyPath = identity.keyPath;
  if (!keyPath) {
    return { state: "skipped", reason: "no-key", detail: `no private key for agent '${agentId}'` };
  }
  // Name the signer in every failure detail (flair#1501 ask 1): an operator
  // reading `doctor`/`init` output must not have to hunt for who was signing.
  const signerLabel = `signed as '${agentId}' (${identity.source}) with key ${keyPath}`;

  // Distinctive content vs. a PARAPHRASE query with deliberately ZERO shared
  // content words. If the search recovers the memory it can ONLY be by meaning.
  //   content: "The feline predator silently stalked its unsuspecting rodent quarry at dusk."
  //   query:   "a cat hunting a mouse in the evening"
  // No word in the query appears in the content (cat≠feline, mouse≠rodent,
  // hunting≠stalked, evening≠dusk), so a keyword scan returns nothing.
  const marker = `flair-doctor-embed-check-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const id = marker;
  const content = `The feline predator silently stalked its unsuspecting rodent quarry at dusk. [${marker}]`;
  const paraphrase = "a cat hunting a mouse in the evening";

  let stored = false;
  try {
    // Write the test memory (ephemeral so it's never durable). PUT /Memory/<id>.
    const writeRes = await authFetch(baseUrl, agentId, keyPath, "PUT", `/Memory/${id}`, {
      id, agentId, content, durability: "ephemeral", createdAt: new Date().toISOString(),
    });
    if (!writeRes.ok && writeRes.status !== 204) {
      const text = await writeRes.text().catch(() => "");
      // flair#1501: a rejected signature is either a real auth defect or a
      // doctor defect — both need a person. Never downgrade it to "skipped".
      if (writeRes.status === 401 || writeRes.status === 403) {
        return { state: "failed", detail: `probe write rejected: HTTP ${writeRes.status} ${text.slice(0, 100)} — ${signerLabel}` };
      }
      return { state: "skipped", reason: "probe-failed", detail: `could not write probe memory: HTTP ${writeRes.status} ${text.slice(0, 80)}` };
    }
    stored = true;

    // Allow the HNSW index to catch up before searching.
    await new Promise((r) => setTimeout(r, 1500));

    // Search by PARAPHRASE. scoring: "raw" so we read the unweighted semantic
    // similarity (_rawScore) directly, without recency/durability composites
    // muddying the keyword-vs-semantic distinction.
    const searchRes = await authFetch(baseUrl, agentId, keyPath, "POST", "/SemanticSearch", {
      agentId, q: paraphrase, limit: 10, scoring: "raw",
    });
    if (!searchRes.ok) {
      const text = await searchRes.text().catch(() => "");
      if (searchRes.status === 401 || searchRes.status === 403) {
        return { state: "failed", detail: `SemanticSearch rejected: HTTP ${searchRes.status} ${text.slice(0, 100)} — ${signerLabel}` };
      }
      return { state: "skipped", reason: "probe-failed", detail: `SemanticSearch failed: HTTP ${searchRes.status} ${text.slice(0, 80)}` };
    }
    const data = await searchRes.json() as { results?: any[]; _warning?: string };

    // The server sets _warning ONLY when getMode() === "none" — i.e. the
    // embedding engine failed to init and the search ran keyword-only. That is
    // the unambiguous "embeddings not loaded" signal.
    if (data._warning) {
      return { state: "degraded", detail: data._warning };
    }

    const results = data.results ?? [];
    const hit = results.find((r) => r.id === id);
    if (!hit) {
      // The paraphrase shares no keywords with the content, so a keyword-only
      // fallback can't find it. Missing the memory == recall-by-meaning is dead.
      return { state: "degraded", detail: "paraphrase did not recall the probe memory (keyword-only fallback active)" };
    }

    // A genuine semantic hit has a positive similarity score. The keyword bonus
    // is +0.05; since there is no keyword overlap here, any score above that
    // floor can only come from vector similarity. Require a real semantic score.
    const score = typeof hit._rawScore === "number" ? hit._rawScore : (hit._score ?? 0);
    if (score <= 0.05) {
      return { state: "degraded", detail: `probe recalled with non-semantic score ${score} (keyword/zero)` };
    }
    return { state: "ok", score };
  } catch (err: unknown) {
    // flair#1023: distinguish "your key will not load" from "the probe
    // request failed". The former is raised before any request leaves the
    // process, so it is never evidence about the instance — and "pass
    // --agent" cannot fix it.
    if (err instanceof KeyLoadError) {
      return { state: "skipped", reason: "key-load", detail: err.message };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { state: "skipped", reason: "probe-failed", detail: `probe error: ${message.slice(0, 100)}` };
  } finally {
    // Best-effort cleanup of the ephemeral probe memory.
    if (stored) {
      try {
        await authFetch(baseUrl, agentId, keyPath, "DELETE", `/Memory/${id}`);
      } catch { /* leave the ephemeral row; it'll age out */ }
    }
  }
}

/**
 * Result of a real write→read_audit_log round-trip (flair#970):
 *   - ok:       the probe's writes came back as audit entries — the audit log
 *               is RECORDING NOW. Deliberately not carrying any stronger
 *               claim: this proves current recording, never historical
 *               completeness (a node that joined or resynced via base copy has
 *               a hard start boundary at copy time — harper#2212 — so "ok"
 *               must never be rendered as "history complete/healthy").
 *   - degraded: cause "not-recording" — read_audit_log answered cleanly but
 *               the probe's writes are missing (audit enabled, pipeline not
 *               recording: the exact silent state flair#970 observed);
 *               cause "disabled" — read_audit_log 400s because
 *               `logging.auditLog` is off in the ROOT harperdb-config.yaml.
 *   - failed:   the instance REJECTED the probe's signature (HTTP 401/403 on a
 *               write) — a real auth defect (stale/unregistered key) or a
 *               doctor defect. flair#1501: loud (✗ + remedy), never a soft
 *               "UNVERIFIED".
 *   - skipped:  could not run the check (no agent/key, no admin credentials
 *               for the ops API, ops API unreachable, probe write failed for
 *               an unrelated reason). Callers MUST render this as UNVERIFIED —
 *               an unrun check must not look like a pass.
 */
export type AuditVerifyResult =
  | { state: "ok" }
  | { state: "degraded"; cause: "not-recording" | "disabled"; detail: string }
  | { state: "failed"; detail: string }
  | { state: "skipped"; reason: AuditSkipReason; detail: string };

export type AuditSkipReason =
  | "no-agent"
  | "no-key"
  | "key-load"
  | "no-admin-credentials"
  | "probe-failed";

/**
 * Positive control for the Harper audit log (flair#970): verify that audit
 * ACTUALLY records by writing and then reading the audit trail back — never by
 * trusting the `audit: true` flag `describe_table` reports.
 *
 * Why a positive control: records applied via cluster base-copy/resync are
 * committed with audit explicitly disabled (harper Table.ts isCopyApply, filed
 * upstream as harper#2212), so a node can report audit enabled, answer
 * read_audit_log with HTTP 200, and still hold zero entries. Before this
 * check, nothing in flair declared, read, or verified audit — the canonical
 * check that cannot fire.
 *
 * Probe (modeled on verifySemanticSearch above, same skipped/degraded/ok
 * discipline):
 *   1. PUT an ephemeral probe row (id `flair-doctor-audit-probe-<uuid>`,
 *      short inert marker content — ephemeral durability so a failed cleanup
 *      self-prunes; the DELETE in `finally` is best-effort).
 *   2. PATCH it — verified live on harper@5.2.0: PATCH /Memory/<id> returns
 *      204 and generates an audit entry with operation "patch" (PUT generates
 *      "upsert", DELETE "delete").
 *   3. `read_audit_log` (search_type hash_value, the probe id) over the ops
 *      API with Basic admin auth — the operations API only exists on its own
 *      port/socket, so the agent's Ed25519 header cannot authenticate it.
 *   4. Assert BOTH write entries are present. The probe's own DELETE lands
 *      AFTER the read, so it is never required (audit is append-only; the
 *      probe's entries persisting after the row is gone is by design).
 *
 * All assertions are BOOLEAN (entry counts only). Audit entries carry full
 * record images (`records: [value]`), so no entry content is ever copied into
 * a result detail — the detail strings are fixed text plus counts/statuses.
 */
export async function verifyAuditLog(
  baseUrl: string,
  agentIdOpt: string | undefined,
  keysDir: string,
  opsUrl: string,
  adminUser: string | undefined,
  adminPass: string | undefined,
): Promise<AuditVerifyResult> {
  // Resolve an agent + key to sign the probe writes with — identical
  // resolution to verifySemanticSearch (flair#1501) so the two probes agree on
  // identity, and neither signs with a stale first-`.key`-on-disk.
  const identity = await resolveProbeSigningIdentity(baseUrl, agentIdOpt, keysDir);
  const agentId = identity.agentId;
  if (!agentId) {
    return { state: "skipped", reason: "no-agent", detail: identity.detail ?? "no agent id or key found" };
  }
  const keyPath = identity.keyPath;
  if (!keyPath) {
    return { state: "skipped", reason: "no-key", detail: `no private key for agent '${agentId}'` };
  }
  const signerLabel = `signed as '${agentId}' (${identity.source}) with key ${keyPath}`;
  if (!adminUser || !adminPass) {
    return {
      state: "skipped",
      reason: "no-admin-credentials",
      detail: "no admin credentials for the ops API (read_audit_log requires them)",
    };
  }

  const id = `flair-doctor-audit-probe-${randomUUID()}`;
  const path = `/Memory/${id}`;
  let stored = false;
  try {
    // Write 1: PUT the probe row. Ephemeral durability — TTL is the cleanup
    // backstop if the finally-DELETE fails.
    const putRes = await authFetch(baseUrl, agentId, keyPath, "PUT", path, {
      id,
      agentId,
      content: `flair doctor audit probe (inert marker, safe to ignore) [${id}]`,
      durability: "ephemeral",
      createdAt: new Date().toISOString(),
    });
    if (!putRes.ok && putRes.status !== 204) {
      const text = await putRes.text().catch(() => "");
      if (putRes.status === 401 || putRes.status === 403) {
        return { state: "failed", detail: `probe write rejected: HTTP ${putRes.status} ${text.slice(0, 100)} — ${signerLabel}` };
      }
      return { state: "skipped", reason: "probe-failed", detail: `could not write probe row: HTTP ${putRes.status}` };
    }
    stored = true;

    // Write 2: PATCH — a second, distinct audit-visible write (live-verified
    // to produce its own entry on harper@5.2.0; see doc comment).
    const patchRes = await authFetch(baseUrl, agentId, keyPath, "PATCH", path, {
      content: `flair doctor audit probe (inert marker, second write) [${id}]`,
    });
    if (!patchRes.ok && patchRes.status !== 204) {
      const text = await patchRes.text().catch(() => "");
      if (patchRes.status === 401 || patchRes.status === 403) {
        return { state: "failed", detail: `probe write rejected: HTTP ${patchRes.status} ${text.slice(0, 100)} — ${signerLabel}` };
      }
      return { state: "skipped", reason: "probe-failed", detail: `could not apply second probe write: HTTP ${patchRes.status}` };
    }

    // Read the audit trail back over the ops API.
    let auditRes: Response;
    try {
      auditRes = await fetch(`${opsUrl.replace(/\/+$/, "")}/`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Basic ${Buffer.from(`${adminUser}:${adminPass}`).toString("base64")}`,
        },
        body: JSON.stringify({
          operation: "read_audit_log",
          database: "flair",
          table: "Memory",
          search_type: "hash_value",
          search_values: [id],
        }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { state: "skipped", reason: "probe-failed", detail: `ops API unreachable at ${opsUrl} (${message.slice(0, 80)})` };
    }
    if (auditRes.status === 400) {
      // harper rejects read_audit_log with HTTP 400 ("To use this operation
      // audit log must be enabled in harperdb-config.yaml") when
      // logging.auditLog is off — live-verified on harper@5.2.0.
      return { state: "degraded", cause: "disabled", detail: "read_audit_log rejected the probe: audit logging is not enabled on this instance" };
    }
    if (!auditRes.ok) {
      // 401/403/404/5xx tell us nothing about whether audit records — that is
      // "could not verify", never "verified" and never "broken".
      return { state: "skipped", reason: "probe-failed", detail: `read_audit_log failed: HTTP ${auditRes.status}` };
    }
    const body = (await auditRes.json().catch(() => null)) as
      | Record<string, Array<{ operation?: string }>>
      | null;
    // BOOLEAN classification only: count the probe's write entries. Audit
    // entries carry full record images — none of that content may reach the
    // result (and via it, doctor/init output).
    const entries = body && Array.isArray(body[id]) ? body[id] : [];
    const writeEntries = entries.filter((e) => e && typeof e === "object" && e.operation !== "delete");
    if (writeEntries.length >= 2) {
      return { state: "ok" };
    }
    // Enabled-but-empty (or partial) is the critical row: we put data in and
    // could not see it come back — the pipeline is broken, not "empty". The
    // pre-fix world silently passed this as ok.
    return {
      state: "degraded",
      cause: "not-recording",
      detail: `probe made 2 writes; read_audit_log returned ${writeEntries.length} write ${writeEntries.length === 1 ? "entry" : "entries"}`,
    };
  } catch (err: unknown) {
    if (err instanceof KeyLoadError) {
      return { state: "skipped", reason: "key-load", detail: err.message };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { state: "skipped", reason: "probe-failed", detail: `probe error: ${message.slice(0, 100)}` };
  } finally {
    // Best-effort cleanup — ephemeral TTL is the backstop if this fails. The
    // DELETE itself appends one more audit entry AFTER the read, by design.
    if (stored) {
      try {
        await authFetch(baseUrl, agentId, keyPath, "DELETE", path);
      } catch { /* leave the ephemeral row; it'll age out */ }
    }
  }
}

// ─── Doctor: client-integration network checks (flair#588) ────────────────────
//
// The pure filesystem checks (MCP block parsing, CLAUDE.md, SessionStart hook)
// live in src/doctor-client.ts. These two are network-dependent and live here
// because they reuse authFetch/resolveKeyPath, which are private to this file.

/**
 * Quick, offline-tolerant reachability probe for a Flair instance's HTTP
 * endpoint — GETs /Health with a short timeout. Never hangs, never throws:
 * any failure (timeout, DNS, connection refused, bad URL) is "unreachable".
 * Mirrors the doctor action's own probePort helper (3000ms AbortSignal.timeout
 * style), but takes a full URL since client configs point at arbitrary hosts.
 */
export async function probeFlairReachable(url: string, timeoutMs = 2000): Promise<boolean> {
  try {
    const res = await fetch(`${url.replace(/\/+$/, "")}/Health`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.status > 0;
  } catch {
    return false;
  }
}

/**
 * Is `agentId` actually registered on the Flair instance at `baseUrl`? Signs
 * GET /Agent/:id with the agent's own key (same pattern as the `flair init`
 * verification at line ~2043 and `flair agent rotate` at line ~2596) —
 * reuses authFetch/resolveKeyPath rather than duplicating the signing logic.
 *
 *   200            -> "registered"
 *   401/403 carrying the server's "unknown_agent" signal -> "not-registered"
 *     (see below — this is the actual live behavior for a missing agent, NOT
 *     404)
 *   any other status, or a network error/timeout -> "unreachable" (could not
 *     verify one way or the other — e.g. a bare 401/403/500 doesn't tell us
 *     whether the agent exists, so we don't claim NOT registered on those)
 *   the key file exists but will not load -> "key-unreadable" (flair#1023 —
 *     signing happens strictly before the request, so authFetch can only
 *     raise KeyLoadError while the instance is still untouched. This USED to
 *     land in the catch below and be reported as "instance unreachable",
 *     which doctor printed directly beneath its own "Harper responding" tick)
 *   no local key found for agentId (checked resolveKeyPath, then keysDir) -> "no-key"
 *     (can't sign the request at all — distinct from "unreachable" so the
 *     caller can print an accurate reason)
 *
 * Why not 404: an unregistered agent never actually reaches the /Agent/:id
 * resource handler (which is where a 404 would come from) — Flair's own
 * signed-auth middleware (resources/auth-middleware.ts) rejects the request
 * first, once it can't find an Agent record matching the signing identity.
 * On current main that's an explicit `401 {"error":"unknown_agent"}` — Live-
 * verified 2026-07-07 against a local Flair instance with a resolvable-but-
 * unregistered signing key: `401 Unauthorized`, body `{"error":"unknown_agent"}`.
 * Some server versions/paths may instead surface Harper's native
 * AccessViolation as a 403 for the same condition, so both codes are checked
 * — but ONLY when the response also carries the unknown-agent marker; a bare
 * 401/403 without it (e.g. a real AccessViolation for an agent that exists
 * but fails a resource-level authorization check) stays "unreachable", since
 * the server can't always distinguish "agent doesn't exist" from "signing key
 * doesn't match a known agent" and we don't want to falsely claim
 * not-registered on that ambiguity. We only make the not-registered call
 * because we ALREADY have a local signing key that resolved for this
 * agentId (checked above) — so this isn't a client-side key problem, and the
 * server naming the agent unknown is a reliable, actionable signal.
 */
export async function checkAgentRegistered(
  baseUrl: string,
  agentId: string,
  keysDir: string,
): Promise<{ state: AgentGateState; detail?: string }> {
  let keyPath = resolveKeyPath(agentId);
  if (!keyPath) {
    const candidate = join(keysDir, `${agentId}.key`);
    if (existsSync(candidate)) keyPath = candidate;
  }
  if (!keyPath) {
    return { state: "no-key", detail: `no local key for agent '${agentId}' to sign the check` };
  }
  try {
    const res = await authFetch(baseUrl, agentId, keyPath, "GET", `/Agent/${agentId}`);
    if (res.ok) return { state: "registered" };
    if (res.status === 404) return { state: "not-registered" };
    const text = await res.text().catch(() => "");
    if ((res.status === 401 || res.status === 403) && /unknown_agent/i.test(text)) {
      return { state: "not-registered", detail: `HTTP ${res.status} ${text.slice(0, 80)}` };
    }
    return { state: "unreachable", detail: `HTTP ${res.status} ${text.slice(0, 80)}` };
  } catch (err: unknown) {
    // flair#1023: a key that will not load is NOT a reachability fact. It is
    // raised before the request is sent, so reporting it as "unreachable"
    // sends the operator to firewalls and ports for a problem that is on
    // their own disk.
    if (err instanceof KeyLoadError) {
      return { state: "key-unreadable", detail: err.message };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { state: "unreachable", detail: `instance unreachable: ${message.slice(0, 100)}` };
  }
}

// Blocks until the given PID is gone (ESRCH from signal 0), or timeout.
// Used during restart to confirm the old Harper process actually exited before
// we start polling /Health — otherwise the still-shutting-down old process can
// answer and we'd declare restart success while a gap is still ahead.
/**
 * Is `pid` a process that exists right now? Signal 0 performs the permission
 * and existence checks without delivering anything (flair#1022) — a `hdb.pid`
 * left behind by a process that is gone is not evidence about a running
 * instance, and treating it as such produces confident wrong answers.
 */
function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch { return; }
    await new Promise((r) => setTimeout(r, HEALTH_POLL_INTERVAL_MS));
  }
  throw new Error(`Process ${pid} did not exit within ${timeoutMs}ms`);
}

function readHarperPid(dataDir: string): number | null {
  const pidFile = join(dataDir, "hdb.pid");
  if (!existsSync(pidFile)) return null;
  try {
    const n = Number(readFileSync(pidFile, "utf-8").trim());
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/**
 * flair#1345 — Harper returns the SAME 401 `{"error":"Login failed"}` for a
 * wrong password and for a nonexistent username, and the CLI's errors used
 * to hint only at the password. On an instance whose superuser is not named
 * `admin` (now reachable in practice: the #604/#610 `authorizeLocal: false`
 * hardening removed the credential-less loopback path, so these calls MUST
 * send real Basic auth) that sent operators down the wrong trail entirely.
 * Name both causes, each with the knob that fixes it.
 */
function opsAuth401Hint(adminUser: string | undefined): string {
  if (adminUser === undefined) {
    // No credentials were sent at all (local caller riding authorizeLocal) —
    // "wrong password or username" would be asserting a cause that isn't
    // established. The remedy is to send credentials.
    return (
      "\n  No admin credentials were sent and the instance rejected the request." +
      "\n  Pass --admin-pass <pass> or --admin-pass-file <path> (and --admin-user <name> if the superuser is not 'admin')."
    );
  }
  return (
    `\n  The operations API rejected the admin credentials (tried username '${adminUser}'). Two possible causes:` +
    "\n  - wrong password — check --admin-pass / --admin-pass-file / FLAIR_ADMIN_PASS" +
    `\n  - wrong username — this instance's superuser may not be '${adminUser}'; pass --admin-user <name> or set FLAIR_ADMIN_USER`
  );
}

/**
 * Seed an agent record via the Harper operations API.
 * Accepts either a port number (localhost) or a full URL string (--target).
 *
 * `adminPass` is optional: a local caller may omit it and ride Harper's
 * `authorizeLocal`, which auto-authorizes a header-less loopback request to
 * the ops port as super_user (current behavior, verified by live probe —
 * flair#610). When passed, the helper sends Basic admin auth so it never
 * depends on that ambient elevation and behaves identically against a remote
 * or hardened instance. Hardening the ops-API loopback posture is tracked in
 * flair#654.
 */
// ─── flair#1790: the ops-API seed names its failure and retries once ──────────
//
// Both seed helpers below insert through the operations API with a single bare
// `fetch` under a 10 s client timeout. On a timeout that surfaced ONLY as an
// undici `DOMException [TimeoutError]` stack — no operation, no target, no
// timeout value — so a post-restart `flair init` that timed out produced an
// unactionable failure and no daemon evidence.
//
// The wrap here names the failure and retries the insert ONCE, on the CLIENT
// timeout only. The retry is safe because the insert is idempotent: a duplicate
// answers 409 (or a "duplicate"/"already exists" body) and is treated as
// success below, so a retried insert cannot double-apply. What is NOT retried:
// an auth failure (401 keeps its existing hint) or any other HTTP or network
// error — those are answers, not stalls.
//
// This is diagnosis + ergonomics, NOT a claim about WHY a seed timed out; the
// mechanism is unknown (flair#1790).
const OPS_AGENT_SEED_TIMEOUT_MS = 10_000;
const OPS_AGENT_SEED_ATTEMPTS = 2;

/**
 * A target URL safe to print: userinfo and query/fragment stripped. The seed
 * target is operator-supplied (`--target` / `--ops-target`), so it may carry
 * credentials or query values that must never reach init output or a log line.
 */
function sanitizeOpsTargetUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.username = "";
    u.password = "";
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch {
    return raw.replace(/\/\/[^/@]*@/, "//").split(/[?#]/)[0];
  }
}

/**
 * True only for the abort our OWN AbortSignal.timeout raises (never a server
 * answer, never a foreign abort). Checked by name AND by the attempt's own
 * signal being aborted (flair#1790 review S1), so a stray TimeoutError from some
 * other AbortSignal is not retried as if it were ours.
 */
function isOwnedSeedTimeout(err: unknown, signal?: AbortSignal): boolean {
  const name = (err as { name?: unknown } | null | undefined)?.name;
  if (name !== "TimeoutError" && name !== "AbortError") return false;
  return signal ? signal.aborted : true;
}

interface OpsSeedRequest {
  /** Raw target URL (sanitised before it reaches any message). */
  url: string;
  auth?: string;
  body: unknown;
  /** Message label, e.g. "Agent" / "Federation Instance". */
  kind: string;
  /** Lowercase noun, e.g. "agent" / "federation instance". */
  noun: string;
  /** Fully-qualified table, e.g. "flair.Agent" / "flair.Instance". */
  tableName: string;
  /** The record id being seeded. */
  id: string;
  /** Kind-specific 401 message (the existing hint text is preserved). */
  auth401Message: (text: string) => string;
  /** Kind-specific generic non-ok message (the existing text is preserved). */
  httpErrorMessage: (status: number, text: string) => string;
}

/**
 * The concise both-attempts-timed-out CLI error. `flairFriendly` makes runCli
 * print just this sentence (no undici/Node stack); the cause stays attached for
 * `--verbose`/diagnostics and is never printed by the default handler.
 */
function opsSeedBothAttemptsTimedOut(
  req: Pick<OpsSeedRequest, "noun" | "tableName" | "id">,
  sanitizedUrl: string,
  cause: unknown,
): Error {
  const message =
    `Flair could not seed ${req.noun} '${req.id}': Operations API insert into ${req.tableName} at ` +
    `${sanitizedUrl} timed out on both attempts (${OPS_AGENT_SEED_TIMEOUT_MS} ms per attempt). ` +
    `Inspect the target daemon's logs, then rerun the same init command.\n` +
    `A timed-out insert may still complete; retrying the same ${req.noun} ID is supported.`;
  const err = new Error(message, { cause });
  (err as { flairFriendly?: boolean }).flairFriendly = true;
  return err;
}

/**
 * POST one ops-API insert, retrying once on the client timeout. The response
 * body is read under the SAME attempt's signal, so each attempt's fresh
 * deadline covers the body read too. Returns normally on success or on the
 * idempotent duplicate path; throws a named error otherwise.
 */
async function opsSeedInsertWithRetry(req: OpsSeedRequest): Promise<void> {
  const sanitizedUrl = sanitizeOpsTargetUrl(req.url);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(req.auth ? { Authorization: `Basic ${req.auth}` } : {}),
  };
  const overallStart = Date.now();
  for (let attempt = 1; attempt <= OPS_AGENT_SEED_ATTEMPTS; attempt++) {
    const attemptStart = Date.now();
    // A FRESH deadline per attempt; the response-body read runs under the SAME
    // signal, so it too is bounded by this attempt's timeout.
    const signal = AbortSignal.timeout(OPS_AGENT_SEED_TIMEOUT_MS);
    try {
      const res = await fetch(req.url, {
        method: "POST",
        headers,
        body: JSON.stringify(req.body),
        signal,
      });
      let text: string;
      try {
        text = await res.text();
      } catch (e: unknown) {
        // flair#1790 follow-up (A): an owned BODY-READ timeout is retryable ONLY
        // for an OK response — a 2xx whose body stalled is OUR stall, so retry
        // it. For a NON-OK response the STATUS is the answer: use empty text and
        // fall through to the status handling (401 → auth error first, then
        // 409/marker → duplicate) instead of retrying away the real error. A 401
        // whose body read stalls must stay the auth error, not become a
        // bogus "timed out on both attempts".
        if (res.ok && isOwnedSeedTimeout(e, signal)) throw e;
        text = "";
      }
      // flair#1790 review C2: 401 FIRST. An auth failure must never be masked by
      // a body that happens to carry a "duplicate"/"already exists" marker.
      if (res.status === 401) throw new Error(req.auth401Message(text));
      // THEN the idempotent duplicate path: an unconditional 409, then the
      // marker match for the remaining non-OK shapes.
      const duplicate = res.status === 409 || text.includes("duplicate") || text.includes("already exists");
      if (!res.ok && !duplicate) throw new Error(req.httpErrorMessage(res.status, text));
      // Success, or the idempotent duplicate path.
      const outcome = res.ok ? "inserted" : "already exists";
      if (attempt > 1) {
        console.log(
          `${req.kind} seed attempt ${attempt} completed in ${Date.now() - attemptStart} ms (${outcome}); ` +
            `total ${Date.now() - overallStart} ms.`,
        );
      }
      return;
    } catch (err) {
      // Auth / HTTP / other network errors are answers, not stalls: never retried.
      if (!isOwnedSeedTimeout(err, signal)) throw err;
      if (attempt < OPS_AGENT_SEED_ATTEMPTS) {
        console.warn(
          `${req.kind} seed attempt ${attempt} timed out after ${OPS_AGENT_SEED_TIMEOUT_MS} ms; retrying once. ` +
            `Target: ${sanitizedUrl} (${req.noun} '${req.id}').`,
        );
        continue;
      }
      throw opsSeedBothAttemptsTimedOut(req, sanitizedUrl, err);
    }
  }
}

export async function seedAgentViaOpsApi(
  opsPortOrUrl: number | string,
  agentId: string,
  pubKeyB64url: string,
  adminUser: string,
  adminPass?: string,
): Promise<void> {
  const url = typeof opsPortOrUrl === "number"
    ? `http://127.0.0.1:${opsPortOrUrl}/`
    : `${opsPortOrUrl.replace(/\/$/, "")}/`;
  // Send Basic auth whenever the caller passed an adminPass. The caller decides
  // when to omit it (e.g., local target with authorizeLocal=true).
  const auth = adminPass !== undefined ? Buffer.from(`${adminUser}:${adminPass}`).toString("base64") : undefined;
  // The ops-API insert bypasses the Agent resource layer, so Agent.post()'s
  // 1.0 Principal defaults (kind/status/displayName/admin/defaultTrustTier/type)
  // never run. Without them a remote-seeded agent lands kind=null, status=null
  // and is invisible to roster/presence/Office-Space queries that filter on
  // status='active' or kind='agent' (#521). Mirror Agent.post() exactly here.
  const now = new Date().toISOString();
  const body = {
    operation: "insert",
    database: "flair",
    table: "Agent",
    records: [{
      id: agentId,
      name: agentId,
      type: "agent",
      kind: "agent",
      status: "active",
      displayName: agentId,
      admin: false,
      defaultTrustTier: "unverified",
      publicKey: pubKeyB64url,
      createdAt: now,
      updatedAt: now,
    }],
  };
  await opsSeedInsertWithRetry({
    url,
    auth,
    body,
    kind: "Agent",
    noun: "agent",
    tableName: "flair.Agent",
    id: agentId,
    auth401Message: (text) =>
      `Operations API insert failed (401): ${text}${opsAuth401Hint(auth === undefined ? undefined : adminUser)}`,
    httpErrorMessage: (status, text) => `Operations API insert failed (${status}): ${text}`,
  });
}

// NOTE: agent records are seeded exclusively via the Harper operations API
// (seedAgentViaOpsApi above). A former seedAgentViaRestApi() helper POSTed the
// ops-insert body to the REST root, which Harper 405s as a collection POST to
// /Agent (the Agent table resource has no POST handler). It was removed in the
// #499 fix; do not reintroduce a REST-root insert path.

// ─── FederationInstance seed via ops API ──────────────────────────────────────
//
// Remote init writes FederationInstance through the ops API (Basic auth with
// admin:admin-pass), not the REST API (which needs server-side HDB_ADMIN_PASSWORD
// — unavailable on Fabric).  Same pattern as seedAgentViaOpsApi above.
//
// `adminPass` is optional (symmetry with seedAgentViaOpsApi): a local caller may
// omit it and ride authorizeLocal, which the Harper ops API honors today — a
// header-less loopback request is auto-authorized as super_user (flair#610).
// When passed, the helper sends Basic admin auth so it never depends on that
// ambient elevation and behaves identically against a remote or hardened
// instance. Hardening that posture is tracked in flair#654.

export async function seedFederationInstanceViaOpsApi(
  opsPortOrUrl: number | string,
  instanceId: string,
  publicKey: string,
  role: string,
  adminUser: string,
  adminPass?: string,
): Promise<void> {
  const url = typeof opsPortOrUrl === "number"
    ? `http://127.0.0.1:${opsPortOrUrl}/`
    : `${opsPortOrUrl.replace(/\/$/, "")}/`;
  // Send Basic auth whenever the caller passed an adminPass. The caller decides
  // when to omit it (e.g., local target with authorizeLocal=true).
  const auth = adminPass !== undefined ? Buffer.from(`${adminUser}:${adminPass}`).toString("base64") : undefined;
  const now = new Date().toISOString();
  const body = {
    operation: "insert",
    database: "flair",
    table: "Instance",
    records: [{
      id: instanceId,
      publicKey,
      role,
      status: "active",
      createdAt: now,
      updatedAt: now,
    }],
  };
  await opsSeedInsertWithRetry({
    url,
    auth,
    body,
    kind: "Federation Instance",
    noun: "federation instance",
    tableName: "flair.Instance",
    id: instanceId,
    auth401Message: (text) =>
      `Federation Instance insert via ops API failed (401): ${text}${opsAuth401Hint(auth === undefined ? undefined : adminUser)}`,
    httpErrorMessage: (status, text) => `Federation Instance insert via ops API failed (${status}): ${text}`,
  });
}

// ─── Federation instance identity (flair#1883) ───────────────────────────────
//
// A hub's identity is ONE `flair.Instance` row. `GET /FederationInstance`
// find-or-creates it (`role: "spoke"`); `flair init --remote` used to INSERT a
// second row under a fresh id, so a hub could hold a spoke row and a hub row and
// every reader that took "the first row" answered from whichever the table
// yielded first. `reconcileFederationInstanceViaOpsApi` is init's writer: it
// reads the rows and decides (create / set the ONE row's role to hub / no-op /
// refuse), never inserting over an existing identity. The decisions themselves
// live in src/lib/instance-identity-row.ts, shared with the cleanup sweep and
// doctor. After it writes, it RE-READS: a row that appeared in its read-then-
// insert window (a concurrent `GET /FederationInstance` find-or-creates one) is
// reported with the prune remedy rather than counted as a successful init. The
// re-read must also hold the row it just WROTE (flair#1883 round 6): an empty
// table or one different row is refused, naming what was found, because an
// absent or wrong hub identity is not a completed init.

/** The ops endpoint trio (URL, user, optional pass) as the identity helpers want it. */
function federationInstanceEndpoint(
  opsPortOrUrl: number | string,
  adminUser: string,
  adminPass?: string,
  fetchImpl?: typeof fetch,
): OpsEndpoint {
  const opsUrl = typeof opsPortOrUrl === "number" ? `http://127.0.0.1:${opsPortOrUrl}` : opsPortOrUrl;
  return {
    opsUrl,
    // A caller without a pass sends no Authorization header — same posture as
    // seedFederationInstanceViaOpsApi (loopback authorizeLocal).
    ...(adminPass !== undefined ? { credentials: { user: adminUser, pass: adminPass } } : {}),
    ...(fetchImpl ? { fetchImpl } : {}),
  };
}

/**
 * Reconcile the hub identity row for `flair init --remote`.
 *
 * Returns what actually happened so the caller's log line can name it: an
 * `already-hub` re-run must not claim it wrote anything.
 *
 * The write is verified by re-reading, not assumed (flair#1883 round 2): the
 * read-then-write window is real, and a `GET /FederationInstance` landing in it
 * leaves two rows. Reporting that as `created` would claim an identity this
 * instance does not have.
 *
 * The re-read must hold the row it just wrote (flair#1883 round 6): an empty
 * table (the insert never landed) or one different row (the update went
 * elsewhere) used to verify as success, and the caller adopted the id anyway.
 */
export async function reconcileFederationInstanceViaOpsApi(
  opsPortOrUrl: number | string,
  create: { instanceId: string; publicKey: string },
  adminUser: string,
  adminPass?: string,
  opts?: { fetchImpl?: typeof fetch },
): Promise<{ action: "created" | "updated" | "already-hub"; id: string }> {
  const endpoint = federationInstanceEndpoint(opsPortOrUrl, adminUser, adminPass, opts?.fetchImpl);
  const rows = await readInstanceRows(endpoint);
  const decision = decideHubReconcile(rows);
  switch (decision.kind) {
    case "refuse-multiple":
      throw new Error(multipleInstanceRowsMessage(decision.rows));
    case "already-hub":
      return { action: "already-hub", id: decision.id };
    case "update-role":
      await updateInstanceRole(endpoint, decision.id, "hub");
      await assertSingleInstanceRowAfterWrite(endpoint, decision.id);
      return { action: "updated", id: decision.id };
    default:
      // The create path keeps the insert (and its retry/401 guidance) unchanged.
      await seedFederationInstanceViaOpsApi(opsPortOrUrl, create.instanceId, create.publicKey, "hub", adminUser, adminPass);
      await assertSingleInstanceRowAfterWrite(endpoint, create.instanceId);
      return { action: "created", id: create.instanceId };
  }
}

/**
 * Re-read after a write: it must hold exactly the ONE hub row that was written.
 *
 * More than one row now means the write raced another writer (a `GET
 * /FederationInstance` creates one), and the caller must hear the refusal — with
 * the prune remedy — instead of a success line. An EMPTY table, one OTHER row,
 * or the expected id with a non-hub role is a failure too (flair#1883 round 6):
 * each names what the re-read found, because "the write did not land" and "the
 * write landed elsewhere" are different operator problems.
 */
async function assertSingleInstanceRowAfterWrite(endpoint: OpsEndpoint, expectedId: string): Promise<void> {
  const verification = verifyInstanceWrite(await readInstanceRows(endpoint), expectedId);
  if (verification.kind === "refuse-multiple") throw new Error(multipleInstanceRowsMessage(verification.rows));
  if (verification.kind === "not-verified") throw new Error(instanceWriteNotVerifiedMessage(expectedId, verification.found));
}

// ─── Provision Flair on Harper Fabric ──────────────────────────────────────
//
// Atomic provisioning for a fresh Harper Fabric cluster: builds a deploy
// tarball with .env baked in, deploys via ops API, waits for restart, and
// creates the super_user admin account.

export async function callOpsApi(
  opsUrl: string,
  body: Record<string, unknown>,
  user: string,
  pass: string,
): Promise<any> {
  const url = `${opsUrl.replace(/\/$/, "")}/`;
  const auth = Buffer.from(`${user}:${pass}`).toString("base64");
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(auth ? { Authorization: `Basic ${auth}` } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `ops API unreachable at ${opsUrl} (derived from --target). ` +
      `Set --ops-target or FLAIR_OPS_TARGET to override. ` +
      `(${message})`,
    );
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Ops API call failed (${res.status}): ${text}`);
  }
  return res.json();
}

/**
 * Build the component tarball `flair init --remote` uploads via the ops API.
 *
 * ── What was wrong here (flair#1005 item 2) ─────────────────────────────────
 * This function wrote a `.env` into its temp directory and then packed an
 * EXPLICIT entries list that did not contain it, so the file was discarded with
 * the temp directory on every call. It had been that way since the writer landed:
 * a writer whose output nothing consumed. `.env` is now in the list, which is the
 * whole of the fix — and `init-remote-ops.test.ts` asserts the entry is present
 * in a real tarball, because "the file was written" was never evidence of
 * anything.
 *
 * ── Why `publicUrl` replaced the password parameter (flair#1011) ────────────
 * The discarded file assigned `HDB_ADMIN_PASSWORD` and `FLAIR_ADMIN_PASSWORD`.
 * Shipping it as-is would have made a latent hazard live, for two independent
 * reasons: Harper composes its own configuration before a component's `.env`
 * loads, so `HDB_ADMIN_PASSWORD` set this way is a credential Harper is
 * structurally unable to honour while flair reads it — two sources, one name,
 * nothing comparing them; and the payload is ingested into Harper's
 * `hdb_deployment` record, which is replicated to every node and retained for
 * rollback, so anything in it is persisted cluster-wide.
 *
 * The parameter is REMOVED rather than validated. A caller cannot pass a password
 * to a function that has nowhere to put one, and no future edit can reintroduce
 * one without also reintroducing the parameter. The admin credential still
 * reaches the instance the way it always actually did — `add_user`/`alter_user`
 * over the ops API in `provisionFabric`.
 */
export async function buildDeployTarball(
  projectRoot: string,
  publicUrl: string | null,
): Promise<{ tarballB64: string }> {
  const tmpDir = mkdtempSync(join(tmpdir(), "flair-deploy-"));
  try {
    // Copy deployment files into temp directory
    const entries = ["dist", "schemas", "config.yaml", "package.json", "LICENSE", "README.md", "SECURITY.md"];
    if (existsSync(join(projectRoot, "ui"))) entries.push("ui");

    for (const entry of entries) {
      const src = join(projectRoot, entry);
      const dst = join(tmpDir, entry);
      if (existsSync(src)) {
        cpSync(src, dst, { recursive: true });
      }
    }

    // The component's environment. Harper reads this file only because
    // config.yaml declares its `loadEnv` plugin (flair#1010) — without that
    // declaration the file is present and inert, which is what made flair#1000
    // hard to see. An existing `.env` in the project root is merged, never
    // replaced; planComponentEnv keeps an operator's own value for the key.
    const existingEnvPath = join(projectRoot, COMPONENT_ENV_FILENAME);
    const existingEnv = existsSync(existingEnvPath) ? readFileSync(existingEnvPath, "utf8") : null;
    const plan = planComponentEnv(existingEnv, publicUrl);
    for (const notice of plan.notices) console.warn(`⚠ flair init --remote: ${notice}`);
    const envText = plan.text ?? existingEnv;
    if (envText !== null) {
      assertNoSecretKeysAdded(existingEnv, envText);
      writeFileSync(join(tmpDir, COMPONENT_ENV_FILENAME), envText, { mode: 0o600 });
      entries.push(COMPONENT_ENV_FILENAME);
    }

    // Build compressed tarball
    const tarballPath = join(tmpDir, "deploy.tar.gz");
    await tarCreate(
      { gzip: true, cwd: tmpDir, file: tarballPath, portable: true },
      entries,
    );

    const buf = readFileSync(tarballPath);
    return { tarballB64: buf.toString("base64") };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

export async function waitForFlairRestart(
  targetUrl: string,
  maxWaitMs: number = 30_000,
): Promise<void> {
  const url = `${targetUrl.replace(/\/$/, "")}/FederationPair`;
  const intervalMs = 1_000;
  const deadline = Date.now() + maxWaitMs;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(5_000),
      });
      const text = await res.text().catch(() => "");
      // The resource handler responds with "instanceId and publicKey required"
      // when the deployment is live and Flair is serving requests.
      if (text.includes("instanceId and publicKey required")) return;
    } catch {
      // Not ready yet — keep polling
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Flair did not respond within ${maxWaitMs / 1000}s`);
}

export async function provisionFabric(
  target: string,
  opsTarget: string,
  clusterAdminUser: string,
  clusterAdminPass: string,
  flairAdminPass: string,
): Promise<void> {
  const projectRoot = process.cwd();

  // 1. Build and deploy component tarball. `target` is the served URL this
  // function verifies against in step 2 — the same value the component must
  // advertise in OAuth/A2A discovery, so it is what FLAIR_PUBLIC_URL is set from
  // (flair#1005). A loopback target supplies nothing: see resolveDeployPublicUrl.
  console.log("Building deploy tarball...");
  const { tarballB64 } = await buildDeployTarball(projectRoot, resolveDeployPublicUrl(target));

  console.log("Deploying via ops API...");
  await callOpsApi(opsTarget, {
    operation: "deploy_component",
    project: "flair",
    payload: tarballB64,
    restart: "rolling",
  }, clusterAdminUser, clusterAdminPass);

  // 2. Wait for restart
  console.log("Waiting for Flair to restart...");
  await waitForFlairRestart(target);
  console.log("Flair is running ✓");

  // 3. Provision Harper super_user
  // Since custom-admin-username support is merged, the username doesn't have to be "admin".
  // We can use the cluster-admin user directly if it's already a super_user.
  // Check if cluster admin is already a super_user first:
  let clusterAdminIsSuperUser = false;
  try {
    const userInfo = await callOpsApi(opsTarget, {
      operation: "list_users",
    }, clusterAdminUser, clusterAdminPass);
    // list_users returns an array of user objects with role/permission info
    const users = Array.isArray(userInfo) ? userInfo : [];
    const adminRecord = users.find(
      (u: any) => u.username === clusterAdminUser || u.user?.username === clusterAdminUser,
    );
    clusterAdminIsSuperUser = !!(
      adminRecord?.role?.permission?.super_user ??
      adminRecord?.permission?.super_user ??
      false
    );
  } catch {
    // If we can't check, assume not and proceed with add_user
  }

  if (clusterAdminIsSuperUser) {
    console.log(`Cluster admin '${clusterAdminUser}' is already a super_user — skipping user provisioning`);
  } else {
    console.log(`Provisioning Harper user 'admin' as super_user...`);
    try {
      await callOpsApi(opsTarget, {
        operation: "add_user",
        username: "admin",
        password: flairAdminPass,
        role: "super_user",
        active: true,
      }, clusterAdminUser, clusterAdminPass);
      console.log("User 'admin' created ✓");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("already exists") || msg.includes("duplicate")) {
        // Idempotent: fall back to alter_user
        console.log("User 'admin' already exists — updating password...");
        await callOpsApi(opsTarget, {
          operation: "alter_user",
          username: "admin",
          password: flairAdminPass,
          role: "super_user",
          active: true,
        }, clusterAdminUser, clusterAdminPass);
        console.log("User 'admin' updated ✓");
      } else {
        throw err;
      }
    }
  }
}

// ─── flair_pair_initiator role ──────────────────────────────────────────────
//
// Hub instances need a `flair_pair_initiator` role so that bootstrap credentials
// (created in PR-2) can pass platform auth on Harper Fabric before reaching the
// FederationPair resource handler.  The role carries no table permissions itself
// — the resource's own allowCreate bypass handles route-level access once the
// request gets through the auth gate.

/**
 * Canonical permission spec for flair_pair_initiator.
 *
 * The role intentionally carries NO table permissions — its only job is to exist
 * so bootstrap credentials can pass Harper platform auth before reaching the
 * FederationPair resource handler (the resource's own allowCreate bypass handles
 * route-level access). A bare role with both flags false is valid, grants nothing,
 * and is exactly that intent.
 *
 * This previously carried an all-false `flair.tables` block, but Harper's add_role
 * REJECTED the whole spec with a 400 (verified live against a spawned Harper):
 *   - `cluster_user` is not a recognized top-level key — Harper reads unknown keys
 *     as database names ("database 'cluster_user' does not exist");
 *   - the table names were the logical shorthand, not the real @table names
 *     ("Table 'flair.Workspace' does not exist" — it's WorkspaceState; "Event" is
 *     OrgEvent; "OAuth" is OAuthClient);
 *   - each grant omitted the required `attribute_permissions` array.
 * The all-false block granted nothing anyway, so dropping it loses no capability
 * and unbreaks fresh hub provisioning (where add_role runs and the 400 aborted
 * `flair init --remote`). Only top-level booleans Harper recognizes remain.
 */
const PAIR_INITIATOR_PERMISSION = {
  super_user: false,
  structure_user: false,
} as const;

/**
 * Idempotently ensures the `flair_pair_initiator` role exists on the Harper
 * instance at `opsUrl` with the canonical permission spec.
 *
 * - If the role is absent → `add_role`
 * - If it exists with different permissions → `alter_role` to bring it into spec
 * - If it already matches → no-op
 */
export async function ensureFlairPairInitiatorRole(
  opsUrl: string,
  adminUser: string,
  adminPass: string,
): Promise<void> {
  const ROLE_NAME = "flair_pair_initiator";

  // 1. Check for existing role
  let roles: any[] = [];
  try {
    const result = await callOpsApi(opsUrl, { operation: "list_roles" }, adminUser, adminPass);
    roles = Array.isArray(result) ? result : [];
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`ensureFlairPairInitiatorRole: list_roles failed: ${msg}`);
  }

  const existing = roles.find(
    (r: any) => r.role === ROLE_NAME || r.name === ROLE_NAME,
  );

  if (!existing) {
    // 2a. Role absent → create it
    console.log(`Creating role '${ROLE_NAME}'...`);
    await callOpsApi(opsUrl, {
      operation: "add_role",
      role: ROLE_NAME,
      permission: PAIR_INITIATOR_PERMISSION,
    }, adminUser, adminPass);
    console.log(`Role '${ROLE_NAME}' created ✓`);
    return;
  }

  // 2b. Role exists — check if permissions match the canonical spec
  const existingPerm = existing.permission ?? existing.role?.permission;
  const canonicalStr = JSON.stringify(PAIR_INITIATOR_PERMISSION);
  const existingStr  = JSON.stringify(existingPerm);

  if (existingStr === canonicalStr) {
    console.log(`Role '${ROLE_NAME}' already exists with correct permissions — skipping`);
    return;
  }

  // 2c. Permissions differ → bring into spec via alter_role
  console.log(`Role '${ROLE_NAME}' exists but permissions differ — updating...`);
  await callOpsApi(opsUrl, {
    operation: "alter_role",
    role: ROLE_NAME,
    permission: PAIR_INITIATOR_PERMISSION,
  }, adminUser, adminPass);
  console.log(`Role '${ROLE_NAME}' updated ✓`);
}

// ─── flair_agent role ────────────────────────────────────────────────────────
//
// The auth reshape replaces the global gate's "verified agent borrows admin
// super_user" elevation with a real, least-privilege Harper role. After an
// agent's Ed25519 signature verifies, resources resolve the request to the
// shared `flair_agent`-roled user instead of admin — so agents get exactly the
// table CRUD below and nothing more. Critically: with no `super_user` and no
// operations grants, /sql and /graphql become NATIVELY 403 for agents (the
// raw-query block the gate hand-rolled is now enforced by Harper itself).
//
// Row-level ownership (an agent touches only its OWN memories/soul/events) is
// NOT expressible in Harper's role model — it stays in each resource's allow*,
// keyed on the Ed25519-verified agentId. So these per-table grants are the
// coarse CRUD envelope; allow* is the ownership boundary inside it.
//
// VALIDATION GATES (must confirm against a live Harper before this role goes
// live — flagged for Sherlock + the PR, not assumed):
//   1. HNSW/vector search (SemanticSearch over Memory) works with table `read`
//      alone — the old elevation comment claimed admin perms were needed for
//      "HNSW-capable" access; confirm `read` suffices or widen precisely.
//   2. Role table keys must EXACTLY match the @table names (Memory, OrgEvent,
//      WorkspaceState, OAuthClient — NOT the logical Memory/Event/Workspace/OAuth
//      shorthand the flair_pair_initiator spec used, which was harmless only
//      because every grant there is false).

// Harper 5.0.21 add_role requires an `attribute_permissions` array on EVERY table
// grant (empty = no attribute-level restriction, so the table-level CRUD applies);
// omitting it makes add_role reject the whole spec ("Missing 'attribute_permissions'
// array"). Validated live against a spawned Harper. This helper guarantees the
// array is never forgotten. Also: `cluster_user` is NOT a valid top-level key —
// Harper reads unrecognized top-level keys as database names ("database
// 'cluster_user' does not exist"); only super_user / structure_user are recognized.
const grant = (read: boolean, insert: boolean, update: boolean, del: boolean) =>
  ({ read, insert, update, delete: del, attribute_permissions: [] });

/** Canonical permission spec for flair_agent (least-privilege; real @table names). */
const FLAIR_AGENT_PERMISSION = {
  super_user: false,
  structure_user: false,
  flair: {
    tables: {
      // Core agent-owned data — CRUD envelope; ownership enforced in allow*.
      Memory:          grant(true,  true,  true,  true),
      MemoryCandidate: grant(true,  true,  true,  true),
      MemoryGrant:     grant(true,  true,  true,  true),
      // Asset (images-in-Flair slice 1). Harper authorizes BEFORE Asset.post
      // runs, so a de-elevated flair_agent needs the table grant or signed
      // POST /Asset 403s as AccessViolation (Kern P0). CRUD envelope;
      // owner-only + write-time size/MIME gates live in resources/Asset.ts.
      Asset:           grant(true,  true,  true,  true),
      Soul:            grant(true,  true,  true,  false),
      OrgEvent:        grant(true,  true,  true,  true),
      WorkspaceState:  grant(true,  true,  true,  true),
      Relationship:    grant(true,  true,  true,  true),
      // Flair Relay S1 (flair#1521). Harper authorizes BEFORE the resource
      // methods run, so a de-elevated flair_agent needs the table grant OR it
      // 403s on POST /Message before relaySend is reached (Kern P0-2). read =
      // the party-scoped collection (Message.search); insert = send via post().
      // update = FALSE (least privilege, Kern P0 blocker): the ack's write goes
      // through the IN-PROCESS static accessor (relayConsume → deps.messages.put),
      // which bypasses role gates entirely — the same raw-put seam Federation.ts
      // relies on — so update:true is NOT needed for any legitimate path. Leaving
      // it granted let PATCH /Message/<id> reach Table's update verb, whose
      // authorize step consults update:true and PASSES for any de-elevated agent,
      // bypassing Message.put()'s FORBIDDEN guard AND relayConsume's recipient-only
      // check (Message has no patch() at the platform level → TableResource.patch
      // runs update()+save() directly). delete = false: direct deletes are
      // admin/internal only. Message.patch() also guards the verb in-resource.
      Message:         grant(true,  true,  false, false),
      Integration:     grant(true,  true,  true,  true),
      Credential:      grant(true,  true,  true,  true),
      Presence:        grant(true,  true,  true,  false),
      // MemoryUsage (flair#683): the usage-feedback dedup ledger. Read (own
      // contributions, scoped in resources/MemoryUsage.ts) + insert (a fresh
      // contribution row) only — NO update/delete. This is load-bearing, not
      // just least-privilege tidiness: the dedup rule ("(agent, memory)
      // contributes ≤ 1") is enforced by requiring a NEW ledger row before
      // any usageCount bump; if an agent could delete its own row, it could
      // re-trigger the /RecordUsage endpoint for the same memory indefinitely
      // (create → count → delete → count again → repeat), defeating the cap
      // entirely. See resources/MemoryUsage.ts's module doc.
      MemoryUsage:     grant(true,  true,  false, false),
      // MemoryHitStat (flair#1528): internal search-hit ledger. No agent REST
      // surface (@table without @export). Counts overlay onto Memory reads.
      MemoryHitStat:   grant(false, false, false, false),
      // Agent: read for discovery, update own card; creation/removal is admin.
      Agent:           grant(true,  false, true,  false),
      // Read-only reference data.
      Instance:        grant(true,  false, false, false),
      // Federation / OAuth / IdP / internal — system + admin only; agents get none.
      Peer:          grant(false, false, false, false),
      PairingToken:  grant(false, false, false, false),
      SyncLog:       grant(false, false, false, false),
      OAuthClient:   grant(false, false, false, false),
      OAuthToken:    grant(false, false, false, false),
      OAuthAuthCode: grant(false, false, false, false),
      IdpConfig:     grant(false, false, false, false),
      IdJagReplay:   grant(false, false, false, false),
    },
  },
};

/**
 * Idempotently ensures the `flair_agent` role exists on the Harper instance at
 * `opsUrl` with the canonical least-privilege spec. Same list/add/alter shape as
 * ensureFlairPairInitiatorRole.
 *
 * - absent → `add_role`
 * - exists with different permissions → `alter_role`
 * - already matches → no-op
 */
export async function ensureFlairAgentRole(
  opsUrl: string,
  adminUser: string,
  adminPass: string,
): Promise<void> {
  const ROLE_NAME = "flair_agent";

  let roles: any[] = [];
  try {
    const result = await callOpsApi(opsUrl, { operation: "list_roles" }, adminUser, adminPass);
    roles = Array.isArray(result) ? result : [];
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`ensureFlairAgentRole: list_roles failed: ${msg}`);
  }

  const existing = roles.find(
    (r: any) => r.role === ROLE_NAME || r.name === ROLE_NAME,
  );

  if (!existing) {
    console.log(`Creating role '${ROLE_NAME}'...`);
    await callOpsApi(opsUrl, {
      operation: "add_role",
      role: ROLE_NAME,
      permission: FLAIR_AGENT_PERMISSION,
    }, adminUser, adminPass);
    console.log(`Role '${ROLE_NAME}' created ✓`);
    return;
  }

  const existingPerm = existing.permission ?? existing.role?.permission;
  const canonicalStr = JSON.stringify(FLAIR_AGENT_PERMISSION);
  const existingStr  = JSON.stringify(existingPerm);

  if (existingStr === canonicalStr) {
    console.log(`Role '${ROLE_NAME}' already exists with correct permissions — skipping`);
    return;
  }

  console.log(`Role '${ROLE_NAME}' exists but permissions differ — updating...`);
  await callOpsApi(opsUrl, {
    operation: "alter_role",
    role: ROLE_NAME,
    permission: FLAIR_AGENT_PERMISSION,
  }, adminUser, adminPass);
  console.log(`Role '${ROLE_NAME}' updated ✓`);
}

/**
 * Shared Harper user that verified Ed25519 agents are resolved to.
 * MUST match FLAIR_AGENT_USERNAME in resources/agent-auth.ts (the gate side).
 * Not imported from there because cli.ts is standalone and that module pulls in
 * Harper's native bindings — kept as a cross-referenced literal instead.
 */
export const FLAIR_AGENT_USERNAME = "flair-agent";

/**
 * Idempotently ensures the shared `flair-agent` Harper user exists with the
 * `flair_agent` role. Verified Ed25519 agents are resolved to THIS user
 * (`getUser("flair-agent", null)` — no password check, identity already proven
 * cryptographically), replacing the old `getUser("admin")` super_user elevation.
 *
 * The password is random and never used for authentication: the agent path
 * resolves the user without it, and the auth gate's Basic path only accepts
 * super_user / pair-bootstrap (a flair_agent Basic login is rejected there), so
 * a Basic login as this user can't reach anything. Random + unused = safe.
 *
 * Row-level ownership stays in each resource's allow* (keyed on the verified
 * agentId); this shared user only carries the flair_agent role's table grants.
 */
export async function ensureFlairAgentUser(
  opsUrl: string,
  adminUser: string,
  adminPass: string,
): Promise<void> {
  const unusedPassword = randomBytes(32).toString("base64url");
  try {
    await callOpsApi(opsUrl, {
      operation: "add_user",
      username: FLAIR_AGENT_USERNAME,
      password: unusedPassword,
      role: "flair_agent",
      active: true,
    }, adminUser, adminPass);
    console.log(`User '${FLAIR_AGENT_USERNAME}' created ✓`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("already exists") || msg.includes("duplicate")) {
      // Idempotent: ensure the role is correct without churning the password.
      await callOpsApi(opsUrl, {
        operation: "alter_user",
        username: FLAIR_AGENT_USERNAME,
        role: "flair_agent",
        active: true,
      }, adminUser, adminPass);
      console.log(`User '${FLAIR_AGENT_USERNAME}' already exists — role ensured ✓`);
    } else {
      throw err;
    }
  }
}

// ─── Upgrade presence probes ──────────────────────────────────────────────────
//
// `flair upgrade` previously called `npm list -g <pkg>` to detect the installed
// version. That assumed the default npm global prefix and failed (silently,
// reporting "not installed") for mise / fnm / nvm / volta users whose prefix
// lives elsewhere — including for the running flair binary itself, which is
// clearly installed somewhere. These probes locate the package regardless of
// install path.

export function probeBinVersion(
  execFileSync: typeof import("node:child_process").execFileSync,
  bin: string,
): string | null {
  // Run the binary's --version via argv (no shell). PATH resolution still
  // happens (so we find the binary wherever npm/mise/fnm installed it),
  // but there's no shell-string to inject into. CodeQL-safe and simpler.
  try {
    const out = execFileSync(bin, ["--version"], {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!out) return null;
    // Accept either "0.6.0" on its own or a line containing a semver.
    const m = out.match(/\b(\d+\.\d+\.\d+(?:[\d.a-z.-]*)?)\b/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

export function probeLibVersion(pkgName: string): string | null {
  // Resolve the package's package.json from the running flair's module graph.
  // If the lib is installed anywhere Node can see (including bundled as a
  // dep of flair itself, sibling global install, or linked workspace), this
  // finds it. If it's truly missing, require.resolve throws → null.
  try {
    const req = createRequire(import.meta.url);
    const pkgJsonPath = req.resolve(`${pkgName}/package.json`);
    const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

/**
 * Read the version of an OpenClaw plugin from `~/.openclaw/extensions/<name>/package.json`.
 *
 * `flair upgrade` uses this to surface the installed `@tpsdev-ai/openclaw-flair`
 * version even though it isn't a globally-installed bin or a flair lib dep.
 * Returns null if openclaw isn't installed, the extension isn't installed, or
 * the package.json can't be parsed.
 *
 * @param extensionName — the directory name under `~/.openclaw/extensions/`
 *                        (typically the plugin name without scope, e.g. `openclaw-flair`)
 */
export function probeOpenclawPluginVersion(extensionName: string): string | null {
  try {
    // process.env.HOME first so tests can override; homedir() as fallback —
    // homedir() doesn't honor runtime HOME changes (caches at module load).
    const home = resolveHome();
    const pkgJsonPath = resolve(home, ".openclaw", "extensions", extensionName, "package.json");
    if (!existsSync(pkgJsonPath)) return null;
    const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

/**
 * Per-package status for the `flair upgrade` listing — the state set, the
 * direction-aware classifier and the renderers live ONCE in
 * src/lib/upgrade-status.ts and are re-exported here so existing importers keep
 * working (flair#1778). src/commands/upgrade.ts cannot import this file, so the
 * shared definition has to live outside both.
 */
export { shouldPrintUpgradeLine, upgradeStatusSuffix };
export type { UpgradeStatus };

/**
 * Resolve the `flair upgrade` finding for flair-mcp from its ACTUAL wiring,
 * not a global-install probe (flair#1208).
 *
 * flair-mcp is zero-install via npx (#1168): a correctly-wired machine never
 * installs it globally, so the global bin/lib probe returning null is the
 * NORMAL state, not "missing". Its real installed version is the pin its wiring
 * carries (a client MCP config's args, refreshed by `flair doctor --fix`).
 *
 * Resolution order:
 *   1. Legacy global install — the bin/lib probe found a version. Honor it.
 *   2. Not wired anywhere — genuinely missing; the remedy (upgradeStatusSuffix)
 *      is `flair doctor --fix`, never `npm install -g`.
 *   3. Wired with a concrete pin — that pin IS the installed version
 *      (current / ahead / outdated by semver direction; outdated → re-pin via
 *      doctor, ahead never re-pins down — flair#1778).
 *   4. Wired but unpinned (a bare npx spec / a pre-#1143 SessionStart hook) —
 *      `npx -y` re-resolves latest every session, so the effective version IS
 *      latest → current.
 */
export function resolveFlairMcpFinding(
  globalProbe: string | null,
  latest: string,
  wiring: { wired: boolean; pinnedVersion: string | null },
): { installed: string | null; status: UpgradeStatus } {
  // 1. Legacy global install.
  if (globalProbe !== null) {
    return { installed: globalProbe, status: classifyInstalledVersion(globalProbe, latest) };
  }
  // 2. Not wired anywhere.
  if (!wiring.wired) {
    return { installed: null, status: "missing" };
  }
  // 3. Wired with a pin.
  if (wiring.pinnedVersion) {
    return {
      installed: wiring.pinnedVersion,
      status: classifyInstalledVersion(wiring.pinnedVersion, latest),
    };
  }
  // 4. Wired but unpinned — npx resolves latest on every session.
  return { installed: latest, status: "current" };
}

/**
 * Pure flag resolution for `flair upgrade`'s restart/verify defaults
 * (flair#635 decision: restart is now the default; `--no-restart` opts
 * out). `--restart` is a deprecated no-op accepted for backward compat —
 * `deprecatedRestartFlagUsed` tells the caller to print a one-time notice
 * without re-deriving the raw Commander value itself.
 *
 * Commander quirk this relies on: registering both `--restart` (plain
 * boolean) and `--no-restart` (negatable) on the same command means
 * `opts.restart` is `undefined` when neither flag is passed, `true` when
 * `--restart` is passed, and `false` when `--no-restart` is passed — so
 * `!== false` is the correct "should restart" default-true test, and
 * `=== true` isolates "the user explicitly typed the deprecated flag".
 */
export function resolveUpgradeRestartVerify(opts: { restart?: boolean; verify?: boolean }): {
  restart: boolean;
  verify: boolean;
  deprecatedRestartFlagUsed: boolean;
} {
  return {
    restart: opts.restart !== false,
    verify: opts.verify !== false,
    deprecatedRestartFlagUsed: opts.restart === true,
  };
}

/**
 * Whether `flair deploy` / `flair upgrade --target` should run the
 * post-deploy fleet convergence sweep (flair#636). Registering
 * `--no-fleet-verify` via commander leaves `opts.fleetVerify` undefined when
 * unset, `false` when the flag is passed — mirrors resolveUpgradeRestartVerify's
 * `!== false` default-true idiom above.
 */
export function shouldRunFleetVerify(opts: { fleetVerify?: boolean }): boolean {
  return opts.fleetVerify !== false;
}

/**
 * Post-sweep abort for `deploy` / `upgrade --target` (flair#988).
 * Unverifiable peers do not abort. A reachable divergence does — and the
 * sentence names that condition, never "NOT fully converged" for couldn't-check.
 */
export function fleetSweepCallerExitMessage(sweep: FleetSweepResult): string | null {
  if (!fleetSweepShouldAbort(sweep.verdict)) return null;
  return `fleet verify failed (exit ${sweep.exitCode}) — ${sweep.verdict.summary}`;
}

/**
 * Decide what to do after post-restart verification (flair#635). Pure —
 * takes the ProbeResult and the previously-installed @tpsdev-ai/flair
 * version (known from the pre-upgrade probe findings), returns the action
 * without performing any I/O.
 */
export type UpgradeVerifyAction =
  | { kind: "ok" }
  | { kind: "healthy-unverified"; reason: string }
  | { kind: "rollback"; reason: string; toVersion: string }
  | { kind: "cannot-rollback"; reason: string };

export function decideAfterVerify(result: ProbeResult, previousVersion: string | null): UpgradeVerifyAction {
  if (result.ok) return { kind: "ok" };
  const reason = result.error ?? "post-restart verification failed";
  // A HEALTHY instance whose ONLY failure was that the verifier couldn't
  // authenticate (401/403) is demonstrably UP: the public /Health answered
  // 2xx AND the server responded to the authenticated probe — it rejected our
  // credentials, it did not fail to respond. A version we couldn't READ is not
  // grounds to roll back a RUNNING instance. Rolling back here is destructive
  // AND self-defeating — the rollback's own re-verify hits the identical
  // missing-credential wall, producing the false "ROLLBACK ALSO FAILED / state
  // UNKNOWN" for an instance that was healthy the whole time. (The real
  // incident: /HealthDetail became a verified-read in flair#747, so a machine
  // with no admin-pass/agent key authenticates fine against the pre-upgrade
  // version but not post-restart — the pre-flight credential check can't
  // anticipate a version that changes /HealthDetail's auth requirement.)
  // Report it as up-but-unverified and NEVER roll back. This supersedes
  // flair#741 fix #3's "prefer the known-good version" default, which the
  // incident proved wrong for a healthy instance.
  if (isCredentialOnlyFailure(result)) return { kind: "healthy-unverified", reason };
  if (!previousVersion) return { kind: "cannot-rollback", reason };
  return { kind: "rollback", reason, toVersion: previousVersion };
}

/** Decide the final outcome after re-verifying a rollback (flair#635). Pure. */
export type RollbackVerifyAction =
  | { kind: "rolled-back" }
  | { kind: "rollback-failed"; reason: string };

export function decideAfterRollbackVerify(result: ProbeResult): RollbackVerifyAction {
  if (result.ok) return { kind: "rolled-back" };
  return { kind: "rollback-failed", reason: result.error ?? "rollback verification failed" };
}

/**
 * Order a soul key→count map for display: highest count first, ties broken
 * alphabetically for stable output. Soul entries are keyed identity facts
 * (role / project / standards / …) — this is the honest breakdown dimension.
 * (Replaced a priority breakdown that was dead telemetry — see flair#453:
 * nothing ever writes Soul.priority to anything but "standard".)
 */
export function sortSoulKeyEntries(byKey: Record<string, number>): Array<[string, number]> {
  return Object.entries(byKey ?? {}).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

// ─── First-run soul wizard ────────────────────────────────────────────────────

type SoulEntries = [string, string][];

export function templateSoul(choice: string): SoulEntries {
  const templates: Record<string, SoulEntries> = {
    "1": [
      ["role", "Pair programmer on this machine. Concise, direct, proactive about flagging risks before I hit them."],
      ["project", "(fill in: the main project or repo I'm helping with — shapes what bootstrap prioritizes)"],
      ["standards", "Match existing codebase style. Prefer editing over rewriting. Surface tradeoffs on ambiguous decisions instead of making unilateral calls."],
    ],
    "2": [
      ["role", "Team agent — operates in a shared repo and coordinates with other agents. Communicate through structured channels (PRs, issues, mail), not free-form chat."],
      ["project", "(fill in: the repo or ops flow this agent runs in)"],
      ["standards", "Keep changes minimal and reviewable. Always open PRs, never push to main. Document decisions in the issue tracker, not in agent memory."],
    ],
    "3": [
      ["role", "Research assistant. Survey sources, extract findings, write structured notes. Flag uncertainty explicitly; separate evidence from inference."],
      ["project", "(fill in: the research area or question being tracked)"],
      ["standards", "Cite sources inline. When sources disagree, surface the disagreement rather than picking a side silently. Prefer primary sources."],
    ],
  };
  return templates[choice] ?? [];
}

async function customSoulPrompts(ask: (q: string) => Promise<string>): Promise<SoulEntries> {
  const entries: SoulEntries = [];

  console.log("\n   Three fields. Press Enter on any to skip it.\n");

  console.log("   role — how the agent identifies itself and acts");
  console.log("     \"Senior dev, concise and direct\"");
  console.log("     \"Data-engineering sidekick, SQL-first\"");
  console.log("     \"PM assistant — asks clarifying questions before writing specs\"");
  const role = await ask("   > ");
  if (role.trim()) entries.push(["role", role.trim()]);

  console.log("\n   project — what the agent is currently focused on");
  console.log("     \"LifestyleLab — building Flair and TPS\"");
  console.log("     \"Legal discovery review, Q2 contracts\"");
  console.log("     \"Personal automation scripts in Bash + Python\"");
  const project = await ask("   > ");
  if (project.trim()) entries.push(["project", project.trim()]);

  console.log("\n   standards — communication or coding preferences that should persist");
  console.log("     \"No emojis. Match existing style. Ask before risky ops.\"");
  console.log("     \"Always cite sources. Flag uncertainty explicitly.\"");
  console.log("     \"Typescript strict mode. Prefer composition over inheritance.\"");
  const standards = await ask("   > ");
  if (standards.trim()) entries.push(["standards", standards.trim()]);

  return entries;
}

async function editEntries(ask: (q: string) => Promise<string>, entries: SoulEntries): Promise<SoulEntries> {
  console.log("\n   Press Enter to keep each default, or type a replacement:");
  const result: SoulEntries = [];
  for (const [key, def] of entries) {
    const preview = def.length > 60 ? def.slice(0, 57) + "..." : def;
    console.log(`\n   ${key} [keep: ${preview}]`);
    const input = (await ask("   > ")).trim();
    result.push([key, input || def]);
  }
  return result;
}

export function parseSoulJson(raw: string): SoulEntries {
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("no JSON object found in input");
  const parsed = JSON.parse(jsonMatch[0]);
  const entries: SoulEntries = [];
  if (parsed.role) entries.push(["role", String(parsed.role).trim()]);
  if (parsed.project) entries.push(["project", String(parsed.project).trim()]);
  if (parsed.standards) entries.push(["standards", String(parsed.standards).trim()]);
  if (entries.length === 0) throw new Error("JSON had no role/project/standards keys");
  return entries;
}

async function runSoulWizard(agentId: string): Promise<SoulEntries> {
  const { createInterface } = await import("node:readline");
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  // Buffered ask: collects rapid input (pasted text) into one answer.
  // Waits 200ms after last line before resolving, so pasted multiline
  // blocks are captured as a single answer instead of spilling across prompts.
  const ask = (q: string): Promise<string> => new Promise(resolve => {
    let buffer = "";
    let timer: ReturnType<typeof setTimeout> | null = null;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      rl.removeListener("line", onLine);
      resolve(buffer.trim());
    };
    const onLine = (line: string) => {
      buffer += (buffer ? "\n" : "") + line;
      if (timer) clearTimeout(timer);
      timer = setTimeout(finish, 200);
    };
    process.stdout.write(q);
    rl.on("line", onLine);
  });

  console.log("\n🎭 Agent personality setup");
  console.log("   Soul entries shape what every future session starts with.\n");
  console.log("   What best describes this agent?");
  console.log("     (1) Solo developer — helps you with code on this machine");
  console.log("     (2) Team agent — runs in a shared repo / ops flow");
  console.log("     (3) Research assistant — surveys sources, writes notes");
  console.log("     (4) Draft from Claude — paste a Claude-generated JSON draft");
  console.log("     (5) Custom — I'll prompt for each field with examples");
  console.log("     (s) Skip — set up later; `flair doctor` will nudge\n");

  const choice = (await ask("   Choice [1-5/s]: ")).trim().toLowerCase();

  let entries: SoulEntries = [];

  if (choice === "s" || choice === "skip") {
    rl.close();
    return [];
  } else if (choice === "1" || choice === "2" || choice === "3") {
    entries = templateSoul(choice);
    console.log("\n   Template draft:");
    for (const [k, v] of entries) console.log(`     ${k}: ${v}`);
    const edit = (await ask("\n   Edit before saving? [y/N]: ")).trim().toLowerCase();
    if (edit === "y" || edit === "yes") {
      entries = await editEntries(ask, entries);
    }
  } else if (choice === "4") {
    console.log("\n   Paste this prompt into your Claude session:");
    console.log("   ─────────────────────────────────────────────────────────────");
    console.log(`   Generate a JSON object with keys "role", "project", and`);
    console.log(`   "standards" suitable as Flair soul entries for an agent with`);
    console.log(`   id "${agentId}" operating in my current context. Each value`);
    console.log(`   should be 1-2 specific sentences that shape behavior. Output`);
    console.log(`   only the JSON object, no prose.`);
    console.log("   ─────────────────────────────────────────────────────────────\n");
    console.log("   Paste the resulting JSON below:");
    const raw = await ask("   > ");
    try {
      entries = parseSoulJson(raw);
      console.log("\n   Parsed draft:");
      for (const [k, v] of entries) console.log(`     ${k}: ${v}`);
      const edit = (await ask("\n   Edit before saving? [y/N]: ")).trim().toLowerCase();
      if (edit === "y" || edit === "yes") {
        entries = await editEntries(ask, entries);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(`\n   Couldn't parse JSON (${message}). Falling back to custom prompts.`);
      entries = await customSoulPrompts(ask);
    }
  } else {
    // Custom (5) or unrecognized input — route to custom prompts
    entries = await customSoulPrompts(ask);
  }

  rl.close();
  return entries.filter(([, v]) => v.trim().length > 0);
}

// ─── Program ─────────────────────────────────────────────────────────────────

// This CLI's own version. Resolution lives in src/lib/mcp-spec.ts so that the
// client-wiring code (src/install/clients.ts) shares ONE definition of both
// the version and the MCP spec derived from it — see flair#907 for what
// happened when the pin lived next to a single call site.
const __pkgVersion = flairCliVersion();

// mcpServerSpec now lives in src/lib/mcp-spec.ts alongside the version
// resolution it depends on, so every writer shares it. Re-exported here
// because it is part of this module's public surface (tests and callers
// import it from src/cli.ts).
export { mcpServerSpec };

const program = new Command();
program.name("flair").version(__pkgVersion, "-v, --version");

// flair#926: an option declared on a parent is consumed by the PARENT even when
// it appears after a subcommand name, so a subcommand must NOT redeclare one —
// the duplicate never receives a value, it only makes the flag look local.
// Removing those duplicates would have hidden working flags from the
// subcommand's help, so the help is taught to show inherited options instead.
// This is commander's own answer to the problem, and it applies to every
// subcommand at once rather than one hand-maintained list of exceptions.
program.configureHelp({ showGlobalOptions: true });

// ─── CLI↔server version handshake (flair#695 §B) ────────────────────────────
// Every command invocation gets a cheap, cached (~60s), short-timeout check
// of the running server's version against this CLI's own — catches the
// bare-npm-upgrade trap where `npm i -g @tpsdev-ai/flair@latest` swaps the
// CLI binary but the already-running Harper daemon keeps serving the OLD
// code until `flair restart`. `doctor` is excluded here — it already prints
// a richer version triple (CLI/installed, running, latest-published) plus
// migration state, so a global hook nudge on top of that would be
// redundant noise on the one command whose whole job is this exact report.
program.hook("preAction", async (_thisCommand, actionCommand) => {
  if (actionCommand.name() === "doctor") return;
  // Interactive-only: this is a pure stderr UX nudge for a human at a
  // terminal ("bare-npm users must not get stuck"), not a machine-consumed
  // signal — it never changes exit codes or stdout. Gating on TTY means a
  // piped/scripted/CI invocation (and every existing test that spawns the
  // CLI against a mock server) never pays the extra network round trip,
  // which matters beyond latency: several unit tests spawn this CLI against
  // a single-shot mock HTTP server asserting on exactly one received
  // request (e.g. test/unit/presence-set.test.ts) — an unconditional extra
  // GET /Health here would silently consume that slot and break them.
  if (!process.stdout.isTTY) return;
  try {
    const opts = (actionCommand.opts?.() ?? {}) as { port?: string | number };
    const serverUrl = `http://127.0.0.1:${resolveHttpPort(opts)}`;
    // Cache key component: prefer the server's own ROOTPATH if this shell
    // happens to have it set (operating a non-default Harper instance
    // root), else fall back to Flair's own resolved data directory — same
    // "which local install is this" identity every other doctor/status
    // check already keys off, so a stale cache from a since-reinstalled
    // instance sharing the same port never bleeds into a fresh one.
    const rootPath = process.env.ROOTPATH ?? defaultDataDir();
    const result = await checkServerHandshake(__pkgVersion, rootPath, serverUrl);
    const nudge = formatHandshakeNudge(result);
    if (nudge) console.error(`⚠️  ${nudge}`);
  } catch {
    // NEVER block or fail the underlying command over this check.
  }
});

// ─── flair init ────────────────────────────────────────────────────────────
// Command registration lives in src/commands/init.ts (flair#1636).
// Bind shared cli-locals first so the extracted module never imports this file.
bindInitCli({
  api,
  b64url,
  buildOperationsApiConfig,
  cleanupLegacyLaunchdPlist,
  defaultDataDir,
  defaultLaunchAgentsDir,
  ensureFlairAgentRole,
  ensureFlairAgentUser,
  ensureFlairPairInitiatorRole,
  flairPackageDir,
  harperBin,
  harperConfigPath,
  launchdLabel,
  launchdPlistPath,
  opsNetworkPortValue,
  persistDefaultInstallCoordinates,
  privKeyPath,
  provisionFabric,
  pubKeyPath,
  readyOpsSocketPosture,
  reconcileFederationInstanceViaOpsApi,
  resolveHttpPort,
  writeAdminPassFile,
  resolveOpsBindHost,
  resolveHttpBindFor,
  resolveOpsPort,
  resolveOpsTarget,
  resolveOpsUrlFromTarget,
  resolveTarget,
  runSoulWizard,
  seedAgentViaOpsApi,
  seedFederationInstanceViaOpsApi,
  shouldShowInlineSecretWarning,
  verifyAuditLog,
  verifySemanticSearch,
  waitForHealth,
  writeDaemonSidecar,
  writeInitLaunchdPlist,
  MQTT_DISABLED_CONFIG,
  STARTUP_TIMEOUT_MS,
});
registerInit(program);

// ─── flair agent ─────────────────────────────────────────────────────────────
// Command group lives in src/commands/agent.ts (flair#1630). Bind shared helpers
// first so the extracted module never imports this file.
bindAgentCli({
  api,
  b64url,
  privKeyPath,
  pubKeyPath,
  shouldShowInlineSecretWarning,
  resolveHttpPort,
  resolveOpsPort,
  resolveEffectiveOpsUrl,
  seedAgentViaOpsApi,
  agentRecordIsAdmin,
});
registerAgent(program);


// ─── flair keys ────────────────────────────────────────────────────────────────
// Command group lives in src/commands/keys.ts (flair#1629). Bind shared helpers
// first so the extracted module never imports this file.
bindKeysCli({
  checkAgentRegistered,
  probeFlairReachable,
  resolveBaseUrl,
});
registerKeys(program);


// ─── flair hook ──────────────────────────────────────────────────────────────
// Command group lives in src/commands/hook.ts (flair#1627). Bind shared helpers
// first so the extracted module never imports this file.
bindHookCli({
  resolveBaseUrl,
});
registerHook(program);

// ─── flair mcp ───────────────────────────────────────────────────────────────
// Command group lives in src/commands/mcp.ts (flair#1625). Bind shared helpers
// first so the extracted module never imports this file.
bindMcpCli({
  resolveOpsPort,
  privKeyPath,
  pubKeyPath,
  b64url,
});
registerMcp(program);

// ─── flair principal ─────────────────────────────────────────────────────────
// Command group lives in src/commands/principal.ts (flair#1632). Bind shared
// helpers first so the extracted module never imports this file.
bindPrincipalCli({
  api,
  b64url,
  privKeyPath,
  pubKeyPath,
  relativeTime,
  resolveOpsPort,
});
registerPrincipal(program);


// ─── flair idp ───────────────────────────────────────────────────────────────
// Command group lives in src/commands/idp.ts (flair#1626). Bind shared helpers
// first so the extracted module never imports this file.
bindIdpCli({
  resolveOpsPort,
  api,
});
registerIdp(program);

// ─── flair grant / revoke ─────────────────────────────────────────────────────
// Commands live in src/commands/grant.ts (flair#1636). Bind shared cli-locals
// first so the extracted module never imports this file.
bindGrantCli({
  resolveHttpPort,
  resolveOpsPort,
  resolveAdminUser,
});
registerGrant(program);

// ─── flair federation ────────────────────────────────────────────────────────
// Command group lives in src/commands/federation.ts (flair#1620). Bind shared
// helpers first so the extracted module never imports this file.
bindFederationCli({
  api,
  resolveTarget,
  resolveBaseUrl,
  resolveEffectiveOpsUrl,
  resolveOpsPort,
  applyAdminPassFile,
  addSharedCredentialOptions,
  addSharedIdentityOption,
  shouldShowInlineSecretWarning,
});
registerFederation(program);

// ─── flair rem ───────────────────────────────────────────────────────────────
// Command group lives in src/commands/rem.ts (flair#1623). Bind shared
// helpers first so the extracted module never imports this file.
bindRemCli({
  api,
  resolveOpsPort,
  applyAdminPassFile,
  addSharedCredentialOptions,
  readPortFromConfig,
  resolveHttpPort,
  humanBytes,
  relativeTime,
  DEFAULT_PORT,
  pkgVersion: __pkgVersion,
});
registerRem(program);

function humanBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const ago = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ago) || ago < 0) return "—";
  const mins = Math.floor(ago / 60000);
  const hrs = Math.floor(ago / 3600000);
  const days = Math.floor(ago / 86400000);
  return days > 0 ? `${days}d ago` : hrs > 0 ? `${hrs}h ago` : mins > 0 ? `${mins}m ago` : "just now";
}

// flair#1183: `signingAgentIdOverride` lets a calling command that already
// resolved a signing identity via the canonical seam (resolveSigningAgentId)
// pass it in, so this verified read signs as the SAME agent the rest of the
// command does. Undefined = resolve locally via the legacy flag>env pair (all
// other callers, unchanged).
async function fetchHealthDetail(opts: { port?: string; url?: string; target?: string; agent?: string }, signingAgentIdOverride?: string | null, signingAgentSource?: SigningIdentitySource): Promise<{
  healthy: boolean;
  baseUrl: string;
  healthData: any | null;
}> {
  const port = resolveHttpPort(opts);
  // --target takes precedence, then --url, then FLAIR_TARGET, then FLAIR_URL, then localhost
  let baseUrl = opts.target || opts.url || process.env.FLAIR_TARGET || (process.env.FLAIR_URL ?? `http://127.0.0.1:${port}`);
  let healthy = false;
  let healthData: any = null;

  try {
    let res = await fetch(`${baseUrl}/Health`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok && res.status === 401) {
      const adminPass = process.env.FLAIR_ADMIN_PASS ?? process.env.HDB_ADMIN_PASSWORD;
      if (adminPass) {
        res = await fetch(`${baseUrl}/Health`, {
          headers: { Authorization: `Basic ${Buffer.from(`${resolveAdminUser(undefined)}:${adminPass}`).toString("base64")}` },
          signal: AbortSignal.timeout(5000),
        });
      }
    }
    healthy = res.ok;
  } catch { /* unreachable */ }

  // flair#1719: the resolved URL for the default install comes from Harper's
  // boot record, which can be stale relative to ~/.flair/config.yaml. If that
  // port is dead and the configured port has a live daemon, treat the
  // configured port as the resolved URL rather than reporting the stale one
  // unreachable (and then telling the user to edit a config that is correct).
  if (!healthy) {
    const altPort = alternateConfiguredLocalPort(opts);
    if (altPort !== null) {
      const altUrl = `http://127.0.0.1:${altPort}`;
      try {
        let res = await fetch(`${altUrl}/Health`, { signal: AbortSignal.timeout(5000) });
        if (!res.ok && res.status === 401) {
          const adminPass = process.env.FLAIR_ADMIN_PASS ?? process.env.HDB_ADMIN_PASSWORD;
          if (adminPass) {
            res = await fetch(`${altUrl}/Health`, {
              headers: { Authorization: `Basic ${Buffer.from(`${resolveAdminUser(undefined)}:${adminPass}`).toString("base64")}` },
              signal: AbortSignal.timeout(5000),
            });
          }
        }
        if (res.ok) {
          baseUrl = altUrl;
          healthy = true;
        }
      } catch { /* configured port also unreachable — fall through to the primary */ }
    }
  }

  if (healthy) {
    // flair#747: /HealthDetail is a verified-read (any registered agent, not
    // just admins — see verifyAuthedGet's doc). Previously this tried the
    // --agent/FLAIR_AGENT_ID key FIRST and admin-pass env only as a manual
    // second attempt, with no admin-pass-FILE leg and no floor at all when
    // no --agent was given — exactly the flair#741 gap, on the `status`
    // command family specifically. Now routed through the shared resolver:
    // env admin-pass > pinned agent key (if --agent/FLAIR_AGENT_ID given) >
    // ~/.flair/admin-pass file > the Ed25519 floor (any registered key) when
    // nothing else resolved.
    try {
      healthData = await authedRequest("GET", "/HealthDetail", undefined, {
        baseUrl,
        agentId: signingAgentIdOverride !== undefined
          ? (signingAgentIdOverride ?? undefined)
          : (opts.agent || process.env.FLAIR_AGENT_ID),
        agentIdSource: signingAgentSource,
      });
    } catch {
      // No credential tier resolved a verified read — healthData stays
      // null; callers already render an "unauthenticated" / limited view.
    }
  }

  return { healthy, baseUrl, healthData };
}

// ─── flair status ────────────────────────────────────────────────────────────
// Command registration lives in src/commands/status.ts (flair#1636).
// Bind shared cli-locals first so the extracted module never imports this file.
bindStatusCli({
  fetchHealthDetail,
  humanBytes,
  relativeTime,
  resolveSigningAgentId,
  sortSoulKeyEntries,
  defaultDataDir,
  readHarperConfig,
  readPortFromConfig,
  __pkgVersion,
});
registerStatus(program);

// ─── Fabric credential resolution (flair deploy / flair upgrade --target) ──
//
// Both commands accept Fabric admin credentials the same three ways: inline
// flags (--fabric-user/--fabric-password — leak to shell history and `ps`
// for the life of the process), a mode-checked --fabric-password-file
// (mirrors --admin-pass-file's file idiom, see readSecretFileSecure above),
// or the FABRIC_USER/FABRIC_PASSWORD env vars. Centralized here so the two
// call sites (runFabricUpgrade below, and `flair deploy`'s action) can't
// drift on precedence or warning wording.
//
// Password precedence: --fabric-password (inline) > --fabric-password-file
// > FABRIC_PASSWORD env. Both explicit, per-invocation sources (inline
// flag, file flag) outrank env, because an env var can be a stale/ambient
// value left over from an earlier shell session rather than something the
// operator actually intended for THIS invocation. Between the two explicit
// sources, inline wins when both are given — matching this CLI's general
// "flag beats everything" precedent elsewhere (resolveBaseUrl/
// resolveHttpPort: --target/--port always outrank their env equivalents) —
// but a warning is returned so a stray leftover --fabric-password doesn't
// silently shadow a safer --fabric-password-file the operator meant to use
// instead of it.
//
// Username has no file-based option: a username isn't a secret that needs
// disk-permission protection. But inline --fabric-user is still recon — it
// confirms a valid login name to anyone who can read `ps` or shell history —
// so it gets the same inline-only warning as inline --fabric-password.
export interface FabricCredentialResolution {
  fabricUser: string | undefined;
  fabricPassword: string | undefined;
  warnings: string[];
}

export function resolveFabricCredentials(opts: {
  fabricUser?: string;
  fabricPassword?: string;
  fabricPasswordFile?: string;
}): FabricCredentialResolution {
  const warnings: string[] = [];

  if (opts.fabricUser && !process.env.FABRIC_USER) {
    warnings.push(
      "warning: --fabric-user passed inline. Consider FABRIC_USER env — " +
        "a login name in shell history/ps is recon."
    );
  }
  const fabricUser = opts.fabricUser ?? process.env.FABRIC_USER;

  let fabricPassword: string | undefined;
  if (opts.fabricPassword) {
    if (opts.fabricPasswordFile) {
      warnings.push(
        "warning: --fabric-password (inline) takes precedence over --fabric-password-file " +
          "when both are given. Pass --fabric-password-file alone to keep the secret out of shell history."
      );
    }
    if (!process.env.FABRIC_PASSWORD) {
      warnings.push(
        "warning: --fabric-password leaks to shell history. Prefer FABRIC_PASSWORD env or --fabric-password-file."
      );
    }
    fabricPassword = opts.fabricPassword;
  } else if (opts.fabricPasswordFile) {
    fabricPassword = readSecretFileSecure(opts.fabricPasswordFile, "--fabric-password-file");
  } else {
    fabricPassword = process.env.FABRIC_PASSWORD;
  }

  return { fabricUser, fabricPassword, warnings };
}

/**
 * Stamp the data directory with the currently-installed Harper engine version
 * (flair#1047). Called after every successful boot — start, restart, upgrade.
 * Best-effort: a failure to stamp is not a boot failure.
 */
function stampEngineVersionIfRunning(dataDir: string): void {
  try {
    const version = readInstalledHarperVersion(flairPackageDir());
    if (version) writeEngineVersionStamp(dataDir, version);
  } catch { /* best-effort — stamp failure must not prevent boot */ }
}

// ─── flair upgrade ────────────────────────────────────────────────────────────
// Command registration lives in src/commands/upgrade.ts (flair#1636).
// Bind shared cli-locals first so the extracted module never imports this file.
bindUpgradeCli({
  decideAfterRollbackVerify,
  decideAfterVerify,
  defaultDataDir,
  doctorRunAfterUpgrade,
  flairPackageDir,
  fleetSweepCallerExitMessage,
  humanBytes,
  isCredentialOnlyFailure,
  observeLaunchdManagement,
  printVerifiedSummary,
  probeBinVersion,
  probeLibVersion,
  probeOpenclawPluginVersion,
  relativeTime,
  resolveFabricCredentials,
  resolveFlairMcpFinding,
  resolveHttpPort,
  resolveInstalledFlairCli,
  resolveInstanceServingPid,
  resolveUpgradeRestartVerify,
  restartAfterUpgrade,
  shouldPrintUpgradeLine,
  shouldRunFleetVerify,
  startFlairProcess,
  stopFlairProcess,
  upgradeStatusSuffix,
  verifyAuthedGet,
  STARTUP_TIMEOUT_MS,
});
registerUpgrade(program);

// ─── daemon liveness machine (flair#1454) ────────────────────────────────────
//
// The pure classifier lives in src/lib/daemon-liveness.ts. These adapters are
// the only places that touch the real filesystem, network, or a process, so
// every classifier branch is unit-testable without a daemon. External tools
// (lsof/ss/ps) never decide the five-state verdict: lsof absence is not
// "not running". lsof MAY gate the #1454 sidecar self-heal when present —
// a listener pid that is not the launched instance is NOT healed
// (flair#1478). Absence of lsof skips that bind; it does not fail it.

/** A pidfile/sidecar read that refuses to follow a symlink (O_NOFOLLOW). */
type NoFollowRead =
  | { kind: "absent" }
  | { kind: "unreadable"; reason: string }
  | { kind: "present"; content: string };

/**
 * Read a file with O_NOFOLLOW so a symlink planted at the pidfile/sidecar path
 * cannot redirect the read (flair#1454 decision 6). `readFileSync` has no such
 * flag, so this opens the fd first and reads from it.
 */
function readFileNoFollow(path: string): NoFollowRead {
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (err: any) {
    if (err?.code === "ENOENT") return { kind: "absent" };
    if (err?.code === "ELOOP") return { kind: "unreadable", reason: `${path} is a symbolic link` };
    return { kind: "unreadable", reason: `cannot open ${path}: ${err?.code ?? err?.message}` };
  }
  try {
    return { kind: "present", content: readFileSync(fd, "utf-8") };
  } catch (err: any) {
    return { kind: "unreadable", reason: `cannot read ${path}: ${err?.code ?? err?.message}` };
  } finally {
    try { closeSync(fd); } catch { /* already closed */ }
  }
}

/**
 * Refuse to trust a data dir that is a symlink or world-writable (flair#1454
 * decision 6). Returns a reason, or null when the dir is safe (or absent — a
 * missing dir is "no data", not "unsafe"; the pidfile read reports absent).
 */
function checkDataDirSafe(dataDir: string): string | null {
  let lst;
  try {
    lst = lstatSync(dataDir);
  } catch {
    return null;
  }
  if (lst.isSymbolicLink()) {
    return `data directory ${dataDir} is a symbolic link — refusing to trust its pidfile`;
  }
  let st;
  try {
    st = statSync(dataDir);
  } catch {
    return null;
  }
  if (st.mode & 0o002) {
    return `data directory ${dataDir} is world-writable — refusing to trust its pidfile`;
  }
  return null;
}

/** Read `hdb.pid` (O_NOFOLLOW) into a `PidfileRead`. */
function readPidfile(dataDir: string): PidfileRead {
  const r = readFileNoFollow(join(dataDir, "hdb.pid"));
  if (r.kind !== "present") return r;
  const n = Number(r.content.trim());
  if (!Number.isInteger(n) || n <= 0) {
    return { kind: "unreadable", reason: `${join(dataDir, "hdb.pid")} does not contain a valid pid` };
  }
  return { kind: "present", pid: n };
}

/** Read `flair-daemon.json` (O_NOFOLLOW) into a `SidecarRead`. */
function readSidecar(dataDir: string): SidecarRead {
  const r = readFileNoFollow(join(dataDir, "flair-daemon.json"));
  if (r.kind !== "present") return r;
  const parsed = parseSidecarJson(r.content);
  if (parsed === null) {
    return { kind: "unreadable", reason: `${join(dataDir, "flair-daemon.json")} is malformed` };
  }
  return { kind: "present", ...parsed };
}

/** `kill(pid, 0)` as a three-way: alive / gone (ESRCH) / eperm (another user's). */
function probePidLiveness(pid: number): PidLiveness {
  try {
    process.kill(pid, 0);
    return { kind: "alive" };
  } catch (err: any) {
    if (err?.code === "ESRCH") return { kind: "gone" };
    if (err?.code === "EPERM") return { kind: "eperm" };
    return { kind: "gone" };
  }
}

/**
 * The health probe (flair#1478): ok only when the response is 2xx AND the
 * body is flair's /Health shape. A decoy that answers 200 is `foreign`,
 * not healed.
 */
async function probeHealth(port: number): Promise<HealthResult> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/Health`, { signal: AbortSignal.timeout(2000) });
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return classifyHealthProbe({ kind: "response", status: res.status, body });
  } catch (err: any) {
    // Node's undici fetch reports ECONNREFUSED on `err.cause.code`; Bun reports
    // `ConnectionRefused` on `err.code`. Both mean "nothing is listening".
    const code = err?.cause?.code ?? err?.code;
    return classifyHealthProbe({ kind: "network-error", code });
  }
}

/**
 * PIDs LISTENING on `port` via `lsof -ti :<port> -sTCP:LISTEN`, or null
 * when lsof is absent / unusable. Empty array means lsof ran and saw no
 * listener — treated as unavailable by classifyPortOwner (do not
 * false-red a real daemon because lsof missed). Non-empty without the
 * launched pid is the stale/foreign holder #1478 refuses to heal.
 */
function resolveListenerPids(port: number): number[] | null {
  try {
    const out = execFileSync("lsof", ["-ti", `:${port}`, "-sTCP:LISTEN"], {
      encoding: "utf-8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return parseListeningPids(out, process.pid);
  } catch (err: any) {
    if (err?.code === "ENOENT") return null;
    if (typeof err?.status === "number") return [];
    return null;
  }
}

function canonicalizeExistingPath(p: string): string {
  try {
    return realpathSync(resolve(p));
  } catch {
    return resolve(p);
  }
}

/** Best-effort ROOTPATH from `/proc/<pid>/environ`. */
function readProcessRootPath(pid: number): { rootPath: string | null; environReadable: boolean } {
  if (process.platform === "linux") {
    try {
      const raw = readFileSync(`/proc/${pid}/environ`, "utf-8");
      return { rootPath: extractRootPath(parseNullSeparatedEnviron(raw)), environReadable: true };
    } catch {
      return { rootPath: null, environReadable: false };
    }
  }
  return { rootPath: null, environReadable: false };
}

/**
 * Was this pid inspectable as a flair worktree? `null` when cwd and
 * cmdline could not be read — do not treat that as "not flair".
 */
function inspectServingFlairPackage(pid: number): boolean | null {
  const cwd = defaultReadProcessCwd(pid);
  const cmdline = defaultReadProcessCmdline(pid);
  if (cwd === null && cmdline === null) return null;
  return resolveServingFlairPackage(pid) !== null;
}

/** Gather every piece of evidence the classifier needs, in one place. */
async function gatherDaemonEvidence(port: number, dataDir: string): Promise<DaemonEvidence> {
  const dataDirUnsafe = checkDataDirSafe(dataDir);
  const pidfile = readPidfile(dataDir);
  const pidLiveness = pidfile.kind === "present" ? probePidLiveness(pidfile.pid) : null;
  let sidecar = readSidecar(dataDir);

  // Probe health first so the self-heal gate below can use it without a
  // second round-trip. Also consumed at the end for the classifier.
  const health = await probeHealth(port);

  // flair#1454 self-heal: a daemon started by a pre-sidecar version of flair
  // (upgrade-across-#1454) has a live pid in hdb.pid but no flair-daemon.json.
  // Without this path, classifyDaemonState returns DISAGREEMENT and `flair stop`
  // refuses — breaking the upgrade flow for every existing user.
  //
  // SECURITY (flair#1478): /Health "ok" is flair-identified 2xx, not a bare
  // HTTP response. The ±2s start-time check is still circular here (we write
  // the sidecar from the live process's own start time). Identity is:
  //   1. res.ok + flair /Health body — a decoy 200 is `foreign`, not healed
  //   2. the port's listener pid is the launched pid (lsof, best-effort)
  //   3. that pid is the flair instance for this dataDir (worktree/ROOTPATH)
  // A stale or foreign pid holding the port is NOT healed. False-green is
  // worse than no self-heal.
  //
  // The write uses the same O_NOFOLLOW / 0600 / atomic-rename posture as every
  // other sidecar write. We skip self-heal when the dataDir is unsafe
  // (symlink / world-writable) — the check has already happened above.
  let portOwner: PortOwnerResult = { kind: "unavailable" };
  let instanceMatch: InstanceMatch = { kind: "unavailable" };
  if (
    sidecar.kind === "absent" &&
    dataDirUnsafe === null &&
    pidfile.kind === "present" &&
    pidLiveness?.kind === "alive"
  ) {
    const pid = pidfile.pid;
    portOwner = classifyPortOwner({ launchedPid: pid, listenerPids: resolveListenerPids(port) });
    const { rootPath, environReadable } = readProcessRootPath(pid);
    instanceMatch = classifyInstanceMatch({
      expectedDataDir: canonicalizeExistingPath(dataDir),
      processRootPath: rootPath ? canonicalizeExistingPath(rootPath) : null,
      environReadable,
      servingFlairPackage: inspectServingFlairPackage(pid),
    });
    if (shouldAdoptMissingSidecar({
      sidecarAbsent: true,
      dataDirSafe: true,
      pidfilePresent: true,
      pidAlive: true,
      health,
      portOwner,
      instanceMatch,
    })) {
      const startTimeMs = readProcessStartTimeMs(pid);
      if (startTimeMs !== null) {
        try {
          writeDaemonSidecar(dataDir, pid, port, startTimeMs);
          // Re-read: now that the sidecar exists, classify through the normal path.
          sidecar = readSidecar(dataDir);
        } catch {
          // Self-heal is best-effort. If the write fails (e.g. read-only dataDir),
          // we proceed with sidecar === absent and fall through to DISAGREEMENT
          // — the same outcome as before the self-heal path, so no regression.
        }
      }
    }
  }

  const identity = verifyIdentity({
    pidfilePid: pidfile.kind === "present" ? pidfile.pid : null,
    sidecar,
    readStartTime: readProcessStartTimeMs,
  });
  return { dataDirUnsafe, pidfile, pidLiveness, identity, health };
}

/**
 * Write the identity sidecar atomically (temp + rename) at spawn time or
 * during self-heal (flair#1454 decision 3). `pid` is the spawned process's
 * pid — the same number Harper writes to `hdb.pid`, since Harper runs
 * in-process. `startTimeMs` defaults to `Date.now()` for a fresh spawn.
 *
 * Self-heal callers pass the live process's actual start time (from
 * readProcessStartTimeMs) so the sidecar records an accurate epoch, not a
 * wall-clock approximation. Note: in the self-heal path the ±2s start-time
 * check in verifyIdentity is NOT what prevents recycled-pid adoption —
 * that guard is the flair-identified /Health probe plus the pid→port bind
 * (flair#1478) that the self-heal caller already required before reaching
 * this point. The start time is recorded faithfully for forward
 * compatibility and audit, not as a security gate here.
 */
function writeDaemonSidecar(dataDir: string, pid: number, port: number, startTimeMs = Date.now()): void {
  const sidecar = { pid, startTimeMs, port, flairVersion: __pkgVersion };
  const tmpPath = join(dataDir, `.flair-daemon.json.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  // Write with mode 0600 so the tmp file is never world-readable (flair#1454
  // decision 6 — same posture as admin-pass and key material).
  writeFileSync(tmpPath, JSON.stringify(sidecar, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
  const finalPath = join(dataDir, "flair-daemon.json");
  renameSync(tmpPath, finalPath);
  // Re-assert 0600 after the rename: rename preserves the tmp permissions but
  // a pre-existing file at the destination retains its original mode on some
  // kernels. An explicit chmod is the only guarantee (flair#1454 decision 6).
  chmodSync(finalPath, 0o600);
}

/**
 * Refuse to act on a launchd service that belongs to a DIFFERENT data
 * directory than the one the command is operating on (flair#902).
 *
 * `resolveLaunchdLabel`'s instance-scoped label is a hash of the data dir,
 * so it can never address another instance — but its pre-flair#693 legacy
 * fallback CAN: `ai.tpsdev.flair` is a single global label, returned for
 * ANY data dir whenever that plist exists. On a host that still has one,
 * `flair snapshot restore --data-dir <scratch>` would resolve the legacy
 * service and stop whatever install it actually belongs to.
 *
 * The plist records the instance it was written for (`ROOTPATH`), so the
 * check is exact. Refuses ONLY on positive contradiction: a plist with no
 * ROOTPATH (hand-written, or some other writer's) is no evidence and is
 * left alone rather than blocking a legitimate stop.
 *
 * Never logs plist contents — the plist embeds HDB_ADMIN_PASSWORD. Only the
 * extracted ROOTPATH path ever reaches a message.
 */

/**
 * Read the ROOTPATH declared in a launchd plist, or null if it cannot be
 * determined (file missing, unreadable, or no ROOTPATH key).
 *
 * The plist stores this XML-escaped (buildLaunchdPlist), so the returned
 * value is decoded through unescapeXml before being returned — a data dir
 * containing `&` is on disk as `&amp;` and this returns the literal `&`.
 *
 * Never logs plist contents — the plist embeds HDB_ADMIN_PASSWORD.
 */
export function readPlistRootPath(plistPath: string): string | null {
  try {
    const raw = readFileSync(plistPath, "utf-8");
    const m = raw.match(/<key>ROOTPATH<\/key>\s*<string>([^<]*)<\/string>/);
    return m ? unescapeXml(m[1]) : null;
  } catch {
    return null;
  }
}

export function assertLaunchdServiceOwnedBy(
  dataDir: string,
  label: string,
  plistPath: string,
  action: "stop" | "start",
): void {
  const declared = readPlistRootPath(plistPath);
  if (declared === null) return;
  if (resolve(declared) === resolve(dataDir)) return;

  throw new Error(
    `refusing to ${action} launchd service ${label}: its plist (${plistPath}) is registered to data directory ` +
      `${resolve(declared)}, not ${resolve(dataDir)} — that is a different Flair instance. ` +
      `Re-run with --data-dir ${resolve(declared)} to act on that one, or run ` +
      `'flair init --data-dir ${resolve(dataDir)}' to register a service for this one.`,
  );
}

// ─── flair service ────────────────────────────────────────────────────────────
// Command registration lives in src/commands/service.ts (flair#1636).
// Bind shared cli-locals first so the extracted module never imports this file.
bindServiceCli({
  buildDirectSpawnEnv,
  closedDirectSpawnEnv,
  defaultDataDir,
  ensureLaunchdServiceLoaded,
  flairPackageDir,
  gatherDaemonEvidence,
  guardEngineNotBackwards,
  harperBinNotFoundMessage,
  harperSearchRoots,
  observeLaunchdManagement,
  probeHealth,
  readyOpsSocketPosture,
  resolveHarperBin,
  resolveHttpBindHost,
  resolveHttpPort,
  resolveLaunchdLabel,
  resolveOpsBindHost,
  resolveOpsPort,
  restartFlair,
  stampEngineVersionIfRunning,
  waitForHealth,
  waitForProcessExit,
  writeDaemonSidecar,
  LEGACY_LAUNCHD_LABEL,
  STARTUP_TIMEOUT_MS,
});
registerService(program);

// ─── "is it still under launchd?" (flair#1022) ─────────────────────────────
//
// The pure logic lives in src/lib/launchd-management.ts; these two adapters
// are the only places that talk to real launchd or the real filesystem, so a
// test can exercise every branch above without either.

/** `launchctl list <label>`, capped so an unreachable launchd cannot hang the CLI. */
const realLaunchctlLister: LaunchctlLister = (label) => {
  const res = spawnSync("launchctl", ["list", label], {
    encoding: "utf-8",
    timeout: LAUNCHCTL_QUERY_TIMEOUT_MS,
  });
  return { code: res.status, stdout: res.stdout ?? "" };
};

/**
 * Which process is actually serving `dataDir` — Harper's own `hdb.pid` first,
 * then the listener on `port`.
 *
 * `hdb.pid` is written by the Harper process itself on every boot regardless
 * of who spawned it, which is exactly the property this needs: it is the same
 * number on the launchd path and on the direct-spawn fallback, so comparing it
 * against launchd's reported PID is a real comparison rather than a proxy.
 * The port listener is the backstop for an install whose PID file is missing;
 * `null` (neither available) is handled by the caller as "no evidence", never
 * as "detached".
 */
function resolveInstanceServingPid(dataDir: string, port: number): number | null {
  let listeningPids: number[] = [];
  try {
    listeningPids = listeningPidsOnPort(port, (cmd) => execSync(cmd, { encoding: "utf-8" }));
  } catch { /* lsof unavailable — the PID file may still answer */ }
  return pickInstancePid({
    pidFilePid: readHarperPid(dataDir),
    isAlive: isProcessAlive,
    listeningPids,
  });
}

/** Agent signing-key ids under `keysDir` — node-scoped federation keys excluded. */
function collectKeyAgentIds(keysDir: string): string[] {
  if (!existsSync(keysDir)) return [];
  try {
    const keyFiles = readdirSync(keysDir).filter((f) => f.endsWith(".key"));
    const { agentKeyIds } = partitionKeyIds(
      keyFiles.map((f) => f.replace(/\.key$/, "")),
      keysDir,
    );
    return agentKeyIds;
  } catch {
    return [];
  }
}

async function confirmYes(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const { createInterface } = await import("node:readline");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer: string = await new Promise((res) =>
    rl.question(question, (a) => { rl.close(); res(a); }),
  );
  return /^y(es)?$/i.test(answer.trim());
}

/**
 * flair#1439 — run the enumerable doctor catalog after upgrade's instance
 * probe, and offer a consented SessionStart-hook install when that check
 * fails. Silent writes are refused: `--install-hooks` or an interactive
 * yes is the only consent. The consent→write composition lives in
 * applyUpgradeHookConsent so tests can drive the path that actually
 * writes (or does not write) the hook file.
 *
 * Before the catalog run, `applyUpgradeMigrations` fires any version-keyed
 * migrations that are pending for the fromVersion→toVersion pair. These do
 * NOT require `--install-hooks` because the user already consented to the
 * affected integration when they ran `flair init` — the migration just
 * applies a new artifact that the old init could not have written.
 */
async function doctorRunAfterUpgrade(args: {
  management: LaunchdManagement;
  port: number;
  installHooksFlag: boolean;
  /** Previously installed version — null when unknown. */
  fromVersion: string | null;
  /** Newly installed (target) version — null when unknown. */
  toVersion: string | null;
}): Promise<DoctorRun> {
  const homeDir = resolveHome();
  const keysDir = defaultKeysDir();
  const detectedClientIds = detectClients().filter((c) => c.detected).map((c) => c.id);

  // ── Version-keyed upgrade migrations (flair#1439) ─────────────────────────
  // Apply any pending migrations BEFORE the doctor catalog run so that the
  // catalog sees the post-migration state (e.g. the hook is present, so the
  // session-start-hook check passes and the upgrade prints ✅ verified: healthy).
  const migCtx: UpgradeMigrationContext = {
    homeDir,
    port: args.port,
    detectedClientIds,
  };
  const migrations = applyUpgradeMigrations(args.fromVersion, args.toVersion, migCtx);
  for (const { results } of migrations.applied) {
    for (const r of results) {
      if (r.wrote) {
        console.log(`   ✓ ${r.message}`);
      } else if (!r.ok) {
        console.error(`   • ${r.message}`);
      }
      // Silently skip no-op (ok, !wrote) — nothing changed, nothing to say.
    }
  }
  if (!migrations.allOk) {
    // A migration reported a non-fatal issue (each is logged above). Say so
    // plainly rather than let the upcoming ✅ verified summary imply the upgrade
    // finished cleanly — the doctor catalog below reflects the real state.
    console.error(
      "   • one or more upgrade migrations did not complete cleanly — the doctor check below shows the current state.",
    );
  }

  const ctx = {
    homeDir,
    cwd: process.cwd(),
    detectedClientIds,
    launchd: args.management,
    keysDir,
    keyAgentIds: collectKeyAgentIds(keysDir),
  };
  const run = runDoctorChecks(ctx);
  const apply = (promptAccepted?: boolean) =>
    applyUpgradeHookConsent({
      homeDir,
      ctx,
      run,
      installHooksFlag: args.installHooksFlag,
      interactive: !!process.stdin.isTTY,
      promptAccepted,
      port: args.port,
    });

  let outcome = apply();
  if (outcome.consent === "prompt" && outcome.prompt) {
    console.log("");
    for (const line of outcome.prompt.preamble) console.log(`  ${line}`);
    outcome = apply(await confirmYes(outcome.prompt.question));
  }
  if (outcome.consent === "install") {
    for (const w of outcome.writes) {
      console.log(`   ${w.ok ? "✓" : "•"} ${w.message}`);
    }
  }
  if (outcome.consent === "skip-noninteractive") {
    for (const line of outcome.messages) {
      console.error(`   ${line}`);
    }
  }
  return outcome.run;
}

function printVerifiedSummary(summary: { degraded: boolean; lines: string[] }): void {
  for (const line of summary.lines) {
    if (summary.degraded) console.error(line); else console.log(line);
  }
}

/**
 * Observe whether `dataDir`'s instance is running under launchd right now.
 *
 * Called AFTER a restart completes, by both `flair restart` and `flair
 * upgrade` — see the module header for why this is an observation rather than
 * a flag carried out of `startFlairProcess` (the upgrade's restart may happen
 * in a child process, so no in-process flag survives).
 */
function observeLaunchdManagement(dataDir: string, port: number): LaunchdManagement {
  // Answered without touching the filesystem or lsof off darwin — this runs on
  // the success path of every restart and upgrade, including Linux's, where
  // there is no launchd to have fallen back from.
  if (process.platform !== "darwin") {
    return { state: "not-applicable", detail: `${process.platform} does not use launchd` };
  }
  const { label, plistPath } = resolveLaunchdLabel(dataDir);
  if (!existsSync(plistPath)) {
    return { state: "no-service", detail: `no launchd service is registered for this instance (${plistPath})` };
  }
  return assessLaunchdManagement({
    platform: process.platform,
    label,
    plistPath,
    instancePid: resolveInstanceServingPid(dataDir, port),
    plistExists: existsSync,
    list: realLaunchctlLister,
  });
}

// `preserveHttpPortValue` / `preserveSecurePort` / `bindHostOf` live in
// src/lib/http-bind.ts so the CLI's plist writer and the pure repair PLANNER
// (src/lib/launchd-repair.ts) share the exact same preservation rules, and the
// planner can refuse an unsupported configuration BEFORE the executor stops
// anything. Re-exported here for existing importers of this module.
export { preserveHttpPortValue, preserveSecurePort };

/**
 * Build the launchd plist for a `doctor --fix` repair (flair#1573 slice b).
 *
 * Deliberately DIVERGES from the `flair init` plist in one way that matters:
 * it always uses the pass-file (secret-free) mode, so the regenerated plist
 * never embeds HDB_ADMIN_PASSWORD inline — the exact regression this issue
 * exists to prevent. The ports and ROOTPATH come from the instance's own
 * harper-config.yaml (config authority, flair#914), never ~/.flair/config.yaml
 * or defaults, so the repair cannot re-bootstrap Harper against a different
 * directory or port.
 *
 * REPAIR IS AN EXPLICIT EXCEPTION TO "every bind goes through the
 * constructor". Credential repair promises not to move the instance's
 * coordinates (see the repair contract above this function), so it PRESERVES
 * the existing bind — host and port, in whatever form the instance recorded
 * them — rather than qualifying, narrowing or widening it. A bare legacy port
 * stays bare; an already-qualified `host:port` keeps its host; a wildcard TLS
 * listener with no intent marker is preserved as-is (changing it is migration's
 * job, not repair's). An unsupported (unparseable) or disabled value is
 * REFUSED rather than defaulted: substituting DEFAULT_PORT is itself a
 * coordinate change and would enable a plaintext listener on a TLS-only
 * instance.
 *
 * `config` is the parsed harper-config.yaml, already gated readable by the
 * caller. Throws when the Harper binary cannot be resolved — a plist pointing
 * at a missing binary is the stale-plist failure this repair must not write.
 */
export function buildRepairPlist(dataDir: string, config: Record<string, any>): string {
  const httpRaw = config?.http?.port;
  // Preserved verbatim (bare stays bare, qualified keeps its host). Throws for a
  // disabled or unparseable value — refuse rather than replace the plist.
  const httpBindValue = preserveHttpPortValue(httpRaw);
  const httpPort = harperPortValue(httpRaw)!;
  const opsPortRaw = config?.operationsApi?.network?.port;
  const opsPort = harperPortValue(opsPortRaw) ?? (httpPort - 1);
  const opsBind = detectOpsApiAllInterfacesBind(opsPortRaw);
  const opsBindHost = opsBind.boundHost ?? "127.0.0.1";
  const opsSocket = join(dataDir, "operations-server");
  // Preserve the config's exact ops-port form (host-qualified or bare) so the
  // regenerated plist neither re-narrows nor re-widens the bind — the
  // no-re-bootstrap guarantee is mechanical, not best-effort.
  const opsNetworkPort = typeof opsPortRaw === "string" && opsPortRaw.trim() !== ""
    ? opsPortRaw.trim()
    : opsNetworkPortValue(opsBindHost, opsPort);
  // TLS is preserved, never defaulted in and never enabled. The secure host
  // follows a "both or neither" rule with the plaintext bind: a secure value
  // that already names a host is preserved verbatim; a BARE secure value with a
  // BARE plaintext port is preserved bare too (repair moves neither — narrowing
  // TLS while plaintext stays wide would move a coordinate and drop LAN TLS
  // clients); and a bare secure value with a qualified plaintext bind is
  // qualified the same way as the plaintext host. A DISABLED secure listener
  // stays disabled (the key is not emitted).
  const httpSecureBind = qualifySecureBindValue(config?.http?.securePort, httpBindValue);
  const opsSecureBind = qualifySecureBindValue(config?.operationsApi?.network?.securePort, opsNetworkPort);
  const setConfig = JSON.stringify({
    rootPath: dataDir,
    http: {
      port: httpBindValue,
      cors: true,
      corsAccessList: httpCorsAccessList(httpPort),
      ...(httpSecureBind === undefined ? {} : { securePort: httpSecureBind }),
    },
    operationsApi: {
      network: {
        port: opsNetworkPort,
        cors: true,
        domainSocket: opsSocket,
        ...(opsSecureBind === undefined ? {} : { securePort: opsSecureBind }),
      },
    },
    mqtt: MQTT_DISABLED_CONFIG,
    localStudio: { enabled: false },
    authentication: { authorizeLocal: false, enableSessions: true },
  });
  const harperBinPath = harperBin();
  if (!harperBinPath) throw new Error(harperBinNotFoundMessage(harperSearchRoots()));
  const label = launchdLabel(dataDir);
  const modelsDir = process.env.FLAIR_MODELS_DIR ?? join(dataDir, "models");
  return buildLaunchdPlist({
    label,
    execPath: process.execPath,
    harperBinPath,
    workingDirectory: flairPackageDir(),
    dataDir,
    modelsDir,
    setConfig,
    adminUser: DEFAULT_ADMIN_USER,
    httpPort: httpBindValue,
    opsNetworkPort,
    passFile: {
      launcher: launchdLauncherPath(),
      adminPassFile: defaultAdminPassPath(),
      home: resolveHome(),
      path: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
    },
  });
}

/**
 * Resolve whether the pass-file launcher's argv is satisfiable (flair#1685),
 * WITHOUT touching the network or writing anything. Pure filesystem + env:
 *
 *   - an existing valid 0600 non-empty file  -> reuse, never rewrite
 *   - FLAIR_ADMIN_PASS / HDB_ADMIN_PASSWORD  -> a candidate the executor must
 *     prove against the live instance before it may write it
 *   - neither                                -> missing (refuse)
 *
 * An existing file that does not pass readSecretFileSecure (wrong mode, empty)
 * is reported missing rather than reused: the launcher re-checks the mode at
 * start time and would refuse the same file, so writing the plist around it
 * would reproduce #1685 one level down.
 */
function resolveAdminPassAvailability(path: string): AdminPassAvailability {
  if (existsSync(path)) {
    try {
      readAdminPassFileSecure(path);
      return { kind: "existing-valid" };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        kind: "missing",
        detail: `the admin-pass file at ${path} is unusable (${msg})`,
      };
    }
  }
  if (process.env.FLAIR_ADMIN_PASS || process.env.HDB_ADMIN_PASSWORD) {
    return { kind: "candidate", source: "env" };
  }
  return {
    kind: "missing",
    detail:
      `the admin-pass file at ${path} does not exist and no credential is available in the environment. ` +
      `Run 'flair init' to provision ${path}, or start the instance and re-run 'flair doctor --fix'.`,
  };
}

/**
 * Prove an admin credential belongs to the running instance before adoption
 * materializes it into the 0600 pass file (flair#1685). The admin-gated
 * /HealthDetail read is the proof: a rejected Basic credential produces 401 and
 * is NOT retried through the agent-key floor (that floor only engages when no
 * credential was sent at all), so success here means THIS credential was
 * accepted by THIS instance. Never logs the secret.
 */
async function proveAdminPassAgainstInstance(
  port: number,
  adminPass: string,
): Promise<string | null> {
  try {
    await api("GET", "/HealthDetail", undefined, {
      baseUrl: `http://127.0.0.1:${port}`,
      explicitAdminPass: adminPass,
    });
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * Validate the pass file against the launcher's OWN read contract before the
 * plist that names it is written (flair#1685): exists, readable, owner-only
 * (no group/other bits), non-empty. This is exactly the four checks
 * templates/launchd/start-flair-with-admin-pass.sh runs at start time; the
 * write side applies them so a plist is never written around a file the
 * launcher would refuse. Returns the problem, or null when the file is safe.
 */
function validateAdminPassFileForLauncher(path: string): string | null {
  try {
    readAdminPassFileSecure(path);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/** Options for `writeInitLaunchdPlist` — the launchd-plist step of `flair init`. */
export interface WriteInitLaunchdPlistOptions {
  dataDir: string;
  /** The label-scoped plist path resolved by the caller (launchdPlistPath). */
  plistPath: string;
  label: string;
  /** The credential `flair init` resolved in-hand (generated, --admin-pass, --admin-pass-file, or env). May be "". */
  adminPass: string;
  adminUser: string;
  modelsDir: string;
  execPath: string;
  harperBinPath: string;
  workingDirectory: string;
  httpPort: number | string;
  opsNetworkPort: string;
  setConfig: string;
  /** The HTTP port to prove an in-hand credential against the running instance. */
  port: number;
  /** Override of `defaultAdminPassPath()`; tests point this at a temp dir. */
  adminPassPath?: string;
  /**
   * Whether a live instance is available to prove the credential against.
   * Defaults to true; tests that do not prove pass false (or inject `prove`).
   */
  liveInstance?: boolean;
}

/** Dependencies `writeInitLaunchdPlist` accepts so tests need no real network. */
export interface WriteInitLaunchdPlistDeps {
  /** Prove a credential against the live instance; returns an error string, or null when proven. */
  prove?: (port: number, credential: string) => Promise<string | null>;
}

/**
 * The outcome of init's launchd-plist step.
 *
 * `unchanged` and `refused` both mean NO plist write happened: the first when
 * the instance is already adopted with the pass-file shape (flair#1693 — init
 * must not downgrade it, and re-writing would only churn the file), the second
 * when the launcher's argv cannot be satisfied (flair#1685).
 */
export type WriteInitLaunchdPlistResult =
  | { kind: "written"; plistPath: string }
  | { kind: "unchanged"; plistPath: string; detail: string }
  | { kind: "refused"; detail: string };

/**
 * Write the launchd plist for `flair init`, with the SAME credential discipline
 * as the `doctor --fix` arms (flair#1693, closing flair#1685's other half).
 *
 * The old `flair init` wrote an INLINE plist (ProgramArguments = [node,
 * harper.js, run, .] + HDB_ADMIN_PASSWORD in EnvironmentVariables) unconditionally,
 * which downgraded an instance already adopted into the flair#1573 pass-file
 * shape and put the admin password into a config file. This function removes
 * that path structurally (there is no inline branch left to call — `passFile`
 * is required on `LaunchdPlistOptions`) and makes the writer own its
 * precondition:
 *
 *   1. An on-disk plist that is provably ours IN THE PASS-FILE SHAPE is left
 *      byte-for-byte unchanged. An adopted instance is never downgraded, and a
 *      re-run of init does not churn mtime / flap launchd state.
 *   2. A plist that is provably another instance's (`foreign`) or cannot be
 *      attributed (`unattributable`) is refused, naming `flair doctor --fix`.
 *   3. Otherwise, resolve the pass file BEFORE writing anything: reuse an
 *      existing valid 0600 file; else prove the credential in hand against the
 *      running instance and write it 0600 atomically; else refuse with the
 *      file and the command named and write NO plist. Never a plist whose
 *      launcher argv cannot be satisfied.
 *
 * The proof uses the same authed `GET /HealthDetail` as the doctor arms (a
 * rejected Basic credential is a 401 and never falls through to the agent-key
 * floor), so a credential that does not belong to THIS instance is refused
 * rather than baked into a pass file the instance would reject.
 */
export async function writeInitLaunchdPlist(
  opts: WriteInitLaunchdPlistOptions,
  deps: WriteInitLaunchdPlistDeps = {},
): Promise<WriteInitLaunchdPlistResult> {
  const prove = deps.prove ?? proveAdminPassAgainstInstance;
  const adminPassPath = opts.adminPassPath ?? defaultAdminPassPath();

  // Already adopted: ours, pass-file shape -> leave the bytes alone (#1693).
  if (existsSync(opts.plistPath)) {
    let raw: string | null = null;
    try { raw = readFileSync(opts.plistPath, "utf-8"); } catch { raw = null; }
    if (raw !== null) {
      const disposition = classifyPlist(opts.plistPath, opts.dataDir, {
        exists: existsSync,
        read: () => raw,
        readRootPath: () => readPlistRootPath(opts.plistPath),
      });
      if (disposition === "foreign" || disposition === "unattributable") {
        return {
          kind: "refused",
          detail:
            `refusing to write the launchd plist at ${opts.plistPath}: ` +
            (disposition === "foreign"
              ? "it is registered to a different data directory, so it belongs to a different Flair instance."
              : "it has no ROOTPATH, so it cannot be proven to belong to this instance.") +
            " Run 'flair doctor --fix' to repair launchd management.",
        };
      }
      const refs = readPlistProgramRefs(opts.plistPath, () => raw as string);
      const launcherArg = refs?.programArguments[0] ?? "";
      const passFileShape =
        !plistCarriesInlineAdminPassword(raw) &&
        basename(launcherArg) === basename(launchdLauncherPath());
      if (disposition === "ours" && passFileShape) {
        return {
          kind: "unchanged",
          plistPath: opts.plistPath,
          detail:
            `the launchd service is already adopted with the pass-file launcher; leaving ${opts.plistPath} unchanged`,
        };
      }
    }
  }

  // Credential before plist (flair#1685): reuse an existing valid 0600 file,
  // else prove the in-hand credential against the live instance and write it
  // 0600, else refuse with no plist.
  if (resolveAdminPassAvailability(adminPassPath).kind !== "existing-valid") {
    const candidate =
      opts.adminPass || process.env.FLAIR_ADMIN_PASS || process.env.HDB_ADMIN_PASSWORD;
    if (!candidate) {
      return {
        kind: "refused",
        detail:
          `refusing to write the launchd plist: the admin-pass file at ${adminPassPath} does not exist and no ` +
          "admin credential is available to provision it. Set FLAIR_ADMIN_PASS or pass --admin-pass-file <path>, " +
          "then re-run 'flair init'.",
      };
    }
    if (opts.liveInstance !== false) {
      const proof = await prove(opts.port, candidate);
      if (proof) {
        return {
          kind: "refused",
          detail:
            "refusing to write the launchd plist: the admin credential does not authenticate against the running " +
            `instance (${proof}), so writing it to ${adminPassPath} would create a pass file the instance rejects. ` +
            "Run 'flair init' with the instance's current credential.",
        };
      }
    }
    writeAdminPassFile(adminPassPath, candidate);
  }

  const passFileProblem = validateAdminPassFileForLauncher(adminPassPath);
  if (passFileProblem) {
    return { kind: "refused", detail: `refusing to write the launchd plist: ${passFileProblem}` };
  }

  const plist = buildLaunchdPlist({
    label: opts.label,
    execPath: opts.execPath,
    harperBinPath: opts.harperBinPath,
    workingDirectory: opts.workingDirectory,
    dataDir: opts.dataDir,
    modelsDir: opts.modelsDir,
    setConfig: opts.setConfig,
    adminUser: opts.adminUser,
    httpPort: opts.httpPort,
    opsNetworkPort: opts.opsNetworkPort,
    passFile: {
      launcher: launchdLauncherPath(),
      adminPassFile: adminPassPath,
      home: resolveHome(),
      path: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
    },
  });
  // No secret is embedded (pass-file mode), so 0644 matches the doctor arm.
  writeFileAtomic(opts.plistPath, plist, 0o644);
  return { kind: "written", plistPath: opts.plistPath };
}

/**
 * Compute the launchd repair plan for `dataDir` (flair#1573 slice b) WITHOUT
 * executing it — the detect + classify + decide half. The doctor command uses
 * this for dry-run / non-`--fix` reporting; `repairLaunchdManagement` (below)
 * reuses it and then executes a `regenerate` or `adopt` plan.
 */
function planLaunchdRepairFor(dataDir: string, port: number): {
  plan: RepairPlan;
  plistPath: string;
  isLegacy: boolean;
  config: Record<string, any> | null;
} {
  // Config authority gate (flair#914): the whole fix is gated on the
  // instance's own harper-config.yaml being readable.
  const config = harperConfigPath(dataDir) ? readHarperConfig(dataDir) : null;
  const configReadable = config !== null;

  // Observe the current state.
  const observation = observeLaunchdManagement(dataDir, port);

  // Classify the plist disposition (ownership guard's first question).
  const { plistPath, isLegacy } = resolveLaunchdLabel(dataDir);
  const disposition = classifyPlist(plistPath, dataDir, {
    exists: existsSync,
    read: (p) => { try { return readFileSync(p, "utf-8"); } catch { return null; } },
    readRootPath: readPlistRootPath,
  });

  // Is a direct (non-launchd) process serving this instance right now?
  const instancePid = resolveInstanceServingPid(dataDir, port);
  const directProcessRunning = instancePid !== null && observation.state !== "managed";

  // Credential before plist (flair#1685): the plan may only authorize a
  // pass-file plist whose launcher argv is satisfiable.
  const adminPassPath = defaultAdminPassPath();
  const adminPass = resolveAdminPassAvailability(adminPassPath);

  const plan = planLaunchdRepair({
    observation,
    disposition,
    plistPath,
    directProcessRunning,
    configReadable,
    adminPassPath,
    adminPass,
    // Hand the instance's own bind values to the PLANNER so an unsupported one
    // (a disabled or unparseable http.port) refuses BEFORE the executor's adopt
    // arm clean-stops the live instance. Deciding this in the executor's writer
    // would bounce first and refuse after — leaving the instance down with a
    // remedy that re-runs this very command.
    configBindValues: config
      ? {
          httpPort: config.http?.port,
          httpSecurePort: config.http?.securePort,
          opsSecurePort: config.operationsApi?.network?.securePort,
        }
      : undefined,
  });
  return { plan, plistPath, isLegacy, config };
}

/**
 * Repair launchd management for `dataDir` (flair#1573 slice b) — the
 * `doctor --fix` launchd repair for a MISSING, CORRUPT, or DETACHED plist.
 *
 * detect -> (adopt: clean-stop the direct process) -> regenerate (pass-file
 * mode) -> load -> verify. The DECISION (state matrix + ownership guard +
 * config authority) lives in planLaunchdRepair (src/lib/launchd-repair.ts);
 * this is the EXECUTION, and it is the only place that touches the real
 * filesystem and launchctl.
 *
 * Reuses the existing primitives rather than re-inventing them:
 *   - observeLaunchdManagement / assessLaunchdManagement is the fail-loud
 *     verifier (launchctl PID AND that PID is the serving process).
 *   - ensureLaunchdServiceLoaded is the unload -> load -> start.
 *   - the five-state liveness machine (gatherDaemonEvidence +
 *     classifyDaemonState, flair#1454) attributes and clean-stops the direct
 *     process on the adopt path — never a foreign/recycled pid, never kill -9.
 *
 * The adopt path (flair#1573 slice b2) BOUNCES the live instance: it
 * clean-stops the direct-spawned process (SIGTERM + wait for exit), confirms
 * the port is free, then regenerates + loads. A foreign/unattributable direct
 * process is refused by the liveness machine (DISAGREEMENT/UNKNOWN), never
 * signalled.
 *
 * Credential before plist (flair#1685): the generated plist is always
 * pass-file mode, so its launcher cannot start unless ~/.flair/admin-pass
 * exists and is safe. An existing valid file is reused; an env credential is
 * PROVEN against the live instance (before the adopt bounce) and only then
 * written; nothing usable yields a refusal with no plist. The written file is
 * validated against the launcher's own read contract (exists, mode 0600,
 * non-empty) before load.
 *
 * Never reports success on a direct-start fallback: the final verify is
 * assessLaunchdManagement (launchctl PID AND that PID is the serving process),
 * and anything short of `managed` is a `failed` result with the detached detail
 * + remedy, never a silent pass. On the adopt arm the verify additionally
 * proves the serving pid CHANGED and the pre-adopt pid is dead, because port
 * health alone is answered by the old process (flair#1684/#1685). The whole
 * executor arm is wrapped in try/catch (Kern's b1 defect): a throw becomes a
 * named `failed` result (or an engine-backwards `refused`), never a crash
 * mid-report.
 */
async function repairLaunchdManagement(dataDir: string, port: number): Promise<LaunchdRepairResult> {
  const { plan, plistPath, isLegacy, config } = planLaunchdRepairFor(dataDir, port);

  switch (plan.kind) {
    case "no-op":
      return { kind: "no-op", reason: plan.reason, detail: plan.detail };
    case "refuse":
      return { kind: "refused", reason: plan.reason, detail: plan.detail, plistPath: plan.plistPath };
    case "adopt":
    case "regenerate": {
      try {
        // Guard FIRST (flair#1093): the repair is a boot path, and an older
        // engine opening a newer store fails at the storage layer minutes
        // later — same refusal as startFlairProcess. On the adopt arm this
        // must run BEFORE the stop: it is a pure read whose inputs don't
        // change during the repair, so guard-first refuses WITHOUT bouncing
        // the live instance (guard-after-stop would SIGTERM the instance and
        // then refuse, leaving it down with nothing to restart it).
        guardEngineNotBackwards(dataDir);
        // Credential before plist (flair#1685). Resolve and, when the plan says
        // the pass file must be materialized (an env candidate), PROVE the
        // credential against the live instance BEFORE the adopt bounce stops
        // it — then write the 0600 file. Refuse, with no plist and no bounce,
        // when nothing proves.
        const adminPassPath = defaultAdminPassPath();
        if (plan.credential.writeAdminPassFile) {
          const candidate = process.env.FLAIR_ADMIN_PASS ?? process.env.HDB_ADMIN_PASSWORD;
          if (!candidate) {
            return {
              kind: "refused",
              reason: "missing-credential",
              detail:
                `refusing to repair the launchd plist: ${adminPassPath} must be written from a credential, ` +
                "but no credential is available in the environment.",
              plistPath,
            };
          }
          const proof = await proveAdminPassAgainstInstance(port, candidate);
          if (proof) {
            return {
              kind: "refused",
              reason: "missing-credential",
              detail:
                "refusing to repair the launchd plist: the credential in FLAIR_ADMIN_PASS/HDB_ADMIN_PASSWORD " +
                `does not authenticate against the running instance (${proof}), so writing it to ` +
                `${adminPassPath} would create a pass file the instance rejects. Run 'flair init' to provision ` +
                "the correct credential.",
              plistPath,
            };
          }
          writeAdminPassFile(adminPassPath, candidate);
        }
        // Validate the pass file against the launcher's OWN read contract before
        // any plist names it: an existing file that drifted to 0644 must refuse
        // here, never be baked into a plist the launcher will reject at start.
        const passFileProblem = validateAdminPassFileForLauncher(adminPassPath);
        if (passFileProblem) {
          return {
            kind: "refused",
            reason: "missing-credential",
            detail: `refusing to repair the launchd plist: ${passFileProblem}`,
            plistPath,
          };
        }
        // Adopt (flair#1573 slice b2): capture the process serving the instance
        // NOW (before the stop), then clean-stop it, so the regenerate + load
        // below does not collide on the port. The captured pid is the evidence
        // the post-load verify uses to prove the serving pid CHANGED.
        let directPid: number | null = null;
        if (plan.kind === "adopt") {
          directPid = resolveInstanceServingPid(dataDir, port);
          const stop = await stopDirectProcessForAdopt(port, dataDir);
          if (stop) return stop; // a named failed result
        }
        const { execSync } = await import("node:child_process");
        // Regenerate the plist (pass-file mode) and write it atomically.
        // No secret is embedded, so 0644 is correct here.
        const plist = buildRepairPlist(dataDir, config!);
        const newPlistPath = launchdPlistPath(launchdLabel(dataDir));
        writeFileAtomic(newPlistPath, plist, 0o644);
        // Validate the plist's absolute paths BEFORE launchd load (flair#1685
        // hardening): launchctl load/start exit 0 for a job whose program is
        // missing, so a stale launcher or node path produces a job that never
        // starts — the same masked failure this repair exists to prevent.
        const stalePlistPath = diagnoseLaunchdPlistPaths(newPlistPath);
        if (stalePlistPath) {
          return { kind: "failed", detail: stalePlistPath.message, remedy: stalePlistPath.remedy };
        }
        // flair#1586 / #1581: a SET_CONFIG-less detach (MQTT_* via
        // buildDirectSpawnEnv) can persist mqtt.network as mtls, port,
        // securePort when Harper stored no originals for already-null ports.
        // Adopt SET_CONFIG updates those keys in place and would otherwise
        // leave harper-config.yaml not byte-identical to the first-repair
        // file (port, securePort, mtls). Reorder only those scalar lines
        // before launchd loads so the next persist matches the settled file.
        const cfgPath = harperConfigPath(dataDir);
        if (cfgPath) {
          const raw = readFileSync(cfgPath, "utf-8");
          const { text, changed } = stabilizeMqttNetworkKeyOrder(raw);
          if (changed) writeFileAtomic(cfgPath, text, 0o644);
        }
        // If the resolved plist was a pre-flair#693 legacy label, unload and
        // remove it so it is not orphaned beside the regenerated one.
        if (isLegacy && plistPath !== newPlistPath) {
          try { execSync(`launchctl unload "${plistPath}"`, { stdio: "pipe" }); } catch { /* best effort */ }
          try { unlinkSync(plistPath); } catch { /* best effort */ }
        }
        // Load (unload -> load -> start). Drop the pre-bounce leftover
        // socket first so exists() cannot be true on the dead inode —
        // Darwin #1704 (`9413a80`) chmod'd that leftover for 10s and
        // still read 0755 after Harper bind()d a new file.
        const bounceAt = Date.now();
        unlinkStaleOpsSocket(dataDir);
        ensureLaunchdServiceLoaded(dataDir, (cmd) => execSync(cmd, { stdio: "pipe" }));
        // Verify (fail-loud).
        const after = observeLaunchdManagement(dataDir, port);
        if (after.state !== "managed") {
          return { kind: "failed", detail: after.detail, remedy: after.remedy };
        }
        // On the adopt arm, port health alone is the green light that lied in
        // #1684: the pre-adopt direct process answered the port the whole time
        // the launchd job was failing to start. Prove the launchd job itself
        // serves — the old pid is dead, the serving pid changed, and it is
        // launchd's reported pid for this label.
        if (plan.kind === "adopt") {
          const label = after.label ?? resolveLaunchdLabel(dataDir).label;
          // flair#1827: poll — the launchd-started Harper may not have written
          // hdb.pid or bound the port yet. Wait for it to serve (and for the
          // pre-adopt process to be gone), THEN prove identity with
          // verifyAdoptServing UNCHANGED on the final observation.
          const waited = await verifyAdoptServingWithWait({
            observe: () => ({
              directPid,
              managedPid: readLaunchctlJobState(label, realLaunchctlLister).pid,
              servingPid: resolveInstanceServingPid(dataDir, port),
              directPidAlive: directPid !== null && isProcessAlive(directPid),
            }),
            deadlineMs: STARTUP_TIMEOUT_MS,
          });
          if (waited.proof) {
            return { kind: "failed", detail: waited.proof.detail, remedy: ["flair stop", "flair doctor --fix"] };
          }
        }
        // flair#1701: the launchd bounce (adopt and regenerate) is a first
        // start. The product launcher execs Harper and never chmods, so the
        // new operations-server lands at 0777 & ~umask. Init / start /
        // restart already call this after health; without it here, doctor
        // flags ✗ Ops socket permissions until a second start. Wait for
        // Harper's bind() (HTTP can answer first); ignore leftover mtimes
        // older than bounceAt.
        await readyOpsSocketPostureAfterStart(dataDir, { notBeforeMs: bounceAt });
        const detail = plan.kind === "adopt"
          ? `adopted the direct-spawned instance into launchd (bounced the live instance): ${after.detail}`
          : after.detail;
        return { kind: "repaired", detail };
      } catch (err) {
        return mapRepairThrow(err);
      }
    }
  }
}

/**
 * Clean-stop the direct (non-launchd) process serving `dataDir`+`port` for the
 * adopt path (flair#1573 slice b2). Returns a `failed` result when the process
 * cannot be attributed (never stop a foreign process) or the port is still
 * occupied after the stop; returns null when the port is free and the caller
 * should proceed to regenerate + load.
 *
 * Reuses the five-state liveness machine (flair#1454): identity is verified
 * (pidfile + sidecar + start time) before any signal, so a DISAGREEMENT/UNKNOWN
 * verdict refuses rather than gambling on a recycled pid. The stop is SIGTERM +
 * wait for exit — never kill -9.
 */
async function stopDirectProcessForAdopt(port: number, dataDir: string): Promise<LaunchdRepairResult | null> {
  const evidence = await gatherDaemonEvidence(port, dataDir);
  const state = classifyDaemonState(evidence, { port, dataDir });
  // SIGTERM + wait for exit for a verified live pid (RUNNING or WEDGED — a
  // wedged daemon is recovery, not a recycled-pid gamble).
  if (state.state === "RUNNING" || state.state === "WEDGED") {
    try { process.kill(state.pid, "SIGTERM"); } catch { /* already gone */ }
    try { await waitForProcessExit(state.pid, STARTUP_TIMEOUT_MS); } catch { /* best-effort — the port check below surfaces the real problem */ }
  }
  // flair#1827: poll the post-stop health until the port is provably free — a
  // single observation that caught the listener mid-release flaked with "port
  // not confirmed free". decideAdoptStop is UNCHANGED; it decides on the final
  // observation, and a timeout names the wait and the last probe.
  const decision = await decideAdoptStopWithWait(state, {
    observe: () => probeHealth(port),
    deadlineMs: STARTUP_TIMEOUT_MS,
  });
  if (decision.decision !== "proceed") return decision.decision;
  // Belt-and-suspenders: lsof confirms no TCP listener remains before the
  // caller loads the plist. probeHealth "refused" (ECONNREFUSED) already means
  // nothing is listening, but a port that is BOUND yet refuses connections
  // (backlog-full, or a non-HTTP listener) would still EADDRINUSE on load —
  // this catches that rare case the HTTP probe cannot see.
  const { execSync } = await import("node:child_process");
  const listeners = listeningPidsOnPort(port, (cmd) => execSync(cmd, { encoding: "utf-8" }));
  if (listeners.length > 0) {
    return {
      kind: "failed",
      detail: `port still occupied after stopping the direct process (listener pid ${listeners.join(", ")})`,
      remedy: ["flair stop", "flair doctor --fix"],
    };
  }
  return null;
}

/**
 * Stop the local Flair (Harper) process — launchd `stop` on darwin when a
 * plist is present (falling back on failure), otherwise a manual SIGTERM by
 * port. Split out of the old monolithic `restartFlair` (flair#637) so the
 * pre-upgrade snapshot can quiesce the data directory between a stop and a
 * start without duplicating this logic — `restartFlair` is now just
 * `stopFlairProcess` followed by `startFlairProcess`.
 *
 * `dataDir` is REQUIRED and names the instance to stop — it is not a
 * convenience parameter. It used to be resolved internally from
 * `defaultDataDir()`, which meant `flair snapshot create|restore --data-dir
 * <elsewhere>` stopped the DEFAULT instance and reported success
 * (flair#902). A port alone does not identify an instance to launchd; the
 * data dir does, via `resolveLaunchdLabel`.
 *
 * Idempotent-ish: stopping an already-stopped instance is a harmless no-op
 * on both paths (launchctl stop on an unloaded/idle service, or a
 * NOT_RUNNING classification from the liveness machine).
 *
 * Throws when the resolved target provably belongs to a different instance
 * — see assertLaunchdServiceOwnedBy, or a DISAGREEMENT/UNKNOWN verdict from
 * the liveness machine. Callers already treat a failed stop as fatal, which
 * is the point: refusing beats quiescing the wrong install.
 */
async function stopFlairProcess(port: number, dataDir: string): Promise<void> {
  if (process.platform === "darwin") {
    // resolveLaunchdLabel (flair#693) finds whichever label this data dir
    // is currently registered under (new instance-scoped, or a
    // pre-flair#693 legacy install) — stop only needs to operate on
    // whichever exists, no migration.
    const { label, plistPath } = resolveLaunchdLabel(dataDir);
    if (existsSync(plistPath)) {
      // Outside the try below: an ownership refusal must NOT degrade into
      // the port-based fallback, which would go on to signal by port the
      // very instance we just refused to touch.
      assertLaunchdServiceOwnedBy(dataDir, label, plistPath, "stop");
      try {
        const { execSync } = await import("node:child_process");
        // Capture the current PID *before* unloading so callers that
        // immediately restart can verify exit. Without this, waitForHealth
        // can race against the still-shutting-down old process and return
        // success before the new one comes up.
        const oldPid = readHarperPid(dataDir);
        // flair#1022: ask launchd whether the process we are about to wait on
        // is even its job's, BEFORE unloading. When the instance is already
        // running outside launchd — the state a previous fallback leaves
        // behind, and the state a stale plist guarantees — the unload has
        // nothing to signal, so waiting on `oldPid` burns the FULL startup
        // budget and then reports the meaningless
        // "Process <pid> did not exit within 60000ms". That was the first of
        // the reported incident's two 60-second hangs. The unload still runs
        // (a loaded-but-broken job must not be left able to respawn); only the
        // wait is skipped, and the fallback is entered immediately with a
        // reason that names the real condition.
        //
        // Gated on a LIVE recorded PID, and that gate is load-bearing: with no
        // running process there is nothing to wait for and nothing to
        // reattribute, and `stopFlairProcess` is documented as a harmless
        // no-op when the instance is already stopped. Without the gate, an
        // already-stopped instance takes the port fallback, which refuses when
        // it cannot attribute a listener (flair#915) — turning an idempotent
        // stop into a failed restart. Caught by the flair#902/#914 suites.
        //
        // Asked BEFORE the unload, because after it launchd no longer knows
        // the label at all and every answer would be "detached".
        const managed = oldPid !== null && isProcessAlive(oldPid)
          ? assessLaunchdManagement({
            platform: process.platform,
            label,
            plistPath,
            instancePid: oldPid,
            plistExists: existsSync,
            list: realLaunchctlLister,
          })
          : null;
        // unload stops the job AND prevents KeepAlive from respawning it.
        // launchctl stop alone is insufficient for a KeepAlive job (flair#874).
        try { execSync(`launchctl unload "${plistPath}"`, { stdio: "pipe" }); } catch {}
        if (managed && isDetached(managed)) {
          throw new Error(
            `launchd is not running this instance — ${managed.detail}`
            + `${managed.remedy?.length ? ` Fix it with: ${managed.remedy.join(" && ")}` : ""}`,
          );
        }
        if (oldPid) await waitForProcessExit(oldPid, STARTUP_TIMEOUT_MS);
        return;
      } catch (err: any) {
        console.error(`launchd stop failed, falling back to port-based stop: ${err.message}`);
      }
    }
  }

  // Port-based stop (Linux, or macOS fallback when no launchd plist) — the
  // five-state liveness machine (flair#1454). The old lsof-based tree is
  // REPLACED, not patched: `lsof` absence used to render as "not running", and
  // the pidfile was only consulted to attribute port-derived PIDs. Now the
  // pidfile + identity sidecar are the primary evidence, and the health probe
  // is a cross-check — never the verdict.
  console.log("Stopping...");
  const evidence = await gatherDaemonEvidence(port, dataDir);
  const state = classifyDaemonState(evidence, { port, dataDir });

  switch (state.state) {
    case "RUNNING":
    case "WEDGED": {
      // Identity is already proven for both — killing a wedged daemon is
      // recovery, not a recycled-PID gamble.
      const pid = state.pid;
      try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
      // flair#905 / lrf5: wait for the signalled process to actually exit. A
      // blind sleep is not a guarantee — Harper may be flushing RocksDB
      // WAL/MANIFEST, and the next start fails with a locked data directory if
      // the old process hasn't released it yet.
      try { await waitForProcessExit(pid, STARTUP_TIMEOUT_MS); } catch { /* best-effort — the next start will surface the real problem */ }
      return;
    }
    case "NOT_RUNNING":
      return; // idempotent no-op
    case "DISAGREEMENT":
    case "UNKNOWN":
      // Deliberately outside any catch: a refusal must reach the caller, not
      // be swallowed as "not running" and reported as a successful stop.
      throw new Error(`refusing to stop: ${state.detail}`);
  }
}

/**
 * Start the local Flair (Harper) process — launchd `start` on darwin when a
 * plist is present (falling back on failure), otherwise a direct spawn.
 * Counterpart to `stopFlairProcess`; see that function's doc comment.
 *
 * `dataDir` is REQUIRED for the same reason it is on `stopFlairProcess`
 * (flair#902): it, not the port, is what identifies the instance. This
 * function resolved it internally from `defaultDataDir()` too, so the
 * snapshot commands' restart leg brought the DEFAULT instance back up after
 * operating on a `--data-dir` elsewhere.
 */
/**
 * flair#1047's refusal, at the point every boot passes through (flair#1093).
 *
 * It used to live inline in the `start` command's action and nowhere else, so
 * `flair restart`, `flair upgrade` (which restarts by spawning the new CLI with
 * `restart`) and the snapshot paths all booted Harper without it. The guard
 * covered one of the doors, and not the one an ENGINE SWAP comes through — so
 * an upgrade across a storage-format boundary came back as a dead port and a
 * bare exit 1 instead of a refusal naming actor, state and remedy.
 *
 * These same two functions had already drifted once, on the spawn environment:
 * see the note above buildDirectSpawnEnv about `start` setting a host-qualified
 * OPERATIONSAPI_NETWORK_PORT while startFlairProcess set none, silently
 * re-widening the ops API on every restart. Same pair, same shape. This is why
 * the check is a single function called from both rather than a second copy.
 *
 * Throws rather than exiting: `start` wants its own framing and an exit code,
 * while restart/upgrade need the message to travel up as an error. Nothing here
 * decides how it is presented.
 */
function guardEngineNotBackwards(dataDir: string): void {
  const runningHarperVersion = readInstalledHarperVersion(flairPackageDir());
  // No readable engine version means nothing to compare — the pre-stamp case
  // checkEngineVersionBackwards already treats as "not backwards". Refusing here
  // would brick every install written before the stamp existed.
  if (!runningHarperVersion) return;
  const backwardsError = checkEngineVersionBackwards(dataDir, runningHarperVersion);
  if (!backwardsError) return;
  const err: any = new Error(backwardsError);
  err.engineBackwards = true;
  throw err;
}

async function startFlairProcess(port: number, dataDir: string): Promise<void> {
  // Before anything is spawned or launchd is touched: an older engine opening a
  // newer store fails at the storage layer with an error about compression
  // internals, minutes later and nowhere near the cause.
  guardEngineNotBackwards(dataDir);
  if (process.platform === "darwin") {
    // resolveLaunchdLabel (flair#693) finds whichever label this data dir
    // is currently registered under before we attempt anything.
    const { label, plistPath } = resolveLaunchdLabel(dataDir);
    if (existsSync(plistPath)) {
      // Same ownership gate as the stop path (flair#902), and outside the
      // try for the same reason: starting the wrong service would then wait
      // for health on `port`, see the OTHER instance answer, and report
      // success.
      assertLaunchdServiceOwnedBy(dataDir, label, plistPath, "start");
      try {
        // flair#1022: launchd will not tell us it cannot exec the job.
        // `launchctl load` and `launchctl start` BOTH exit 0 for a plist whose
        // ProgramArguments[0] does not exist (measured, see the module header),
        // so the only way this loop learns anything is by waiting the full
        // startup budget for a port that will never open — the reported
        // incident's second 60-second hang, ending in "did not respond within
        // 60000ms (120 attempts)", an error about a port that says nothing
        // about the cause. The paths in the plist are absolute and checkable
        // with an existsSync, so check them first and turn a two-minute silence
        // into an immediate, named diagnosis. Still falls back — a running
        // instance beats a down one — just without the wait or the mystery.
        const stalePlist = diagnoseLaunchdPlistPaths(plistPath);
        if (stalePlist) {
          throw new Error(`${stalePlist.message} Fix it with: ${stalePlist.remedy.join(" && ")}`);
        }
        const { execSync } = await import("node:child_process");
        ensureLaunchdServiceLoaded(dataDir, (cmd) => execSync(cmd, { stdio: "pipe" }));
        await waitForHealth(port, DEFAULT_ADMIN_USER, process.env.HDB_ADMIN_PASSWORD ?? "", STARTUP_TIMEOUT_MS);
        readyOpsSocketPosture(dataDir); // flair#763: re-assert socket posture across restart/upgrade
        stampEngineVersionIfRunning(dataDir); // flair#1047: stamp the store with the engine version
        return;
      } catch (err: any) {
        console.error(`launchd start failed, falling back to direct start: ${err.message}`);
      }
    }
  }

  console.log("Starting...");
  const harper = resolveHarperBin(harperSearchRoots());
  if (!harper.path) {
    throw new Error(harperBinNotFoundMessage(harper.searched));
  }
  const bin = harper.path;

  // Match `flair start`: accept either HDB_ADMIN_PASSWORD or FLAIR_ADMIN_PASS.
  // Without this, `flair init --admin-pass X` (which only exports HDB_*
  // to the initial Harper spawn) followed by `flair restart` would silently
  // drop admin credentials — any subsequent auth'd call returns 401.
  const adminPass = process.env.HDB_ADMIN_PASSWORD || process.env.FLAIR_ADMIN_PASS || "";
  // flair#863: the same env `flair start` builds, from the same builder — this
  // path sets no HARPER_SET_CONFIG, and Harper RESTORES the pre-SET_CONFIG
  // original for every key SET_CONFIG had forced whenever that variable is
  // absent (cleanupRemovedEnvVar; see opsNetworkPortValue). This site used to
  // set no OPERATIONSAPI_NETWORK_PORT at all, so every `flair restart` /
  // `flair upgrade` on the non-launchd path silently reverted
  // `operationsApi.network.port` to a bare number in harper-config.yaml and
  // re-bound the ops API to all interfaces — permanently, since the reverted
  // value is what the next boot reads. It also made doctor's
  // `flair init && flair restart` remedy a no-op: the restart undid whatever
  // init had just written.
  const env: Record<string, string> = closedDirectSpawnEnv(process.env, buildDirectSpawnEnv({
    dataDir,
    modelsDir: process.env.FLAIR_MODELS_DIR ?? join(dataDir, "models"),
    httpPort: port,
    httpBindHost: resolveHttpBindHost({}),
    opsPort: resolveOpsPort({ port }),
    opsBindHost: resolveOpsBindHost({}),
    adminUser: DEFAULT_ADMIN_USER,
    adminPass,
  }));

  const proc = spawn(process.execPath, [bin, "run", "."], {
    cwd: flairPackageDir(), env, detached: true, stdio: "ignore",
  });
  proc.unref();

  // Identity sidecar immediately after spawn (flair#1454 decision 3), before
  // waitForHealth so startTimeMs stays within the ±2s tolerance.
  if (proc.pid) writeDaemonSidecar(dataDir, proc.pid, port);

  await waitForHealth(port, DEFAULT_ADMIN_USER, adminPass, STARTUP_TIMEOUT_MS);
  readyOpsSocketPosture(dataDir); // flair#763: re-assert socket posture across restart/upgrade
  stampEngineVersionIfRunning(dataDir); // flair#1047: stamp the store with the engine version
}

/**
 * The ONE restart mechanism for a local Flair install. Shared by `flair
 * restart` and `flair upgrade`'s post-install restart step (flair#635) so
 * the two never drift into two different ways to bounce the same process.
 * Composed of `stopFlairProcess` + `startFlairProcess` (flair#637) — the
 * pre-upgrade snapshot step calls those two directly with a snapshot taken
 * in between, instead of going through this wrapper.
 *
 * Throws on failure instead of calling process.exit — callers decide how to
 * react (`flair restart` exits 1; `flair upgrade` treats a failed restart as
 * an upgrade failure and may attempt a rollback).
 *
 * Takes `dataDir` explicitly (flair#902) so the instance being bounced is
 * named at the call site rather than assumed from `defaultDataDir()` two
 * frames down.
 */
async function restartFlair(port: number, dataDir: string): Promise<void> {
  await stopFlairProcess(port, dataDir);
  await startFlairProcess(port, dataDir);
  // Bust the version-handshake cache so the next preAction nudge re-fetches
  // the LIVE version instead of the pre-restart cached one (the false
  // "server is running <old>" users hit for up to 60s post-upgrade+restart).
  // Same (rootPath, serverUrl) key the preAction hook computes (~line 2189)
  // — must match exactly, or this busts the wrong cache file. Deliberately
  // NOT `dataDir`: the key is whatever the preAction hook computed for THIS
  // process, and using the restarted instance's dir instead would bust a
  // different cache file (or none) and leave the stale entry in place.
  try {
    invalidateHandshakeCache(process.env.ROOTPATH ?? defaultDataDir(), `http://127.0.0.1:${port}`);
  } catch { /* best-effort — never fail a restart over cache cleanup */ }
}

/**
 * Locate the `dist/cli.js` of the flair package installed at `packageRoot`,
 * reading version identity off disk rather than trusting the running process.
 *
 * `packageRoot` is normally `flairPackageDir()` — and the subtlety worth being
 * explicit about is that this path was never the stale thing. An in-place
 * `npm install -g` replaces the CONTENTS of that directory, so post-swap it
 * holds the new version's files; it is the loaded JavaScript, not the path,
 * that is frozen at the old version. Reading package.json back and comparing
 * it against `expectVersion` is what turns "the path exists" into "the new
 * version is really there", and catches the case where npm reported success
 * but installed somewhere else entirely (a custom prefix, a shadowed global).
 */
export type InstalledFlairCli =
  | { ok: true; cliPath: string; version: string }
  | { ok: false; reason: string };

export function resolveInstalledFlairCli(
  packageRoot: string,
  expectVersion: string | null,
  deps: {
    exists?: (p: string) => boolean;
    read?: (p: string) => string;
  } = {},
): InstalledFlairCli {
  const exists = deps.exists ?? existsSync;
  const read = deps.read ?? ((p: string) => readFileSync(p, "utf-8"));
  const cliPath = join(packageRoot, "dist", "cli.js");
  if (!exists(cliPath)) return { ok: false, reason: `no dist/cli.js at ${cliPath}` };
  let version: string;
  try {
    version = (JSON.parse(read(join(packageRoot, "package.json"))) as { version?: string }).version ?? "";
  } catch (err: any) {
    return { ok: false, reason: `could not read ${join(packageRoot, "package.json")}: ${err?.message ?? err}` };
  }
  if (!version) return { ok: false, reason: `${join(packageRoot, "package.json")} declares no version` };
  if (expectVersion && version !== expectVersion) {
    return { ok: false, reason: `${packageRoot} holds ${version}, expected ${expectVersion}` };
  }
  return { ok: true, cliPath, version };
}

/**
 * Restart Flair after a package swap, through the newly installed CLI when one
 * could be located and in-process otherwise.
 *
 * The in-process fallback is deliberate and is NOT a silent one: it announces
 * which path it took and why. A missing/unverifiable new CLI means the swap
 * itself is suspect, and refusing to restart at all would turn a recoverable
 * upgrade into a guaranteed outage — but a fallback nobody can see in the
 * output is how "it restarted fine" and "it restarted with the wrong code"
 * become indistinguishable after the fact.
 *
 * Delegation is limited to the DEFAULT data directory, and that limit is not
 * incidental. The child is `flair restart`, which has no `--data-dir` and
 * therefore restarts `defaultDataDir()` — handing it a `dataDir` that is not
 * the default would restart a different instance and then wait for health on
 * `port` and watch the wrong one answer. That is flair#902 exactly, and the
 * required `dataDir` parameter here exists so the condition is checkable rather
 * than assumed. Today the upgrade path only ever operates on the default
 * install, so this never triggers; if that changes, `flair restart` needs a
 * `--data-dir` before this may delegate.
 *
 * Throws on failure; the caller owns the rollback decision. Returns whether the
 * restart was delegated, so the caller can leave the success line to whichever
 * process actually printed one.
 */
async function restartAfterUpgrade(
  port: number,
  dataDir: string,
  newCliArg: { cliPath: string; version: string } | null,
): Promise<boolean> {
  let newCli = newCliArg;
  if (newCli && resolve(dataDir) !== defaultDataDir()) {
    console.error(
      `warning: not delegating the restart to ${newCli.cliPath} — it would restart ${defaultDataDir()}, ` +
      `not ${resolve(dataDir)}. Restarting with this process's own code instead.`,
    );
    newCli = null;
  }
  if (!newCli) {
    await restartFlair(port, dataDir);
    return false;
  }
  console.log(`  (restarting via the newly installed CLI: ${newCli.cliPath} @ ${newCli.version})`);
  const { spawnSync } = await import("node:child_process");
  const res = spawnSync(process.execPath, [newCli.cliPath, "restart", "--port", String(port)], {
    encoding: "utf-8",
    // The child runs the same stop→start→waitForHealth sequence this process
    // would have; give it the full startup budget plus slack for the stop leg
    // rather than killing a restart that is merely slow.
    timeout: STARTUP_TIMEOUT_MS * 3,
    env: process.env,
  });
  if (res.stdout) process.stdout.write(res.stdout);
  if (res.stderr) process.stderr.write(res.stderr);
  if (res.error) {
    throw new Error(`could not run the newly installed CLI (${newCli.cliPath}): ${res.error.message}`);
  }
  if (res.status !== 0) {
    const detail = (res.stderr ?? "").trim().split("\n").filter(Boolean).pop();
    throw new Error(
      `the newly installed CLI (@tpsdev-ai/flair@${newCli.version}) failed to restart Flair` +
      `${res.signal ? ` (killed by ${res.signal})` : ` (exit ${res.status})`}` +
      `${detail ? `: ${detail}` : ""}`,
    );
  }
  return true;
}

// ─── flair uninstall ────────────────────────────────────────────────────────────
// Command registration lives in src/commands/uninstall.ts (flair#1636).
// Bind shared cli-locals first so the extracted module never imports this file.
bindUninstallCli({
  configPath,
  defaultDataDir,
  launchdLabel,
  launchdPlistPath,
  listeningPidsOnPort,
  readHarperPid,
  resolveHttpPort,
  LEGACY_LAUNCHD_LABEL,
});
registerUninstall(program);

// ─── flair reembed ────────────────────────────────────────────────────────────
// Command registration lives in src/commands/reembed.ts (flair#1636).
// Bind shared cli-locals first so the extracted module never imports this file.
bindReembedCli({
  privKeyPath,
  resolveHttpPort,
  resolveOpsPort,
});
registerReembed(program);

// ─── flair test ────────────────────────────────────────────────────────────
// Command registration lives in src/commands/test.ts (flair#1636).
// Bind shared cli-locals first so the extracted module never imports this file.
bindTestCli({
  api,
  resolveBaseUrl,
});
registerTest(program);

// ─── flair deploy ────────────────────────────────────────────────────────────
// Command registration lives in src/commands/deploy.ts (flair#1636).
// Bind shared cli-locals first so the extracted module never imports this file.
bindDeployCli({
  fleetSweepCallerExitMessage,
  resolveFabricCredentials,
  shouldRunFleetVerify,
});
registerDeploy(program);

// ─── flair fleet ──────────────────────────────────────────────────────────────
// Command group lives in src/commands/fleet.ts (flair#1624). Bind shared
// helpers first so the extracted module never imports this file.
bindFleetCli({
  resolveFabricCredentials,
});
registerFleet(program);

// ─── flair doctor ────────────────────────────────────────────────────────────
// Command registration lives in src/commands/doctor.ts (flair#1636).
// Bind shared cli-locals first so the extracted module never imports this file.
bindDoctorCli({
  api,
  checkAgentRegistered,
  classifyOpsSocketPosture,
  configPath,
  defaultDataDir,
  flairPackageDir,
  listeningPidsOnPort,
  persistDefaultInstallCoordinates,
  planLaunchdRepairFor,
  probeFlairReachable,
  readHarperConfig,
  readPortFromConfig,
  relativeTime,
  repairLaunchdManagement,
  resolveHttpPort,
  resolveOpsPort,
  verifyAuditLog,
  verifySemanticSearch,
  __pkgVersion,
});
registerDoctor(program);

// ─── flair quality ────────────────────────────────────────────────────────────
// Command registration lives in src/commands/quality.ts (flair#1636).
// Bind shared cli-locals first so the extracted module never imports this file.
bindQualityCli({
  api,
  fetchHealthDetail,
  publishOrgEvent,
  relativeTime,
  resolveSigningAgentId,
  __pkgVersion,
});
registerQuality(program);

// ─── flair session snapshot ──────────────────────────────────────────────────
// Command group lives in src/commands/session.ts (flair#1631). Bind shared
// helpers first so the extracted module never imports this file.
bindSessionCli({
  humanBytes,
  relativeTime,
  pkgVersion: __pkgVersion,
});
registerSession(program);


// ─── Memory and Soul commands ────────────────────────────────────────────────

// ─── --entities <csv> (flair#1288) ──────────────────────────────────────────
//
// Shared parse+validate for the `--entities <csv>` option on `memory add`,
// `workspace set`, and `orgevent`. Comma-delimited to match the existing CLI
// list-option convention (`--tags <csv>`, `--derived-from <csv>`); safe
// because no entity grammar admits a comma. Invalid input exits 1 with the
// canonical message — it names the offending values, the `type:value`
// format, and the closed type set (errors must enable a response; same hint
// the attention path's server-side invalid_entity 400 carries). The server
// still re-validates on every write path (resources/entity-vocab.ts via
// Memory/WorkspaceState/OrgEvent) — this client-side gate exists so a typo
// is caught before any signing/network work, with a message a raw 400 body
// never matched.
function parseEntitiesOptionOrExit(csv: string): string[] {
  const { entities, invalid } = parseEntitiesCsv(csv);
  if (invalid.length > 0) {
    console.error(`error: invalid --entities value${invalid.length === 1 ? "" : "s"}: ${invalid.join(", ")}`);
    console.error(`  ${entityFormatHint()}`);
    process.exit(1);
  }
  return entities;
}

const ENTITIES_OPTION_DESCRIPTION =
  "Comma-separated entity vocabulary strings this record touches (type:value from the closed type set, e.g. repo:tpsdev-ai/flair — see docs/entity-vocabulary.md; feeds `flair attention`)";

// ─── flair memory ────────────────────────────────────────────────────────────
// Command group lives in src/commands/memory.ts (flair#1621). Bind shared
// helpers first so the extracted module never imports this file.
bindMemoryCli({
  api,
  resolveBaseUrl,
  resolveSigningAgentId,
  applyAdminPassFile,
  addSharedCredentialOptions,
  addSharedIdentityOption,
  resolveOpsPort,
  parseEntitiesOptionOrExit,
  ENTITIES_OPTION_DESCRIPTION,
});
registerMemory(program);

// ─── flair search ────────────────────────────────────────────────────────────
// Command registration lives in src/commands/search.ts (flair#1636).
// Bind shared cli-locals first so the extracted module never imports this file.
bindSearchCli({
  resolveBaseUrl,
  resolveSigningAgentId,
});
registerSearch(program);

// ─── flair bootstrap ────────────────────────────────────────────────────────────
// Command registration lives in src/commands/bootstrap.ts (flair#1636).
// Bind shared cli-locals first so the extracted module never imports this file.
bindBootstrapCli({
  resolveBaseUrl,
  resolveSigningAgentId,
});
registerBootstrap(program);

// ─── flair relationship ──────────────────────────────────────────────────────
// Command group lives in src/commands/relationship.ts (flair#1634). Bind shared
// helpers first so the extracted module never imports this file.
bindRelationshipCli({
  api,
  resolveSigningAgentId,
});
registerRelationship(program);


// ─── flair soul ──────────────────────────────────────────────────────────────
// Command group lives in src/commands/soul.ts (flair#1622). Bind shared
// helpers first so the extracted module never imports this file.
bindSoulCli({
  api,
  resolveSigningAgentId,
  applyAdminPassFile,
  addSharedCredentialOptions,
});
registerSoul(program);

// ─── flair bridge ────────────────────────────────────────────────────────────
// Command group lives in src/commands/bridge.ts (flair#1628). Bind shared helpers
// first so the extracted module never imports this file.
bindBridgeCli({
  api,
  resolveHttpPort,
});
registerBridge(program);


// ─── flair backup ────────────────────────────────────────────────────────────
// Command registration lives in src/commands/backup.ts (flair#1636).
// Bind shared cli-locals first so the extracted module never imports this file.
bindBackupCli({
  addSharedCredentialOptions,
  applyAdminPassFile,
  resolveHttpPort,
});
registerBackup(program);

// ─── flair restore ────────────────────────────────────────────────────────────
// Command registration lives in src/commands/restore.ts (flair#1636).
// Bind shared cli-locals first so the extracted module never imports this file.
bindRestoreCli({
  resolveHttpPort,
});
registerRestore(program);

// ─── flair export ────────────────────────────────────────────────────────────
// Command registration lives in src/commands/export.ts (flair#1636).
// Bind shared cli-locals first so the extracted module never imports this file.
bindExportCli({
  privKeyPath,
  resolveHttpPort,
});
registerExport(program);

// ─── flair import ────────────────────────────────────────────────────────────
// Command registration lives in src/commands/import.ts (flair#1636).
// Bind shared cli-locals first so the extracted module never imports this file.
bindImportCli({
  b64url,
  privKeyPath,
  resolveEffectiveOpsUrl,
  resolveHttpPort,
  resolveOpsPort,
  seedAgentViaOpsApi,
});
registerImport(program);

// ─── flair inspect ────────────────────────────────────────────────────────────
// Command registration lives in src/commands/inspect.ts (flair#1636).
registerInspect(program);

// ─── flair migrate ────────────────────────────────────────────────────────────
// Command registration lives in src/commands/migrate-harness-memory.ts (flair#1636).
// Bind shared cli-locals first so the extracted module never imports this file.
bindMigrateHarnessMemoryCli({
  resolveHttpPort,
});
registerMigrateHarnessMemory(program);

// ─── flair presence ─────────────────────────────────────────────────────────
// Command group lives in src/commands/presence.ts (flair#1633). Bind shared
// helpers first so the extracted module never imports this file.
bindPresenceCli({
  resolveBaseUrl,
  resolveSigningAgentId,
});
registerPresence(program);


// ─── flair workspace ─────────────────────────────────────────────────────────
// Command group lives in src/commands/workspace.ts (flair#1635). Bind shared
// helpers first so the extracted module never imports this file.
bindWorkspaceCli({
  resolveBaseUrl,
  resolveSigningAgentId,
  parseEntitiesOptionOrExit,
  ENTITIES_OPTION_DESCRIPTION,
});
registerWorkspace(program);


// ─── flair orgevent ────────────────────────────────────────────────────────────
// Command registration lives in src/commands/orgevent.ts (flair#1636).
// Bind shared cli-locals first so the extracted module never imports this file.
bindOrgeventCli({
  parseEntitiesOptionOrExit,
  resolveBaseUrl,
  resolveSigningAgentId,
  ENTITIES_OPTION_DESCRIPTION,
});
registerOrgevent(program);

// ─── flair attention ────────────────────────────────────────────────────────────
// Command registration lives in src/commands/attention.ts (flair#1636).
// Bind shared cli-locals first so the extracted module never imports this file.
bindAttentionCli({
  resolveBaseUrl,
  resolveSigningAgentId,
});
registerAttention(program);

// Parse argv and run the CLI. Exported so the CommonJS preflight shim
// (cli-shim.cts → dist/cli-shim.cjs, the real bin entry) can invoke it after
// its Node-version check passes. The shim imports this module, so import.meta.main
// is false there — without this explicit entry point the CLI would load but never run.
async function runCli(): Promise<void> {
  // flair#1134 — npm ≥12 blocks install scripts by default, so the
  // postinstall PATH warning cannot fire there; the first thing of ours
  // that executes is this CLI, reached via npx / absolute path / a PATH
  // fixed-for-one-shell. Spawn-free (prefix derived from this file's own
  // location), validated (the derived bin dir must really hold flair),
  // TTY-gated (no per-run noise for automation), and skipped for `doctor`,
  // which prints the full finding itself. Must never break the CLI.
  if (process.argv[2] !== "doctor") {
    try {
      const banner = cliBootPathWarning({
        packageDir: resolve(dirname(fileURLToPath(import.meta.url)), ".."),
        pathEnv: process.env.PATH,
        shell: process.env.SHELL,
        stderrIsTTY: process.stderr.isTTY === true,
      });
      if (banner) console.error(banner);
    } catch { /* a diagnostic must never take down the CLI */ }
  }
  // A bare `flair` (no command) is a help request, not a usage error — show
  // help and exit 0, rather than commander's default (help + exit 1). Flags
  // like -h/--help/-v have argv beyond the binary and fall through to
  // commander, which already exits 0 for them.
  if (process.argv.length <= 2) {
    program.outputHelp();
    process.exit(0);
  }
  try {
    await program.parseAsync();
  } catch (err: any) {
    // Errors the API layer already translated (flair#1719) carry a sentence
    // naming the actor, state and remedy; print it without the undici stack.
    if (err && typeof err === "object" && err.flairFriendly === true) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
}

// Run CLI directly when this file is the entry point — covers `node dist/cli.js`,
// `bun src/cli.ts`, and the test harness (which spawns src/cli.ts under bun).
// The packaged bin goes through cli-shim.cjs → runCli() instead.
if (import.meta.main) {
  await runCli();
}

// ─── Exported for testing ─────────────────────────────────────────────────────
export { classifyKeysDir, applyKeyPrune } from "./commands/keys.js";
export type { KeysPruneEntry, KeysPruneResult } from "./commands/keys.js";

export {
  runFederationSyncOnce,
  persistLocalPeerLastSyncAt,
  runFederationWatch,
  federationStatusUrlSetting,
  describeFederationStatusFetchFailed,
  isFederationStatusConnectFailure,
  rewriteFederationStatusFetchFailed,
  isFederationStatusAuthFailure,
  isFederationStatusAuthRemedy,
};

export {
  describeFederationPairHubAccessError,
  describeFederationPairLocalAccessError,
  rewriteFederationPairHubAccessError,
  rewriteFederationPairLocalAccessError,
};

export {
  categorizeForHygiene,
  HYGIENE_TEST_CONTENT_PATTERNS,
};
export type { HygieneRow, HygieneCategory, HygieneOptions } from "./commands/memory.js";

export {
  formatCandidateLine,
  describeReflectError,
  validatePromoteOpts,
  validateRejectOpts,
  decideCandidateAction,
  derivePromotedTags,
  derivePromotedVisibility,
  validateHumanReviewerId,
  isMachineReviewerId,
  ADK_SCOPE_TAG_PREFIX,
  CONTINUITY_SCOPE_TAG_PREFIX,
  MACHINE_REVIEWER_PREFIX,
  MACHINE_REVIEWER_ADK_AUTO_PROMOTE,
} from "./commands/rem.js";
export type { SourceMemoryFetch, PromotedTagsDecision } from "./commands/rem.js";

export {
  grantMcpClient,
  revokeMcpClient,
  readMcpClientManifest,
  buildMcpGrantConfig,
  defaultMcpClientManifestPath,
  McpClientNameExistsError,
  McpClientAgentIdCollisionError,
  McpClientNotFoundError,
} from "./commands/mcp.js";
export type {
  McpClientManifestEntry,
  McpGrantParams,
  McpGrantDeps,
  McpGrantResult,
  McpRevokeParams,
  McpRevokeDeps,
} from "./commands/mcp.js";

export {
  runCli,
  resolveKeyPath,
  buildEd25519Auth,
  readPortFromConfig,
  readOpsBindFromConfig,
  readOpsPortFromConfig,
  writeConfig,
  resolveHttpPort,
  resolveOpsPort,
  resolveOpsBindHost,

  // Harper's own config — the per-instance port record (flair#914)
  harperConfigPath,
  readHarperConfig,
  readPortFromHarperConfig,
  persistDefaultInstallCoordinates,

  resolveTarget,
  resolveOpsTarget,
  resolveEffectiveOpsUrl,
  resolveOpsUrlFromTarget,
  FABRIC_OPS_PORT,
  signRequestBody,
  b64,
  b64url,
  program,
  api,
  VALID_PRESENCE_ACTIVITIES,
  MAX_TASK_LENGTH,
  MAX_WORKSPACE_FIELD_LENGTH,
  MAX_ORGEVENT_SUMMARY_LENGTH,
  MAX_ORGEVENT_DETAIL_LENGTH,

  isLocalBase,
  isLikelyRealSecret,
  shouldShowInlineSecretWarning,
  parseTokenFromFile,
  resolveLocalAdminPass,
  readAdminPassFileSecure,
  DEFAULT_ADMIN_USER,
  resolveAdminUser,

  // launchd label (flair#693)
  LEGACY_LAUNCHD_LABEL,
  launchdLabel,
  launchdPlistPath,
  cleanupLegacyLaunchdPlist,
  resolveLaunchdLabel,
  migrateLegacyLaunchdLabel,
  ensureLaunchdServiceLoaded,

  // launchd management observation (flair#1022)
  observeLaunchdManagement,
  resolveInstanceServingPid,
};

// Shared with `flair status` via src/lib/ops-api-bind.ts (flair#852).
export { detectOpsApiAllInterfacesBind };


export { searchScoringFormula, buildSearchExplain, formatSearchExplain } from "./commands/search.js";
export type { SearchScoringMode, SearchExplain } from "./commands/search.js";
export { isLocalhostUrl, discoverLocalFlairPort } from "./commands/status.js";
export { createDataSnapshot, pruneOldSnapshots, decideUpgradeSnapshotAction, UPGRADE_SNAPSHOT_NUDGE_LINES } from "./commands/upgrade.js";
export type { UpgradeSnapshotDecision } from "./commands/upgrade.js";
export { summarizeDoctorRun } from "./commands/doctor.js";
export { QUALITY_QUIET_THRESHOLD_DAYS, QUALITY_HASH_FALLBACK_DEGRADED_PCT, QUALITY_RECALL_SAMPLE_SIZE, QUALITY_RECALL_K, QUALITY_MEMORY_LIST_SELECT, QUALITY_RECALL_SNAPSHOT_OVERFETCH, qualityRecallSamplePath, qualitySnapshotLookupPath, isDiscriminativeSubject, deriveRecallCue, computeRecallSpotCheck, planRecallSpotCheck, computeQualityReport, fetchRecallSpotCheckData, QUALITY_EVENT_COVERAGE_ABS_THRESHOLD_PCT, QUALITY_EVENT_COVERAGE_DROP_THRESHOLD_PCT, QUALITY_EVENT_STALENESS_ABS_THRESHOLD_PCT, QUALITY_EVENT_RECALL_DROP_THRESHOLD, QUALITY_EVENT_DEDUP_GROWTH_PCT_THRESHOLD, QUALITY_EVENT_DEDUP_GROWTH_ABS_THRESHOLD, buildQualitySnapshot, diffQualitySnapshots, qualitySnapshotSubject, fetchPreviousQualitySnapshot } from "./commands/quality.js";
export type { QualityApi, QualityMetricGap, RecallSpotCheckScore, RecallSpotCheckFetchResult, RecallSampleHealth, RecallSpotCheckPlan, QualityAgentActivity, QualityReport, QualitySnapshotCore, QualityEventKind, QualityEventFinding } from "./commands/quality.js";