/**
 * RFC 7523 client_assertion signing — the Flair/consumer half of headless
 * agent-auth to a Harper MCP `/mcp` endpoint.
 *
 * Builds + signs the `client_assertion` JWT a Flair agent presents to an
 * OAuth token endpoint for the `client_credentials` grant with
 * `private_key_jwt` client authentication (RFC 7523 §2.2), using the agent's
 * EXISTING Ed25519 identity key — no new key material, no browser, no human.
 *
 * The exact claim shape here is deliberately pinned to what
 * HarperFast/oauth PR #165 (`src/lib/mcp/clientAssertion.ts`,
 * merged @ commit d48c3b2) verifies:
 *   - header: `alg` exactly `EdDSA`; `typ` "JWT" when present.
 *   - payload: `iss` = `sub` = `client_id`; `aud` = the token endpoint
 *     (exact string match); `exp` required, ≤ 60s out; `iat` required;
 *     `jti` required (replay guard, enforced server-side via
 *     `assertionJtiStore.ts`).
 * See test/unit/mcp-client-assertion.test.ts for a mirror of that
 * verification, run against assertions this module produces.
 *
 * ── oauth#161/#162/#163, shipped in @harperfast/oauth@2.2.0 ─────────────────
 * The token-endpoint grant that CONSUMES this assertion
 * (`grant_type=client_credentials`) shipped as HarperFast/oauth PR #170
 * (closes issues #161/#162) in the 2.2.0 release; rate limiting (#171,
 * closes #163) shipped in the same release. Confirmed against the published
 * package's source (`node_modules/@harperfast/oauth/dist/lib/mcp/token.js`,
 * `.../cimd.js`), not guessed:
 *   - `client_assertion_type` = `urn:ietf:params:oauth:client-assertion-
 *     type:jwt-bearer`; `client_assertion` = the signed JWT; `client_id`
 *     required in the form body and MUST equal the assertion's `iss`/`sub`
 *     — already true here by construction (`buildTokenRequestForm`'s
 *     `clientId` param is always the same value callers pass as
 *     `signClientAssertion`'s `clientId`, which becomes both `iss` and
 *     `sub`).
 *   - RFC 8707 `resource` parameter: accepted, exact-match, fail-closed,
 *     defaulting to the configured canonical resource — `buildTokenRequestForm`
 *     already carries an optional `resource` pass-through (see below), and
 *     `defaultMcpResource()` supplies the configured canonical default
 *     (mirrors `resources/mcp-oauth-flag.ts`'s `mcpResource()` — the same
 *     `<issuer>/mcp` value the AS will exact-match against).
 *   - Issued token `sub` = `client_id`; access-token TTL default 300s
 *     (`mcp.clientCredentials.accessTokenTtl`); no `refresh_token` — agents
 *     re-mint on 401/near-expiry instead (see `getMcpAccessToken` below).
 *   - Issuance is rate-limited per verified client_id
 *     (`mcp.clientCredentials.rateLimit`, default 30/min) — debited AFTER
 *     assertion verification, so a forged assertion can never drain a real
 *     client's bucket. Over-limit is `429 {"error":"slow_down"}` with a
 *     `Retry-After` header (seconds). `requestMcpAccessToken` below honors it.
 * `requestMcpAccessToken` performs the real POST; `getMcpAccessToken` wraps
 * it with the two consumer requirements the 2.2.0 rate limiter adds (pinned
 * in flair#663's tracking-issue thread): token caching (reuse until
 * near-expiry, mint sparingly) and jittered Retry-After backoff on 429.
 * See docs/notes/mcp-agent-auth-consumer.md.
 */

import { createPrivateKey, createPublicKey, randomUUID, sign, type KeyObject } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ─── RFC 7523 constants ─────────────────────────────────────────────────────

/** RFC 7523 §2.2 value for `client_assertion_type`. */
export const CLIENT_ASSERTION_TYPE_JWT_BEARER =
  "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";

