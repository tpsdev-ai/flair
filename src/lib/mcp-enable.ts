/**
 * mcp-enable.ts — flair#719: `flair mcp enable/disable/status`, the last
 * piece of the paved-paths command family. Automates the 8-step operator
 * checklist documented in docs/notes/mcp-oauth-model2.md into one command.
 *
 * ── Design record (BINDING) ─────────────────────────────────────────────────
 * flair#719 issue comments: Flint's "Paved-paths design round" (the 8-step
 * checklist), Kern's + Sherlock's K&S verdicts (approved, with conditions —
 * see below), the scenario addendum (binding), and the CIMD design-record
 * correction (DCR is for INTERACTIVE clients only).
 *
 * **The scenario addendum is binding on this implementation**: `enable`
 * targets the HOSTED shape only — it runs on the OPERATOR's machine, against
 * a REMOTE instance (`--instance <url>` / FLAIR_URL). A local-origin instance
 * (claude.ai's servers cannot dial into localhost) gets an honest refusal —
 * never eight steps toward a connector that can never connect. Secrets
 * provisioning treats the remote path as primary. Self-verification runs
 * from the operator's machine against the PUBLIC origin — success means
 * "claude.ai could connect to this," not "localhost answered."
 *
 * ── K&S conditions honored here ──────────────────────────────────────────────
 *   - Kern (binding): `enable` CONSUMES `src/lib/dcr-client.ts`'s
 *     `registerDcrClient` for its DCR interaction — it never inlines its own
 *     POST to `/oauth/mcp/register`. See `preRegisterClaudeViaDcr` below.
 *   - Sherlock: `accessTokenTtl` is explicitly 900 in the written config
 *     block, never left at the plugin's 1h default (see
 *     `buildMcpOAuthConfigBlock`).
 *   - Sherlock: the RS256 keypair comes from `crypto.generateKeyPairSync`
 *     (see `generateRsaSigningKeyPair`), never a PRNG shortcut.
 *   - Sherlock (the #741 lesson): self-verification is the exit criterion.
 *     On failure, the result names which step to re-run — never reports
 *     success on hope (see `EnableMcpResult.failedStep`).
 *   - Secrets provisioning is shape-aware but never silent: every result
 *     names the mechanism chosen and where the material lives (paths only —
 *     values never appear in `EnableMcpResult` or on stdout).
 *
 * ── Ground truth used to design the remote "existing ops paths" step ────────
 * Verified against the ACTUALLY INSTALLED packages, not assumed:
 *   - `@harperfast/harper`'s Operations API has a genuine `set_configuration`
 *     operation (writes harperdb-config.yaml for all workers, requires a
 *     restart to take effect — node_modules/@harperfast/harper/dist/config/
 *     configUtils.js's `setConfiguration`) and a genuine `restart` operation
 *     (whole-process restart — see .../components/mcp/tools/schemas/
 *     operationDescriptions.js's operation catalog). Both are called the
 *     SAME way `grantMcpClient`/`revokeMcpClient` (src/cli.ts) already call
 *     the ops API: Basic admin auth, POST a JSON operation body, targeting
 *     either a local port or a remote URL — genuinely "the existing remote
 *     ops paths" the design addendum names, not a new mechanism invented for
 *     this slice.
 *   - `FLAIR_MCP_OAUTH` (resources/mcp-oauth-flag.ts) is read from
 *     `process.env` ONLY — never YAML config — so it (and the OAuth secrets:
 *     the DCR gate token, the signing key PEM, the IdP client secret) cannot
 *     be set via `set_configuration`. Those are delivered through the
 *     shape-aware secrets-provisioning step below (a 0600 staging file the
 *     operator applies via Fabric Studio's environment panel, or their own
 *     process-manager env). `enable` requires the operator to confirm
 *     application (`confirmSecretsApplied`, or an interactive prompt) before
 *     it calls `restart` — otherwise the restart would just bounce back to
 *     the flag-OFF byte-identical boot with the new config.yaml block inert.
 *   - `@harperfast/oauth`'s config field names (`mcp.issuer`, `mcp.resource`,
 *     `mcp.accessTokenTtl`, `mcp.dynamicClientRegistration.{initialAccessToken,
 *     allowedRedirectUriHosts}`, `mcp.signingKeyPem`) are confirmed against
 *     the installed 2.2.0 package's source (dist/lib/mcp/{dcr,keyStore,
 *     token}.js) and match docs/notes/mcp-oauth-model2.md exactly.
 *   - The self-verification target, `${issuer}/.well-known/oauth-
 *     authorization-server` (RFC 8414), is served by dist/lib/mcp/
 *     wellKnown.js and advertises `registration_endpoint`/`token_endpoint`.
 *   - The GitHub OAuth-app callback URL, `${issuer}/oauth/github/callback`,
 *     is the plugin's own README "Configure OAuth Callback" convention
 *     (`https://your-domain/oauth/<provider>/callback`).
 *   - The claude.ai/claude.com DCR redirect URI, `https://claude.com/api/mcp/
 *     auth_callback`, matches the constant already shipped in
 *     resources/OAuth.ts (`ALLOWED_REDIRECT_URI`) for the 1.0 opaque-token AS
 *     — the same value claude.ai's connector flow uses.
 *
 * ── Execution order vs. the design's numbered checklist ──────────────────────
 * The design record's 8 steps are a CONCEPTUAL checklist (ported from the
 * manual runbook); the automated command must respect real dependencies.
 * Steps 6 ("pre-register claude.ai via DCR") and 8 ("self-verify") both make
 * LIVE calls against the OAuth surface, which only exists once the instance
 * has restarted with `FLAIR_MCP_OAUTH=1` and the new config live. So this
 * module executes step 7 ("set the flag, restart") BEFORE step 6, and runs
 * step 6 immediately after the restart succeeds — the checklist's numbering
 * is preserved in the STEP NAMES and messaging, but not in wall-clock order.
 * Named explicitly here (not silently reordered) per this repo's "no
 * vibe-claims" / ground-truth-over-assumed-ordering discipline.
 */

