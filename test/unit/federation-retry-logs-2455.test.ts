// flair#2455 rev 2.1 N2 — the sender never logs receiver-authored text.
//
// This mocks the wire and asserts that the receiver's text reaches neither the
// returned error nor any console output, for four responses: a 403 batch of
// one record (not retried), a 503 liveness ping, a 200 whose `merged`/`skipped`
// are not counts, and a 200 whose body is not JSON.
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import nacl from "tweetnacl";

const origFetch = globalThis.fetch;
const SECRET = "RECEIVER-BODY-SECRET-2455";

/** A minimal Response whose body carries a distinctive string. */
function res(ok: boolean, status: number, body: any) {
  return {
    ok,
    status,
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/**
 * A 200 over raw text whose `.json()` throws the runtime JSON parser's own
 * error. Node's `Response.json()` quotes the start of the body in that error
 * (`Unexpected token 'R', "RECEIVER-B"... is not valid JSON`); Bun's
 * `JSON.parse` quotes the identifier. Bun's `Response.json()` does not, so the
 * parser is called directly to reproduce what the CLI sees under Node.
 */
function rawRes(status: number, text: string) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => "application/json" },
    json: async () => JSON.parse(text),
    text: async () => text,
  } as unknown as Response;
}

const kp = nacl.sign.keyPair();

describe("flair#2455 N2 — the sender logs no receiver-authored text", () => {
  let logs: string[];
  let spies: ReturnType<typeof spyOn>[];

  beforeEach(() => {
    logs = [];
    const record = (...args: unknown[]) => { logs.push(args.map((a) => String(a)).join(" ")); };
    spies = [
      spyOn(console, "log").mockImplementation(record),
      spyOn(console, "warn").mockImplementation(record),
      spyOn(console, "error").mockImplementation(record),
    ];
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    for (const s of spies) s.mockRestore();
  });

  function installMock(opts: {
    rows?: number;
    batchStatus: number;
    pingStatus: number;
    /** The body of a 200 batch response (default: the receiver text as an error). */
    batchBody?: unknown;
    /** A raw, non-JSON text body for a 200 batch response. */
    batchRaw?: string;
  }) {
    let advanced = false;
    globalThis.fetch = mock(async (urlInput: string | URL | Request, init?: RequestInit) => {
      const url = typeof urlInput === "string" ? urlInput : urlInput.toString();
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;

      if (method === "GET" && url.includes("/FederationPeers")) {
        return res(true, 200, { peers: [{ id: "hub-a", role: "hub", status: "connected", endpoint: "http://hub-a.invalid:9926", lastSyncAt: "2025-01-01T00:00:00.000Z" }] });
      }
      if (method === "GET" && url.includes("/FederationInstance")) {
        return res(true, 200, { id: "spoke-a", publicKey: Buffer.from(kp.publicKey).toString("base64url"), role: "spoke" });
      }
      if (body?.operation === "search_by_conditions") {
        if (!advanced) advanced = true;
        if (body.table !== "Memory" || body.conditions?.[0]?.search_value === null) return res(true, 200, []);
        return res(true, 200, Array.from({ length: opts.rows ?? 0 }, (_, i) => ({
          id: `row-${i}`, agentId: "agent-a", content: `c${i}`, contentHash: `h${i}`,
          instanceToken: `t${i}`, durability: "persistent", visibility: "shared", archived: false,
          createdAt: new Date(Date.now() - 60_000).toISOString(), updatedAt: new Date().toISOString(),
        })));
      }
      if (body?.operation === "search_by_value" && body.table === "Instance") {
        return res(true, 200, [{ id: "spoke-a", _keySeed: Buffer.from(kp.secretKey.slice(0, 32)).toString("base64url") }]);
      }
      if (method === "POST" && url.includes("/FederationSync")) {
        const sent = (body?.records ?? []).length;
        if (sent > 0) {
          if (opts.batchRaw !== undefined) return rawRes(opts.batchStatus, opts.batchRaw);
          return res(opts.batchStatus === 200, opts.batchStatus, opts.batchBody ?? { error: SECRET });
        }
        return res(opts.pingStatus === 200, opts.pingStatus, { error: SECRET });
      }
      if (body?.operation === "update" && body?.table === "Peer") {
        return res(true, 200, { update_hashes: ["hub-a"], skipped_hashes: [] });
      }
      throw new Error(`Unexpected fetch call: ${method} ${url}`);
    }) as any;
  }

  it("a 403 batch of one record reports the HTTP status only, never the receiver body", async () => {
    installMock({ rows: 1, batchStatus: 403, pingStatus: 200 });
    const { runFederationSyncOnce } = await import("../../src/cli");
    const result = await runFederationSyncOnce({ adminPass: "test-admin-pass", opsPort: "9925" });

    expect(result.error, "the batch failure must surface").toBeDefined();
    expect(String(result.error?.message)).toContain("403");
    expect(String(result.error?.message)).not.toContain(SECRET);
    expect(logs.join("\n")).not.toContain(SECRET);
  });

  it("a 503 liveness ping reports the HTTP status only, never the receiver body", async () => {
    installMock({ rows: 0, batchStatus: 200, pingStatus: 503 });
    const { runFederationSyncOnce } = await import("../../src/cli");
    const result = await runFederationSyncOnce({ adminPass: "test-admin-pass", opsPort: "9925" });

    expect(result.error).toBeUndefined();
    expect(logs.join("\n")).toContain("503");
    expect(logs.join("\n")).not.toContain(SECRET);
  });

  it("a 200 whose counts are receiver text is an invalid response, reported in local text only", async () => {
    installMock({
      rows: 1,
      batchStatus: 200,
      pingStatus: 200,
      batchBody: { merged: SECRET, skipped: `${SECRET}-skipped`, total: 1 },
    });
    const { runFederationSyncOnce } = await import("../../src/cli");
    const result = await runFederationSyncOnce({ adminPass: "test-admin-pass", opsPort: "9925" });

    expect(logs.join("\n")).not.toContain(SECRET);
    expect(String(result.pushed)).not.toContain(SECRET);
    expect(String(result.skipped)).not.toContain(SECRET);
    expect(result.error, "an invalid response must surface as an error").toBeDefined();
    expect(String(result.error?.message)).toContain("invalid response");
    expect(String(result.error?.message)).not.toContain(SECRET);
  });

  it("a 200 whose body is not JSON is reported in local text only, never the parser's quote of it", async () => {
    installMock({ rows: 1, batchStatus: 200, pingStatus: 200, batchRaw: `${SECRET} not json` });
    const { runFederationSyncOnce } = await import("../../src/cli");
    const result = await runFederationSyncOnce({ adminPass: "test-admin-pass", opsPort: "9925" });

    // The part of the body the runtime's JSON parser quotes back ("RECEIVER-B…"
    // on Node, the identifier "RECEIVER" on Bun) must not appear anywhere.
    expect(logs.join("\n")).not.toContain("RECEIVER");
    expect(result.error).toBeDefined();
    expect(String(result.error?.message)).not.toContain("RECEIVER");
    expect(String(result.error?.message)).toContain("invalid response");
  });

  it("a valid 200 still syncs and logs its numeric counts", async () => {
    installMock({ rows: 1, batchStatus: 200, pingStatus: 200, batchBody: { merged: 1, skipped: 0, total: 1 } });
    const { runFederationSyncOnce } = await import("../../src/cli");
    const result = await runFederationSyncOnce({ adminPass: "test-admin-pass", opsPort: "9925" });

    expect(result.error).toBeUndefined();
    expect(result.pushed).toBe(1);
    expect(result.skipped).toBe(0);
    expect(logs.join("\n")).toContain("Synced 1 records (0 skipped)");
  });
});