/**
 * Maximum assertion lifetime (`exp - iat`), in seconds. Pinned to 60 to
 * match HarperFast/oauth PR #165's `DEFAULT_MAX_EXPIRES_IN_SECONDS` — an
 * assertion signed with a longer window would be rejected server-side.
 */
export const MAX_ASSERTION_LIFETIME_SECONDS = 60;

// ─── JWK types ──────────────────────────────────────────────────────────────

export interface Ed25519Jwk {
  kty: "OKP";
  crv: "Ed25519";
  x: string;
  kid?: string;
}

// ─── Key loading ────────────────────────────────────────────────────────────

/**
 * Locate an agent's private key file. Search order mirrors `resolveKeyPath`
 * in src/cli.ts (the existing TPS-Ed25519 REST-auth path) exactly, with one
 * addition: an explicit `keysDirOverride` (this module's `--keys-dir` CLI
 * flag) takes priority over everything, including `FLAIR_KEY_DIR`.
 */
export function resolveAgentKeyPath(agentId: string, keysDirOverride?: string): string | null {
  const candidates = [
    keysDirOverride ? join(keysDirOverride, `${agentId}.key`) : null,
    process.env.FLAIR_KEY_DIR ? join(process.env.FLAIR_KEY_DIR, `${agentId}.key`) : null,
    join(homedir(), ".flair", "keys", `${agentId}.key`),
    join(homedir(), ".tps", "secrets", "flair", `${agentId}-priv.key`),
  ].filter((p): p is string => Boolean(p));
  return candidates.find((p) => existsSync(p)) ?? null;
}

/** Fixed ASN.1 prefix that turns a raw 32-byte Ed25519 seed into a PKCS8 DER key. */
const ED25519_PKCS8_HEADER = Buffer.from("302e020100300506032b657004220420", "hex");

/**
 * Load an Ed25519 private key from disk. Accepts every format already in use
 * across this repo's agent keys (mirrors `buildEd25519Auth` in src/cli.ts):
 *   - raw 32-byte binary seed
 *   - base64-encoded 32-byte seed
 *   - base64-encoded full PKCS8 DER (the standard `~/.tps/secrets/flair/
 *     <agentId>-priv.key` format written by flair-client.mjs et al.)
 *   - raw PEM/DER bytes as a last-resort fallback
 */
export function loadEd25519PrivateKeyFromFile(filePath: string): KeyObject {
  const raw = readFileSync(filePath);
  if (raw.length === 32) {
    return createPrivateKey({
      key: Buffer.concat([ED25519_PKCS8_HEADER, raw]),
      format: "der",
      type: "pkcs8",
    });
  }
  const decoded = Buffer.from(raw.toString("utf-8").trim(), "base64");
  if (decoded.length === 32) {
    return createPrivateKey({
      key: Buffer.concat([ED25519_PKCS8_HEADER, decoded]),
      format: "der",
      type: "pkcs8",
    });
  }
  try {
    return createPrivateKey({ key: decoded, format: "der", type: "pkcs8" });
  } catch {
    return createPrivateKey(raw);
  }
}

/** Derive the public JWK (OKP/Ed25519) for a loaded private key. */
export function publicJwkFromPrivateKey(privateKey: KeyObject): Ed25519Jwk {
  const pub = createPublicKey(privateKey);
  const jwk = pub.export({ format: "jwk" }) as { kty?: string; crv?: string; x?: string };
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.x !== "string" || !jwk.x) {
    throw new Error("private key is not an Ed25519 key");
  }
  return { kty: "OKP", crv: "Ed25519", x: jwk.x };
}

// ─── Assertion signing ──────────────────────────────────────────────────────

