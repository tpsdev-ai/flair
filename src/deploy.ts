import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
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
  const args = [
    "deploy",
    `target=${url}`,
    `project=${project}`,
    `restart=${opts.restart !== false}`,
    `replicated=${opts.replicated !== false}`,
  ];

  // Credentials go via env, not argv, so they don't appear in `ps` output
  // for the lifetime of the Harper child process. Harper's cliOperations
  // reads CLI_TARGET_USERNAME / CLI_TARGET_PASSWORD as env fallbacks.
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    CLI_TARGET_USERNAME: opts.fabricUser,
    CLI_TARGET_PASSWORD: opts.fabricPassword,
  };

  await spawnHarper(harperBin, args, packageRoot, childEnv);

  return { url, project, version, packageRoot, dryRun: false };
}
