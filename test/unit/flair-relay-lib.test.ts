/**
 * flair-relay-lib.test.ts — Flair Relay S1 pure primitives (relay-lib) and the
 * federation policy/owner-field change (federation-classify). No Harper: these
 * are pure functions, so no module mock and none of the bun single-process
 * superclass-capture hazard. See the Flair Relay S1 design (flair#1521).
 */
import { describe, it, expect } from "bun:test";
import nacl from "tweetnacl";
import {
  computeContentHash,
  sealMessage,
  verifyMessageSignature,
  capDecision,
  reconcileState,
  sweepDecision,
  isUnconsumed,
  DEFAULT_INBOX_CAP,
  DEFAULT_PER_SENDER_CAP,
  type MessageEnvelope,
} from "../../resources/relay-lib.js";
import {
  checkPrincipalEntitlement,
  principalOwnerField,
  PRINCIPAL_OWNING_TABLES,
  FEDERATION_SYNC_TABLES,
  FEDERATION_TABLE_POLICY,
} from "../../resources/federation-classify.js";

function keypair() {
  const kp = nacl.sign.keyPair();
  return { secretKey: kp.secretKey, publicKey: Buffer.from(kp.publicKey).toString("base64url") };
}

function baseMsg(over: Partial<MessageEnvelope> = {}): MessageEnvelope {
  return {
    id: "alice-bob-1",
    orgScope: "org-1",
    from: "alice",
    to: "bob",
    threadId: "alice:t1",
    seq: 1,
    kind: "message",
    body: "hello",
    createdAt: "2026-09-04T00:00:00.000Z",
    senderModel: "opus",
    senderProvider: "anthropic",
    senderRunId: "run-1",
    ...over,
  };
}

describe("relay-lib — contentHash", () => {
  it("is stable across identical content (retry-dedup key)", () => {
    expect(computeContentHash(baseMsg())).toBe(computeContentHash(baseMsg()));
  });
  it("ignores id and createdAt (a retry may restamp either)", () => {
    expect(computeContentHash(baseMsg({ id: "x", createdAt: "2026-01-01T00:00:00Z" }))).toBe(
      computeContentHash(baseMsg()),
    );
  });
  it("changes when content changes (seq distinguishes thread messages)", () => {
    expect(computeContentHash(baseMsg({ seq: 2 }))).not.toBe(computeContentHash(baseMsg()));
    expect(computeContentHash(baseMsg({ body: "other" }))).not.toBe(computeContentHash(baseMsg()));
  });
});

describe("relay-lib — signature over the full envelope", () => {
  it("seals and verifies a well-formed message", () => {
    const k = keypair();
    const sealed = sealMessage(baseMsg(), k.secretKey);
    expect(sealed.signature).toBeTruthy();
    expect(sealed.contentHash).toBe(computeContentHash(baseMsg()));
    expect(verifyMessageSignature(sealed, k.publicKey)).toEqual({ ok: true });
  });
  it("rejects a tampered signed field (body)", () => {
    const k = keypair();
    const sealed = sealMessage(baseMsg(), k.secretKey);
    const tampered = { ...sealed, body: "evil" };
    expect(verifyMessageSignature(tampered, k.publicKey).ok).toBe(false);
  });
  it("rejects a tampered id (in the signed body, not in contentHash) as invalid_signature", () => {
    const k = keypair();
    const sealed = sealMessage(baseMsg(), k.secretKey);
    const tampered = { ...sealed, id: "alice-bob-999" };
    expect(verifyMessageSignature(tampered, k.publicKey)).toEqual({ ok: false, reason: "invalid_signature" });
  });
  it("rejects a forged contentHash before checking the signature", () => {
    const k = keypair();
    const sealed = sealMessage(baseMsg(), k.secretKey);
    const forged = { ...sealed, contentHash: "0".repeat(64) };
    expect(verifyMessageSignature(forged, k.publicKey)).toEqual({ ok: false, reason: "content_hash_mismatch" });
  });
  it("rejects a missing signature", () => {
    expect(verifyMessageSignature(baseMsg(), keypair().publicKey)).toEqual({ ok: false, reason: "missing_signature" });
  });
  it("rejects a valid signature under the wrong key", () => {
    const sealed = sealMessage(baseMsg(), keypair().secretKey);
    expect(verifyMessageSignature(sealed, keypair().publicKey).ok).toBe(false);
  });
});

