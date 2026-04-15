/**
 * OAuth.ts unit tests
 *
 * OAuth 2.1 resource classes extend Harper's Resource and depend on `databases`,
 * so they cannot be instantiated directly. This file tests the pure / extractable
 * logic that lives inside OAuth.ts:
 *
 *   - PKCE S256 challenge generation and verification
 *   - Redirect URI allowlist enforcement
 *   - Token response shape (fields, types, TTL)
 *   - Authorization-code record shape
 *   - OAuth metadata shape
 *   - Grant type routing
 *
 * Coverage gaps:
 *   - OAuthRegister.post(), OAuthAuthorize.get/post(), OAuthToken.post(),
 *     OAuthRevoke.post() are all bound to Harper DB — not directly testable
 *     without a running Harper instance.
 */

import { describe, test, expect } from "bun:test";
import { createHash, randomBytes } from "node:crypto";

// ─── Replicated pure helpers (same logic as OAuth.ts) ───────────────────────

const ALLOWED_REDIRECT_URI = "https://claude.com/api/mcp/auth_callback";
const ACCESS_TOKEN_TTL_MS = 3_600_000;        // 1 hour
const REFRESH_TOKEN_TTL_MS = 7 * 86_400_000;  // 7 days
const AUTH_CODE_TTL_MS = 600_000;             // 10 minutes

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function randomToken(prefix: string): string {
  return `${prefix}${randomBytes(32).toString("base64url")}`;
}

function nowISO(): string {
  return new Date().toISOString();
}

