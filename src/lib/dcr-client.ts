/**
 * dcr-client.ts — the shared "DCR gate token" contract, plus the RFC 7591
 * Dynamic Client Registration (DCR) HTTP client, extracted so `flair mcp
 * enable` (not yet built) and `flair mcp grant`/`revoke` (flair#746, this
 * module's first consumer) read the operator's DCR gate token from exactly
 * ONE documented, secured location instead of drifting.
 *
 * ── The token-location contract (Kern's #719 verdict condition) ─────────────
 * The DCR gate token — the same value an operator sets as
 * `@harperfast/oauth`'s `mcp.dynamicClientRegistration.initialAccessToken`
 * (see docs/notes/mcp-oauth-model2.md's config snippet, which already names
 * it `FLAIR_MCP_DCR_TOKEN`) — is read from, in order:
 *
 *   1. `FLAIR_MCP_DCR_TOKEN` env var.
 *   2. A 0600 file at `~/.flair/mcp-dcr-token` (DEFAULT_DCR_TOKEN_FILE_PATH),
 *      mirroring the established `~/.flair/admin-pass` pattern
 *      (readAdminPassFileSecure in src/cli.ts) — same fail-closed permission
 *      check (refuses a world/group-readable file rather than silently
 *      reading it).
 *
 * `enable` WRITES the token to one of these two locations (env is the
 * operator's choice at process-launch time; the file is what `enable` itself
 * would create for a long-lived local install). `grant`/`revoke` only ever
 * READ it, via `requireDcrToken()` — never a fallback to a world-readable
 * config file, never printed, never logged.
 *
 * ── Ground-truth correction to the #719/#746 design record ──────────────────
 * The #719 design round (and Sherlock/Kern's verdicts on it) described
 * `flair mcp grant` as "minting a named machine client via the gated DCR
 * endpoint (client_credentials grant)" — i.e., literally POSTing to
 * `/oauth/mcp/register` with a client_credentials shape. Reading the
 * REAL, published `@harperfast/oauth@2.2.0` source
 * (node_modules/@harperfast/oauth/dist/lib/mcp/{dcr,clientValidator,token}.js)
 * during implementation of this module shows that assumption does not hold:
 *
 *   - `dcr.js`'s DCR handler validates `grant_types` against
 *     `clientValidator.js`'s `SUPPORTED_GRANT_TYPES = new Set(['authorization_code',
 *     'refresh_token'])` — `client_credentials` is not a legal DCR grant type
 *     at all; a DCR registration requesting it is rejected with
 *     `invalid_client_metadata`.
 *   - `token.js`'s `handleClientCredentialsGrant` requires
 *     `client._cimd === true` — literally: "Pinned to CIMD-resolved clients
 *     … A stored (DCR) record must never mint here". A DCR-registered client
 *     can never successfully use the client_credentials grant, by
 *     construction.
 *   - This is BY DESIGN, not a gap: CIMD (Client ID Metadata Documents,
 *     oauth#161, shipped in 2.2.0) is the machine-client registration path
 *     that REPLACED DCR for this exact use case — see
 *     resources/MCPClientMetadata.ts's own header ("CIMD is explicitly the
 *     stateless registration path — no DCR row to replicate across Fabric
 *     nodes") and docs/notes/mcp-agent-auth-consumer.md's "What's NOT in
 *     this slice" section, which explicitly says a DCR-shaped registration
 *     command ("`flair agent register-mcp-client`") is "not needed for the
 *     CIMD path".
 *
 * So `flair mcp grant` (src/cli.ts, `grantMcpClient`) does NOT call
 * `registerDcrClient` below — it provisions a flair Agent + Ed25519 keypair
 * (the existing #663 CIMD machine-identity primitive), whose CIMD document
 * (served live by `resources/MCPClientMetadata.ts`) IS the client
 * registration. `requireDcrToken()` is still the gate `grant`/`revoke`
 * enforce before touching anything — an APPLICATION-LEVEL workflow gate
 * ("prove you already ran `flair mcp enable`"), layered on top of the real
 * security boundary (Harper admin-pass, exactly as `agent add` already
 * requires) — not a substitute for it, and not a loosening of anything: a
 * caller who lacks the DCR token is refused with an actionable error
 * ("run `flair mcp enable` first") instead of a confusing downstream 401.
 *
 * `registerDcrClient` below remains genuinely useful and is exported for the
 * future `enable` builder: DCR is still the right, and only, mechanism for
 * pre-registering the INTERACTIVE authorization_code client (Claude
 * Desktop / claude.ai) — that is what `@harperfast/oauth`'s DCR endpoint
 * actually gates. Both `enable` and `grant`/`revoke` import the token
 * contract from this one module so neither drifts from the other.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ─── Token-location contract ────────────────────────────────────────────────

/** Env var carrying the DCR gate token — same name already documented in
 *  docs/notes/mcp-oauth-model2.md as the value wired into
 *  `dynamicClientRegistration.initialAccessToken`. */
