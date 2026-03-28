import { describe, test, expect, beforeEach } from "bun:test";

// We need to enable rate limiting for tests
process.env.FLAIR_RATE_LIMIT_ENABLED = "true";
process.env.FLAIR_RATE_LIMIT_RPM = "5"; // Low limit for testing
process.env.FLAIR_RATE_LIMIT_EMBED = "3";
process.env.FLAIR_RATE_LIMIT_STORAGE = "100";

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
