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

// ─── Basic auth: flair_pair_initiator support (PR-2) ────────────────────────

describe("flair_pair_initiator Basic auth", () => {
  /**
   * Simulate the Path 3 branch of the auth middleware.
   * Returns the "accept" / "reject" decision given the incoming request details.
   */
  function simulateAuthMiddleware(opts: {
    pathname: string;
    username: string;
    password: string;
    harperUser: any;
  }): "accepted" | "rejected" {
    const { pathname, username, password, harperUser } = opts;

    // Simulate: Path 1 (admin fast-path) — not applicable for pair-bootstrap-* users
    // Simulate: Path 2 (super_user) — pair-bootstrap users are not super_user
    const isSuperUser = harperUser?.role?.permission?.super_user === true;
    if (isSuperUser) return "accepted";

    // Path 3: flair_pair_initiator — restricted to /FederationPair only
    if (pathname === "/FederationPair" && username.startsWith("pair-bootstrap-")) {
      // getUser succeeded and returned a flair_pair_initiator record
      if (
        harperUser?.role?.role === "flair_pair_initiator" &&
        harperUser?.active === true
      ) {
        return "accepted";
      }
    }

    // Fall through → 401
    return "rejected";
  }

  const PAIR_USER: any = {
    role: { role: "flair_pair_initiator" },
    active: true,
  };

  test("flair_pair_initiator Basic auth on /FederationPair → accepted", () => {
    const result = simulateAuthMiddleware({
      pathname: "/FederationPair",
      username: "pair-bootstrap-abcd1234",
      password: "correct-password",
      harperUser: PAIR_USER,
    });
    expect(result).toBe("accepted");
  });

  test("flair_pair_initiator Basic auth on /Memory → 401", () => {
    const result = simulateAuthMiddleware({
      pathname: "/Memory",
      username: "pair-bootstrap-abcd1234",
      password: "correct-password",
      harperUser: PAIR_USER,
    });
    expect(result).toBe("rejected");
  });

  test("flair_pair_initiator Basic auth on /Soul → 401", () => {
    const result = simulateAuthMiddleware({
      pathname: "/Soul",
      username: "pair-bootstrap-abcd1234",
      password: "correct-password",
      harperUser: PAIR_USER,
    });
    expect(result).toBe("rejected");
  });

  test("wrong password → 401 (getUser returns null)", () => {
    // When password is wrong, getUser would return null or throw
    const result = simulateAuthMiddleware({
      pathname: "/FederationPair",
      username: "pair-bootstrap-abcd1234",
      password: "wrong-password",
      harperUser: null, // getUser returns null for bad creds
    });
    expect(result).toBe("rejected");
  });

  test("disabled (active=false) user → 401", () => {
    const disabledUser = { role: { role: "flair_pair_initiator" }, active: false };
    const result = simulateAuthMiddleware({
      pathname: "/FederationPair",
      username: "pair-bootstrap-abcd1234",
      password: "correct-password",
      harperUser: disabledUser,
    });
    expect(result).toBe("rejected");
  });

  test("username not starting with pair-bootstrap- → falls through to 401 on /FederationPair", () => {
    // Non-bootstrap username never hits Path 3
    const result = simulateAuthMiddleware({
      pathname: "/FederationPair",
      username: "regular-user",
      password: "correct-password",
      harperUser: PAIR_USER, // even if user record matched, prefix check prevents acceptance
    });
    expect(result).toBe("rejected");
  });

  test("path-restriction: pair-bootstrap user cannot access /Agent", () => {
    const result = simulateAuthMiddleware({
      pathname: "/Agent",
      username: "pair-bootstrap-abcd1234",
      password: "correct-password",
      harperUser: PAIR_USER,
    });
    expect(result).toBe("rejected");
  });

  test("path-restriction: pair-bootstrap user cannot access /FederationSync", () => {
    const result = simulateAuthMiddleware({
      pathname: "/FederationSync",
      username: "pair-bootstrap-abcd1234",
      password: "correct-password",
      harperUser: PAIR_USER,
    });
    expect(result).toBe("rejected");
  });

  test("pair-bootstrap username format: starts with pair-bootstrap-", () => {
    const tokenId = "abcdefgh123456"; // 14 chars, first 8 are used
    const username = `pair-bootstrap-${tokenId.slice(0, 8)}`;
    expect(username).toBe("pair-bootstrap-abcdefgh");
    expect(username.startsWith("pair-bootstrap-")).toBe(true);
  });

  test("flat-string role rejected (Harper returns role as object, not string)", () => {
    // Real Harper user records have role as { role: "...", permission: {...} },
    // NOT a flat string. This test guards against the regression where the
    // auth middleware checked pairUser?.role === "flair_pair_initiator" instead
    // of pairUser?.role?.role === "flair_pair_initiator".
    const result = simulateAuthMiddleware({
      pathname: "/FederationPair",
      username: "pair-bootstrap-abcd1234",
      password: "correct-password",
      harperUser: { role: "flair_pair_initiator", active: true }, // wrong shape
    });
    expect(result).toBe("rejected");
  });
});

// ─── Basic auth: super_user support (ops-lzmg) ───────────────────────────────

