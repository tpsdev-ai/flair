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
 * ── pending oauth#161/#162 ───────────────────────────────────────────────────
 * The token-endpoint grant that CONSUMES this assertion
 * (`grant_type=client_credentials`) is tracked as HarperFast/oauth issue
 * #162 ("client_credentials (3/4): token-endpoint grant — resource binding,
 * per-grant TTL, discovery") — an ISSUE, not yet a PR, and it depends on
 * #161 (client resolution/validation) and #167 (CIMD resolution layer,
 * still an open draft). #162's scope, confirmed against this module:
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
 *   - Issued token `sub` = `client_id`; access-token TTL default 300s; no
 *     `refresh_token` — nothing to change here, this module never touches
 *     the token response (see the stub below).
 * The exact request/response contract (error shapes, discovery
 * advertisement) is still not final since #162 isn't merged. This module
 * fully builds + signs the assertion (that contract IS final, per #165) and
 * fully shapes the token-request form (per #162's scope above) but stops
 * short of POSTing it anywhere: `requestMcpAccessToken` always throws,
 * clearly marked `pending #162`. See docs/notes/mcp-agent-auth-consumer.md.
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

/**
 * pending #162 — HarperFast/oauth's client_credentials token-endpoint grant
 * (github.com/HarperFast/oauth issue #162) is not yet a PR; its exact
 * contract (error shapes, whether `resource` is required vs defaulted,
 * discovery advertisement) is not final. Wiring a live POST here now would
 * mean guessing that contract and re-doing it once #162 lands, so this
 * function intentionally always throws. `signClientAssertion` +
 * `buildTokenRequestForm` are the stable, already-testable surface; this
 * is the one function to fill in once #162 merges.
 */
export async function requestMcpAccessToken(
  _form: TokenRequestForm,
  _tokenEndpoint: string,
): Promise<never> {
  throw new Error(
    "pending #162: HarperFast/oauth's client_credentials token-endpoint grant is not yet merged " +
      "(github.com/HarperFast/oauth issue #162) — the live token round-trip is intentionally not " +
      "wired. Use signClientAssertion()/buildTokenRequestForm() to inspect what will be sent once it is.",
  );
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
