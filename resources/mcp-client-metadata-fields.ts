/**
 * Client ID Metadata Document (CIMD) field logic for Flair agent identities.
 *
 * Produces the JSON metadata document an OAuth authorization server fetches
 * when a client_id is an HTTPS URL — draft-ietf-oauth-client-id-metadata-
 * document-00, adopted by the MCP draft authorization spec IN PLACE OF DCR
 * (see ~/ops/FLAIR-CLOUD-AGENT-BETA-ALIGNMENT.md Delta 2). HarperFast/oauth
 * PR #167 (merged @ commit f0da8a1) implements the AS side that fetches +
 * validates this document.
 *
 * Kept free of any @harperfast/harper import (mirrors agentcard-fields.ts)
 * so the document shape is unit-testable without spinning up Harper.
 *
 * ── pending oauth#162 ───────────────────────────────────────────────────────
 * This module produces the TARGET shape — the document our agents actually
 * need — not what the CURRENTLY MERGED #167 validator accepts today. As of
 * #167 (commit f0da8a1, `src/lib/mcp/{cimd,clientValidator}.ts`):
 *
 *   1. `clientValidator.ts`'s `SUPPORTED_GRANT_TYPES` is
 *      `{authorization_code, refresh_token}` — `"client_credentials"` is
 *      rejected (`Unsupported grant_type`) until a follow-up (presumably
 *      bundled with #162) extends it.
 *   2. `cimd.ts`'s `validateCimdDocument` hardcodes CIMD clients to
 *      `token_endpoint_auth_method === 'none'` — `"private_key_jwt"` is
 *      rejected until #159/#162 activates it (the plugin's own comment says
 *      as much: "private_key_jwt will be activated by issue #159").
 *   3. `redirect_uris` is REQUIRED and non-empty today (inherited from the
 *      DCR-shaped validator) — meaningless for a pure client_credentials
 *      agent that never does a redirect-based flow. We deliberately OMIT it
 *      rather than invent a placeholder redirect URI that could get
 *      silently accepted onto an unintended surface if a future validator
 *      loosens the auth-method/grant-type checks without also dropping this
 *      requirement for credential-only clients.
 *
 * All three gaps mean fetching this document against TODAY's deployed AS
 * fails closed (missing/invalid field → 400) rather than silently degrading
 * to a weaker auth method — that fail-closed behavior is what we want in
 * the interim. See docs/notes/mcp-agent-auth-consumer.md for the open
 * questions to resolve when #162 lands (and whether the redirect_uris
 * requirement is dropped for client_credentials-only CIMD clients, or we
 * need a different answer).
 */

export interface Ed25519Jwk {
  kty: "OKP";
  crv: "Ed25519";
  x: string;
  kid?: string;
}

export interface CimdDocument {
  client_id: string;
  client_name: string;
  jwks: { keys: Ed25519Jwk[] };
  token_endpoint_auth_method: string;
  grant_types: string[];
}

/** The grant this agent's CIMD document targets. Rejected by #167 today — see module header. */
export const CIMD_TARGET_GRANT_TYPES = ["client_credentials"] as const;
/** The auth method this agent's CIMD document targets. Rejected by #167 today — see module header. */
export const CIMD_TARGET_AUTH_METHOD = "private_key_jwt" as const;

export interface BuildCimdDocumentParams {
  /** The exact HTTPS URL this document will be served at (must equal the fetch URL, byte-for-byte). */
  clientId: string;
  /** Human-readable name; required by the document schema. */
  clientName: string;
  /** The agent's Ed25519 public key as a JWK OKP. */
  jwk: Ed25519Jwk;
}

/** Build a Client ID Metadata Document for a headless Flair agent. */
export function buildCimdDocument(params: BuildCimdDocumentParams): CimdDocument {
  const { clientId, clientName, jwk } = params;
  if (!clientId) throw new Error("clientId is required");
  if (!clientName) throw new Error("clientName is required");
  if (!jwk || jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.x !== "string" || !jwk.x) {
    throw new Error("jwk must be a public Ed25519 JWK ({kty:'OKP', crv:'Ed25519', x:'...'})");
  }
  return {
    client_id: clientId,
    client_name: clientName,
    jwks: { keys: [jwk] },
    // pending oauth#162 — rejected by today's deployed CIMD validator; see module header.
    token_endpoint_auth_method: CIMD_TARGET_AUTH_METHOD,
    grant_types: [...CIMD_TARGET_GRANT_TYPES],
    // redirect_uris deliberately omitted — pending oauth#162, see module header.
  };
}

/**
 * Normalize a Flair `Agent.publicKey` value into a JWK OKP `x`. Accepts both
 * encodings `Agent.publicKey` is written in across this repo (hex 64-char,
 * or base64/base64url 44-char raw 32-byte key) — the same two forms
 * resources/ed25519-auth.ts's `importEd25519Key` accepts, so a document
 * built from this always matches what the verified-request path already
 * treats as the agent's key.
 */
export function agentPublicKeyToJwk(publicKeyStr: string, kid?: string): Ed25519Jwk {
  const trimmed = (publicKeyStr ?? "").trim();
  let raw: Buffer;
  if (/^[0-9a-f]{64}$/i.test(trimmed)) {
    raw = Buffer.from(trimmed, "hex");
  } else {
    raw = Buffer.from(trimmed.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  }
  if (raw.length !== 32) {
    throw new Error(`agent public key must decode to 32 bytes (got ${raw.length})`);
  }
  const jwk: Ed25519Jwk = { kty: "OKP", crv: "Ed25519", x: raw.toString("base64url") };
  if (kid) jwk.kid = kid;
  return jwk;
}
