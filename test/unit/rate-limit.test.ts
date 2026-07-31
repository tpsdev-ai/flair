// rate-limit.test.ts — resources/rate-limit.ts.
//
// The counter itself is pure and process-local, so it is unit-testable end to
// end. What a unit test CANNOT show is that the limiter is wired into a running
// instance and actually rejects real traffic — that is
// test/integration/oauth-rate-limit-e2e.test.ts's job, driving real HTTP past
// the threshold against a real Harper spawn.
//
// EVERY limit case here carries a POSITIVE CONTROL: the requests below the
// threshold are asserted to be ALLOWED, not just the one above it asserted to be
// rejected. A test that only checks for the 429 passes with the limit set to
// zero, which is a broken limiter, not a working one.
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  consume,
  policyFor,
  policyForPath,
  callerKey,
  checkHttpRateLimit,
  checkMcpRateLimit,
  envLimit,
  rateLimitEnabled,
  trustedProxyHops,
  limitedResponse,
  LIMITED_BODY,
  UNKNOWN_CALLER,
  MAX_TRACKED_KEYS,
  __resetBucketsForTest,
  __resetWarningsForTest,
  __trackedKeyCountForTest,
} from "../../resources/rate-limit.ts";

// bun runs every test file in ONE process, so both the bucket Map and the
// one-shot warning set are shared state. Reset them per case, and restore any
// env var touched so a later FILE doesn't inherit it.
const TOUCHED = [
  "FLAIR_RATE_LIMIT",
  "FLAIR_OAUTH_RATE_LIMIT",
  "FLAIR_OAUTH_REGISTER_RATE_LIMIT",
  "FLAIR_MCP_RATE_LIMIT",
  "FLAIR_TRUSTED_PROXY",
];
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  __resetBucketsForTest();
  __resetWarningsForTest();
  saved = {};
  for (const k of TOUCHED) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of TOUCHED) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

/** A request stub shaped like Harper's: `.ip` plus a Headers-ish `.get`. */
function req(ip: string | undefined, headers: Record<string, string> = {}): any {
  return {
    ip,
    headers: { get: (n: string) => headers[n.toLowerCase()] ?? null, asObject: headers },
  };
}

// ─── The counter ────────────────────────────────────────────────────────────

describe("consume", () => {
  const policy = { bucket: "t", limit: 3, windowMs: 1000 };

  test("POSITIVE CONTROL: every request up to the limit is allowed", () => {
    for (let i = 1; i <= policy.limit; i++) {
      expect(consume("k", policy, 1000).limited).toBe(false);
    }
  });

  test("the request AFTER the limit is rejected", () => {
    for (let i = 1; i <= policy.limit; i++) consume("k", policy, 1000);
    expect(consume("k", policy, 1000).limited).toBe(true);
  });

  test("stays rejected while the window holds, then allows again once it rolls", () => {
    for (let i = 1; i <= policy.limit + 2; i++) consume("k", policy, 1000);
    expect(consume("k", policy, 1500).limited).toBe(true);
    // A fresh window starts at windowMs after the first request.
    expect(consume("k", policy, 2000).limited).toBe(false);
  });

  test("distinct keys have independent budgets", () => {
    for (let i = 1; i <= policy.limit + 1; i++) consume("a", policy, 1000);
    expect(consume("a", policy, 1000).limited).toBe(true);
    expect(consume("b", policy, 1000).limited).toBe(false);
  });

  test("retryAfterSec counts down within the window and is never 0", () => {
    const first = consume("k", policy, 1000);
    expect(first.retryAfterSec).toBe(1);
    const late = consume("k", policy, 1999);
    expect(late.retryAfterSec).toBeGreaterThanOrEqual(1);
  });

  test("bounded memory: tracked keys never exceed the cap, and the HOT key survives eviction", () => {
    const hot = { bucket: "t", limit: 5, windowMs: 60_000 };
    // Put the hot key over its limit first.
    for (let i = 0; i < 6; i++) consume("hot", hot, 1000);
    expect(consume("hot", hot, 1000).limited).toBe(true);

    // Now flood with distinct keys, touching the hot key as we go so it stays
    // most-recently-used. This is the shape of the attack the cap exists for:
    // a caller rotating source addresses to grow the Map without bound.
    for (let i = 0; i < MAX_TRACKED_KEYS + 500; i++) {
      consume(`flood-${i}`, hot, 1000);
      if (i % 100 === 0) consume("hot", hot, 1000);
    }

    expect(__trackedKeyCountForTest()).toBeLessThanOrEqual(MAX_TRACKED_KEYS);
    // LRU, not first-seen: the key being hammered is the last thing evicted, so
    // it is still limited rather than handed a fresh budget.
    expect(consume("hot", hot, 1000).limited).toBe(true);
  });
});

