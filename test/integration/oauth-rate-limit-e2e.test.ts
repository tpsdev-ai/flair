// oauth-rate-limit-e2e.test.ts — the OAuth surface's rate limiter, driven over
// real HTTP against a real Harper spawn.
//
// A unit test of the counter proves the arithmetic. It does not prove the
// limiter is WIRED IN — that requests to a live instance are actually counted
// and actually rejected. That is what this file is for: real fetches, past the
// threshold, against a running server.
//
// Every limit assertion here is paired with a POSITIVE CONTROL. Asserting only
// that a 429 eventually arrives would pass against a limiter configured to
// reject everything, which is not a working limiter. So each case first shows
// the requests BELOW the threshold being served normally.
//
// MODEL: test/integration/oauth-authorize-authz.test.ts.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { randomUUID } from "node:crypto";
import { startHarper, stopHarper, HarperInstance } from "../helpers/harper-lifecycle";

const ALLOWED_REDIRECT_URI = "https://claude.com/api/mcp/auth_callback";

// Small enough to exhaust in a handful of requests. The window is 60s, so once a
// bucket is spent it STAYS spent for the rest of the file — the cases below are
// ordered to depend on that rather than fight it.
const OAUTH_LIMIT = 6;
const REGISTER_LIMIT = 3;

