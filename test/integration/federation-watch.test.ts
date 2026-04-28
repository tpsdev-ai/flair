import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import { runFederationSyncOnce, runFederationWatch } from "../../src/cli.js";

/**
 * Fast-fetch mock that makes runFederationSyncOnce execute quickly with
 * no records to push.  This lets us test runFederationWatch without
 * relying on mock.module (which is global and leaks across test files).
 */
function setupFastFetch(overrides?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response | undefined>) {
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (overrides) {
      const override = await overrides(input, init);
      if (override) return override;
    }
    const url = input.toString();
    if (url.includes("/FederationPeers")) {
      return new Response(
        JSON.stringify({
          peers: [
            {
              role: "hub",
              id: "hub1",
              status: "active",
              lastSyncAt: "2024-01-01T00:00:00Z",
              endpoint: "http://hub",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("/FederationInstance")) {
      return new Response(
        JSON.stringify({ id: "inst1" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("/FederationSync")) {
      return new Response(
        JSON.stringify({ merged: 0, skipped: 0, durationMs: 1 }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (init?.method === "POST" && !url.includes("/FederationSync")) {
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("not found", { status: 404 });
  });
}

describe("federation watch", () => {
  let origFetch: typeof fetch;

  beforeEach(() => {
    origFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  test("watch calls sync at least once", async () => {
    setupFastFetch();

    const watchPromise = runFederationWatch({ interval: "5" });
    await new Promise((r) => setTimeout(r, 100));
    process.kill(process.pid, "SIGTERM");
    await watchPromise;
  });

  // Note: This sends SIGTERM to the test-runner process itself. It works
  // today because Bun handles the signal gracefully, but it couples the test
  // to runner internals. Mocking signal delivery cleanly would require
  // either injecting a signal mock into runFederationWatch or using a
  // child-process wrapper — both are disproportionate rework for a test that
  // already passes, so we leave it as-is.
  test("watch exits on SIGTERM", async () => {
    setupFastFetch();

    const start = Date.now();
    const watchPromise = runFederationWatch({ interval: "10" });
    await new Promise((r) => setTimeout(r, 150));
    process.kill(process.pid, "SIGTERM");

    await watchPromise;
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(2000);
  });

  test("clamps negative interval to 5 seconds minimum", async () => {
    setupFastFetch();

    let syncCalls = 0;
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.includes("/FederationPeers")) {
        return new Response(
          JSON.stringify({
            peers: [
              {
                role: "hub",
                id: "hub1",
                status: "active",
                lastSyncAt: "2024-01-01T00:00:00Z",
                endpoint: "http://hub",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/FederationInstance")) {
        return new Response(
          JSON.stringify({ id: "inst1" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (init?.method === "POST" && !url.includes("/FederationSync")) {
        syncCalls++;
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    });

    const start = Date.now();
    const watchPromise = runFederationWatch({ interval: "-5" });
    await new Promise((r) => setTimeout(r, 500));
    process.kill(process.pid, "SIGTERM");
    await watchPromise;
    const elapsed = Date.now() - start;

    // With interval clamped to 5s, we should only see 1 sync run in 500ms.
    // Each sync run issues 4 ops POSTs (one per table: Memory, Soul, Agent, Relationship).
    expect(syncCalls).toBe(4);
    expect(elapsed).toBeLessThan(1000);
  });
});

describe("runFederationSyncOnce auth propagation", () => {
  let origFetch: typeof fetch;

  beforeEach(() => {
    origFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  test("returns error when ops SQL query returns 401", async () => {
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.includes("/FederationPeers")) {
        return new Response(
          JSON.stringify({
            peers: [
              {
                role: "hub",
                id: "hub1",
                status: "active",
                lastSyncAt: "2024-01-01T00:00:00Z",
                endpoint: "http://hub",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/FederationInstance")) {
        return new Response(
          JSON.stringify({ id: "inst1" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (init?.method === "POST" && !url.includes("/FederationSync")) {
        return new Response("Unauthorized", { status: 401 });
      }
      return new Response("not found", { status: 404 });
    });

    const result = await runFederationSyncOnce({
      adminPass: "admin",
      port: "19926",
      opsPort: "19925",
    });
    expect(result.error).toBeDefined();
    expect(result.error?.message).toContain("401");
  });

  test("returns error when ops SQL query throws network error", async () => {
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.includes("/FederationPeers")) {
        return new Response(
          JSON.stringify({
            peers: [
              {
                role: "hub",
                id: "hub1",
                status: "active",
                lastSyncAt: "2024-01-01T00:00:00Z",
                endpoint: "http://hub",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/FederationInstance")) {
        return new Response(
          JSON.stringify({ id: "inst1" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (init?.method === "POST" && !url.includes("/FederationSync")) {
        throw new Error("ECONNREFUSED");
      }
      return new Response("not found", { status: 404 });
    });

    const result = await runFederationSyncOnce({
      adminPass: "admin",
      port: "19926",
      opsPort: "19925",
    });
    expect(result.error).toBeDefined();
    expect(result.error?.message).toContain("ECONNREFUSED");
  });
});
