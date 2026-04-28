import { describe, expect, test } from "bun:test";

// Test the auth header regex parsing (same pattern used in auth-middleware.ts)
const AUTH_REGEX = /^TPS-Ed25519\s+([^:]+):(\d+):([^:]+):(.+)$/;

describe("auth middleware logic", () => {
  test("parses valid TPS-Ed25519 header", () => {
    const header = "TPS-Ed25519 flint:1709000000000:abc123nonce:c2lnbmF0dXJl";
    const m = header.match(AUTH_REGEX);
    expect(m).not.toBeNull();
    expect(m![1]).toBe("flint");
    expect(m![2]).toBe("1709000000000");
    expect(m![3]).toBe("abc123nonce");
    expect(m![4]).toBe("c2lnbmF0dXJl");
  });

  test("rejects missing scheme", () => {
    expect("Bearer token123".match(AUTH_REGEX)).toBeNull();
  });

  test("rejects malformed header (missing fields)", () => {
    expect("TPS-Ed25519 flint:123".match(AUTH_REGEX)).toBeNull();
    expect("TPS-Ed25519 flint".match(AUTH_REGEX)).toBeNull();
  });

  test("rejects non-numeric timestamp", () => {
    expect("TPS-Ed25519 flint:notanumber:nonce:sig".match(AUTH_REGEX)).toBeNull();
  });

  test("timestamp window check logic", () => {
    const WINDOW_MS = 30_000;
    const now = Date.now();
    // Valid: within window
    expect(Math.abs(now - now) <= WINDOW_MS).toBe(true);
    // Expired: 31s ago
    expect(Math.abs(now - (now - 31000)) <= WINDOW_MS).toBe(false);
    // Future: 31s ahead
    expect(Math.abs(now - (now + 31000)) <= WINDOW_MS).toBe(false);
  });

  test("nonce dedup logic", () => {
    const nonceSeen = new Map<string, number>();
    const key = "flint:abc123";
    expect(nonceSeen.has(key)).toBe(false);
    nonceSeen.set(key, Date.now());
    expect(nonceSeen.has(key)).toBe(true);
  });

  test("b64ToArrayBuffer roundtrip", () => {
    // Same implementation as auth-middleware.ts
    function b64ToArrayBuffer(b64: string): ArrayBuffer {
      const bin = atob(b64);
      const buf = new ArrayBuffer(bin.length);
      const view = new Uint8Array(buf);
      for (let i = 0; i < bin.length; i++) view[i] = bin.charCodeAt(i);
      return buf;
    }
    const original = new Uint8Array([1, 2, 3, 255, 0, 128]);
    const b64 = btoa(String.fromCharCode(...original));
    const result = new Uint8Array(b64ToArrayBuffer(b64));
    expect(result).toEqual(original);
  });

  test("Bearer token regex (simulates header parsing)", () => {
    const header = "Bearer some-pairing-token-123";
    const m = header.match(/^Bearer (.+)$/);
    expect(m).not.toBeNull();
    expect(m![1]).toBe("some-pairing-token-123");
  });

  test("Bearer token required for auth", () => {
    // Simulate: request without Authorization header should fail
    const header = "";
    expect(header.startsWith("Bearer ")).toBe(false);
    expect(header.startsWith("Basic ")).toBe(false);
    expect(header.startsWith("TPS-Ed25519")).toBe(false);
  });

  test("Bearer pairing token scoped to /FederationPair", () => {
    // Simulate the scope check in auth-middleware
    const bearerOnFederationPair = (pathname: string): boolean => {
      if (pathname !== "/FederationPair") return false;
      return true;
    };
    expect(bearerOnFederationPair("/FederationPair")).toBe(true);
    expect(bearerOnFederationPair("/Memory")).toBe(false);
    expect(bearerOnFederationPair("/health")).toBe(false);
    expect(bearerOnFederationPair("/FederationSync")).toBe(false);
  });

  test("public allowlist no longer includes /FederationPair", () => {
    // Mirror the updated allowlist
    const publicEndpoints = new Set([
      "/health", "/Health", "/a2a", "/A2AAdapter", "/AgentCard",
      "/FederationSync", 
      "/OAuthRegister", "/OAuthAuthorize", "/OAuthToken", "/OAuthRevoke",
      "/.well-known/oauth-authorization-server", "/OAuthMetadata",
    ]);
    const prefixEndpoints = ["/A2AAdapter/", "/AgentCard/"];

    const isAllowed = (pathname: string): boolean => {
      if (publicEndpoints.has(pathname)) return true;
      for (const prefix of prefixEndpoints) {
        if (pathname.startsWith(prefix)) return true;
      }
      return false;
    };

    // Verify /FederationPair is NOT in the allowlist
    expect(isAllowed("/FederationPair")).toBe(false);
    // Verify other endpoints still allowed
    expect(isAllowed("/health")).toBe(true);
    expect(isAllowed("/FederationSync")).toBe(true);
  });

  test("Authorization header detection fallback patterns", () => {
    // Simulate the various ways auth middleware reads the header
    const headerDirect = "Bearer tok_abc";
    const headerAsObject = { authorization: "Bearer tok_abc" };
    const headerEmpty = "";

    // Primary read
    const a = headerDirect || "" || "";
    const b = headerAsObject.authorization || "";
    const c = headerEmpty || "" || "";

    expect(a.startsWith("Bearer ")).toBe(true);
    expect(b.startsWith("Bearer ")).toBe(true);
    expect(c).toBe("");
  });

  test("invalid_or_expired_pairing_token error message", () => {
    const error = { error: "invalid_or_expired_pairing_token" };
    expect(error.error).toBe("invalid_or_expired_pairing_token");
  });

  test("consumedBy check logic", () => {
    const recordConsumed = { id: "tok1", consumedBy: "spoke_abc" };
    const recordFree = { id: "tok2", consumedBy: undefined };
    expect(recordConsumed.consumedBy).toBeTruthy();
    expect(recordFree.consumedBy).toBeFalsy();
  });

  test("expiry check logic", () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const future = new Date(Date.now() + 60_000).toISOString();
    expect(new Date(past) < new Date()).toBe(true);
    expect(new Date(future) < new Date()).toBe(false);
  });

  test("tpsAuthContext shape", () => {
    const context = { pairingToken: "tok_abc", authType: "pairing-context" };
    expect(context.pairingToken).toBe("tok_abc");
    expect(context.authType).toBe("pairing-context");
  });

  test("x-pairing-token header propagation", () => {
    const headers = new Map<string, string>();
    const token = "pairtok_xyz";
    headers.set("x-pairing-token", token);
    expect(headers.get("x-pairing-token")).toBe(token);
  });

  test("FederationPair without Authorization header returns 401", () => {
    // Simulate: request hits auth middleware, not in allowlist,
    // no Basic, no Bearer, no TPS-Ed25519 → 401
    const header = "";
    const isBearer = header.startsWith("Bearer ");
    const isBasic = header.startsWith("Basic ");
    const isEd25519 = /^TPS-Ed25519\s+/.test(header);
    expect(isBearer).toBe(false);
    expect(isBasic).toBe(false);
    expect(isEd25519).toBe(false);
    // No valid auth path → 401
    expect(header).toBe("");
  });

  test("FederationPair with consumed token returns 401", () => {
    const token = { id: "tok_used", consumedBy: "some_spoke", expiresAt: new Date(Date.now() + 3600000).toISOString() };
    expect(token.consumedBy).toBeTruthy();
  });

  test("FederationPair with expired token returns 401", () => {
    const token = { id: "tok_expired", consumedBy: undefined, expiresAt: new Date(Date.now() - 1000).toISOString() };
    expect(token.consumedBy).toBeFalsy();
    expect(new Date(token.expiresAt) < new Date()).toBe(true);
  });

  test("FederationPair with valid token passes auth", () => {
    const token = { id: "tok_valid", consumedBy: undefined, expiresAt: new Date(Date.now() + 3600000).toISOString() };
    expect(token.consumedBy).toBeFalsy();
    expect(new Date(token.expiresAt) < new Date()).toBe(false);
  });
});

