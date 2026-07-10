/**
 * Client ID Metadata Document (CIMD) field logic for Flair agent identities.
 *
 * Produces the JSON metadata document an OAuth authorization server fetches
 * when a client_id is an HTTPS URL — draft-ietf-oauth-client-id-metadata-
 * document-00, adopted by the MCP draft authorization spec IN PLACE OF DCR
 * (see ~/ops/FLAIR-CLOUD-AGENT-BETA-ALIGNMENT.md Delta 2).
 *
 * Shape is pinned to HarperFast/oauth **issue #161** ("client_credentials
 * (2/4): CIMD-first client resolution for private_key_jwt agents") — the
 * FORMAL shape spec for this document, re-scoped 2026-07-09 to CIMD-first
 * (DCR demoted to optional back-compat). #161 requires:
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
 * HarperFast/oauth PR #167 ("CIMD resolution layer") implements the AS-side
 * fetch/validate/cache machinery #161 builds on. **#167 is an OPEN DRAFT PR
 * as of this writing — NOT merged** (a prior version of this comment
 * claimed "merged @ commit f0da8a1"; that was inaccurate and is corrected
 * here 2026-07-09). Its current `validateCimdDocument` / `clientValidator.ts`
 * do not yet accept this document's `client_credentials` shape — see the
 * "pending #161/#162" section below.
 *
 * Kept free of any @harperfast/harper import (mirrors agentcard-fields.ts)
 * so the document shape is unit-testable without spinning up Harper.
 *
 * ── pending oauth#161/#162 ──────────────────────────────────────────────────
 * This module produces the shape FORMALIZED by #161 — not what today's
 * still-open-draft #167 validator currently accepts. As coded in #167's
 * draft (`src/lib/mcp/{cimd,clientValidator}.ts`):
 *
 *   1. `clientValidator.ts`'s `SUPPORTED_GRANT_TYPES` is
 *      `{authorization_code, refresh_token}` — `"client_credentials"` is
 *      rejected (`Unsupported grant_type`) until #161 lands.
 *   2. `cimd.ts`'s `validateCimdDocument` hardcodes CIMD clients to
 *      `token_endpoint_auth_method === 'none'` — `"private_key_jwt"` is
 *      rejected until #161/#159 activates it (the plugin's own comment says
 *      as much: "private_key_jwt will be activated by issue #159").
 *   3. `redirect_uris` is REQUIRED and non-empty today (inherited from the
 *      DCR-shaped validator) — meaningless for a pure client_credentials
 *      agent that never does a redirect-based flow. #161 now explicitly
 *      blesses omitting it (and `response_types`) for client_credentials-only
 *      CIMD clients, so this is a documented, upstream-endorsed deviation —
 *      not a guess we're hoping gets accepted.
 *
 * All three gaps mean fetching this document against TODAY's deployed AS
 * (running #167's current draft code) fails closed (missing/invalid field →
 * 400) rather than silently degrading to a weaker auth method — that
 * fail-closed behavior is what we want in the interim. See
 * docs/notes/mcp-agent-auth-consumer.md for the resolved open-questions list
 * and the deployment-coordination note (`allowedHosts` must include this
 * document's host once #161/#167 land).
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

/** The grant this agent's CIMD document targets — formalized by oauth#161; rejected by today's open-draft #167 validator until #161 lands. See module header. */
export const CIMD_TARGET_GRANT_TYPES = ["client_credentials"] as const;
/** The auth method this agent's CIMD document targets — formalized by oauth#161; rejected by today's open-draft #167 validator until #161 lands. See module header. */
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
