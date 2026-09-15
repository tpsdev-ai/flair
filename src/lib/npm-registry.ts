/**
 * npm-registry.ts — resolve the npm registry to query for a package, the way
 * npm itself would, and fetch from it with npm's security boundaries applied
 * (flair#1688, security review flair#1692).
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
 * drift from npm), we ask npm: `npm config list` already resolves every layer
 * in the right order, and — unlike `npm config get` — its per-section headers
 * let us name the layer a value came from, so the operator can SEE a
 * redirected registry (`registry: … (source: user .npmrc …)`). The env layer
 * is read directly too, as a fast path so tests (and scripts that export
 * `npm_config_*`) never need a subprocess.
 *
 * SECURITY BOUNDARIES (flair#1692). This module is where every version
 * decision flows through, so the resolver is the right chokepoint:
 *
 *   - SCHEME ALLOWLIST. Only `https:` is fetched by default. `http:` is
 *     allowed ONLY for a loopback host (127.0.0.1 / localhost / ::1) — the CI
 *     lane's registry — or when the operator explicitly opts in with
 *     `FLAIR_ALLOW_INSECURE_REGISTRY=1`, in which case the resolution is
 *     reported as INSECURE. `file:`/`ftp:`/anything else is refused outright.
 *     A refusal names the actor, the state, and the remedy; it is never silent.
 *
 *   - SEMVER VALIDATION. A registry may return any string as `latest`, and npm
 *     accepts `pkg@https://attacker/x.tgz` as a remote-tarball install spec.
 *     So a fetched version is validated as strict semver BEFORE it can be used
 *     as an install spec (see `isStrictSemver` / `fetchLatestVersion`). A
 *     non-semver value is refused and printed, never installed.
 *
 *   - REDIRECTS. The version fetch passes `redirect: "error"`: a 302 from an
 *     allowed registry cannot silently land on a disallowed host, which would
 *     otherwise bypass the scheme allowlist.
 *
 *   - TRANSPORT. A bare `fetch()` cannot honour npm's `strict-ssl` / `cafile`
 *     / `_authToken`. When the configured registry is a NON-default mirror
 *     (i.e. not the public npmjs default) AND npm has transport config we
 *     cannot replicate, the lookup is delegated to
 *     `npm view <pkg> version --json --registry <url>`, which gets URL, TLS
 *     trust, and auth from npm in one step. This is the reviewer's preferred
 *     transport (flair#1692 item 4). For the public default npmjs registry we
 *     fetch anonymously — public reads need no trust config — and the residual
 *     gap is: a custom CA/auth token set for a registry OTHER than the
 *     configured one is not carried. `_authToken` cannot be read back anyway:
 *     npm marks auth options "protected" and refuses to print them.
 *
 * DEFAULT. When nothing is configured — and when npm is absent or errors —
 * this returns npm's public default, `https://registry.npmjs.org`. A user with
 * no registry configured must see exactly the behaviour they saw before this
 * module existed.
 */

import { execFile } from "node:child_process";

/** npm's public default, and the pre-flair#1688 behaviour. No trailing slash. */
export const DEFAULT_NPM_REGISTRY = "https://registry.npmjs.org";

/**
 * Opt-in for a deliberately plain-http registry that is not loopback. Any
 * other non-https scheme is refused even with this set (flair#1692).
 */
export const INSECURE_REGISTRY_ENV = "FLAIR_ALLOW_INSECURE_REGISTRY";

/** npm config layers, in the order npm prints them (later wins). */
export type NpmConfigLayer = "env" | "cli" | "project" | "user" | "global" | "builtin" | "publish" | "unknown";

/** One resolved npm config value plus the layer it came from. */
export interface NpmConfigEntry {
  value: string;
  layer: NpmConfigLayer;
  /** Human label naming the file/scope, e.g. "user .npmrc (/home/u/.npmrc)". */
  source: string;
}

/** Reads one npm config key (value + source), or null when unset/unavailable. */
export type NpmConfigEntryReader = (key: string) => Promise<NpmConfigEntry | null>;

/** The fully-resolved registry for a package, plus how it was chosen. */
export interface RegistryResolution {
  /** Registry base URL, no trailing slash. */
  url: string;
  /** Where the value came from (env / scope mapping / .npmrc layer / default). */
  source: string;
  /** True only when a non-https registry was permitted by the explicit opt-in. */
  insecure: boolean;
}

