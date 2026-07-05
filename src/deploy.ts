import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

export interface DeployOptions {
  fabricOrg?: string;
  fabricCluster?: string;
  fabricUser?: string;
  fabricPassword?: string;
  fabricToken?: string;
  target?: string;
  project?: string;
  version?: string;
  replicated?: boolean;
  restart?: boolean;
  dryRun?: boolean;
  packageRoot?: string;
  // How long harper's own deploy CLI will wait for cluster-wide peer
  // replication / package install before giving up. Both default to
  // DEFAULT_DEPLOYMENT_TIMEOUT_MS / DEFAULT_INSTALL_TIMEOUT_MS — the harper
  // CLI's own default (120s) is too short for Fabric peer-replication and
  // was the root cause of a real incident where the CLI aborted and forced
  // a hand-rolled raw deploy.
  deploymentTimeoutMs?: number;
  installTimeoutMs?: number;
  // Post-deploy served-API verification (on by default). See verifyDeployServing.
  verify?: boolean;
  verifyResources?: string[];
  verifyTimeoutMs?: number;
  // Optional progress sink so callers (the CLI) can surface what would
  // otherwise be a silent multi-minute poll. Never required — deploy() and
  // verifyDeployServing() work fine without it (e.g. fabric-upgrade.ts's
  // reuse of deploy() doesn't pass one).
  onProgress?: (msg: string) => void;
}

export interface DeployResult {
  url: string;
  project: string;
  version: string;
  packageRoot: string;
  dryRun: boolean;
}

// Files that must be present in a Flair package for deployment.
// Mirrors the `files` array in package.json — keep in sync.
export const REQUIRED_PACKAGE_FILES = [
  "dist",
  "schemas",
  "ui",
  "config.yaml",
] as const;

// harper's own deploy CLI defaults to a 120s peer-replication timeout that's
// too short for Fabric — the CLI aborts mid-replicate with no override,
// which is exactly the incident this module now guards against. 10 minutes
// gives cluster-wide replication + install room to actually finish.
export const DEFAULT_DEPLOYMENT_TIMEOUT_MS = 600_000;
export const DEFAULT_INSTALL_TIMEOUT_MS = 600_000;

// Post-deploy verification: how long we'll wait for the served API to come
// back up after harper's restart, how often we poll while waiting, and how
// many consecutive reachable responses count as "settled" (a single
// reachable probe right after restart can be a fluke mid-flap).
export const DEFAULT_VERIFY_TIMEOUT_MS = 300_000;
export const VERIFY_POLL_INTERVAL_MS = 15_000;
export const VERIFY_SETTLE_STREAK = 3;

// Fallback when dist/resources can't be scanned (e.g. an unusual package
// layout via --package-root). Memory is Flair's original, always-present
// resource — a reasonable single thing to check when derivation fails.
export const FALLBACK_VERIFY_RESOURCE = "Memory";

export function validateOptions(opts: DeployOptions): string[] {
  const errors: string[] = [];
  if (!opts.target) {
    if (!opts.fabricOrg)
      errors.push("--fabric-org required (or FABRIC_ORG env)");
    if (!opts.fabricCluster)
      errors.push("--fabric-cluster required (or FABRIC_CLUSTER env)");
  }
  const hasBasic = !!(opts.fabricUser && opts.fabricPassword);
  const hasBearer = !!opts.fabricToken;
  if (!hasBasic && !hasBearer) {
    errors.push(
      "credentials required: pass --fabric-user + --fabric-password " +
        "(or FABRIC_USER / FABRIC_PASSWORD env), or --fabric-token " +
        "(FABRIC_TOKEN env)",
    );
  }
  return errors;
}

export function buildTargetUrl(opts: DeployOptions): string {
  if (opts.target) return opts.target;
  return `https://${opts.fabricCluster}.${opts.fabricOrg}.harperfabric.com`;
}

