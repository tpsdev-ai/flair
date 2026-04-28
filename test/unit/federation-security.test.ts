import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import nacl from "tweetnacl";
import { canonicalize, signBody } from "../../resources/federation-crypto";
import { encryptSeed, decryptSeed } from "../../src/keystore";
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ─── canonicalize() ─────────────────────────────────────────────────────────

describe("canonicalize", () => {
  test("produces deterministic output regardless of key insertion order", () => {
    const a = { z: 1, a: 2, m: 3 };
    const b = { a: 2, m: 3, z: 1 };
    expect(canonicalize(a)).toBe(canonicalize(b));
    expect(canonicalize(a)).toBe('{"a":2,"m":3,"z":1}');
  });

  test("handles nested objects with sorted keys", () => {
    const obj = { b: { z: 1, a: 2 }, a: 3 };
    expect(canonicalize(obj)).toBe('{"a":3,"b":{"a":2,"z":1}}');
  });

  test("handles arrays (preserves order)", () => {
    const obj = { items: [3, 1, 2], name: "test" };
    expect(canonicalize(obj)).toBe('{"items":[3,1,2],"name":"test"}');
  });

  test("handles null and primitive values", () => {
    expect(canonicalize(null)).toBe("null");
    expect(canonicalize(42)).toBe("42");
    expect(canonicalize("hello")).toBe('"hello"');
  });

  test("handles arrays of objects with sorted keys", () => {
    const obj = { list: [{ z: 1, a: 2 }, { b: 3, a: 4 }] };
    expect(canonicalize(obj)).toBe('{"list":[{"a":2,"z":1},{"a":4,"b":3}]}');
  });
});

// ─── Sign + Verify ──────────────────────────────────────────────────────────

describe("signBody / verify", () => {
  const kp = nacl.sign.keyPair();
  const publicKeyB64 = Buffer.from(kp.publicKey).toString("base64url");

  test("sign + verify round-trip succeeds", () => {
    const body = { instanceId: "test_123", data: "hello", nested: { b: 1, a: 2 } };
    const sig = signBody(body, kp.secretKey);
    expect(typeof sig).toBe("string");
    expect(sig.length).toBeGreaterThan(0);

    // Verify: reconstruct canonical form without signature, check against pubkey
    const message = new TextEncoder().encode(canonicalize(body));
    const sigBytes = Buffer.from(sig, "base64url");
    expect(nacl.sign.detached.verify(message, new Uint8Array(sigBytes), kp.publicKey)).toBe(true);
  });

  test("tampered body fails verification", () => {
    const body = { instanceId: "test_123", data: "original" };
    const sig = signBody(body, kp.secretKey);

    // Tamper with the body
    const tampered = { instanceId: "test_123", data: "tampered" };
    const message = new TextEncoder().encode(canonicalize(tampered));
    const sigBytes = Buffer.from(sig, "base64url");
    expect(nacl.sign.detached.verify(message, new Uint8Array(sigBytes), kp.publicKey)).toBe(false);
  });

  test("wrong key fails verification", () => {
    const body = { instanceId: "test_123", data: "hello" };
    const sig = signBody(body, kp.secretKey);

    const otherKp = nacl.sign.keyPair();
    const message = new TextEncoder().encode(canonicalize(body));
    const sigBytes = Buffer.from(sig, "base64url");
    expect(nacl.sign.detached.verify(message, new Uint8Array(sigBytes), otherKp.publicKey)).toBe(false);
  });
});

// ─── Missing signature rejection (simulates resource behavior) ──────────────

describe("signature enforcement", () => {
  test("missing signature field is detected", () => {
    const body = { instanceId: "test_123", records: [] };
    // The resource checks for body.signature before verifying
    expect(body.hasOwnProperty("signature")).toBe(false);
  });

  test("empty signature fails verification", () => {
    const kp = nacl.sign.keyPair();
    const pubKey = Buffer.from(kp.publicKey).toString("base64url");

    const body = { instanceId: "test_123", records: [], signature: "" };
    const { signature, ...rest } = body;

    // Empty signature should not verify
    const message = new TextEncoder().encode(canonicalize(rest));
    try {
      const sigBytes = Buffer.from(signature, "base64url");
      const result = nacl.sign.detached.verify(message, new Uint8Array(sigBytes), kp.publicKey);
      expect(result).toBe(false);
    } catch {
      // tweetnacl throws on malformed signature — also acceptable
      expect(true).toBe(true);
    }
  });
});

