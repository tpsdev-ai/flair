/**
 * Proves our production code interoperates with the REAL, PUBLISHED
 * @harperfast/oauth@2.2.0 package — not a mirror, not a guess. Deep-imports
 * the plugin's own compiled modules directly from `node_modules` rather than
 * `import "@harperfast/oauth"`: the package's `exports` map only surfaces
 * `.` (the top-level plugin entry) and `./config`, but `clientAssertion.js`,
 * `cimd.js`, and `rateLimit.js` each export additional, underscore-prefixed
 * functions explicitly documented `@internal` / "for testing" (see their own
 * JSDoc) that simply aren't re-exported at the package boundary. A relative
 * filesystem import reaches them directly — Node's and Bun's package
 * `exports` enforcement only restricts BARE-SPECIFIER resolution through the
 * package boundary, not an explicit path into `node_modules` (verified: a
 * bare `import("@harperfast/oauth/dist/lib/mcp/cimd.js")` throws
 * `ERR_PACKAGE_PATH_NOT_EXPORTED` under both Node and Bun; the relative path
 * used below does not). This is the plugin's OWN sanctioned test-injection
 * surface, used here exactly as intended.
 *
 * ── process-boundary caveat (read before extending this file) ─────────────
 * This works because this test and the imported plugin code run in the SAME
 * process, sharing the SAME module registry. A `startHarper()`-spawned child
 * process does NOT share this test process's module state — empirically
 * confirmed while building this test (a `resolveClient` call made from a
 * Harper JS-resource in the spawned child, deep-importing `cimd.js` the same
 * way, saw its OWN `_setDnsLookup`/`_setFetch` overrides take effect for
 * ITS OWN calls, but NOT for the calls the `@harperfast/oauth` plugin's own
 * `/oauth/mcp/token` route makes internally — Harper's component loader
 * gives each `package:`-declared component (flair's own `jsResource`-loaded
 * resources vs. the sibling `'@harperfast/oauth': {package: ...}` component)
 * its own isolated module graph, even within one process/thread). Combined
 * with the plugin's UNCONDITIONAL SSRF gate on CIMD document fetches (no
 * loopback/private-IP exception — confirmed by reading
 * `node_modules/@harperfast/oauth/dist/lib/mcp/cimd.js`'s `isPrivateIpv4`/
 * `isPrivateIpv6`; contrast with `mcp.issuer`'s explicit loopback carve-out
 * in `dist/index.js`, which has no analog here), this is why a fully-live
 * network round trip through `/oauth/mcp/token` cannot be forced further
 * inside an ephemeral, network-isolated local Harper. See
 * `test/integration/mcp-client-credentials-e2e.test.ts` for what IS provable
 * live, and `docs/notes/mcp-agent-auth-consumer.md` for the full writeup.
 *
 * What THIS file proves instead, against the real plugin code, in-process:
 *   1. `signClientAssertion`'s output is accepted by the plugin's REAL
 *      `verifyClientAssertion` (not the mirror in mcp-client-assertion.test.ts).
 *   2. `buildCimdDocument`'s output resolves through the plugin's REAL
 *      SSRF-guarded `resolveCimdClient` (network transport substituted via
 *      its own `_setDnsLookup`/`_setFetch` hooks — nothing about the
 *      validation/shape logic is mocked).
 *   3. The plugin's REAL `createRateLimiter` algorithm drives our shipped
 *      `requestMcpAccessToken`'s 429/Retry-After handling.
 *   4. Post-auth-debit ordering (#171/#163: a forged assertion must never
 *      drain the rate bucket) — proved by composing the REAL
 *      `verifyClientAssertion` + REAL `createRateLimiter` in the SAME order
 *      `token.js`'s `handleClientCredentialsGrant` uses (verify, THEN rate
 *      limit — confirmed by reading that function's source).
 */
import { describe, test, expect, afterEach } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { createServer, type Server } from "node:http";
import { signClientAssertion, publicJwkFromPrivateKey, requestMcpAccessToken, buildTokenRequestForm } from "../../src/mcp-client-assertion";
import { buildCimdDocument } from "../../resources/mcp-client-metadata-fields";

// Deep imports of @harperfast/oauth@2.2.0's internals — see module header.
import { verifyClientAssertion } from "../../node_modules/@harperfast/oauth/dist/lib/mcp/clientAssertion.js";
import {
  resolveCimdClient,
  isCimdClientId,
  _setDnsLookup,
  _setFetch,
  _clearCimdCache,
  CimdClientError,
} from "../../node_modules/@harperfast/oauth/dist/lib/mcp/cimd.js";
import { createRateLimiter } from "../../node_modules/@harperfast/oauth/dist/lib/mcp/rateLimit.js";

