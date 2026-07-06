import { describe, it, expect, mock, afterEach, beforeAll, afterAll } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import nacl from "tweetnacl";
import { canonicalize, verifyBodySignature } from "../../resources/federation-crypto";
import { keystore } from "../../src/keystore";

/**
 * federation-edge-hardening slice 3a.
 *
 * The federation-sync PUSH (runFederationSyncOnce in src/cli.ts) now signs
 * EACH SyncRecord individually — over a versioned canonical form — using the
 * instance's already-loaded secret key, in addition to the existing
 * batch-level signBodyFresh signature. This is the additive half of the fix;
 * resources/Federation.ts's FederationSync.post (slice 3b) is what actually
 * verifies it on the receiving side (see federation-sync-e2e.test.ts).
 *
 * This file proves, against the real push path:
 *   - every pushed record carries a `signature` field
 *   - that signature verifies against the instance's public key, over the
 *     EXACT canonical form { v: 1, table, id, data, updatedAt,
 *     originatorInstanceId } — the same shape resources/Federation.ts
 *     reconstructs on verify
 *   - principalId is attached ONLY when the row carries a write-time
 *     provenance stamp with a verified agentId (informational; never
 *     required for verification)
 *   - a tampered field breaks verification (the round-trip isn't a no-op)
 */

const origFetch = globalThis.fetch;

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
const publicKeyB64url = Buffer.from(testKp.publicKey).toString("base64url");
const SINCE = "2025-01-01T00:00:00.000Z";
// A randomized, obviously-synthetic instance ID — NOT "spoke-alpha" (used by
// federation-sync-push-privacy.test.ts and elsewhere). keystore.ts persists
// keys to the REAL ~/.flair/keys/ on disk (there is no test-mode override),
// so reusing a shared ID risks reading a STALE key left behind by a prior
// test run/file instead of the keypair this file actually signs with —
// exactly the failure mode this randomization avoids. Cleaned up in
// afterAll below.
const INSTANCE_ID = `test-fed-sig-3a-${randomUUID().slice(0, 8)}`;