export function resolvePackageRoot(override?: string): string {
  if (override) {
    const abs = resolve(override);
    if (!existsSync(join(abs, "package.json"))) {
      throw new Error(`No package.json at ${abs}`);
    }
    return abs;
  }

  // Walk up from this module's location — works when installed locally
  // and when npx extracts the tarball to a tmpdir.
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    let dir = here;
    for (let i = 0; i < 8; i++) {
      const pkgPath = join(dir, "package.json");
      if (existsSync(pkgPath)) {
        const json = JSON.parse(readFileSync(pkgPath, "utf8"));
        if (json.name === "@tpsdev-ai/flair") return dir;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    /* fall through */
  }

  try {
    const req = createRequire(import.meta.url);
    return dirname(req.resolve("@tpsdev-ai/flair/package.json"));
  } catch {
    throw new Error(
      "Could not locate @tpsdev-ai/flair package root. Try --package-root.",
    );
  }
}

export function validatePackageLayout(packageRoot: string): void {
  const missing: string[] = [];
  for (const f of REQUIRED_PACKAGE_FILES) {
    if (!existsSync(join(packageRoot, f))) missing.push(f);
  }
  if (missing.length) {
    throw new Error(
      `Flair package at ${packageRoot} is missing required entries: ` +
        missing.join(", "),
    );
  }
}

// Derive the list of served, table-backed REST resources from the compiled
// package — no hardcoded resource list. Flair's jsResource files (dist/resources/*.js)
// contain both real Resource classes (routable, GET-able) and plain helper
// modules (embeddings, auth, scoring, etc). We only ship dist/ in the
// published package (resources/*.ts source is not in package.json's `files`),
// so this scans the COMPILED output, matching the convention every current
// table-backed resource follows:
//
//   export class <Name> extends databases.<db>.<Name> { ... }
//
// i.e. the exported class name equals the filename equals the underlying
// table name (Memory.js -> `export class Memory extends databases.flair.Memory`,
// same for Agent, Soul, MemoryGrant, Credential, OrgEvent, etc). Helper
// modules are lowercase-first (agent-auth.js, embeddings-provider.js, ...)
// and never match, so they're skipped without needing a denylist. Files
// that export a resource extending a *generic* `Resource` base (AgentCard,
// WorkspaceLatest, action-style endpoints) are deliberately excluded here —
// they're action/command endpoints, not GET-able collections, and asserting
// non-404 on them would be the wrong check.
const TABLE_RESOURCE_RE = (name: string) =>
  new RegExp(`export class ${name} extends databases\\.[A-Za-z_$][\\w$]*\\.${name}\\b`);

export function deriveVerifyResources(packageRoot: string): string[] {
  const resourcesDir = join(packageRoot, "dist", "resources");
  let entries: string[];
  try {
    entries = readdirSync(resourcesDir);
  } catch {
    return [FALLBACK_VERIFY_RESOURCE];
  }

  const names: string[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".js")) continue;
    const base = entry.slice(0, -3);
    if (!/^[A-Z]/.test(base)) continue; // helper modules are camelCase/lowercase
    let src: string;
    try {
      src = readFileSync(join(resourcesDir, entry), "utf8");
    } catch {
      continue;
    }
    if (TABLE_RESOURCE_RE(base).test(src)) names.push(base);
  }
  names.sort();
  return names.length ? names : [FALLBACK_VERIFY_RESOURCE];
}

