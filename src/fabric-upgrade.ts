/**
 * fabric-upgrade.ts — `flair upgrade --target <fabric-url>`
 *
 * One-command upgrade of a Flair instance already DEPLOYED to a Harper Fabric
 * cluster (as opposed to a local `flair upgrade`, which upgrades the globally
 * installed npm packages on the current host).
 *
 * Why this exists — the manual dance it replaces:
 *   Upgrading a deployed Fabric Flair used to require, by hand:
 *     1. mkdir a fresh temp dir
 *     2. write a package.json that depends on @tpsdev-ai/flair@<version> AND
 *        carries an `overrides` block pinning harper to a fixed
 *        version — because the PUBLISHED flair declares an OLD Harper
 *        (harper@5.0.21 as of flair@0.14.0) whose component
 *        packager (`packageComponent`) emits an EMPTY tarball when the package
 *        root lives under node_modules (the real npm-install scenario).
 *        See flair#513 — fixed in Harper >= 5.1.13.
 *     3. npm install
 *     4. run `flair deploy --target <url>` from that temp dir
 *   This module bakes the Harper pin in so the whole thing is one command.
 *
 * `deploy()` (src/deploy.ts) is REUSED verbatim for the packaging + spawn of
 * the bundled Harper's `harper deploy` — this module never reimplements deploy.
 * It only: resolves the target version, prepares a clean temp deployable with
 * the Harper override baked in, confirms the resolved Harper bin is the fix
 * version, then hands the temp package root to deploy() via `packageRoot`.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { createRegistryNoticePrinter, fetchDeclaredDependencies, fetchLatestVersion } from "./lib/npm-registry.js";
import type { DeployOptions, DeployResult } from "./deploy.js";
import { endpointHostRefusal, explicitEndpoint } from "./lib/ops-url.js";
import { assertSafeUrl, safeUrl } from "./mqtt-off-deploy.js";

/**
 * Minimum harper version whose component packager works when the
 * package root is under node_modules (flair#513 — the empty-tarball fix landed
 * in 5.1.13). Anything below this MUST be overridden before a Fabric deploy.
 */
export const MIN_HARPER_VERSION = "5.1.13";
/** One wait before a second post-deploy /Health read when the first semver is older than the deploy. */
const POST_DEPLOY_VERSION_REREAD_MS = 250;

/**
 * Version we pin Harper to when an override is needed and `--harper-version`
 * isn't given and we can't resolve the registry's latest. Known-good, ships the
 * packageComponent fix. 5.1.14 is the latest published as of this writing.
 */
export const DEFAULT_HARPER_PIN = "5.1.14";

const FLAIR_PKG = "@tpsdev-ai/flair";
const HARPER_PKG = "harper";
/**
 * flair#870 renamed flair's Harper dependency from the scoped
 * `@harperfast/harper` to the BARE `harper` name (permanent lockstep publishes
 * of the same source; bare is upstream's primary public name).
 *
 * This module reads and rewrites the dependency graph of a PUBLISHED flair
 * version, which may predate that rename — so every lookup here has to accept
 * either name. The bare name is always preferred when both are present.
 */
const LEGACY_HARPER_PKG = "@harperfast/harper";
const HARPER_PKG_NAMES = [HARPER_PKG, LEGACY_HARPER_PKG] as const;

/**
 * Parse "5.1.14" / "5.1.14-rc.1" / "v0.14.0" into [major, minor, patch],
 * ignoring any pre-release / build suffix for comparison. Returns null when the
 * core can't be parsed as three numeric segments.
 */
export function parseSemverCore(v: string): [number, number, number] | null {
  if (!v) return null;
  const core = v.trim().replace(/^v/, "").split("-")[0].split("+")[0];
  const parts = core.split(".");
  if (parts.length < 3) return null;
  const nums = parts.slice(0, 3).map((p) => Number(p));
  if (nums.some((n) => !Number.isFinite(n))) return null;
  return [nums[0], nums[1], nums[2]];
}

