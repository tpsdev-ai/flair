/**
 * Resolve the runtime for the action-recall PreToolUse hook (flair#2067 slice 2).
 *
 * The installed hook command runs the BUILT artefact directly with an absolute
 * Bun executable — no `npx`, no package resolution, no network at tool-call
 * time. This module finds those two absolute paths at INSTALL time and reports
 * a named failure when either is invalid.
 */

import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join } from "node:path";
import { satisfies } from "semver";
import { FLAIR_MCP_PACKAGE, flairCliVersion } from "./mcp-spec.js";

export interface ActionRecallRuntime {
  bunPath: string;
  artifactPath: string;
}

export type ActionRecallRuntimeResult =
  | { ok: true; runtime: ActionRecallRuntime }
  | { ok: false; reason: string };

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
  try {
    const version = execFileSync(path, ["--version"], { encoding: "utf8", timeout: 2000, maxBuffer: 1024, stdio: ["ignore", "pipe", "ignore"] }).trim();
    return /^\d+\.\d+\.\d+$/.test(version) && satisfies(version, SUPPORTED_BUN_RANGE);
  } catch {
    return false;
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
export function actionRecallArtifactForPackage(packageDir: string): string {
  return join(packageDir, "dist", "action-recall-hook.js");
}

/** Locate the installed @tpsdev-ai/flair-mcp package directory. */
export function resolveFlairMcpPackageDir(fromUrl: string): string | null {
  try {
    const require = createRequire(fromUrl);
    const pkgJson = require.resolve(`${FLAIR_MCP_PACKAGE}/package.json`);
    return dirname(pkgJson);
  } catch {
    return null;
  }
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

function isBuiltActionRecallArtifact(path: string): boolean {
  if (!isRegularFile(path)) return false;
  try {
    const packageDir = dirname(dirname(path));
    const pkg = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
    return path === actionRecallArtifactForPackage(packageDir)
      && pkg.name === FLAIR_MCP_PACKAGE
      && pkg.version === flairCliVersion()
      && pkg.bin?.["flair-action-recall"] === "dist/action-recall-hook.js"
      && readFileSync(path, "utf8").split("\n", 3).includes(`// flair-action-recall-built@${pkg.version}`);
  } catch {
    return false;
  }
}

export function isWorkingActionRecallRuntime(runtime: ActionRecallRuntime): boolean {
  return isSupportedBun(runtime.bunPath) && isBuiltActionRecallArtifact(runtime.artifactPath);
}

export interface ResolveOptions {
  env?: NodeJS.ProcessEnv;
  /** import.meta.url of the calling module (for package resolution). */
  fromUrl: string;
}

/**
 * Resolve supported Bun and a version-matched built hook, including overrides.
 */
export function resolveActionRecallRuntime(opts: ResolveOptions): ActionRecallRuntimeResult {
  const env = opts.env ?? process.env;
  const artifactOverride = env.FLAIR_ACTION_RECALL_ARTIFACT;
  let artifactPath: string | null = null;
  if (artifactOverride !== undefined) {
    artifactPath = artifactOverride;
  } else {
    const packageDir = resolveFlairMcpPackageDir(opts.fromUrl);
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
      artifactPath = actionRecallArtifactForPackage(packageDir);
    }
  }
  if (!artifactPath || !isBuiltActionRecallArtifact(artifactPath)) {
    return {
      ok: false,
      reason: `the action-recall artefact ${artifactPath ?? FLAIR_MCP_PACKAGE} is not a version-matched built hook; rebuild or reinstall ${FLAIR_MCP_PACKAGE} at the same version`,
    };
  }
  const bunPath = resolveBunPath(env);
  if (!bunPath) {
    return { ok: false, reason: `no supported Bun executable found (${SUPPORTED_BUN_RANGE}); install Bun and re-run (or set FLAIR_BUN_PATH)` };
  }
  return { ok: true, runtime: { bunPath, artifactPath } };
}