import { existsSync, mkdirSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import {
  registerDcrClient,
  readDcrToken,
  writeDcrTokenFile,
  type DcrRegisterResult,
} from "./dcr-client.js";

// ─── Claude connector constants ─────────────────────────────────────────────

/** The redirect URI claude.ai's connector flow uses — matches the constant
 *  already shipped for the 1.0 opaque-token AS (resources/OAuth.ts). */
export const CLAUDE_DCR_REDIRECT_URI = "https://claude.com/api/mcp/auth_callback";

/** Default DCR-allowed redirect-host allowlist (mcp-oauth-model2.md). */
export const DEFAULT_REDIRECT_URI_HOSTS = ["claude.ai", "claude.com"];

/** Required TTL per Sherlock's Model-2 requirement 1 — never the plugin's 1h default. */
export const REQUIRED_ACCESS_TOKEN_TTL = 900;

// ─── Local-origin detection (scenario addendum, binding) ───────────────────

const LOCAL_ORIGIN_REFUSAL =
  "claude.ai connectors need a public HTTPS origin; this instance is local. See the hosted-shape docs.";

/**
 * Is `url`'s host a local/private origin claude.ai's servers could never
 * dial into? Covers localhost, loopback, RFC1918 private ranges, link-local,
 * and `.local` mDNS. An unparseable URL is treated as local (refuse rather
 * than proceed against an origin we can't even parse).
 */
export function isLocalOrigin(url: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return true;
  }
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
  // WHATWG URL keeps IPv6 hosts bracketed in `.hostname` (e.g. "[::1]").
  if (hostname === "::1" || hostname === "[::1]") return true;
  if (hostname.endsWith(".local")) return true;
  const ipv4 = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const a = Number(ipv4[1]);
    const b = Number(ipv4[2]);
    if (a === 127) return true; // loopback
    if (a === 10) return true; // RFC1918
    if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
    if (a === 192 && b === 168) return true; // RFC1918
    if (a === 169 && b === 254) return true; // link-local
    if (a === 0) return true;
  }
  return false;
}

/** Structural refusal check + the exact operator-facing message (scenario addendum). */
export function checkLocalOriginRefusal(url: string): { refused: true; message: string } | { refused: false } {
  if (isLocalOrigin(url)) return { refused: true, message: LOCAL_ORIGIN_REFUSAL };
  return { refused: false };
}

// ─── Fabric-shape detection (secrets-mechanism default) ────────────────────

/** Is this a Harper Fabric-hosted origin? (`*.harperfabric.com`.) Used only
 *  to pick the secrets-provisioning mechanism's DEFAULT — always overridable
 *  via `--secrets-mechanism`. */
export function isFabricOrigin(url: string): boolean {
  try {
    return new URL(url).hostname.toLowerCase().endsWith(".harperfabric.com");
  } catch {
    return false;
  }
}

export type SecretsMechanism = "fabric-env-secrets" | "env-file";

/**
 * Which secrets-delivery mechanism should `enable` use? The remote path is
 * primary per the scenario addendum: a recognized Fabric origin defaults to
 * `fabric-env-secrets` (Harper's encrypted env-secrets, 5.2-alpha as of this
 * writing — see the module header on why this is a DOCUMENTED procedure, not
 * an automated push: no confirmed ops-API operation for it exists in the
 * installed 5.1.17 SDK). Anything else defaults to `env-file` — the
 * documented, universally-supported fallback. Always overridable.
 */
export function selectSecretsMechanism(instanceUrl: string, override?: SecretsMechanism): SecretsMechanism {
  if (override) return override;
  return isFabricOrigin(instanceUrl) ? "fabric-env-secrets" : "env-file";
}

// ─── Step 1: RS256 keypair + DCR gate token ─────────────────────────────────

export interface RsaKeyPairPem {
  publicKey: string;
  privateKey: string;
}

/** RS256 signing keypair for `mcp.signingKeyPem` — `crypto.generateKeyPairSync`,
 *  never a PRNG shortcut (Sherlock's Model-2 requirement 2 implementation note). */
export function generateRsaSigningKeyPair(): RsaKeyPairPem {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return { publicKey, privateKey };
}

/** A fresh DCR gate token — 32 random bytes, base64url (same shape as any
 *  other flair-minted bearer credential). */
export function generateDcrGateToken(): string {
  return randomBytes(32).toString("base64url");
}

export function defaultSigningKeyFilePath(): string {
  return join(homedir(), ".flair", "mcp-signing-key.pem");
}

/** Write the RS256 private key PEM to a 0600 file (idempotent — reuses an
 *  existing file rather than silently rotating the signing key). */