// ─── Which paths are throttled ──────────────────────────────────────────────

describe("policyForPath", () => {
  test("covers the four OAuth endpoints", () => {
    for (const p of ["/OAuthToken", "/OAuthAuthorize", "/OAuthRevoke", "/OAuthRegister"]) {
      expect(policyForPath(p)).not.toBeNull();
    }
  });

  test("registration has its own, tighter policy than the rest of the OAuth surface", () => {
    const reg = policyForPath("/OAuthRegister")!;
    const tok = policyForPath("/OAuthToken")!;
    expect(reg.bucket).not.toBe(tok.bucket);
    expect(reg.limit).toBeLessThan(tok.limit);
  });

  test("throttles NOTHING else — the agent surface and discovery are untouched", () => {
    for (const p of [
      "/Memory", "/Memory/abc", "/Presence", "/FederationSync", "/FederationPair",
      "/Health", "/OAuthMetadata", "/.well-known/oauth-authorization-server",
      "/.well-known/oauth-protected-resource", "/mcp", "/Admin", "/SemanticSearch",
    ]) {
      expect(policyForPath(p)).toBeNull();
    }
  });

  test("matching is exact — a lookalike prefix is not throttled by accident", () => {
    expect(policyForPath("/OAuthTokenSomethingElse")).toBeNull();
    expect(policyForPath("/OAuthToken/")).toBeNull();
  });
});

// ─── Caller identity ────────────────────────────────────────────────────────

describe("callerKey", () => {
  test("uses the socket peer address by default", () => {
    expect(callerKey(req("203.0.113.7"))).toBe("addr:203.0.113.7");
  });

  test("SPOOF RESISTANCE: X-Forwarded-For is ignored entirely when no proxy is trusted", () => {
    const key = callerKey(req("203.0.113.7", { "x-forwarded-for": "10.0.0.1" }));
    expect(key).toBe("addr:203.0.113.7");
    expect(key).not.toContain("10.0.0.1");
  });

  test("SPOOF RESISTANCE: with one trusted hop it takes the RIGHTMOST entry, never the caller-supplied left one", () => {
    process.env.FLAIR_TRUSTED_PROXY = "1";
    // A caller sent "1.1.1.1"; the trusted proxy appended the address it actually
    // saw. Keying on the left entry would let anyone mint a fresh bucket per
    // request just by varying a header.
    const key = callerKey(req("127.0.0.1", { "x-forwarded-for": "1.1.1.1, 203.0.113.7" }));
    expect(key).toBe("xff:203.0.113.7");
    expect(key).not.toContain("1.1.1.1");
  });

  test("with two trusted hops it takes the entry two from the right", () => {
    process.env.FLAIR_TRUSTED_PROXY = "2";
    expect(callerKey(req("127.0.0.1", { "x-forwarded-for": "1.1.1.1, 203.0.113.7, 10.0.0.9" })))
      .toBe("xff:203.0.113.7");
  });

  test("a chain SHORTER than the configured hop count falls back to the socket peer", () => {
    process.env.FLAIR_TRUSTED_PROXY = "3";
    expect(callerKey(req("203.0.113.7", { "x-forwarded-for": "1.1.1.1" }))).toBe("addr:203.0.113.7");
  });

  test("no address available collapses to ONE shared bucket — restrictive, never unthrottled", () => {
    expect(callerKey(req(undefined))).toBe(UNKNOWN_CALLER);
    expect(callerKey(req(""))).toBe(UNKNOWN_CALLER);
  });
});

describe("trustedProxyHops", () => {
  test("defaults to trusting nothing", () => {
    expect(trustedProxyHops()).toBe(0);
  });

  test("accepts a hop count and the boolean spellings", () => {
    process.env.FLAIR_TRUSTED_PROXY = "2";
    expect(trustedProxyHops()).toBe(2);
    process.env.FLAIR_TRUSTED_PROXY = "true";
    expect(trustedProxyHops()).toBe(1);
    process.env.FLAIR_TRUSTED_PROXY = "off";
    expect(trustedProxyHops()).toBe(0);
  });

  test("garbage is treated as NO trusted proxy, not as one", () => {
    process.env.FLAIR_TRUSTED_PROXY = "yes-please";
    expect(trustedProxyHops()).toBe(0);
  });
});

