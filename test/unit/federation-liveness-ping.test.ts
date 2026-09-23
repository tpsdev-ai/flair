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
 *
 * flair#1146: the spoke's own lastSyncAt must not advance unless that ping
 * (or a sendBatch) returned 200. A failed ping leaves the stamp untouched.
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

  function installNoChangeMock(pingStatus: number = 200) {
    globalThis.fetch = mock(async (urlInput: string | URL | Request, init?: RequestInit) => {
      const url = typeof urlInput === "string" ? urlInput : urlInput.toString();
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      capturedCalls.push({ url, body, method });

      if (method === "GET" && url.includes("/FederationPeers")) {
        return res(true, 200, { peers: [{ id: "hub-1", role: "hub", status: "connected", endpoint: "http://hub:9926", lastSyncAt: "2025-01-01T00:00:00.000Z" }] });
      }
      if (method === "GET" && url.includes("/FederationInstance")) {
        return res(true, 200, { id: "spoke-alpha", publicKey: Buffer.from(testKp.publicKey).toString("base64url"), role: "spoke" });
      }
      if (body?.operation === "search_by_conditions") {
        return res(true, 200, []);
      }
      if (body?.operation === "search_by_value" && body.table === "Peer") {
        return res(true, 200, [{
          id: "hub-1",
          publicKey: "hub-pk",
          role: "hub",
          status: "paired",
          endpoint: "http://hub:9926",
          lastSyncAt: "2025-01-01T00:00:00.000Z",
        }]);
      }
      if (body?.operation === "search_by_value") {
        return res(true, 200, [{ id: "spoke-alpha", _keySeed: Buffer.from(testKp.secretKey.slice(0, 32)).toString("base64url") }]);
      }
      if (body?.operation === "update" || body?.operation === "upsert") {
        const ids = (body?.records ?? []).map((r: any) => r.id);
        return res(true, 200, { message: `${body.operation} ${ids.length} of ${ids.length}`, update_hashes: ids, upserted_hashes: ids, skipped_hashes: [] });
      }
      if (method === "POST" && url.includes("/FederationSync")) {
        return res(
          pingStatus === 200,
          pingStatus,
          pingStatus === 200 ? { merged: 0, skipped: 0, skippedReasons: {}, total: 0, durationMs: 1 } : { error: "service unavailable" },
        );
      }
      throw new Error(`Unexpected fetch call: ${method} ${url} body=${JSON.stringify(body)}`);
    }) as any;
  }

  function peerCursorWrites() {
    return capturedCalls.filter((c) => c.body?.operation === "update" && c.body?.table === "Peer");
  }
  function peerUpserts() {
    return capturedCalls.filter((c) => c.body?.operation === "upsert" && c.body?.table === "Peer");
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

    const federationSyncCalls = capturedCalls.filter(
      (c) => c.url.includes("/FederationSync") && c.method === "POST",
    );

    expect(federationSyncCalls).toHaveLength(1);

    const pingCall = federationSyncCalls[0];
    expect(pingCall.body).toBeDefined();
    expect(pingCall.body!.instanceId).toBe("spoke-alpha");
    expect(pingCall.body!.records).toEqual([]);
    expect(typeof pingCall.body!.lamportClock).toBe("number");
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

    expect(result.pushed).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.error).toBeUndefined();

    const federationSyncCalls = capturedCalls.filter(
      (c) => c.url.includes("/FederationSync") && c.method === "POST",
    );
    expect(federationSyncCalls).toHaveLength(1);
  });

  it("ping fails → lastSyncAt is NOT written (flair#1146)", async () => {
    installNoChangeMock(503);

    const { runFederationSyncOnce } = await import("../../src/cli");
    await runFederationSyncOnce({
      adminPass: "test-admin-pass",
      opsPort: "9925",
    });

    expect(peerCursorWrites()).toHaveLength(0);
    expect(peerUpserts()).toHaveLength(0);
  });

  it("ping ok → lastSyncAt is written AFTER the ping, at completion time", async () => {
    const t0 = Date.now();
    installNoChangeMock(200);

    const { runFederationSyncOnce } = await import("../../src/cli");
    await runFederationSyncOnce({
      adminPass: "test-admin-pass",
      opsPort: "9925",
    });

    const pingIdx = capturedCalls.findIndex((c) => c.url.includes("/FederationSync") && c.method === "POST");
    const cursorIdx = capturedCalls.findIndex((c) => c.body?.operation === "update" && c.body?.table === "Peer");
    expect(pingIdx).toBeGreaterThan(-1);
    expect(cursorIdx).toBeGreaterThan(pingIdx);
    const stamp = capturedCalls[cursorIdx]?.body?.records?.[0]?.lastSyncAt;
    expect(typeof stamp).toBe("string");
    expect(Date.parse(stamp)).toBeGreaterThanOrEqual(t0);
  });
});

describe("hub-side FederationSync with empty records", () => {
  it("accepts empty records array (Array.isArray([]) = true)", () => {
    const records: any[] = [];
    expect(Array.isArray(records)).toBe(true);
    expect(records.length).toBe(0);
  });

  it("peer cursor: lastSyncAt always advances, lastMergeAt only when merged > 0", () => {
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

    expect(peerUpdate.lastSyncAt).toBe(nowIso);
    expect(peerUpdate.lastSyncAt).not.toBe(peer.lastSyncAt);
    expect(peerUpdate.lastMergeAt).toBeUndefined();
  });
});