export const DCR_TOKEN_ENV = "FLAIR_MCP_DCR_TOKEN";

/** Default 0600 file location for the DCR gate token, when not passed via env. */
export function defaultDcrTokenFilePath(): string {
  return join(homedir(), ".flair", "mcp-dcr-token");
}

export interface DcrTokenResult {
  token: string;
  source: "env" | "file";
  /** Only set when source === "file". */
  path?: string;
}

/** Thrown by requireDcrToken when neither location yields a token. */
export class DcrTokenNotFoundError extends Error {
  constructor(filePath: string) {
    super(
      `No DCR gate token found. Set ${DCR_TOKEN_ENV} or run \`flair mcp enable\` first ` +
        `(it provisions this token and writes it to ${filePath}, mode 0600). ` +
        `Never fall back to a world-readable config file for this value.`,
    );
    this.name = "DcrTokenNotFoundError";
  }
}

/** Thrown when the token file exists but has unsafe (world/group-readable) permissions. */
export class DcrTokenFilePermissionError extends Error {
  constructor(path: string, modeOctal: string) {
    super(
      `Refusing to read DCR gate token at ${path}: permissions ${modeOctal} are too open. ` +
        `Run \`chmod 600 ${path}\` to restrict to owner-only.`,
    );
    this.name = "DcrTokenFilePermissionError";
  }
}

/**
 * Read the DCR gate token per the documented contract: env var first, then
 * the 0600 file. Returns null if neither location has a value — callers that
 * need to fail closed with an actionable message should use
 * `requireDcrToken` instead. Throws `DcrTokenFilePermissionError` if the file
 * exists but is not owner-only (fails closed rather than silently reading an
 * over-exposed secret — mirrors `readAdminPassFileSecure` in src/cli.ts).
 */
export function readDcrToken(opts: { filePath?: string } = {}): DcrTokenResult | null {
  const envToken = (process.env[DCR_TOKEN_ENV] ?? "").trim();
  if (envToken) return { token: envToken, source: "env" };

  const filePath = opts.filePath ?? defaultDcrTokenFilePath();
  if (!existsSync(filePath)) return null;

  const st = statSync(filePath);
  if (st.mode & 0o077) {
    const modeOctal = (st.mode & 0o777).toString(8).padStart(3, "0");
    throw new DcrTokenFilePermissionError(filePath, modeOctal);
  }
  const content = readFileSync(filePath, "utf-8").replace(/\s+$/, "");
  if (!content) return null;
  return { token: content, source: "file", path: filePath };
}

/** `readDcrToken`, but throws `DcrTokenNotFoundError` (actionable message)
 *  instead of returning null when no token is found at either location. */
export function requireDcrToken(opts: { filePath?: string } = {}): DcrTokenResult {
  const result = readDcrToken(opts);
  if (!result) {
    throw new DcrTokenNotFoundError(opts.filePath ?? defaultDcrTokenFilePath());
  }
  return result;
}

// ─── RFC 7591 DCR HTTP client (for the future `enable` builder) ────────────

