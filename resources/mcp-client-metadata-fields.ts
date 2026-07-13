/**
 * Client ID Metadata Document (CIMD) field logic for Flair agent identities.
 *
 * Produces the JSON metadata document an OAuth authorization server fetches
 * when a client_id is an HTTPS URL — draft-ietf-oauth-client-id-metadata-
 * document-00, adopted by the MCP draft authorization spec IN PLACE OF DCR
 * (no registration row to create or replicate across nodes; the served
 * document IS the registration).
 *
 * Shape is pinned to HarperFast/oauth **issue #161** ("client_credentials
 * (2/4): CIMD-first client resolution for private_key_jwt agents") — the
 * FORMAL shape spec for this document, shipped in @harperfast/oauth@2.2.0
 * via PR #170 (with #167's CIMD resolution layer). #161 requires:
 *
 *   - `grant_types: ["client_credentials"]`;
 *     `token_endpoint_auth_method: "private_key_jwt"`.
 *   - `jwks` = JWK Set of PUBLIC OKP/Ed25519 keys ONLY — reject any key
 *     carrying a private `d`, reject empty sets, reject non-OKP/non-Ed25519
 *     keys.
 *   - client_credentials-only clients carry NEITHER `redirect_uris` NOR
 *     `response_types` — #161 explicitly blesses this as a documented
 *     deviation from the CIMD draft's general required-fields list (which
 *     includes `redirect_uris` for interactive/DCR-style clients).
 *   - `client_credentials` combined with `refresh_token` is rejected.
 *   - Security gate (AS-side, enforced by the plugin, documented here for
 *     deployment coordination): `clientIdMetadataDocuments.allowedHosts`
 *     MUST be configured and this document's `client_id` host MUST be on
 *     it — merely hosting a reachable document must never be sufficient to
 *     mint tokens. Replaces the old DCR `initialAccessToken` gate.
 *
 * The AS-side machinery consuming this document (fetch/validate/cache —
 * #167's CIMD resolution layer, extended by #170 for client_credentials +
 * private_key_jwt) is SHIPPED in the published @harperfast/oauth@2.2.0.
 * This module's output is proven against that real published code — not a
 * mirror — in test/unit/mcp-client-credentials-live-package.test.ts, which
 * drives 2.2.0's actual `resolveCimdClient` pipeline (via its exported
 * `_setDnsLookup`/`_setFetch` test hooks) and confirms the document
 * resolves and validates end-to-end, plus the fail-closed negatives (no
 * `allowedHosts` configured → rejected; leaked private `d` in a JWK →
 * rejected by the plugin even if our own build-time guard were bypassed).
 *
 * Kept free of any @harperfast/harper import (mirrors agentcard-fields.ts)
 * so the document shape is unit-testable without spinning up Harper.
 */

export interface Ed25519Jwk {
  kty: "OKP";
  crv: "Ed25519";
  x: string;
  kid?: string;
}

/**
 * Deliberately has NO `redirect_uris` and NO `response_types` field —
 * oauth#161 requires client_credentials-only CIMD clients to carry neither
 * (see module header). Not modeled as optional-and-omitted; they simply
 * don't exist on this type, so there's no field to accidentally populate.
 */
export interface CimdDocument {
  client_id: string;
  client_name: string;
  jwks: { keys: Ed25519Jwk[] };
  token_endpoint_auth_method: string;
  grant_types: string[];
}

/** The grant this agent's CIMD document targets — formalized by oauth#161, accepted by the published 2.2.0 validator. See module header. */
export const CIMD_TARGET_GRANT_TYPES = ["client_credentials"] as const;
/** The auth method this agent's CIMD document targets — formalized by oauth#161, accepted by the published 2.2.0 validator. See module header. */
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
  // Belt-and-suspenders (oauth#161: "reject any key carrying private `d`").
  // Ed25519Jwk's TS type has no `d` field, so a well-typed caller can't
  // construct one — but this function's argument still crosses a runtime
  // boundary (a JWK read from disk/network, or a caller using `as any`), so
  // check for it explicitly rather than trust the type alone. A CIMD
  // document is fetched by an unauthenticated AS over the public internet;
  // there is no scenario where leaking `d` here is acceptable.
  if (typeof (jwk as { d?: unknown }).d !== "undefined") {
    throw new Error(
      "jwk must be a PUBLIC key — refusing to build a CIMD document from a JWK carrying a private 'd' component",
    );
  }
  return {
    client_id: clientId,
    client_name: clientName,
    // Exactly one key, always non-empty and always OKP/Ed25519 — both are
    // structurally guaranteed by the validation above (oauth#161 also
    // requires rejecting an EMPTY jwks set and non-OKP/non-Ed25519 keys;
    // this function's single-already-validated-jwk API makes both
    // impossible to violate from here).
    jwks: { keys: [jwk] },
    // pending oauth#161 — rejected by today's open-draft #167 validator; see module header.
    token_endpoint_auth_method: CIMD_TARGET_AUTH_METHOD,
    grant_types: [...CIMD_TARGET_GRANT_TYPES],
    // redirect_uris AND response_types are both deliberately omitted — #161
    // blesses this explicitly for client_credentials-only CIMD clients (no
    // redirect-based flow is ever possible for a headless agent). Neither
    // field is declared on CimdDocument, so neither can slip back in via
    // this object literal.
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
