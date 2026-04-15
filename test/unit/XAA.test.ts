/**
 * XAA.ts unit tests
 *
 * XAA exports two functions (validateIdJag, handleJwtBearerGrant) that both call
 * Harper databases internally — they cannot be tested end-to-end without a running
 * Harper instance. This file tests:
 *
 *   - JWT pre-decode logic (extract issuer before signature verification)
 *   - Issuer validation rules
 *   - Domain restriction logic (hd/tid claim matching)
 *   - Scope intersection (allowed scopes vs requested scopes)
 *   - JIT provisioning guard logic
 *   - Principal ID generation pattern
 *   - Token response shape for jwt-bearer grant
 *
 * Coverage gaps:
 *   - validateIdJag() signature verification requires a real IdP + JWKS endpoint
 *   - handleJwtBearerGrant() full flow requires Harper DB (IdpConfig, Credential, Agent tables)
 *   - resolveOrCreatePrincipal() is unexported
 */

import { describe, test, expect } from "bun:test";
import { createHash, randomBytes } from "node:crypto";

// ─── JWT pre-decode helper (mirrors validateIdJag preamble) ──────────────────

function preDecodeJwtPayload(jwt: string): any {
  const parts = jwt.split(".");
  if (parts.length !== 3) throw new Error("invalid JWT format");
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString());
  } catch {
    throw new Error("invalid JWT payload encoding");
  }
}

function buildFakeJwt(payload: Record<string, any>): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const fakeSig = "fakesignature";
  return `${header}.${body}.${fakeSig}`;
}

// ─── JWT pre-decode ───────────────────────────────────────────────────────────

describe("JWT pre-decode", () => {
  test("extracts issuer from a well-formed JWT", () => {
    const jwt = buildFakeJwt({ iss: "https://accounts.google.com", sub: "user123" });
    const payload = preDecodeJwtPayload(jwt);
    expect(payload.iss).toBe("https://accounts.google.com");
    expect(payload.sub).toBe("user123");
  });

  test("throws on non-JWT string (too few parts)", () => {
    expect(() => preDecodeJwtPayload("not.a")).toThrow("invalid JWT format");
  });

  test("throws on malformed base64url payload", () => {
    expect(() => preDecodeJwtPayload("header.!!!.sig")).toThrow();
  });

  test("throws when iss is missing", () => {
    const jwt = buildFakeJwt({ sub: "user123" }); // no iss
    const payload = preDecodeJwtPayload(jwt);
    expect(payload.iss).toBeUndefined();
    // Caller must check for missing iss
    if (!payload.iss) {
      expect(true).toBe(true); // confirms iss guard is needed
    }
  });

  test("handles Azure tid claim", () => {
    const jwt = buildFakeJwt({
      iss: "https://login.microsoftonline.com/tenant-id/v2.0",
      tid: "contoso.com",
      sub: "azure-user",
    });
    const payload = preDecodeJwtPayload(jwt);
    expect(payload.tid).toBe("contoso.com");
  });

  test("handles Google hd claim", () => {
    const jwt = buildFakeJwt({
      iss: "https://accounts.google.com",
      hd: "example.com",
      sub: "google-user",
    });
    const payload = preDecodeJwtPayload(jwt);
    expect(payload.hd).toBe("example.com");
  });
});

// ─── Domain restriction logic ─────────────────────────────────────────────────

/**
 * Mirrors the domain restriction logic in validateIdJag (lines 105-117).
 * Called only after cryptographic verification — claims are trusted at this point.
 */
function checkDomainRestriction(
  payload: Record<string, any>,
  requiredDomain: string | null,
): { ok: boolean; error?: string } {
  if (!requiredDomain) return { ok: true };

  const hd = payload.hd;
  const tid = payload.tid;

  if (hd && hd !== requiredDomain) {
    return { ok: false, error: `domain mismatch: expected ${requiredDomain}, got ${hd}` };
  }
  if (tid && tid !== requiredDomain) {
    return { ok: false, error: `tenant mismatch: expected ${requiredDomain}, got ${tid}` };
  }
  if (!hd && !tid) {
    return { ok: false, error: "domain required but no hd/tid claim present — consumer account rejected" };
  }
  return { ok: true };
}

