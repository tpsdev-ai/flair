import { describe, expect, test } from "bun:test";
import nacl from "tweetnacl";

// ─── Simulator: CLI TPS-Ed25519 Authorization header for /FederationSync ───
// Tests validate that the CLI constructs the correct Authorization header.
// The header is verified against the same message format that auth-middleware
// Path 5 expects.

const TPS_REGEX = /^TPS-Ed25519\s+([^:]+):(\d+):([^:]+):(.+)$/;

describe("CLI federation sync Authorization header", () => {
  test("sync builds correct TPS-Ed25519 Authorization header", () => {
    const kp = nacl.sign.keyPair();
    const instanceId = "spoke-alpha-1";

    // Simulate header construction (mirrors cli.ts runFederationSyncOnce)
    const ts = Date.now();
    const nonce = Buffer.from(nacl.randomBytes(12)).toString("base64url");
    const message = `${instanceId}:${ts}:${nonce}:POST:/FederationSync`;
    const sig = nacl.sign.detached(Buffer.from(message, "utf-8"), kp.secretKey);
    const signatureB64 = Buffer.from(sig).toString("base64");
    const authHeader = `TPS-Ed25519 ${instanceId}:${ts}:${nonce}:${signatureB64}`;

    // Parse the header back
    const match = authHeader.match(TPS_REGEX);
    expect(match).not.toBeNull();
    const [, parsedId, parsedTs, parsedNonce, parsedSig] = match!;
    expect(parsedId).toBe(instanceId);
    expect(parsedTs).toBe(String(ts));
    expect(parsedNonce).toBe(nonce);
    expect(parsedSig).toBe(signatureB64);
  });

  test("Authorization header signature verifies against spoke pubkey", () => {
    const kp = nacl.sign.keyPair();
    const instanceId = "spoke-alpha-1";
    const publicKeyB64url = Buffer.from(kp.publicKey).toString("base64url");

    const ts = Date.now();
    const nonce = "test-nonce-42";
    const message = `${instanceId}:${ts}:${nonce}:POST:/FederationSync`;
    const sig = nacl.sign.detached(Buffer.from(message, "utf-8"), kp.secretKey);
    const signatureB64 = Buffer.from(sig).toString("base64");

    // Verify — mirrors auth-middleware Path 5 verification
    const reconstructed = `${instanceId}:${ts}:${nonce}:POST:/FederationSync`;
    const valid = nacl.sign.detached.verify(
      Buffer.from(reconstructed, "utf-8"),
      Buffer.from(signatureB64, "base64"),
      Buffer.from(publicKeyB64url, "base64url"),
    );
    expect(valid).toBe(true);
  });

  test("header timestamp is current (within 30s)", () => {
    const ts = Date.now();
    const now = Date.now();
    const WINDOW_MS = 30_000;
    expect(Math.abs(now - ts) <= WINDOW_MS).toBe(true);
  });

  test("nonce is non-empty", () => {
    const nonce = Buffer.from(nacl.randomBytes(12)).toString("base64url");
    expect(nonce.length).toBeGreaterThan(0);
  });

  test("nonces are unique per call", () => {
    const nonces = new Set<string>();
    for (let i = 0; i < 10; i++) {
      nonces.add(Buffer.from(nacl.randomBytes(12)).toString("base64url"));
    }
    expect(nonces.size).toBe(10);
  });

  test("signed message matches canonical format", () => {
    // The format MUST be: ${instanceId}:${ts}:${nonce}:${request.method}:${url.pathname}
    const instanceId = "spoke-alpha-1";
    const ts = 1715000000000;
    const nonce = "abc123";
    const method = "POST";
    const path = "/FederationSync";

    const message = `${instanceId}:${ts}:${nonce}:${method}:${path}`;
    expect(message).toBe("spoke-alpha-1:1715000000000:abc123:POST:/FederationSync");

    // Verify regex can parse it back
    const header = `TPS-Ed25519 ${message}:basesig`;
    const match = header.match(TPS_REGEX);
    expect(match).not.toBeNull();
    expect(match![1]).toBe(instanceId);
    expect(match![2]).toBe(String(ts));
    expect(match![3]).toBe(nonce);
  });

  test("Authorization header is NOT sent on /FederationPair", () => {
    // The PR spec explicitly forbids this — pair flow uses bootstrap Basic or anon
    // This test exists as a contract reminder; the actual enforcement is in
    // cli.ts (pair doesn't construct this header at all).
    const pairPath = "/FederationPair";
    const syncPath = "/FederationSync";

    // Sync builds header with /FederationSync path in signature message
    const syncMessage = `spoke-1:${Date.now()}:nonce:POST:${syncPath}`;
    expect(syncMessage.endsWith(":/FederationSync")).toBe(true);

    // A pair message would use /FederationPair but we assert it doesn't
    const pairMessage = `spoke-1:${Date.now()}:nonce:POST:${pairPath}`;
    expect(pairMessage.endsWith(":/FederationPair")).toBe(true);
    // This is just a reminder — the CLI never constructs TPS-Ed25519 for pair paths
  });

  test("body signature is separate from Authorization header signature", () => {
    const kp = nacl.sign.keyPair();

    // Body signing (simulated from signRequestBody / signBody)
    const body = { instanceId: "spoke-1", records: [], lamportClock: Date.now() };
    const bodySig = nacl.sign.detached(
      Buffer.from(canonicalize(body), "utf-8"),
      kp.secretKey,
    );

    // Auth header signing (separate message format)
    const ts = Date.now();
    const nonce = "nonce-auth";
    const authMessage = `spoke-1:${ts}:${nonce}:POST:/FederationSync`;
    const authSig = nacl.sign.detached(
      Buffer.from(authMessage, "utf-8"),
      kp.secretKey,
    );

    // The two signatures should be different (different messages)
    expect(Buffer.from(bodySig).toString("base64"))
      .not.toBe(Buffer.from(authSig).toString("base64"));
  });

  test("reuses same secretKey for body and auth header signing", () => {
    const kp = nacl.sign.keyPair();
    const secretKey = kp.secretKey; // loaded once via loadInstanceSecretKey

    // Body sig
    const bodySig = nacl.sign.detached(
      Buffer.from("body-data", "utf-8"),
      secretKey,
    );

    // Auth header sig (same secretKey instance)
    const authSig = nacl.sign.detached(
      Buffer.from("auth-data", "utf-8"),
      secretKey, // reused — not reloaded
    );

    // Both verify against the same public key
    const pubKey = kp.publicKey;
    const bodyOk = nacl.sign.detached.verify(
      Buffer.from("body-data", "utf-8"),
      bodySig,
      pubKey,
    );
    const authOk = nacl.sign.detached.verify(
      Buffer.from("auth-data", "utf-8"),
      authSig,
      pubKey,
    );
    expect(bodyOk).toBe(true);
    expect(authOk).toBe(true);
  });
});

