/**
 * federation-sync-push-presence-2578.test.ts — flair#2578 slice 2, the Presence
 * SENDER driven through the real push path (runFederationSyncOnce) with the
 * network mocked.
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
  let syncRefused: Array<{ table: string; id: string; reason: string }> = [];
  let syncIndeterminate: Array<{ table: string; id: string }> = [];
  let syncMergedDelta = 0;
  let syncResponse: Record<string, unknown> | undefined;
  let genericRows: any[] = [];

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
    syncRefused = [];
    syncIndeterminate = [];
    syncMergedDelta = 0;
    syncResponse = undefined;
    genericRows = [];
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
      if (body?.operation === "search_by_conditions") {
        return res(true, 200, body.conditions[0].search_type === "greater_than" ? genericRows : []);
      }
      if (body?.operation === "sql") return res(true, 200, presenceRows);
      if (body?.operation === "search_by_value") return res(true, 200, []);
      if (body?.operation === "update" || body?.operation === "upsert") {
        return res(true, 200, { update_hashes: [body.records?.[0]?.id].filter(Boolean) });
      }
      if (method === "POST" && url.includes("/FederationSync")) {
        if (syncStatus !== 200) return res(false, syncStatus, { error: "refused" });
        const records = body?.records ?? [];
        return res(true, 200, syncResponse ?? {
          merged: records.length - syncRefused.length - syncIndeterminate.length + syncMergedDelta,
          skipped: syncRefused.length,
          refused: syncRefused,
          indeterminate: syncIndeterminate,
          total: records.length,
        });
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

  for (const table of ["Memory", "Soul", "Agent", "Relationship"]) {
    it(`flag OFF: accepts legacy merged/skipped counts without refusal lists for ${table}`, async () => {
      installMock();
      genericRows = [{ id: "legacy-a", updatedAt: new Date().toISOString() }];
      syncResponse = { merged: 0, skipped: 1 };
      // Offer a row only for this table.
      const fetchMock = globalThis.fetch;
      globalThis.fetch = mock(async (url: any, init?: RequestInit) => {
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        if (body?.operation === "search_by_conditions" && body.table !== table) return res(true, 200, []);
        return fetchMock(url, init);
      }) as any;
      const result = await run();
      expect(result.error).toBeUndefined();
      expect(result.pushed).toBe(0);
      expect(result.skipped).toBe(1);
      expect(pushed().map((record) => record.table)).toEqual([table]);
      expect(presenceUpdates()).toEqual([]);
      expect(captured.some((call) => call.body?.operation === "sql")).toBe(false);
    });
  }

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

  it("flag ON: an unchanged row far below the re-scan overlap is not re-sent", async () => {
    process.env[PRESENCE_SEND_FLAG_ENV] = "1";
    const watermark = Date.now();
    // 60 s behind the watermark: outside the 30 s re-scan overlap.
    installMock({ presenceLastSyncAt: new Date(watermark).toISOString() });
    presenceRows = [homeRow({ lastHeartbeatAt: watermark - 60_000 })];
    const result = await run();
    expect(result.error).toBeUndefined();
    expect(presenceRecords()).toEqual([]);
    expect(presenceUpdates()).toEqual([]);
  });

  it("flag ON: a row below the watermark but inside the overlap is re-offered (F2)", async () => {
    process.env[PRESENCE_SEND_FLAG_ENV] = "1";
    const h1 = Date.now() - 5_000;
    installMock({ presenceLastSyncAt: SINCE });
    presenceRows = [homeRow({ agentId: "agent-a", lastHeartbeatAt: h1 })];
    const r1 = await run();
    expect(r1.error).toBeUndefined();
    const updates1 = presenceUpdates();
    expect(updates1.length).toBe(1);

    // A row stamped 1 s before the saved watermark (it committed after run 1's
    // SQL read) is below the watermark, so only the overlap re-offers it.
    const h2 = h1 - 1_000;
    installMock({ presenceLastSyncAt: updates1[0].body.records[0].presenceLastSyncAt });
    presenceRows = [homeRow({ agentId: "agent-a", lastHeartbeatAt: h1 }), homeRow({ agentId: "agent-b", lastHeartbeatAt: h2 })];
    const r2 = await run();
    expect(r2.error).toBeUndefined();
    expect(presenceRecords().map((r) => r.id)).toContain("agent-b");
  });

  it("flag ON: a retryable refusal holds the watermark below that row and re-offers it (F1)", async () => {
    process.env[PRESENCE_SEND_FLAG_ENV] = "1";
    const hb = Date.now();
    installMock({ presenceLastSyncAt: SINCE });
    syncRefused = [{ table: "Presence", id: "agent-a", reason: "presence_agent_not_replicated" }];
    presenceRows = [homeRow({ agentId: "agent-a", lastHeartbeatAt: hb })];
    const r1 = await run();
    expect(r1.error).toBeUndefined();
    // The record was offered...
    expect(presenceRecords().map((r) => r.id)).toEqual(["agent-a"]);
    // ...and the refusal held the watermark strictly below its cursor.
    const updates1 = presenceUpdates();
    expect(updates1.length).toBe(1);
    const saved = Date.parse(updates1[0].body.records[0].presenceLastSyncAt);
    expect(Number.isFinite(saved)).toBe(true);
    expect(saved).toBeLessThan(hb);

    // Next pass: the hub now has the Agent row, and the row is offered again.
    installMock({ presenceLastSyncAt: updates1[0].body.records[0].presenceLastSyncAt });
    presenceRows = [homeRow({ agentId: "agent-a", lastHeartbeatAt: hb })];
    const r2 = await run();
    expect(r2.error).toBeUndefined();
    expect(presenceRecords().map((r) => r.id)).toEqual(["agent-a"]);
  });

  it("flag ON: newer confirmed cursors advance the watermark", async () => {
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

  it("flag ON: a far-future row is not sent, and the watermark never passes the scan time", async () => {
    process.env[PRESENCE_SEND_FLAG_ENV] = "1";
    installMock({ presenceLastSyncAt: SINCE });
    const now = Date.now();
    const farFuture = now + 1e9; // far beyond the receiver's 5-minute future allowance
    const normal = now - 1_000;
    presenceRows = [
      homeRow({ agentId: "agent-future", lastHeartbeatAt: farFuture }),
      homeRow({ agentId: "agent-normal", lastHeartbeatAt: normal }),
    ];
    const result = await run();
    const scanAfter = Date.now();
    expect(result.error).toBeUndefined();

    // The far-future row is left out of the batch entirely.
    expect(presenceRecords().map((r) => r.id)).toEqual(["agent-normal"]);
    // The watermark advanced to the sent row's cursor, never past the scan time.
    const updates = presenceUpdates();
    expect(updates.length).toBe(1);
    const saved = Date.parse(updates[0].body.records[0].presenceLastSyncAt);
    expect(Number.isFinite(saved)).toBe(true);
    expect(saved).toBeLessThanOrEqual(scanAfter);
    expect(saved).toBe(normal);

    // Second run: only the normal row's heartbeat moved forward — to a stamp
    // ahead of the clock, still inside the allowance. It is pushed, and the
    // watermark advances only to the scan time, not to the row's future stamp.
    installMock({ presenceLastSyncAt: updates[0].body.records[0].presenceLastSyncAt });
    const movedForward = now + 60_000;
    presenceRows = [
      homeRow({ agentId: "agent-future", lastHeartbeatAt: farFuture }),
      homeRow({ agentId: "agent-normal", lastHeartbeatAt: movedForward }),
    ];
    const result2 = await run();
    const scanAfter2 = Date.now();
    expect(result2.error).toBeUndefined();
    expect(presenceRecords().map((r) => r.id)).toEqual(["agent-normal"]);

    const updates2 = presenceUpdates();
    expect(updates2.length).toBe(1);
    const saved2 = Date.parse(updates2[0].body.records[0].presenceLastSyncAt);
    expect(Number.isFinite(saved2)).toBe(true);
    expect(saved2).toBeLessThanOrEqual(scanAfter2);
    expect(saved2).toBeLessThan(movedForward);
  });

  it("flag ON: an indeterminate row holds the watermark below it and is re-offered (B1)", async () => {
    process.env[PRESENCE_SEND_FLAG_ENV] = "1";
    const hb = Date.now();
    installMock({ presenceLastSyncAt: SINCE });
    syncIndeterminate = [{ table: "Presence", id: "agent-a" }];
    presenceRows = [homeRow({ agentId: "agent-a", lastHeartbeatAt: hb })];
    const r1 = await run();
    expect(r1.error).toBeUndefined();
    expect(presenceRecords().map((r) => r.id)).toEqual(["agent-a"]);
    // The un-decided row is treated as a retryable refusal: the saved
    // watermark stays strictly below its cursor.
    const updates1 = presenceUpdates();
    expect(updates1.length).toBe(1);
    const saved = Date.parse(updates1[0].body.records[0].presenceLastSyncAt);
    expect(Number.isFinite(saved)).toBe(true);
    expect(saved).toBeLessThan(hb);

    // Next pass: the overlap selects the row again and it is re-offered.
    installMock({ presenceLastSyncAt: updates1[0].body.records[0].presenceLastSyncAt });
    presenceRows = [homeRow({ agentId: "agent-a", lastHeartbeatAt: hb })];
    const r2 = await run();
    expect(r2.error).toBeUndefined();
    expect(presenceRecords().map((r) => r.id)).toEqual(["agent-a"]);
  });

  it("flag ON: an indeterminate key outside the offered batch leaves the watermark unchanged", async () => {
    process.env[PRESENCE_SEND_FLAG_ENV] = "1";
    installMock({ presenceLastSyncAt: SINCE });
    presenceRows = [homeRow()];
    syncResponse = { merged: 0, skipped: 0, indeterminate: [{ table: "Presence", id: "other" }] };
    const result = await run();
    expect(presenceRecords().map((record) => record.id)).toEqual(["agent-a"]);
    expect(presenceUpdates()).toEqual([]);
    expect(result.error).toBeDefined();
  });

  for (const [name, response] of [
    ["wrong refusal id", { merged: 1, skipped: 1, refused: [{ table: "Presence", id: "other", reason: "merge_error" }] }],
    ["wrong table", { merged: 1, skipped: 0, indeterminate: [{ table: "Agent", id: "agent-a" }] }],
    ["duplicate refusals", { merged: 0, skipped: 2, refused: [{ table: "Presence", id: "agent-a", reason: "merge_error" }, { table: "Presence", id: "agent-a", reason: "merge_error" }] }],
    ["duplicate indeterminate keys", { merged: 0, skipped: 0, indeterminate: [{ table: "Presence", id: "agent-a" }, { table: "Presence", id: "agent-a" }] }],
    ["key in both outcome lists", { merged: 0, skipped: 1, refused: [{ table: "Presence", id: "agent-a", reason: "merge_error" }], indeterminate: [{ table: "Presence", id: "agent-a" }] }],
    ["skipped/refused mismatch", { merged: 1, skipped: 0, refused: [{ table: "Presence", id: "agent-a", reason: "merge_error" }] }],
    ["malformed entry", { merged: 2, skipped: 0, indeterminate: [{ table: "Presence" }] }],
  ] as const) {
    it(`flag ON: ${name} resolves nothing in the Presence batch`, async () => {
      process.env[PRESENCE_SEND_FLAG_ENV] = "1";
      installMock({ presenceLastSyncAt: SINCE });
      presenceRows = [homeRow(), homeRow({ agentId: "agent-b" })];
      syncResponse = response;
      const result = await run();
      expect(result.error).toBeDefined();
      expect(result.pushed).toBe(0);
      expect(result.skipped).toBe(0);
      expect(presenceUpdates()).toEqual([]);
    });
  }

  it("flag ON: a response that does not account for every record saves no watermark (B1)", async () => {
    process.env[PRESENCE_SEND_FLAG_ENV] = "1";
    installMock({ presenceLastSyncAt: SINCE });
    syncMergedDelta = -1;
    presenceRows = [homeRow({ lastHeartbeatAt: Date.now() })];
    const result = await run();
    expect(result.error).toBeDefined();
    expect(presenceUpdates()).toEqual([]);
  });

  it("flag ON: confirmed contact clamps a stored future watermark to scan time (B5)", async () => {
    process.env[PRESENCE_SEND_FLAG_ENV] = "1";
    const now = Date.now();
    // A watermark an hour ahead would suppress the current row if the scan
    // floor used it unchanged.
    const futureWatermark = now + 3_600_000;
    const rowCursor = now - 1_000;
    installMock({ presenceLastSyncAt: new Date(futureWatermark).toISOString() });
    presenceRows = [homeRow({ lastHeartbeatAt: rowCursor })];
    const result = await run();
    const scanAfter = Date.now();
    expect(result.error).toBeUndefined();
    // The clamp is applied before selection: the current row is still offered.
    expect(presenceRecords().map((r) => r.id)).toEqual(["agent-a"]);

    const updates = presenceUpdates();
    expect(updates.length).toBe(1);
    const saved = Date.parse(updates[0].body.records[0].presenceLastSyncAt);
    expect(Number.isFinite(saved)).toBe(true);
    expect(saved).toBeLessThanOrEqual(scanAfter);
    expect(saved).toBeLessThan(futureWatermark);
  });

  it("flag ON: a successful ping saves the future watermark clamp with no rows sent (B5)", async () => {
    process.env[PRESENCE_SEND_FLAG_ENV] = "1";
    const now = Date.now();
    const futureWatermark = now + 3_600_000;
    installMock({ presenceLastSyncAt: new Date(futureWatermark).toISOString() });
    // Older than the 30 s overlap, so this pass sends no Presence row.
    presenceRows = [homeRow({ lastHeartbeatAt: now - 120_000 })];
    const result = await run();
    const scanAfter = Date.now();
    expect(result.error).toBeUndefined();
    expect(presenceRecords()).toEqual([]);

    const updates = presenceUpdates();
    expect(updates.length).toBe(1);
    const saved = Date.parse(updates[0].body.records[0].presenceLastSyncAt);
    expect(Number.isFinite(saved)).toBe(true);
    expect(saved).toBeLessThanOrEqual(scanAfter);
    expect(saved).toBeLessThan(futureWatermark);
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
