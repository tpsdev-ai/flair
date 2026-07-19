/**
 * mcp-enable.ts — flair#719: `flair mcp enable/disable/status`, the last
 * piece of the paved-paths command family. Automates the operator checklist
 * documented in docs/notes/mcp-oauth-model2.md into one command.
 *
 * ── flair#756 (2026-07-19): CIMD-only, DCR removed entirely ──────────────────
 * #754 shipped `enable`'s default flow pre-registering claude.ai via DCR
 * (RFC 7591 Dynamic Client Registration) + provisioning a DCR gate token.
 * That contradicted the strategic direction (Nathan, on the record,
 * 2026-07-19): CIMD-only looking forward, DCR is not the path — and the
 * scope was amended same-day from "CIMD-first with a --with-dcr legacy
 * hatch" to full removal: DCR is UNSUPPORTED on this surface, not legacy.
 * There is no `--with-dcr` flag, no gate-token machinery, and
 * `src/lib/dcr-client.ts` (the module that used to own the gate-token
 * contract + the RFC 7591 HTTP client) is deleted.
 *
 * Ground truth (verified in installed @harperfast/oauth@2.2.0 source): the
 * plugin fully supports CIMD for the interactive authorization_code flow —
 * `authorize.js` resolves URL-shaped client_ids via `cimd.js`'s
 * `resolveClient` (metadata-document fetch, rate-limited,
 * `clientIdMetadataDocuments.allowedHosts` gate, redirect-URI-host
 * validation baked into the fetched document itself). A CIMD-capable client
 * like claude.ai needs ZERO pre-registration — there is no client_id for
 * `enable` to hand back, because Claude presents its OWN CIMD document URL
 * as its client_id (Anthropic docs: claude.com/docs/connectors/building/
 * authentication — "Claude uses an HTTPS URL as its client_id, and your
 * authorization server fetches the metadata document from that URL").
 *
 * **Leaving `dynamicClientRegistration` unset does NOT disable DCR** — this
 * is the load-bearing ground-truth fact this rewrite is built on. Read
 * directly from the installed package:
 *   - `node_modules/@harperfast/oauth/dist/types.d.ts:131-144` (the
 *     `MCPDynamicClientRegistrationConfig` doc comment): "Defaults to
 *     enabled because Claude Desktop, Cursor, and mcp-remote all register at
 *     runtime with no pre-baked client_id. Restricting registration is
 *     opt-in via initialAccessToken or allowedRedirectUriHosts."
 *   - `node_modules/@harperfast/oauth/dist/lib/mcp/dcr.js:161-167`
 *     (`handleRegister`): `if (dcrConfig?.enabled === false) return 404`.
 *     An ABSENT `dynamicClientRegistration` block leaves `dcrConfig`
 *     `undefined`, so `dcrConfig?.enabled === false` is `false` — the
 *     endpoint stays live.
 *   - `dcr.js:16-24` (`checkInitialAccessToken`): "Returns null when no
 *     token is configured (open registration per RFC 7591)." — an absent
 *     `initialAccessToken` means the endpoint accepts ANY registration,
 *     unauthenticated.
 *   So simply never writing the block would leave `/oauth/mcp/register`
 *   OPEN, not inert — the opposite of "DCR removed." `buildMcpOAuthConfigBlock`
 *   below therefore writes an EXPLICIT `dynamicClientRegistration: { enabled:
 *   false }` — the one config shape that is verifiably fail-closed
 *   (dcr.js:165-167's 404 branch) — and never writes `initialAccessToken` or
 *   `allowedRedirectUriHosts` (there is no gate-token machinery to configure
 *   them with). A structural test in test/unit/mcp-enable.test.ts asserts
 *   this shape directly.
 *
 * ── K&S conditions from #719, still honored ──────────────────────────────────
 *   - Sherlock: `accessTokenTtl` is explicitly 900 in the written config
 *     block, never left at the plugin's 1h default (see
 *     `buildMcpOAuthConfigBlock`).
 *   - Sherlock: the RS256 keypair comes from `crypto.generateKeyPairSync`
 *     (see `generateRsaSigningKeyPair`), never a PRNG shortcut.
 *   - Sherlock (the #741 lesson): self-verification is the exit criterion.
 *     On failure, the result names which step to re-run — never reports
 *     success on hope (see `EnableMcpResult.failedStep`). flair#756 extends
 *     this: self-verify now also confirms the metadata endpoint advertises
 *     CIMD support (the exact pair Claude's client checks — see
 *     `selfVerifyMcpMetadata` below), not just that the endpoint answers.
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
 *     the signing key PEM, the IdP client secret) cannot be set via
 *     `set_configuration`. Those are delivered through the shape-aware
 *     secrets-provisioning step below (a 0600 staging file the operator
 *     applies via Fabric Studio's environment panel, or their own
 *     process-manager env). `enable` requires the operator to confirm
 *     application (`confirmSecretsApplied`, or an interactive prompt) before
 *     it calls `restart` — otherwise the restart would just bounce back to
 *     the flag-OFF byte-identical boot with the new config.yaml block inert.
 *   - `@harperfast/oauth`'s config field names (`mcp.issuer`, `mcp.resource`,
 *     `mcp.accessTokenTtl`, `mcp.dynamicClientRegistration.enabled`,
 *     `mcp.clientIdMetadataDocuments.allowedHosts`, `mcp.signingKeyPem`) are
 *     confirmed against the installed 2.2.0 package's source
 *     (dist/types.d.ts:38-229, dist/lib/mcp/{dcr,cimd,keyStore,token}.js).
 *   - The self-verification target, `${issuer}/.well-known/oauth-
 *     authorization-server` (RFC 8414), is served by
 *     `dist/lib/mcp/wellKnown.js`'s `buildAuthorizationServerMetadata`
 *     (lines 129-166), which advertises `registration_endpoint`/
 *     `token_endpoint` unconditionally (NOTE: `registration_endpoint` is
 *     advertised even though DCR is disabled — the plugin doesn't condition
 *     that field on `dynamicClientRegistration.enabled`; a POST there still
 *     404s per dcr.js:165-167, this is just a metadata-completeness quirk of
 *     the installed package, not a gap in our config) and
 *     `client_id_metadata_document_supported: true` whenever
 *     `clientIdMetadataDocuments.enabled !== false` (wellKnown.js:164 — true
 *     by default, which is what our config relies on), and
 *     `token_endpoint_auth_methods_supported` always includes `"none"`
 *     (wellKnown.js:148-149) — together the exact pair Anthropic's docs say
 *     Claude checks before it will use CIMD instead of DCR (claude.com/docs/
 *     connectors/building/authentication: "Claude selects CIMD only when
 *     your authorization server metadata advertises both
 *     client_id_metadata_document_supported: true and none in
 *     token_endpoint_auth_methods_supported").
 *   - The GitHub OAuth-app callback URL, `${issuer}/oauth/github/callback`,
 *     is the plugin's own README "Configure OAuth Callback" convention
 *     (`https://your-domain/oauth/<provider>/callback`).
 *   - The claude.ai CIMD/redirect-URI allowlist hosts: Anthropic's current
 *     docs (claude.com/docs/connectors/building/authentication, "Callback
 *     URLs" — fetched 2026-07-19) name `https://claude.ai/api/mcp/
 *     auth_callback` as the redirect URI for the hosted Claude surfaces
 *     (Claude.ai web, Desktop, mobile, Cowork), and the lazy-authentication
 *     doc's CIMD section notes "the listed redirect_uris should be required
 *     to be same-origin with the client_id URL" — so claude.ai is the
 *     confirmed CIMD client_id host for that surface. `claude.com` is kept
 *     alongside it because it's this repo's own pre-existing allowlist value
 *     (`resources/OAuth.ts:24`'s `ALLOWED_REDIRECT_URI` for the 1.0
 *     opaque-token AS, and this module's own prior `DEFAULT_REDIRECT_URI_HOSTS`
 *     constant) — carried forward defensively, not newly invented; CIMD
 *     `allowedHosts` only widens which hosts MAY present a client_id URL,
 *     every resolution still runs the full SSRF/document-validation pipeline
 *     in `cimd.js`, so listing an extra host is not a meaningful risk
 *     expansion.
 */

