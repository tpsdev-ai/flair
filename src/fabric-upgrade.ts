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
 *        carries an `overrides` block pinning @harperfast/harper to a fixed
 *        version — because the PUBLISHED flair declares an OLD Harper
 *        (@harperfast/harper@5.0.21 as of flair@0.14.0) whose component
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
import type { DeployOptions, DeployResult } from "./deploy.js";

/**
 * Minimum @harperfast/harper version whose component packager works when the
 * package root is under node_modules (flair#513 — the empty-tarball fix landed
 * in 5.1.13). Anything below this MUST be overridden before a Fabric deploy.
 */
export const MIN_HARPER_VERSION = "5.1.13";

/**
 * Version we pin Harper to when an override is needed and `--harper-version`
 * isn't given and we can't resolve the registry's latest. Known-good, ships the
 * packageComponent fix. 5.1.14 is the latest published as of this writing.
 */
export const DEFAULT_HARPER_PIN = "5.1.14";

const FLAIR_PKG = "@tpsdev-ai/flair";
const HARPER_PKG = "@harperfast/harper";

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
 * Decide what (if any) @harperfast/harper override to bake into the temp
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
 * package.json gets `overrides: { "@harperfast/harper": pin }`.
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
    pkg.overrides = { [HARPER_PKG]: pin.pin };
  }
  return pkg;
}

// ─── Injectable seams (so tests don't hit npm / the network) ────────────────

export interface FabricUpgradeDeps {
  /** Fetch the latest published version of @tpsdev-ai/flair from the registry. */
  fetchLatestFlairVersion: () => Promise<string>;
  /**
   * Read the @harperfast/harper version that @tpsdev-ai/flair@<version>
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
   * Query the live Fabric for the version of the deployed `project` component.
   * Returns null when it can't be determined (older Fabric, network, etc.).
   */
  fetchDeployedVersion: (opts: {
    url: string;
    project: string;
    fabricUser?: string;
    fabricPassword?: string;
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
}

// ─── Default (real) dependency implementations ──────────────────────────────

const REGISTRY = "https://registry.npmjs.org";

async function defaultFetchLatestFlairVersion(): Promise<string> {
  const res = await fetch(`${REGISTRY}/${FLAIR_PKG}/latest`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`npm registry returned ${res.status} for ${FLAIR_PKG}/latest`);
  }
  const data = (await res.json()) as { version?: string };
  if (!data.version) throw new Error(`No version in registry response for ${FLAIR_PKG}`);
  return data.version;
}

async function defaultFetchDeclaredHarperVersion(
  flairVersion: string,
): Promise<string | null> {
  const res = await fetch(`${REGISTRY}/${FLAIR_PKG}/${flairVersion}`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as {
    dependencies?: Record<string, string>;
  };
  return data.dependencies?.[HARPER_PKG] ?? null;
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

/**
 * Query the Fabric for the deployed Flair component version. Best-effort: the
 * public REST surface exposes `/Health`, which echoes the running Flair version
 * in newer builds; if the shape isn't recognized we return null (verification
 * downgrades to a soft notice, never a hard failure).
 */
async function defaultFetchDeployedVersion(opts: {
  url: string;
  project: string;
  fabricUser?: string;
  fabricPassword?: string;
}): Promise<string | null> {
  const base = opts.url.replace(/\/$/, "");
  const headers: Record<string, string> = {};
  if (opts.fabricUser && opts.fabricPassword) {
    const auth = Buffer.from(`${opts.fabricUser}:${opts.fabricPassword}`).toString("base64");
    headers.Authorization = `Basic ${auth}`;
  }
  try {
    const res = await fetch(`${base}/Health`, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const text = await res.text();
    let body: any;
    try {
      body = JSON.parse(text);
    } catch {
      return null;
    }
    // Tolerate a few shapes: { version }, { flair: { version } }, { flairVersion }.
    const v =
      body?.version ?? body?.flairVersion ?? body?.flair?.version ?? null;
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

/** Resolve the @harperfast/harper bin that npm installed under the staged flair. */
export function resolveStagedHarperVersion(stagingDir: string): string | null {
  const harperPkgJson = join(
    stagingDir,
    "node_modules",
    FLAIR_PKG,
    "node_modules",
    HARPER_PKG,
    "package.json",
  );
  // npm dedupes: with an override the fixed Harper may hoist to the staging
  // root rather than nest under flair. Check both.
  const hoisted = join(stagingDir, "node_modules", HARPER_PKG, "package.json");
  for (const candidate of [harperPkgJson, hoisted]) {
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
  try {
    const flairPkg = join(stagingDir, "node_modules", FLAIR_PKG, "package.json");
    const req = createRequire(flairPkg);
    const resolved = req.resolve(`${HARPER_PKG}/package.json`);
    const pkg = JSON.parse(readFileSync(resolved, "utf8"));
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
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
    fetchDeployedVersion: defaultFetchDeployedVersion,
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
    url: opts.target,
    project,
    fabricUser: opts.fabricUser,
    fabricPassword: opts.fabricPassword,
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

  // Step 1 + diff.
  const plan = await planFabricUpgrade(opts, deps);

  log(`Fabric:  ${plan.target}`);
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
    log(`Deploying ${plan.project} ${plan.targetVersion} to ${plan.target} ...`);
    const result = await deps.deploy({
      target: opts.target,
      project: plan.project,
      version: plan.targetVersion,
      fabricUser: opts.fabricUser,
      fabricPassword: opts.fabricPassword,
      restart: opts.restart,
      replicated: opts.replicated,
      packageRoot,
    });

    // Step 4: verify the deployed version (best-effort).
    let verifiedVersion: string | null = null;
    try {
      verifiedVersion = await deps.fetchDeployedVersion({
        url: opts.target,
        project: plan.project,
        fabricUser: opts.fabricUser,
        fabricPassword: opts.fabricPassword,
      });
    } catch {
      verifiedVersion = null;
    }
    if (verifiedVersion) {
      const ok = semverGte(verifiedVersion, plan.targetVersion);
      log(
        ok
          ? `✓ Fabric now reports Flair ${verifiedVersion}`
          : `⚠ Fabric reports ${verifiedVersion} (expected ${plan.targetVersion}) — may still be restarting`,
      );
    } else {
      log(
        `✓ Deployed ${result.version} (Fabric did not report a version to verify against)`,
      );
    }

    return { plan, deployed: true, verifiedVersion, stagingDir };
  } finally {
    // SAFETY: always clean up the temp dir.
    rmSync(stagingDir, { recursive: true, force: true });
  }
}
