/**
 * ed25519-auth.test.ts — unit tests for the shared Ed25519 auth primitives
 * module (shared nonce-store consolidation).
 *
 * resources/ed25519-auth.ts has ZERO dependency on @harperfast/harper (it
 * only imports resources/b64.ts, which is also dependency-free), so these
 * tests import it directly — no mock.module needed.
 *
 * Covers the shared nonce store in isolation: pruning, replay rejection, and
 * the cross-path closure property (a nonce recorded via the shared API is
 * then rejected — proving there is exactly ONE store, not three). Real
 * cross-MODULE closure (agent-auth.ts <-> Presence.ts <-> auth-middleware.ts
 * all seeing the same recorded nonce) is covered in
 * ed25519-auth-cross-site.test.ts and auth-middleware-ed25519.test.ts.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import nacl from "tweetnacl";
import {
  WINDOW_MS,
  isNonceReplay,
  recordNonce,
  importEd25519Key,
  b64ToArrayBuffer,
  parseTpsEd25519Header,
  TPS_ED25519_HEADER_RE,
  MAX_AUTH_HEADER_LEN,
  __clearNoncesForTest,
} from "../../resources/ed25519-auth.ts";

beforeEach(() => {
  __clearNoncesForTest();
});

describe("WINDOW_MS", () => {
  it("defaults to 30_000 (matches all 3 pre-consolidation sites)", () => {
    expect(WINDOW_MS).toBe(30_000);
  });
});

describe("isNonceReplay / recordNonce — the single shared store", () => {
  it("a fresh (agentId, nonce) pair is not a replay", () => {
    expect(isNonceReplay("agent-a", "nonce-1", Date.now())).toBe(false);
  });

  it("CORE CLOSURE PROPERTY: recording a nonce via the shared API makes the SAME key rejected", () => {
    const ts = Date.now();
    expect(isNonceReplay("agent-a", "nonce-2", ts)).toBe(false);
    recordNonce("agent-a", "nonce-2", ts);
    // Any caller checking the identical (agentId, nonce) — regardless of which
    // "site" it represents — now sees a replay, because there is exactly one
    // module-level nonceSeen Map backing both isNonceReplay and recordNonce.
    expect(isNonceReplay("agent-a", "nonce-2", ts + 1000)).toBe(true);
  });

  it("nonceKey format is `${agentId}:${nonce}` — different agentId does not collide", () => {
    const ts = Date.now();
    recordNonce("agent-a", "shared-nonce", ts);
    expect(isNonceReplay("agent-a", "shared-nonce", ts)).toBe(true);
    expect(isNonceReplay("agent-b", "shared-nonce", ts)).toBe(false);
  });

  it("different nonce for the same agent does not collide", () => {
    const ts = Date.now();
    recordNonce("agent-a", "nonce-x", ts);
    expect(isNonceReplay("agent-a", "nonce-y", ts)).toBe(false);
  });

  it("prunes entries older than WINDOW_MS — replay guard expires", () => {
    const ts = 1_000_000;
    recordNonce("agent-a", "nonce-3", ts);
    expect(isNonceReplay("agent-a", "nonce-3", ts + WINDOW_MS - 1)).toBe(true);
    // Strictly greater than WINDOW_MS is pruned (matches all 3 sites' `now - t > WINDOW_MS`).
    expect(isNonceReplay("agent-a", "nonce-3", ts + WINDOW_MS + 1)).toBe(false);
  });

  it("pruning one expired nonce does not evict a still-fresh nonce", () => {
    const t0 = 1_000_000;
    recordNonce("agent-a", "old-nonce", t0);
    const t1 = t0 + 10_000;
    recordNonce("agent-a", "fresh-nonce", t1);
    // Advance past old-nonce's window but within fresh-nonce's window.
    const now = t0 + WINDOW_MS + 1;
    expect(isNonceReplay("agent-a", "old-nonce", now)).toBe(false); // pruned
    expect(isNonceReplay("agent-a", "fresh-nonce", now)).toBe(true); // still recorded
  });
});

describe("importEd25519Key", () => {
  it("imports a base64-encoded public key and verifies a real signature", async () => {
    const kp = nacl.sign.keyPair();
    const pubB64 = Buffer.from(kp.publicKey).toString("base64");
    const key = await importEd25519Key(pubB64);

    const message = new TextEncoder().encode("hello-ed25519-auth");
    const sig = nacl.sign.detached(message, kp.secretKey);

    const ok = await crypto.subtle.verify({ name: "Ed25519" } as any, key, sig, message);
    expect(ok).toBe(true);
  });

  it("imports a hex-encoded public key identically", async () => {
    const kp = nacl.sign.keyPair();
    const pubHex = Buffer.from(kp.publicKey).toString("hex");
    const key = await importEd25519Key(pubHex);

    const message = new TextEncoder().encode("hex-key-message");
    const sig = nacl.sign.detached(message, kp.secretKey);

    const ok = await crypto.subtle.verify({ name: "Ed25519" } as any, key, sig, message);
    expect(ok).toBe(true);
  });

  it("imports a base64url-encoded public key (unpadded) identically", async () => {
    const kp = nacl.sign.keyPair();
    const pubB64url = Buffer.from(kp.publicKey).toString("base64url");
    const key = await importEd25519Key(pubB64url);

    const message = new TextEncoder().encode("base64url-key-message");
    const sig = nacl.sign.detached(message, kp.secretKey);

    const ok = await crypto.subtle.verify({ name: "Ed25519" } as any, key, sig, message);
    expect(ok).toBe(true);
  });

  it("caches by the raw key string (same CryptoKey instance on 2nd call)", async () => {
    const kp = nacl.sign.keyPair();
    const pubB64 = Buffer.from(kp.publicKey).toString("base64");
    const key1 = await importEd25519Key(pubB64);
    const key2 = await importEd25519Key(pubB64);
    expect(key1).toBe(key2);
  });

  it("a signature from a DIFFERENT key does not verify (sanity: real crypto, not a stub)", async () => {
    const kp1 = nacl.sign.keyPair();
    const kp2 = nacl.sign.keyPair();
    const key1 = await importEd25519Key(Buffer.from(kp1.publicKey).toString("base64"));

    const message = new TextEncoder().encode("mismatched-key-message");
    const sigFromKp2 = nacl.sign.detached(message, kp2.secretKey);

    const ok = await crypto.subtle.verify({ name: "Ed25519" } as any, key1, sigFromKp2, message);
    expect(ok).toBe(false);
  });
});

describe("parseTpsEd25519Header — bounded, linear-time header parsing", () => {
  it("accepts a valid header and extracts every field", () => {
    const parsed = parseTpsEd25519Header(
      "TPS-Ed25519 agent-42:1721000000000:nonce-abc:c2lnbmF0dXJlLWJ5dGVz",
    );
    expect(parsed).toEqual({
      agentId: "agent-42",
      tsRaw: "1721000000000",
      nonce: "nonce-abc",
      signatureB64: "c2lnbmF0dXJlLWJ5dGVz",
    });
  });

  it("returns null for empty and non-matching headers", () => {
    expect(parseTpsEd25519Header("")).toBeNull();
    expect(parseTpsEd25519Header("Basic dXNlcjpwYXNz")).toBeNull();
    expect(parseTpsEd25519Header("TPS-Ed25519 no-colons-here")).toBeNull();
  });

  it("parses long/degenerate headers in linear time", () => {
    // A long whitespace run with no colon is the worst case for a grammar whose
    // whitespace and text character classes overlap. With disjoint classes
    // ([^:\s]) there is a single unambiguous split, so the match is linear and
    // completes near-instantly instead of exploring O(n^2) backtracks.
    const degenerate = "TPS-Ed25519 " + " ".repeat(200_000);
    const start = performance.now();
    const parsed = parseTpsEd25519Header(degenerate);
    const elapsed = performance.now() - start;
    expect(parsed).toBeNull();
    expect(elapsed).toBeLessThan(200);
  });

  it("the header grammar itself matches a long degenerate input in linear time", () => {
    // Exercises the regex directly (bypassing the length guard) to prove the
    // grammar alone stays linear on a long whitespace-only, colon-free input.
    const degenerate = "TPS-Ed25519 " + " ".repeat(200_000);
    const start = performance.now();
    const m = TPS_ED25519_HEADER_RE.exec(degenerate);
    const elapsed = performance.now() - start;
    expect(m).toBeNull();
    expect(elapsed).toBeLessThan(200);
  });

  it("rejects over-length headers", () => {
    const tooLong = "TPS-Ed25519 " + "a".repeat(MAX_AUTH_HEADER_LEN);
    expect(tooLong.length).toBeGreaterThan(MAX_AUTH_HEADER_LEN);
    expect(parseTpsEd25519Header(tooLong)).toBeNull();
  });

  it("accepts a valid header sized exactly at the length bound (guard is inclusive)", () => {
    const prefix = "TPS-Ed25519 a:1:n:";
    const sig = "x".repeat(MAX_AUTH_HEADER_LEN - prefix.length);
    const header = prefix + sig;
    expect(header.length).toBe(MAX_AUTH_HEADER_LEN);
    expect(parseTpsEd25519Header(header)).toEqual({
      agentId: "a",
      tsRaw: "1",
      nonce: "n",
      signatureB64: sig,
    });
  });
});

describe("b64ToArrayBuffer (re-exported from b64.ts)", () => {
  it("round-trips standard base64", () => {
    const original = new Uint8Array([1, 2, 3, 255, 0, 128]);
    const b64 = btoa(String.fromCharCode(...original));
    const result = new Uint8Array(b64ToArrayBuffer(b64));
    expect(result).toEqual(original);
  });

  it("round-trips unpadded base64url", () => {
    const original = new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2, 1, 0]);
    const b64url = Buffer.from(original).toString("base64url");
    const result = new Uint8Array(b64ToArrayBuffer(b64url));
    expect(result).toEqual(original);
  });
});
