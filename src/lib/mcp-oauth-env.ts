import { chmodSync, existsSync, lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import {
  SHIPPED_IDP_PROVIDER,
  idpEnvNames,
  isUnresolvedEnvValue,
  issuerFromEnv,
  mcpOAuthEnabledIn,
  validateRedirectIssuer,
  describeMcpRedirectFinding,
  parseMcpComponentEnv,
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
  validateRedirectIssuer,
  readMcpProviderReadiness,
  guardMcpOAuthEnv,
  describeMcpRedirectFinding,
} from "./mcp-oauth-env-core.js";
export type { DegradedGuardDecision, McpProviderReadiness, McpRedirectDoctorFinding } from "./mcp-oauth-env-core.js";

// ─── Component `.env` (the upgrade writer) ───────────────────────────────────

/** Search only the explicit path, or `./config.yaml` when no path is supplied. */
export function resolveInstanceConfigPath(explicitPath?: string): string | null {
  const candidates = explicitPath
    ? [explicitPath]
    : [join(process.cwd(), "config.yaml")];
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

const ASSIGNMENT_RE = /^[ \t]*(?:export[ \t]+)?([\w.-]+)[ \t]*(?:=|:[ \t]+)/;

export type RedirectMigrationAction = "not-enabled" | "already-set" | "no-issuer" | "no-credentials" | "refused" | "staged";

export interface RedirectMigrationResult {
  action: RedirectMigrationAction;
  /** The variable the migration concerns (a name, never a value). */
  redirectVar: string;
  /** The `.env` that was (or would be) written, when one applies. */
  envPath?: string;
  /** True only when a value was written to `envPath`. */
  wrote?: boolean;
  reason?: string;
}

export interface RedirectMigrationDeps {
  env?: Record<string, string | undefined>;
  configPath?: string;
}

export function planRedirectMigration(
  deps: RedirectMigrationDeps = {},
  provider: string = SHIPPED_IDP_PROVIDER,
): RedirectMigrationResult {
  const names = idpEnvNames(provider);
  const configPath = deps.configPath ?? resolveInstanceConfigPath();
  const envPath = configPath ? componentEnvPathForConfig(configPath) : undefined;
  const result = { redirectVar: names.redirectUri, envPath };
  if (!envPath) return { ...result, action: "refused", reason: "missing-config" };
  let envText = "";
  let mode = 0o600;
  let existingFile = false;
  try {
    const stat = lstatSync(envPath);
    existingFile = true;
    if (!stat.isFile() || (stat.mode & 0o444) === 0) return { ...result, action: "refused", reason: "unreadable-env" };
    mode = stat.mode & 0o7777;
    envText = readFileSync(envPath, "utf-8");
  } catch (err) {
    if (existingFile || (err as NodeJS.ErrnoException).code !== "ENOENT") return { ...result, action: "refused", reason: "unreadable-env" };
  }
  const tracked = new Set(["FLAIR_MCP_OAUTH", "FLAIR_MCP_ISSUER", ...Object.values(names)]);
  const assignments = new Set<string>();
  const envLines = envText.replace(/\r\n?/g, "\n").split("\n");
  for (const line of envLines) {
    const assignment = ASSIGNMENT_RE.exec(line);
    const key = assignment?.[1];
    if (!key || !tracked.has(key)) continue;
    if (assignments.has(key)) return { ...result, action: "refused", reason: `ambiguous-env:${key}` };
    const raw = line.slice(assignment![0].length).trim();
    if ((raw.startsWith("\"") || raw.startsWith("\'") || raw.startsWith("`")) && raw.indexOf(raw[0]!, 1) < 0) {
      return { ...result, action: "refused", reason: `multiline-env:${key}` };
    }
    assignments.add(key);
  }
  const fileEnv = parseMcpComponentEnv(envText);
  const processEnv = deps.env ?? process.env;
  if (processEnv[names.redirectUri] !== undefined && isUnresolvedEnvValue(processEnv[names.redirectUri])) {
    return { ...result, action: "refused", reason: "redirect-env-masks-file" };
  }
  const env = { ...fileEnv } as Record<string, string | undefined>;
  for (const [key, value] of Object.entries(processEnv)) {
    if (value !== undefined) env[key] = value;
  }
  if (!isUnresolvedEnvValue(fileEnv[names.redirectUri]) || !isUnresolvedEnvValue(env[names.redirectUri])) {
    return { ...result, action: "already-set" };
  }
  if (!mcpOAuthEnabledIn(env)) return { ...result, action: "not-enabled" };
  if ([names.clientId, names.clientSecret].some(key => isUnresolvedEnvValue(env[key]))) {
    return { ...result, action: "no-credentials" };
  }
  const issuer = issuerFromEnv(env);
  const validation = validateRedirectIssuer(issuer);
  if (!validation.redirect) return { ...result, action: issuer ? "refused" : "no-issuer", reason: validation.reason };
  const lines = envLines.filter(line => ASSIGNMENT_RE.exec(line)?.[1] !== names.redirectUri);
  while (lines.at(-1) === "") lines.pop();
  lines.push(`${names.redirectUri}=${validation.redirect}`, "");
  const tempPath = `${envPath}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tempPath, lines.join("\n"), { mode, flag: "wx" });
    chmodSync(tempPath, mode);
    renameSync(tempPath, envPath);
  } finally {
    rmSync(tempPath, { force: true });
  }
  return { ...result, action: "staged", wrote: true };
}

export async function readTargetMcpRedirectFinding(
  authenticatedRead: () => Promise<unknown>,
): Promise<import("./mcp-oauth-env-core.js").McpRedirectDoctorFinding | null> {
  let readiness: import("./mcp-oauth-env-core.js").McpProviderReadiness | null = null;
  try {
    const detail = await authenticatedRead() as { mcpOAuthProvider?: { credentialsPresent?: unknown; redirectPresent?: unknown } };
    const candidate = detail?.mcpOAuthProvider;
    if (typeof candidate?.credentialsPresent === "boolean" && typeof candidate.redirectPresent === "boolean") {
      readiness = { credentialsPresent: candidate.credentialsPresent, redirectPresent: candidate.redirectPresent };
    }
  } catch { /* target unavailable */ }
  return describeMcpRedirectFinding(readiness);
}

/** One operator-facing line for a migration result. Never a value. */
export function renderRedirectMigration(result: RedirectMigrationResult): string | null {
  switch (result.action) {
    case "staged":
      return `MCP OAuth: staged ${result.redirectVar} for the ${SHIPPED_IDP_PROVIDER} provider (${result.envPath}).`;
    case "no-issuer":
      return `MCP OAuth: ${result.redirectVar} is missing and FLAIR_MCP_ISSUER is missing — set ${result.redirectVar} in the instance environment, or re-run: flair mcp enable`;
    case "refused":
      return `MCP OAuth redirect migration refused: ${result.reason}. Set ${result.redirectVar} in the instance environment and restart.`;
    case "not-enabled":
    case "already-set":
    case "no-credentials":
      return null;
  }
}