describe("relay-lib — cap + per-sender sub-cap", () => {
  const caps = { inbox: 10, perSender: 2 };
  it("accepts under both caps", () => {
    expect(capDecision({ recipientUnconsumed: 5, senderUnconsumed: 1 }, caps)).toEqual({ ok: true });
  });
  it("rejects the sender at its sub-cap even when the inbox has room", () => {
    expect(capDecision({ recipientUnconsumed: 5, senderUnconsumed: 2 }, caps)).toEqual({
      ok: false,
      reason: "inbox_full",
      scope: "sender",
    });
  });
  it("rejects at the global cap", () => {
    expect(capDecision({ recipientUnconsumed: 10, senderUnconsumed: 0 }, caps)).toEqual({
      ok: false,
      reason: "inbox_full",
      scope: "recipient",
    });
  });
  it("has generous defaults with sub-cap below the global cap", () => {
    expect(DEFAULT_PER_SENDER_CAP).toBeLessThan(DEFAULT_INBOX_CAP);
  });
});

describe("relay-lib — absorbing state machine (§12 P0-3)", () => {
  it("consumed absorbs any incoming state, in either position", () => {
    expect(reconcileState("consumed", "failed")).toBe("consumed");
    expect(reconcileState("consumed", "delivered")).toBe("consumed");
    expect(reconcileState("delivered", "consumed")).toBe("consumed");
    expect(reconcileState("failed", "consumed")).toBe("consumed");
  });
  it("failed yields only to consumed", () => {
    expect(reconcileState("failed", "delivered")).toBe("failed");
    expect(reconcileState("delivered", "failed")).toBe("failed");
  });
  it("otherwise the incoming state wins", () => {
    expect(reconcileState("submitted", "delivered")).toBe("delivered");
    expect(reconcileState(undefined, "delivered")).toBe("delivered");
  });
});

describe("relay-lib — deadline sweep decision", () => {
  const past = "2020-01-01T00:00:00.000Z";
  const future = "2999-01-01T00:00:00.000Z";
  const now = new Date("2026-09-04T00:00:00.000Z");
  it("fails an unconsumed, past-deadline row", () => {
    expect(sweepDecision({ state: "delivered", deadline: past }, now)).toEqual({ fail: true, failureReason: "deadline" });
  });
  it("never touches a consumed row (absorbing)", () => {
    expect(sweepDecision({ state: "consumed", deadline: past }, now)).toEqual({ fail: false });
  });
  it("never touches a not-yet-due row", () => {
    expect(sweepDecision({ state: "delivered", deadline: future }, now)).toEqual({ fail: false });
  });
  it("never touches a deadline-less row", () => {
    expect(sweepDecision({ state: "delivered" }, now)).toEqual({ fail: false });
  });
  it("isUnconsumed covers submitted/delivered only", () => {
    expect(isUnconsumed("submitted")).toBe(true);
    expect(isUnconsumed("delivered")).toBe(true);
    expect(isUnconsumed("consumed")).toBe(false);
    expect(isUnconsumed("failed")).toBe(false);
  });
});

describe("federation-classify — Message policy + per-table owner field (flair#1521)", () => {
  it("Message is registered principal-owning, owning by `from`", () => {
    expect(FEDERATION_TABLE_POLICY.Message.principalOwning).toBe(true);
    expect(PRINCIPAL_OWNING_TABLES.has("Message")).toBe(true);
    expect(FEDERATION_SYNC_TABLES).toContain("Message");
    expect(principalOwnerField("Message")).toBe("from");
    expect(principalOwnerField("Memory")).toBe("agentId");
    expect(principalOwnerField("Unknown")).toBe("agentId");
  });

  it("checkPrincipalEntitlement uses `from` for a v:2 Message record", () => {
    const ok: any = {
      table: "Message",
      id: "m1",
      data: { id: "m1", from: "alice" },
      updatedAt: "2026-09-04T00:00:00Z",
      originatorInstanceId: "spoke-1",
      principalId: "alice",
      v: 2,
    };
    expect(checkPrincipalEntitlement(ok)).toBeNull();

    const mismatch = { ...ok, principalId: "bob" };
    expect(checkPrincipalEntitlement(mismatch)).toBe("principal_mismatch");

    // Memory still keys on agentId — the map didn't disturb the existing table.
    const mem: any = {
      table: "Memory",
      id: "mem1",
      data: { id: "mem1", agentId: "carol" },
      updatedAt: "2026-09-04T00:00:00Z",
      originatorInstanceId: "spoke-1",
      principalId: "carol",
      v: 2,
    };
    expect(checkPrincipalEntitlement(mem)).toBeNull();
    expect(checkPrincipalEntitlement({ ...mem, principalId: "eve" })).toBe("principal_mismatch");
  });
});