import { existsSync, mkdirSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { generateKeyPairSync, randomBytes } from "node:crypto";

// ─── CIMD constants ──────────────────────────────────────────────────────────

/** Default `clientIdMetadataDocuments.allowedHosts` allowlist — see the
 *  module header's "claude.ai CIMD/redirect-URI allowlist hosts" note for
 *  the citation trail. Schema: node_modules/@harperfast/oauth/dist/
 *  types.d.ts:211-229 (`MCPClientIdMetadataDocumentsConfig.allowedHosts`). */
export const DEFAULT_CIMD_ALLOWED_HOSTS = ["claude.ai", "claude.com"];

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

// ─── RS256 signing keypair ───────────────────────────────────────────────────

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

// ─── @harperfast/oauth config block ──────────────────────────────────────────

export interface McpOAuthConfigBlockParams {
  idpProvider: string;
  /** `clientIdMetadataDocuments.allowedHosts` override — defaults to
   *  `DEFAULT_CIMD_ALLOWED_HOSTS`. */
  cimdAllowedHosts?: string[];
}

/**
 * The `@harperfast/oauth` config block, matching the installed 2.2.0
 * package's field names (node_modules/@harperfast/oauth/dist/types.d.ts).
 * Secrets are `${ENV_VAR}` placeholders — never literal values — so this
 * block is safe to write to harperdb-config.yaml via `set_configuration`
 * (the config file itself carries no secret material; see the
 * secrets-provisioning step for how the referenced env vars land).
 *
 * flair#756: `dynamicClientRegistration: { enabled: false }` is written
 * EXPLICITLY — never omitted. See the module header's "Leaving
 * `dynamicClientRegistration` unset does NOT disable DCR" note: an absent
 * block leaves the plugin's own default (OPEN, ungated registration) live
 * (dcr.js:161-167, types.d.ts:131-144). `enabled: false` is the one shape
 * that actually 404s the endpoint (dcr.js:165-167). No `initialAccessToken`
 * / `allowedRedirectUriHosts` are ever written — there is no gate-token
 * machinery left to populate them with.
 */
export function buildMcpOAuthConfigBlock(params: McpOAuthConfigBlockParams): Record<string, unknown> {
  const provider = params.idpProvider;
  const envPrefix = `OAUTH_${provider.toUpperCase()}`;
  const cimdAllowedHosts = params.cimdAllowedHosts ?? DEFAULT_CIMD_ALLOWED_HOSTS;
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
        // Explicit fail-closed disable — see the doc comment above and the
        // module header for why an omitted block is NOT equivalent to this.
        dynamicClientRegistration: { enabled: false },
        // CIMD is the only supported client-registration path. `allowedHosts`
        // restricts which hosts may present a CIMD client_id URL — schema at
        // node_modules/@harperfast/oauth/dist/types.d.ts:211-229. Every
        // resolution still runs cimd.js's full SSRF/document-validation
        // pipeline regardless of this list.
        clientIdMetadataDocuments: { allowedHosts: cimdAllowedHosts },
        signingKeyPem: "${FLAIR_MCP_SIGNING_KEY_PEM}",
      },
    },
  };
}

