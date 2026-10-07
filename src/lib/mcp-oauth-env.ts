/**
 * mcp-oauth-env.ts — the file/environment half of the flair#2270 OAuth
 * redirect-URI handling: derive the variable, migrate it onto an upgraded
 * install, and report it from `flair doctor`.
 *
 * ── The defect ───────────────────────────────────────────────────────────────
 * The shipped `config.yaml` declares the github provider's credentials AND a
 * whole-token `redirectUri: ${OAUTH_GITHUB_REDIRECT_URI}`. Since
 * `@harperfast/oauth` 2.7.0 a provider with BOTH credentials set must carry a
 * resolvable `redirectUri`; the library throws at config-resolution time
 * (`buildProviderConfig`) when that placeholder is unresolved, the component
 * load fails, Harper registers an error resource at the component path, and the
 * whole HTTP surface — `/health` included — answers 500.
 *
 * An install created by an older `flair mcp enable` has the two credentials in
 * its process environment but never had this variable: the redirect is a later
 * requirement. Upgrading the package therefore left those installs 500ing.
 *
 * The redirect is a DERIVED value: it is always the instance's public origin
 * plus `/oauth`, and the origin is the same one `FLAIR_MCP_ISSUER` already
 * carries. So it can be reconstructed from the issuer rather than asked for
 * again.
 *
 * ── What this module provides ────────────────────────────────────────────────
 *   1. `planRedirectMigration` — the UPGRADE PATH. Derive `<origin>/oauth` from
 *      the issuer the install already has and stage it through the same file
 *      the component's `loadEnv` reads (the `.env` beside the component
 *      `config.yaml`), using the component-env writer and its secret-handling
 *      rules. The value is never returned or printed.
 *   2. `probeAdvertisedIssuer` — read the issuer the running instance advertises
 *      (the CLI is not started inside the instance's environment).
 *   3. `describeMcpRedirectFinding` (re-exported from the pure core) — the
 *      `flair doctor` finding for the missing variable, with the remedy.
 *
 * The boot guard and the pure decisions live in mcp-oauth-env-core.ts, which
 * `resources/**` may import without pulling a module graph into the Harper
 * process.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveHome } from "./home.js";
import {
  SHIPPED_IDP_PROVIDER,
  idpEnvNames,
  isUnresolvedEnvValue,
  issuerFromEnv,
  mcpOAuthEnabledIn,
  redirectUriForIssuer,
} from "./mcp-oauth-env-core.js";

export {
  SHIPPED_IDP_PROVIDER,
  IDP_CLIENT_ID_SUFFIX,
  IDP_CLIENT_SECRET_SUFFIX,
  IDP_REDIRECT_URI_SUFFIX,
  idpEnvPrefix,
  idpEnvNames,
  isUnresolvedEnvValue,
  mcpOAuthEnabledIn,
  issuerFromEnv,
  redirectUriForIssuer,
  guardMcpOAuthEnv,
  describeMcpRedirectFinding,
} from "./mcp-oauth-env-core.js";
export type { DegradedGuardDecision, McpRedirectDoctorInput, McpRedirectDoctorFinding } from "./mcp-oauth-env-core.js";

// ─── Component `.env` (the upgrade writer) ───────────────────────────────────

/** The instance's component `config.yaml`, resolved the way the runtime loads
 *  it: an explicit path, then `./config.yaml`, then `~/.flair/config.yaml`. */
export function resolveInstanceConfigPath(explicitPath?: string): string | null {
  const candidates = explicitPath
    ? [explicitPath]
    : [join(process.cwd(), "config.yaml"), join(resolveHome(), ".flair", "config.yaml")];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** The `.env` beside a component `config.yaml` — the file Harper's `loadEnv`
 *  plugin reads (declared in the shipped config.yaml). Not created here. */
export function componentEnvPathForConfig(configPath: string): string {
  return join(dirname(configPath), ".env");
}

const ASSIGNMENT_RE = /^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=/;

/** The value assigned to `key` in a dotenv text, or null. */
function dotenvValue(text: string | null, key: string): string | null {
  if (!text) return null;
  for (const line of text.split(/\r?\n/)) {
    const m = ASSIGNMENT_RE.exec(line);
    if (!m || m[1] !== key) continue;
    let v = line.slice(line.indexOf("=") + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"') && v.length >= 2) ||
        (v.startsWith("'") && v.endsWith("'") && v.length >= 2)) {
      v = v.slice(1, -1);
    }
    return v;
  }
  return null;
}

/** Append (or replace) `KEY=VALUE` in a dotenv text. Pure; never logs. */
function withAssignment(text: string, key: string, value: string): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  let replaced = false;
  for (const line of lines) {
    if (line.trim() === "" && out.length > 0 && out[out.length - 1] === "") continue;
    const m = ASSIGNMENT_RE.exec(line);
    if (m && m[1] === key) {
      out.push(`${key}=${value}`);
      replaced = true;
    } else {
      out.push(line);
    }
  }
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  if (!replaced) out.push(`${key}=${value}`);
  return `${out.join("\n")}\n`;
}

/** The install-signal variables a dotenv carries, resolved from its text. */
function envFromDotenv(text: string | null): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  if (!text) return out;
  for (const key of ["FLAIR_MCP_OAUTH", "FLAIR_MCP_ISSUER", "FLAIR_PUBLIC_URL"]) {
    out[key] = dotenvValue(text, key) ?? undefined;
  }
  return out;
}

