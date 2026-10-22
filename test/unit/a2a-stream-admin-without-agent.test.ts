/**
 * a2a-stream-admin-without-agent.test.ts — A2AAdapter message/stream refusal
 * for an admin-flagged caller that carries no agent id.
 *
 * message/stream reads catch-up events AS the caller, so the caller's agent id
 * is required even when the request is admin-flagged. A2AAdapter.post() refuses
 * such a request with JSON-RPC -32001 before building the stream's reader.
 * These cases pin the refusal code and that no catch-up read is started.
 */
import { describe, expect, it, mock } from "bun:test";

mock.module("harper", () => ({
  server: { http: () => {}, getUser: async () => null },
  databases: { flair: {} },
  Resource: class {},
}));

const { A2AAdapter } = await import("../../resources/A2AAdapter");
const { OrgEventCatchup } = await import("../../resources/OrgEventCatchup");

type RpcFailure = { jsonrpc: string; id: unknown; error: { code: number; message: string; data?: any } };

/** Count catch-up reads while `run` executes, restoring the real method after. */
async function withoutCatchupReads(run: () => Promise<unknown>): Promise<{ result: unknown; reads: number }> {
  const original = (OrgEventCatchup as any).get;
  let reads = 0;
  (OrgEventCatchup as any).get = async () => {
    reads++;
    return { events: [], nextAfter: null, hasMore: false };
  };
  try {
    const result = await run();
    return { result, reads };
  } finally {
    (OrgEventCatchup as any).get = original;
  }
}

describe("A2AAdapter message/stream — admin flag without a caller agent id", () => {
  it("refuses with -32001 and starts no catch-up read", async () => {
    const adapter = new A2AAdapter();
    const { result, reads } = await withoutCatchupReads(() =>
      adapter.post(
        { jsonrpc: "2.0", id: 42, method: "message/stream", params: { agentId: "agent-b" } },
        { request: { tpsAgentIsAdmin: true } },
      ),
    );

    // A stream would be a Response; a refusal is a JSON-RPC error body.
    expect(result).not.toBeInstanceOf(Response);
    const failure = result as RpcFailure;
    expect(failure.error.code).toBe(-32001);
    expect(failure.error.message).toBe("Forbidden");
    expect(failure.error.data?.detail).toBe("caller (anon) cannot stream as agent-b");
    expect(reads).toBe(0);
  });
});