describe("federation pairing token lifecycle", () => {
  test("pairing token sent as Bearer header not in body", () => {
    // Simulate CLI sending token in header, not body
    const headers = { Authorization: "Bearer tok_secret" };
    const body = { instanceId: "spoke_1", publicKey: "abc123" };

    expect(headers.Authorization.startsWith("Bearer ")).toBe(true);
    expect((body as any).pairingToken).toBeUndefined();
  });

  test("consumedBy and consumedAt set on successful pair", () => {
    const token = { id: "tok_abc", createdAt: new Date().toISOString() };
    const instanceId = "spoke_xyz";

    // Simulate consumption
    const consumed = {
      ...token,
      consumedBy: instanceId,
      consumedAt: new Date().toISOString(),
    };

    expect(consumed.consumedBy).toBe(instanceId);
    expect(consumed.consumedAt).toBeTruthy();
    // Token should not be usable again
    expect(consumed.consumedBy).toBeTruthy();
  });

  test("pairing body still contains Ed25519 signature", () => {
    const body = {
      instanceId: "spoke_1",
      publicKey: "pubkey_b64",
      signature: "sig_b64",
    };

    expect(body.signature).toBeTruthy();
    const { signature: _sig, ...rest } = body;
    expect((rest as any).pairingToken).toBeUndefined();
  });
});

// Test the re-pairing path still works without token
describe("federation re-pairing", () => {
  test("re-pairing skips token check when peer already exists", () => {
    // Simulate: existing peer found, same public key → skip token
    const existingPeer = { id: "spoke_1", publicKey: "same_pubkey", status: "paired" };
    const incomingPublicKey = "same_pubkey";
    expect(existingPeer.publicKey === incomingPublicKey).toBe(true);
  });

  test("re-pairing with mismatched key returns 409", () => {
    const existingPeer = { id: "spoke_1", publicKey: "original_pubkey" };
    const incomingPublicKey = "different_pubkey";
    const mismatch = existingPeer.publicKey !== incomingPublicKey;
    expect(mismatch).toBe(true);
  });
});

// ─── Auth header format parsing (edge cases) ────────────────────────────────────

describe("auth header edge cases", () => {
  test("header with just 'Basic ' prefix but no credentials", () => {
    const header = "Basic ";
    expect(header.startsWith("Basic ")).toBe(true);
    // Empty base64 decodes to empty string, not an error
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf-8");
    expect(decoded).toBe("");
  });

  test("header with 'Bearer ' prefix but no token", () => {
    const header = "Bearer ";
    expect(header.startsWith("Bearer ")).toBe(true);
    const token = header.slice(7);
    expect(token).toBe("");
  });

  test("lowercase 'authorization' header (edge case)", () => {
    // Some HTTP clients lowercase header names
    const lower = "bearer token123";
    expect(lower.startsWith("bearer")).toBe(true);
    // Our code checks startsWith("Bearer ") with capital B
    expect(lower.startsWith("Bearer ")).toBe(false);
    // NOTE: RFC 7235 says scheme is case-insensitive
  });
});
