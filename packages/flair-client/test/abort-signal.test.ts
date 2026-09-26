/**
 * The caller abort signal, combined with the per-request timeout and forwarded
 * to the fetch (flair#1884). Covers the `AbortSignal.any` fallback this package
 * needs for its `engines.node: ">=18"` floor (`any` is Node ≥ 20.3), and round 3
 * item 4: the fallback's listeners on the caller's long-lived signal are removed
 * when the request settles, on every path, so a listener cannot leak per
 * request.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";

const originalFetch = globalThis.fetch;
const originalAny = (AbortSignal as any).any;

let lastInit: any;
let releaseFetch: (() => void) | null = null;

function deferredFetch(): void {
  releaseFetch = null;
  const gate = new Promise<void>((r) => {
    releaseFetch = () => r();
  });
  globalThis.fetch = (async (_url: string, init: any = {}) => {
    lastInit = init;
    await gate;
    return new Response("{}", { status: 200 });
  }) as any;
}

beforeEach(() => {
  lastInit = undefined;
  releaseFetch = null;
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

/** Counts add/removeEventListener on the underlying signal (EventTarget hides it). */
class CountingSignal {
  adds = 0;
  removes = 0;
  constructor(private inner: AbortSignal) {}
  get aborted(): boolean {
    return this.inner.aborted;
  }
  get reason(): unknown {
    return this.inner.reason;
  }
  addEventListener(type: string, fn: any, opts?: any): void {
    this.adds++;
    this.inner.addEventListener(type as any, fn, opts);
  }
  removeEventListener(type: string, fn: any, opts?: any): void {
    this.removes++;
    this.inner.removeEventListener(type as any, fn, opts);
  }
}

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
    deferredFetch();
    const client = new FlairClient({ agentId: "test" });
    const ctrl = new AbortController();
    const pending = client.request("GET", "/Health", undefined, { signal: ctrl.signal });
    while (!lastInit) await new Promise((r) => setTimeout(r, 1));
    expect(lastInit.signal.aborted).toBe(false);
    ctrl.abort(); // while the request is IN FLIGHT
    expect(lastInit.signal.aborted).toBe(true);
    releaseFetch?.();
    await pending;
  });

  test("the fallback honours an ALREADY-aborted caller signal", async () => {
    (AbortSignal as any).any = undefined;
    const client = new FlairClient({ agentId: "test" });
    const ctrl = new AbortController();
    ctrl.abort();
    await client.request("GET", "/Health", undefined, { signal: ctrl.signal });
    expect(lastInit.signal.aborted).toBe(true);
  });

  test("item 4: 1,000 sequential requests leave no listener on the caller's signal", async () => {
    (AbortSignal as any).any = undefined; // exercise the hand-linked fallback
    const client = new FlairClient({ agentId: "test" });
    const counting = new CountingSignal(new AbortController().signal);
    for (let i = 0; i < 1000; i++) {
      await client.request("GET", "/Health", undefined, { signal: counting as unknown as AbortSignal });
    }
    expect(counting.adds).toBe(1000);
    expect(counting.removes).toBe(1000); // every listener removed → back to baseline
    expect(counting.adds - counting.removes).toBe(0);
  });
});
