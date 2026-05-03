/**
 * cli-port-autodiscover.test.ts — Unit tests for the port-drift autodiscover
 * helpers (ops-mbdi).
 *
 * The discoverLocalFlairPort helper probes a small candidate-port set when the
 * configured Flair URL is unreachable. Tests cover:
 *
 *   - isLocalhostUrl: localhost / 127.0.0.1 / ::1 → true; remote hosts → false
 *   - discoverLocalFlairPort: returns null for non-localhost URLs (no probing)
 *   - discoverLocalFlairPort: returns the first responsive port from the
 *     candidate set when fetch is mocked
 *   - discoverLocalFlairPort: excludes the original port from the probe set
 *   - discoverLocalFlairPort: treats 401 (auth required) as alive, since the
 *     daemon is running even if /Health is auth-gated
 */

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { isLocalhostUrl, discoverLocalFlairPort } from "../../src/cli.ts";

describe("isLocalhostUrl", () => {
  test("returns true for 127.0.0.1", () => {
    expect(isLocalhostUrl("http://127.0.0.1:9926")).toBe(true);
    expect(isLocalhostUrl("https://127.0.0.1/path")).toBe(true);
  });

  test("returns true for localhost", () => {
    expect(isLocalhostUrl("http://localhost:9926")).toBe(true);
  });

  test("returns true for IPv6 ::1", () => {
    expect(isLocalhostUrl("http://[::1]:9926")).toBe(true);
  });

  test("returns false for remote hosts", () => {
    expect(isLocalhostUrl("https://flair.example.com")).toBe(false);
    expect(isLocalhostUrl("http://10.0.0.1:9926")).toBe(false);
    expect(isLocalhostUrl("http://flair.local:9926")).toBe(false);
  });

  test("returns false for malformed URLs", () => {
    expect(isLocalhostUrl("not a url")).toBe(false);
    expect(isLocalhostUrl("")).toBe(false);
  });
});

describe("discoverLocalFlairPort", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("returns null for non-localhost URLs (no probing)", async () => {
    let fetchCalled = false;
    globalThis.fetch = (mock(async () => {
      fetchCalled = true;
      return new Response("", { status: 200 });
    }) as unknown) as typeof globalThis.fetch;

    const result = await discoverLocalFlairPort("https://flair.example.com:9926");
    expect(result).toBeNull();
    expect(fetchCalled).toBe(false);
  });

  test("returns the first responsive candidate port", async () => {
    globalThis.fetch = (mock(async (url: any) => {
      const u = new URL(String(url));
      // 9926 responds, others fail
      if (u.port === "9926") return new Response("", { status: 200 });
      throw new Error("connection refused");
    }) as unknown) as typeof globalThis.fetch;

    // Original URL points at 19926 (which doesn't respond in the mock).
    // Discovery should hit 9926.
    const result = await discoverLocalFlairPort("http://127.0.0.1:19926");
    expect(result).toBe(9926);
  });

  test("excludes the original port from the probe set", async () => {
    const probedPorts: number[] = [];
    globalThis.fetch = (mock(async (url: any) => {
      const u = new URL(String(url));
      probedPorts.push(Number(u.port));
      throw new Error("connection refused");
    }) as unknown) as typeof globalThis.fetch;

    await discoverLocalFlairPort("http://127.0.0.1:9926");
    // Original was 9926 — should not appear in the probe set.
    expect(probedPorts).not.toContain(9926);
  });

  test("treats 401 as alive (auth-gated /Health is still a live daemon)", async () => {
    globalThis.fetch = (mock(async (url: any) => {
      const u = new URL(String(url));
      if (u.port === "19926") return new Response("auth required", { status: 401 });
      throw new Error("connection refused");
    }) as unknown) as typeof globalThis.fetch;

    const result = await discoverLocalFlairPort("http://127.0.0.1:9926");
    expect(result).toBe(19926);
  });

  test("returns null when no candidates respond", async () => {
    globalThis.fetch = (mock(async () => {
      throw new Error("connection refused");
    }) as unknown) as typeof globalThis.fetch;

    const result = await discoverLocalFlairPort("http://127.0.0.1:9926");
    expect(result).toBeNull();
  });
});