// ─── Configuration ──────────────────────────────────────────────────────────

describe("configuration", () => {
  test("limits default to the documented values", () => {
    expect(policyFor("oauth").limit).toBe(30);
    expect(policyFor("register").limit).toBe(5);
    expect(policyFor("mcp").limit).toBe(120);
  });

  test("a valid override is honoured", () => {
    process.env.FLAIR_OAUTH_RATE_LIMIT = "7";
    expect(policyFor("oauth").limit).toBe(7);
  });

  test("zero, negative and non-numeric values fall back to the default rather than disabling the control", () => {
    for (const bad of ["0", "-1", "abc", "1.5", ""]) {
      process.env.FLAIR_OAUTH_RATE_LIMIT = bad;
      __resetWarningsForTest();
      expect(envLimit("FLAIR_OAUTH_RATE_LIMIT", 30)).toBe(30);
    }
  });

  test("rate limiting is ON unless explicitly switched off", () => {
    expect(rateLimitEnabled()).toBe(true);
    process.env.FLAIR_RATE_LIMIT = "off";
    expect(rateLimitEnabled()).toBe(false);
  });

  test("a TYPO in the master switch leaves the control ENABLED", () => {
    // "disabled" is not one of the accepted off spellings. Treating an
    // unrecognised value as "off" would let a typo silently unthrottle the
    // instance — an unrun check that looks like a pass.
    process.env.FLAIR_RATE_LIMIT = "disabled";
    expect(rateLimitEnabled()).toBe(true);
  });
});

// ─── The HTTP entry point ───────────────────────────────────────────────────