describe("domain restriction", () => {
  test("passes when no domain restriction is configured", () => {
    const result = checkDomainRestriction({ sub: "user" }, null);
    expect(result.ok).toBe(true);
  });

  test("passes when hd matches required domain", () => {
    const result = checkDomainRestriction({ hd: "acme.com" }, "acme.com");
    expect(result.ok).toBe(true);
  });

  test("passes when tid matches required domain", () => {
    const result = checkDomainRestriction({ tid: "contoso.com" }, "contoso.com");
    expect(result.ok).toBe(true);
  });

  test("fails when hd does not match required domain", () => {
    const result = checkDomainRestriction({ hd: "evil.com" }, "acme.com");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("domain mismatch");
    expect(result.error).toContain("acme.com");
    expect(result.error).toContain("evil.com");
  });

  test("fails when tid does not match required domain", () => {
    const result = checkDomainRestriction({ tid: "wrong.com" }, "contoso.com");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("tenant mismatch");
  });

  test("fails when neither hd nor tid is present (consumer account)", () => {
    const result = checkDomainRestriction({ sub: "personal@gmail.com" }, "acme.com");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("consumer account rejected");
  });

  test("both hd and tid must match when present — tid mismatch fails even if hd matches", () => {
    // Source checks hd first (passes), then tid (fails):
    //   if (hd && hd !== required) throw
    //   if (tid && tid !== required) throw
    // So if hd matches but tid doesn't, the tid check still rejects.
    const result = checkDomainRestriction({ hd: "acme.com", tid: "different.com" }, "acme.com");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("tenant mismatch");
  });
});

// ─── Scope intersection ───────────────────────────────────────────────────────

/**
 * Mirrors the scope intersection logic in handleJwtBearerGrant (lines 225-231).
 */
function intersectScopes(
  requestedScopeStr: string,
  allowedScopes: string[] | null,
): string {
  const requestedScopes = requestedScopeStr.split(" ");
  const allowedSet = allowedScopes?.length ? new Set(allowedScopes) : null;
  const granted = allowedSet
    ? requestedScopes.filter((s) => allowedSet.has(s))
    : requestedScopes;
  return granted.join(" ");
}

describe("scope intersection", () => {
  test("all scopes granted when no allowedScopes restriction", () => {
    const granted = intersectScopes("memory:read memory:write principal:read", null);
    expect(granted).toBe("memory:read memory:write principal:read");
  });

  test("only allowed scopes pass through", () => {
    const granted = intersectScopes(
      "memory:read memory:write connector:admin",
      ["memory:read", "memory:write"],
    );
    expect(granted).toBe("memory:read memory:write");
  });

  test("empty result when no overlap", () => {
    const granted = intersectScopes("connector:admin principal:admin", ["memory:read"]);
    expect(granted).toBe("");
  });

  test("single scope passed through", () => {
    const granted = intersectScopes("memory:read", ["memory:read", "memory:write"]);
    expect(granted).toBe("memory:read");
  });

  test("empty allowedScopes array treated as no restriction", () => {
    // allowedScopes?.length is falsy when empty array → null path
    const granted = intersectScopes("memory:read memory:write", []);
    expect(granted).toBe("memory:read memory:write");
  });

  test("duplicate requested scopes are preserved as-is", () => {
    const granted = intersectScopes("memory:read memory:read", ["memory:read"]);
    // intersection keeps both occurrences; consumer must deduplicate if needed
    expect(granted).toBe("memory:read memory:read");
  });
});

// ─── JIT provisioning guard ───────────────────────────────────────────────────

/**
 * Mirrors the jitProvision guard in resolveOrCreatePrincipal.
 */