export type RedirectMigrationAction =
  /** Nothing to do: MCP is not enabled on this install. */
  | "not-enabled"
  /** The variable is already set (env or `.env`): never rewritten. */
  | "already-set"
  /** MCP is enabled but the install carries no issuer to derive from. */
  | "no-issuer"
  /** MCP and issuer are present, but no credentials are staged — the shipped
   *  provider is unconfigured, so no redirect is needed. */
  | "no-credentials"
  /** The redirect was staged into the component `.env`. */
  | "staged";

export interface RedirectMigrationResult {
  action: RedirectMigrationAction;
  /** The variable the migration concerns (a name, never a value). */
  redirectVar: string;
  /** The `.env` that was (or would be) written, when one applies. */
  envPath?: string;
  /** True only when a value was written to `envPath`. */
  wrote?: boolean;
}

export interface RedirectMigrationDeps {
  /** Env the install carries; defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Explicit component config path; defaults to the runtime resolution order. */
  configPath?: string;
  /**
   * The issuer the running instance advertises, when a caller could read it
   * (the upgrade path probes `/OAuthMetadata` before restart). Its presence is
   * ALSO the strongest "MCP is enabled" signal available to a CLI that was not
   * started inside the instance's environment.
   */
  advertisedIssuer?: string | null;
}

/**
 * Decide and perform the upgrade-path migration. Reads the `.env` beside the
 * component `config.yaml` (and the process environment) and, when MCP is
 * enabled with staged credentials but no redirect, stages `<origin>/oauth`
 * derived from the issuer through the component `.env` — the file the shipped
 * `config.yaml`'s `loadEnv` reads before the OAuth component resolves.
 *
 * Idempotent: an already-set value (in the `.env` or the environment) is left
 * verbatim. Returns names and booleans only — the value is written, never
 * surfaced.
 */
export function planRedirectMigration(
  deps: RedirectMigrationDeps = {},
  provider: string = SHIPPED_IDP_PROVIDER,
): RedirectMigrationResult {
  const env = deps.env ?? (process.env as Record<string, string | undefined>);
  const names = idpEnvNames(provider);
  const configPath = deps.configPath ?? resolveInstanceConfigPath();
  const envPath = configPath ? componentEnvPathForConfig(configPath) : undefined;
  const envText = envPath && existsSync(envPath) ? safeRead(envPath) : null;

  // Already present anywhere -> leave it alone.
  const envValue = dotenvValue(envText, names.redirectUri);
  if (!isUnresolvedEnvValue(envValue) || !isUnresolvedEnvValue(env[names.redirectUri])) {
    return { action: "already-set", redirectVar: names.redirectUri, envPath };
  }
  const advertised = deps.advertisedIssuer ? deps.advertisedIssuer.trim() : null;
  const enabledInEnv = mcpOAuthEnabledIn(env) || mcpOAuthEnabledIn(envFromDotenv(envText));
  if (!enabledInEnv && !advertised) {
    return { action: "not-enabled", redirectVar: names.redirectUri, envPath };
  }
  const issuer = advertised ?? issuerFromEnv(env) ?? issuerFromEnv(envFromDotenv(envText));
  const redirect = redirectUriForIssuer(issuer);
  if (!redirect) return { action: "no-issuer", redirectVar: names.redirectUri, envPath };
  // A probed issuer means the AS is already up, so a provider is configured and
  // the redirect is needed. Without a probe, only stage when the install
  // actually has the provider credentials; an install with none has nothing to
  // configure.
  if (!advertised) {
    const credsStaged =
      !isUnresolvedEnvValue(dotenvValue(envText, names.clientId)) ||
      !isUnresolvedEnvValue(env[names.clientId]) ||
      !isUnresolvedEnvValue(dotenvValue(envText, names.clientSecret)) ||
      !isUnresolvedEnvValue(env[names.clientSecret]);
    if (!credsStaged) return { action: "no-credentials", redirectVar: names.redirectUri, envPath };
  }

  if (!configPath || !envPath) return { action: "no-issuer", redirectVar: names.redirectUri };
  applyRedirect(envPath, withAssignment(envText ?? "", names.redirectUri, redirect));
  return { action: "staged", redirectVar: names.redirectUri, envPath, wrote: true };
}

/** Read the issuer a running instance advertises at `/OAuthMetadata`, or null.
 *  A failed or malformed probe returns null so the caller never mistakes an
 *  unreadable state for a value. */
export async function probeAdvertisedIssuer(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 5000,
): Promise<string | null> {
  try {
    const res = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}/OAuthMetadata`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const doc = (await res.json()) as { issuer?: unknown };
    return typeof doc?.issuer === "string" && doc.issuer.trim() !== "" ? doc.issuer : null;
  } catch {
    return null;
  }
}

/** One operator-facing line for a migration result. Never a value. */
export function renderRedirectMigration(result: RedirectMigrationResult): string | null {
  switch (result.action) {
    case "staged":
      return `MCP OAuth: staged ${result.redirectVar} for the ${SHIPPED_IDP_PROVIDER} provider (${result.envPath}).`;
    case "no-issuer":
      return `MCP OAuth: ${result.redirectVar} is missing and no public origin was available to derive it — set it in the instance environment, or re-run: flair mcp enable`;
    case "not-enabled":
    case "already-set":
    case "no-credentials":
      return null;
  }
}

function safeRead(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

/** Write the `.env` with the component-env rules: `0600`, parent created, no
 *  value echoed. */
function applyRedirect(envPath: string, text: string): void {
  mkdirSync(dirname(envPath), { recursive: true });
  writeFileSync(envPath, text, { mode: 0o600 });
  chmodSync(envPath, 0o600);
}