describe("checkHttpRateLimit", () => {
  test("POSITIVE CONTROL: requests under the limit pass through (null = continue)", () => {
    process.env.FLAIR_OAUTH_RATE_LIMIT = "3";
    for (let i = 0; i < 3; i++) {
      expect(checkHttpRateLimit(req("203.0.113.7"), "/OAuthToken")).toBeNull();
    }
  });

  test("over the limit it returns a 429 carrying Retry-After", async () => {
    process.env.FLAIR_OAUTH_RATE_LIMIT = "3";
    for (let i = 0; i < 3; i++) checkHttpRateLimit(req("203.0.113.7"), "/OAuthToken");
    const res = checkHttpRateLimit(req("203.0.113.7"), "/OAuthToken");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(429);
    expect(Number(res!.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(await res!.text()).toBe(LIMITED_BODY);
  });

  test("the 429 body leaks nothing about the caller, the endpoint or the credential", async () => {
    // Identical bytes for every key and every endpoint. Anything echoed back
    // here would be a free confirmation channel on an unauthenticated surface.
    const body = JSON.parse(LIMITED_BODY);
    expect(Object.keys(body).sort()).toEqual(["error", "error_description"]);
    expect(body.error).toBe("slow_down");
    expect(LIMITED_BODY).not.toContain("203.0.113");
    expect(LIMITED_BODY).not.toContain("client");
    expect(LIMITED_BODY).not.toContain("grant");
  });

  test("no RateLimit-* pacing headers are emitted", () => {
    const res = limitedResponse({ limited: true, limit: 3, retryAfterSec: 42 });
    expect(res.headers.get("ratelimit-limit")).toBeNull();
    expect(res.headers.get("ratelimit-remaining")).toBeNull();
    expect(res.headers.get("ratelimit-reset")).toBeNull();
    expect(res.headers.get("retry-after")).toBe("42");
  });

  test("registration keeps its own budget when the token budget is heavily used", () => {
    // The limits are deliberately the wrong way round for this case: the token
    // budget is LARGER than the registration budget, so if the two shared a key
    // the token traffic alone would push the shared count past the registration
    // limit. With equal-or-smaller limits the assertion passes either way and
    // proves nothing — which is what a first draft of this test did.
    process.env.FLAIR_OAUTH_RATE_LIMIT = "10";
    process.env.FLAIR_OAUTH_REGISTER_RATE_LIMIT = "2";
    const caller = req("203.0.113.7");
    for (let i = 0; i < 10; i++) expect(checkHttpRateLimit(caller, "/OAuthToken")).toBeNull();
    expect(checkHttpRateLimit(caller, "/OAuthRegister")).toBeNull();
    expect(checkHttpRateLimit(caller, "/OAuthRegister")).toBeNull();
    expect(checkHttpRateLimit(caller, "/OAuthRegister")).not.toBeNull();
  });

  test("an exhausted token budget does not close registration", () => {
    process.env.FLAIR_OAUTH_RATE_LIMIT = "2";
    process.env.FLAIR_OAUTH_REGISTER_RATE_LIMIT = "5";
    const caller = req("203.0.113.7");
    for (let i = 0; i < 3; i++) checkHttpRateLimit(caller, "/OAuthToken");
    expect(checkHttpRateLimit(caller, "/OAuthToken")).not.toBeNull();
    expect(checkHttpRateLimit(caller, "/OAuthRegister")).toBeNull();
  });

  test("distinct callers do not spend each other's budget", () => {
    process.env.FLAIR_OAUTH_RATE_LIMIT = "2";
    for (let i = 0; i < 3; i++) checkHttpRateLimit(req("203.0.113.7"), "/OAuthToken");
    expect(checkHttpRateLimit(req("203.0.113.7"), "/OAuthToken")).not.toBeNull();
    expect(checkHttpRateLimit(req("198.51.100.4"), "/OAuthToken")).toBeNull();
  });

  test("an unthrottled path is never rejected, however many times it is called", () => {
    process.env.FLAIR_OAUTH_RATE_LIMIT = "1";
    for (let i = 0; i < 50; i++) {
      expect(checkHttpRateLimit(req("203.0.113.7"), "/Memory")).toBeNull();
    }
  });

  test("the master switch off means no request is ever rejected", () => {
    process.env.FLAIR_RATE_LIMIT = "off";
    process.env.FLAIR_OAUTH_RATE_LIMIT = "1";
    for (let i = 0; i < 20; i++) {
      expect(checkHttpRateLimit(req("203.0.113.7"), "/OAuthToken")).toBeNull();
    }
  });
});

// ─── The /mcp entry point ───────────────────────────────────────────────────

describe("checkMcpRateLimit", () => {
  const mcpReq = (sub: string, clientId = "cid", ip = "203.0.113.7"): any => ({
    ...req(ip),
    mcp: { sub, client_id: clientId },
  });

  test("POSITIVE CONTROL: calls under the limit pass through", () => {
    process.env.FLAIR_MCP_RATE_LIMIT = "3";
    for (let i = 0; i < 3; i++) expect(checkMcpRateLimit(mcpReq("sub-a"))).toBeNull();
  });

  test("over the limit returns a 429 with a JSON-RPC error body", () => {
    process.env.FLAIR_MCP_RATE_LIMIT = "3";
    for (let i = 0; i < 3; i++) checkMcpRateLimit(mcpReq("sub-a"));
    const res = checkMcpRateLimit(mcpReq("sub-a"));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(429);
    expect(JSON.parse(res!.body).error.message).toBe("too many requests");
    expect(Number(res!.headers["retry-after"])).toBeGreaterThanOrEqual(1);
  });

  test("keyed on the VERIFIED SUBJECT, not the address: a second subject on the same address is unaffected", () => {
    process.env.FLAIR_MCP_RATE_LIMIT = "2";
    for (let i = 0; i < 3; i++) checkMcpRateLimit(mcpReq("sub-a"));
    expect(checkMcpRateLimit(mcpReq("sub-a"))).not.toBeNull();
    expect(checkMcpRateLimit(mcpReq("sub-b"))).toBeNull();
  });

  test("keyed on the VERIFIED SUBJECT, not the address: the SAME subject stays limited from a new address", () => {
    // This is the property per-IP keying cannot give: a token that changes
    // network position keeps its budget.
    process.env.FLAIR_MCP_RATE_LIMIT = "2";
    for (let i = 0; i < 3; i++) checkMcpRateLimit(mcpReq("sub-a", "cid", "203.0.113.7"));
    expect(checkMcpRateLimit(mcpReq("sub-a", "cid", "198.51.100.4"))).not.toBeNull();
  });

  test("the /mcp budget is separate from the OAuth endpoints'", () => {
    process.env.FLAIR_OAUTH_RATE_LIMIT = "1";
    process.env.FLAIR_MCP_RATE_LIMIT = "5";
    for (let i = 0; i < 3; i++) checkHttpRateLimit(req("203.0.113.7"), "/OAuthToken");
    expect(checkMcpRateLimit(mcpReq("sub-a"))).toBeNull();
  });
});