/** True when `a` >= `b` by numeric major.minor.patch (pre-release ignored). */
export function semverGte(a: string, b: string): boolean {
  const pa = parseSemverCore(a);
  const pb = parseSemverCore(b);
  if (!pa || !pb) return false;
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return true;
    if (pa[i] < pb[i]) return false;
  }
  return true; // equal
}

export interface HarperPinDecision {
  /** The Harper version the deployable's package.json should resolve. */
  pin: string;
  /** Whether we had to add an `overrides` entry (declared was too old / absent). */
  overridden: boolean;
  /** The version the published flair package declared (for reporting). */
  declared: string | null;
  /** Human-readable reason the decision was made. */
  reason: string;
}

/**
 * Decide what (if any) harper override to bake into the temp
 * deployable's package.json.
 *
 *   - If flair already declares Harper >= MIN_HARPER_VERSION → no override
 *     needed; keep what it ships (pin = declared).
 *   - Otherwise (declared is older, absent, or unparseable) → override to
 *     `preferredPin` (caller passes --harper-version, else registry latest,
 *     else DEFAULT_HARPER_PIN). We still require the chosen pin to satisfy
 *     MIN_HARPER_VERSION, falling back to DEFAULT_HARPER_PIN if the caller
 *     passed something too old.
 *
 * Pure — no I/O. The LOAD-BEARING bit is `overridden`: when true, the temp
 * package.json gets `overrides: { "harper": pin }`.
 */
export function resolveHarperPin(
  declared: string | null,
  preferredPin?: string,
): HarperPinDecision {
  if (declared && semverGte(declared, MIN_HARPER_VERSION)) {
    return {
      pin: declared,
      overridden: false,
      declared,
      reason: `flair declares ${HARPER_PKG}@${declared} (>= ${MIN_HARPER_VERSION}); no override needed`,
    };
  }

  // Need an override. Choose the pin: prefer the caller's, but never below the
  // fix floor — a stale --harper-version would silently reintroduce flair#513.
  let pin = preferredPin && semverGte(preferredPin, MIN_HARPER_VERSION)
    ? preferredPin
    : DEFAULT_HARPER_PIN;

  const declaredLabel = declared ? `${declared}` : "none";
  const tooOldHint = preferredPin && !semverGte(preferredPin, MIN_HARPER_VERSION)
    ? ` (requested ${preferredPin} is below the ${MIN_HARPER_VERSION} fix floor — using ${pin} instead)`
    : "";
  return {
    pin,
    overridden: true,
    declared,
    reason: `flair declares ${HARPER_PKG}@${declaredLabel} (< ${MIN_HARPER_VERSION}, flair#513 empty-tarball) — pinning to ${pin}${tooOldHint}`,
  };
}

/**
 * Build the package.json contents for the temp deployable. Depends on
 * @tpsdev-ai/flair@<version> and, when the Harper pin is an override, carries
 * the `overrides` block that forces npm to install the fix Harper under the
 * flair package's node_modules.
 *
 * The override is written under BOTH Harper package names (flair#870). Only
 * flair versions OLDER than the rename ever need an override — MIN_HARPER_VERSION
 * is 5.1.13 and every post-rename flair declares ≥ 5.1.22 — and those declare
 * the scoped name, so dropping the legacy key would make the override a silent
 * no-op exactly when it matters. Both are plain VERSION overrides, not `npm:`
 * aliases; an override key that matches nothing in the tree is inert.
 */
export function buildDeployablePackageJson(
  flairVersion: string,
  pin: HarperPinDecision,
): Record<string, unknown> {
  const pkg: Record<string, unknown> = {
    name: "flair-fabric-upgrade-stage",
    version: "0.0.0",
    private: true,
    dependencies: {
      [FLAIR_PKG]: flairVersion,
    },
  };
  if (pin.overridden) {
    pkg.overrides = Object.fromEntries(HARPER_PKG_NAMES.map((n) => [n, pin.pin]));
  }
  return pkg;
}

// ─── Injectable seams (so tests don't hit npm / the network) ────────────────

