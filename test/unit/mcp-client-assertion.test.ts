/**
 * Tests for src/mcp-client-assertion.ts — the RFC 7523 client_assertion
 * signer (the Flair/consumer half of headless agent-auth to a Harper MCP
 * `/mcp` endpoint).
 *
 * The central claim under test: an assertion `signClientAssertion` produces
 * is one HarperFast/oauth PR #165's `verifyClientAssertion` (**merged** @
 * commit d48c3b2, `src/lib/mcp/clientAssertion.ts`) would accept.
 * `mirrorVerifyClientAssertion` below re-implements its verification
 * contract faithfully enough to exercise that claim — production
 * verification lives entirely in the plugin; this is a round-trip check,
 * not a reimplementation we ship.
 *
 * A second claim, covered further down: the token-request form
 * (`buildTokenRequestForm`) matches what shipped in HarperFast/oauth@2.2.0
 * PR #170 (closing issues #161/#162, "client_credentials (3/4):
 * token-endpoint grant") for the request side —
 * `client_assertion_type`/`client_assertion`/`client_id` present, `client_id`
 * equal to the assertion's `iss`/`sub`, and an optional RFC 8707 `resource`
 * pass-through — confirmed against the published package's source
 * (`node_modules/@harperfast/oauth/dist/lib/mcp/token.js`).
 *
 * A third claim: `requestMcpAccessToken`/`getMcpAccessToken` perform a real
 * HTTP round-trip against a token endpoint shaped like the published
 * package's (a local `node:http` server standing in for it here, since the
 * plugin's own SSRF-guarded CIMD client-resolution step cannot be driven
 * from a loopback-only ephemeral Harper — see
 * `test/integration/mcp-client-credentials-e2e.test.ts` and
 * `docs/notes/mcp-agent-auth-consumer.md` for the live-Harper proof of what
 * IS reachable, and the documented reason the full mint can't be forced
 * further in this environment): success parsing, non-2xx error mapping,
 * `429 slow_down` + `Retry-After` jittered-backoff retry (#171/#163's
 * client-side counterpart), and token caching (mint sparingly, reuse until
 * near-expiry — the consumer requirement flair#663's tracking-issue comment
 * pins to the 2.2.0 rate limiter).
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { generateKeyPairSync, createPublicKey, verify as verifySignature, type KeyObject } from "node:crypto";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import {
  CLIENT_ASSERTION_TYPE_JWT_BEARER,
  MAX_ASSERTION_LIFETIME_SECONDS,
  signClientAssertion,
  publicJwkFromPrivateKey,
  buildTokenRequestForm,
  requestMcpAccessToken,
  getMcpAccessToken,
  clearMcpAccessTokenCache,
  McpTokenRequestError,
  resolveAgentKeyPath,
  loadEd25519PrivateKeyFromFile,
  defaultMcpIssuer,
  defaultMcpResource,
  defaultMcpTokenEndpoint,
  defaultMcpClientId,
} from "../../src/mcp-client-assertion";

const CLIENT_ID = "https://flair.example.com/MCPClientMetadata/flint";
const TOKEN_ENDPOINT = "https://flair.example.com/oauth/mcp/token";

function makeKeyPair() {
  return generateKeyPairSync("ed25519");
}

// ─── Mirror of HarperFast/oauth PR #165's clientAssertion.ts verification ──
// Faithful to the checks that matter for round-trip testing: alg pinning,
// iss=sub=client_id, aud exact match, exp/iat window, jti presence,
// signature verification over header.payload with no digest algorithm.
// NOT the shipped verifier — that lives in the plugin.
function mirrorVerifyClientAssertion(
  assertion: string,
  opts: { clientId: string; tokenEndpoint: string; jwk: { kty: string; crv: string; x: string }; maxExpiresIn?: number },
): { valid: true; claims: any } | { valid: false; reason: string } {
  const segments = assertion.split(".");
  if (segments.length !== 3) return { valid: false, reason: "not a compact JWT" };
  const [h, p, s] = segments;

  const header = JSON.parse(Buffer.from(h, "base64url").toString("utf8"));
  if (header.alg !== "EdDSA") return { valid: false, reason: "alg must be EdDSA" };
  if (header.typ !== undefined && String(header.typ).toUpperCase() !== "JWT") {
    return { valid: false, reason: "typ must be JWT" };
  }

  const publicKey = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: opts.jwk.x }, format: "jwk" });
  const signature = Buffer.from(s, "base64url");
  if (signature.length !== 64) return { valid: false, reason: "signature malformed" };
  const ok = verifySignature(null, Buffer.from(`${h}.${p}`), publicKey, signature);
  if (!ok) return { valid: false, reason: "signature verification failed" };

  const claims = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
  if (claims.iss !== opts.clientId) return { valid: false, reason: "iss mismatch" };
  if (claims.sub !== opts.clientId) return { valid: false, reason: "sub mismatch" };
  if (claims.aud !== opts.tokenEndpoint) return { valid: false, reason: "aud mismatch" };

  const now = Math.floor(Date.now() / 1000);
  const maxExpiresIn = opts.maxExpiresIn ?? 60;
  const tolerance = 5;
  if (typeof claims.exp !== "number") return { valid: false, reason: "exp required" };
  if (claims.exp <= now - tolerance) return { valid: false, reason: "expired" };
  if (claims.exp > now + maxExpiresIn + tolerance) return { valid: false, reason: "exp window exceeded" };
  if (typeof claims.iat !== "number") return { valid: false, reason: "iat required" };
  if (claims.iat > now + tolerance) return { valid: false, reason: "iat in future" };
  if (claims.exp - claims.iat > maxExpiresIn + tolerance) return { valid: false, reason: "lifetime exceeds window" };
  if (typeof claims.jti !== "string" || claims.jti.length === 0) return { valid: false, reason: "jti required" };

  return { valid: true, claims };
}

describe("signClientAssertion", () => {
  test("produces an assertion the mirrored #165 verifier accepts", () => {
    const { privateKey } = makeKeyPair();
    const jwk = publicJwkFromPrivateKey(privateKey);
    const { assertion, claims } = signClientAssertion({
      clientId: CLIENT_ID,
      tokenEndpoint: TOKEN_ENDPOINT,
      privateKey,
    });

    const result = mirrorVerifyClientAssertion(assertion, { clientId: CLIENT_ID, tokenEndpoint: TOKEN_ENDPOINT, jwk });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.claims.iss).toBe(CLIENT_ID);
      expect(result.claims.sub).toBe(CLIENT_ID);
      expect(result.claims.aud).toBe(TOKEN_ENDPOINT);
      expect(result.claims.jti).toBe(claims.jti);
    }
  });

  test("header is exactly {alg: EdDSA, typ: JWT}", () => {
    const { privateKey } = makeKeyPair();
    const { assertion } = signClientAssertion({ clientId: CLIENT_ID, tokenEndpoint: TOKEN_ENDPOINT, privateKey });
    const [h] = assertion.split(".");
    const header = JSON.parse(Buffer.from(h, "base64url").toString("utf8"));
    expect(header).toEqual({ alg: "EdDSA", typ: "JWT" });
  });

  test("iss, sub, aud, exp, iat, jti are all present and correctly shaped", () => {
    const { privateKey } = makeKeyPair();
    const before = Math.floor(Date.now() / 1000);
    const { claims } = signClientAssertion({ clientId: CLIENT_ID, tokenEndpoint: TOKEN_ENDPOINT, privateKey });
    expect(claims.iss).toBe(CLIENT_ID);
    expect(claims.sub).toBe(CLIENT_ID);
    expect(claims.aud).toBe(TOKEN_ENDPOINT);
    expect(typeof claims.jti).toBe("string");
    expect(claims.jti.length).toBeGreaterThan(0);
    expect(claims.iat).toBeGreaterThanOrEqual(before);
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(MAX_ASSERTION_LIFETIME_SECONDS);
    expect(claims.exp - claims.iat).toBeGreaterThan(0);
  });

  test("exp - iat is hard-capped at MAX_ASSERTION_LIFETIME_SECONDS even if a longer window is requested", () => {
    const { privateKey } = makeKeyPair();
    const { claims } = signClientAssertion({
      clientId: CLIENT_ID,
      tokenEndpoint: TOKEN_ENDPOINT,
      privateKey,
      expiresInSeconds: 3600,
    });
    expect(claims.exp - claims.iat).toBe(MAX_ASSERTION_LIFETIME_SECONDS);
  });

  test("a distinct random jti is generated per call", () => {
    const { privateKey } = makeKeyPair();
    const a = signClientAssertion({ clientId: CLIENT_ID, tokenEndpoint: TOKEN_ENDPOINT, privateKey });
    const b = signClientAssertion({ clientId: CLIENT_ID, tokenEndpoint: TOKEN_ENDPOINT, privateKey });
    expect(a.claims.jti).not.toBe(b.claims.jti);
  });

  test("SECURITY: tampering with the payload invalidates the signature", () => {
    const { privateKey } = makeKeyPair();
    const jwk = publicJwkFromPrivateKey(privateKey);
    const { assertion } = signClientAssertion({ clientId: CLIENT_ID, tokenEndpoint: TOKEN_ENDPOINT, privateKey });
    const [h, p, s] = assertion.split(".");
    const claims = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
    const tamperedClaims = { ...claims, sub: "https://attacker.example.com/MCPClientMetadata/evil" };
    const tamperedP = Buffer.from(JSON.stringify(tamperedClaims)).toString("base64url");
    const tampered = `${h}.${tamperedP}.${s}`;

    const result = mirrorVerifyClientAssertion(tampered, { clientId: CLIENT_ID, tokenEndpoint: TOKEN_ENDPOINT, jwk });
    expect(result.valid).toBe(false);
  });

  test("SECURITY: wrong aud is rejected (audience-confusion defense)", () => {
    const { privateKey } = makeKeyPair();
    const jwk = publicJwkFromPrivateKey(privateKey);
    const { assertion } = signClientAssertion({
      clientId: CLIENT_ID,
      tokenEndpoint: "https://a-different-as.example.com/oauth/mcp/token",
      privateKey,
    });
    const result = mirrorVerifyClientAssertion(assertion, { clientId: CLIENT_ID, tokenEndpoint: TOKEN_ENDPOINT, jwk });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toMatch(/aud/);
  });

  test("SECURITY: an assertion signed with a DIFFERENT agent's key fails verification", () => {
    const { privateKey: realKey } = makeKeyPair();
    const { privateKey: attackerKey } = makeKeyPair();
    const realJwk = publicJwkFromPrivateKey(realKey);
    // Attacker signs an assertion CLAIMING to be the real client_id, using their own key.
    const { assertion } = signClientAssertion({ clientId: CLIENT_ID, tokenEndpoint: TOKEN_ENDPOINT, privateKey: attackerKey });
    const result = mirrorVerifyClientAssertion(assertion, { clientId: CLIENT_ID, tokenEndpoint: TOKEN_ENDPOINT, jwk: realJwk });
    expect(result.valid).toBe(false);
  });

  test("an expired assertion is rejected", () => {
    const { privateKey } = makeKeyPair();
    const jwk = publicJwkFromPrivateKey(privateKey);
    const past = Math.floor(Date.now() / 1000) - 3600;
    const { assertion } = signClientAssertion({
      clientId: CLIENT_ID,
      tokenEndpoint: TOKEN_ENDPOINT,
      privateKey,
      nowSeconds: past,
    });
    const result = mirrorVerifyClientAssertion(assertion, { clientId: CLIENT_ID, tokenEndpoint: TOKEN_ENDPOINT, jwk });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe("expired");
  });
});

describe("publicJwkFromPrivateKey", () => {
  test("derives a JWK OKP/Ed25519 matching #165's expected key shape", () => {
    const { privateKey } = makeKeyPair();
    const jwk = publicJwkFromPrivateKey(privateKey);
    expect(jwk.kty).toBe("OKP");
    expect(jwk.crv).toBe("Ed25519");
    expect(typeof jwk.x).toBe("string");
    // Unpadded base64url of a 32-byte key is 43 chars.
    expect(jwk.x.length).toBe(43);
  });

  test("rejects a non-Ed25519 key", () => {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" } as any);
    expect(() => publicJwkFromPrivateKey(privateKey as unknown as KeyObject)).toThrow();
  });
});

describe("loadEd25519PrivateKeyFromFile", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mcp-assertion-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("loads a base64-encoded PKCS8 DER key (the standard ~/.tps/secrets/flair format)", () => {
    const { privateKey } = makeKeyPair();
    const der = privateKey.export({ format: "der", type: "pkcs8" });
    const file = join(dir, "test-pkcs8.key");
    writeFileSync(file, Buffer.from(der).toString("base64"));

    const loaded = loadEd25519PrivateKeyFromFile(file);
    const originalJwk = publicJwkFromPrivateKey(privateKey);
    const loadedJwk = publicJwkFromPrivateKey(loaded);
    expect(loadedJwk.x).toBe(originalJwk.x);
  });

  test("loads a base64-encoded raw 32-byte seed", () => {
    const { privateKey } = makeKeyPair();
    // Extract the raw seed by re-deriving via the same PKCS8 export minus the header:
    // Node's PKCS8 DER for Ed25519 is a fixed 16-byte prefix + 32-byte seed.
    const der = Buffer.from(privateKey.export({ format: "der", type: "pkcs8" }));
    const seed = der.subarray(der.length - 32);
    const file = join(dir, "test-seed.key");
    writeFileSync(file, seed.toString("base64"));

    const loaded = loadEd25519PrivateKeyFromFile(file);
    const originalJwk = publicJwkFromPrivateKey(privateKey);
    const loadedJwk = publicJwkFromPrivateKey(loaded);
    expect(loadedJwk.x).toBe(originalJwk.x);
  });

  test("loads a raw 32-byte binary seed file (no text encoding)", () => {
    const { privateKey } = makeKeyPair();
    const der = Buffer.from(privateKey.export({ format: "der", type: "pkcs8" }));
    const seed = der.subarray(der.length - 32);
    const file = join(dir, "test-raw-seed.key");
    writeFileSync(file, seed);

    const loaded = loadEd25519PrivateKeyFromFile(file);
    const originalJwk = publicJwkFromPrivateKey(privateKey);
    const loadedJwk = publicJwkFromPrivateKey(loaded);
    expect(loadedJwk.x).toBe(originalJwk.x);
  });
});

describe("resolveAgentKeyPath", () => {
  test("keysDirOverride takes priority over FLAIR_KEY_DIR and defaults", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-assertion-keydir-"));
    writeFileSync(join(dir, "testagent.key"), "not-a-real-key");
    const resolved = resolveAgentKeyPath("testagent", dir);
    expect(resolved).toBe(join(dir, "testagent.key"));
    rmSync(dir, { recursive: true, force: true });
  });

  test("returns null when no candidate path exists", () => {
    const resolved = resolveAgentKeyPath("definitely-not-a-real-agent-id-xyz", "/nonexistent/dir/for/test");
    expect(resolved).toBeNull();
  });
});

describe("buildTokenRequestForm", () => {
  test("shape matches RFC 7523 client_credentials + RFC 8707 resource (oauth#162's request-side scope)", () => {
    const form = buildTokenRequestForm({
      clientId: CLIENT_ID,
      assertion: "header.payload.signature",
      resource: "https://flair.example.com/mcp",
    });
    expect(form).toEqual({
      grant_type: "client_credentials",
      client_assertion_type: CLIENT_ASSERTION_TYPE_JWT_BEARER,
      client_assertion: "header.payload.signature",
      client_id: CLIENT_ID,
      resource: "https://flair.example.com/mcp",
    });
    expect(form.client_assertion_type).toBe("urn:ietf:params:oauth:client-assertion-type:jwt-bearer");
  });

  test("resource is omitted when not provided (oauth#162: pass-through only, this module never invents a default)", () => {
    const form = buildTokenRequestForm({ clientId: CLIENT_ID, assertion: "a.b.c" });
    expect(form.resource).toBeUndefined();
    expect("resource" in form).toBe(false);
  });

  test("oauth#162: client_id in the form equals the assertion's iss/sub when built from the same signClientAssertion call", () => {
    const { privateKey } = makeKeyPair();
    const { assertion, claims } = signClientAssertion({ clientId: CLIENT_ID, tokenEndpoint: TOKEN_ENDPOINT, privateKey });
    const form = buildTokenRequestForm({ clientId: CLIENT_ID, assertion, resource: "https://flair.example.com/mcp" });

    expect(form.client_id).toBe(claims.iss);
    expect(form.client_id).toBe(claims.sub);
    expect(form.client_assertion).toBe(assertion);
  });
});

// ─── requestMcpAccessToken / getMcpAccessToken — live round trip ───────────
//
// A local node:http server stands in for the token endpoint, shaped exactly
// like @harperfast/oauth@2.2.0's published `/oauth/mcp/token` responses
// (verified against node_modules/@harperfast/oauth/dist/lib/mcp/token.js:
// 200 `{access_token, token_type, expires_in}`; non-2xx OAuth error objects
// `{error, error_description}`; `429 {"error":"slow_down"}` with a
// `Retry-After` header on the issuance rate limit, #171/#163). This proves
// the CLIENT's real fetch/parse/retry logic against real HTTP, not a mocked
// fetch function — sleep/random are injected only to keep 429-retry tests
// fast and deterministic (no real waiting).

type TokenHandler = (req: IncomingMessage, res: ServerResponse, body: string) => void;

async function startTokenServer(handler: TokenHandler): Promise<{ url: string; server: Server; requests: string[] }> {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      requests.push(body);
      handler(req, res, body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { url: `http://127.0.0.1:${port}/oauth/mcp/token`, server, requests };
}

function jsonResponse(res: ServerResponse, status: number, body: unknown, headers?: Record<string, string>) {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

let activeServer: Server | undefined;
afterEach(async () => {
  if (activeServer) {
    await new Promise<void>((resolve) => activeServer!.close(() => resolve()));
    activeServer = undefined;
  }
  clearMcpAccessTokenCache();
});

describe("requestMcpAccessToken — live round trip against a 2.2.0-shaped token endpoint", () => {
  test("mints a token from a 200 response, POSTing the exact form oauth#162 (shipped 2.2.0) expects", async () => {
    const { url, server, requests } = await startTokenServer((req, res) => {
      expect(req.method).toBe("POST");
      expect(req.headers["content-type"]).toBe("application/x-www-form-urlencoded");
      jsonResponse(res, 200, { access_token: "tok_abc123", token_type: "Bearer", expires_in: 300, scope: "memory:read" });
    });
    activeServer = server;

    const { privateKey } = generateKeyPairSync("ed25519");
    const { assertion } = signClientAssertion({ clientId: CLIENT_ID, tokenEndpoint: url, privateKey });
    const form = buildTokenRequestForm({ clientId: CLIENT_ID, assertion, resource: "https://flair.example.com/mcp" });

    const before = Date.now();
    const token = await requestMcpAccessToken(form, url);
    expect(token.accessToken).toBe("tok_abc123");
    expect(token.tokenType).toBe("Bearer");
    expect(token.expiresIn).toBe(300);
    expect(token.scope).toBe("memory:read");
    expect(token.mintedAtMs).toBeGreaterThanOrEqual(before);
    expect(token.expiresAtMs).toBe(token.mintedAtMs + 300_000);

    expect(requests.length).toBe(1);
    const sent = new URLSearchParams(requests[0]);
    expect(sent.get("grant_type")).toBe("client_credentials");
    expect(sent.get("client_assertion_type")).toBe(CLIENT_ASSERTION_TYPE_JWT_BEARER);
    expect(sent.get("client_assertion")).toBe(assertion);
    expect(sent.get("client_id")).toBe(CLIENT_ID);
    expect(sent.get("resource")).toBe("https://flair.example.com/mcp");
  });

  test("defaults expires_in to 300s (the plugin's client_credentials default) when the response omits it", async () => {
    const { url, server } = await startTokenServer((_req, res) => {
      jsonResponse(res, 200, { access_token: "tok_no_ttl", token_type: "Bearer" });
    });
    activeServer = server;
    const form = buildTokenRequestForm({ clientId: CLIENT_ID, assertion: "a.b.c" });
    const token = await requestMcpAccessToken(form, url);
    expect(token.expiresIn).toBe(300);
  });

  test("throws McpTokenRequestError on a 401 invalid_client response, preserving status + error code", async () => {
    const { url, server } = await startTokenServer((_req, res) => {
      jsonResponse(res, 401, { error: "invalid_client", error_description: "client_assertion verification failed: signature invalid" });
    });
    activeServer = server;
    const form = buildTokenRequestForm({ clientId: CLIENT_ID, assertion: "a.b.c" });
    await expect(requestMcpAccessToken(form, url)).rejects.toThrow(McpTokenRequestError);
    try {
      await requestMcpAccessToken(form, url);
      throw new Error("expected rejection");
    } catch (err) {
      expect(err).toBeInstanceOf(McpTokenRequestError);
      expect((err as McpTokenRequestError).status).toBe(401);
      expect((err as McpTokenRequestError).error).toBe("invalid_client");
    }
  });

  test("throws on a non-JSON response body", async () => {
    const { url, server } = await startTokenServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("not json");
    });
    activeServer = server;
    const form = buildTokenRequestForm({ clientId: CLIENT_ID, assertion: "a.b.c" });
    await expect(requestMcpAccessToken(form, url)).rejects.toThrow(McpTokenRequestError);
  });

  test("429 slow_down: honors Retry-After with jittered backoff, then succeeds on retry", async () => {
    let calls = 0;
    const { url, server } = await startTokenServer((_req, res) => {
      calls++;
      if (calls === 1) {
        jsonResponse(res, 429, { error: "slow_down" }, { "Retry-After": "2" });
        return;
      }
      jsonResponse(res, 200, { access_token: "tok_after_retry", token_type: "Bearer", expires_in: 300 });
    });
    activeServer = server;

    const sleepCalls: number[] = [];
    const form = buildTokenRequestForm({ clientId: CLIENT_ID, assertion: "a.b.c" });
    const token = await requestMcpAccessToken(form, url, {
      sleep: async (ms) => {
        sleepCalls.push(ms);
      },
      random: () => 0.5, // full-jitter: sleep = round(0.5 * retryAfterMs)
    });

    expect(token.accessToken).toBe("tok_after_retry");
    expect(calls).toBe(2);
    expect(sleepCalls.length).toBe(1);
    // Retry-After: 2s -> baseMs 2000 -> jittered with random()=0.5 -> 1000ms.
    expect(sleepCalls[0]).toBe(1000);
  });

  test("429 without Retry-After falls back to exponential backoff, never hammering", async () => {
    let calls = 0;
    const { url, server } = await startTokenServer((_req, res) => {
      calls++;
      jsonResponse(res, 429, { error: "slow_down" }); // no Retry-After header
    });
    activeServer = server;

    const sleepCalls: number[] = [];
    const form = buildTokenRequestForm({ clientId: CLIENT_ID, assertion: "a.b.c" });
    await expect(
      requestMcpAccessToken(form, url, {
        maxRetries: 2,
        sleep: async (ms) => {
          sleepCalls.push(ms);
        },
        random: () => 1, // upper bound of the jitter range
      }),
    ).rejects.toThrow(McpTokenRequestError);

    expect(calls).toBe(3); // initial + 2 retries
    expect(sleepCalls.length).toBe(2);
    // Fallback base doubles per attempt: 1000ms, then 2000ms (random()=1 -> full base).
    expect(sleepCalls[0]).toBe(1000);
    expect(sleepCalls[1]).toBe(2000);
  });

  test("gives up after maxRetries consecutive 429s and throws McpTokenRequestError(429)", async () => {
    let calls = 0;
    const { url, server } = await startTokenServer((_req, res) => {
      calls++;
      jsonResponse(res, 429, { error: "slow_down" }, { "Retry-After": "0" });
    });
    activeServer = server;
    const form = buildTokenRequestForm({ clientId: CLIENT_ID, assertion: "a.b.c" });
    try {
      await requestMcpAccessToken(form, url, { maxRetries: 1, sleep: async () => {}, random: () => 0 });
      throw new Error("expected rejection");
    } catch (err) {
      expect(err).toBeInstanceOf(McpTokenRequestError);
      expect((err as McpTokenRequestError).status).toBe(429);
      expect((err as McpTokenRequestError).error).toBe("slow_down");
    }
    expect(calls).toBe(2); // initial + 1 retry, then gives up
  });
});

describe("getMcpAccessToken — token caching (consumer requirement: mint sparingly)", () => {
  test("mints once and reuses the cached token for a second call with the same clientId/tokenEndpoint/resource", async () => {
    let mintCount = 0;
    const { url, server } = await startTokenServer((_req, res) => {
      mintCount++;
      jsonResponse(res, 200, { access_token: `tok_${mintCount}`, token_type: "Bearer", expires_in: 300 });
    });
    activeServer = server;
    const { privateKey } = generateKeyPairSync("ed25519");

    const first = await getMcpAccessToken({ clientId: CLIENT_ID, tokenEndpoint: url, privateKey, resource: "https://flair.example.com/mcp" });
    const second = await getMcpAccessToken({ clientId: CLIENT_ID, tokenEndpoint: url, privateKey, resource: "https://flair.example.com/mcp" });

    expect(mintCount).toBe(1);
    expect(second.accessToken).toBe(first.accessToken);
  });

  test("re-mints when the cached token is within the refresh margin of expiry", async () => {
    let mintCount = 0;
    const { url, server } = await startTokenServer((_req, res) => {
      mintCount++;
      jsonResponse(res, 200, { access_token: `tok_${mintCount}`, token_type: "Bearer", expires_in: 300 });
    });
    activeServer = server;
    const { privateKey } = generateKeyPairSync("ed25519");

    let now = 1_000_000;
    const first = await getMcpAccessToken({
      clientId: CLIENT_ID,
      tokenEndpoint: url,
      privateKey,
      refreshMarginMs: 30_000,
      now: () => now,
    });
    // Advance to inside the 30s refresh margin (300s TTL - 29s elapsed = 271s left).
    now += 271_000;
    const second = await getMcpAccessToken({
      clientId: CLIENT_ID,
      tokenEndpoint: url,
      privateKey,
      refreshMarginMs: 30_000,
      now: () => now,
    });

    expect(mintCount).toBe(2);
    expect(second.accessToken).not.toBe(first.accessToken);
  });

  test("forceRefresh mints unconditionally even when the cache is fresh", async () => {
    let mintCount = 0;
    const { url, server } = await startTokenServer((_req, res) => {
      mintCount++;
      jsonResponse(res, 200, { access_token: `tok_${mintCount}`, token_type: "Bearer", expires_in: 300 });
    });
    activeServer = server;
    const { privateKey } = generateKeyPairSync("ed25519");

    await getMcpAccessToken({ clientId: CLIENT_ID, tokenEndpoint: url, privateKey });
    await getMcpAccessToken({ clientId: CLIENT_ID, tokenEndpoint: url, privateKey, forceRefresh: true });

    expect(mintCount).toBe(2);
  });

  test("caches separately per resource — a token minted for one resource never serves another", async () => {
    let mintCount = 0;
    const { url, server } = await startTokenServer((_req, res) => {
      mintCount++;
      jsonResponse(res, 200, { access_token: `tok_${mintCount}`, token_type: "Bearer", expires_in: 300 });
    });
    activeServer = server;
    const { privateKey } = generateKeyPairSync("ed25519");

    await getMcpAccessToken({ clientId: CLIENT_ID, tokenEndpoint: url, privateKey, resource: "https://flair.example.com/mcp" });
    await getMcpAccessToken({ clientId: CLIENT_ID, tokenEndpoint: url, privateKey, resource: "https://other.example.com/mcp" });

    expect(mintCount).toBe(2);
  });
});

describe("default*() env-driven helpers", () => {
  const keys = ["FLAIR_MCP_ISSUER", "FLAIR_PUBLIC_URL"] as const;
  const saved: Record<string, string | undefined> = {};
  for (const k of keys) saved[k] = process.env[k];

  function clearEnv() {
    for (const k of keys) delete process.env[k];
  }
  function restoreEnv() {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }

  test("all undefined when no issuer is configured", () => {
    clearEnv();
    expect(defaultMcpIssuer()).toBeUndefined();
    expect(defaultMcpResource()).toBeUndefined();
    expect(defaultMcpTokenEndpoint()).toBeUndefined();
    expect(defaultMcpClientId("flint")).toBeUndefined();
    restoreEnv();
  });

  test("derive from FLAIR_MCP_ISSUER, matching MCPClientMetadata.ts + wellKnown.ts paths", () => {
    clearEnv();
    process.env.FLAIR_MCP_ISSUER = "https://flair.example.com/";
    expect(defaultMcpIssuer()).toBe("https://flair.example.com/");
    expect(defaultMcpResource()).toBe("https://flair.example.com/mcp");
    expect(defaultMcpTokenEndpoint()).toBe("https://flair.example.com/oauth/mcp/token");
    expect(defaultMcpClientId("flint")).toBe("https://flair.example.com/MCPClientMetadata/flint");
    restoreEnv();
  });

  test("falls back to FLAIR_PUBLIC_URL when FLAIR_MCP_ISSUER is unset", () => {
    clearEnv();
    process.env.FLAIR_PUBLIC_URL = "https://public.example.com";
    expect(defaultMcpIssuer()).toBe("https://public.example.com");
    restoreEnv();
  });
});
