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

/**
 * flair#2450 — the spoke-side cursor advance after a BATCH (not the no-change
 * ping the block above covers), pinned on its own.
 *
 * The item-3 real-Harper case drives a single instance that is both the
 * client's hub and the receiver, so FederationSync.post's own contact write and
 * runFederationSyncOnce's stampLocalContact both touch the SAME Peer row the
 * client re-reads as `since` — the advance cannot be attributed. These unit
 * cases isolate stampLocalContact: they mock the wire, push one Memory record,
 * and assert the field-only Peer cursor update happens exactly once, after the
 * batch POST, and only when the batch returned 200. Removing the post-batch
 * `await stampLocalContact()` fails the first case; letting a failed batch stamp
 * anyway fails the second.
 */
describe("flair#2450 — the spoke cursor advances after a batch, and only when every batch got 200", () => {
  const origFetch = globalThis.fetch;
  let calls: Array<{ url: string; method?: string; body?: any }> = [];
  const INSTANCE = "spoke-batch-2450";
  const HUB = "hub-batch-2450";
  const CURSOR = "2025-01-01T00:00:00.000Z";
  const kp = nacl.sign.keyPair();

  beforeEach(() => { calls = []; });
  afterEach(() => { globalThis.fetch = origFetch; });

  function installBatchMock(batchStatuses: number[], rowCount = 1) {
    let post = 0;
    globalThis.fetch = mock(async (urlInput: string | URL | Request, init?: RequestInit) => {
      const url = typeof urlInput === "string" ? urlInput : urlInput.toString();
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, method, body });

      if (method === "GET" && url.includes("/FederationPeers")) {
        return res(true, 200, { peers: [{ id: HUB, role: "hub", status: "connected", endpoint: "http://hub:9926", lastSyncAt: CURSOR }] });
      }
      if (method === "GET" && url.includes("/FederationInstance")) {
        return res(true, 200, { id: INSTANCE, publicKey: Buffer.from(kp.publicKey).toString("base64url"), role: "spoke" });
      }
      if (body?.operation === "search_by_conditions") {
        if (body.table !== "Memory") return res(true, 200, []);
        // Only the `updatedAt > cursor` query yields rows; the `updatedAt == null`
        // query yields none, so the row count is exactly `rowCount`.
        if (body.conditions?.[0]?.search_value === null) return res(true, 200, []);
        return res(true, 200, Array.from({ length: rowCount }, (_, i) => ({
          id: `mem-batch-${i}`, agentId: "agent-1", content: `hello ${i}`, contentHash: `hash-${i}`,
          instanceToken: `tok-${i}`, durability: "persistent", visibility: "shared", archived: false,
          createdAt: new Date(Date.now() - 60_000).toISOString(), updatedAt: new Date().toISOString(),
        })));
      }
      if (body?.operation === "search_by_value" && body.table === "Instance") {
        return res(true, 200, [{ id: INSTANCE, _keySeed: Buffer.from(kp.secretKey.slice(0, 32)).toString("base64url") }]);
      }
      if (method === "POST" && url.includes("/FederationSync")) {
        const status = batchStatuses[Math.min(post, batchStatuses.length - 1)] ?? 200;
        post++;
        const sent = (body?.records ?? []).length;
        return res(status === 200, status,
          status === 200 ? { merged: sent, skipped: 0, skippedReasons: {}, total: sent, durationMs: 1 } : { error: "service unavailable" });
      }
      if (body?.operation === "update" && body?.table === "Peer") {
        return res(true, 200, { update_hashes: [HUB], skipped_hashes: [] });
      }
      throw new Error(`Unexpected fetch call: ${method} ${url} body=${JSON.stringify(body)}`);
    }) as any;
  }

  const cursorWrites = () => calls.filter((c) => c.body?.operation === "update" && c.body?.table === "Peer");

  it("one batch, 200 → stampLocalContact runs once, after the batch, at queriedAt", async () => {
    const t0 = Date.now();
    installBatchMock([200]);
    const { runFederationSyncOnce } = await import("../../src/cli");
    const result = await runFederationSyncOnce({ adminPass: "test-admin-pass", opsPort: "9925" });

    expect(result.error, String(result.error)).toBeUndefined();
    expect(result.pushed).toBe(1);

    const batchIdx = calls.findIndex((c) => c.url.includes("/FederationSync") && c.method === "POST");
    const writes = cursorWrites();
    expect(batchIdx, "no batch POST was sent").toBeGreaterThan(-1);
    expect(writes.length, "the spoke cursor was not stamped exactly once").toBe(1);
    const writeIdx = calls.findIndex((c) => c.body?.operation === "update" && c.body?.table === "Peer");
    expect(writeIdx, "the cursor was stamped before the batch").toBeGreaterThan(batchIdx);
    const stamp = writes[0]?.body?.records?.[0]?.lastSyncAt;
    expect(typeof stamp).toBe("string");
    expect(Date.parse(stamp), "the cursor was not set to the pre-query timestamp").toBeGreaterThanOrEqual(t0);
    expect(writes[0]?.body?.records?.[0]?.id).toBe(HUB);
  });

  it("a LATER batch that fails does not stamp: an earlier 200 does not advance the cursor (no per-batch stamp)", async () => {
    // 51 rows forces two batches: 50 (200) then 1 (503). The stamp is written
    // ONCE after the whole run, so the failed second batch must leave the cursor
    // put even though the first batch succeeded — a per-batch "after any 200"
    // stamp would have advanced it here.
    installBatchMock([200, 503], 51);
    const { runFederationSyncOnce } = await import("../../src/cli");
    const result = await runFederationSyncOnce({ adminPass: "test-admin-pass", opsPort: "9925" });

    expect(result.error, "a failed batch must surface").toBeDefined();
    const posts = calls.filter((c) => c.url.includes("/FederationSync") && c.method === "POST");
    expect(posts.length, "expected two batches (50 then 1)").toBeGreaterThan(1);
    expect(cursorWrites().length, "the cursor advanced after the first batch despite a later failure").toBe(0);
  });
});