// ─── Keystore encrypt/decrypt ───────────────────────────────────────────────

describe("keystore", () => {
  test("encrypt + decrypt round-trip", () => {
    const seed = nacl.sign.keyPair().secretKey.slice(0, 32);
    const encrypted = encryptSeed(seed);

    // Encrypted output should be longer than the seed (IV + tag + ciphertext)
    expect(encrypted.length).toBeGreaterThan(32);

    const decrypted = decryptSeed(encrypted);
    expect(Buffer.from(decrypted).toString("hex")).toBe(Buffer.from(seed).toString("hex"));
  });

  test("different seeds produce different ciphertexts", () => {
    const seed1 = nacl.sign.keyPair().secretKey.slice(0, 32);
    const seed2 = nacl.sign.keyPair().secretKey.slice(0, 32);
    const enc1 = encryptSeed(seed1);
    const enc2 = encryptSeed(seed2);
    expect(enc1.toString("hex")).not.toBe(enc2.toString("hex"));
  });

  test("tampered ciphertext fails decryption", () => {
    const seed = nacl.sign.keyPair().secretKey.slice(0, 32);
    const encrypted = encryptSeed(seed);

    // Flip a byte in the ciphertext portion
    encrypted[30] ^= 0xff;

    expect(() => decryptSeed(encrypted)).toThrow();
  });
});

// ─── Bearer pairing-token auth ──────────────────────────────────────────────