/** Read-only view of every npm config value, keyed by config key. */
export type NpmConfigEntries = ReadonlyMap<string, NpmConfigEntry>;

/**
 * Thrown when the configured registry is not allowed. The message already
 * contains actor + state + remedy, so callers only have to print it.
 */
export class RegistryRefusalError extends Error {
  readonly rawUrl: string;
  readonly source: string;
  constructor(message: string, rawUrl: string, source: string) {
    super(message);
    this.name = "RegistryRefusalError";
    this.rawUrl = rawUrl;
    this.source = source;
  }
}

// ─── npm config: value + source ─────────────────────────────────────────────

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

function describeConfigLayer(layer: NpmConfigLayer, from: string): string {
  switch (layer) {
    case "env":
      return "env";
    case "cli":
      return "command line";
    case "project":
      return `project .npmrc (${from})`;
    case "user":
      return `user .npmrc (${from})`;
    case "global":
      return `global .npmrc (${from})`;
    case "builtin":
      return "npm builtin";
    default:
      return from || "npm config";
  }
}

/**
 * Parse the human output of `npm config list` into key → {value, source}.
 *
 * Only non-default config is printed, grouped under section headers such as
 * `; "project" config from /path/.npmrc`. Values already overridden by a
 * higher layer are printed COMMENTED OUT (`; registry = … ; overridden by …`),
 * so the single active line per key wins — which is exactly npm's precedence.
 * `publishConfig` values are publish-time only and are ignored.
 *
 * Exported for the unit tests that pin the parse without spawning npm.
 */
export function parseNpmConfigList(stdout: string): Map<string, NpmConfigEntry> {
  const entries = new Map<string, NpmConfigEntry>();
  let layer: NpmConfigLayer = "unknown";
  let source = "npm config";
  let ignore = false;

  for (const rawLine of String(stdout).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "") continue;

    const header = line.match(/^;\s*"([^"]+)"(?:\s+config)?\s+from\s+(.+)$/);
    if (header) {
      const name = header[1];
      const from = header[2].trim();
      if (name === "publishConfig") {
        ignore = true;
        layer = "publish";
        source = from;
        continue;
      }
      ignore = false;
      const knownLayers = ["env", "cli", "project", "user", "global", "builtin"] as const;
      layer = (knownLayers as readonly string[]).includes(name)
        ? (name as (typeof knownLayers)[number])
        : "unknown";
      source = describeConfigLayer(layer, from);
      continue;
    }

    // Comments (including overridden values) and the trailing node-version
    // footer are not config we can use.
    if (line.startsWith(";")) continue;
    if (ignore) continue;

    const m = line.match(/^([^=]+?)\s*=\s*(.*)$/);
    if (!m) continue;
    const key = m[1].trim();
    let value = m[2].trim();
    // npm redacts auth in `npm config list`; presence is all we need.
    if (value === "(protected)") value = "";
    else if (value.startsWith('"') && value.endsWith('"')) {
      try {
        value = JSON.parse(value) as string;
      } catch {
        value = value.slice(1, -1);
      }
    }
    entries.set(key, { value, layer, source });
  }
  return entries;
}

// ─── Default readers: ask npm, memoised per process ─────────────────────────

let entriesCache: Promise<Map<string, NpmConfigEntry>> | null = null;

function runNpmConfigList(): Promise<Map<string, NpmConfigEntry>> {
  return new Promise((resolve) => {
    execFile(
      process.platform === "win32" ? "npm.cmd" : "npm",
      ["config", "list"],
      { timeout: 5000, encoding: "utf-8", shell: process.platform === "win32" },
      (err, stdout) => {
        // npm missing, timed out, or errored — treat as "cannot determine".
        // The caller falls back to the public default, never a broken URL.
        if (err) return resolve(new Map());
        try {
          resolve(parseNpmConfigList(String(stdout)));
        } catch {
          resolve(new Map());
        }
      },
    );
  });
}

/**
 * Every explicitly-set npm config value, resolved once per process (the config
 * does not change under a running command).
 */
export function defaultNpmConfigEntries(): Promise<Map<string, NpmConfigEntry>> {
  if (!entriesCache) entriesCache = runNpmConfigList();
  return entriesCache;
}

