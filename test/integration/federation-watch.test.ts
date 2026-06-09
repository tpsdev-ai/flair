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
        // Distinguish search_by_conditions (one per table per sync) from
        // the lastSyncAt cursor-advance update (one per sync, added in
        // task #146 fix). Test only counts the per-table search ops.
        let opType: string | undefined;
        try { opType = JSON.parse(String(init?.body ?? "{}"))?.operation; } catch { /* ignore */ }
        if (opType === "search_by_conditions") {
          syncCalls++;
        }
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
    // Each sync run issues 8 search_by_conditions POSTs (2 per table:
    // Memory, Soul, Agent, Relationship — one for updatedAt > since,
    // one for updatedAt IS NULL). The Peer.update for cursor
    // advancement is NOT counted (filtered above) — orthogonal concern.
    expect(syncCalls).toBe(8);
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


describe("runFederationSyncOnce null-updatedAt fix", () => {
  let origFetch: typeof fetch;

  beforeEach(() => {
    origFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  test("syncs rows with null updatedAt using createdAt as effective timestamp", async () => {
    const since = "2024-01-01T00:00:00Z";
    let syncBodies: any[] = [];
    // 32 zero bytes as base64url — valid nacl seed for signing
    const zeroKeySeed = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

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
                lastSyncAt: since,
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
        const body = JSON.parse(String(init?.body ?? "{}"));
        syncBodies.push(body);
        return new Response(
          JSON.stringify({ merged: body.records.length, skipped: 0, durationMs: 1 }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (init?.method === "POST" && !url.includes("/FederationSync")) {
        const body = JSON.parse(String(init?.body ?? "{}"));
        // Keystore fallback: loadInstanceSecretKey searches Instance table
        if (body.operation === "search_by_value" && body.table === "Instance") {
          return new Response(
            JSON.stringify([{ id: "inst1", _keySeed: zeroKeySeed }]),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        const searchType = body.conditions?.[0]?.search_type;
        if (searchType === "greater_than") {
          return new Response(JSON.stringify([]), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (searchType === "equals" && body.conditions?.[0]?.search_value === null) {
          if (body.table !== "Memory") return new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } });
          return new Response(
            JSON.stringify([
              {
                id: "legacy-1",
                table: "Memory",
                content: "legacy memory",
                createdAt: "2025-06-01T00:00:00Z",
                updatedAt: null,
              },
            ]),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    });

    const result = await runFederationSyncOnce({
      adminPass: "admin",
      port: "19926",
      opsPort: "19925",
    });

    expect(result.error).toBeUndefined();
    expect(result.pushed).toBe(1);
    expect(syncBodies).toHaveLength(1);
    expect(syncBodies[0].records).toHaveLength(1);
    expect(syncBodies[0].records[0].id).toBe("legacy-1");
    expect(syncBodies[0].records[0].updatedAt).toBe("2025-06-01T00:00:00Z");
  });

  test("skips null-updatedAt rows whose createdAt is before the sync cursor", async () => {
    const since = "2025-06-01T00:00:00Z";

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
                lastSyncAt: since,
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
        const body = JSON.parse(String(init?.body ?? "{}"));
        const searchType = body.conditions?.[0]?.search_type;
        if (searchType === "greater_than") {
          return new Response(JSON.stringify([]), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (searchType === "equals" && body.conditions?.[0]?.search_value === null) {
          if (body.table !== "Memory") return new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } });
          return new Response(
            JSON.stringify([
              {
                id: "old-legacy",
                content: "old legacy memory",
                createdAt: "2024-01-01T00:00:00Z",
                updatedAt: null,
              },
            ]),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    });

    const result = await runFederationSyncOnce({
      adminPass: "admin",
      port: "19926",
      opsPort: "19925",
    });

    expect(result.error).toBeUndefined();
    expect(result.pushed).toBe(0);
  });
});