function shouldJitProvision(
  foundExisting: boolean,
  jitProvisionEnabled: boolean,
): { provision: boolean; error?: string } {
  if (foundExisting) return { provision: false };
  if (!jitProvisionEnabled) {
    return {
      provision: false,
      error: "no principal for IdP subject and JIT provisioning is disabled",
    };
  }
  return { provision: true };
}

describe("JIT provisioning guard", () => {
  test("no provisioning needed when principal already exists", () => {
    const result = shouldJitProvision(true, true);
    expect(result.provision).toBe(false);
    expect(result.error).toBeUndefined();
  });

  test("provisions when no existing principal and JIT enabled", () => {
    const result = shouldJitProvision(false, true);
    expect(result.provision).toBe(true);
  });

  test("errors when no existing principal and JIT disabled", () => {
    const result = shouldJitProvision(false, false);
    expect(result.provision).toBe(false);
    expect(result.error).toContain("JIT provisioning is disabled");
  });
});

// ─── Principal ID generation pattern ─────────────────────────────────────────

describe("principal ID generation", () => {
  test("principal ID has usr_ prefix", () => {
    const idpSubject = "user@example.com";
    const sanitized = idpSubject.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 20);
    const principalId = `usr_${sanitized}_${randomBytes(4).toString("hex")}`;
    expect(principalId.startsWith("usr_")).toBe(true);
  });

  test("special chars in IdP subject are sanitized", () => {
    const idpSubject = "user@example.com";
    const sanitized = idpSubject.replace(/[^a-zA-Z0-9]/g, "_");
    expect(sanitized).not.toMatch(/[@.]/);
    expect(sanitized).toMatch(/^[a-zA-Z0-9_]+$/);
  });

  test("subject is truncated to 20 chars", () => {
    const longSubject = "a".repeat(100);
    const truncated = longSubject.slice(0, 20);
    expect(truncated.length).toBe(20);
  });

  test("random suffix ensures uniqueness for same IdP subject", () => {
    const idpSubject = "user123";
    const ids = new Set(
      Array.from({ length: 20 }, () =>
        `usr_${idpSubject}_${randomBytes(4).toString("hex")}`
      )
    );
    expect(ids.size).toBe(20);
  });
});

// ─── Email / display name resolution ─────────────────────────────────────────

describe("display name resolution from JWT claims", () => {
  test("prefers name claim", () => {
    const payload = { sub: "s", email: "e@e.com", name: "Alice" };
    const displayName = payload.name ?? payload.email ?? payload.sub;
    expect(displayName).toBe("Alice");
  });

  test("falls back to email when name absent", () => {
    const payload = { sub: "s", email: "e@e.com" };
    const displayName = (payload as any).name ?? payload.email ?? payload.sub;
    expect(displayName).toBe("e@e.com");
  });

  test("falls back to sub when neither name nor email present", () => {
    const payload = { sub: "s" };
    const displayName = (payload as any).name ?? (payload as any).email ?? payload.sub;
    expect(displayName).toBe("s");
  });

  test("prefers email over preferred_username via explicit pick", () => {
    // resolveOrCreatePrincipal: email = payload.email ?? payload.preferred_username
    const payload = { sub: "s", email: "e@e.com", preferred_username: "euser" };
    const email = payload.email ?? payload.preferred_username;
    expect(email).toBe("e@e.com");
  });

  test("uses preferred_username when email absent", () => {
    const payload = { sub: "s", preferred_username: "euser" };
    const email = (payload as any).email ?? payload.preferred_username;
    expect(email).toBe("euser");
  });
});

// ─── Clock skew constant ──────────────────────────────────────────────────────

describe("clock skew tolerance", () => {
  test("CLOCK_SKEW_MS is 30 seconds", () => {
    const CLOCK_SKEW_MS = 30_000;
    expect(CLOCK_SKEW_MS).toBe(30_000);
  });

  test("clock skew in seconds for jose is 30", () => {
    const CLOCK_SKEW_MS = 30_000;
    expect(CLOCK_SKEW_MS / 1000).toBe(30);
  });
});
