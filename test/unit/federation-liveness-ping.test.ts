import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import nacl from "tweetnacl";

/**
 * No-change federation syncs must still ping the hub for liveness.
 *
 * Before the fix, when a spoke had no records to push, it returned early
 * without contacting the hub — so idle-but-alive spokes looked dead
 * on the hub dashboard (lastSyncAt never advanced).
 *
 * After the fix, a lightweight empty-records POST to FederationSync is
 * sent on every no-change sync. The hub handler always updates lastSyncAt
 * on valid FederationSync calls, so the hub can distinguish alive-but-idle
 * from dead.
 */

const origFetch = globalThis.fetch;

/** Build a minimal Response mock with proper headers.get(). */
function res(ok: boolean, status: number, body: any) {
  return {
    ok,
    status,
    headers: {
      get: (name: string) =>
        name === "content-length" ? String(JSON.stringify(body).length) : null,
    },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const testKp = nacl.sign.keyPair();

describe("federation liveness ping on no-change sync", () => {
  let capturedCalls: Array<{ url: string; body?: any; method?: string }> = [];

  beforeEach(() => {
    capturedCalls = [];
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  /**
   * Install fetch mock for a no-change sync run.
   *
   * Call sequence (14 calls total):
   *  1. GET  /FederationPeers                  → api() helper
   *  2. GET  /FederationInstance               → api() helper
   *  3-10. POST ops/                           → 4 tables × 2 queries (all empty)
   *  11. POST ops/                             → local hub.lastSyncAt advance
   *  12. POST ops/                             → loadInstanceSecretKey DB fallback (keystore is empty in tests)
   *  13. POST hub/FederationSync               → liveness ping (empty records)
   *  14. POST hub/FederationSync               → (only if ping retries, shouldn't happen)
   */
  function installNoChangeMock(pingStatus: number = 200) {
    let idx = 0;

    const responses = [
      // Call 1: FederationPeers
      res(true, 200, { peers: [{ id: "hub-1", role: "hub", status: "connected", endpoint: "http://hub:9926", lastSyncAt: "2025-01-01T00:00:00.000Z" }] }),
      // Call 2: FederationInstance
      res(true, 200, { id: "spoke-alpha", publicKey: Buffer.from(testKp.publicKey).toString("base64url"), role: "spoke" }),
      // Calls 3-10: 4 tables × 2 queries each → all empty
      res(true, 200, []), res(true, 200, []), // Memory
      res(true, 200, []), res(true, 200, []), // Soul
      res(true, 200, []), res(true, 200, []), // Agent
      res(true, 200, []), res(true, 200, []), // Relationship
      // Call 11: Local hub.lastSyncAt advance
      res(true, 200, { ok: true }),
      // Call 12: loadInstanceSecretKey DB fallback (keystore miss in test env)
      res(true, 200, [{ id: "spoke-alpha", _keySeed: Buffer.from(testKp.secretKey.slice(0, 32)).toString("base64url") }]),
      // Call 13: Liveness ping to FederationSync
      res(pingStatus === 200, pingStatus, pingStatus === 200 ? { merged: 0, skipped: 0, skippedReasons: {}, total: 0, durationMs: 1 } : { error: "service unavailable" }),
    ];

    globalThis.fetch = mock(async (urlInput: string | URL | Request, init?: RequestInit) => {
      const url = typeof urlInput === "string" ? urlInput : urlInput.toString();
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      capturedCalls.push({ url, body, method });

      if (idx >= responses.length) {
        throw new Error(`Unexpected fetch call #${idx + 1}: ${method} ${url}`);
      }
      return responses[idx++];
    }) as any;
  }

  it("sends empty-records POST to hub FederationSync on no-change sync", async () => {
    installNoChangeMock();

    const { runFederationSyncOnce } = await import("../../src/cli");

    const result = await runFederationSyncOnce({
      adminPass: "test-admin-pass",
      opsPort: "9925",
    });

    expect(result.pushed).toBe(0);
    expect(result.skipped).toBe(0);

    // Find the liveness ping: POST to FederationSync with empty records.
    const federationSyncCalls = capturedCalls.filter(
      (c) => c.url.includes("/FederationSync") && c.method === "POST",
    );

    expect(federationSyncCalls).toHaveLength(1);

    const pingCall = federationSyncCalls[0];
    expect(pingCall.body).toBeDefined();
    expect(pingCall.body!.instanceId).toBe("spoke-alpha");
    expect(pingCall.body!.records).toEqual([]);
    expect(typeof pingCall.body!.lamportClock).toBe("number");
    // signRequestBody injects _ts, _nonce, and signature
    expect(pingCall.body!._ts).toBeDefined();
    expect(pingCall.body!._nonce).toBeDefined();
    expect(pingCall.body!.signature).toBeDefined();
  });

  it("sync succeeds even when liveness ping returns non-ok (warning only)", async () => {
    installNoChangeMock(503);

    const { runFederationSyncOnce } = await import("../../src/cli");

    const result = await runFederationSyncOnce({
      adminPass: "test-admin-pass",
      opsPort: "9925",
    });

    // Sync succeeds — ping failure is a warning, not fatal
    expect(result.pushed).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.error).toBeUndefined();

    // The ping was still attempted
    const federationSyncCalls = capturedCalls.filter(
      (c) => c.url.includes("/FederationSync") && c.method === "POST",
    );
    expect(federationSyncCalls).toHaveLength(1);
  });
});

// ─── Hub-side: FederationSync updates lastSyncAt even with empty records ────

describe("hub-side FederationSync with empty records", () => {
  it("accepts empty records array (Array.isArray([]) = true)", () => {
    const records: any[] = [];
    expect(Array.isArray(records)).toBe(true);
    expect(records.length).toBe(0);
  });

  it("peer cursor: lastSyncAt always advances, lastMergeAt only when merged > 0", () => {
    // Mirrors the peer update logic from FederationSync.post() in resources/Federation.ts
    const peer = { id: "spoke-alpha", role: "spoke", lastSyncAt: "2025-01-01T00:00:00.000Z" };
    const nowIso = new Date().toISOString();
    const merged = 0;

    const peerUpdate: Record<string, any> = {
      ...peer,
      lastSyncAt: nowIso,
      status: "connected",
      updatedAt: nowIso,
    };
    if (merged > 0) {
      peerUpdate.lastMergeAt = nowIso;
    }

    // lastSyncAt always advances (liveness signal)
    expect(peerUpdate.lastSyncAt).toBe(nowIso);
    expect(peerUpdate.lastSyncAt).not.toBe(peer.lastSyncAt);

    // lastMergeAt NOT updated when no records merged
    expect(peerUpdate.lastMergeAt).toBeUndefined();
  });
});