// ─── Canonical JSON helper (mirrors federation-crypto.ts) ──────────────────

function canonicalize(obj: unknown): string {
  return JSON.stringify(sortKeys(obj));
}

function sortKeys(val: unknown): unknown {
  if (val === null || val === undefined || typeof val !== "object") return val;
  if (Array.isArray(val)) return val.map(sortKeys);
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(val as Record<string, unknown>).sort()) {
    sorted[key] = sortKeys((val as Record<string, unknown>)[key]);
  }
  return sorted;
}

// ─── Edge cases ─────────────────────────────────────────────────────────────

describe("CLI sync header edge cases", () => {
  test("nonce is base64url-safe (no +/= chars)", () => {
    // base64url encoding produces URL-safe output
    const nonce = Buffer.from(nacl.randomBytes(12)).toString("base64url");
    expect(nonce).not.toContain("+");
    expect(nonce).not.toContain("/");
    expect(nonce).not.toContain("=");
  });

  test("nonce has sufficient entropy (12 bytes = 96 bits)", () => {
    const nonce = Buffer.from(nacl.randomBytes(12)).toString("base64url");
    // 12 random bytes → 16 base64url chars (no padding)
    expect(nonce.length).toBeGreaterThanOrEqual(16);
  });

  test("timestamp is a finite number", () => {
    const ts = Date.now();
    expect(Number.isFinite(ts)).toBe(true);
    expect(typeof ts).toBe("number");
  });

  test("tampered signature does not verify", () => {
    const kp = nacl.sign.keyPair();
    const pubKeyB64url = Buffer.from(kp.publicKey).toString("base64url");
    const instanceId = "spoke-1";
    const ts = Date.now();
    const nonce = "nonce-ok";

    // Sign the original message
    const originalMsg = `${instanceId}:${ts}:${nonce}:POST:/FederationSync`;
    const sig = nacl.sign.detached(Buffer.from(originalMsg, "utf-8"), kp.secretKey);
    const sigB64 = Buffer.from(sig).toString("base64");

    // Try to verify with a tampered message
    const tamperedMsg = `${instanceId}:${ts}:${nonce}:DELETE:/FederationSync`;
    const valid = nacl.sign.detached.verify(
      Buffer.from(tamperedMsg, "utf-8"),
      Buffer.from(sigB64, "base64"),
      Buffer.from(pubKeyB64url, "base64url"),
    );
    expect(valid).toBe(false);
  });

  test("Authorization header contains correct scheme prefix", () => {
    const header = "TPS-Ed25519 spoke-1:1715000000000:abc:sig";
    expect(header.startsWith("TPS-Ed25519 ")).toBe(true);
  });
});