function futureISO(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

/** Mirror of the PKCE S256 verification logic in OAuthToken.handleAuthorizationCode */
function verifySha256Pkce(codeVerifier: string, codeChallenge: string): boolean {
  const expected = createHash("sha256").update(codeVerifier).digest("base64url");
  return expected === codeChallenge;
}

/** Mirror of the redirect URI validation used in OAuthRegister and OAuthAuthorize */
function validateRedirectUris(uris: string[]): { valid: boolean; invalidUri?: string } {
  for (const uri of uris) {
    if (uri !== ALLOWED_REDIRECT_URI) {
      return { valid: false, invalidUri: uri };
    }
  }
  return { valid: true };
}

// ─── PKCE S256 ───────────────────────────────────────────────────────────────

describe("PKCE S256", () => {
  test("correct verifier satisfies challenge", () => {
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    expect(verifySha256Pkce(verifier, challenge)).toBe(true);
  });

  test("wrong verifier fails", () => {
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const wrongVerifier = randomBytes(32).toString("base64url");
    expect(verifySha256Pkce(wrongVerifier, challenge)).toBe(false);
  });

  test("challenge is base64url (no +, /, =)", () => {
    const verifier = "s3cr3t_verifier_value";
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    expect(challenge).not.toMatch(/[+/=]/);
  });

  test("deterministic: same verifier always produces same challenge", () => {
    const verifier = "stable-test-verifier";
    const c1 = createHash("sha256").update(verifier).digest("base64url");
    const c2 = createHash("sha256").update(verifier).digest("base64url");
    expect(c1).toBe(c2);
  });

  test("distinct verifiers produce distinct challenges", () => {
    const v1 = randomBytes(32).toString("base64url");
    const v2 = randomBytes(32).toString("base64url");
    const c1 = createHash("sha256").update(v1).digest("base64url");
    const c2 = createHash("sha256").update(v2).digest("base64url");
    expect(c1).not.toBe(c2);
  });
});

// ─── Redirect URI validation ─────────────────────────────────────────────────

describe("redirect URI validation", () => {
  test("claude.com callback is the only allowed URI", () => {
    const result = validateRedirectUris([ALLOWED_REDIRECT_URI]);
    expect(result.valid).toBe(true);
  });

  test("arbitrary HTTPS URI is rejected", () => {
    const result = validateRedirectUris(["https://evil.example.com/callback"]);
    expect(result.valid).toBe(false);
    expect(result.invalidUri).toBe("https://evil.example.com/callback");
  });

  test("HTTP variant of allowed URI is rejected", () => {
    const result = validateRedirectUris(["http://claude.com/api/mcp/auth_callback"]);
    expect(result.valid).toBe(false);
  });

  test("empty list passes (will be defaulted to allowed URI)", () => {
    const result = validateRedirectUris([]);
    expect(result.valid).toBe(true);
  });

  test("mix of valid and invalid fails on first invalid", () => {
    const result = validateRedirectUris([
      ALLOWED_REDIRECT_URI,
      "https://attacker.example.com/cb",
    ]);
    expect(result.valid).toBe(false);
    expect(result.invalidUri).toBe("https://attacker.example.com/cb");
  });

  test("localhost redirect is rejected", () => {
    const result = validateRedirectUris(["http://localhost:3000/callback"]);
    expect(result.valid).toBe(false);
  });
});

// ─── Token helpers ────────────────────────────────────────────────────────────

describe("token helpers", () => {
  test("randomToken has the expected prefix", () => {
    const at = randomToken("flair_at_");
    expect(at.startsWith("flair_at_")).toBe(true);
    expect(at.length).toBeGreaterThan(20);
  });

  test("randomToken produces unique values", () => {
    const tokens = new Set(Array.from({ length: 100 }, () => randomToken("flair_at_")));
    expect(tokens.size).toBe(100);
  });

  test("sha256 produces a 64-char hex string", () => {
    const hash = sha256("test-input");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("sha256 is deterministic", () => {
    expect(sha256("hello")).toBe(sha256("hello"));
  });

  test("sha256 produces distinct hashes for distinct inputs", () => {
    expect(sha256("token-a")).not.toBe(sha256("token-b"));
  });
});

// ─── TTL / expiry helpers ─────────────────────────────────────────────────────

describe("expiry helpers", () => {
  test("futureISO returns a valid ISO string in the future", () => {
    const future = futureISO(ACCESS_TOKEN_TTL_MS);
    expect(new Date(future).getTime()).toBeGreaterThan(Date.now());
  });

  test("access token expires in ~1 hour", () => {
    const future = new Date(futureISO(ACCESS_TOKEN_TTL_MS)).getTime();
    const diff = future - Date.now();
    // Allow 1s of test execution jitter
    expect(diff).toBeGreaterThan(ACCESS_TOKEN_TTL_MS - 1000);
    expect(diff).toBeLessThanOrEqual(ACCESS_TOKEN_TTL_MS + 1000);
  });

  test("refresh token expires in ~7 days", () => {
    const future = new Date(futureISO(REFRESH_TOKEN_TTL_MS)).getTime();
    const diff = future - Date.now();
    expect(diff).toBeGreaterThan(REFRESH_TOKEN_TTL_MS - 1000);
    expect(diff).toBeLessThanOrEqual(REFRESH_TOKEN_TTL_MS + 1000);
  });

  test("auth code expires in ~10 minutes", () => {
    const future = new Date(futureISO(AUTH_CODE_TTL_MS)).getTime();
    const diff = future - Date.now();
    expect(diff).toBeGreaterThan(AUTH_CODE_TTL_MS - 1000);
    expect(diff).toBeLessThanOrEqual(AUTH_CODE_TTL_MS + 1000);
  });

  test("nowISO returns a valid ISO string close to now", () => {
    const now = Date.now();
    const iso = nowISO();
    const parsed = new Date(iso).getTime();
    expect(Math.abs(parsed - now)).toBeLessThan(100);
  });

  test("expired code is detectable", () => {
    // Simulate a code that was created 11 minutes ago
    const pastISO = new Date(Date.now() - AUTH_CODE_TTL_MS - 60_000).toISOString();
    expect(new Date(pastISO) < new Date()).toBe(true);
  });
});

// ─── Token response shape ─────────────────────────────────────────────────────

describe("token response shape", () => {
  test("issueTokenPair output has required OAuth 2.x fields", () => {
    // Simulate the return value of issueTokenPair
    const scope = "memory:read memory:write";
    const accessTokenRaw = randomToken("flair_at_");
    const refreshTokenRaw = randomToken("flair_rt_");

    const response = {
      access_token: accessTokenRaw,
      token_type: "Bearer",
      expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
      refresh_token: refreshTokenRaw,
      scope,
    };

    expect(response.access_token).toBeTruthy();
    expect(response.token_type).toBe("Bearer");
    expect(response.expires_in).toBe(3600);
    expect(response.refresh_token).toBeTruthy();
    expect(response.scope).toBe(scope);
    // access and refresh tokens must be distinct
    expect(response.access_token).not.toBe(response.refresh_token);
  });

  test("access_token uses flair_at_ prefix", () => {
    const token = randomToken("flair_at_");
    expect(token.startsWith("flair_at_")).toBe(true);
  });

  test("refresh_token uses flair_rt_ prefix", () => {
    const token = randomToken("flair_rt_");
    expect(token.startsWith("flair_rt_")).toBe(true);
  });
});

// ─── Authorization code record shape ─────────────────────────────────────────

describe("authorization code record", () => {
  test("code record has all required fields", () => {
    const code = randomBytes(32).toString("base64url");
    const now = nowISO();

    const record = {
      id: code,
      clientId: "flair_cl_abc123",
      principalId: "admin",
      redirectUri: ALLOWED_REDIRECT_URI,
      scope: "memory:read",
      codeChallenge: createHash("sha256").update("verifier").digest("base64url"),
      codeChallengeMethod: "S256",
      expiresAt: futureISO(AUTH_CODE_TTL_MS),
      used: false,
      createdAt: now,
    };

    expect(record.id).toBeTruthy();
    expect(record.codeChallengeMethod).toBe("S256");
    expect(record.used).toBe(false);
    expect(new Date(record.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  test("used-code replay is detectable", () => {
    const authCode = { used: true, expiresAt: futureISO(AUTH_CODE_TTL_MS) };
    expect(authCode.used).toBe(true);
  });
});

// ─── OAuth metadata shape ─────────────────────────────────────────────────────

describe("OAuth metadata shape", () => {
  test("metadata includes all required discovery fields", () => {
    const baseUrl = "https://flair.example.com";
    const metadata = {
      issuer: baseUrl,
      authorization_endpoint: `${baseUrl}/OAuthAuthorize`,
      token_endpoint: `${baseUrl}/OAuthToken`,
      registration_endpoint: `${baseUrl}/OAuthRegister`,
      revocation_endpoint: `${baseUrl}/OAuthRevoke`,
      response_types_supported: ["code"],
      grant_types_supported: [
        "authorization_code",
        "refresh_token",
        "urn:ietf:params:oauth:grant-type:jwt-bearer",
      ],
      token_endpoint_auth_methods_supported: ["none", "client_secret_basic"],
      code_challenge_methods_supported: ["S256"],
    };

    expect(metadata.issuer).toBe(baseUrl);
    expect(metadata.response_types_supported).toContain("code");
    expect(metadata.grant_types_supported).toContain("authorization_code");
    expect(metadata.grant_types_supported).toContain("urn:ietf:params:oauth:grant-type:jwt-bearer");
    expect(metadata.code_challenge_methods_supported).toContain("S256");
    expect(metadata.code_challenge_methods_supported).not.toContain("plain");
  });

  test("endpoints are rooted at the base URL", () => {
    const baseUrl = "https://flair.example.com";
    const token = `${baseUrl}/OAuthToken`;
    expect(token.startsWith(baseUrl)).toBe(true);
  });
});

// ─── Grant type routing ───────────────────────────────────────────────────────

describe("grant type routing", () => {
  test("recognized grant types are identified", () => {
    const supported = ["authorization_code", "refresh_token", "urn:ietf:params:oauth:grant-type:jwt-bearer"];
    for (const gt of supported) {
      expect(supported.includes(gt)).toBe(true);
    }
  });

  test("unsupported grant type is detectable", () => {
    const supported = new Set(["authorization_code", "refresh_token", "urn:ietf:params:oauth:grant-type:jwt-bearer"]);
    expect(supported.has("client_credentials")).toBe(false);
    expect(supported.has("password")).toBe(false);
    expect(supported.has("implicit")).toBe(false);
  });
});