describe("federation sync push — per-record signing (federation-edge-hardening slice 3a)", () => {
  let capturedCalls: Array<{ url: string; body?: any; method?: string }> = [];

  beforeAll(() => {
    // Pin the keystore to OUR known keypair for this synthetic instance ID
    // so loadInstanceSecretKey() deterministically returns testKp.secretKey
    // (via the keystore branch) rather than depending on the search_by_value
    // DB-fallback mock below, which only fires if the keystore is empty.
    keystore.setPrivateKeySeed(INSTANCE_ID, testKp.secretKey.slice(0, 32));
  });

  afterAll(() => {
    const keyFile = join(homedir(), ".flair", "keys", `${INSTANCE_ID}.key`);
    if (existsSync(keyFile)) rmSync(keyFile, { force: true });
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  function installMock(memoryRows: any[]) {
    capturedCalls = [];
    globalThis.fetch = mock(async (urlInput: string | URL | Request, init?: RequestInit) => {
      const url = typeof urlInput === "string" ? urlInput : urlInput.toString();
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      capturedCalls.push({ url, body, method });

      if (method === "GET" && url.includes("/FederationPeers")) {
        return res(true, 200, { peers: [{ id: "hub-1", role: "hub", status: "connected", endpoint: "http://hub:9926", lastSyncAt: SINCE }] });
      }
      if (method === "GET" && url.includes("/FederationInstance")) {
        return res(true, 200, { id: INSTANCE_ID, publicKey: publicKeyB64url, role: "spoke" });
      }
      if (body?.operation === "search_by_conditions") {
        const isMemoryUpdatedAtQuery = body.table === "Memory" && body.conditions?.[0]?.search_type === "greater_than";
        return res(true, 200, isMemoryUpdatedAtQuery ? memoryRows : []);
      }
      if (body?.operation === "search_by_value") {
        // loadInstanceSecretKey DB fallback (keystore is empty in test env)
        return res(true, 200, [{ id: INSTANCE_ID, _keySeed: Buffer.from(testKp.secretKey.slice(0, 32)).toString("base64url") }]);
      }
      if (body?.operation === "update") {
        return res(true, 200, { ok: true });
      }
      if (method === "POST" && url.includes("/FederationSync")) {
        const records = body?.records ?? [];
        return res(true, 200, { merged: records.length, skipped: 0 });
      }
      throw new Error(`Unexpected fetch call: ${method} ${url} body=${JSON.stringify(body)}`);
    }) as any;
  }

  function pushedRecords(): any[] {
    const records: any[] = [];
    for (const call of capturedCalls) {
      if (call.url.includes("/FederationSync") && call.method === "POST") {
        for (const r of call.body?.records ?? []) records.push(r);
      }
    }
    return records;
  }

  /** Reconstruct the canonical payload the receiver verifies against. */
  function canonicalPayloadOf(record: any) {
    return {
      v: 1,
      table: record.table,
      id: record.id,
      data: record.data,
      updatedAt: record.updatedAt,
      originatorInstanceId: record.originatorInstanceId,
    };
  }

  it("attaches a signature to every pushed record", async () => {
    installMock([
      { id: "mem-1", agentId: "a1", content: "hello", updatedAt: "2025-06-01T00:00:00.000Z", createdAt: "2025-06-01T00:00:00.000Z" },
    ]);

    const { runFederationSyncOnce } = await import("../../src/cli");
    const result = await runFederationSyncOnce({ adminPass: "test-admin-pass", opsPort: "9925" });

    expect(result.error).toBeUndefined();
    const records = pushedRecords();
    expect(records.length).toBe(1);
    expect(typeof records[0].signature).toBe("string");
    expect(records[0].signature.length).toBeGreaterThan(0);
  });

  it("the signature round-trips against the instance public key over the versioned canonical form", async () => {
    installMock([
      { id: "mem-2", agentId: "a1", content: "round trip me", updatedAt: "2025-06-01T00:00:00.000Z", createdAt: "2025-06-01T00:00:00.000Z" },
    ]);

    const { runFederationSyncOnce } = await import("../../src/cli");
    await runFederationSyncOnce({ adminPass: "test-admin-pass", opsPort: "9925" });

    const record = pushedRecords()[0];
    expect(record.originatorInstanceId).toBe(INSTANCE_ID);

    const payload = canonicalPayloadOf(record);
    expect(payload.v).toBe(1);

    const ok = verifyBodySignature({ ...payload, signature: record.signature }, publicKeyB64url);
    expect(ok).toBe(true);
  });

  it("a tampered field breaks verification — the round-trip is not a no-op", async () => {
    installMock([
      { id: "mem-3", agentId: "a1", content: "original", updatedAt: "2025-06-01T00:00:00.000Z", createdAt: "2025-06-01T00:00:00.000Z" },
    ]);

    const { runFederationSyncOnce } = await import("../../src/cli");
    await runFederationSyncOnce({ adminPass: "test-admin-pass", opsPort: "9925" });

    const record = pushedRecords()[0];
    const payload = canonicalPayloadOf(record);

    // Tamper with data after the fact — same shape used by canonicalize().
    const tampered = { ...payload, data: { ...payload.data, content: "tampered" }, signature: record.signature };
    expect(verifyBodySignature(tampered, publicKeyB64url)).toBe(false);

    // Tamper with a wrong public key instead.
    const otherKp = nacl.sign.keyPair();
    const wrongKeyResult = verifyBodySignature(
      { ...payload, signature: record.signature },
      Buffer.from(otherKp.publicKey).toString("base64url"),
    );
    expect(wrongKeyResult).toBe(false);
  });

  it("principalId is attached when the row carries a verified provenance stamp", async () => {
    const provenance = JSON.stringify({ v: 1, verified: { agentId: "agent-nathan", timestamp: "2025-06-01T00:00:00.000Z" } });
    installMock([
      { id: "mem-prov", agentId: "a1", content: "has provenance", provenance, updatedAt: "2025-06-01T00:00:00.000Z", createdAt: "2025-06-01T00:00:00.000Z" },
    ]);

    const { runFederationSyncOnce } = await import("../../src/cli");
    await runFederationSyncOnce({ adminPass: "test-admin-pass", opsPort: "9925" });

    const record = pushedRecords()[0];
    expect(record.principalId).toBe("agent-nathan");
  });

  it("principalId is OMITTED (not null/undefined-valued) when the row has no provenance stamp", async () => {
    installMock([
      { id: "mem-noprov", agentId: "a1", content: "no provenance", updatedAt: "2025-06-01T00:00:00.000Z", createdAt: "2025-06-01T00:00:00.000Z" },
    ]);

    const { runFederationSyncOnce } = await import("../../src/cli");
    await runFederationSyncOnce({ adminPass: "test-admin-pass", opsPort: "9925" });

    const record = pushedRecords()[0];
    expect("principalId" in record).toBe(false);
  });

  it("principalId is OMITTED when provenance is malformed JSON — fails closed, doesn't throw", async () => {
    installMock([
      { id: "mem-badprov", agentId: "a1", content: "bad provenance", provenance: "{not json", updatedAt: "2025-06-01T00:00:00.000Z", createdAt: "2025-06-01T00:00:00.000Z" },
    ]);

    const { runFederationSyncOnce } = await import("../../src/cli");
    const result = await runFederationSyncOnce({ adminPass: "test-admin-pass", opsPort: "9925" });

    expect(result.error).toBeUndefined();
    const record = pushedRecords()[0];
    expect("principalId" in record).toBe(false);
    // still signed — a bad provenance blob must not break signing.
    expect(typeof record.signature).toBe("string");
  });

  it("canonicalize sorts keys — signing is insensitive to source field order", () => {
    // Sanity-check the exact shared primitive both sides rely on for the
    // byte-for-byte contract: field order must not matter.
    const a = canonicalize({ v: 1, table: "Memory", id: "x", data: { b: 1, a: 2 }, updatedAt: "t", originatorInstanceId: "i" });
    const b = canonicalize({ originatorInstanceId: "i", updatedAt: "t", data: { a: 2, b: 1 }, id: "x", table: "Memory", v: 1 });
    expect(a).toBe(b);
  });
});