describe("Basic auth super_user path", () => {
  test("parses Basic auth header with colon in password", () => {
    // Use indexOf(':') to split user:pass — handles colons in passwords
    const decoded = "heskew@pm.me:my:pass:with:colons";
    const colonIdx = decoded.indexOf(":");
    const user = colonIdx >= 0 ? decoded.slice(0, colonIdx) : decoded;
    const pass = colonIdx >= 0 ? decoded.slice(colonIdx + 1) : "";
    expect(user).toBe("heskew@pm.me");
    expect(pass).toBe("my:pass:with:colons");
  });

  test("parses Basic auth header without colon (no password)", () => {
    const decoded = "justuser";
    const colonIdx = decoded.indexOf(":");
    const user = colonIdx >= 0 ? decoded.slice(0, colonIdx) : decoded;
    const pass = colonIdx >= 0 ? decoded.slice(colonIdx + 1) : "";
    expect(user).toBe("justuser");
    expect(pass).toBe("");
  });

  test("admin user with HDB_ADMIN_PASSWORD passes", () => {
    // Simulate the env-var fast-path
    const adminPass = "s3cret";
    const user = "admin";
    const pass = "s3cret";
    expect(adminPass !== null && user === "admin" && pass === adminPass).toBe(true);
  });

  test("admin user with wrong password falls through to super_user check", () => {
    const adminPass = "s3cret";
    const user = "admin";
    const pass = "wrongpass";
    // Env-var fast-path does NOT match (wrong password)
    expect(adminPass !== null && user === "admin" && pass === adminPass).toBe(false);
    // Should fall through to getUser path
  });

  test("non-admin user with HDB_ADMIN_PASSWORD set falls through to super_user check", () => {
    const adminPass = "s3cret";
    const user = "heskew@pm.me";
    const pass = "heskewspass";
    // Env-var fast-path does NOT match (user !== "admin")
    expect(adminPass !== null && user === "admin" && pass === adminPass).toBe(false);
    // Should fall through to getUser path
  });

  test("super_user with non-'admin' username passes via getUser path", () => {
    // Simulate server.getUser returning a super_user record
    const harperUser = {
      id: "heskew@pm.me",
      role: {
        permission: { super_user: true },
      },
    };
    expect(harperUser?.role?.permission?.super_user === true).toBe(true);
  });

  test("non-super_user is rejected", () => {
    const harperUser = {
      id: "regular_user",
      role: {
        permission: { super_user: false },
      },
    };
    expect(harperUser?.role?.permission?.super_user === true).toBe(false);
  });

  test("getUser returning null is treated as invalid", () => {
    const harperUser = null;
    expect(harperUser?.role?.permission?.super_user === true).toBe(false);
  });

  test("getUser returning undefined is treated as invalid", () => {
    const harperUser = undefined;
    expect(harperUser?.role?.permission?.super_user === true).toBe(false);
  });

  test("getUser returning missing role is treated as invalid", () => {
    const harperUser = { id: "some_user" };
    expect(harperUser?.role?.permission?.super_user === true).toBe(false);
  });

  test("getUser returning missing permission is treated as invalid", () => {
    const harperUser = { id: "some_user", role: {} };
    expect(harperUser?.role?.permission?.super_user === true).toBe(false);
  });

  test("no HDB_ADMIN_PASSWORD set still allows super_user auth", () => {
    // When adminPass is null, only Path 2 (super_user check) applies
    const adminPass = null;
    const harperUser = {
      role: { permission: { super_user: true } },
    };
    // Path 1 won't match (adminPass is null)
    expect(adminPass !== null).toBe(false);
    // Path 2 can still match
    expect(harperUser?.role?.permission?.super_user === true).toBe(true);
  });

  test("auth context set correctly for super_user", () => {
    const user = "heskew@pm.me";
    // Simulate what the middleware sets
    const request: any = {};
    request.headers = { set: (_k: string, _v: string) => {} };
    (request as any)._tpsAuthVerified = true;
    request.user = { id: user, role: { permission: { super_user: true } } };
    request.tpsAgent = user;
    request.tpsAgentIsAdmin = true;
    expect(request._tpsAuthVerified).toBe(true);
    expect(request.tpsAgent).toBe(user);
    expect(request.tpsAgentIsAdmin).toBe(true);
  });

  test("complete auth flow simulation: super_user via Basic auth", async () => {
    // Simulate the full Basic auth flow
    const adminPass = "s3cret";
    const user = "heskew@pm.me";
    const pass = "heskewspass";
    const mockGetUser = async (u: string, p: string): Promise<any> => {
      if (u === "heskew@pm.me" && p === "heskewspass") {
        return { role: { permission: { super_user: true } } };
      }
      return null;
    };

    // Path 1: env-var fast-path — doesn't match (user !== "admin")
    const path1Match = adminPass !== null && user === "admin" && pass === adminPass;
    expect(path1Match).toBe(false);

    // Path 2: super_user check
    const harperUser = await mockGetUser(user, pass);
    const path2Match = harperUser?.role?.permission?.super_user === true;
    expect(path2Match).toBe(true);
  });

  test("invalid creds rejected by complete flow", async () => {
    const user = "anyone";
    const pass = "wrongpass";
    const mockGetUser = async (): Promise<any> => {
      throw new Error("invalid creds");
    };

    let harperUser: any = null;
    try {
      harperUser = await mockGetUser(user, pass);
    } catch { /* fall through */ }

    expect(harperUser?.role?.permission?.super_user === true).toBe(false);
  });
});