/** Default `NpmConfigEntryReader` — one key from the memoised config map. */
export async function defaultNpmConfigEntryReader(key: string): Promise<NpmConfigEntry | null> {
  const entries = await defaultNpmConfigEntries();
  return entries.get(key) ?? null;
}

/** Drop the memoised npm answers — tests that change registry env between runs. */
export function clearNpmRegistryCache(): void {
  entriesCache = null;
}

// ─── Scheme allowlist ───────────────────────────────────────────────────────

/** The loopback hosts `http:` is allowed for without an opt-in (CI lane). */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return h === "127.0.0.1" || h === "localhost" || h === "::1";
}

function insecureOptedIn(env: NodeJS.ProcessEnv): boolean {
  const raw = (env[INSECURE_REGISTRY_ENV] ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

function buildRegistryRefusal(rawUrl: string, source: string, problem: string, scheme: string | null): string {
  const actor = `the npm registry is configured as ${JSON.stringify(rawUrl)} (source: ${source})`;
  const state = scheme === "http:"
    ? "Flair only queries registries over https; plain http is allowed only for a loopback host (127.0.0.1, localhost, ::1)."
    : `Flair refuses the "${scheme ?? "unknown"}" scheme for a registry — only http(s) is considered at all.`;
  const remedy = scheme === "http:"
    ? `Point \`registry\` / \`@scope:registry\` at an https URL, or set ${INSECURE_REGISTRY_ENV}=1 to allow this plain-http registry deliberately (file:/ftp: are never allowed).`
    : "Point `registry` / `@scope:registry` at an https URL.";
  return `Refusing npm registry: ${problem}.\n  actor: ${actor}\n  state: ${state}\n  remedy: ${remedy}`;
}

/**
 * Validate a normalized registry URL against the scheme allowlist.
 *
 * Returns the resolution on success (with `insecure` set when the explicit
 * opt-in permitted a non-loopback `http:` registry) and throws a
 * `RegistryRefusalError` whose message carries actor + state + remedy.
 */
export function validateRegistryUrl(rawUrl: string, source: string, env: NodeJS.ProcessEnv = process.env): RegistryResolution {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new RegistryRefusalError(
      buildRegistryRefusal(rawUrl, source, "it is not a valid URL", null),
      rawUrl,
      source,
    );
  }

  const scheme = parsed.protocol.toLowerCase();
  if (scheme === "https:") {
    return { url: rawUrl, source, insecure: false };
  }
  if (scheme === "http:") {
    if (isLoopbackHost(parsed.hostname)) {
      return { url: rawUrl, source, insecure: false };
    }
    if (insecureOptedIn(env)) {
      return { url: rawUrl, source, insecure: true };
    }
    throw new RegistryRefusalError(
      buildRegistryRefusal(rawUrl, source, "plain http is not allowed for a non-loopback host", scheme),
      rawUrl,
      source,
    );
  }
  throw new RegistryRefusalError(
    buildRegistryRefusal(
      rawUrl,
      source,
      `the "${scheme}" scheme is never fetched`,
      scheme,
    ),
    rawUrl,
    source,
  );
}

// ─── Resolution ─────────────────────────────────────────────────────────────

export interface ResolveNpmRegistryDeps {
  /** Environment to read `npm_config_*` from. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** npm config reader. Defaults to `defaultNpmConfigEntryReader`. */
  readConfig?: NpmConfigEntryReader;
  /** Whole-config view, for transport-config detection in the fetch helpers. */
  readConfigMap?: () => Promise<NpmConfigEntries>;
}

async function readEntry(
  readConfig: NpmConfigEntryReader,
  key: string,
): Promise<NpmConfigEntry | null> {
  try {
    const entry = await readConfig(key);
    if (!entry) return null;
    const value = normalizeRegistryValue(entry.value);
    if (!value) return null;
    return { ...entry, value };
  } catch {
    // A custom reader must never break version resolution — treat a throw as
    // "unset" and let the fallback (public default) apply.
    return null;
  }
}

/**
 * Resolve the registry for `packageName` together with HOW it was chosen, and
 * validate its scheme. Throws `RegistryRefusalError` for a disallowed scheme.
 */
export async function resolveNpmRegistryDetailed(
  packageName: string,
  deps: ResolveNpmRegistryDeps = {},
): Promise<RegistryResolution> {
  const env = deps.env ?? process.env;
  const readConfig = deps.readConfig ?? defaultNpmConfigEntryReader;

  // Scope mapping first: for a scoped package a configured `@scope:registry`
  // beats the default `registry`, and npm resolves project/user/global files.
  const scope = packageScope(packageName);
  if (scope) {
    const envScoped = normalizeRegistryValue(env[`npm_config_${scope}:registry`]);
    if (envScoped) {
      return validateRegistryUrl(envScoped, `env npm_config_${scope}:registry`, env);
    }
    const scoped = await readEntry(readConfig, `${scope}:registry`);
    if (scoped) {
      return validateRegistryUrl(scoped.value, `${scope}:registry (${scoped.source})`, env);
    }
  }

  // env `npm_config_registry` beats any .npmrc default, so read it before npm.
  const envDefault = normalizeRegistryValue(env.npm_config_registry);
  if (envDefault) {
    return validateRegistryUrl(envDefault, "env npm_config_registry", env);
  }

  const configured = await readEntry(readConfig, "registry");
  if (configured) {
    return validateRegistryUrl(configured.value, `registry (${configured.source})`, env);
  }

  return validateRegistryUrl(DEFAULT_NPM_REGISTRY, "default npm public registry", env);
}

/**
 * Resolve the registry base URL for `packageName` the way npm would, without
 * the source metadata. Throws `RegistryRefusalError` for a disallowed scheme.
 */
export async function resolveNpmRegistry(
  packageName: string,
  deps: ResolveNpmRegistryDeps = {},
): Promise<string> {
  return (await resolveNpmRegistryDetailed(packageName, deps)).url;
}

/** One operator-facing line naming the registry and where it came from. */
export function formatRegistryLine(res: RegistryResolution): string {
  const flag = res.insecure ? " [INSECURE]" : "";
  return `registry: ${res.url} (source: ${res.source})${flag}`;
}

/**
 * A printer that emits each distinct registry line once per process, so a
 * listing that resolves the same registry for N packages prints one line.
 */
export function createRegistryNoticePrinter(
  sink: (line: string) => void = (line) => console.log(line),
): (res: RegistryResolution) => void {
  const seen = new Set<string>();
  return (res) => {
    const line = formatRegistryLine(res);
    if (seen.has(line)) return;
    seen.add(line);
    sink(line);
  };
}

/**
 * Resolve + validate for a caller that only wants to REPORT the registry
 * (status/doctor). Never throws: a refusal comes back as `error`.
 */
export async function resolveRegistryNotice(
  packageName: string,
  deps: ResolveNpmRegistryDeps = {},
): Promise<{ line: string | null; error: string | null }> {
  try {
    const res = await resolveNpmRegistryDetailed(packageName, deps);
    return { line: formatRegistryLine(res), error: null };
  } catch (err) {
    if (err instanceof RegistryRefusalError) return { line: null, error: err.message };
    return { line: null, error: err instanceof Error ? err.message : String(err) };
  }
}

// ─── Strict semver ──────────────────────────────────────────────────────────

/**
 * The semver.org regex, exact. A registry value must match this before it can
 * be used as an `npm install` spec: npm accepts `pkg@<url>` as a remote-tarball
 * spec, so a hostile/compromised registry returning a URL as `latest` would
 * otherwise turn the update check into an arbitrary install (flair#1692).
 */
const STRICT_SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

/** True when `value` is a strict semver version (not a range, tag, or URL). */
export function isStrictSemver(value: unknown): value is string {
  return typeof value === "string" && STRICT_SEMVER.test(value.trim());
}

// ─── Transport config (for the fetch fallback) ──────────────────────────────

export interface RegistryTransportConfig {
  strictSsl: boolean;
  cafile: string | null;
  ca: string | null;
  /** npm config key holding the token, when one is configured (value redacted). */
  authTokenKey: string | null;
}

function boolValue(value: string | undefined): boolean {
  return value == null ? true : !/^(false|0|no)$/i.test(value.trim());
}

/**
 * The npm auth-config key that applies to `registryUrl`, or null. npm stores a
 * registry token as `//host/path/:_authToken` (longest matching prefix wins),
 * plus a legacy unscoped `_authToken`. npm refuses to print the VALUE; we only
 * need to know one exists so we can delegate to `npm view` (flair#1692 item 4).
 */
export function registryAuthTokenKey(registryUrl: string, entries: NpmConfigEntries): string | null {
  if (entries.has("_authToken")) return "_authToken";
  let parsed: URL;
  try {
    parsed = new URL(registryUrl);
  } catch {
    return null;
  }
  const hostPath = `//${parsed.host}${parsed.pathname.replace(/\/+$/, "")}/`;
  let best: string | null = null;
  for (const key of entries.keys()) {
    if (!key.endsWith(":_authToken")) continue;
    const prefix = key.slice(0, -":_authToken".length);
    if (!prefix.endsWith("/")) continue;
    if (!hostPath.startsWith(prefix) && !prefix.startsWith(hostPath)) continue;
    if (best === null || prefix.length > best.length - ":_authToken".length) best = key;
  }
  return best;
}

/** Read npm's transport trust config (TLS + auth) for the fetch decision. */
export async function readRegistryTransport(
  registryUrl: string,
  deps: ResolveNpmRegistryDeps = {},
): Promise<RegistryTransportConfig> {
  const readConfig = deps.readConfig ?? defaultNpmConfigEntryReader;
  const readMap = deps.readConfigMap ?? defaultNpmConfigEntries;
  const strictSsl = boolValue((await readEntry(readConfig, "strict-ssl"))?.value);
  const cafile = (await readEntry(readConfig, "cafile"))?.value ?? null;
  const ca = (await readEntry(readConfig, "ca"))?.value ?? null;
  let authTokenKey: string | null = null;
  try {
    authTokenKey = registryAuthTokenKey(registryUrl, await readMap());
  } catch {
    authTokenKey = null;
  }
  return { strictSsl, cafile, ca, authTokenKey };
}

/**
 * True when the transport config cannot be honoured by a bare `fetch()` and
 * the lookup must go through npm (`npm view`). Covers a custom CA, a disabled
 * TLS check, and a configured registry auth token.
 */
export function registryNeedsNpmTransport(config: RegistryTransportConfig): boolean {
  return !config.strictSsl || config.cafile != null || config.ca != null || config.authTokenKey != null;
}

// ─── Fetching ───────────────────────────────────────────────────────────────

export interface FetchRegistryDeps extends ResolveNpmRegistryDeps {
  timeoutMs?: number;
  /** Injectable fetch — tests mock `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
  /** Called with the validated registry as soon as it is resolved. */
  onRegistry?: (res: RegistryResolution) => void;
}

export type LatestVersionResult =
  | { kind: "ok"; version: string; registry: RegistryResolution }
  /** The registry answered, but with a non-semver value. Never an install spec. */
  | { kind: "invalid"; value: string; registry: RegistryResolution }
  /** The configured registry is disallowed; message carries actor/state/remedy. */
  | { kind: "refused"; message: string }
  /** Offline, timeout, non-2xx, bad JSON, or npm unavailable. */
  | { kind: "unavailable"; message: string; registry: RegistryResolution };

export type DeclaredDependenciesResult =
  | { kind: "ok"; dependencies: Record<string, string> | null; registry: RegistryResolution }
  | { kind: "refused"; message: string }
  | { kind: "unavailable"; message: string; registry: RegistryResolution };

interface JsonFetchResult {
  ok: boolean;
  data?: unknown;
  message: string;
}

/**
 * GET a registry URL as JSON with redirects REFUSED. `redirect: "error"` is
 * load-bearing: without it a 302 from an allow-listed registry would silently
 * land on a disallowed host (flair#1692 item 5).
 */
async function fetchRegistryJson(
  url: string,
  timeoutMs: number,
  fetchImpl?: typeof fetch,
): Promise<JsonFetchResult> {
  const doFetch: typeof fetch = fetchImpl ?? fetch;
  try {
    const res = await doFetch(url, {
      redirect: "error",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { ok: false, message: `registry returned HTTP ${res.status}` };
    return { ok: true, data: await res.json(), message: "" };
  } catch (err) {
    const message = err instanceof Error && err.message ? err.message : "registry fetch failed";
    return { ok: false, message };
  }
}

function npmBin(): string {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

/**
 * `npm view <spec> <field> --json`. Used when npm transport config (CA, TLS
 * override, auth token) cannot be replicated by `fetch()`.
 */
function runNpmViewJson(
  spec: string,
  field: string,
  registryUrl: string,
  timeoutMs: number,
): Promise<JsonFetchResult> {
  return new Promise((resolve) => {
    execFile(
      npmBin(),
      ["view", spec, field, "--json", "--registry", registryUrl],
      { timeout: timeoutMs, encoding: "utf-8", shell: process.platform === "win32" },
      (err, stdout, stderr) => {
        if (err) {
          const message = String(stderr || err.message || "npm view failed").trim();
          return resolve({ ok: false, message });
        }
        try {
          resolve({ ok: true, data: JSON.parse(String(stdout).trim()), message: "" });
        } catch {
          resolve({ ok: false, message: "npm view returned non-JSON output" });
        }
      },
    );
  });
}

/** True when this registry should be queried through npm rather than fetch(). */
async function useNpmTransport(
  registry: RegistryResolution,
  deps: FetchRegistryDeps,
): Promise<boolean> {
  if (registry.url === DEFAULT_NPM_REGISTRY) return false;
  const transport = await readRegistryTransport(registry.url, deps);
  return registryNeedsNpmTransport(transport);
}

/**
 * Resolve the registry for `packageName` and fetch its `latest` dist-tag,
 * validating the result as strict semver before returning it. Never throws for
 * a refusal or a network failure — those come back as discriminated results so
 * every caller can decide whether to skip, warn, or abort.
 */
export async function fetchLatestVersion(
  packageName: string,
  deps: FetchRegistryDeps = {},
): Promise<LatestVersionResult> {
  let registry: RegistryResolution;
  try {
    registry = await resolveNpmRegistryDetailed(packageName, deps);
  } catch (err) {
    if (err instanceof RegistryRefusalError) return { kind: "refused", message: err.message };
    return { kind: "refused", message: err instanceof Error ? err.message : String(err) };
  }
  deps.onRegistry?.(registry);

  const timeoutMs = deps.timeoutMs ?? 5000;
  let raw: string | null = null;

  if (await useNpmTransport(registry, deps)) {
    const out = await runNpmViewJson(packageName, "version", registry.url, timeoutMs);
    if (!out.ok) return { kind: "unavailable", message: out.message, registry };
    if (typeof out.data === "string") raw = out.data;
  } else {
    const out = await fetchRegistryJson(`${registry.url}/${packageName}/latest`, timeoutMs, deps.fetchImpl);
    if (!out.ok) return { kind: "unavailable", message: out.message, registry };
    const data = out.data as { version?: unknown } | null;
    if (data && typeof data.version === "string") raw = data.version;
  }

  if (raw == null || raw.trim() === "") {
    return { kind: "unavailable", message: "registry response had no version", registry };
  }
  const value = raw.trim();
  if (!isStrictSemver(value)) return { kind: "invalid", value, registry };
  return { kind: "ok", version: value, registry };
}

/**
 * Resolve the registry for `packageName` and fetch the declared `dependencies`
 * map for `version`. Used to decide the Harper engine version a target flair
 * release declares, so the same registry/auth/TLS path is used.
 */
export async function fetchDeclaredDependencies(
  packageName: string,
  version: string,
  deps: FetchRegistryDeps = {},
): Promise<DeclaredDependenciesResult> {
  let registry: RegistryResolution;
  try {
    registry = await resolveNpmRegistryDetailed(packageName, deps);
  } catch (err) {
    if (err instanceof RegistryRefusalError) return { kind: "refused", message: err.message };
    return { kind: "refused", message: err instanceof Error ? err.message : String(err) };
  }
  deps.onRegistry?.(registry);

  const timeoutMs = deps.timeoutMs ?? 5000;
  let data: unknown;

  if (await useNpmTransport(registry, deps)) {
    const out = await runNpmViewJson(`${packageName}@${version}`, "dependencies", registry.url, timeoutMs);
    if (!out.ok) return { kind: "unavailable", message: out.message, registry };
    data = out.data;
  } else {
    const out = await fetchRegistryJson(`${registry.url}/${packageName}/${version}`, timeoutMs, deps.fetchImpl);
    if (!out.ok) return { kind: "unavailable", message: out.message, registry };
    data = out.data;
  }

  const depsField = (data as { dependencies?: unknown } | null)?.dependencies;
  const dependencies =
    depsField && typeof depsField === "object" && !Array.isArray(depsField)
      ? (depsField as Record<string, string>)
      : null;
  return { kind: "ok", dependencies, registry };
}
