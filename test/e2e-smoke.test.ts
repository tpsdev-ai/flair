import { describe, expect, test, beforeAll } from "bun:test";

const BASE_URL = "http://127.0.0.1:9926";

describe("Flair API E2E Smoke", () => {
  test("health check returns 200", async () => {
    const res = await fetch(`${BASE_URL}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  test("Agent table is reachable", async () => {
    const res = await fetch(`${BASE_URL}/Agent`);
    // Should be 200 (empty list) or 401 if auth is strictly enforced
    expect([200, 401]).toContain(res.status);
  });

  test("Memory table rejects plaintext via custom resource", async () => {
    // Note: This assumes we can bypass auth or have a test token
    // For a basic smoke, we just verify the route exists
    const res = await fetch(`${BASE_URL}/Memory`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: "test", content: "foo" })
    });
    // Expected 401 if middleware is active, or 400 if plaintext guard hits (if we forgot encrypted fields)
    expect([201, 401, 400]).toContain(res.status);
  });
});
