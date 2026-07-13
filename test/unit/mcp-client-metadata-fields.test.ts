/**
 * Tests for resources/mcp-client-metadata-fields.ts — Client ID Metadata
 * Document (CIMD) construction for Flair agent identities.
 *
 * The document shape under test is pinned to HarperFast/oauth **issue
 * #161** ("client_credentials (2/4): CIMD-first client resolution for
 * private_key_jwt agents") — the formal spec for this exact shape.
 *
 * `mirrorValidateCimdDocument` below re-implements the STRUCTURAL parts of
 * HarperFast/oauth PR #167's `validateCimdDocument` (`src/lib/mcp/cimd.ts`)
 * closely enough to assert our document's shape against it. **#167 is an
 * OPEN DRAFT PR as of this writing — NOT merged** (a prior revision of this
 * comment said "merged," which was inaccurate; corrected 2026-07-09). #167
 * is not an installable dependency here regardless (a different repo's PR,
 * not published to the pinned `@harperfast/oauth@2.1.0` at the time of
 * writing), so this is a shape-mirroring check against its current draft
 * behavior, not a reimplementation we ship. It ALSO deliberately proves the
 * "pending #161/#162" gaps documented in mcp-client-metadata-fields.ts's
 * header: our document's `grant_types`/`token_endpoint_auth_method`/missing
 * `redirect_uris` are exactly the fields #167's draft validator rejects
 * today, pending #161 landing.
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
// (open draft, not merged). Structural checks only — not the SSRF/fetch/
// cache machinery, which has nothing to do with document SHAPE.
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

  test("response_types is omitted too (oauth#161: client_credentials-only clients carry neither)", () => {
    const doc = buildCimdDocument({ clientId: CLIENT_ID, clientName: "flint", jwk: JWK });
    expect("response_types" in doc).toBe(false);
    // Belt-and-suspenders against a future accidental regression: neither
    // field should appear anywhere in the serialized JSON either.
    const serialized = JSON.stringify(doc);
    expect(serialized).not.toContain("redirect_uris");
    expect(serialized).not.toContain("response_types");
  });

  test("jwks is a non-empty set of exactly one PUBLIC OKP/Ed25519 key (oauth#161: reject empty sets / non-OKP)", () => {
    const doc = buildCimdDocument({ clientId: CLIENT_ID, clientName: "flint", jwk: JWK });
    expect(doc.jwks.keys.length).toBe(1);
    expect(doc.jwks.keys[0].kty).toBe("OKP");
    expect(doc.jwks.keys[0].crv).toBe("Ed25519");
  });

  test("rejects a missing clientId, clientName, or malformed jwk", () => {
    expect(() => buildCimdDocument({ clientId: "", clientName: "flint", jwk: JWK })).toThrow();
    expect(() => buildCimdDocument({ clientId: CLIENT_ID, clientName: "", jwk: JWK })).toThrow();
    expect(() =>
      buildCimdDocument({ clientId: CLIENT_ID, clientName: "flint", jwk: { kty: "RSA" } as any }),
    ).toThrow();
  });

  test("rejects a null/undefined jwk (this single-key API has no other way to produce an empty jwks set — oauth#161's 'reject empty sets')", () => {
    expect(() =>
      buildCimdDocument({ clientId: CLIENT_ID, clientName: "flint", jwk: undefined as any }),
    ).toThrow();
    expect(() =>
      buildCimdDocument({ clientId: CLIENT_ID, clientName: "flint", jwk: null as any }),
    ).toThrow();
  });

  test("SECURITY (oauth#161): rejects a jwk carrying a private 'd' component, even via an untyped/external object", () => {
    // A private OKP/Ed25519 JWK still carries a valid kty/crv/x (the public
    // half is derivable from it), so this specifically proves the dedicated
    // 'd' guard — not just a side effect of the existing shape checks.
    const privateJwk = { ...JWK, d: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" };
    expect(() =>
      buildCimdDocument({ clientId: CLIENT_ID, clientName: "flint", jwk: privateJwk as any }),
    ).toThrow(/private/i);
  });

  describe("pending #161/#162 — against TODAY's open-draft #167 CIMD validator", () => {
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