function resolveHarperBin(packageRoot: string): string {
  const local = join(
    packageRoot,
    "node_modules/@harperfast/harper/dist/bin/harper.js",
  );
  if (existsSync(local)) return local;

  try {
    const req = createRequire(join(packageRoot, "package.json"));
    const mainPath = req.resolve("@harperfast/harper");
    let dir = dirname(mainPath);
    for (let i = 0; i < 6; i++) {
      const candidate = join(dir, "dist/bin/harper.js");
      if (existsSync(candidate)) return candidate;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    /* fall through */
  }
  throw new Error(
    "Could not locate Harper CLI binary (@harperfast/harper). " +
      "Flair deploy requires Harper to be installed alongside Flair.",
  );
}

// Pure arg-array builder — separated from spawnHarper so the timeout
// passthrough (and the rest of the arg shape) is unit-testable without
// mocking child_process / actually spawning harper.
export function buildHarperDeployArgs(
  opts: DeployOptions,
  url: string,
  project: string,
): string[] {
  const deploymentTimeoutMs = opts.deploymentTimeoutMs ?? DEFAULT_DEPLOYMENT_TIMEOUT_MS;
  const installTimeoutMs = opts.installTimeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS;
  return [
    "deploy",
    `target=${url}`,
    `project=${project}`,
    `restart=${opts.restart !== false}`,
    `replicated=${opts.replicated !== false}`,
    `deployment_timeout=${deploymentTimeoutMs}`,
    `install_timeout=${installTimeoutMs}`,
  ];
}

function spawnHarper(
  bin: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  return new Promise((resolveP, rejectP) => {
    const p = spawn(process.execPath, [bin, ...args], {
      cwd,
      stdio: "inherit",
      env,
    });
    p.on("error", rejectP);
    p.on("exit", (code) => {
      if (code === 0) resolveP();
      else rejectP(new Error(`harper deploy exited with code ${code}`));
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// A single reachability probe against the served (REST) base URL. Harper
// restarts the process after every deploy, so the endpoint FLAPS for a bit —
// connection refused / reset / DNS blips are all EXPECTED right after
// restart, not a failure signal by themselves. Any HTTP response at all
// (regardless of status code — a 404 on `/` is normal) proves the process
// is back up and terminating TLS/HTTP again; that's all "reachable" means
// here. Resource-level 404s are a separate, later check.
async function probeReachable(baseUrl: string, fetchImpl: typeof fetch): Promise<boolean> {
  try {
    await fetchImpl(baseUrl, { method: "GET", signal: AbortSignal.timeout(10_000) });
    return true;
  } catch {
    return false;
  }
}

export interface VerifyDeployOptions {
  baseUrl: string;
  resources: string[];
  timeoutMs?: number;
  pollIntervalMs?: number;
  settleStreak?: number;
  fetchImpl?: typeof fetch;
  onProgress?: (msg: string) => void;
}

async function pollUntilSettled(
  baseUrl: string,
  timeoutMs: number,
  pollIntervalMs: number,
  settleStreak: number,
  fetchImpl: typeof fetch,
  onProgress?: (msg: string) => void,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let streak = 0;
  let attempt = 0;
  for (;;) {
    attempt++;
    const reachable = await probeReachable(baseUrl, fetchImpl);
    streak = reachable ? streak + 1 : 0;
    if (!reachable) {
      onProgress?.(`waiting for ${baseUrl} to come back up after restart (attempt ${attempt})...`);
    }
    if (streak >= settleStreak) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `deploy verification: ${baseUrl} did not settle within ${timeoutMs}ms after restart ` +
          `(Harper never came back up, or is unusually slow to restart post-deploy)`,
      );
    }
    await sleep(pollIntervalMs);
  }
}

async function verifyResourcesServing(
  baseUrl: string,
  resources: string[],
  fetchImpl: typeof fetch,
): Promise<void> {
  const base = baseUrl.replace(/\/+$/, "");
  const notServing: string[] = [];
  for (const name of resources) {
    const path = `${base}/${name}`;
    let status: number;
    try {
      const res = await fetchImpl(path, { method: "GET", signal: AbortSignal.timeout(10_000) });
      status = res.status;
    } catch (err: any) {
      throw new Error(
        `deploy verification: request to ${path} failed even after the endpoint settled: ${err?.message ?? err}`,
      );
    }
    // 404 = the resource genuinely isn't being served (this is the incident:
    // harper reported "Successfully deployed" while the component was empty).
    // 401 = auth-gated, which means the resource IS being served correctly.
    // 200 = served + accessible. Both count as pass.
    if (status === 404) notServing.push(name);
  }
  if (notServing.length) {
    const list = notServing.map((n) => `/${n}`).join(", ");
    throw new Error(
      `deploy reported success but ${list} return${notServing.length === 1 ? "s" : ""} 404 — ` +
        `component is not serving; likely deployed the wrong package root`,
    );
  }
}

// The tool must not be able to lie. harper's deploy CLI can print
// "Successfully deployed" for an empty component — the only way to know the
// deploy actually worked is to curl the served API and check it isn't 404.
// This polls the served base URL (443, NOT the :9925 ops API deploy talks
// to) until it settles after harper's post-deploy restart, then asserts the
// derived resource(s) respond non-404.
export async function verifyDeployServing(o: VerifyDeployOptions): Promise<void> {
  const {
    baseUrl,
    resources,
    timeoutMs = DEFAULT_VERIFY_TIMEOUT_MS,
    pollIntervalMs = VERIFY_POLL_INTERVAL_MS,
    settleStreak = VERIFY_SETTLE_STREAK,
    fetchImpl = fetch,
    onProgress,
  } = o;
  onProgress?.(`verifying ${baseUrl} is actually serving (not just reported deployed)...`);
  await pollUntilSettled(baseUrl, timeoutMs, pollIntervalMs, settleStreak, fetchImpl, onProgress);
  onProgress?.(`settled — checking ${resources.map((r) => `/${r}`).join(", ")}...`);
  await verifyResourcesServing(baseUrl, resources, fetchImpl);
  onProgress?.(`served API verified non-404 for ${resources.length} resource(s)`);
}

export async function deploy(opts: DeployOptions): Promise<DeployResult> {
  const errors = validateOptions(opts);
  if (errors.length) {
    throw new Error(errors.join("\n"));
  }

  const packageRoot = resolvePackageRoot(opts.packageRoot);
  validatePackageLayout(packageRoot);

  const pkg = JSON.parse(
    readFileSync(join(packageRoot, "package.json"), "utf8"),
  );
  const version = opts.version ?? pkg.version;
  const project = opts.project ?? "flair";
  const url = buildTargetUrl(opts);

  if (opts.dryRun) {
    return { url, project, version, packageRoot, dryRun: true };
  }

  if (opts.fabricToken && !(opts.fabricUser && opts.fabricPassword)) {
    throw new Error(
      "Bearer token auth (--fabric-token) is not yet supported — " +
        "Harper's deploy_component CLI path only accepts Basic auth today. " +
        "Pass --fabric-user + --fabric-password instead.",
    );
  }

  const harperBin = resolveHarperBin(packageRoot);
  const args = buildHarperDeployArgs(opts, url, project);

  // Credentials go via env, not argv, so they don't appear in `ps` output
  // for the lifetime of the Harper child process. Harper's cliOperations
  // reads CLI_TARGET_USERNAME / CLI_TARGET_PASSWORD as env fallbacks.
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    CLI_TARGET_USERNAME: opts.fabricUser,
    CLI_TARGET_PASSWORD: opts.fabricPassword,
  };

  await spawnHarper(harperBin, args, packageRoot, childEnv);

  // harper can print "Successfully deployed" for a component that isn't
  // actually serving anything (the incident this closes: an empty deploy,
  // reported success, /Memory 404ing in prod). Verify by curling the served
  // API — on by default, escape hatch via --no-verify.
  if (opts.verify !== false) {
    const resources = opts.verifyResources?.length
      ? opts.verifyResources
      : deriveVerifyResources(packageRoot);
    await verifyDeployServing({
      baseUrl: url,
      resources,
      timeoutMs: opts.verifyTimeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS,
      onProgress: opts.onProgress,
    });
  }

  return { url, project, version, packageRoot, dryRun: false };
}