const CLIENT_HOST = "cimd-test.flair.example";
const TOKEN_ENDPOINT = `https://${CLIENT_HOST}/oauth/mcp/token`;
const CLIENT_ID = `https://${CLIENT_HOST}/MCPClientMetadata/flint`;

afterEach(() => {
  _clearCimdCache();
  _setDnsLookup(undefined as any);
  _setFetch(undefined as any);
});

describe("signClientAssertion vs the REAL published verifyClientAssertion", () => {
  test("an assertion this module signs is accepted by the plugin's real verifier", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const jwk = publicJwkFromPrivateKey(privateKey);
    const { assertion } = signClientAssertion({ clientId: CLIENT_ID, tokenEndpoint: TOKEN_ENDPOINT, privateKey });

    const result = verifyClientAssertion({ assertion, clientId: CLIENT_ID, tokenEndpoint: TOKEN_ENDPOINT, jwks: [jwk] });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.claims.iss).toBe(CLIENT_ID);
      expect(result.claims.aud).toBe(TOKEN_ENDPOINT);
    }
  });

  test("SECURITY: an assertion signed with the WRONG key is rejected by the real verifier", () => {
    const { privateKey: real } = generateKeyPairSync("ed25519");
    const { privateKey: attacker } = generateKeyPairSync("ed25519");
    const jwk = publicJwkFromPrivateKey(real);
    const { assertion } = signClientAssertion({ clientId: CLIENT_ID, tokenEndpoint: TOKEN_ENDPOINT, privateKey: attacker });

    const result = verifyClientAssertion({ assertion, clientId: CLIENT_ID, tokenEndpoint: TOKEN_ENDPOINT, jwks: [jwk] });
    expect(result.valid).toBe(false);
  });

  test("SECURITY: a tampered claims payload fails the real verifier's signature check", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const jwk = publicJwkFromPrivateKey(privateKey);
    const { assertion } = signClientAssertion({ clientId: CLIENT_ID, tokenEndpoint: TOKEN_ENDPOINT, privateKey });
    const [h, p, s] = assertion.split(".");
    const claims = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
    const tampered = `${h}.${Buffer.from(JSON.stringify({ ...claims, sub: "https://attacker.example/evil" })).toString("base64url")}.${s}`;

    const result = verifyClientAssertion({ assertion: tampered, clientId: CLIENT_ID, tokenEndpoint: TOKEN_ENDPOINT, jwks: [jwk] });
    expect(result.valid).toBe(false);
  });
});

describe("buildCimdDocument vs the REAL published resolveCimdClient", () => {
  test("our published CIMD document resolves through the plugin's real SSRF-guarded fetch+validate pipeline", async () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const jwk = publicJwkFromPrivateKey(privateKey);
    const doc = buildCimdDocument({ clientId: CLIENT_ID, clientName: "flint", jwk });

    expect(isCimdClientId(CLIENT_ID)).toBe(true);

    _setDnsLookup(async () => [{ address: "8.8.8.8", family: 4 }]); // any global-unicast address; the transport is fully substituted below
    _setFetch(async (urlStr: string) => {
      expect(urlStr).toBe(CLIENT_ID); // proves the resolver fetches EXACTLY our served document's URL
      return {
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        body: new Response(JSON.stringify(doc)).body,
      };
    });

    const resolved: any = await resolveCimdClient(CLIENT_ID, { allowedHosts: [CLIENT_HOST] });
    expect(resolved._cimd).toBe(true);
    expect(resolved.grant_types).toEqual(["client_credentials"]);
    expect(resolved.token_endpoint_auth_method).toBe("private_key_jwt");
    expect(resolved.jwks.keys).toHaveLength(1);
    expect(resolved.jwks.keys[0].x).toBe(jwk.x);
  });

  test("negative: allowedHosts not configured — the real validator rejects our document even though it fetched fine (#161's fail-closed gate)", async () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const jwk = publicJwkFromPrivateKey(privateKey);
    const doc = buildCimdDocument({ clientId: CLIENT_ID, clientName: "flint", jwk });

    _setDnsLookup(async () => [{ address: "8.8.8.8", family: 4 }]);
    _setFetch(async () => ({
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      body: new Response(JSON.stringify(doc)).body,
    }));

    await expect(resolveCimdClient(CLIENT_ID, {})).rejects.toThrow(CimdClientError);
  });

  test("negative: a document carrying leaked private key material ('d') is rejected by the real validator, even bypassing our own build-time guard", async () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const jwk = publicJwkFromPrivateKey(privateKey) as any;
    // Constructed by hand — NOT through buildCimdDocument, which already
    // refuses to build this (see mcp-client-metadata-fields.ts). This proves
    // the plugin's OWN validator is the real defense-in-depth layer, not
    // just our client-side guard.
    const malformedDoc = {
      client_id: CLIENT_ID,
      client_name: "flint",
      jwks: { keys: [{ ...jwk, d: "leaked-private-scalar" }] },
      token_endpoint_auth_method: "private_key_jwt",
      grant_types: ["client_credentials"],
    };

    _setDnsLookup(async () => [{ address: "8.8.8.8", family: 4 }]);
    _setFetch(async () => ({
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      body: new Response(JSON.stringify(malformedDoc)).body,
    }));

    await expect(resolveCimdClient(CLIENT_ID, { allowedHosts: [CLIENT_HOST] })).rejects.toThrow(CimdClientError);
  });
});