export interface SignClientAssertionParams {
  /** The client_id being authenticated; becomes both `iss` and `sub`. */
  clientId: string;
  /** The token-endpoint URL; becomes `aud` (exact match required). */
  tokenEndpoint: string;
  /** The agent's Ed25519 private key. */
  privateKey: KeyObject;
  /** `exp - iat` window, seconds. Default + hard cap: MAX_ASSERTION_LIFETIME_SECONDS. */
  expiresInSeconds?: number;
  /** Override `jti` (defaults to a random UUID). Exposed for deterministic tests. */
  jti?: string;
  /** Override `iat`, unix seconds (defaults to now). Exposed for deterministic tests. */
  nowSeconds?: number;
}

export interface ClientAssertionClaims {
  iss: string;
  sub: string;
  aud: string;
  exp: number;
  iat: number;
  jti: string;
}

export interface SignedClientAssertion {
  /** Compact-serialized JWT — the `client_assertion` form-body value. */
  assertion: string;
  claims: ClientAssertionClaims;
}

function clampExpiresIn(requested: number | undefined): number {
  const n = requested ?? MAX_ASSERTION_LIFETIME_SECONDS;
  if (!Number.isFinite(n) || n <= 0) return MAX_ASSERTION_LIFETIME_SECONDS;
  return Math.min(n, MAX_ASSERTION_LIFETIME_SECONDS);
}

function base64urlJson(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64url");
}

/**
 * Build + sign an RFC 7523 client_assertion JWT for the client_credentials
 * grant. Pure given a KeyObject — callers load the key separately (see
 * loadEd25519PrivateKeyFromFile) so this stays independently testable with
 * an ephemeral test keypair.
 */
export function signClientAssertion(params: SignClientAssertionParams): SignedClientAssertion {
  const { clientId, tokenEndpoint, privateKey } = params;
  if (!clientId) throw new Error("clientId is required");
  if (!tokenEndpoint) throw new Error("tokenEndpoint is required");

  const expiresIn = clampExpiresIn(params.expiresInSeconds);
  const iat = Math.floor(params.nowSeconds ?? Date.now() / 1000);
  const exp = iat + expiresIn;
  const jti = params.jti ?? randomUUID();

  // header.typ is optional per RFC 7515 §4.1.9, but #165 accepts it when
  // present (case-insensitively) — include it for maximum interop.
  const header = { alg: "EdDSA", typ: "JWT" };
  const claims: ClientAssertionClaims = { iss: clientId, sub: clientId, aud: tokenEndpoint, exp, iat, jti };

  const headerB64 = base64urlJson(header);
  const payloadB64 = base64urlJson(claims);
  const signingInput = `${headerB64}.${payloadB64}`;
  // Ed25519 (EdDSA) takes no digest algorithm — pass null, per RFC 8032 and
  // matching #165's own verify call (`verifySignature(null, ...)`).
  const signature = sign(null, Buffer.from(signingInput), privateKey);
  const assertion = `${signingInput}.${signature.toString("base64url")}`;

  return { assertion, claims };
}

// ─── Token-request shape (documentation + tests only — see stub below) ─────

export interface TokenRequestForm {
  grant_type: "client_credentials";
  client_assertion_type: typeof CLIENT_ASSERTION_TYPE_JWT_BEARER;
  client_assertion: string;
  /** MUST equal the assertion's `iss`/`sub` claims — oauth#162 requirement. */
  client_id: string;
  /**
   * RFC 8707 resource indicator — the canonical `/mcp` URI being requested.
   * oauth#162 accepts this, exact-match/fail-closed, defaulting to the
   * configured canonical resource when the caller omits it (see
   * `defaultMcpResource()` below, and the CLI wiring in `flair mcp token`,
   * which passes `opts.resource ?? defaultMcpResource()`).
   */
  resource?: string;
}

/**
 * The form-body this assertion would be sent in, per oauth#162's scope (RFC
 * 7523 `client_credentials` grant + RFC 8707 `resource`). Pure/testable;
 * NOT sent anywhere by this module — see requestMcpAccessToken. Callers are
 * responsible for passing the SAME `clientId` used to sign the assertion
 * (`signClientAssertion`'s `iss`/`sub`) — every call site in this repo
 * (`flair mcp token` in src/cli.ts) already does this from a single shared
 * local.
 */
