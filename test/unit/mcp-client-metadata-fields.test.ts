/**
 * Tests for resources/mcp-client-metadata-fields.ts — Client ID Metadata
 * Document (CIMD) construction for Flair agent identities.
 *
 * `mirrorValidateCimdDocument` below re-implements the STRUCTURAL parts of
 * HarperFast/oauth PR #167's `validateCimdDocument` (commit f0da8a1,
 * `src/lib/mcp/cimd.ts`) closely enough to assert our document's shape
 * against it. #167 is not an installable dependency here (a different
 * repo's merged PR, not published to the pinned `@harperfast/oauth@2.1.0`
 * at the time of writing), so this is a shape-mirroring check, not a
 * reimplementation we ship. It ALSO deliberately proves the "pending
 * #162" gaps documented in mcp-client-metadata-fields.ts's header: our
 * document's `grant_types`/`token_endpoint_auth_method`/missing
 * `redirect_uris` are exactly the fields #167's validator rejects today.
 */
import { describe, test, expect } from "bun:test";
import {
  buildCimdDocument,
  agentPublicKeyToJwk,
  CIMD_TARGET_GRANT_TYPES,
  CIMD_TARGET_AUTH_METHOD,
  type Ed25519Jwk,
} from "../../resources/mcp-client-metadata-fields";

const CLIENT_ID = "https://flair.example.com/MCPClientMetadata/flint";
const JWK: Ed25519Jwk = { kty: "OKP", crv: "Ed25519", x: "Vu7JEgIlaJs4aee6F-0tOVAVLsg8dBe1L7T4DaqWVIU" };

// ─── Mirror of HarperFast/oauth PR #167's clientValidator.ts + cimd.ts ─────
// (commit f0da8a1). Structural checks only — not the SSRF/fetch/cache
// machinery, which has nothing to do with document SHAPE.
const SUPPORTED_GRANT_TYPES_TODAY = new Set(["authorization_code", "refresh_token"]);

function mirrorValidateCimdDocument(
  doc: Record<string, unknown>,
  fetchedFromUrl: string,
): { ok: true } | { ok: false; reason: string } {
  if (typeof doc.client_id !== "string" || doc.client_id !== fetchedFromUrl) {
    return { ok: false, reason: "client_id does not match the fetched URL" };
  }
  if (typeof doc.client_name !== "string" || !doc.client_name) {
    return { ok: false, reason: "missing required field: client_name" };
  }
  if (!Array.isArray(doc.redirect_uris) || doc.redirect_uris.length === 0) {
    return { ok: false, reason: "missing required field: redirect_uris" };
  }
  const grantTypes = Array.isArray(doc.grant_types) ? (doc.grant_types as string[]) : ["authorization_code", "refresh_token"];
  for (const g of grantTypes) {
    if (!SUPPORTED_GRANT_TYPES_TODAY.has(g)) return { ok: false, reason: `Unsupported grant_type: ${g}` };
  }
  const authMethod = typeof doc.token_endpoint_auth_method === "string" ? doc.token_endpoint_auth_method : "none";
  if (authMethod !== "none") {
    return { ok: false, reason: `token_endpoint_auth_method '${authMethod}' is not yet supported for CIMD clients` };
  }
  return { ok: true };
}