export interface DcrRegisterParams {
  /** This instance's public origin (FLAIR_MCP_ISSUER/FLAIR_PUBLIC_URL). Used
   *  to derive `<issuer>/oauth/mcp/register` when `registerEndpoint` is omitted. */
  issuer?: string;
  /** Explicit registration endpoint URL; overrides `issuer` derivation. */
  registerEndpoint?: string;
  /** The DCR gate token (Authorization: Bearer) — pass the value from
   *  `requireDcrToken()`; this function never reads the token contract itself. */
  dcrToken: string;
  redirectUris: string[];
  clientName?: string;
  /** Defaults to ["authorization_code", "refresh_token"] — the only grant
   *  types the plugin's DCR endpoint accepts (see module header). */
  grantTypes?: string[];
  responseTypes?: string[];
  tokenEndpointAuthMethod?: string;
  contacts?: string[];
  /** Injectable fetch (tests only; defaults to the global). */
  fetchImpl?: typeof fetch;
}

export interface DcrRegisterResult {
  client_id: string;
  client_name?: string;
  redirect_uris?: string[];
  grant_types?: string[];
  response_types?: string[];
  token_endpoint_auth_method?: string;
  client_secret?: string;
  client_secret_expires_at?: number;
  client_id_issued_at?: number;
  [key: string]: unknown;
}

export class DcrRegisterError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly error?: string,
  ) {
    super(message);
    this.name = "DcrRegisterError";
  }
}

function deriveRegisterEndpoint(issuer: string): string {
  return `${issuer.replace(/\/+$/, "")}/oauth/mcp/register`;
}

/**
 * POST to the `@harperfast/oauth` plugin's `POST /oauth/mcp/register`
 * (RFC 7591 DCR), gated by `mcp.dynamicClientRegistration.initialAccessToken`
 * (dcr.js's `checkInitialAccessToken`). Registers an INTERACTIVE
 * authorization_code client — never used for machine/client_credentials
 * identities (see module header for why). Not called by `flair mcp
 * grant`/`revoke` in this slice; exported for the future `flair mcp enable`
 * builder's pre-registration step.
 */
export async function registerDcrClient(params: DcrRegisterParams): Promise<DcrRegisterResult> {
  const endpoint = params.registerEndpoint ?? (params.issuer ? deriveRegisterEndpoint(params.issuer) : undefined);
  if (!endpoint) {
    throw new Error("registerDcrClient: either issuer or registerEndpoint is required");
  }
  if (!params.dcrToken) {
    throw new Error("registerDcrClient: dcrToken is required");
  }
  if (!params.redirectUris || params.redirectUris.length === 0) {
    throw new Error("registerDcrClient: redirectUris must be a non-empty array");
  }

  const fetchImpl = params.fetchImpl ?? fetch;
  const body: Record<string, unknown> = {
    redirect_uris: params.redirectUris,
    grant_types: params.grantTypes ?? ["authorization_code", "refresh_token"],
    response_types: params.responseTypes ?? ["code"],
    token_endpoint_auth_method: params.tokenEndpointAuthMethod ?? "none",
  };
  if (params.clientName) body.client_name = params.clientName;
  if (params.contacts) body.contacts = params.contacts;

  const res = await fetchImpl(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${params.dcrToken}`,
    },
    body: JSON.stringify(body),
  });

  let payload: any;
  try {
    payload = await res.json();
  } catch {
    throw new DcrRegisterError(`DCR endpoint returned a non-JSON response (HTTP ${res.status})`, res.status);
  }

  if (!res.ok) {
    const errorCode = typeof payload?.error === "string" ? payload.error : "error";
    const description =
      typeof payload?.error_description === "string" ? `: ${payload.error_description}` : "";
    throw new DcrRegisterError(
      `DCR registration failed (HTTP ${res.status} ${errorCode})${description}`,
      res.status,
      errorCode,
    );
  }

  if (typeof payload?.client_id !== "string" || !payload.client_id) {
    throw new DcrRegisterError("DCR endpoint response is missing client_id", res.status);
  }

  return payload as DcrRegisterResult;
}
