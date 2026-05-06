import { describe, expect, test } from "bun:test";
import nacl from "tweetnacl";
import {
  signBodyFresh,
  verifyBodySignatureFresh,
  generateNonce,
  createNonceStore,
} from "../../resources/federation-crypto.js";

describe("signBodyFresh + verifyBodySignatureFresh", () => {
  test("sign → verifyFresh succeeds with real Ed25519 keypair", () => {
    const kp = nacl.sign.keyPair();
    const secretKey = kp.secretKey;
    const publicKeyB64url = Buffer.from(kp.publicKey).toString("base64url");

    const body = { instanceId: "spoke-1", records: [1, 2, 3] };
    const signed = signBodyFresh(body, secretKey);

    // Body has _ts, _nonce, and signature fields
    expect(signed._ts).toBeGreaterThan(0);
    expect(signed._nonce).toBeTruthy();
    expect(signed.signature).toBeTruthy();
    expect(signed.instanceId).toBe("spoke-1");

    // Verify
    const result = verifyBodySignatureFresh(signed, publicKeyB64url, {
      windowMs: 30_000,
      nonceStore: createNonceStore(),
    });
    expect(result.ok).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  test("replay same signed body → verifyFresh rejects with reason=replay", () => {
    const kp = nacl.sign.keyPair();
    const secretKey = kp.secretKey;
    const publicKeyB64url = Buffer.from(kp.publicKey).toString("base64url");
    const store = createNonceStore();

    const signed = signBodyFresh({ instanceId: "spoke-1" }, secretKey);

    // First verify — ok
    const first = verifyBodySignatureFresh(signed, publicKeyB64url, {
      windowMs: 30_000,
      nonceStore: store,
    });
    expect(first.ok).toBe(true);

    // Second verify with same body — replay
    const second = verifyBodySignatureFresh(signed, publicKeyB64url, {
      windowMs: 30_000,
      nonceStore: store,
    });
    expect(second.ok).toBe(false);
    expect(second.reason).toBe("replay");
  });

  test("stale timestamp (>30s old) → reason=stale", () => {
    const kp = nacl.sign.keyPair();
    const secretKey = kp.secretKey;
    const publicKeyB64url = Buffer.from(kp.publicKey).toString("base64url");

    const staleTs = Date.now() - 31_000;
    const signed = signBodyFresh({ data: "test" }, secretKey, { ts: staleTs });

    const result = verifyBodySignatureFresh(signed, publicKeyB64url, {
      windowMs: 30_000,
      nonceStore: createNonceStore(),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("stale");
  });

  test("future timestamp (>30s ahead) → reason=future", () => {
    const kp = nacl.sign.keyPair();
    const secretKey = kp.secretKey;
    const publicKeyB64url = Buffer.from(kp.publicKey).toString("base64url");

    const futureTs = Date.now() + 31_000;
    const signed = signBodyFresh({ data: "test" }, secretKey, { ts: futureTs });

    const result = verifyBodySignatureFresh(signed, publicKeyB64url, {
      windowMs: 30_000,
      nonceStore: createNonceStore(),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("future");
  });

  test("tampered body → reason=invalid_signature", () => {
    const kp = nacl.sign.keyPair();
    const secretKey = kp.secretKey;
    const publicKeyB64url = Buffer.from(kp.publicKey).toString("base64url");

    const signed = signBodyFresh({ instanceId: "spoke-1" }, secretKey);

    // Tamper: change instanceId after signing
    const tampered = { ...signed, instanceId: "spoke-evil" };

    const result = verifyBodySignatureFresh(tampered, publicKeyB64url, {
      windowMs: 30_000,
      nonceStore: createNonceStore(),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("invalid_signature");
  });

  test("wrong public key → reason=invalid_signature", () => {
    const kp1 = nacl.sign.keyPair();
    const kp2 = nacl.sign.keyPair();
    const wrongKeyB64url = Buffer.from(kp2.publicKey).toString("base64url");

    const signed = signBodyFresh({ data: "test" }, kp1.secretKey);

    const result = verifyBodySignatureFresh(signed, wrongKeyB64url, {
      windowMs: 30_000,
      nonceStore: createNonceStore(),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("invalid_signature");
  });

  test("missing _ts → reason=invalid_signature", () => {
    const kp = nacl.sign.keyPair();
    const publicKeyB64url = Buffer.from(kp.publicKey).toString("base64url");

    const body = { instanceId: "spoke-1", _nonce: "abc", signature: "sig" };
    const result = verifyBodySignatureFresh(body, publicKeyB64url, {
      windowMs: 30_000,
      nonceStore: createNonceStore(),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("invalid_signature");
  });

  test("missing _nonce → reason=invalid_signature", () => {
    const kp = nacl.sign.keyPair();
    const publicKeyB64url = Buffer.from(kp.publicKey).toString("base64url");

    const body = { instanceId: "spoke-1", _ts: Date.now(), signature: "sig" };
    const result = verifyBodySignatureFresh(body, publicKeyB64url, {
      windowMs: 30_000,
      nonceStore: createNonceStore(),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("invalid_signature");
  });

  test("missing signature → reason=invalid_signature", () => {
    const kp = nacl.sign.keyPair();
    const publicKeyB64url = Buffer.from(kp.publicKey).toString("base64url");

    const body = { instanceId: "spoke-1", _ts: Date.now(), _nonce: "abc" };
    const result = verifyBodySignatureFresh(body, publicKeyB64url, {
      windowMs: 30_000,
      nonceStore: createNonceStore(),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("invalid_signature");
  });

  test("nonce store evicts old entries", () => {
    const kp = nacl.sign.keyPair();
    const secretKey = kp.secretKey;
    const publicKeyB64url = Buffer.from(kp.publicKey).toString("base64url");
    const store = createNonceStore();

    // Set up an old nonce directly (simulate old entry)
    const oldTs = Date.now() - 120_000; // 2 minutes ago
    store.set("old-nonce", oldTs);

    // The evict is called during verifyBodySignatureFresh
    const signed = signBodyFresh({ data: "new-request" }, secretKey);
    const result = verifyBodySignatureFresh(signed, publicKeyB64url, {
      windowMs: 30_000,
      nonceStore: store,
    });
    expect(result.ok).toBe(true);

    // The old-nonce should be evicted (2min > 60s = 2x window)
    expect(store.has("old-nonce")).toBe(false);
  });

  test("signature from signBodyFresh verifies only with correct public key", () => {
    const kp = nacl.sign.keyPair();
    const otherKp = nacl.sign.keyPair();
    const correctKey = Buffer.from(kp.publicKey).toString("base64url");
    const wrongKey = Buffer.from(otherKp.publicKey).toString("base64url");

    const signed = signBodyFresh({ data: "test" }, kp.secretKey);

    // Correct key works
    expect(
      verifyBodySignatureFresh(signed, correctKey, {
        windowMs: 30_000,
        nonceStore: createNonceStore(),
      }).ok,
    ).toBe(true);

    // Wrong key fails
    expect(
      verifyBodySignatureFresh(signed, wrongKey, {
        windowMs: 30_000,
        nonceStore: createNonceStore(),
      }).ok,
    ).toBe(false);
  });

  test("_ts is exactly as provided through opts", () => {
    const kp = nacl.sign.keyPair();
    const explicitTs = 1715000000000;
    const signed = signBodyFresh({ data: "test" }, kp.secretKey, { ts: explicitTs });
    expect(signed._ts).toBe(explicitTs);
  });

  test("_nonce is exactly as provided through opts", () => {
    const kp = nacl.sign.keyPair();
    const explicitNonce = "custom-nonce-for-test";
    const signed = signBodyFresh({ data: "test" }, kp.secretKey, { nonce: explicitNonce });
    expect(signed._nonce).toBe(explicitNonce);
  });

  test("timestamp exactly at window boundary (30s old) succeeds", () => {
    const kp = nacl.sign.keyPair();
    const secretKey = kp.secretKey;
    const publicKeyB64url = Buffer.from(kp.publicKey).toString("base64url");

    // Use 29_999ms to avoid sub-ms race with verifyFresh's Date.now() call
    const boundaryTs = Date.now() - 29_999;
    const signed = signBodyFresh({ data: "test" }, secretKey, { ts: boundaryTs });

    const result = verifyBodySignatureFresh(signed, publicKeyB64url, {
      windowMs: 30_000,
      nonceStore: createNonceStore(),
    });
    expect(result.ok).toBe(true);
  });

  test("timestamp exactly at window boundary + 1ms fails", () => {
    const kp = nacl.sign.keyPair();
    const secretKey = kp.secretKey;
    const publicKeyB64url = Buffer.from(kp.publicKey).toString("base64url");

    const overBoundaryTs = Date.now() - 30_001; // 1ms over
    const signed = signBodyFresh({ data: "test" }, secretKey, { ts: overBoundaryTs });

    const result = verifyBodySignatureFresh(signed, publicKeyB64url, {
      windowMs: 30_000,
      nonceStore: createNonceStore(),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("stale");
  });
});

describe("generateNonce", () => {
  test("nonces are base64url-safe (no special chars)", () => {
    for (let i = 0; i < 10; i++) {
      const nonce = generateNonce();
      expect(nonce).not.toContain("+");
      expect(nonce).not.toContain("/");
      expect(nonce).not.toContain("=");
    }
  });

  test("nonces are unique (collision test)", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) {
      seen.add(generateNonce());
    }
    expect(seen.size).toBe(100);
  });

  test("nonce has 16 bytes of entropy (128 bits, 22-char base64url)", () => {
    const nonce = generateNonce();
    // 16 raw bytes → ceil(16 * 8/6) = 22 base64url chars (no padding)
    expect(nonce.length).toBe(22);
  });
});

describe("verifyBodySignatureFresh — no nonceStore", () => {
  test("succeeds without nonceStore (no replay check, just sig + time)", () => {
    const kp = nacl.sign.keyPair();
    const secretKey = kp.secretKey;
    const publicKeyB64url = Buffer.from(kp.publicKey).toString("base64url");

    const signed = signBodyFresh({ data: "test" }, secretKey);
    const result = verifyBodySignatureFresh(signed, publicKeyB64url, {
      windowMs: 30_000,
      // no nonceStore
    });
    expect(result.ok).toBe(true);
  });

  test("replay succeeds without nonceStore (no dedup)", () => {
    const kp = nacl.sign.keyPair();
    const secretKey = kp.secretKey;
    const publicKeyB64url = Buffer.from(kp.publicKey).toString("base64url");

    const signed = signBodyFresh({ data: "test" }, secretKey);
    const first = verifyBodySignatureFresh(signed, publicKeyB64url);
    const second = verifyBodySignatureFresh(signed, publicKeyB64url);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true); // no store = no replay check
  });
});
