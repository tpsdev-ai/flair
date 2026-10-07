/**
 * mcp-oauth-env-core.ts — the dependency-free half of the flair#2270 OAuth
 * redirect-URI handling.
 *
 * `resources/**` may only statically import `src/` helpers that pull in NOTHING
 * of their own (test/unit/resource-src-purity-1775.test.ts): a resource is
 * loaded in the Harper process before the OAuth component resolves its config,
 * and it must not drag a module graph in with it. So the parts the boot guard
 * needs are pure — no `node:fs`, no `node:path` — and live here; the file/env
 * side lives in src/lib/mcp-oauth-env.ts.
 *
 * Nothing here returns or prints a variable VALUE. Names, booleans and the
 * redirect (a public origin) only.
 */

/** The provider whose block the shipped `config.yaml` declares. */
export const SHIPPED_IDP_PROVIDER = "github";

/** Suffixes of the three per-provider variables, matching `buildSecretsBundle`
 *  (src/lib/mcp-enable.ts) and the shipped `config.yaml`. */
export const IDP_CLIENT_ID_SUFFIX = "_CLIENT_ID";
export const IDP_CLIENT_SECRET_SUFFIX = "_CLIENT_SECRET";
export const IDP_REDIRECT_URI_SUFFIX = "_REDIRECT_URI";

/** `OAUTH_<PROVIDER>` — the prefix every IdP variable shares. */
export function idpEnvPrefix(provider: string = SHIPPED_IDP_PROVIDER): string {
  return `OAUTH_${provider.toUpperCase()}`;
}

/** The three variable NAMES for a provider. */
export function idpEnvNames(provider: string = SHIPPED_IDP_PROVIDER): {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
} {
  const prefix = idpEnvPrefix(provider);
  return {
    clientId: `${prefix}${IDP_CLIENT_ID_SUFFIX}`,
    clientSecret: `${prefix}${IDP_CLIENT_SECRET_SUFFIX}`,
    redirectUri: `${prefix}${IDP_REDIRECT_URI_SUFFIX}`,
  };
}

const PLACEHOLDER_RE = /^\$\{[^}]*\}$/;

/** True for an unexpanded whole-token `${VAR}` placeholder (and for blank). A
 *  value like this is "missing" to `@harperfast/oauth`'s `expandEnvVar`. */
export function isUnresolvedEnvValue(value: string | undefined | null): boolean {
  if (value == null) return true;
  const trimmed = value.trim();
  return trimmed === "" || PLACEHOLDER_RE.test(trimmed);
}

/** The strict read of `FLAIR_MCP_OAUTH` flair's own `/mcp` route uses
 *  (`resources/mcp-oauth-flag.ts`): 1/true/yes/on, case-insensitive. */
export function mcpOAuthEnabledIn(env: Record<string, string | undefined>): boolean {
  const raw = (env.FLAIR_MCP_OAUTH ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

/** The issuer an install carries, from either variable flair documents. */
export function issuerFromEnv(env: Record<string, string | undefined>): string | null {
  const raw = (env.FLAIR_MCP_ISSUER ?? env.FLAIR_PUBLIC_URL ?? "").trim();
  if (!raw || PLACEHOLDER_RE.test(raw)) return null;
  return raw;
}

/**
 * The redirect URI for `issuer`: its HTTP(S) origin plus `/oauth`. This is the
 * SAME derivation `buildSecretsBundle` performs, so `flair mcp enable` and the
 * upgrade migration cannot disagree. Null when the issuer is not an HTTP(S)
 * absolute URL.
 */
export function redirectUriForIssuer(issuer: string | null | undefined): string | null {
  if (!issuer) return null;
  let url: URL;
  try {
    url = new URL(issuer.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  return `${url.origin}/oauth`;
}

// ─── Degraded-start guard ────────────────────────────────────────────────────

export interface DegradedGuardDecision {
  /** True when the provider was left unconfigured to keep the instance up. */
  degraded: boolean;
  /** Operator-facing reason naming the missing variable. Never a value. */
  reason?: string;
  /** Variable NAMES removed from the environment to make the provider
   *  unconfigured. Names only. */
  neutralizedVars: string[];
}

/**
 * Boot guard, called before the OAuth component resolves its config.
 *
 * When flair's MCP surface is enabled and the github credentials are staged but
 * `${OAUTH_GITHUB_REDIRECT_URI}` is missing, `@harperfast/oauth` refuses to
 * load the provider and the failure takes the WHOLE instance down (`/health`
 * 500). Losing an instance to a provider that is not fully configured is worse
 * than serving it without that provider, so the guard drops the two credential
 * variables from the environment: the library then skips the provider as
 * unconfigured, the component starts, `/mcp` fails closed, and the instance is
 * DEGRADED rather than down.
 *
 * Pure over the passed env; a no-op unless the variable is missing AND the
 * credentials are present. It never prints or returns a value.
 */
export function guardMcpOAuthEnv(
  env: Record<string, string | undefined>,
  provider: string = SHIPPED_IDP_PROVIDER,
): DegradedGuardDecision {
  if (!mcpOAuthEnabledIn(env)) return { degraded: false, neutralizedVars: [] };
  const names = idpEnvNames(provider);
  if (!isUnresolvedEnvValue(env[names.redirectUri])) return { degraded: false, neutralizedVars: [] };
  const credVars = [names.clientId, names.clientSecret];
  const anyCredential = credVars.some((k) => !isUnresolvedEnvValue(env[k]));
  if (!anyCredential) return { degraded: false, neutralizedVars: [] };
  for (const k of credVars) delete env[k];
  return {
    degraded: true,
    reason: `${names.redirectUri} is not set, so the ${provider} OAuth provider cannot be configured`,
    neutralizedVars: credVars,
  };
}

// ─── flair doctor ────────────────────────────────────────────────────────────

export interface McpRedirectDoctorInput {
  /** True when the instance's process environment has FLAIR_MCP_OAUTH on. */
  mcpEnabled: boolean;
  /** Variable names present in the instance's environment (names only). */
  presentVarNames: readonly string[];
  /** The instance's advertised issuer, or null when it could not be read. */
  advertisedIssuer: string | null;
  provider?: string;
}

export interface McpRedirectDoctorFinding {
  isIssue: boolean;
  message: string;
  fixHint?: string;
}

/**
 * What `flair doctor` should say about the OAuth redirect variable.
 *
 * Reports only the actionable shape: MCP is on, the provider's credentials are
 * staged, and the redirect is absent. Names the missing variable and gives the
 * one-step remedy. When the credentials are absent too the provider is simply
 * unconfigured (the shipped default), which is not a finding.
 */
export function describeMcpRedirectFinding(input: McpRedirectDoctorInput): McpRedirectDoctorFinding | null {
  if (!input.mcpEnabled) return null;
  const provider = input.provider ?? SHIPPED_IDP_PROVIDER;
  const names = idpEnvNames(provider);
  const present = new Set(input.presentVarNames);
  if (present.has(names.redirectUri)) return null;
  const hasCredential = present.has(names.clientId) || present.has(names.clientSecret);
  if (!hasCredential) return null;
  const example = redirectUriForIssuer(input.advertisedIssuer ?? "https://flair.example.com") ?? "https://flair.example.com/oauth";
  return {
    isIssue: true,
    message:
      `MCP OAuth is enabled but ${names.redirectUri} is not set, so the ${provider} ` +
      `provider cannot be configured and MCP auth is unavailable`,
    fixHint:
      `set ${names.redirectUri}=${example} in the instance environment (launchd EnvironmentVariables, systemd Environment=, ` +
      `or the component .env), or re-run: flair mcp enable`,
  };
}
