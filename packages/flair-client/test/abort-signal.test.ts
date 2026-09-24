/**
 * The caller abort signal, combined with the per-request timeout and forwarded
 * to the fetch (flair#1884 round 2). Covers the `AbortSignal.any` fallback this
 * package needs for its `engines.node: ">=18"` floor — `AbortSignal.any` only
 * exists from Node 20.3, so a caller passing `opts.signal` on Node 18 must not
 * crash before the fetch.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";

const originalFetch = globalThis.fetch;
const originalAny = (AbortSignal as any).any;

let lastInit: any;

beforeEach(() => {
  lastInit = undefined;
  globalThis.fetch = ((_url: string, init: any = {}) => {
    lastInit = init;
    return Promise.resolve(new Response("{}", { status: 200 }));
  }) as any;
  (AbortSignal as any).any = originalAny;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  (AbortSignal as any).any = originalAny;
});

const { FlairClient } = await import("../src/client.js");

describe("caller abort signal reaches the fetch (flair#1884)", () => {
  test("opts.signal is combined with the timeout and passed to fetch", async () => {
    const client = new FlairClient({ agentId: "test" });
    const ctrl = new AbortController();
    await client.request("GET", "/Health", undefined, { signal: ctrl.signal });
    expect(lastInit.signal).toBeInstanceOf(AbortSignal);
    expect(lastInit.signal.aborted).toBe(false);
    ctrl.abort();
    expect(lastInit.signal.aborted).toBe(true);
  });

  test("without a caller signal the timeout signal is used unchanged", async () => {
    const client = new FlairClient({ agentId: "test" });
    await client.request("GET", "/Health");
    expect(lastInit.signal).toBeInstanceOf(AbortSignal);
    expect(lastInit.signal.aborted).toBe(false);
  });

  test("links the signals when AbortSignal.any is unavailable (Node 18)", async () => {
    (AbortSignal as any).any = undefined;
    const client = new FlairClient({ agentId: "test" });
    const ctrl = new AbortController();
    await client.request("GET", "/Health", undefined, { signal: ctrl.signal });
    expect(lastInit.signal.aborted).toBe(false);
    ctrl.abort();
    expect(lastInit.signal.aborted).toBe(true);
  });

  test("the fallback honours an ALREADY-aborted caller signal", async () => {
    (AbortSignal as any).any = undefined;
    const client = new FlairClient({ agentId: "test" });
    const ctrl = new AbortController();
    ctrl.abort();
    await client.request("GET", "/Health", undefined, { signal: ctrl.signal });
    expect(lastInit.signal.aborted).toBe(true);
  });
});
