/**
 * Resolve the runtime for the action-recall PreToolUse hook (flair#2067 slice 2).
 *
 * The installed hook command runs the BUILT artefact directly with an absolute
 * Bun executable — no `npx`, no package resolution, no network at tool-call
 * time. This module finds those two absolute paths at INSTALL time and reports
 * a named, actionable failure when either is missing. Pure filesystem work;
 * never throws.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join } from "node:path";
import { FLAIR_MCP_PACKAGE, flairCliVersion } from "./mcp-spec.js";

export interface ActionRecallRuntime {
  bunPath: string;
  artifactPath: string;
}

export type ActionRecallRuntimeResult =
  | { ok: true; runtime: ActionRecallRuntime }
  | { ok: false; reason: string };

function isExecutableFile(path: string): boolean {
  try {
    const st = statSync(path);
    return st.isFile();
  } catch {
    return false;
  }
}

/** Find an absolute Bun executable: env override, then PATH, then ~/.bun/bin. */
export function resolveBunPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const override = env.FLAIR_BUN_PATH;
  if (typeof override === "string" && isAbsolute(override) && isExecutableFile(override)) return override;
  const dirs = (env.PATH ?? "").split(":").filter(Boolean);
  for (const dir of dirs) {
    const candidate = join(dir, "bun");
    if (isExecutableFile(candidate)) return candidate;
  }
  const home = env.HOME ?? "";
  if (home) {
    const fallback = join(home, ".bun", "bin", "bun");
    if (isExecutableFile(fallback)) return fallback;
  }
  return null;
}

/** The built artefact path, given the flair-mcp package directory. */
export function actionRecallArtifactForPackage(packageDir: string): string {
  return join(packageDir, "dist", "action-recall-hook.js");
}

/** Locate the installed, version-matching @tpsdev-ai/flair-mcp package directory. */
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

export interface ResolveOptions {
  env?: NodeJS.ProcessEnv;
  /** import.meta.url of the calling module (for package resolution). */
  fromUrl: string;
}

/**
 * Resolve both absolute paths. A missing runtime or artefact, or an artefact
 * whose package version does not match the running CLI, is a named failure.
 */
export function resolveActionRecallRuntime(opts: ResolveOptions): ActionRecallRuntimeResult {
  const env = opts.env ?? process.env;
  const artifactOverride = env.FLAIR_ACTION_RECALL_ARTIFACT;
  let artifactPath: string | null = null;
  if (typeof artifactOverride === "string" && isAbsolute(artifactOverride)) {
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
  if (!artifactPath || !existsSync(artifactPath)) {
    return {
      ok: false,
      reason: `the action-recall artefact ${artifactPath ?? FLAIR_MCP_PACKAGE} is not installed; install ${FLAIR_MCP_PACKAGE} at the same version`,
    };
  }
  const bunPath = resolveBunPath(env);
  if (!bunPath) {
    return { ok: false, reason: "no Bun executable found; install Bun and re-run (or set FLAIR_BUN_PATH)" };
  }
  return { ok: true, runtime: { bunPath, artifactPath } };
}