async function adminOp(harper: HarperInstance, op: Record<string, any>): Promise<Response> {
  return fetch(harper.opsURL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`),
    },
    body: JSON.stringify(op),
  });
}

/** POST a form-encoded body to /OAuthToken, the way a real OAuth client does. */
async function postToken(harper: HarperInstance, body: Record<string, string>, headers: Record<string, string> = {}) {
  const res = await fetch(`${harper.httpURL}/OAuthToken`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, text: await res.text(), retryAfter: res.headers.get("retry-after") };
}

let harper: HarperInstance;
const savedEnv: Record<string, string | undefined> = {};
const clientId = `flair_cl_ratelimit_${randomUUID()}`;
const validCode = `code_${randomUUID()}`;

describe("OAuth rate limiting (real Harper, real HTTP)", () => {
  beforeAll(async () => {
    // Set BEFORE the spawn — startHarper hands its own process.env to the child.
    for (const k of ["FLAIR_OAUTH_RATE_LIMIT", "FLAIR_OAUTH_REGISTER_RATE_LIMIT", "FLAIR_RATE_LIMIT", "FLAIR_TRUSTED_PROXY"]) {
      savedEnv[k] = process.env[k];
    }
    process.env.FLAIR_OAUTH_RATE_LIMIT = String(OAUTH_LIMIT);
    process.env.FLAIR_OAUTH_REGISTER_RATE_LIMIT = String(REGISTER_LIMIT);
    delete process.env.FLAIR_RATE_LIMIT;
    delete process.env.FLAIR_TRUSTED_PROXY;

    harper = await startHarper();

    // A registered client and a genuinely valid, unused authorization code.
    // Inserted through the admin ops API rather than run through the consent
    // flow: the point here is to have a credential that really does exchange for
    // a token, so "valid" and "garbage" can be compared once the bucket is spent.
    await adminOp(harper, {
      operation: "insert", database: "flair", table: "OAuthClient",
      records: [{
        id: clientId, name: "rate-limit test client",
        redirectUris: [ALLOWED_REDIRECT_URI],
        grantTypes: ["authorization_code", "refresh_token"],
        scope: "memory:read", registeredBy: "test",
        createdAt: new Date().toISOString(),
      }],
    });
    await adminOp(harper, {
      operation: "insert", database: "flair", table: "OAuthAuthCode",
      records: [{
        id: validCode, clientId, principalId: "admin",
        redirectUri: ALLOWED_REDIRECT_URI, scope: "memory:read",
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        used: false, createdAt: new Date().toISOString(),
      }],
    });
  }, 180_000);

  afterAll(async () => {
    if (harper) await stopHarper(harper);
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  // ── POSITIVE CONTROL ──────────────────────────────────────────────────────

  test("POSITIVE CONTROL: a genuinely valid authorization code still exchanges for a token", async () => {
    const res = await postToken(harper, {
      grant_type: "authorization_code", code: validCode, client_id: clientId,
      redirect_uri: ALLOWED_REDIRECT_URI,
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.text).access_token).toStartWith("flair_at_");
  });

  test("POSITIVE CONTROL: every request up to the limit is served, none is throttled", async () => {
    // One of the budget was spent above, so drive the remainder.
    for (let i = 1; i < OAUTH_LIMIT; i++) {
      const res = await postToken(harper, { grant_type: "authorization_code", code: "nope", client_id: clientId });
      expect(res.status).not.toBe(429);
      expect(res.status).toBe(400); // invalid_grant — the endpoint is working normally
    }
  });

  // ── THE LIMIT ─────────────────────────────────────────────────────────────

  test("the request past the limit is rejected with 429 and a Retry-After", async () => {
    const res = await postToken(harper, { grant_type: "authorization_code", code: "nope", client_id: clientId });
    expect(res.status).toBe(429);
    expect(Number(res.retryAfter)).toBeGreaterThanOrEqual(1);
    expect(JSON.parse(res.text).error).toBe("slow_down");
  });

  test("it STAYS limited — the counter is not reset by a further attempt", async () => {
    for (let i = 0; i < 3; i++) {
      expect((await postToken(harper, { grant_type: "refresh_token", refresh_token: "x" })).status).toBe(429);
    }
  });

  // ── NO ENUMERATION ORACLE ────────────────────────────────────────────────

  test("once limited, a VALID credential and a garbage one are byte-identical", async () => {
    // The whole point of consuming the counter before evaluating the credential.
    // If the limiter only counted failures, a valid credential would slip past a
    // spent bucket and "did I get a 429" would answer "was that credential
    // good" — a cleaner oracle than the 400 the endpoint already returns.
    const good = await postToken(harper, {
      grant_type: "authorization_code", code: validCode, client_id: clientId,
      redirect_uri: ALLOWED_REDIRECT_URI,
    });
    const bad = await postToken(harper, {
      grant_type: "authorization_code", code: "definitely-not-a-real-code", client_id: "flair_cl_nope",
      redirect_uri: ALLOWED_REDIRECT_URI,
    });
    expect(good.status).toBe(429);
    expect(bad.status).toBe(429);
    expect(good.text).toBe(bad.text);
  });

  test("an unsupported grant type is limited identically — the grant is never read", async () => {
    const res = await postToken(harper, { grant_type: "totally_made_up" });
    expect(res.status).toBe(429);
  });

  test("the 429 body echoes nothing back to the caller", async () => {
    const res = await postToken(harper, { grant_type: "authorization_code", code: "abc", client_id: "sentinel-client-id" });
    expect(res.text).not.toContain("sentinel-client-id");
    expect(res.text).not.toContain("authorization_code");
    expect(res.text).not.toContain("127.0.0.1");
  });

  test("X-Forwarded-For does NOT buy a fresh bucket when no proxy is trusted", async () => {
    // FLAIR_TRUSTED_PROXY is unset for this instance, so the header is ignored
    // entirely. If it were honoured by default, this limiter would be
    // bypassable by anyone willing to vary a header.
    for (const spoof of ["1.2.3.4", "5.6.7.8", "9.10.11.12"]) {
      const res = await postToken(harper, { grant_type: "refresh_token", refresh_token: "x" }, { "x-forwarded-for": spoof });
      expect(res.status).toBe(429);
    }
  });

  // ── BLAST RADIUS ─────────────────────────────────────────────────────────

  test("registration has its OWN budget — it still works while the token bucket is spent", async () => {
    const res = await fetch(`${harper.httpURL}/OAuthRegister`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "separate bucket", redirect_uris: [ALLOWED_REDIRECT_URI] }),
    });
    expect(res.status).not.toBe(429);
    expect((await res.json() as any).client_id).toStartWith("flair_cl_");
  });

  test("registration is limited on its own, tighter budget", async () => {
    let sawLimit = false;
    for (let i = 0; i < REGISTER_LIMIT + 2; i++) {
      const res = await fetch(`${harper.httpURL}/OAuthRegister`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_name: `flood ${i}`, redirect_uris: [ALLOWED_REDIRECT_URI] }),
      });
      if (res.status === 429) sawLimit = true;
      await res.text();
    }
    expect(sawLimit).toBe(true);
  });

  test("UNTHROTTLED PATHS ARE UNTOUCHED: /Health still answers with both OAuth buckets spent", async () => {
    for (let i = 0; i < 10; i++) {
      const res = await fetch(`${harper.httpURL}/Health`);
      expect(res.status).toBe(200);
      await res.text();
    }
  });

  test("UNTHROTTLED PATHS ARE UNTOUCHED: discovery still answers", async () => {
    for (let i = 0; i < 10; i++) {
      const res = await fetch(`${harper.httpURL}/.well-known/oauth-authorization-server`);
      expect(res.status).toBe(200);
      await res.text();
    }
  });

  test("UNTHROTTLED PATHS ARE UNTOUCHED: an ordinary resource path is not rate limited", async () => {
    // /Memory denies an anonymous caller — the point is that it denies for the
    // usual reason and never with a 429.
    for (let i = 0; i < 10; i++) {
      const res = await fetch(`${harper.httpURL}/Memory`);
      expect(res.status).not.toBe(429);
      await res.text();
    }
  });
});

// ─── Keying, proven over real HTTP ──────────────────────────────────────────

describe("OAuth rate limiting keys per caller (trusted-proxy mode, real Harper)", () => {
  let proxied: HarperInstance;
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    for (const k of ["FLAIR_OAUTH_RATE_LIMIT", "FLAIR_TRUSTED_PROXY"]) saved[k] = process.env[k];
    process.env.FLAIR_OAUTH_RATE_LIMIT = String(OAUTH_LIMIT);
    process.env.FLAIR_TRUSTED_PROXY = "1";
    proxied = await startHarper();
  }, 180_000);

  afterAll(async () => {
    if (proxied) await stopHarper(proxied);
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test("one caller's exhausted budget does not limit a DIFFERENT caller", async () => {
    // With one trusted hop the rightmost X-Forwarded-For entry is the key, so
    // two values are two callers. This is the assertion that shows the limiter
    // keys per caller over real HTTP rather than throttling globally.
    for (let i = 0; i <= OAUTH_LIMIT; i++) {
      await postToken(proxied, { grant_type: "refresh_token", refresh_token: "x" }, { "x-forwarded-for": "203.0.113.10" });
    }
    const first = await postToken(proxied, { grant_type: "refresh_token", refresh_token: "x" }, { "x-forwarded-for": "203.0.113.10" });
    expect(first.status).toBe(429);

    // POSITIVE CONTROL for the keying: a different caller is unaffected.
    const second = await postToken(proxied, { grant_type: "refresh_token", refresh_token: "x" }, { "x-forwarded-for": "198.51.100.20" });
    expect(second.status).not.toBe(429);
    expect(second.status).toBe(400);
  });

  test("SPOOF RESISTANCE: prepending an attacker-chosen entry does not buy a fresh bucket", async () => {
    // The trusted proxy appends what it saw, so the RIGHTMOST entry is the one
    // written by the trusted hop. Keying on the leftmost — the entry the caller
    // controls — is the classic way this control is made useless.
    const res = await postToken(
      proxied,
      { grant_type: "refresh_token", refresh_token: "x" },
      { "x-forwarded-for": "9.9.9.9, 203.0.113.10" },
    );
    expect(res.status).toBe(429);
  });
});
