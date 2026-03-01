import { describe, expect, test } from "bun:test";

// Test the auth header regex parsing (same pattern used in auth-middleware.ts)
const AUTH_REGEX = /^TPS-Ed25519\s+([^:]+):(\d+):([^:]+):(.+)$/;

describe("auth middleware logic", () => {
  test("parses valid TPS-Ed25519 header", () => {
    const header = "TPS-Ed25519 flint:1709000000000:abc123nonce:c2lnbmF0dXJl";
    const m = header.match(AUTH_REGEX);
    expect(m).not.toBeNull();
    expect(m![1]).toBe("flint");
    expect(m![2]).toBe("1709000000000");
    expect(m![3]).toBe("abc123nonce");
    expect(m![4]).toBe("c2lnbmF0dXJl");
  });

  test("rejects missing scheme", () => {
    expect("Bearer token123".match(AUTH_REGEX)).toBeNull();
  });

  test("rejects malformed header (missing fields)", () => {
    expect("TPS-Ed25519 flint:123".match(AUTH_REGEX)).toBeNull();
    expect("TPS-Ed25519 flint".match(AUTH_REGEX)).toBeNull();
  });

  test("rejects non-numeric timestamp", () => {
    expect("TPS-Ed25519 flint:notanumber:nonce:sig".match(AUTH_REGEX)).toBeNull();
  });

  test("timestamp window check logic", () => {
    const WINDOW_MS = 30_000;
    const now = Date.now();
    // Valid: within window
    expect(Math.abs(now - now) <= WINDOW_MS).toBe(true);
    // Expired: 31s ago
    expect(Math.abs(now - (now - 31000)) <= WINDOW_MS).toBe(false);
    // Future: 31s ahead
    expect(Math.abs(now - (now + 31000)) <= WINDOW_MS).toBe(false);
  });

  test("nonce dedup logic", () => {
    const nonceSeen = new Map<string, number>();
    const key = "flint:abc123";
    expect(nonceSeen.has(key)).toBe(false);
    nonceSeen.set(key, Date.now());
    expect(nonceSeen.has(key)).toBe(true);
  });

  test("b64ToArrayBuffer roundtrip", () => {
    // Same implementation as auth-middleware.ts
    function b64ToArrayBuffer(b64: string): ArrayBuffer {
      const bin = atob(b64);
      const buf = new ArrayBuffer(bin.length);
      const view = new Uint8Array(buf);
      for (let i = 0; i < bin.length; i++) view[i] = bin.charCodeAt(i);
      return buf;
    }
    const original = new Uint8Array([1, 2, 3, 255, 0, 128]);
    const b64 = btoa(String.fromCharCode(...original));
    const result = new Uint8Array(b64ToArrayBuffer(b64));
    expect(result).toEqual(original);
  });
});