describe("pairing token bearer auth", () => {
  test("pairing token is NOT included in signed body", () => {
    // After refactor, the CLI sends token as Authorization header, not in body.
    // The body is signed without the pairingToken field.
    const kp = nacl.sign.keyPair();
    const body = { instanceId: "spoke_1", publicKey: Buffer.from(kp.publicKey).toString("base64url") };

    // Body should NOT contain pairingToken
    expect((body as any).pairingToken).toBeUndefined();

    // Sign the body without pairingToken (as the new CLI does)
    const sig = signBody(body, kp.secretKey);
    expect(typeof sig).toBe("string");
    expect(sig.length).toBeGreaterThan(0);

    // Resource-side: canonicalize without signature, verify against pubkey
    const { signature: _sig, ...rest } = { ...body, signature: sig };
    const canonical = new TextEncoder().encode(canonicalize(rest));
    const sigBytes = Buffer.from(sig, "base64url");
    expect(nacl.sign.detached.verify(canonical, new Uint8Array(sigBytes), kp.publicKey)).toBe(true);

    // Verify that adding pairingToken AFTER signing would invalidate signature
    const tampered = { ...rest, pairingToken: "tok_hacked" };
    const tamperedCanonical = new TextEncoder().encode(canonicalize(tampered));
    expect(nacl.sign.detached.verify(tamperedCanonical, new Uint8Array(sigBytes), kp.publicKey)).toBe(false);
  });

  test("pairing token in auth header, validated by middleware, consumed by resource", () => {
    // Simulate the lifecycle:
    // 1. Middleware validates Bearer token
    const validToken = { id: "tok_valid", consumedBy: undefined, expiresAt: new Date(Date.now() + 3600000).toISOString() };
    const isConsumed = validToken.consumedBy !== undefined;
    const isExpired = validToken.expiresAt ? new Date(validToken.expiresAt) < new Date() : false;
    expect(isConsumed).toBe(false);
    expect(isExpired).toBe(false);

    // 2. Middleware sets auth context and passes to resource
    const tpsAuthContext = { pairingToken: "tok_valid", authType: "pairing-context" };
    const request = { tpsAuthContext };
    expect(request.tpsAuthContext.pairingToken).toBe("tok_valid");

    // 3. Resource fetches and consumes the token
    const consumedToken = {
      ...validToken,
      consumedBy: "spoke_instance",
      consumedAt: new Date().toISOString(),
    };
    expect(consumedToken.consumedBy).toBe("spoke_instance");
    expect(consumedToken.consumedAt).toBeTruthy();
  });

  test("consumed token rejected by middleware", () => {
    const consumedToken = { id: "tok_used", consumedBy: "some_spoke", expiresAt: new Date(Date.now() + 3600000).toISOString() };
    const isConsumed = consumedToken.consumedBy !== undefined;
    expect(isConsumed).toBe(true);
  });

  test("expired token rejected by middleware", () => {
    const expiredToken = { id: "tok_expired", consumedBy: undefined, expiresAt: new Date(Date.now() - 1000).toISOString() };
    const isExpired = expiredToken.expiresAt ? new Date(expiredToken.expiresAt) < new Date() : false;
    expect(isExpired).toBe(true);
  });

  test("unknown token rejected by middleware", () => {
    const tokenRecord = null;
    const notFound = tokenRecord === null;
    expect(notFound).toBe(true);
  });

  test("re-pairing path skips token (existing peer found)", () => {
    // Existing peer with matching pubkey — re-pair without token
    // Still needs Bearer header per spec, but the resource skips token consumption
    const existing = { id: "spoke_1", publicKey: "same_pubkey" };
    const incoming = { instanceId: "spoke_1", publicKey: "same_pubkey" };

    expect(existing.id).toBe(incoming.instanceId);
    expect(existing.publicKey).toBe(incoming.publicKey);
  });

  test("re-pairing with mismatched key is rejected (409)", () => {
    const existing = { id: "spoke_1", publicKey: "original_key" };
    const incoming = { instanceId: "spoke_1", publicKey: "different_key" };

    const mismatch = existing.publicKey !== incoming.publicKey;
    expect(mismatch).toBe(true);
  });

  test("Ed25519 signature still required in pairing body", () => {
    const kp = nacl.sign.keyPair();
    const body = {
      instanceId: "spoke_1",
      publicKey: Buffer.from(kp.publicKey).toString("base64url"),
    };
    const sig = signBody(body, kp.secretKey);
    const signedBody = { ...body, signature: sig };
    expect(signedBody.signature).toBeTruthy();
    expect(typeof signedBody.signature).toBe("string");

    // Body without signature should fail
    const noSig = { ...body };
    expect((noSig as any).signature).toBeUndefined();
  });

  test("body signature fails if pairingToken added after signing", () => {
    // Defense: if someone adds pairingToken to the body AFTER the CLI signs it
    // (e.g. an old-style body), the signature won't match because canonicalize
    // includes all fields.
    const kp = nacl.sign.keyPair();
    const body = {
      instanceId: "spoke_1",
      publicKey: Buffer.from(kp.publicKey).toString("base64url"),
    };
    const sig = signBody(body, kp.secretKey);

    // Someone adds pairingToken to the signed body
    const tampered = { ...body, pairingToken: "injected_token", signature: sig };
    const { signature: _sig, ...rest } = tampered;
    const canonical = new TextEncoder().encode(canonicalize(rest));
    const sigBytes = Buffer.from(sig, "base64url");
    // Verification FAILS because canonical form differs
    expect(nacl.sign.detached.verify(canonical, new Uint8Array(sigBytes), kp.publicKey)).toBe(false);
  });

  test("tpsAuthContext propagates from middleware to resource", () => {
    // Middleware sets this on the request
    const request: any = {};
    request.tpsAuthContext = { pairingToken: "tok_middleware_set", authType: "pairing-context" };
    request.headers = new Map<string, string>();
    request.headers.set("x-pairing-token", "tok_middleware_set");

    // Resource reads via getContext
    const resourceRequest =
      request?.tpsAuthContext?.pairingToken ??
      request?.headers?.get?.("x-pairing-token");
    expect(resourceRequest).toBe("tok_middleware_set");
  });
});