export function ensureSigningKeyFile(filePath?: string, deps: { generate?: () => RsaKeyPairPem } = {}): { path: string; reused: boolean } {
  const path = filePath ?? defaultSigningKeyFilePath();
  if (existsSync(path)) {
    return { path, reused: true };
  }
  const generate = deps.generate ?? generateRsaSigningKeyPair;
  const { privateKey } = generate();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, privateKey, { mode: 0o600 });
  chmodSync(path, 0o600);
  return { path, reused: false };
}

/** Read back a signing key file's PEM contents (used to fold it into the
 *  secrets bundle — never logged, never returned in an `EnableMcpResult`). */
export function readSigningKeyFile(path: string): string {
  return readFileSync(path, "utf-8");
}

/** Reuse an existing DCR gate token (env or 0600 file) if one is already
 *  provisioned; otherwise generate + write a fresh one. Idempotent re-runs
 *  of `enable` don't rotate a token that's already live in a remote config. */
export function ensureDcrGateToken(
  filePath?: string,
  deps: { generate?: () => string } = {},
): { token: string; path: string; reused: boolean } {
  const path = filePath ?? undefined;
  const existing = readDcrToken(path ? { filePath: path } : {});
  if (existing) {
    return { token: existing.token, path: existing.path ?? path ?? "(env)", reused: true };
  }
  const generate = deps.generate ?? generateDcrGateToken;
  const token = generate();
  const writtenPath = writeDcrTokenFile(token, path);
  return { token, path: writtenPath, reused: false };
}

// ─── Step 2: @harperfast/oauth config block ─────────────────────────────────

export interface McpOAuthConfigBlockParams {
  idpProvider: string;
  redirectUriHosts?: string[];
}

/**
 * The `@harperfast/oauth` config block, exactly matching docs/notes/
 * mcp-oauth-model2.md's documented shape and the installed 2.2.0 package's
 * field names. Secrets are `${ENV_VAR}` placeholders — never literal values
 * — so this block is safe to write to harperdb-config.yaml via
 * `set_configuration` (the config file itself carries no secret material;
 * see the secrets-provisioning step for how the referenced env vars land).
 */
export function buildMcpOAuthConfigBlock(params: McpOAuthConfigBlockParams): Record<string, unknown> {
  const provider = params.idpProvider;
  const envPrefix = `OAUTH_${provider.toUpperCase()}`;
  const redirectUriHosts = params.redirectUriHosts ?? DEFAULT_REDIRECT_URI_HOSTS;
  return {
    "@harperfast/oauth": {
      package: "@harperfast/oauth",
      providers: {
        [provider]: {
          clientId: `\${${envPrefix}_CLIENT_ID}`,
          clientSecret: `\${${envPrefix}_CLIENT_SECRET}`,
        },
      },
      mcp: {
        enabled: true,
        issuer: "${FLAIR_MCP_ISSUER}",
        resource: "${FLAIR_MCP_ISSUER}/mcp",
        accessTokenTtl: REQUIRED_ACCESS_TOKEN_TTL,
        dynamicClientRegistration: {
          initialAccessToken: "${FLAIR_MCP_DCR_TOKEN}",
          allowedRedirectUriHosts: redirectUriHosts,
        },
        signingKeyPem: "${FLAIR_MCP_SIGNING_KEY_PEM}",
      },
    },
  };
}

/** The exact callback URL to hand the operator when they create the IdP
 *  OAuth app (design step 3: "with the exact GitHub callback URL printed"). */
export function idpCallbackUrl(issuer: string, idpProvider: string): string {
  return `${issuer.replace(/\/+$/, "")}/oauth/${idpProvider}/callback`;
}

// ─── Step 4: secrets bundle ──────────────────────────────────────────────────

export interface SecretsBundleParams {
  issuer: string;
  dcrToken: string;
  signingKeyPem: string;
  idpProvider: string;
  idpClientId: string;
  idpClientSecret: string;
}

/** The full set of env vars the restarted instance needs live. Contains
 *  secret VALUES — this is the one place they exist as a JS object; callers
 *  must never fold this into a CLI-printed / `EnableMcpResult` field. */
export function buildSecretsBundle(params: SecretsBundleParams): Record<string, string> {
  const envPrefix = `OAUTH_${params.idpProvider.toUpperCase()}`;
  return {
    FLAIR_MCP_OAUTH: "1",
    FLAIR_MCP_ISSUER: params.issuer.replace(/\/+$/, ""),
    FLAIR_MCP_DCR_TOKEN: params.dcrToken,
    FLAIR_MCP_SIGNING_KEY_PEM: params.signingKeyPem,
    [`${envPrefix}_CLIENT_ID`]: params.idpClientId,
    [`${envPrefix}_CLIENT_SECRET`]: params.idpClientSecret,
  };
}

export function defaultSecretsStagingPath(issuer: string): string {
  let host = "instance";
  try {
    host = new URL(issuer).hostname;
  } catch {
    /* fall through to the generic name */
  }
  const safe = host.replace(/[^a-zA-Z0-9.-]/g, "_");
  return join(homedir(), ".flair", `mcp-enable-secrets-${safe}.env`);
}

/** Write the secrets bundle to a 0600 staging file, `KEY=VALUE` per line.
 *  This file legitimately carries secret material (like `grant`'s 0600 key
 *  files) — the "never print secret values" rule is about stdout/returned
 *  result objects, not this deliberately-created, permission-locked file. */