export function buildTokenRequestForm(params: {
  clientId: string;
  assertion: string;
  /** Defaults are the CALLER's responsibility (e.g. `defaultMcpResource()`) — this function is a pure pass-through and never invents a value. */
  resource?: string;
}): TokenRequestForm {
  const form: TokenRequestForm = {
    grant_type: "client_credentials",
    client_assertion_type: CLIENT_ASSERTION_TYPE_JWT_BEARER,
    client_assertion: params.assertion,
    client_id: params.clientId,
  };
  if (params.resource) form.resource = params.resource;
  return form;
}

// ─── Live token round-trip ──────────────────────────────────────────────────

/** A minted MCP access token, plus the bookkeeping `getMcpAccessToken`'s cache needs. */
export interface McpAccessToken {
  accessToken: string;
  tokenType: string;
  /** Server-reported TTL, seconds (defaults to 300 if the response omits it — matches the plugin's client_credentials default). */
  expiresIn: number;
  scope?: string;
  /** `Date.now()` at mint time. */
  mintedAtMs: number;
  /** `mintedAtMs + expiresIn * 1000`. */
  expiresAtMs: number;
}

export class McpTokenRequestError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly error?: string,
  ) {
    super(message);
    this.name = "McpTokenRequestError";
  }
}

export interface RequestMcpAccessTokenOptions {
  /** Injectable `fetch` (tests only; defaults to the global). */
  fetchImpl?: typeof fetch;
  /** Injectable sleep (tests only, so 429 backoff tests don't actually wait). */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable RNG for jitter (tests only, for determinism). Range [0, 1). */
  random?: () => number;
  /** Max 429 retries before giving up. Default 3 — a client_credentials assertion is only valid ≤60s, so unbounded retry would frequently outlive it anyway. */
  maxRetries?: number;
  /** Injectable clock (tests only) — used for `mintedAtMs`/`expiresAtMs` so cache-freshness checks in `getMcpAccessToken` compare against the same clock. */
  now?: () => number;
}

const DEFAULT_MAX_429_RETRIES = 3;
// Ceiling on a single backoff sleep: a misconfigured or hostile server
// returning an absurd Retry-After must not stall the caller indefinitely
// (mirrors the plugin's own MAX_RETRY_AFTER_SECONDS defense-in-depth
// posture at the source of the header, node_modules/@harperfast/oauth's
// rateLimit.ts — this is the client-side counterpart of that cap).
const MAX_BACKOFF_MS = 60_000;
// Fallback backoff (exponential, doubling per attempt) when the server 429s
// without a Retry-After header at all — should not happen against the
// plugin (it always sets one, see mcp-client-assertion.ts's module header),
// but a client MUST NOT hammer even a non-conformant server.
const FALLBACK_BASE_MS = 1_000;

/**
 * POST the `client_credentials` grant to the MCP token endpoint (oauth#162,
 * shipped in @harperfast/oauth@2.2.0's PR #170). On `429 slow_down`
 * (issuance rate limit, #171/#163), honors the `Retry-After` header with
 * FULL JITTER (sleep a random duration in `[0, Retry-After]`, per the
 * standard token-bucket backoff pattern — never hammer, and never retry in
 * lockstep with other rate-limited callers), retrying up to `maxRetries`
 * times before giving up.
 *
 * Throws `McpTokenRequestError` on any non-2xx response (including the
 * final 429). Never retries non-429 errors — those are the AS telling us
 * the request itself is wrong (bad assertion, unresolvable client, wrong
 * resource), and retrying identically would just repeat the same rejection
 * (worse, it would burn a fresh `jti` for no reason on a client-side bug).
 */