/** The exact callback URL to hand the operator when they create the IdP
 *  OAuth app ("with the exact GitHub callback URL printed"). */
export function idpCallbackUrl(issuer: string, idpProvider: string): string {
  return `${issuer.replace(/\/+$/, "")}/oauth/${idpProvider}/callback`;
}

// ─── Secrets bundle ──────────────────────────────────────────────────────────

export interface SecretsBundleParams {
  issuer: string;
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

// ─── Identity mapping (Credential kind:idp) ─────────────────────────────────

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

// ─── Apply config + restart ──────────────────────────────────────────────────

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

// ─── Self-verify ─────────────────────────────────────────────────────────────

export interface SelfVerifyResult {
  ok: boolean;
  issuer?: string;
  registrationEndpoint?: string;
  tokenEndpoint?: string;
  /** Does the AS metadata advertise CIMD support? Requires BOTH
   *  `client_id_metadata_document_supported === true` AND `"none"` present
   *  in `token_endpoint_auth_methods_supported` — the exact pair Anthropic's
   *  docs say Claude's client checks before it will use CIMD instead of
   *  falling back to DCR (see the module header's citation). Populated
   *  whenever the response body parses far enough to check; `undefined`
   *  only when the fetch itself failed or returned non-JSON. */
  cimdSupported?: boolean;
  detail: string;
}

/**
 * Hit the OAuth metadata endpoint from the operator's machine against the
 * PUBLIC origin — the verification that matters is the one claude.ai's
 * perspective sees (scenario addendum). Never reports success on hope: any
 * unreachable/malformed/mismatched response, OR a response that doesn't
 * advertise CIMD support, is `ok: false` with a specific `detail`.
 *
 * flair#756: since CIMD is the only supported client-registration path now,
 * "the /mcp OAuth surface is properly enabled" means "and a CIMD client can
 * actually use it" — this single check is reused by `enable`'s own
 * self-verify step, `grant`/`revoke`'s workflow gate (src/cli.ts), and
 * `flair mcp status`, so all four commands agree on what "enabled" means.
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

  // flair#756: confirm CIMD is actually advertised (node_modules/@harperfast/
  // oauth/dist/lib/mcp/wellKnown.js:129-165's buildAuthorizationServerMetadata:
  // `client_id_metadata_document_supported` is set only when
  // clientIdMetadataDocuments.enabled !== false; `token_endpoint_auth_methods_
  // supported` always includes "none"). Both are required per Anthropic's docs
  // before Claude will use CIMD (see module header).
  const cimdSupported =
    body?.client_id_metadata_document_supported === true &&
    Array.isArray(body?.token_endpoint_auth_methods_supported) &&
    body.token_endpoint_auth_methods_supported.includes("none");
  if (!cimdSupported) {
    return {
      ok: false,
      issuer: body.issuer,
      registrationEndpoint: body.registration_endpoint,
      tokenEndpoint: body.token_endpoint,
      cimdSupported: false,
      detail: `${url} answered but does not advertise CIMD support (client_id_metadata_document_supported / "none" in token_endpoint_auth_methods_supported) — is clientIdMetadataDocuments.enabled explicitly false?`,
    };
  }

  return {
    ok: true,
    issuer: body.issuer,
    registrationEndpoint: body.registration_endpoint,
    tokenEndpoint: body.token_endpoint,
    cimdSupported: true,
    detail: "OAuth metadata endpoint answering on the public origin, advertising CIMD support",
  };
}

/** The exact block to paste into claude.ai → Settings → Connectors. No
 *  client ID to hand over — CIMD-based connectors have Claude present its
 *  OWN client_id (a URL it hosts), never one this server issues. */
export function buildClaudePasteBlock(resource: string): string {
  return [
    "claude.ai → Settings → Connectors → Add custom connector",
    `  URL: ${resource}`,
    "  (no client ID to enter — Claude presents its own Client ID Metadata Document URL automatically)",
  ].join("\n");
}

// ─── Orchestration ────────────────────────────────────────────────────────────

export type EnableStepName =
  | "local-origin-check"
  | "signing-key"
  | "config-block"
  | "idp-credentials"
  | "secrets-provisioning"
  | "identity-mapping"
  | "apply-config-and-restart"
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
  signingKeyFilePath?: string;
  secretsMechanism?: SecretsMechanism;
  secretsStagingPath?: string;
  /** `clientIdMetadataDocuments.allowedHosts` override — defaults to
   *  `DEFAULT_CIMD_ALLOWED_HOSTS`. */
  cimdAllowedHosts?: string[];
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
  pasteBlock?: string;
  secretsMechanism?: SecretsMechanism;
  secretsPath?: string;
  signingKeyFilePath?: string;
  callbackUrl?: string;
}