export interface FabricUpgradeDeps {
  /** Fetch the latest published version of @tpsdev-ai/flair from the registry. */
  fetchLatestFlairVersion: () => Promise<string>;
  /**
   * Read the harper version that @tpsdev-ai/flair@<version>
   * DECLARES (its package.json `dependencies`). Used to decide overrides
   * without a full install.
   */
  fetchDeclaredHarperVersion: (flairVersion: string) => Promise<string | null>;
  /**
   * Install the prepared package.json into `dir` (runs npm install). Resolves
   * once node_modules is populated.
   */
  npmInstall: (dir: string) => void;
  /**
   * Query the application endpoint for the version of the deployed `project`
   * component. The default implementation throws when the probe fails, the
   * body is empty or unreadable, or the version is not a semver. Before
   * deploy the body needs boolean `ok` and a semver. After deploy it needs
   * the strict Flair `/Health` body. An injected implementation may return
   * null; after `deploy_component`, null is an unverified version.
   */
  fetchDeployedVersion: (opts: {
    url: string;
    project: string;
    fabricUser?: string;
    fabricPassword?: string;
    /** True when the caller passed --application-endpoint. */
    applicationEndpointNamed?: boolean;
    /** Pre-deploy accepts ok plus a semver. Post-deploy requires the strict body. */
    healthShape?: "pre-deploy" | "post-deploy";
  }) => Promise<string | null>;
  /** The real deploy() — reused, never reimplemented. */
  deploy: (opts: DeployOptions) => Promise<DeployResult>;
  /** Sink for progress lines (defaults to console.log). */
  log?: (msg: string) => void;
}

export interface FabricUpgradeOptions {
  target: string;
  project?: string;
  version?: string; // explicit flair version; default = latest published
  harperVersion?: string; // explicit Harper pin; default = registry latest / DEFAULT_HARPER_PIN
  fabricUser?: string;
  fabricPassword?: string;
  check?: boolean; // plan only, do not deploy
  restart?: boolean;
  replicated?: boolean;
  /** `--keep-mqtt-config`: deploy() leaves the target's MQTT configuration as it is (DeployOptions.keepMqttConfig). */
  keepMqttConfig?: boolean;
  /** `--no-verify` (`false`): deploy() skips its served-API verification and its post-restart MQTT step (DeployOptions.verify). */
  verify?: boolean;
  /** The target's operations API URL for deploy()'s MQTT-off configuration, restart and read-back (DeployOptions.opsUrl). */
  opsUrl?: string;
  /** Operations endpoint for deploy_component. Unset: `target`. */
  operationsEndpoint?: string;
  /** Application endpoint for migration, discovery, verification, and the version probe. Unset: `target`. */
  applicationEndpoint?: string;
  /**
   * flair#878: these were reachable from `flair deploy` but NOT from
   * `flair upgrade --target` — this module built its deploy() options by hand
   * and simply omitted them. So when harper's own error said "pass
   * ignore_replication_errors: true", there was no way to do that through the
   * upgrade path, and `--deploy-retries` was likewise unreachable (upgrades
   * silently ran on deploy()'s default). Both are threaded through now, along
   * with the convergence-poll knobs.
   */
  ignoreReplicationErrors?: boolean;
  deployRetries?: number;
  convergenceCheck?: boolean;
  convergenceTimeoutMs?: number;
}

export interface FabricUpgradePlan {
  target: string;
  project: string;
  targetVersion: string;
  currentVersion: string | null;
  harper: HarperPinDecision;
  /** Whether the deployed version already equals the target (a no-op upgrade). */
  upToDate: boolean;
}

export interface FabricUpgradeResult {
  plan: FabricUpgradePlan;
  deployed: boolean;
  /** Version reported by the Fabric AFTER the deploy (verification). null if unverifiable. */
  verifiedVersion: string | null;
  /** Temp staging dir that was used + cleaned up (for logging/debug). */
  stagingDir: string;
  /** Origin-only deploy accepted via --ignore-replication-errors (see DeployResult). */
  replicationWarning?: boolean;
  /**
   * flair#878: harper reported a peer-replication failure and the per-node
   * component-tree comparison then showed every peer had converged. The upgrade
   * succeeded; this is surfaced so the CLI says so rather than hiding it.
   */
  convergedAfterReplicationError?: boolean;
}

