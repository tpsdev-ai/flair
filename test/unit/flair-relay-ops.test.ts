/**
 * flair-relay-ops.test.ts — Flair Relay S1 behavioural acceptance (relay-ops).
 *
 * Exercises the full surface with injected in-memory tables and REAL ed25519
 * keys (no Harper, no module mock): round-trip post->inbox->consume->ack;
 * over-cap 4xx + per-sender sub-cap; absorbing-consumed under a deadline sweep;
 * signature verify + tampered-field reject; contentHash retry-dedup; seq
 * read-ordering; server-resolved orgScope (not settable from the body); no-forge
 * `from`; and the no-existence-oracle response.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import nacl from "tweetnacl";
import { sealMessage, type MessageEnvelope } from "../../resources/relay-lib.js";
import {
  relaySend,
  relayInbox,
  relayConsume,
  relayDeadLetters,
  relaySweepDeadlines,
  type RelayDeps,
} from "../../resources/relay-ops.js";
import type { AgentAuthVerdict } from "../../resources/agent-auth.js";

const ORG = "flair-test-instance";

// ─── mocks ──────────────────────────────────────────────────────────────────

function messagesTable() {
  const store = new Map<string, any>();
  return {
    store,
    get: async (id: string) => store.get(id) ?? null,
    put: async (row: any) => {
      store.set(row.id, { ...row });
      return row;
    },
    search: () => {
      async function* gen() {
        for (const r of store.values()) yield r;
      }
      return gen();
    },
  };
}

type Keyed = { secretKey: Uint8Array; publicKey: string };
const agents = new Map<string, { id: string; publicKey: string }>();
const keys = new Map<string, Keyed>();

function makeAgent(id: string): Keyed {
  const kp = nacl.sign.keyPair();
  const publicKey = Buffer.from(kp.publicKey).toString("base64url");
  const k = { secretKey: kp.secretKey, publicKey };
  keys.set(id, k);
  agents.set(id, { id, publicKey });
  return k;
}

function deps(msgs = messagesTable(), now?: () => Date): RelayDeps & { msgs: ReturnType<typeof messagesTable> } {
  return {
    msgs,
    messages: msgs,
    agents: { get: async (id: string) => agents.get(id) ?? null },
    resolveOrg: async () => ORG,
    now,
  };
}

const agentAuth = (agentId: string, isAdmin = false): AgentAuthVerdict => ({ kind: "agent", agentId, isAdmin });
const internalAuth: AgentAuthVerdict = { kind: "internal" };
const anonAuth: AgentAuthVerdict = { kind: "anonymous" };

function send(from: string, to: string, seq: number, over: Partial<MessageEnvelope> = {}): MessageEnvelope {
  const msg: MessageEnvelope = {
    id: over.id ?? `${from}-${to}-${seq}`,
    orgScope: ORG,
    from,
    to,
    threadId: `${from}:thread`,
    seq,
    kind: "message",
    body: `msg-${seq}`,
    createdAt: over.createdAt ?? new Date(Date.UTC(2026, 8, 4, 0, 0, 0, seq)).toISOString(),
    senderModel: "opus",
    senderProvider: "anthropic",
    senderRunId: "run-1",
    ...over,
  };
  return sealMessage(msg, keys.get(from)!.secretKey);
}

const isResponse = (x: unknown): x is Response => x instanceof Response;

beforeEach(() => {
  agents.clear();
  keys.clear();
  makeAgent("alice");
  makeAgent("bob");
  makeAgent("carol");
  delete process.env.FLAIR_RELAY_INBOX_CAP;
  delete process.env.FLAIR_RELAY_PER_SENDER_CAP;
});
afterEach(() => {
  delete process.env.FLAIR_RELAY_INBOX_CAP;
  delete process.env.FLAIR_RELAY_PER_SENDER_CAP;
});

// ─── round-trip ──────────────────────────────────────────────────────────────

describe("round-trip: post -> inbox -> consume -> ack", () => {
  it("delivers, appears in the recipient inbox, then consumes to absorbing", async () => {
    const d = deps();
    const accepted = await relaySend(d, agentAuth("alice"), send("alice", "bob", 1));
    expect(isResponse(accepted)).toBe(false);
    expect((accepted as MessageEnvelope).state).toBe("delivered");
    expect((accepted as MessageEnvelope).deliveredAt).toBeTruthy();

    const inbox = (await relayInbox(d, agentAuth("bob"))) as MessageEnvelope[];
    expect(inbox.map((m) => m.id)).toEqual(["alice-bob-1"]);

    const consumed = (await relayConsume(d, agentAuth("bob"), "alice-bob-1")) as MessageEnvelope;
    expect(consumed.state).toBe("consumed");
    expect(consumed.consumedAt).toBeTruthy();

    const after = (await relayInbox(d, agentAuth("bob"))) as MessageEnvelope[];
    expect(after).toEqual([]);
  });

  it("consume is idempotent — a second ack never regresses (absorbing)", async () => {
    const d = deps();
    await relaySend(d, agentAuth("alice"), send("alice", "bob", 1));
    const first = (await relayConsume(d, agentAuth("bob"), "alice-bob-1")) as MessageEnvelope;
    const firstAt = first.consumedAt;
    const second = (await relayConsume(d, agentAuth("bob"), "alice-bob-1")) as MessageEnvelope;
    expect(second.state).toBe("consumed");
    expect(second.consumedAt).toBe(firstAt);
  });

  it("only the recipient may consume; anyone else gets an indistinguishable 404", async () => {
    const d = deps();
    await relaySend(d, agentAuth("alice"), send("alice", "bob", 1));
    const res = await relayConsume(d, agentAuth("carol"), "alice-bob-1");
    expect(isResponse(res)).toBe(true);
    expect((res as Response).status).toBe(404);
    // a genuinely missing id is the SAME 404 — no enumeration
    const missing = await relayConsume(d, agentAuth("bob"), "does-not-exist");
    expect((missing as Response).status).toBe(404);
  });
});

// ─── over-cap + per-sender sub-cap ──────────────────────────────────────────

describe("over-cap rejection with a per-sender sub-cap", () => {
  it("one hostile sender fills only its sub-cap and cannot lock out others", async () => {
    process.env.FLAIR_RELAY_INBOX_CAP = "10";
    process.env.FLAIR_RELAY_PER_SENDER_CAP = "2";
    const d = deps();

    expect(isResponse(await relaySend(d, agentAuth("alice"), send("alice", "bob", 1)))).toBe(false);
    expect(isResponse(await relaySend(d, agentAuth("alice"), send("alice", "bob", 2)))).toBe(false);

    // alice's 3rd is rejected synchronously at her sub-cap
    const over = await relaySend(d, agentAuth("alice"), send("alice", "bob", 3));
    expect(isResponse(over)).toBe(true);
    expect((over as Response).status).toBe(429);
    const body = await (over as Response).json();
    expect(body.reason).toBe("inbox_full");
    expect(body.scope).toBe("sender");

    // carol is unaffected — the whole point of the sub-cap
    const carol = await relaySend(d, agentAuth("carol"), send("carol", "bob", 1));
    expect(isResponse(carol)).toBe(false);
  });

  it("rejects at the global inbox cap with recipient scope", async () => {
    process.env.FLAIR_RELAY_INBOX_CAP = "2";
    process.env.FLAIR_RELAY_PER_SENDER_CAP = "10";
    const d = deps();
    await relaySend(d, agentAuth("alice"), send("alice", "bob", 1));
    await relaySend(d, agentAuth("carol"), send("carol", "bob", 1));
    const over = (await relaySend(d, agentAuth("alice"), send("alice", "bob", 2))) as Response;
    expect(over.status).toBe(429);
    expect((await over.json()).scope).toBe("recipient");
  });

  it("a consumed message frees inbox room (cap counts only unconsumed)", async () => {
    process.env.FLAIR_RELAY_PER_SENDER_CAP = "1";
    process.env.FLAIR_RELAY_INBOX_CAP = "10";
    const d = deps();
    await relaySend(d, agentAuth("alice"), send("alice", "bob", 1));
    expect((await relaySend(d, agentAuth("alice"), send("alice", "bob", 2)) as Response).status).toBe(429);
    await relayConsume(d, agentAuth("bob"), "alice-bob-1");
    // now under the sub-cap again
    expect(isResponse(await relaySend(d, agentAuth("alice"), send("alice", "bob", 2)))).toBe(false);
  });
});

// ─── absorbing-consumed under a deadline sweep ──────────────────────────────

describe("absorbing-consumed: a deadline sweep after consume does NOT flip to failed", () => {
  it("consumed stays consumed; an unconsumed past-deadline peer fails visibly", async () => {
    const past = "2020-01-01T00:00:00.000Z";
    const d = deps();

    // A: consumed, with a past deadline
    await relaySend(d, agentAuth("alice"), send("alice", "bob", 1, { deadline: past }));
    await relayConsume(d, agentAuth("bob"), "alice-bob-1");
    // B: unconsumed, past deadline
    await relaySend(d, agentAuth("alice"), send("alice", "bob", 2, { deadline: past }));

    const swept = (await relaySweepDeadlines(d, internalAuth)) as { failed: number };
    expect(swept.failed).toBe(1);

    expect(d.msgs.store.get("alice-bob-1").state).toBe("consumed"); // absorbing — untouched
    const b = d.msgs.store.get("alice-bob-2");
    expect(b.state).toBe("failed");
    expect(b.failureReason).toBe("deadline");
  });

  it("the failed message surfaces to the SENDER as a visible dead-letter", async () => {
    const past = "2020-01-01T00:00:00.000Z";
    const d = deps();
    await relaySend(d, agentAuth("alice"), send("alice", "bob", 1, { deadline: past }));
    await relaySweepDeadlines(d, internalAuth);

    const dead = (await relayDeadLetters(d, agentAuth("alice"))) as MessageEnvelope[];
    expect(dead.map((m) => m.id)).toEqual(["alice-bob-1"]);
    expect(dead[0].failureReason).toBe("deadline");
  });

  it("deadline sweep is admin/internal only", async () => {
    const d = deps();
    const res = await relaySweepDeadlines(d, agentAuth("alice"));
    expect(isResponse(res)).toBe(true);
    expect((res as Response).status).toBe(403);
  });
});

// ─── signature verify + tampered-field reject ───────────────────────────────

describe("signature verification on post", () => {
  it("rejects a message whose body was tampered after signing", async () => {
    const d = deps();
    const sealed = send("alice", "bob", 1);
    const tampered = { ...sealed, body: "evil" };
    const res = (await relaySend(d, agentAuth("alice"), tampered)) as Response;
    expect(res.status).toBe(400);
    expect(d.msgs.store.size).toBe(0);
  });

  it("rejects a message from an unknown sender principal", async () => {
    const d = deps();
    agents.delete("alice");
    const res = (await relaySend(d, agentAuth("alice"), send("alice", "bob", 1))) as Response;
    // sealed BEFORE deletion; sender key now unknown
    expect(res.status).toBe(403);
  });
});

// ─── contentHash retry-dedup ────────────────────────────────────────────────

describe("contentHash retry-dedup", () => {
  it("an identical resend returns the accepted envelope without a second row", async () => {
    const d = deps();
    const msg = send("alice", "bob", 1);
    const first = (await relaySend(d, agentAuth("alice"), { ...msg })) as MessageEnvelope;
    const second = (await relaySend(d, agentAuth("alice"), { ...msg })) as MessageEnvelope;
    expect(isResponse(first)).toBe(false);
    expect(isResponse(second)).toBe(false);
    expect(d.msgs.store.size).toBe(1);
    expect(second.id).toBe(first.id);
  });

  it("dedups identical content even under a different id (contentHash, not id)", async () => {
    const d = deps();
    await relaySend(d, agentAuth("alice"), send("alice", "bob", 1));
    // same content, different id (createdAt/id are excluded from contentHash)
    const resend = send("alice", "bob", 1, { id: "alice-bob-1-retry", createdAt: "2026-09-04T12:00:00.000Z" });
    await relaySend(d, agentAuth("alice"), resend);
    expect(d.msgs.store.size).toBe(1);
  });
});

// ─── seq read-ordering ──────────────────────────────────────────────────────

describe("seq read-ordering (createdAt collides at ms)", () => {
  it("inbox is sorted by seq regardless of arrival/createdAt order", async () => {
    const d = deps();
    const sameMs = "2026-09-04T00:00:00.000Z";
    // seq is monotonic PER (from, threadId), so out-of-order arrival within one
    // thread is now rejected — spread across threads to keep arrival order (3,1,2
    // by seq) different from the seq-sorted output while each thread stays
    // monotonic. The sort is over the whole inbox, so it still proves seq-sort.
    await relaySend(d, agentAuth("alice"), send("alice", "bob", 3, { createdAt: sameMs, threadId: "alice:t1" }));
    await relaySend(d, agentAuth("alice"), send("alice", "bob", 1, { createdAt: sameMs, threadId: "alice:t2" }));
    await relaySend(d, agentAuth("alice"), send("alice", "bob", 2, { createdAt: sameMs, threadId: "alice:t3" }));
    const inbox = (await relayInbox(d, agentAuth("bob"))) as MessageEnvelope[];
    expect(inbox.map((m) => m.seq)).toEqual([1, 2, 3]);
  });
});

// ─── seq monotonicity per (from, threadId) (Sherlock P1) ────────────────────

describe("seq monotonicity per (from, threadId)", () => {
  it("rejects a seq that is not strictly ahead of the thread's last seq", async () => {
    const d = deps();
    expect(isResponse(await relaySend(d, agentAuth("alice"), send("alice", "bob", 5)))).toBe(false);
    // same (from, threadId), seq 5 again → conflict (not > prev max)
    const equal = (await relaySend(d, agentAuth("alice"), send("alice", "bob", 5, { id: "dup-seq", body: "different" }))) as Response;
    expect(equal.status).toBe(409);
    expect((await equal.json()).reason).toBe("seq_conflict");
    // a lower seq is also rejected
    const lower = (await relaySend(d, agentAuth("alice"), send("alice", "bob", 3, { body: "different-2" }))) as Response;
    expect(lower.status).toBe(409);
    // a strictly higher seq is accepted
    expect(isResponse(await relaySend(d, agentAuth("alice"), send("alice", "bob", 6)))).toBe(false);
  });

  it("an identical retry (same content) is deduped, never a seq conflict", async () => {
    const d = deps();
    const msg = send("alice", "bob", 2);
    expect(isResponse(await relaySend(d, agentAuth("alice"), { ...msg }))).toBe(false);
    // resend the SAME content (same seq) — dedup wins before the monotonicity check
    const retry = await relaySend(d, agentAuth("alice"), { ...msg });
    expect(isResponse(retry)).toBe(false);
    expect(d.msgs.store.size).toBe(1);
  });

  it("monotonicity is per-thread — a fresh threadId starts clean", async () => {
    const d = deps();
    await relaySend(d, agentAuth("alice"), send("alice", "bob", 9, { threadId: "alice:tA" }));
    // seq 1 in a DIFFERENT thread is fine even though thread A is at 9
    expect(isResponse(await relaySend(d, agentAuth("alice"), send("alice", "bob", 1, { threadId: "alice:tB" })))).toBe(false);
  });
});

// ─── send-time field validation (Kern nits + Sherlock P1) ───────────────────

describe("send-time validation", () => {
  it("rejects a missing `from` (required, signed — never server-defaulted)", async () => {
    const d = deps();
    const msg = send("alice", "bob", 1);
    delete (msg as any).from;
    const res = (await relaySend(d, agentAuth("alice"), msg)) as Response;
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("from");
  });

  it("rejects a negative seq (seq >= 0)", async () => {
    const d = deps();
    const res = (await relaySend(d, agentAuth("alice"), send("alice", "bob", -1))) as Response;
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("non-negative");
  });

  it("rejects a garbage deadline (would otherwise sweep to failed immediately)", async () => {
    const d = deps();
    const res = (await relaySend(d, agentAuth("alice"), send("alice", "bob", 1, { deadline: "not-a-date" }))) as Response;
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("deadline");
    expect(d.msgs.store.size).toBe(0);
  });

  it("strips client-supplied lifecycle fields from the stored row", async () => {
    const d = deps();
    const msg = send("alice", "bob", 1);
    // lifecycle fields are NOT under the signature — a client could smuggle them
    (msg as any).consumedAt = "2020-01-01T00:00:00.000Z";
    (msg as any).failureReason = "inbox_full";
    (msg as any).state = "consumed";
    const accepted = (await relaySend(d, agentAuth("alice"), msg)) as MessageEnvelope;
    expect(isResponse(accepted)).toBe(false);
    const stored = d.msgs.store.get("alice-bob-1");
    expect(stored.state).toBe("delivered"); // server-set, not the smuggled "consumed"
    expect(stored.consumedAt).toBeUndefined();
    expect(stored.failureReason).toBeUndefined();
  });
});

// ─── orgScope is server-resolved, not settable from the body ────────────────

describe("orgScope cannot be set from the body (§12 P0(S))", () => {
  it("rejects a message whose signed orgScope is a foreign/forged scope", async () => {
    const d = deps();
    // sealed over orgScope "evil-org" — a valid signature over the wrong scope
    const forged = send("alice", "bob", 1, { orgScope: "evil-org" });
    const res = (await relaySend(d, agentAuth("alice"), forged)) as Response;
    expect(res.status).toBe(403);
    expect(d.msgs.store.size).toBe(0);
  });
});

// ─── no-forge `from` + no existence oracle ──────────────────────────────────

describe("no-forge from and no existence oracle", () => {
  it("a non-admin cannot send AS another principal", async () => {
    const d = deps();
    // alice authenticates but claims from=bob (even validly signed by bob)
    const asBob = sealMessage(
      {
        id: "spoof",
        orgScope: ORG,
        from: "bob",
        to: "carol",
        threadId: "bob:t",
        seq: 1,
        kind: "message",
        body: "spoof",
        createdAt: "2026-09-04T00:00:00.000Z",
      },
      keys.get("bob")!.secretKey,
    );
    const res = (await relaySend(d, agentAuth("alice"), asBob)) as Response;
    expect(res.status).toBe(403);
  });

  it("a send to a non-existent recipient still returns the same accepted envelope", async () => {
    const d = deps();
    const accepted = await relaySend(d, agentAuth("alice"), send("alice", "ghost", 1));
    expect(isResponse(accepted)).toBe(false);
    expect((accepted as MessageEnvelope).state).toBe("delivered");
    // it was actually stored — indistinguishable from a real recipient
    expect(d.msgs.store.size).toBe(1);
  });

  it("anonymous is denied", async () => {
    const d = deps();
    const res = (await relaySend(d, anonAuth, send("alice", "bob", 1))) as Response;
    expect(res.status).toBe(401);
  });
});
