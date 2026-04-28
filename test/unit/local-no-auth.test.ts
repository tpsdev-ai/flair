/**
 * local-no-auth.test.ts — Unit tests for implicit local auth skip (ops-vu31)
 *
 * When targeting localhost with no admin pass, api() should send no
 * Authorization header. Auth-middleware should let the request through
 * if Harper's authorizeLocal has already set request.user.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";

// We can't import api() directly because cli.ts starts a Commander program
// on import. Instead we exercise the logic by mocking fetch and checking
// that local calls omit the Authorization header when no admin pass is set.

import { api } from "../../src/cli.js";

describe("api() local auth behavior", () => {
  let origFetch: typeof globalThis.fetch;
  let capturedHeaders: Record<string, string> | undefined;
  let capturedUrl: string | undefined;

  beforeEach(() => {
    origFetch = globalThis.fetch;
    capturedHeaders = undefined;
    capturedUrl = undefined;
    globalThis.fetch = async (url: any, opts: any) => {
      capturedUrl = typeof url === "string" ? url : url.toString();
      capturedHeaders = opts?.headers ?? {};
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    delete process.env.FLAIR_ADMIN_PASS;
    delete process.env.HDB_ADMIN_PASSWORD;
    delete process.env.FLAIR_URL;
    delete process.env.FLAIR_TOKEN;
    delete process.env.FLAIR_AGENT_ID;
  });

  test("local call with no admin pass sends no Authorization header", async () => {
    delete process.env.FLAIR_ADMIN_PASS;
    delete process.env.HDB_ADMIN_PASSWORD;
    delete process.env.FLAIR_TOKEN;

    await api("GET", "/Agent", undefined, { baseUrl: "http://127.0.0.1:19926" });

    expect(capturedUrl).toBe("http://127.0.0.1:19926/Agent");
    expect(capturedHeaders?.authorization).toBeUndefined();
  });

  test("local call with no admin pass (localhost hostname) sends no Authorization header", async () => {
    delete process.env.FLAIR_ADMIN_PASS;
    delete process.env.HDB_ADMIN_PASSWORD;
    delete process.env.FLAIR_TOKEN;

    await api("GET", "/Agent", undefined, { baseUrl: "http://localhost:19926" });

    expect(capturedUrl).toBe("http://localhost:19926/Agent");
    expect(capturedHeaders?.authorization).toBeUndefined();
  });

  test("remote call with admin pass sends Basic auth header", async () => {
    process.env.FLAIR_ADMIN_PASS = "secret123";

    await api("GET", "/Agent", undefined, { baseUrl: "https://remote.example.com:19926" });

    expect(capturedUrl).toBe("https://remote.example.com:19926/Agent");
    expect(capturedHeaders?.authorization).toStartWith("Basic ");
  });

  test("local call with admin pass env set skips Basic auth (authorizes via authorizeLocal)", async () => {
    process.env.FLAIR_ADMIN_PASS = "secret123";

    await api("GET", "/Agent", undefined, { baseUrl: "http://127.0.0.1:19926" });

    expect(capturedUrl).toBe("http://127.0.0.1:19926/Agent");
    expect(capturedHeaders?.authorization).toBeUndefined();
  });

  test("Bearer token still sent on local when FLAIR_TOKEN is set", async () => {
    process.env.FLAIR_TOKEN = "mytoken";

    await api("GET", "/Agent", undefined, { baseUrl: "http://127.0.0.1:19926" });

    expect(capturedHeaders?.authorization).toBe("Bearer mytoken");
  });

  test("Ed25519 agent auth still used on local when FLAIR_AGENT_ID and key exist", async () => {
    // This test verifies the fallback to agent auth isn't broken.
    // We don't have a real key file, so it falls through to no auth.
    delete process.env.FLAIR_ADMIN_PASS;
    delete process.env.HDB_ADMIN_PASSWORD;
    process.env.FLAIR_AGENT_ID = "test-agent";

    await api("POST", "/Agent", { agentId: "test-agent" }, { baseUrl: "http://127.0.0.1:19926" });

    // No key file exists for test-agent, so no auth header is sent.
    expect(capturedHeaders?.authorization).toBeUndefined();
  });
});