export async function requestMcpAccessToken(
  form: TokenRequestForm,
  tokenEndpoint: string,
  opts: RequestMcpAccessTokenOptions = {},
): Promise<McpAccessToken> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const random = opts.random ?? Math.random;
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_429_RETRIES;
  const now = opts.now ?? Date.now;

  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(form)) {
    if (value !== undefined) body.set(key, String(value));
  }

  for (let attempt = 0; ; attempt++) {
    const mintedAtMs = now();
    const res = await fetchImpl(tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (res.status === 429 && attempt < maxRetries) {
      // `res.headers.get()` returns null (not undefined) when absent, and
      // `Number(null) === 0` — a bare `Number(...)` here would silently read
      // a MISSING header as "retry immediately", not "no header present".
      // Distinguish explicitly so absence falls through to the exponential
      // fallback below instead.
      const retryAfterHeader = res.headers.get("retry-after");
      const retryAfterRaw = retryAfterHeader === null ? NaN : Number(retryAfterHeader);
      const baseMs =
        Number.isFinite(retryAfterRaw) && retryAfterRaw >= 0
          ? retryAfterRaw * 1000
          : FALLBACK_BASE_MS * 2 ** attempt;
      const jitteredMs = Math.min(MAX_BACKOFF_MS, Math.round(random() * baseMs));
      // Drain the body so the connection can be reused; the error payload
      // isn't needed for a retry.
      await res.body?.cancel?.().catch(() => {});
      await sleep(jitteredMs);
      continue;
    }

    let payload: any;
    try {
      payload = await res.json();
    } catch {
      throw new McpTokenRequestError(
        `MCP token endpoint returned a non-JSON response (HTTP ${res.status})`,
        res.status,
      );
    }

    if (!res.ok) {
      const errorCode = typeof payload?.error === "string" ? payload.error : "error";
      const description = typeof payload?.error_description === "string" ? `: ${payload.error_description}` : "";
      throw new McpTokenRequestError(
        `MCP token request failed (HTTP ${res.status} ${errorCode})${description}`,
        res.status,
        errorCode,
      );
    }

    if (typeof payload?.access_token !== "string" || !payload.access_token) {
      throw new McpTokenRequestError("MCP token endpoint response is missing access_token", res.status);
    }

    const expiresIn = Number.isFinite(payload.expires_in) ? Number(payload.expires_in) : 300;
    return {
      accessToken: payload.access_token,
      tokenType: typeof payload.token_type === "string" ? payload.token_type : "Bearer",
      expiresIn,
      scope: typeof payload.scope === "string" ? payload.scope : undefined,
      mintedAtMs,
      expiresAtMs: mintedAtMs + expiresIn * 1000,
    };
  }
}

// ─── Token caching (consumer requirement — flair#663 tracking-issue thread) ─
//
// The 2.2.0 rate limiter (mcp.clientCredentials.rateLimit, default 30/min)
// is debited PER MINT, not per use — so a caller that re-signs+re-requests
// on every tool call would burn a real agent's quota for no reason. Cache
// the minted token per (clientId, tokenEndpoint, resource) and reuse it
// until it's within `refreshMarginMs` of expiry.

const mcpTokenCache = new Map<string, McpAccessToken>();

function mcpTokenCacheKey(clientId: string, tokenEndpoint: string, resource: string | undefined): string {
  return `${clientId} ${tokenEndpoint} ${resource ?? ""}`;
}

/** Drop all cached tokens (tests only, or a caller that wants a hard reset — e.g. after rotating the agent's key). */
export function clearMcpAccessTokenCache(): void {
  mcpTokenCache.clear();
}

export interface GetMcpAccessTokenParams {
  clientId: string;
  tokenEndpoint: string;
  privateKey: KeyObject;
  /** RFC 8707 resource indicator; part of the cache key since a token minted for one resource cannot serve another. */
  resource?: string;
  /** Assertion `exp - iat` window, seconds. Default + hard cap: MAX_ASSERTION_LIFETIME_SECONDS. */
  expiresInSeconds?: number;
  /** Re-mint once fewer than this many ms remain before the cached token's expiry. Default 30s — comfortably inside the client_credentials grant's short (default 300s) TTL. */
  refreshMarginMs?: number;
  /** Skip the cache and mint a fresh token unconditionally (e.g. after a 401 the caller suspects means the cached token was revoked). */
  forceRefresh?: boolean;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  maxRetries?: number;
  /** Injectable clock (tests only). */
  now?: () => number;
}

