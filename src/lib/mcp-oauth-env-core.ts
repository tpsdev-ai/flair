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

export function issuerFromEnv(env: Record<string, string | undefined>): string | null {
  const raw = env.FLAIR_MCP_ISSUER;
  return isUnresolvedEnvValue(raw) ? null : raw!.trim();
}

export function validateRedirectIssuer(issuer: string | null | undefined): { redirect: string | null; reason?: string } {
  if (isUnresolvedEnvValue(issuer)) return { redirect: null, reason: "missing-issuer" };
  let url: URL;
  try { url = new URL(issuer!); } catch { return { redirect: null, reason: "invalid-origin" }; }
  if (url.username || url.password || /^[a-z]+:\/\/[^/?#]*@/i.test(issuer!.trim())) return { redirect: null, reason: "origin-has-userinfo" };
  if (issuer!.includes("\\")) return { redirect: null, reason: "origin-has-path" };
  if (url.search) return { redirect: null, reason: "origin-has-query" };
  if (url.hash) return { redirect: null, reason: "origin-has-fragment" };
  const suffix = /^[a-z]+:\/\/[^/?#]+(.*)$/i.exec(issuer!.trim())?.[1];
  if (suffix !== "" && suffix !== "/") return { redirect: null, reason: "origin-has-path" };
  const loopback = url.hostname === "localhost" || url.hostname === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    return { redirect: null, reason: "origin-requires-https" };
  }
  return { redirect: `${url.origin}/oauth` };
}

export function redirectUriForIssuer(issuer: string | null | undefined): string | null {
  return validateRedirectIssuer(issuer).redirect;
}

export interface McpProviderReadiness {
  credentialsPresent: boolean;
  redirectPresent: boolean;
}

export function readMcpProviderReadiness(env: Record<string, string | undefined>, provider = SHIPPED_IDP_PROVIDER): McpProviderReadiness {
  const names = idpEnvNames(provider);
  return {
    credentialsPresent: !isUnresolvedEnvValue(env[names.clientId]) && !isUnresolvedEnvValue(env[names.clientSecret]),
    redirectPresent: !isUnresolvedEnvValue(env[names.redirectUri]),
  };
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

export function guardMcpOAuthEnv(
  env: Record<string, string | undefined>,
  provider: string = SHIPPED_IDP_PROVIDER,
): DegradedGuardDecision {
  const names = idpEnvNames(provider);
  if (!isUnresolvedEnvValue(env[names.redirectUri])) return { degraded: false, neutralizedVars: [] };
  const credVars = [names.clientId, names.clientSecret];
  const credentialsPresent = credVars.every((k) => !isUnresolvedEnvValue(env[k]));
  if (!credentialsPresent) return { degraded: false, neutralizedVars: [] };
  for (const k of credVars) delete env[k];
  return {
    degraded: true,
    reason: `${names.redirectUri} is not set, so the ${provider} OAuth provider cannot be configured`,
    neutralizedVars: credVars,
  };
}

// ─── flair doctor ────────────────────────────────────────────────────────────

export interface McpRedirectDoctorFinding {
  isIssue: boolean;
  message: string;
  fixHint?: string;
}

export function describeMcpRedirectFinding(readiness: McpProviderReadiness | null): McpRedirectDoctorFinding | null {
  if (!readiness) return { isIssue: false, message: "MCP OAuth redirect: cannot verify target configuration" };
  if (!readiness.credentialsPresent || readiness.redirectPresent) return null;
  const names = idpEnvNames();
  return {
    isIssue: true,
    message: `${names.redirectUri} is missing from the target's github OAuth configuration`,
    fixHint: `set ${names.redirectUri} in the instance environment, or re-run: flair mcp enable; then restart`,
  };
}
export function parseMcpComponentEnv(text: string): Record<string, string> {
  const assignments = /^\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?$/gm;
  const values: Record<string, string> = {};
  for (const match of text.replace(/\r\n?/g, "\n").matchAll(assignments)) {
    let value = (match[2] ?? "").trim();
    const quote = value[0];
    value = value.replace(/^(['"`])([\s\S]*)\1$/gm, "$2");
    if (quote === '"') value = value.replace(/\\n/g, "\n").replace(/\\r/g, "\r");
    values[match[1]!] = value;
  }
  return values;
}