describe("requestMcpAccessToken vs the REAL published createRateLimiter algorithm", () => {
  async function startServer(handler: (res: any) => void): Promise<{ url: string; server: Server }> {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => handler(res));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    return { url: `http://127.0.0.1:${port}/oauth/mcp/token`, server };
  }

  test("honors the exact Retry-After the real limiter computes, then succeeds once it refills", async () => {
    // Real algorithm (rateLimit.ts), capacity 1: pre-consume the only token,
    // then drive the limiter through a deterministic `now` sequence so the
    // client's FIRST attempt sees an exhausted bucket (429) and its RETRY
    // sees a refilled one (200) — no real time needs to pass.
    const nowSequence = [0, 0, 120_000]; // [pre-consume, 1st attempt, retry]
    let nowIdx = 0;
    const limiter = createRateLimiter({
      capacity: 1,
      refillPerMinute: 1,
      now: () => nowSequence[Math.min(nowIdx++, nowSequence.length - 1)],
    });
    limiter.tryTake(CLIENT_ID); // pre-consume at now=0

    const { url, server } = await startServer((res) => {
      const result = limiter.tryTake(CLIENT_ID);
      if (!result.allowed) {
        res.writeHead(429, { "Content-Type": "application/json", "Retry-After": String(result.retryAfterSeconds) });
        res.end(JSON.stringify({ error: "slow_down" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ access_token: "tok_after_refill", token_type: "Bearer", expires_in: 300 }));
    });

    try {
      const form = buildTokenRequestForm({ clientId: CLIENT_ID, assertion: "a.b.c" });
      const sleepCalls: number[] = [];
      const token = await requestMcpAccessToken(form, url, {
        sleep: async (ms) => {
          sleepCalls.push(ms);
        },
        random: () => 1,
      });
      expect(token.accessToken).toBe("tok_after_refill");
      expect(sleepCalls.length).toBe(1);
      // Real limiter's formula (capacity=1, refillPerMinute=1, deficit=1):
      // retryAfterSeconds = ceil(1 * 60 / 1) = 60.
      expect(sleepCalls[0]).toBe(60_000);
    } finally {
      server.close();
    }
  });

  test("post-auth-debit (#171/#163): a forged assertion never reaches the rate limiter, so it can't drain a real client's bucket", () => {
    // Composes the REAL verifyClientAssertion + REAL createRateLimiter in
    // the SAME order token.js's handleClientCredentialsGrant uses (read
    // directly from node_modules/@harperfast/oauth/dist/lib/mcp/token.js:
    // `result = verifyClientAssertion(...); if (!result.valid) return 401;
    // ...; const limit = getGrantLimiter(...).tryTake(clientId);`).
    function simulateGrant(assertion: string, jwks: unknown[], limiter: ReturnType<typeof createRateLimiter>) {
      const result = verifyClientAssertion({ assertion, clientId: CLIENT_ID, tokenEndpoint: TOKEN_ENDPOINT, jwks });
      if (!result.valid) return { minted: false, rateLimited: false };
      const limit = limiter.tryTake(CLIENT_ID);
      return { minted: limit.allowed, rateLimited: true };
    }

    const { privateKey: real } = generateKeyPairSync("ed25519");
    const { privateKey: attacker } = generateKeyPairSync("ed25519");
    const jwk = publicJwkFromPrivateKey(real);
    const limiter = createRateLimiter({ capacity: 1, refillPerMinute: 1 });

    // Flood with forged assertions (wrong signing key, claiming the real client_id).
    for (let i = 0; i < 5; i++) {
      const { assertion: forged } = signClientAssertion({ clientId: CLIENT_ID, tokenEndpoint: TOKEN_ENDPOINT, privateKey: attacker });
      const outcome = simulateGrant(forged, [jwk], limiter);
      expect(outcome.rateLimited).toBe(false); // never even reaches tryTake
    }

    // The legitimate client still has its full bucket — capacity=1 makes
    // this provable: if any forged attempt HAD drained it, this would 429.
    const { assertion: legit } = signClientAssertion({ clientId: CLIENT_ID, tokenEndpoint: TOKEN_ENDPOINT, privateKey: real });
    const outcome = simulateGrant(legit, [jwk], limiter);
    expect(outcome.rateLimited).toBe(true);
    expect(outcome.minted).toBe(true);
  });
});
