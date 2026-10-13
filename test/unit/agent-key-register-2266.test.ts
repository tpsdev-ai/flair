// agent-key-register-2266.test.ts — the pure pieces of flair#2266.
//
// The key-format rule, the audit fingerprint, and the federation pending-key
// predicate, unit-tested without a Harper. The resource's request/auth/write
// behaviour is covered against real Harper by
// test/integration/agent-key-register-2266.test.ts and
// test/integration/agent-pending-key-federation-2266.test.ts.
import { describe, expect, test } from "bun:test";
import {
  PENDING_PUBLIC_KEY,
  isCanonicalEd25519Base64url,
  keyFingerprint,
} from "../../src/lib/agent-key-register.js";
import { inboundChangesExistingPendingKey } from "../../resources/federation-classify.js";

const KEY = Buffer.from(new Uint8Array(32).fill(7)).toString("base64url");

describe("flair#2266 — the canonical Ed25519 base64url key rule", () => {
  test("accepts a canonical unpadded base64url 32-byte key", () => {
    expect(KEY.length).toBe(43);
    expect(isCanonicalEd25519Base64url(KEY)).toBe(true);
  });

  test("rejects padding, wrong length, wrong alphabet and non-strings", () => {
    expect(isCanonicalEd25519Base64url(`${KEY}=`)).toBe(false);
    expect(isCanonicalEd25519Base64url(KEY.slice(0, 42))).toBe(false);
    expect(isCanonicalEd25519Base64url(`${KEY.slice(0, 42)}+`)).toBe(false);
    expect(isCanonicalEd25519Base64url("pending")).toBe(false);
    expect(isCanonicalEd25519Base64url("")).toBe(false);
    expect(isCanonicalEd25519Base64url(undefined)).toBe(false);
    expect(isCanonicalEd25519Base64url(123)).toBe(false);
  });

  test("rejects a non-canonical tail that decodes to 32 bytes but re-encodes differently", () => {
    // The final base64url char of a 32-byte key encodes 4 key bits and 4 padding
    // bits. Swapping it for a char whose padding bits are non-zero still decodes
    // to 32 bytes, but the canonical re-encoding differs — so it is refused.
    const nonCanonical = `${KEY.slice(0, 42)}f`;
    expect(Buffer.from(nonCanonical, "base64url").length).toBe(32);
    expect(Buffer.from(nonCanonical, "base64url").toString("base64url")).not.toBe(nonCanonical);
    expect(isCanonicalEd25519Base64url(nonCanonical)).toBe(false);
  });
});

describe("flair#2266 — the audit fingerprint is of the key, never the key", () => {
  test("is deterministic sha256 hex of the canonical key string", async () => {
    const fp = await keyFingerprint(KEY);
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
    expect(await keyFingerprint(KEY)).toBe(fp);
    expect(fp).not.toContain(KEY);
  });
});

describe("flair#2266 — the federation pending-key predicate", () => {
  const pendingRow = { id: "a", publicKey: PENDING_PUBLIC_KEY, status: "active" };
  const record = (data: unknown, table = "Agent") => ({ table, id: "a", updatedAt: "2026-01-01T00:00:00.000Z", data }) as any;

  test("true only when a local pending row's key would change", () => {
    expect(inboundChangesExistingPendingKey(record({ id: "a", publicKey: KEY }), pendingRow)).toBe(true);
  });

  test("false when the stored key is not pending, there is no local row, or the table differs", () => {
    expect(inboundChangesExistingPendingKey(record({ id: "a", publicKey: KEY }), { id: "a", publicKey: "notpending" })).toBe(false);
    expect(inboundChangesExistingPendingKey(record({ id: "a", publicKey: KEY }), null)).toBe(false);
    expect(inboundChangesExistingPendingKey(record({ id: "a", publicKey: KEY }, "Soul"), pendingRow)).toBe(false);
  });

  test("false when the record does not carry a publicKey, or restates pending", () => {
    expect(inboundChangesExistingPendingKey(record({ id: "a", status: "active" }), pendingRow)).toBe(false);
    expect(inboundChangesExistingPendingKey(record({ id: "a", publicKey: PENDING_PUBLIC_KEY }), pendingRow)).toBe(false);
    expect(inboundChangesExistingPendingKey(record({ id: "a" }), pendingRow)).toBe(false);
  });
});
