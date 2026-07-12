/**
 * version-handshake.test.ts — src/version-handshake.ts, the CLI↔server
 * version handshake (ops-1l18 §B). Mirrors test/unit/version-check.test.ts's
 * technique (injected fetch/cache/clock) for the sibling "installed vs
 * latest-published" checker.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  checkServerHandshake,
  formatHandshakeNudge,
  DEFAULT_HANDSHAKE_TTL_MS,
  type HandshakeDeps,
} from "../../src/version-handshake.ts";

let cacheDir: string;

beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), "flair-handshake-test-"));
});

afterEach(() => {
  rmSync(cacheDir, { recursive: true, force: true });
});

function deps(overrides: Partial<HandshakeDeps> = {}): Partial<HandshakeDeps> {
  return { cacheDir, timeoutMs: 500, ttlMs: DEFAULT_HANDSHAKE_TTL_MS, now: () => 1_000_000, ...overrides };
}

function fetchReturning(version: string | null, ok = true): typeof fetch {
  return (async () =>
    ({
      ok,
      status: ok ? 200 : 500,
      json: async () => (version === null ? {} : { version }),
    }) as unknown as Response) as unknown as typeof fetch;
}

function fetchThrowing(message = "network error"): typeof fetch {
  return (async () => {
    throw new Error(message);
  }) as unknown as typeof fetch;
}

describe("checkServerHandshake — network path", () => {
  it("reports mismatch:false when versions match", async () => {
    const result = await checkServerHandshake("1.2.3", "/root", "http://x", deps({ fetchImpl: fetchReturning("1.2.3") }));
    expect(result.mismatch).toBe(false);
    expect(result.runningVersion).toBe("1.2.3");
    expect(result.source).toBe("network");
  });

  it("reports mismatch:true when the running version differs", async () => {
    const result = await checkServerHandshake("1.2.3", "/root", "http://x", deps({ fetchImpl: fetchReturning("1.1.0") }));
    expect(result.mismatch).toBe(true);
    expect(result.runningVersion).toBe("1.1.0");
  });

  it("caches a fetched result so a second call within the TTL does NOT hit the network again", async () => {
    let calls = 0;
    const countingFetch: typeof fetch = (async () => {
      calls++;
      return { ok: true, status: 200, json: async () => ({ version: "1.2.3" }) } as unknown as Response;
    }) as unknown as typeof fetch;

    const d = deps({ fetchImpl: countingFetch, now: () => 1_000_000 });
    await checkServerHandshake("1.2.3", "/root", "http://x", d);
    expect(calls).toBe(1);
    const second = await checkServerHandshake("1.2.3", "/root", "http://x", d);
    expect(calls).toBe(1);
    expect(second.source).toBe("cache");
  });

  it("re-fetches once the TTL has expired", async () => {
    let calls = 0;
    const countingFetch: typeof fetch = (async () => {
      calls++;
      return { ok: true, status: 200, json: async () => ({ version: "1.2.3" }) } as unknown as Response;
    }) as unknown as typeof fetch;

    let now = 1_000_000;
    const d = deps({ fetchImpl: countingFetch, now: () => now, ttlMs: 60_000 });
    await checkServerHandshake("1.2.3", "/root", "http://x", d);
    expect(calls).toBe(1);

    now += 61_000; // past the 60s TTL
    await checkServerHandshake("1.2.3", "/root", "http://x", d);
    expect(calls).toBe(2);
  });
});

describe("checkServerHandshake — never throws, offline-tolerant", () => {
  it("resolves source:'unavailable' (never throws) when the server is unreachable and there's no cache", async () => {
    const result = await checkServerHandshake("1.2.3", "/root", "http://x", deps({ fetchImpl: fetchThrowing() }));
    expect(result.source).toBe("unavailable");
    expect(result.mismatch).toBe(false);
    expect(result.runningVersion).toBeNull();
  });

  it("falls back to a stale cache when the server becomes unreachable after a prior successful check", async () => {
    let now = 1_000_000;
    const d1 = deps({ fetchImpl: fetchReturning("1.1.0"), now: () => now, ttlMs: 1000 });
    await checkServerHandshake("1.2.3", "/root", "http://x", d1);

    now += 2000; // TTL expired — next call must re-fetch, which now fails
    const d2 = { ...d1, fetchImpl: fetchThrowing(), now: () => now };
    const result = await checkServerHandshake("1.2.3", "/root", "http://x", d2);
    expect(result.source).toBe("cache");
    expect(result.runningVersion).toBe("1.1.0");
    expect(result.mismatch).toBe(true);
  });

  it("a non-2xx response resolves like an unreachable server, never throws", async () => {
    const result = await checkServerHandshake("1.2.3", "/root", "http://x", deps({ fetchImpl: fetchReturning(null, false) }));
    expect(result.source).toBe("unavailable");
  });

  it("a malformed JSON body (fetch's .json() rejects) never throws", async () => {
    const badJsonFetch: typeof fetch = (async () =>
      ({ ok: true, status: 200, json: async () => { throw new Error("bad json"); } }) as unknown as Response) as unknown as typeof fetch;
    const result = await checkServerHandshake("1.2.3", "/root", "http://x", deps({ fetchImpl: badJsonFetch }));
    expect(result.source).toBe("unavailable");
  });
});

describe("checkServerHandshake — cache isolation per (rootPath, serverUrl)", () => {
  it("two DIFFERENT rootPaths pointed at the same serverUrl never share a cache entry", async () => {
    const d1 = deps({ fetchImpl: fetchReturning("1.0.0"), now: () => 1_000_000 });
    await checkServerHandshake("1.2.3", "/root-a", "http://x", d1);

    // Same serverUrl, different rootPath — must NOT read /root-a's cache.
    let called = false;
    const d2 = { ...d1, fetchImpl: (async () => { called = true; return { ok: true, status: 200, json: async () => ({ version: "2.0.0" }) } as unknown as Response; }) as unknown as typeof fetch };
    const result = await checkServerHandshake("1.2.3", "/root-b", "http://x", d2);
    expect(called).toBe(true);
    expect(result.runningVersion).toBe("2.0.0");
  });

  it("the SAME (rootPath, serverUrl) pair reuses its cache", async () => {
    let calls = 0;
    const countingFetch: typeof fetch = (async () => {
      calls++;
      return { ok: true, status: 200, json: async () => ({ version: "1.2.3" }) } as unknown as Response;
    }) as unknown as typeof fetch;
    const d = deps({ fetchImpl: countingFetch, now: () => 1_000_000 });
    await checkServerHandshake("1.2.3", "/root-a", "http://x", d);
    await checkServerHandshake("1.2.3", "/root-a", "http://x", d);
    expect(calls).toBe(1);
  });
});

describe("formatHandshakeNudge", () => {
  it("returns the exact spec wording on a mismatch", () => {
    const nudge = formatHandshakeNudge({ cliVersion: "0.23.0", runningVersion: "0.22.1", mismatch: true, source: "network" });
    expect(nudge).toBe("flair 0.23.0 installed but server is running 0.22.1 — run: flair restart");
  });

  it("returns null when there's no mismatch", () => {
    expect(formatHandshakeNudge({ cliVersion: "1.0.0", runningVersion: "1.0.0", mismatch: false, source: "network" })).toBeNull();
  });

  it("returns null when runningVersion is unknown even if mismatch were somehow true", () => {
    expect(formatHandshakeNudge({ cliVersion: "1.0.0", runningVersion: null, mismatch: true, source: "unavailable" })).toBeNull();
  });
});