export function writeSecretsStagingFile(path: string, bundle: Record<string, string>): void {
  mkdirSync(dirname(path), { recursive: true });
  const body = Object.entries(bundle).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
  writeFileSync(path, body, { mode: 0o600 });
  chmodSync(path, 0o600);
}

export interface SecretsProvisioningResult {
  mechanism: SecretsMechanism;
  path: string;
  varNames: string[];
  instructions: string;
}

/** Provision secrets per the shape-aware mechanism, staging the bundle to a
 *  0600 file and returning ONLY names/paths/instructions — never values. */
export function provisionSecrets(
  instanceUrl: string,
  bundle: Record<string, string>,
  opts: { mechanism?: SecretsMechanism; stagingPath?: string } = {},
): SecretsProvisioningResult {
  const mechanism = selectSecretsMechanism(instanceUrl, opts.mechanism);
  const path = opts.stagingPath ?? defaultSecretsStagingPath(instanceUrl);
  writeSecretsStagingFile(path, bundle);
  const varNames = Object.keys(bundle);

  const instructions =
    mechanism === "fabric-env-secrets"
      ? `Fabric env-secrets (enc:v1) push is alpha-only as of this writing — no confirmed ops-API operation exists in the installed SDK to automate it. ` +
        `Apply the ${varNames.length} vars staged at ${path} via Fabric Studio → Cluster Settings → Environment, then re-run with --confirm-secrets-applied.`
      : `Apply the ${varNames.length} vars staged at ${path} to the target instance's process environment (systemd/launchd unit, or your process manager), then re-run with --confirm-secrets-applied.`;

  return { mechanism, path, varNames, instructions };
}

// ─── Step 5: identity mapping (Credential kind:idp) ─────────────────────────

function opsBaseUrl(opsPortOrUrl: number | string): string {
  return typeof opsPortOrUrl === "number" ? `http://127.0.0.1:${opsPortOrUrl}/` : `${opsPortOrUrl.replace(/\/$/, "")}/`;
}

function basicAuthHeader(adminUser: string, adminPass: string): string {
  return `Basic ${Buffer.from(`${adminUser}:${adminPass}`).toString("base64")}`;
}

export interface IdentityMappingParams {
  opsPortOrUrl: number | string;
  adminUser: string;
  adminPass: string;
  /** Personal-shape default per #718: one principal per instance. */
  principal: string;
  principalKind: "human" | "agent";
  idpProvider: string;
  idpSubject: string;
}

export interface IdentityMappingResult {
  principalCreated: boolean;
  credentialId: string;
  credentialReused: boolean;
}

/**
 * Map the operator's IdP subject to their principal via `Credential(kind:
 * "idp")` — the SAME credential surface resources/mcp-handler.ts's
 * `resolveAgentFromSub` reads at request time. Idempotent: an existing
 * mapping for (provider, subject) is reused (lastUsedAt bumped) rather than
 * duplicated; the principal Agent is created only if missing.
 */
export async function provisionIdpIdentityMapping(
  params: IdentityMappingParams,
  deps: { fetchImpl?: typeof fetch; now?: () => string } = {},
): Promise<IdentityMappingResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = (deps.now ?? (() => new Date().toISOString()))();
  const opsUrl = opsBaseUrl(params.opsPortOrUrl);
  const authHeader = basicAuthHeader(params.adminUser, params.adminPass);

  // Ensure the principal Agent exists.
  const findRes = await fetchImpl(opsUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: authHeader },
    body: JSON.stringify({
      operation: "search_by_value",
      database: "flair",
      table: "Agent",
      search_attribute: "id",
      search_value: params.principal,
      get_attributes: ["id"],
    }),
  });
  if (!findRes.ok) {
    const text = await findRes.text().catch(() => "");
    throw new Error(`Identity mapping: failed to look up principal '${params.principal}' (HTTP ${findRes.status}): ${text}`);
  }
  const foundAgents = await findRes.json().catch(() => []);
  let principalCreated = false;
  if (!Array.isArray(foundAgents) || foundAgents.length === 0) {
    const insertRes = await fetchImpl(opsUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authHeader },
      body: JSON.stringify({
        operation: "insert",
        database: "flair",
        table: "Agent",
        records: [
          {
            id: params.principal,
            name: params.principal,
            displayName: params.principal,
            kind: params.principalKind,
            type: params.principalKind,
            status: "active",
            admin: false,
            defaultTrustTier: "endorsed",
            createdAt: now,
            updatedAt: now,
          },
        ],
      }),
    });
    if (!insertRes.ok) {
      const text = await insertRes.text().catch(() => "");
      throw new Error(`Identity mapping: failed to create principal '${params.principal}' (HTTP ${insertRes.status}): ${text}`);
    }
    principalCreated = true;
  }

  // Reuse an existing Credential(kind:idp, provider, subject) mapping if present.
  const searchCredRes = await fetchImpl(opsUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: authHeader },
    body: JSON.stringify({
      operation: "search_by_conditions",
      database: "flair",
      table: "Credential",
      operator: "and",
      conditions: [
        { search_attribute: "kind", search_type: "equals", search_value: "idp" },
        { search_attribute: "idpProvider", search_type: "equals", search_value: params.idpProvider },
        { search_attribute: "idpSubject", search_type: "equals", search_value: params.idpSubject },
      ],
      get_attributes: ["id", "principalId"],
    }),
  });
  const existingCreds = searchCredRes.ok ? await searchCredRes.json().catch(() => []) : [];
  const existing = Array.isArray(existingCreds) ? existingCreds[0] : undefined;

  const credentialId = existing?.id ?? `cred_idp_${params.idpProvider}_${randomBytes(6).toString("hex")}`;
  const upsertRes = await fetchImpl(opsUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: authHeader },
    body: JSON.stringify({
      operation: "upsert",
      database: "flair",
      table: "Credential",
      records: [
        {
          id: credentialId,
          principalId: params.principal,
          kind: "idp",
          label: `MCP OAuth (${params.idpProvider})`,
          status: "active",
          idpProvider: params.idpProvider,
          idpSubject: params.idpSubject,
          createdAt: existing ? undefined : now,
          lastUsedAt: now,
        },
      ],
    }),
  });
  if (!upsertRes.ok) {
    const text = await upsertRes.text().catch(() => "");
    throw new Error(`Identity mapping: failed to write Credential(kind:idp) mapping (HTTP ${upsertRes.status}): ${text}`);
  }

  return { principalCreated, credentialId, credentialReused: Boolean(existing) };
}

