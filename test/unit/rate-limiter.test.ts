import { describe, test, expect, beforeEach, afterAll } from "bun:test";

// We need to enable rate limiting for tests. `checkRateLimit`/`isEnabled`
// read process.env LAZILY on every call (not cached at import time), so it's
// safe to set these here and restore them in afterAll below.
//
// Test-isolation note: `bun test <dir>` runs every file in ONE process, so an
// unrestored `process.env` mutation here leaks into every OTHER test file
// that runs afterward — including ones that exercise Memory.post()'s own
// checkRateLimit("general") call with a small, fixed number of test agent
// ids. Once this file set FLAIR_RATE_LIMIT_RPM=5 without cleanup, any other
// suite doing >5 writes for the same agentId within the shared 60s window
// started intermittently 429'ing depending on file execution order (caught
// by test/unit/memory-integrity.test.ts flaking only in the full-suite run,
// never in isolation — see that file's own defensive env override too).
const ORIGINAL_ENV = {
  FLAIR_RATE_LIMIT_ENABLED: process.env.FLAIR_RATE_LIMIT_ENABLED,
  FLAIR_RATE_LIMIT_RPM: process.env.FLAIR_RATE_LIMIT_RPM,
  FLAIR_RATE_LIMIT_EMBED: process.env.FLAIR_RATE_LIMIT_EMBED,
  FLAIR_RATE_LIMIT_USAGE: process.env.FLAIR_RATE_LIMIT_USAGE,
  FLAIR_RATE_LIMIT_STORAGE: process.env.FLAIR_RATE_LIMIT_STORAGE,
};
process.env.FLAIR_RATE_LIMIT_ENABLED = "true";
process.env.FLAIR_RATE_LIMIT_RPM = "5"; // Low limit for testing
process.env.FLAIR_RATE_LIMIT_EMBED = "3";
process.env.FLAIR_RATE_LIMIT_USAGE = "2";
process.env.FLAIR_RATE_LIMIT_STORAGE = "100";

afterAll(() => {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete (process.env as any)[key];
    else process.env[key] = value;
  }
});

// Import after setting env vars
const { checkRateLimit, checkStorageQuota, rateLimitResponse, storageQuotaResponse } = await import("../../resources/rate-limiter");

describe("rate limiter", () => {
  test("allows requests under the limit", () => {
    const result = checkRateLimit("test-agent-1", "general");
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBeDefined();
  });

  test("blocks requests over the limit", () => {
    const agent = "test-agent-flood-" + Date.now();
    // RPM limit is 5
    for (let i = 0; i < 5; i++) {
      const r = checkRateLimit(agent, "general");
      expect(r.allowed).toBe(true);
    }
    // 6th should be blocked
    const blocked = checkRateLimit(agent, "general");
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
  });

  test("embedding bucket has separate limit", () => {
    const agent = "test-agent-embed-" + Date.now();
    // Embed limit is 3
    for (let i = 0; i < 3; i++) {
      expect(checkRateLimit(agent, "embedding").allowed).toBe(true);
    }
    expect(checkRateLimit(agent, "embedding").allowed).toBe(false);
    // General bucket should still work
    expect(checkRateLimit(agent, "general").allowed).toBe(true);
  });

  // flair#683: usage-feedback's own bucket (Sherlock's rate-limiter layer of
  // the three-layer anti-gaming defense — see resources/RecordUsage.ts).
  test("usage bucket has its own separate limit", () => {
    const agent = "test-agent-usage-" + Date.now();
    // Usage limit is 2 (set above)
    expect(checkRateLimit(agent, "usage").allowed).toBe(true);
    expect(checkRateLimit(agent, "usage").allowed).toBe(true);
    const blocked = checkRateLimit(agent, "usage");
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
    // Other buckets are unaffected by the usage bucket being exhausted.
    expect(checkRateLimit(agent, "general").allowed).toBe(true);
  });

  test("allows requests when agent is empty", () => {
    const result = checkRateLimit("", "general");
    expect(result.allowed).toBe(true);
  });

  test("storage quota check works", () => {
    expect(checkStorageQuota(50).allowed).toBe(true);
    expect(checkStorageQuota(100).allowed).toBe(false);
    expect(checkStorageQuota(100).limit).toBe(100);
  });

  test("rateLimitResponse returns 429", () => {
    const resp = rateLimitResponse(5000, "write");
    expect(resp.status).toBe(429);
    expect(resp.headers.get("Retry-After")).toBe("5");
  });

  test("storageQuotaResponse returns 413", () => {
    const resp = storageQuotaResponse(10000);
    expect(resp.status).toBe(413);
  });
});