// ─── Default (real) dependency implementations ──────────────────────────────

// flair#1692: one printer per process, so a Fabric upgrade names the registry
// (and source) it stages from without repeating the line per lookup.
const noticeRegistry = createRegistryNoticePrinter();

async function defaultFetchLatestFlairVersion(): Promise<string> {
  // flair#1688: the configured registry (scoped `@tpsdev-ai:registry`,
  // project/user/global .npmrc, env `npm_config_registry`), not a hardcoded
  // host — a Fabric upgrade must stage the package from the mirror the
  // operator configured, or fail rather than silently use the public one.
  // flair#1692: the value is validated as strict semver before it is used as
  // `dependencies` in the staged package.json (npm accepts `pkg@<url>` as a
  // remote-tarball spec, so an unvalidated value is an arbitrary-install
  // primitive).
  const result = await fetchLatestVersion(FLAIR_PKG, { timeoutMs: 10_000, onRegistry: noticeRegistry });
  if (result.kind === "ok") return result.version;
  if (result.kind === "refused") throw new Error(result.message);
  if (result.kind === "invalid") {
    throw new Error(
      `npm registry returned a non-semver latest version (${JSON.stringify(result.value)}) for ${FLAIR_PKG} ` +
        `from ${result.registry.url} (source: ${result.registry.source}) — refusing to use it`,
    );
  }
  throw new Error(`Could not determine ${FLAIR_PKG}/latest: ${result.message}`);
}

async function defaultFetchDeclaredHarperVersion(
  flairVersion: string,
): Promise<string | null> {
  const result = await fetchDeclaredDependencies(FLAIR_PKG, flairVersion, {
    timeoutMs: 10_000,
    onRegistry: noticeRegistry,
  });
  if (result.kind === "refused") {
    console.error(result.message);
    return null;
  }
  if (result.kind !== "ok") return null;
  // Either package name (flair#870) — pre-rename flair versions declare the
  // scoped one, and those are precisely the versions that may need an override.
  for (const name of HARPER_PKG_NAMES) {
    const declared = result.dependencies?.[name];
    if (declared) return declared;
  }
  return null;
}

function defaultNpmInstall(dir: string): void {
  // No package spec on argv — npm reads dependencies + overrides from the
  // package.json we wrote into `dir`. --omit=dev keeps the stage lean;
  // --no-audit/--no-fund cut noise. Output streamed for operator visibility.
  const r = spawnSync(
    "npm",
    ["install", "--omit=dev", "--no-audit", "--no-fund"],
    { cwd: dir, stdio: "inherit" },
  );
  if (r.error) throw r.error;
  if (r.status !== 0) {
    throw new Error(`npm install failed in staging dir (exit ${r.status})`);
  }
}

export class VersionProbeError extends Error {
  constructor(
    readonly healthUrl: string,
    readonly why: string,
  ) {
    super(
      `Could not read the deployed Flair version from ${healthUrl}: ${why}. ` +
        `This command stops. ` +
        `Retry when GET ${healthUrl} returns JSON with a boolean status field and a semver version.`,
    );
    this.name = "VersionProbeError";
  }
}

function versionProbeError(
  healthUrl: string,
  why: string,
  applicationEndpointNamed: boolean,
  healthShape: "pre-deploy" | "post-deploy",
): VersionProbeError {
  const err = new VersionProbeError(healthUrl, why);
  if (healthShape === "post-deploy") {
    err.message = err.message.replace(
      "JSON with a boolean status field and a semver version.",
      "a Flair /Health body whose version is a semver.",
    );
  }
  if (!applicationEndpointNamed) {
    err.message += " Pass --application-endpoint <application-url> when that URL is not the application endpoint.";
  }
  return err;
}

