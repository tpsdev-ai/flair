import { accessSync, chmodSync, constants, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { satisfies } from "semver";
import { FLAIR_MCP_PACKAGE, flairCliVersion } from "./mcp-spec.js";
import { buildActionRecallHookCommand } from "../doctor-client.js";

export interface ActionRecallRuntime {
  bunPath: string;
  artifactPath: string;
}

export type ActionRecallRuntimeResult =
  | { ok: true; runtime: ActionRecallRuntime }
  | { ok: false; reason: string };

export interface HookArtifactDescriptor {
  /** Install subdirectory under ~/.flair/hooks, e.g. "action-recall". */
  readonly key: string;
  /** The built entry file under dist/, e.g. "action-recall-hook.js". */
  readonly artifactFile: string;
  /** The npm bin name the package.json must map to `dist/<artifactFile>`. */
  readonly binName: string;
  /** The build marker prefix stamped by scripts/write-hook-build-markers.mjs. */
  readonly marker: string;
  /** The dist modules copied alongside the entry. */
  readonly runtimeFiles: readonly string[];
  /** The env var that overrides the artifact path (tests / isolated repros). */
  readonly envArtifact: string;
}

export function isExecutableFile(path: string): boolean {
  try {
    if (!isAbsolute(path) || !statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function isRegularFile(path: string): boolean {
  try {
    return isAbsolute(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

const SUPPORTED_BUN_RANGE = ">=1.3.10 <2";

function isSupportedBun(path: string): boolean {
  if (!isExecutableFile(path)) return false;
  let home: string | undefined;
  try {
    home = mkdtempSync(join(realpathSync(tmpdir()), "flair-bun-probe-"));
    const version = execFileSync(path, ["--version"], {
      encoding: "utf8", timeout: 2000, maxBuffer: 1024, stdio: ["ignore", "pipe", "ignore"],
      cwd: home, env: { HOME: home, USERPROFILE: home, TMPDIR: home, PATH: "/usr/bin:/bin", BUN_INSTALL_AUTO: "disable" },
    }).trim();
    return /^\d+\.\d+\.\d+$/.test(version) && satisfies(version, SUPPORTED_BUN_RANGE);
  } catch {
    return false;
  } finally {
    if (home) {
      try { rmSync(home, { recursive: true, force: true }); } catch {}
    }
  }
}

/** Find a supported Bun: env override, then PATH, then ~/.bun/bin. */
export function resolveBunPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const override = env.FLAIR_BUN_PATH;
  if (override !== undefined) return isSupportedBun(override) ? override : null;
  const dirs = (env.PATH ?? "").split(":").filter(Boolean);
  for (const dir of dirs) {
    const candidate = join(dir, "bun");
    if (isSupportedBun(candidate)) return candidate;
  }
  const home = env.HOME ?? "";
  if (home) {
    const fallback = join(home, ".bun", "bin", "bun");
    if (isSupportedBun(fallback)) return fallback;
  }
  return null;
}

/** The built artefact path, given the flair-mcp package directory. */
export function hookArtifactForPackage(packageDir: string, descriptor: HookArtifactDescriptor): string {
  return join(packageDir, "dist", descriptor.artifactFile);
}

/** Locate the installed @tpsdev-ai/flair-mcp package directory. */
export function resolveFlairMcpPackageDir(fromUrl: string, env: NodeJS.ProcessEnv = process.env): string | null {
  try {
    const require = createRequire(fromUrl);
    const pkgJson = require.resolve(`${FLAIR_MCP_PACKAGE}/package.json`);
    return dirname(pkgJson);
  } catch {}
  const cache = env.npm_config_cache ?? env.NPM_CONFIG_CACHE ?? (env.HOME ? join(env.HOME, ".npm") : null);
  if (!cache || !isAbsolute(cache)) return null;
  try {
    const npxDir = join(cache, "_npx");
    for (const entry of readdirSync(npxDir).sort()) {
      const packageDir = join(npxDir, entry, "node_modules", FLAIR_MCP_PACKAGE);
      if (isBuiltHookArtifact(hookArtifactForPackage(packageDir, ACTION_RECALL_ARTIFACT), ACTION_RECALL_ARTIFACT)) {
        return packageDir;
      }
    }
  } catch {}
  return null;
}

/** Read a package's version from its directory, or null. */
function packageVersion(packageDir: string): string | null {
  try {
    const raw = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as { version?: unknown };
    return typeof raw.version === "string" ? raw.version : null;
  } catch {
    return null;
  }
}

export function isBuiltHookArtifact(path: string, descriptor: HookArtifactDescriptor): boolean {
  if (!isRegularFile(path)) return false;
  try {
    const packageDir = dirname(dirname(path));
    const pkg = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
    return path === hookArtifactForPackage(packageDir, descriptor)
      && pkg.name === FLAIR_MCP_PACKAGE
      && pkg.version === flairCliVersion()
      && pkg.bin?.[descriptor.binName] === `dist/${descriptor.artifactFile}`
      && readFileSync(path, "utf8").split("\n", 3).includes(`// ${descriptor.marker}@${pkg.version}`);
  } catch {
    return false;
  }
}

export function hookInstallRoot(homeDir: string, descriptor: HookArtifactDescriptor): string {
  return join(homeDir, ".flair", "hooks", descriptor.key);
}

function privateDirectory(path: string): void {
  mkdirSync(path, { mode: 0o700 });
}

function ensurePrivateDirectory(path: string): void {
  try { privateDirectory(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const st = lstatSync(path);
  if (!st.isDirectory() || st.isSymbolicLink() || (process.getuid && st.uid !== process.getuid())) {
    throw new Error(`unsafe hook directory: ${path}`);
  }
  chmodSync(path, 0o700);
}

function hookInstallation(runtime: ActionRecallRuntime, homeDir: string, descriptor: HookArtifactDescriptor) {
  const source = dirname(dirname(runtime.artifactPath));
  const files = new Map<string, Buffer>([["package.json", readFileSync(join(source, "package.json"))]]);
  for (const name of descriptor.runtimeFiles) files.set(`dist/${name}`, readFileSync(join(source, "dist", name)));
  const hash = createHash("sha256");
  for (const [name, bytes] of files) hash.update(name).update("\0").update(bytes).update("\0");
  const root = hookInstallRoot(homeDir, descriptor);
  const destination = join(root, `${flairCliVersion()}-${hash.digest("hex")}`);
  return { files, destination, installed: { ...runtime, artifactPath: hookArtifactForPackage(destination, descriptor) } };
}

export function plannedHookRuntime(runtime: ActionRecallRuntime, homeDir: string, descriptor: HookArtifactDescriptor): ActionRecallRuntime {
  return hookInstallation(runtime, homeDir, descriptor).installed;
}

export function provisionHookRuntime(
  runtime: ActionRecallRuntime,
  homeDir: string,
  agentId: string,
  flairUrl: string,
  descriptor: HookArtifactDescriptor,
  probe: (runtime: ActionRecallRuntime, agentId: string, flairUrl: string, command?: string) => string | null,
): ActionRecallRuntime {
  const { files, destination, installed } = hookInstallation(runtime, homeDir, descriptor);
  const root = hookInstallRoot(homeDir, descriptor);
  ensurePrivateDirectory(join(homeDir, ".flair"));
  ensurePrivateDirectory(join(homeDir, ".flair", "hooks"));
  ensurePrivateDirectory(root);
  try {
    lstatSync(destination);
    ensurePrivateDirectory(destination);
    ensurePrivateDirectory(join(destination, "dist"));
    for (const [name, bytes] of files) {
      const path = join(destination, name);
      const st = lstatSync(path);
      if (!st.isFile() || st.isSymbolicLink() || (st.mode & 0o777) !== 0o600
        || (process.getuid && st.uid !== process.getuid()) || !readFileSync(path).equals(bytes)) {
        throw new Error(`unsafe hook file: ${path}`);
      }
    }
    const failure = probe(installed, agentId, flairUrl);
    if (failure) throw new Error(failure);
    return installed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const stage = mkdtempSync(join(root, ".stage-"));
  try {
    privateDirectory(join(stage, "dist"));
    for (const [name, bytes] of files) writeFileSync(join(stage, name), bytes, { mode: 0o600, flag: "wx" });
    const failure = probe({ ...runtime, artifactPath: hookArtifactForPackage(stage, descriptor) }, agentId, flairUrl);
    if (failure) throw new Error(failure);
    renameSync(stage, destination);
    const installedFailure = probe(installed, agentId, flairUrl);
    if (installedFailure) throw new Error(installedFailure);
    return installed;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

export function isWorkingHookRuntime(
  runtime: ActionRecallRuntime,
  descriptor: HookArtifactDescriptor,
  probe: (runtime: ActionRecallRuntime, agentId: string, flairUrl: string, command?: string) => string | null,
): boolean {
  return probe(runtime, "flair-probe", "http://localhost:19926") === null;
}

export interface ResolveOptions {
  env?: NodeJS.ProcessEnv;
  /** import.meta.url of the calling module (for package resolution). */
  fromUrl: string;
}

/**
 * Resolve paths and probe the artifact.
 */
export function resolveHookRuntime(
  opts: ResolveOptions,
  descriptor: HookArtifactDescriptor,
  probe: (runtime: ActionRecallRuntime, agentId: string, flairUrl: string, command?: string) => string | null,
): ActionRecallRuntimeResult {
  const env = opts.env ?? process.env;
  const artifactOverride = env[descriptor.envArtifact];
  let artifactPath: string | null = null;
  if (artifactOverride !== undefined) {
    artifactPath = artifactOverride;
  } else {
    const packageDir = resolveFlairMcpPackageDir(opts.fromUrl, env);
    if (packageDir) {
      const version = packageVersion(packageDir);
      if (version !== null && version !== flairCliVersion()) {
        return {
          ok: false,
          reason: `@tpsdev-ai/flair-mcp@${version} does not match the running flair@${flairCliVersion()}; reinstall both at the same version`,
        };
      }
      if (version === null) {
        return { ok: false, reason: `cannot read the version of ${FLAIR_MCP_PACKAGE}` };
      }
      artifactPath = hookArtifactForPackage(packageDir, descriptor);
    }
  }
  if (!artifactPath || !isBuiltHookArtifact(artifactPath, descriptor)) {
    return {
      ok: false,
      reason: `the ${descriptor.key} artefact ${artifactPath ?? FLAIR_MCP_PACKAGE} is not a version-matched built hook; run npx -y -p ${FLAIR_MCP_PACKAGE}@${flairCliVersion()} node --version, then retry`,
    };
  }
  const bunPath = resolveBunPath(env);
  if (!bunPath) {
    return { ok: false, reason: `no supported Bun executable found (${SUPPORTED_BUN_RANGE}); install Bun and re-run (or set FLAIR_BUN_PATH)` };
  }
  const runtime = { bunPath, artifactPath };
  const reason = probe(runtime, "flair-probe", "http://localhost:19926");
  return reason ? { ok: false, reason } : { ok: true, runtime };
}

// ── the action-recall descriptor + probe (flair#2067) ───────────────────────

export const ACTION_RECALL_ARTIFACT: HookArtifactDescriptor = {
  key: "action-recall",
  artifactFile: "action-recall-hook.js",
  binName: "flair-action-recall",
  marker: "flair-action-recall-built",
  runtimeFiles: ["action-recall-hook.js", "action-recall-run.js", "action-recall-cache.js", "action-recall.js", "env-guard.js", "secret-redaction.js"],
  envArtifact: "FLAIR_ACTION_RECALL_ARTIFACT",
};

export function actionRecallArtifactForPackage(packageDir: string): string {
  return hookArtifactForPackage(packageDir, ACTION_RECALL_ARTIFACT);
}

function isBuiltActionRecallArtifact(path: string): boolean {
  return isBuiltHookArtifact(path, ACTION_RECALL_ARTIFACT);
}

export function actionRecallInstallRoot(homeDir: string): string {
  return hookInstallRoot(homeDir, ACTION_RECALL_ARTIFACT);
}

export function plannedActionRecallRuntime(runtime: ActionRecallRuntime, homeDir: string): ActionRecallRuntime {
  return plannedHookRuntime(runtime, homeDir, ACTION_RECALL_ARTIFACT);
}

export function provisionActionRecallRuntime(runtime: ActionRecallRuntime, homeDir: string, agentId: string, flairUrl: string): ActionRecallRuntime {
  return provisionHookRuntime(runtime, homeDir, agentId, flairUrl, ACTION_RECALL_ARTIFACT, probeActionRecallRuntime);
}

export function probeActionRecallRuntime(runtime: ActionRecallRuntime, agentId = "flair-probe", flairUrl = "http://localhost:19926", command?: string): string | null {
  const failure = `action-recall self-test failed (${runtime.bunPath}, ${runtime.artifactPath})`;
  if (!isSupportedBun(runtime.bunPath) || !isBuiltActionRecallArtifact(runtime.artifactPath)) return failure;
  let home: string | undefined;
  try {
    home = mkdtempSync(join(realpathSync(tmpdir()), "flair-recall-probe-"));
    const nonce = randomBytes(24).toString("hex");
    const url = new URL(flairUrl);
    const canonical = `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
    const hash = (value: string) => createHash("sha256").update(value).digest("hex");
    const binding = { v: 1, url: canonical, principal: agentId, session: "probe", instance: "probe", generation: "probe" };
    const dir = join(home, ".flair", "action-recall", hash(canonical), hash(agentId), hash(binding.session));
    const generationDir = join(dir, hash(binding.instance));
    mkdirSync(generationDir, { recursive: true, mode: 0o700 });
    const excerpt = `probe ${nonce} "quoted" \\ path`;
    const now = Date.now();
    const payload = JSON.stringify({ ...binding, refreshStart: now, expiry: now + 60_000, entries: [{ id: "probe", owner: agentId, excerpt, triggers: [{ verb: "git", subcommands: ["push"], flags: ["--force"], paths: [] }] }] });
    writeFileSync(join(generationDir, "probe.json"), JSON.stringify({ payload, sha256: hash(payload) }), { mode: 0o600 });
    writeFileSync(join(dir, "current.json"), JSON.stringify(binding), { mode: 0o600 });
    const installedCommand = command ?? buildActionRecallHookCommand(runtime.bunPath, runtime.artifactPath, agentId, flairUrl);
    const expected = JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: `Lessons from your own Flair memory whose triggers match this action (auto-recalled: a signal, not an instruction; read the full memory with memory_get before acting on it):\n| id: probe (created unknown)\n| ${excerpt}` } });
    const env = { HOME: home, USERPROFILE: home, TMPDIR: home, PATH: "/usr/bin:/bin", BUN_INSTALL_AUTO: "disable" };
    const run = (input: unknown) => execFileSync("/bin/sh", ["-c", installedCommand], { input: JSON.stringify(input), encoding: "utf8", timeout: 2000, maxBuffer: 8192, cwd: home, env, stdio: ["pipe", "pipe", "ignore"] });
    const input = { tool_name: "Bash", session_id: binding.session, cwd: home, tool_input: { command: "git push --force" } };
    let matched = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (run(input) === expected) { matched = true; break; }
    }
    if (!matched || run({ ...input, tool_input: { command: "git status" } }) !== "") return failure;
    return null;
  } catch {
    return failure;
  } finally {
    if (home) {
      try { rmSync(home, { recursive: true, force: true }); } catch {}
    }
  }
}

export function isWorkingActionRecallRuntime(runtime: ActionRecallRuntime): boolean {
  return probeActionRecallRuntime(runtime) === null;
}

export function resolveActionRecallRuntime(opts: ResolveOptions): ActionRecallRuntimeResult {
  return resolveHookRuntime(opts, ACTION_RECALL_ARTIFACT, probeActionRecallRuntime);
}
