/**
 * federation-reoffer-outcomes-2797.test.ts — the sender's handling of a Memory
 * batch response that does not account for every offered record (flair#2797).
 *
 * The receiver is a fetch stub here: a real Harper receiver always returns the
 * refused and indeterminate lists (test/integration/federation-reoffer-busy-2797
 * exercises that path). These cases pin the older-receiver shapes the count
 * parser still permits.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import nacl from "tweetnacl";
import { retryEntryKey } from "../../src/lib/federation-retry-key.js";

const origFetch = globalThis.fetch;
const HUB = "hub-a";
const SPEKE = "spoke-a";
const ROW = "memory-a";
const SINCE = "2026-01-01T00:00:00.000Z";
const kp = nacl.sign.keyPair();

function res(body: any, ok = true, status = 200) {
  return {
    ok,
    status,
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

type Fake = {
  retryRows: Map<string, any>;
  peerUpdates: any[];
  hubBodies: any[];
};

function install(fake: Fake, hubResponse: (records: any[]) => any, opts: { pending?: boolean; cursorRow?: boolean } = {}) {
  globalThis.fetch = mock(async (urlInput: string | URL | Request, init?: RequestInit) => {
    const url = typeof urlInput === "string" ? urlInput : urlInput.toString();
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;

    if (method === "GET" && url.includes("/FederationPeers")) {
      return res({ peers: [{ id: HUB, role: "hub", status: "connected", endpoint: "http://hub-a:9926", lastSyncAt: SINCE }] });
    }
    if (method === "GET" && url.includes("/FederationInstance")) {
      return res({ id: SPEKE, publicKey: Buffer.from(kp.publicKey).toString("base64url"), role: "spoke" });
    }
    if (body?.operation === "search_by_value" && body.table === "Instance") {
      return res([{ id: SPEKE, _keySeed: Buffer.from(kp.secretKey.slice(0, 32)).toString("base64url") }]);
    }
    if (body?.operation === "search_by_conditions" && body.table === "FederationRetry") {
      return res(opts.pending ? [...fake.retryRows.values()] : []);
    }
    if (body?.operation === "search_by_conditions" && body.table === "Memory") {
      const isCursor = body.conditions?.[0]?.search_type === "greater_than";
      return res(isCursor && opts.cursorRow ? [{ id: ROW, agentId: "agent-a", content: "x", contentHash: "h", visibility: "shared", archived: false, createdAt: SINCE, updatedAt: SINCE }] : []);
    }
    if (body?.operation === "search_by_conditions") return res([]);
    if (body?.operation === "search_by_hash" && body.table === "FederationRetry") {
      const row = fake.retryRows.get(body.hash_values[0]);
      return res(row ? [row] : []);
    }
    if (body?.operation === "search_by_hash" && body.table === "Memory") {
      return res([{ id: ROW, agentId: "agent-a", content: "x", contentHash: "h", visibility: "shared", archived: false, createdAt: SINCE, updatedAt: SINCE }]);
    }
    if (body?.operation === "upsert" && body.table === "FederationRetry") {
      for (const row of body.records) fake.retryRows.set(row.id, row);
      return res({ ok: true });
    }
    if (body?.operation === "update" && body.table === "FederationRetry") {
      for (const row of body.records) fake.retryRows.set(row.id, row);
      return res({ update_hashes: body.records.map((r: any) => r.id) });
    }
    if (body?.operation === "update" && body.table === "Peer") {
      fake.peerUpdates.push(body);
      return res({ update_hashes: body.records.map((r: any) => r.id) });
    }
    if (method === "POST" && url.includes("/FederationSync")) {
      fake.hubBodies.push(body);
      return res(hubResponse(body?.records ?? []));
    }
    throw new Error(`Unexpected fetch call: ${method} ${url} body=${JSON.stringify(body)}`);
  }) as any;
}

function pendingRow() {
  return {
    id: retryEntryKey(HUB, "Memory", ROW),
    peerId: HUB,
    table: "Memory",
    recordId: ROW,
    state: "pending",
    firstRefusedAt: SINCE,
    attempts: 1,
    lastReason: "merge_target_busy",
    lastAttemptAt: "2026-01-01T00:00:00.000Z",
    createdAt: SINCE,
    updatedAt: SINCE,
  };
}

async function run() {
  const { runFederationSyncOnce } = await import("../../src/cli");
  return runFederationSyncOnce({ adminPass: "test-admin-pass", opsPort: "9925" });
}

let fake: Fake;
beforeEach(() => {
  fake = { retryRows: new Map(), peerUpdates: [], hubBodies: [] };
});
afterEach(() => {
  globalThis.fetch = origFetch;
});

describe("flair#2797 — a Memory response must account for every offered record", () => {
  it("an older-receiver counts-only response is rejected and creates no retry row or cursor advance", async () => {
    install(fake, () => ({ merged: 0, skipped: 1 }), { cursorRow: true });
    const result = await run();
    expect(result.error?.message).toContain("outcomes do not account");
    expect(fake.retryRows.size).toBe(0);
    expect(fake.peerUpdates).toEqual([]);
  });

  it("a skip reported without a refused list leaves an existing pending row pending, not merged", async () => {
    fake.retryRows.set(retryEntryKey(HUB, "Memory", ROW), pendingRow());
    install(fake, () => ({ merged: 0, skipped: 0 }), { pending: true });
    const result = await run();
    expect(result.error?.message).toContain("outcomes do not account");
    const stored = fake.retryRows.get(retryEntryKey(HUB, "Memory", ROW));
    expect(stored.state).toBe("pending");
    expect(stored.resolution).toBeUndefined();
    expect(fake.peerUpdates).toEqual([]);
  });

  it("a complete response is accepted and the row counts as pushed", async () => {
    install(fake, (records) => ({ merged: records.length, skipped: 0, refused: [], indeterminate: [] }), { cursorRow: true });
    const result = await run();
    expect(result.error).toBeUndefined();
    expect(result.pushed).toBe(1);
  });
});
