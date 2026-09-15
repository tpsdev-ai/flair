/**
 * npm-registry.ts — resolve the npm registry to query for a package, the way
 * npm itself would (flair#1688).
 *
 * WHY THIS EXISTS. `flair upgrade`'s update check and Fabric version lookups
 * used to fetch `https://registry.npmjs.org/<pkg>/latest` with a HARDCODED
 * host. A user on a private mirror, an air-gapped registry, or a vetted
 * internal proxy configured through npm never influenced those fetches: the
 * upgrade path compared against the public registry's `latest` (reporting
 * "you are current" when the mirror had a different/newer release) and, in CI,
 * defeated the scoped `@tpsdev-ai:registry` config the macOS launchd lane sets.
 * A supply-chain control (route all installs through the internal mirror) was
 * bypassed by the update check itself.
 *
 * WHAT IT DOES. Given a package name, returns the registry base URL npm would
 * use for it, honouring the same configuration npm does:
 *
 *   1. the `@<scope>:registry` mapping for a scoped package (scope-specific
 *      config beats the default for that scope),
 *   2. the default `registry`,
 *   3. npm's own precedence: env `npm_config_<key>` > project `.npmrc` > user
 *      `.npmrc` > global `.npmrc` > npm's builtin default.
 *
 * Rather than reimplement npm's ini parsing and precedence (which would surely
 * drift from npm), we ask npm: `npm config get <key>` already resolves every
 * layer in the right order. The env layer is read directly first as a fast
 * path so tests (and scripts that export `npm_config_*`) never need a
 * subprocess, but the result is identical to what npm returns.
 *
 * DEFAULT. When nothing is configured — and when npm is absent or errors —
 * this returns npm's public default, `https://registry.npmjs.org`. A user with
 * no registry configured must see exactly the behaviour they saw before this
 * module existed.
 */

import { execFile } from "node:child_process";

/** npm's public default, and the pre-flair#1688 behaviour. No trailing slash. */
export const DEFAULT_NPM_REGISTRY = "https://registry.npmjs.org";

/** Reads one npm config key, or null when unset / npm unavailable. */
export type NpmConfigReader = (key: string) => Promise<string | null>;

/**
 * npm represents "unset" as the literal string `undefined` from
 * `npm config get`, and may pad with whitespace. Normalise all of that, plus a
 * trailing slash, to a clean base URL (or null).
 */
function normalizeRegistryValue(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed === "undefined" || trimmed === "null") return null;
  return trimmed.replace(/\/+$/, "");
}

/**
 * The `@scope` of a package name, or null for unscoped names.
 * `@tpsdev-ai/flair` → `@tpsdev-ai`; `flair` → null.
 *
 * The scope is restricted to npm's legal scope characters. The result is
 * interpolated into an npm config key (and, on Windows, a shell command), so
 * a name that is not a real npm scope must never reach that path.
 */
export function packageScope(packageName: string): string | null {
  if (!packageName.startsWith("@")) return null;
  const slash = packageName.indexOf("/");
  if (slash <= 1) return null;
  const scope = packageName.slice(0, slash);
  return /^@[A-Za-z0-9._~-]+$/.test(scope) ? scope : null;
}

// ─── Default reader: shell out to npm, memoised per process ─────────────────

let configCache: Map<string, Promise<string | null>> | null = null;

function runNpmConfigGet(key: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      process.platform === "win32" ? "npm.cmd" : "npm",
      ["config", "get", key],
      { timeout: 5000, encoding: "utf-8", shell: process.platform === "win32" },
      (err, stdout) => {
        // npm missing, timed out, or errored — treat as "cannot determine".
        // The caller falls back to the public default, never a broken URL.
        if (err) return resolve(null);
        resolve(normalizeRegistryValue(String(stdout)));
      },
    );
  });
}

/**
 * Default `NpmConfigReader`. Each key is asked of npm at most once per process
 * (the config does not change under a running command), so a listing of N
 * packages costs two npm invocations, not 2N.
 */
export function defaultNpmConfigReader(key: string): Promise<string | null> {
  if (!configCache) configCache = new Map();
  const cached = configCache.get(key);
  if (cached) return cached;
  const pending = runNpmConfigGet(key);
  configCache.set(key, pending);
  return pending;
}

/** Drop the memoised npm answers — tests that change registry env between runs. */
export function clearNpmRegistryCache(): void {
  configCache = null;
}

export interface ResolveNpmRegistryDeps {
  /** Environment to read `npm_config_*` from. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** npm config reader. Defaults to `defaultNpmConfigReader`. */
  readConfig?: NpmConfigReader;
}

async function readOrNull(readConfig: NpmConfigReader, key: string): Promise<string | null> {
  try {
    return await readConfig(key);
  } catch {
    // A custom reader must never break version resolution — treat a throw as
    // "unset" and let the fallback (public default) apply.
    return null;
  }
}

/**
 * Resolve the registry base URL for `packageName` the way npm would.
 *
 * Never throws and always returns a usable base URL: on any failure it falls
 * back to `DEFAULT_NPM_REGISTRY`, preserving the pre-flair#1688 behaviour for
 * users who have no registry configured.
 */
export async function resolveNpmRegistry(
  packageName: string,
  deps: ResolveNpmRegistryDeps = {},
): Promise<string> {
  const env = deps.env ?? process.env;
  const readConfig = deps.readConfig ?? defaultNpmConfigReader;

  // Scope mapping first: for a scoped package a configured `@scope:registry`
  // beats the default `registry`, and npm resolves project/user/global files.
  const scope = packageScope(packageName);
  if (scope) {
    const envScoped = normalizeRegistryValue(env[`npm_config_${scope}:registry`]);
    if (envScoped) return envScoped;
    const scoped = normalizeRegistryValue(await readOrNull(readConfig, `${scope}:registry`));
    if (scoped) return scoped;
  }

  // env `npm_config_registry` beats any .npmrc default, so read it before npm.
  const envDefault = normalizeRegistryValue(env.npm_config_registry);
  if (envDefault) return envDefault;

  const configured = normalizeRegistryValue(await readOrNull(readConfig, "registry"));
  return configured ?? DEFAULT_NPM_REGISTRY;
}
