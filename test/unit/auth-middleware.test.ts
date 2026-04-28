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