/**
 * Read the running Flair version from the application endpoint's `/Health`.
 * A failed request, an empty or unreadable body, or a version that is not a
 * semver throws. Before deploy, the body needs boolean `ok` and a semver
 * `version`, `flairVersion`, or `flair.version`. After deploy, it needs the
 * strict Flair body (`ok`, `searchReady`, `buildCommit`, and that semver).
 * It does not return null for any of those.
 */
export async function readDeployedFlairVersion(opts: {
  url: string;
  project: string;
  fabricUser?: string;
  fabricPassword?: string;
  applicationEndpointNamed?: boolean;
  /** Pre-deploy accepts ok plus a semver. Post-deploy requires the strict body. Defaults to post-deploy. */
  healthShape?: "pre-deploy" | "post-deploy";
}): Promise<string> {
  const base = opts.url.replace(/\/$/, "");
  const healthUrl = `${base}/Health`;
  const healthShape = opts.healthShape ?? "post-deploy";
  const headers: Record<string, string> = {};
  if (opts.fabricUser && opts.fabricPassword) {
    const auth = Buffer.from(`${opts.fabricUser}:${opts.fabricPassword}`).toString("base64");
    headers.Authorization = `Basic ${auth}`;
  }
  let res: Response;
  try {
    res = await fetch(healthUrl, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err: any) {
    throw versionProbeError(healthUrl, `the request failed (${err?.message ?? err})`, opts.applicationEndpointNamed === true, healthShape);
  }
  if (!res.ok) throw versionProbeError(healthUrl, `HTTP ${res.status}`, opts.applicationEndpointNamed === true, healthShape);
  let text: string;
  try {
    text = await res.text();
  } catch (err: any) {
    throw versionProbeError(healthUrl, `the body could not be read (${err?.message ?? err})`, opts.applicationEndpointNamed === true, healthShape);
  }
  if (text.trim() === "") throw versionProbeError(healthUrl, "the body was empty", opts.applicationEndpointNamed === true, healthShape);
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    throw versionProbeError(healthUrl, "the body was not JSON", opts.applicationEndpointNamed === true, healthShape);
  }
  const version = healthVersionString(body);
  const named = opts.applicationEndpointNamed === true;
  if (typeof version === "string" && version.trim() !== "" && parseSemverCore(version) === null) {
    throw versionProbeError(healthUrl, "the version string is not a semver", named, healthShape);
  }
  if (healthShape === "pre-deploy") {
    if (!preDeployHealthBody(body, version)) {
      throw versionProbeError(healthUrl, "the JSON has no boolean ok and semver version", named, healthShape);
    }
  } else if (!flairHealthBody(body, version)) {
    throw versionProbeError(healthUrl, "the JSON is not a Flair /Health body", named, healthShape);
  }
  return version as string;
}

/** `version`, `flairVersion`, or `flair.version` when that field is a string. */
function healthVersionString(body: unknown): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const doc = body as Record<string, unknown>;
  const direct = doc.version ?? doc.flairVersion;
  if (typeof direct === "string") return direct;
  const nested = doc.flair;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    const nestedVersion = (nested as Record<string, unknown>).version;
    if (typeof nestedVersion === "string") return nestedVersion;
  }
  return null;
}

/** Before deploy: boolean `ok` and a semver version. Older `/Health` bodies have `ok` and no `searchReady` or `buildCommit`. */
function preDeployHealthBody(body: unknown, version: string | null): boolean {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  if (typeof version !== "string" || parseSemverCore(version) === null) return false;
  return typeof (body as Record<string, unknown>).ok === "boolean";
}

/** After deploy: boolean `ok`, boolean `searchReady`, `buildCommit` string or null, and a semver version. */
function flairHealthBody(body: unknown, version: string | null): boolean {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  if (typeof version !== "string" || parseSemverCore(version) === null) return false;
  const doc = body as Record<string, unknown>;
  if (typeof doc.ok !== "boolean" || typeof doc.searchReady !== "boolean") return false;
  if (!Object.prototype.hasOwnProperty.call(doc, "buildCommit")) return false;
  return doc.buildCommit === null || typeof doc.buildCommit === "string";
}