describe("buildCimdDocument", () => {
  test("client_id is exactly the URL provided (byte-for-byte, per CIMD identity match)", () => {
    const doc = buildCimdDocument({ clientId: CLIENT_ID, clientName: "flint", jwk: JWK });
    expect(doc.client_id).toBe(CLIENT_ID);
  });

  test("jwks carries the agent's public key as a JWK Set", () => {
    const doc = buildCimdDocument({ clientId: CLIENT_ID, clientName: "flint", jwk: JWK });
    expect(doc.jwks).toEqual({ keys: [JWK] });
  });

  test("no private key material is ever present in the document", () => {
    const doc = buildCimdDocument({ clientId: CLIENT_ID, clientName: "flint", jwk: JWK });
    const serialized = JSON.stringify(doc);
    expect(serialized).not.toContain('"d"');
    expect(doc.jwks.keys[0]).not.toHaveProperty("d");
  });

  test("targets client_credentials + private_key_jwt (the contract our agents need)", () => {
    const doc = buildCimdDocument({ clientId: CLIENT_ID, clientName: "flint", jwk: JWK });
    expect(doc.grant_types).toEqual([...CIMD_TARGET_GRANT_TYPES]);
    expect(doc.token_endpoint_auth_method).toBe(CIMD_TARGET_AUTH_METHOD);
  });

  test("redirect_uris is omitted (meaningless for a pure client_credentials agent)", () => {
    const doc = buildCimdDocument({ clientId: CLIENT_ID, clientName: "flint", jwk: JWK });
    expect("redirect_uris" in doc).toBe(false);
  });

  test("rejects a missing clientId, clientName, or malformed jwk", () => {
    expect(() => buildCimdDocument({ clientId: "", clientName: "flint", jwk: JWK })).toThrow();
    expect(() => buildCimdDocument({ clientId: CLIENT_ID, clientName: "", jwk: JWK })).toThrow();
    expect(() =>
      buildCimdDocument({ clientId: CLIENT_ID, clientName: "flint", jwk: { kty: "RSA" } as any }),
    ).toThrow();
  });

  describe("pending #162 — against TODAY's deployed #167 CIMD validator", () => {
    test("our document is rejected today (grant_types, auth method, redirect_uris all gaps)", () => {
      const doc = buildCimdDocument({ clientId: CLIENT_ID, clientName: "flint", jwk: JWK });
      const result = mirrorValidateCimdDocument(doc as unknown as Record<string, unknown>, CLIENT_ID);
      expect(result.ok).toBe(false);
      // Structural check order matches #167's cimd.ts (redirect_uris checked
      // before grant_types/auth_method) — asserting the FIRST gap it would hit.
      if (!result.ok) expect(result.reason).toMatch(/redirect_uris/);
    });

    test("client_id + client_name alone (today's minimum-shape fields) DO pass structurally", () => {
      // Isolate just the two fields #167 already accepts unconditionally, to
      // prove the gaps above are specifically grant_types/auth_method/
      // redirect_uris — not a client_id/client_name regression.
      const minimal = {
        client_id: CLIENT_ID,
        client_name: "flint",
        redirect_uris: ["https://example.com/never-used"],
      };
      const result = mirrorValidateCimdDocument(minimal, CLIENT_ID);
      expect(result.ok).toBe(true);
    });
  });
});

describe("agentPublicKeyToJwk", () => {
  test("accepts base64url raw 32-byte key (the Agent.publicKey convention from `flair agent add`)", () => {
    const jwk = agentPublicKeyToJwk("Vu7JEgIlaJs4aee6F-0tOVAVLsg8dBe1L7T4DaqWVIU");
    expect(jwk).toEqual({ kty: "OKP", crv: "Ed25519", x: "Vu7JEgIlaJs4aee6F-0tOVAVLsg8dBe1L7T4DaqWVIU" });
  });

  test("accepts standard (non-url) base64", () => {
    const raw = Buffer.from("Vu7JEgIlaJs4aee6F-0tOVAVLsg8dBe1L7T4DaqWVIU".replace(/-/g, "+").replace(/_/g, "/"), "base64");
    const jwk = agentPublicKeyToJwk(raw.toString("base64"));
    expect(jwk.x).toBe("Vu7JEgIlaJs4aee6F-0tOVAVLsg8dBe1L7T4DaqWVIU");
  });

  test("accepts hex-encoded 64-char key", () => {
    const raw = Buffer.from("Vu7JEgIlaJs4aee6F-0tOVAVLsg8dBe1L7T4DaqWVIU".replace(/-/g, "+").replace(/_/g, "/"), "base64");
    const hex = raw.toString("hex");
    const jwk = agentPublicKeyToJwk(hex);
    expect(jwk.x).toBe("Vu7JEgIlaJs4aee6F-0tOVAVLsg8dBe1L7T4DaqWVIU");
  });

  test("attaches kid when provided", () => {
    const jwk = agentPublicKeyToJwk("Vu7JEgIlaJs4aee6F-0tOVAVLsg8dBe1L7T4DaqWVIU", "flint");
    expect(jwk.kid).toBe("flint");
  });

  test("rejects a key that doesn't decode to 32 bytes", () => {
    expect(() => agentPublicKeyToJwk("dG9vLXNob3J0")).toThrow();
  });
});