// ─── Step 7 (executed before step 6 — see module header): apply config + restart

export interface ApplyConfigAndRestartParams {
  opsPortOrUrl: number | string;
  adminUser: string;
  adminPass: string;
  configBlock: Record<string, unknown>;
}

/** `set_configuration` (writes harperdb-config.yaml) then `restart`
 *  (whole-process restart) — the genuine Harper Operations API operations
 *  this module's header documents. Throws on either non-2xx response. */
export async function applyRemoteConfigAndRestart(
  params: ApplyConfigAndRestartParams,
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<void> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const opsUrl = opsBaseUrl(params.opsPortOrUrl);
  const authHeader = basicAuthHeader(params.adminUser, params.adminPass);

  const setRes = await fetchImpl(opsUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: authHeader },
    body: JSON.stringify({ operation: "set_configuration", ...params.configBlock }),
  });
  if (!setRes.ok) {
    const text = await setRes.text().catch(() => "");
    throw new Error(`set_configuration failed (HTTP ${setRes.status}): ${text}`);
  }

  const restartRes = await fetchImpl(opsUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: authHeader },
    body: JSON.stringify({ operation: "restart" }),
  });
  if (!restartRes.ok) {
    const text = await restartRes.text().catch(() => "");
    throw new Error(`restart failed (HTTP ${restartRes.status}): ${text}`);
  }
}

/** `restart` only — used by `disableMcp` (flag off + restart, no config
 *  rewrite: the `@harperfast/oauth` config block is left in place; it is
 *  inert whenever `FLAIR_MCP_OAUTH` is unset, per the byte-identical-boot
 *  contract). */
export async function triggerRemoteRestart(
  opsPortOrUrl: number | string,
  adminUser: string,
  adminPass: string,
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<void> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const opsUrl = opsBaseUrl(opsPortOrUrl);
  const authHeader = basicAuthHeader(adminUser, adminPass);
  const restartRes = await fetchImpl(opsUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: authHeader },
    body: JSON.stringify({ operation: "restart" }),
  });
  if (!restartRes.ok) {
    const text = await restartRes.text().catch(() => "");
    throw new Error(`restart failed (HTTP ${restartRes.status}): ${text}`);
  }
}

// ─── Step 6: pre-register claude.ai via DCR (via dcr-client.ts — NEVER inlined)

/**
 * Pre-register claude.ai as an interactive OAuth client through the gated
 * DCR endpoint. Consumes `registerDcrClient` from `./dcr-client.js` — per
 * Kern's binding #719 verdict condition, `enable` never inlines its own POST
 * to `/oauth/mcp/register`.
 */