function applicationUrlOf(opts: { target: string; applicationEndpoint?: string }): string {
  return explicitEndpoint(opts.applicationEndpoint) ?? opts.target;
}

function operationsUrlOf(opts: { target: string; operationsEndpoint?: string }): string {
  return explicitEndpoint(opts.operationsEndpoint) ?? opts.target;
}

/**
 * Resolve the harper bin that npm installed under the staged flair.
 *
 * Probes both Harper package names (flair#870): the staged flair may be a
 * pre-rename published version whose Harper landed under `@harperfast/harper`.
 */
export function resolveStagedHarperVersion(stagingDir: string): string | null {
  const candidates: string[] = [];
  for (const name of HARPER_PKG_NAMES) {
    // Nested under the staged flair…
    candidates.push(
      join(stagingDir, "node_modules", FLAIR_PKG, "node_modules", name, "package.json"),
    );
    // …or hoisted: npm dedupes, and with an override the fixed Harper may sit
    // at the staging root rather than nest under flair. Check both.
    candidates.push(join(stagingDir, "node_modules", name, "package.json"));
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      try {
        const pkg = JSON.parse(readFileSync(candidate, "utf8"));
        if (typeof pkg.version === "string") return pkg.version;
      } catch {
        /* try next */
      }
    }
  }
  // Last resort: resolve through the staged flair's module graph.
  const flairPkg = join(stagingDir, "node_modules", FLAIR_PKG, "package.json");
  for (const name of HARPER_PKG_NAMES) {
    try {
      const req = createRequire(flairPkg);
      const resolved = req.resolve(`${name}/package.json`);
      const pkg = JSON.parse(readFileSync(resolved, "utf8"));
      if (typeof pkg.version === "string") return pkg.version;
    } catch {
      /* try the next package name */
    }
  }
  return null;
}

/** Locate the staged @tpsdev-ai/flair package root (the deploy() packageRoot). */
export function resolveStagedFlairRoot(stagingDir: string): string {
  const root = join(stagingDir, "node_modules", FLAIR_PKG);
  if (!existsSync(join(root, "package.json"))) {
    throw new Error(
      `Staged flair not found at ${root} — npm install may have failed`,
    );
  }
  return root;
}

function defaultDeps(): FabricUpgradeDeps {
  // deploy is imported lazily so unit tests can fully mock without pulling the
  // real Harper-spawning module into their graph.
  return {
    fetchLatestFlairVersion: defaultFetchLatestFlairVersion,
    fetchDeclaredHarperVersion: defaultFetchDeclaredHarperVersion,
    npmInstall: defaultNpmInstall,
    fetchDeployedVersion: readDeployedFlairVersion,
    deploy: async (opts) => {
      const { deploy } = await import("./deploy.js");
      return deploy(opts);
    },
    log: (m: string) => console.log(m),
  };
}

// ─── Orchestrator ───────────────────────────────────────────────────────────

/**
 * Build the upgrade plan (steps 1 + version diff). Pure-ish: only the two
 * read-only registry lookups, no install, no deploy. `--check` stops here.
 */
export async function planFabricUpgrade(
  opts: FabricUpgradeOptions,
  deps: FabricUpgradeDeps,
): Promise<FabricUpgradePlan> {
  const project = opts.project ?? "flair";
  const targetVersion = opts.version ?? (await deps.fetchLatestFlairVersion());
  const declaredHarper = await deps.fetchDeclaredHarperVersion(targetVersion);
  const harper = resolveHarperPin(declaredHarper, opts.harperVersion);
  const currentVersion = await deps.fetchDeployedVersion({
    url: applicationUrlOf(opts),
    project,
    applicationEndpointNamed: explicitEndpoint(opts.applicationEndpoint) !== undefined,
    fabricUser: opts.fabricUser,
    fabricPassword: opts.fabricPassword,
    healthShape: "pre-deploy",
  });
  const upToDate =
    currentVersion != null &&
    parseSemverCore(currentVersion) != null &&
    parseSemverCore(targetVersion) != null &&
    semverGte(currentVersion, targetVersion) &&
    semverGte(targetVersion, currentVersion);

  return { target: opts.target, project, targetVersion, currentVersion, harper, upToDate };
}