/**
 * Full `flair mcp enable` orchestration. No `process.exit`, no console
 * output — directly unit-testable with a mocked fetch and temp dirs, same
 * split as `grantMcpClient`/`revokeMcpClient`. Returns a step-by-step log so
 * a failure names exactly which step to re-run (never reports success on
 * hope).
 *
 * flair#756: no DCR step anywhere in this flow — CIMD needs no
 * pre-registration, so there is nothing to do after the restart besides
 * self-verify. `self-verify` is now the ONLY live call that happens after
 * `apply-config-and-restart`.
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
    // ── RS256 signing keypair ─────────────────────────────────────────────────
    const keyResult = ensureSigningKeyFile(params.signingKeyFilePath, { generate: deps.generateRsaKeyPair });
    push("signing-key", true, `signing key ${keyResult.reused ? "reused" : "generated"} at ${keyResult.path} (0600)`);

    // ── @harperfast/oauth config block (CIMD-only; DCR explicitly disabled) ──
    const cimdAllowedHosts = params.cimdAllowedHosts ?? DEFAULT_CIMD_ALLOWED_HOSTS;
    const configBlock = buildMcpOAuthConfigBlock({ idpProvider, cimdAllowedHosts });
    push(
      "config-block",
      true,
      `built the @harperfast/oauth mcp config block (accessTokenTtl=${REQUIRED_ACCESS_TOKEN_TTL}, ` +
        `dynamicClientRegistration.enabled=false, clientIdMetadataDocuments.allowedHosts=${JSON.stringify(cimdAllowedHosts)})`,
    );

    // ── IdP OAuth-app credential intake ───────────────────────────────────────
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
        signingKeyFilePath: keyResult.path,
      };
    }

    // ── Secrets provisioning (shape-aware, never silent) ──────────────────────
    const signingKeyPem = readSigningKeyFile(keyResult.path);
    const bundle = buildSecretsBundle({
      issuer,
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

    // ── Identity mapping (Credential kind:idp) ────────────────────────────────
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
        `not applied: pass --confirm-secrets-applied once the staged secrets are live on ${params.instance}, then re-run \`flair mcp enable\` (earlier steps are idempotent and will reuse what's already provisioned).`,
      );
      return { ok: false, dryRun, steps, failedStep: "apply-config-and-restart", secretsMechanism: secretsResult.mechanism, secretsPath: secretsResult.path };
    }

    // ── Apply config + restart ────────────────────────────────────────────────
    await applyRemoteConfigAndRestart(
      { opsPortOrUrl: params.instance, adminUser: params.adminUser, adminPass: params.adminPass, configBlock },
      { fetchImpl: deps.fetchImpl },
    );
    push("apply-config-and-restart", true, `set_configuration + restart succeeded against ${params.instance}`);

    // ── Self-verify from the operator's machine, public origin, CIMD-inclusive
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
      pasteBlock: buildClaudePasteBlock(resource),
      secretsMechanism: secretsResult.mechanism,
      secretsPath: secretsResult.path,
      signingKeyFilePath: keyResult.path,
      callbackUrl,
    };
  } catch (err: any) {
    const lastStep = steps.length > 0 ? steps[steps.length - 1].step : "signing-key";
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
  /** flair#756: does the live metadata endpoint advertise CIMD support
   *  (allowedHosts config presence, from the operator's perspective — the
   *  only signal `status` can see WITHOUT admin credentials; see
   *  `selfVerifyMcpMetadata`'s doc comment for the exact check)? */
  cimdSupported?: boolean;
  detail: string;
  machineClientCount?: number;
}

/**
 * Surfaces LIVE state (not a stale local marker): hits the same well-known
 * metadata endpoint `enable`'s self-verify step checks. A 200 with the
 * expected shape AND CIMD advertised means the surface is enabled and
 * usable by a CIMD client; anything else means disabled/unreachable/
 * misconfigured — `status` never guesses from local files alone (this is
 * the same "never report success on hope" posture as self-verify).
 */
export async function mcpStatus(params: McpStatusParams, deps: McpStatusDeps = {}): Promise<McpStatusResult> {
  const verify = await selfVerifyMcpMetadata(params.instance, { fetchImpl: deps.fetchImpl });
  const machineClientCount = deps.countMachineClients?.();

  return {
    instance: params.instance,
    enabled: verify.ok,
    metadataReachable: verify.ok,
    issuer: verify.issuer,
    registrationEndpoint: verify.registrationEndpoint,
    tokenEndpoint: verify.tokenEndpoint,
    cimdSupported: verify.cimdSupported,
    detail: verify.detail,
    machineClientCount,
  };
}