export async function preRegisterClaudeViaDcr(
  params: { issuer: string; dcrToken: string; redirectUris?: string[] },
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<DcrRegisterResult> {
  return registerDcrClient({
    issuer: params.issuer,
    dcrToken: params.dcrToken,
    redirectUris: params.redirectUris ?? [CLAUDE_DCR_REDIRECT_URI],
    clientName: "claude.ai",
    fetchImpl: deps.fetchImpl,
  });
}

// ─── Step 8: self-verify ─────────────────────────────────────────────────────

export interface SelfVerifyResult {
  ok: boolean;
  issuer?: string;
  registrationEndpoint?: string;
  tokenEndpoint?: string;
  detail: string;
}

/**
 * Hit the OAuth metadata endpoint from the operator's machine against the
 * PUBLIC origin — the verification that matters is the one claude.ai's
 * perspective sees (scenario addendum). Never reports success on hope: any
 * unreachable/malformed/mismatched response is `ok: false` with a specific
 * `detail`.
 */
export async function selfVerifyMcpMetadata(
  issuer: string,
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<SelfVerifyResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const normalizedIssuer = issuer.replace(/\/+$/, "");
  const url = `${normalizedIssuer}/.well-known/oauth-authorization-server`;

  let res: Response;
  try {
    res = await fetchImpl(url, { signal: AbortSignal.timeout(15_000) } as RequestInit);
  } catch (err: any) {
    return { ok: false, detail: `could not reach ${url}: ${err?.message ?? err}` };
  }
  if (!res.ok) {
    return {
      ok: false,
      detail: `${url} returned HTTP ${res.status} — is FLAIR_MCP_OAUTH actually set on the restarted instance?`,
    };
  }
  let body: any;
  try {
    body = await res.json();
  } catch {
    return { ok: false, detail: `${url} did not return JSON` };
  }
  if (
    body?.issuer !== normalizedIssuer ||
    typeof body?.registration_endpoint !== "string" ||
    typeof body?.token_endpoint !== "string"
  ) {
    return {
      ok: false,
      detail: `${url} responded but the metadata shape is unexpected (issuer/registration_endpoint/token_endpoint) — got issuer=${JSON.stringify(body?.issuer)}`,
    };
  }
  return {
    ok: true,
    issuer: body.issuer,
    registrationEndpoint: body.registration_endpoint,
    tokenEndpoint: body.token_endpoint,
    detail: "OAuth metadata endpoint answering on the public origin",
  };
}

/** The exact block to paste into claude.ai → Settings → Connectors. */
export function buildClaudePasteBlock(resource: string, clientId: string): string {
  return [
    "claude.ai → Settings → Connectors → Add custom connector",
    `  URL:       ${resource}`,
    `  Client ID: ${clientId}`,
  ].join("\n");
}

// ─── Orchestration ────────────────────────────────────────────────────────────

export type EnableStepName =
  | "local-origin-check"
  | "keypair-and-dcr-token"
  | "config-block"
  | "idp-credentials"
  | "secrets-provisioning"
  | "identity-mapping"
  | "apply-config-and-restart"
  | "dcr-preregister-claude"
  | "self-verify";

export interface EnableStepResult {
  step: EnableStepName;
  ok: boolean;
  detail: string;
}

export interface EnableMcpParams {
  /** Ops-API / restart target — the operator's machine talks TO this remote
   *  instance. Defaults to FLAIR_URL at the CLI layer. */
  instance: string;
  /** Public origin claude.ai will use; defaults to `instance`. */
  issuer?: string;
  idpProvider?: string;
  idpClientId?: string;
  idpClientSecret?: string;
  /** The operator's expected `sub`/login at the IdP (GitHub's `usernameClaim`
   *  is `login` — verify at first live login if unsure; `flair mcp status`
   *  surfaces mismatches). Required — never guessed. */
  idpSubject?: string;
  principal?: string;
  principalKind?: "human" | "agent";
  adminUser: string;
  adminPass: string;
  dcrTokenFilePath?: string;
  signingKeyFilePath?: string;
  secretsMechanism?: SecretsMechanism;
  secretsStagingPath?: string;
  redirectUriHosts?: string[];
  dryRun?: boolean;
  /** Operator confirms the staged secrets are live in the target's process
   *  environment. Required (or an interactive `prompt` confirmation) before
   *  `enable` calls restart — never assumed. */
  confirmSecretsApplied?: boolean;
}

export interface EnableMcpDeps {
  fetchImpl?: typeof fetch;
  now?: () => string;
  generateRsaKeyPair?: () => RsaKeyPairPem;
  generateDcrToken?: () => string;
  /** Interactive confirmation (CLI wires readline; tests inject a stub).
   *  Only consulted when `confirmSecretsApplied` is not already true and
   *  this is not a dry run. */
  confirmPrompt?: (message: string) => Promise<boolean>;
}

export interface EnableMcpResult {
  ok: boolean;
  dryRun: boolean;
  refused?: { message: string };
  steps: EnableStepResult[];
  failedStep?: EnableStepName;
  issuer?: string;
  resource?: string;
  claudeClientId?: string;
  pasteBlock?: string;
  secretsMechanism?: SecretsMechanism;
  secretsPath?: string;
  dcrTokenFilePath?: string;
  signingKeyFilePath?: string;
  callbackUrl?: string;
}

/**
 * Full `flair mcp enable` orchestration. No `process.exit`, no console
 * output — directly unit-testable with a mocked fetch and temp dirs, same
 * split as `grantMcpClient`/`revokeMcpClient`. Returns a step-by-step log so
 * a failure names exactly which step to re-run (never reports success on
 * hope).
 */
export async function enableMcp(params: EnableMcpParams, deps: EnableMcpDeps = {}): Promise<EnableMcpResult> {
  const steps: EnableStepResult[] = [];
  const dryRun = Boolean(params.dryRun);
  const push = (step: EnableStepName, ok: boolean, detail: string) => steps.push({ step, ok, detail });

  // ── Local-origin refusal (scenario addendum, binding) ─────────────────────
  const localCheck = checkLocalOriginRefusal(params.instance);
  if (localCheck.refused) {
    push("local-origin-check", false, localCheck.message);
    return { ok: false, dryRun, refused: { message: localCheck.message }, steps, failedStep: "local-origin-check" };
  }
  push("local-origin-check", true, `${params.instance} is a public-shaped origin`);

  const issuer = (params.issuer ?? params.instance).replace(/\/+$/, "");
  const idpProvider = params.idpProvider ?? "github";
  const principal = params.principal ?? "self";
  const principalKind = params.principalKind ?? "human";

  try {
    // ── Design step 1: RS256 keypair + DCR gate token ────────────────────────
    const keyResult = ensureSigningKeyFile(params.signingKeyFilePath, { generate: deps.generateRsaKeyPair });
    const dcrResult = ensureDcrGateToken(params.dcrTokenFilePath, { generate: deps.generateDcrToken });
    push(
      "keypair-and-dcr-token",
      true,
      `signing key ${keyResult.reused ? "reused" : "generated"} at ${keyResult.path} (0600); ` +
        `DCR gate token ${dcrResult.reused ? "reused from" : "generated and written to"} ${dcrResult.path}`,
    );

    // ── Design step 2: @harperfast/oauth config block ────────────────────────
    const configBlock = buildMcpOAuthConfigBlock({ idpProvider, redirectUriHosts: params.redirectUriHosts });
    push("config-block", true, `built the @harperfast/oauth mcp config block (accessTokenTtl=${REQUIRED_ACCESS_TOKEN_TTL})`);

    // ── Design step 3: IdP OAuth-app credential intake ───────────────────────
    const callbackUrl = idpCallbackUrl(issuer, idpProvider);
    if (!params.idpClientId || !params.idpClientSecret || !params.idpSubject) {
      const missing = [
        !params.idpClientId && "--idp-client-id",
        !params.idpClientSecret && "--idp-client-secret",
        !params.idpSubject && "--idp-subject",
      ].filter(Boolean).join(", ");
      push(
        "idp-credentials",
        false,
        `missing ${missing}. Create a ${idpProvider} OAuth app with callback URL ${callbackUrl}, then re-run with the credentials.`,
      );
      return { ok: false, dryRun, steps, failedStep: "idp-credentials", callbackUrl };
    }
    push("idp-credentials", true, `${idpProvider} OAuth app credentials present; callback URL: ${callbackUrl}`);

    if (dryRun) {
      // Dry-run stops here — everything above is pure/local generation; no
      // remote mutation has happened, and nothing below this line would run
      // without --dry-run either.
      return {
        ok: true,
        dryRun: true,
        steps,
        issuer,
        resource: `${issuer}/mcp`,
        callbackUrl,
        dcrTokenFilePath: dcrResult.path,
        signingKeyFilePath: keyResult.path,
      };
    }

    // ── Design step 4: secrets provisioning (shape-aware, never silent) ──────
    const signingKeyPem = readSigningKeyFile(keyResult.path);
    const bundle = buildSecretsBundle({
      issuer,
      dcrToken: dcrResult.token,
      signingKeyPem,
      idpProvider,
      idpClientId: params.idpClientId,
      idpClientSecret: params.idpClientSecret,
    });
    const secretsResult = provisionSecrets(params.instance, bundle, {
      mechanism: params.secretsMechanism,
      stagingPath: params.secretsStagingPath,
    });
    push(
      "secrets-provisioning",
      true,
      `mechanism: ${secretsResult.mechanism}; ${secretsResult.varNames.length} vars staged at ${secretsResult.path} (0600). ${secretsResult.instructions}`,
    );

    // ── Design step 5: identity mapping (Credential kind:idp) ────────────────
    const mapping = await provisionIdpIdentityMapping(
      {
        opsPortOrUrl: params.instance,
        adminUser: params.adminUser,
        adminPass: params.adminPass,
        principal,
        principalKind,
        idpProvider,
        idpSubject: params.idpSubject,
      },
      { fetchImpl: deps.fetchImpl, now: deps.now },
    );
    push(
      "identity-mapping",
      true,
      `principal '${principal}' ${mapping.principalCreated ? "created" : "already existed"}; ` +
        `Credential(kind:idp) ${mapping.credentialReused ? "reused" : "created"} (${mapping.credentialId})`,
    );

    // ── Gate: confirm the staged secrets are actually live before restarting ─
    let confirmed = Boolean(params.confirmSecretsApplied);
    if (!confirmed && deps.confirmPrompt) {
      confirmed = await deps.confirmPrompt(
        `Have you applied the ${secretsResult.varNames.length} vars staged at ${secretsResult.path} to ${params.instance}'s environment?`,
      );
    }
    if (!confirmed) {
      push(
        "apply-config-and-restart",
        false,
        `not applied: pass --confirm-secrets-applied once the staged secrets are live on ${params.instance}, then re-run \`flair mcp enable\` (steps 1-5 are idempotent and will reuse what's already provisioned).`,
      );
      return { ok: false, dryRun, steps, failedStep: "apply-config-and-restart", secretsMechanism: secretsResult.mechanism, secretsPath: secretsResult.path };
    }

    // ── Design step 7 (executed here — see module header): config + restart ──
    await applyRemoteConfigAndRestart(
      { opsPortOrUrl: params.instance, adminUser: params.adminUser, adminPass: params.adminPass, configBlock },
      { fetchImpl: deps.fetchImpl },
    );
    push("apply-config-and-restart", true, `set_configuration + restart succeeded against ${params.instance}`);

    // ── Design step 6 (executed after restart — see module header): DCR ──────
    let dcrRegistration: DcrRegisterResult;
    try {
      dcrRegistration = await preRegisterClaudeViaDcr(
        { issuer, dcrToken: dcrResult.token, redirectUris: [CLAUDE_DCR_REDIRECT_URI] },
        { fetchImpl: deps.fetchImpl },
      );
    } catch (err: any) {
      push("dcr-preregister-claude", false, `${err?.message ?? err} — re-run \`flair mcp enable\` once the restarted instance is reachable; steps 1-5 will be reused.`);
      return { ok: false, dryRun, steps, failedStep: "dcr-preregister-claude", issuer, resource: `${issuer}/mcp` };
    }
    push("dcr-preregister-claude", true, `claude.ai pre-registered (client_id: ${dcrRegistration.client_id})`);

    // ── Design step 8: self-verify from the operator's machine, public origin
    const verify = await selfVerifyMcpMetadata(issuer, { fetchImpl: deps.fetchImpl });
    if (!verify.ok) {
      push("self-verify", false, `${verify.detail} — re-run \`flair mcp status\` to check current state, or \`flair mcp enable\` to retry the apply-config-and-restart step.`);
      return {
        ok: false,
        dryRun,
        steps,
        failedStep: "self-verify",
        issuer,
        resource: `${issuer}/mcp`,
        claudeClientId: dcrRegistration.client_id,
      };
    }
    push("self-verify", true, verify.detail);

    const resource = `${issuer}/mcp`;
    return {
      ok: true,
      dryRun: false,
      steps,
      issuer,
      resource,
      claudeClientId: dcrRegistration.client_id,
      pasteBlock: buildClaudePasteBlock(resource, dcrRegistration.client_id),
      secretsMechanism: secretsResult.mechanism,
      secretsPath: secretsResult.path,
      dcrTokenFilePath: dcrResult.path,
      signingKeyFilePath: keyResult.path,
      callbackUrl,
    };
  } catch (err: any) {
    const lastStep = steps.length > 0 ? steps[steps.length - 1].step : "keypair-and-dcr-token";
    push(lastStep, false, `unexpected error: ${err?.message ?? err}`);
    return { ok: false, dryRun, steps, failedStep: lastStep };
  }
}

// ─── flair mcp disable ────────────────────────────────────────────────────────

export interface DisableMcpParams {
  instance: string;
  adminUser: string;
  adminPass: string;
  confirmFlagOff?: boolean;
}

export interface DisableMcpDeps {
  fetchImpl?: typeof fetch;
  confirmPrompt?: (message: string) => Promise<boolean>;
}

export interface DisableMcpResult {
  ok: boolean;
  detail: string;
}

/**
 * Flag off + restart = byte-identical boot, per the Model-2 contract
 * (resources/mcp-oauth.ts: the route is registered ONLY when
 * `FLAIR_MCP_OAUTH` is truthy; when off, the module does nothing at load).
 * `FLAIR_MCP_OAUTH` is a process env var (never YAML config —
 * resources/mcp-oauth-flag.ts), so `disable` cannot flip it remotely by
 * itself; it requires the same operator confirmation `enable` requires
 * before it calls `restart`. The `@harperfast/oauth` config block written by
 * `enable` is deliberately left in place — it's inert whenever the flag is
 * off, so there is nothing to "undo" there.
 */
export async function disableMcp(params: DisableMcpParams, deps: DisableMcpDeps = {}): Promise<DisableMcpResult> {
  let confirmed = Boolean(params.confirmFlagOff);
  if (!confirmed && deps.confirmPrompt) {
    confirmed = await deps.confirmPrompt(
      `Have you unset FLAIR_MCP_OAUTH (or set it to 0) in ${params.instance}'s process environment?`,
    );
  }
  if (!confirmed) {
    return {
      ok: false,
      detail:
        `Unset FLAIR_MCP_OAUTH (or set it to 0) via the same mechanism \`flair mcp enable\` used to set it, ` +
        `then re-run \`flair mcp disable --confirm-flag-off\` to restart.`,
    };
  }

  try {
    await triggerRemoteRestart(params.instance, params.adminUser, params.adminPass, { fetchImpl: deps.fetchImpl });
  } catch (err: any) {
    return { ok: false, detail: `restart failed: ${err?.message ?? err}` };
  }
  return { ok: true, detail: `restarted ${params.instance} — /mcp route no longer mounts (byte-identical boot)` };
}

// ─── flair mcp status ─────────────────────────────────────────────────────────

export interface McpStatusParams {
  instance: string;
  dcrTokenFilePath?: string;
}

export interface McpStatusDeps {
  fetchImpl?: typeof fetch;
  /** Reads the local machine-client manifest count — reuses the EXISTING
   *  `flair mcp list` machinery (src/cli.ts's `readMcpClientManifest`)
   *  rather than a new server call, per Kern's note that `status`/`list`
   *  must agree on what a "client" is. */
  countMachineClients?: () => number;
}

export interface McpStatusResult {
  instance: string;
  enabled: boolean;
  metadataReachable: boolean;
  issuer?: string;
  registrationEndpoint?: string;
  tokenEndpoint?: string;
  detail: string;
  dcrTokenProvisionedLocally: boolean;
  machineClientCount?: number;
}

/**
 * Surfaces LIVE state (not a stale local marker): hits the same well-known
 * metadata endpoint `enable`'s self-verify step checks. A 200 with the
 * expected shape means the surface is enabled and answering; anything else
 * means disabled/unreachable — `status` never guesses from local files
 * alone (this is the same "never report success on hope" posture as
 * self-verify).
 */
export async function mcpStatus(params: McpStatusParams, deps: McpStatusDeps = {}): Promise<McpStatusResult> {
  const verify = await selfVerifyMcpMetadata(params.instance, { fetchImpl: deps.fetchImpl });
  const dcrToken = readDcrToken({ filePath: params.dcrTokenFilePath });
  const machineClientCount = deps.countMachineClients?.();

  return {
    instance: params.instance,
    enabled: verify.ok,
    metadataReachable: verify.ok,
    issuer: verify.issuer,
    registrationEndpoint: verify.registrationEndpoint,
    tokenEndpoint: verify.tokenEndpoint,
    detail: verify.detail,
    dcrTokenProvisionedLocally: Boolean(dcrToken),
    machineClientCount,
  };
}