/**
 * Full Fabric upgrade. Reuses deploy() for the packaging/deploy — this function
 * only prepares the clean temp deployable (with the Harper override baked in)
 * and verifies afterward.
 *
 * SAFETY: never logs creds; always cleans up the staging dir (finally); never
 * touches the running local Flair — all work happens in an isolated temp dir
 * and the deploy targets the remote Fabric URL only.
 */
export async function fabricUpgrade(
  opts: FabricUpgradeOptions,
  injected?: Partial<FabricUpgradeDeps>,
): Promise<FabricUpgradeResult> {
  const deps: FabricUpgradeDeps = { ...defaultDeps(), ...injected };
  const log = deps.log ?? (() => {});
  // Every URL the upgrade uses has an allowed scheme and a host, and is
  // scheme, host, port and path only; anything else is refused before
  // anything is fetched or printed.
  assertSafeUrl(opts.target, "deploy target URL");
  const operationsUrl = operationsUrlOf(opts);
  const applicationUrl = applicationUrlOf(opts);
  assertSafeUrl(operationsUrl, "operations endpoint");
  assertSafeUrl(applicationUrl, "application endpoint");
  if (opts.opsUrl !== undefined) assertSafeUrl(opts.opsUrl, "operations API URL");
  const hostRefusal = endpointHostRefusal("flair upgrade", operationsUrl, applicationUrl);
  if (hostRefusal) throw new Error(hostRefusal);

  // Step 1 + diff.
  const plan = await planFabricUpgrade(opts, deps);

  log(`Fabric:  ${safeUrl(plan.target)}`);
  log(`Project: ${plan.project}`);
  log(
    `Version: ${plan.currentVersion ?? "(unknown)"} → ${plan.targetVersion}` +
      (plan.upToDate ? "  (already up to date)" : ""),
  );
  log(`Harper:  ${plan.harper.reason}`);

  if (opts.check) {
    log("");
    log("--check: plan only — not deploying.");
    return { plan, deployed: false, verifiedVersion: null, stagingDir: "" };
  }

  // Step 2: prepare a clean deployable in an isolated temp dir.
  const stagingDir = mkdtempSync(join(tmpdir(), "flair-fabric-upgrade-"));
  try {
    const pkgJson = buildDeployablePackageJson(plan.targetVersion, plan.harper);
    writeFileSync(
      join(stagingDir, "package.json"),
      JSON.stringify(pkgJson, null, 2),
    );
    log(`\nStaging ${FLAIR_PKG}@${plan.targetVersion} in ${stagingDir} ...`);
    deps.npmInstall(stagingDir);

    // CONFIRM the resolved Harper bin is the fix version before deploying.
    const stagedHarper = resolveStagedHarperVersion(stagingDir);
    if (!stagedHarper) {
      throw new Error(
        `Could not resolve the staged ${HARPER_PKG} version — refusing to deploy ` +
          `(packageComponent may emit an empty tarball, flair#513).`,
      );
    }
    if (!semverGte(stagedHarper, MIN_HARPER_VERSION)) {
      throw new Error(
        `Staged ${HARPER_PKG}@${stagedHarper} is below the ${MIN_HARPER_VERSION} ` +
          `fix floor — the override did not take. Refusing to deploy (flair#513).`,
      );
    }
    log(`✓ Staged ${HARPER_PKG}@${stagedHarper} (>= ${MIN_HARPER_VERSION})`);

    const packageRoot = resolveStagedFlairRoot(stagingDir);

    // Step 3: REUSE deploy() — do not reimplement packaging/spawn.
    log(`Deploying ${plan.project} ${plan.targetVersion} to ${safeUrl(operationsUrl)} ...`);
    const result = await deps.deploy({
      target: opts.target,
      operationsEndpoint: explicitEndpoint(opts.operationsEndpoint),
      applicationEndpoint: explicitEndpoint(opts.applicationEndpoint),
      project: plan.project,
      version: plan.targetVersion,
      fabricUser: opts.fabricUser,
      fabricPassword: opts.fabricPassword,
      restart: opts.restart,
      verify: opts.verify,
      replicated: opts.replicated,
      keepMqttConfig: opts.keepMqttConfig,
      opsUrl: opts.opsUrl,
      packageRoot,
      // flair#878 — see FabricUpgradeOptions: these used to stop at this
      // boundary, which is why the upgrade path could not act on harper's own
      // "pass ignore_replication_errors: true" advice.
      ignoreReplicationErrors: opts.ignoreReplicationErrors,
      deployRetries: opts.deployRetries,
      convergenceCheck: opts.convergenceCheck,
      convergenceTimeoutMs: opts.convergenceTimeoutMs,
      onProgress: (m: string) => log(`  ${m}`),
    });

    // Step 4: read the deployed version from the application endpoint.
    // deploy_component has already been sent. A failed probe is unverified,
    // not a claim that the deploy did not happen.
    let verifiedVersion: string | null;
    try {
      verifiedVersion = await deps.fetchDeployedVersion({
        url: applicationUrl,
        project: plan.project,
        fabricUser: opts.fabricUser,
        fabricPassword: opts.fabricPassword,
        applicationEndpointNamed: explicitEndpoint(opts.applicationEndpoint) !== undefined,
        healthShape: "post-deploy",
      });
    } catch (err) {
      const why = err instanceof VersionProbeError ? err.why : (err instanceof Error ? err.message : String(err));
      const healthUrl = err instanceof VersionProbeError
        ? err.healthUrl
        : `${applicationUrl.replace(/\/$/, "")}/Health`;
      throw new Error(
        `deploy_component was sent to ${safeUrl(operationsUrl)}. The running version is unverified: ${why}. Check GET ${healthUrl}.`,
      );
    }
    const healthUrl = `${applicationUrl.replace(/\/$/, "")}/Health`;
    // A restarting node can briefly serve the previous build. Read once more
    // before treating an older semver as unverified.
    if (verifiedVersion && parseSemverCore(verifiedVersion) !== null && !semverGte(verifiedVersion, plan.targetVersion)) {
      await new Promise((resolve) => setTimeout(resolve, POST_DEPLOY_VERSION_REREAD_MS));
      try {
        verifiedVersion = await deps.fetchDeployedVersion({
          url: applicationUrl,
          project: plan.project,
          fabricUser: opts.fabricUser,
          fabricPassword: opts.fabricPassword,
          applicationEndpointNamed: explicitEndpoint(opts.applicationEndpoint) !== undefined,
          healthShape: "post-deploy",
        });
      } catch (err) {
        const why = err instanceof VersionProbeError ? err.why : (err instanceof Error ? err.message : String(err));
        throw new Error(
          `deploy_component was sent to ${safeUrl(operationsUrl)}. The running version is unverified: ${why}. Check GET ${healthUrl}.`,
        );
      }
    }
    const unverified = !verifiedVersion
      ? "no version string was returned"
      : parseSemverCore(verifiedVersion) === null
        ? "the version string is not a semver"
        : semverGte(verifiedVersion, plan.targetVersion)
          ? null
          : `reported ${verifiedVersion}, which is older than ${plan.targetVersion}`;
    if (unverified) {
      throw new Error(
        `deploy_component was sent to ${safeUrl(operationsUrl)}. The running version is unverified: ${unverified}. Check GET ${healthUrl}.`,
      );
    }
    log(`✓ Fabric now reports Flair ${verifiedVersion}`);

    return {
      plan,
      deployed: true,
      verifiedVersion,
      stagingDir,
      replicationWarning: result.replicationWarning,
      convergedAfterReplicationError: result.convergedAfterReplicationError,
    };
  } finally {
    // SAFETY: always clean up the temp dir.
    rmSync(stagingDir, { recursive: true, force: true });
  }
}
