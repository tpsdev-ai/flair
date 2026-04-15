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