describe("flair#2455 — parseSyncBatchCounts accepts only bounded non-negative integer counts", () => {
  it("accepts integer counts within the batch size", async () => {
    const { parseSyncBatchCounts } = await import("../../src/commands/federation");
    expect(parseSyncBatchCounts({ merged: 3, skipped: 2, total: 5 }, 5)).toEqual({ merged: 3, skipped: 2 });
    expect(parseSyncBatchCounts({ merged: 0, skipped: 0 }, 1)).toEqual({ merged: 0, skipped: 0 });
  });

  it("rejects a non-object, a missing count, text, a fraction, a negative and an over-bound count", async () => {
    const { parseSyncBatchCounts } = await import("../../src/commands/federation");
    for (const body of [
      null,
      "3",
      [3, 2],
      { merged: 1 },
      { skipped: 1 },
      { merged: "1", skipped: 0 },
      { merged: 1, skipped: "0" },
      { merged: 1.5, skipped: 0 },
      { merged: -1, skipped: 0 },
      { merged: 6, skipped: 0 },
      { merged: 0, skipped: 6 },
      { merged: Number.NaN, skipped: 0 },
      { merged: Number.POSITIVE_INFINITY, skipped: 0 },
    ]) {
      expect(parseSyncBatchCounts(body, 5), JSON.stringify(body)).toBeNull();
    }
  });
});
