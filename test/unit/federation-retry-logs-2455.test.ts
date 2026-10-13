// flair#2455 rev 2.1 N2 — the sender must never log a receiver-authored response
// body. Two lines did: the batch failure (`Sync batch failed: <status> <body>`,
// surfaced by the watch loop) and the failed-liveness-ping warning.
//
// This mocks the wire and asserts the receiver's body text reaches neither the
// returned error nor any console output.
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

const kp = nacl.sign.keyPair();

describe("flair#2455 N2 — the sender logs no receiver response body", () => {
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

  function installMock(opts: { rows?: number; batchStatus: number; pingStatus: number }) {
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
          return res(opts.batchStatus === 200, opts.batchStatus, { error: SECRET });
        }
        return res(opts.pingStatus === 200, opts.pingStatus, { error: SECRET });
      }
      if (body?.operation === "update" && body?.table === "Peer") {
        return res(true, 200, { update_hashes: ["hub-a"], skipped_hashes: [] });
      }
      throw new Error(`Unexpected fetch call: ${method} ${url}`);
    }) as any;
  }

  it("a non-2xx batch logs the status class only — never the receiver body", async () => {
    installMock({ rows: 1, batchStatus: 403, pingStatus: 200 });
    const { runFederationSyncOnce } = await import("../../src/cli");
    const result = await runFederationSyncOnce({ adminPass: "test-admin-pass", opsPort: "9925" });

    expect(result.error, "the batch failure must surface").toBeDefined();
    expect(String(result.error?.message)).toContain("403");
    expect(String(result.error?.message)).not.toContain(SECRET);
    expect(logs.join("\n")).not.toContain(SECRET);
  });

  it("a failed liveness ping logs the status class only — never the receiver body", async () => {
    installMock({ rows: 0, batchStatus: 200, pingStatus: 503 });
    const { runFederationSyncOnce } = await import("../../src/cli");
    const result = await runFederationSyncOnce({ adminPass: "test-admin-pass", opsPort: "9925" });

    expect(result.error).toBeUndefined();
    expect(logs.join("\n")).toContain("503");
    expect(logs.join("\n")).not.toContain(SECRET);
  });
});
