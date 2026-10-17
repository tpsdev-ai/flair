/**
 * federation-sync-push-presence-2578.test.ts — flair#2578 slice 2, the Presence
 * SENDER driven through the real push path (runFederationSyncOnce) with the
 * network mocked.
 *
 * Proves, against the real push code:
 *   - with the flag OFF the sender is unchanged: no Presence scan, no Presence
 *     record, no watermark write;
 *   - with the flag ON a HOME row (originatorInstanceId is this instance) is
 *     pushed as a signed v:2 Presence record keyed on agentId;
 *   - a non-home row is never pushed;
 *   - a row at or below the per-table watermark is not re-sent;
 *   - a confirmed batch advances the watermark (the local Peer row's
 *     presenceLastSyncAt), and a failed batch does not.
 *
 * The real end-to-end case (a real sender against a real Harper receiver) is in
 * test/integration/federation-presence-send-2578.test.ts.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import nacl from "tweetnacl";
import { verifyBodySignature } from "../../resources/federation-crypto";
import { reconstructRecordVerifyBody } from "../../resources/federation-classify";
import { keystore } from "../../src/keystore";
import { PRESENCE_SEND_FLAG_ENV } from "../../src/federation/presence-send";

const origFetch = globalThis.fetch;
const testKp = nacl.sign.keyPair();
const publicKeyB64url = Buffer.from(testKp.publicKey).toString("base64url");
const SINCE = "2025-01-01T00:00:00.000Z";
const INSTANCE_ID = `test-fed-pres-s2-${randomUUID().slice(0, 8)}`;
const HUB = "hub-1";

function res(ok: boolean, status: number, body: any) {
  return {
    ok,
    status,
    headers: { get: (name: string) => (name === "content-length" ? String(JSON.stringify(body).length) : null) },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe("federation sync push — Presence sender (flair#2578 slice 2)", () => {
  let captured: Array<{ url: string; body?: any; method?: string }> = [];
  let presenceRows: any[] = [];
  let syncStatus = 200;

  beforeAll(() => keystore.setPrivateKeySeed(INSTANCE_ID, testKp.secretKey.slice(0, 32)));
  afterAll(() => {
    const keyFile = join(homedir(), ".flair", "keys", `${INSTANCE_ID}.key`);
    if (existsSync(keyFile)) rmSync(keyFile, { force: true });
  });
  afterEach(() => {
    globalThis.fetch = origFetch;
    delete process.env[PRESENCE_SEND_FLAG_ENV];
  });

  function installMock(opts: { presenceLastSyncAt?: string } = {}) {
    captured = [];
    presenceRows = [];
    syncStatus = 200;
    globalThis.fetch = mock(async (urlInput: string | URL | Request, init?: RequestInit) => {
      const url = typeof urlInput === "string" ? urlInput : urlInput.toString();
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      captured.push({ url, body, method });

      if (method === "GET" && url.includes("/FederationPeers")) {
        return res(true, 200, {
          peers: [{ id: HUB, role: "hub", status: "connected", endpoint: "http://hub:9926", lastSyncAt: SINCE, presenceLastSyncAt: opts.presenceLastSyncAt }],
        });
      }
      if (method === "GET" && url.includes("/FederationInstance")) {
        return res(true, 200, { id: INSTANCE_ID, publicKey: publicKeyB64url, role: "spoke" });
      }
      if (body?.operation === "search_by_conditions") return res(true, 200, []);
      if (body?.operation === "sql") return res(true, 200, presenceRows);
      if (body?.operation === "search_by_value") return res(true, 200, []);
      if (body?.operation === "update" || body?.operation === "upsert") {
        return res(true, 200, { update_hashes: [body.records?.[0]?.id].filter(Boolean) });
      }
      if (method === "POST" && url.includes("/FederationSync")) {
        if (syncStatus !== 200) return res(false, syncStatus, { error: "refused" });
        const records = body?.records ?? [];
        return res(true, 200, { merged: records.length, skipped: 0 });
      }
      throw new Error(`Unexpected fetch call: ${method} ${url} body=${JSON.stringify(body)}`);
    }) as any;
  }

  async function run() {
    const { runFederationSyncOnce } = await import("../../src/cli");
    return runFederationSyncOnce({ adminPass: "test-admin-pass", opsPort: "9100" });
  }

  const pushed = () => {
    const out: any[] = [];
    for (const c of captured) if (c.url.includes("/FederationSync") && c.method === "POST") out.push(...(c.body?.records ?? []));
    return out;
  };
  const presenceRecords = () => pushed().filter((r) => r.table === "Presence");
  const presenceUpdates = () =>
    captured.filter((c) => c.body?.operation === "update" && c.body?.records?.[0]?.presenceLastSyncAt !== undefined);

  const homeRow = (over: Record<string, unknown> = {}) => ({
    agentId: "agent-a",
    lastHeartbeatAt: Date.now(),
    activity: "coding",
    originatorInstanceId: INSTANCE_ID,
    ...over,
  });

  it("flag OFF: sends nothing and never scans the Presence table", async () => {
    installMock();
    presenceRows = [homeRow()];
    const result = await run();
    expect(result.error).toBeUndefined();
    expect(presenceRecords()).toEqual([]);
    expect(captured.some((c) => c.body?.operation === "sql")).toBe(false);
    expect(presenceUpdates()).toEqual([]);
  });

  it("flag ON: a home row is pushed as a signed v:2 Presence record keyed on agentId", async () => {
    process.env[PRESENCE_SEND_FLAG_ENV] = "1";
    installMock();
    presenceRows = [homeRow()];
    const result = await run();
    expect(result.error).toBeUndefined();

    const records = presenceRecords();
    expect(records.length).toBe(1);
    const record = records[0];
    expect(record.id).toBe("agent-a");
    expect(record.data.id).toBe("agent-a");
    expect(record.data.agentId).toBe("agent-a");
    expect(record.originatorInstanceId).toBe(INSTANCE_ID);
    expect(record.v).toBe(2);
    expect(typeof record.signature).toBe("string");
    expect(verifyBodySignature(reconstructRecordVerifyBody(record, INSTANCE_ID), publicKeyB64url)).toBe(true);
  });

  it("flag ON: a non-home row is never pushed", async () => {
    process.env[PRESENCE_SEND_FLAG_ENV] = "1";
    installMock();
    presenceRows = [homeRow({ agentId: "agent-x", originatorInstanceId: "flair_other" }), homeRow({ originatorInstanceId: null })];
    const result = await run();
    expect(result.error).toBeUndefined();
    expect(presenceRecords()).toEqual([]);
  });

  it("flag ON: an unchanged row (at or below the watermark) is not re-sent", async () => {
    process.env[PRESENCE_SEND_FLAG_ENV] = "1";
    const heartbeat = Date.now();
    installMock({ presenceLastSyncAt: new Date(heartbeat).toISOString() });
    presenceRows = [homeRow({ lastHeartbeatAt: heartbeat })];
    const result = await run();
    expect(result.error).toBeUndefined();
    expect(presenceRecords()).toEqual([]);
  });

  it("flag ON: a confirmed batch advances the watermark to the newest sent cursor", async () => {
    process.env[PRESENCE_SEND_FLAG_ENV] = "1";
    const oldest = Date.now() - 5_000;
    const newest = Date.now();
    installMock({ presenceLastSyncAt: SINCE });
    presenceRows = [homeRow({ agentId: "agent-a", lastHeartbeatAt: oldest }), homeRow({ agentId: "agent-b", lastHeartbeatAt: newest })];
    const result = await run();
    expect(result.error).toBeUndefined();

    const updates = presenceUpdates();
    expect(updates.length).toBe(1);
    expect(updates[0].body.records[0].id).toBe(HUB);
    expect(updates[0].body.records[0].presenceLastSyncAt).toBe(new Date(newest).toISOString());
  });

  it("flag ON: a failed batch does not advance the watermark", async () => {
    process.env[PRESENCE_SEND_FLAG_ENV] = "1";
    installMock({ presenceLastSyncAt: SINCE });
    syncStatus = 500;
    presenceRows = [homeRow()];
    const result = await run();
    expect(result.error).toBeDefined();
    expect(presenceUpdates()).toEqual([]);
  });
});