const DEFAULT_REFRESH_MARGIN_MS = 30_000;

/**
 * Mint sparingly: reuse a cached, not-near-expiry token for the same
 * (clientId, tokenEndpoint, resource) rather than signing a fresh assertion
 * and re-minting on every call. This is the mandatory consumer-side
 * counterpart to the 2.2.0 rate limiter (pinned in flair#663's tracking
 * comment: "mint sparingly and reuse until expiry... per-request minting
 * would burn the bucket for no reason").
 */
export async function getMcpAccessToken(params: GetMcpAccessTokenParams): Promise<McpAccessToken> {
  const now = (params.now ?? Date.now)();
  const key = mcpTokenCacheKey(params.clientId, params.tokenEndpoint, params.resource);
  const cached = mcpTokenCache.get(key);
  const refreshMarginMs = params.refreshMarginMs ?? DEFAULT_REFRESH_MARGIN_MS;
  if (!params.forceRefresh && cached && cached.expiresAtMs - now > refreshMarginMs) {
    return cached;
  }

  const { assertion } = signClientAssertion({
    clientId: params.clientId,
    tokenEndpoint: params.tokenEndpoint,
    privateKey: params.privateKey,
    expiresInSeconds: params.expiresInSeconds,
  });
  const form = buildTokenRequestForm({ clientId: params.clientId, assertion, resource: params.resource });
  const token = await requestMcpAccessToken(form, params.tokenEndpoint, {
    fetchImpl: params.fetchImpl,
    sleep: params.sleep,
    random: params.random,
    maxRetries: params.maxRetries,
    now: params.now,
  });
  mcpTokenCache.set(key, token);
  return token;
}

// ─── Convenience defaults (this Flair instance's own /mcp + oauth surface) ──
//
// Mirrors resources/mcp-oauth-flag.ts's mcpIssuer()/mcpResource() env-driven
// defaults. Duplicated here (rather than imported) because src/ (this CLI's
// build root, tsconfig.cli.json) and resources/ (tsconfig.json) are separate
// TypeScript compilation roots with no existing cross-import in this repo —
// keep both in sync if either changes. These are only DEFAULTS: every value
// is overridable via CLI flags, since an agent may authenticate to a
// DIFFERENT Harper MCP server than the one running this CLI (identity is
// portable — the whole point of the design, see
// ~/ops/FLAIR-AGENT-AUTH-CONSUMER-SPEC.md "Wiring / usage").

/** `FLAIR_MCP_ISSUER`, falling back to `FLAIR_PUBLIC_URL`. */
export function defaultMcpIssuer(): string | undefined {
  const raw = (process.env.FLAIR_MCP_ISSUER ?? process.env.FLAIR_PUBLIC_URL ?? "").trim();
  return raw || undefined;
}

/** `${issuer}/mcp` — the RFC 8707 resource this instance's /mcp binds to. */
export function defaultMcpResource(): string | undefined {
  const iss = defaultMcpIssuer();
  return iss ? `${iss.replace(/\/+$/, "")}/mcp` : undefined;
}

/** `${issuer}/oauth/mcp/token` — matches HarperFast/oauth's wellKnown.ts discovery doc. */
export function defaultMcpTokenEndpoint(): string | undefined {
  const iss = defaultMcpIssuer();
  return iss ? `${iss.replace(/\/+$/, "")}/oauth/mcp/token` : undefined;
}

/** `${issuer}/MCPClientMetadata/{agentId}` — matches resources/MCPClientMetadata.ts. */
export function defaultMcpClientId(agentId: string): string | undefined {
  const iss = defaultMcpIssuer();
  return iss ? `${iss.replace(/\/+$/, "")}/MCPClientMetadata/${agentId}` : undefined;
}
