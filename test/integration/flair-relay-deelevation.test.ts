// Flair Relay S1 de-elevation integration test (flair#1521, Kern P0-2 / P0-1).
//
// This is the test class the relay-ops UNIT suite structurally CANNOT catch:
// every relay-ops assertion runs the orchestration directly with an injected
// auth verdict, so it never exercises Harper's HTTP dispatch — which authorizes
// (allowCreate / table permissions) BEFORE the resource methods run. The two
// P0s live exactly there:
//
//   P0-2 — send/ack are 403 for a de-elevated flair_agent unless (a) Message
//          carries a FLAIR_AGENT_PERMISSION grant AND (b) Message/MessageAck
//          override allowCreate→allowVerified. Proven here: agent POST /Message
//          and POST /MessageAck are NOT 403 against a real Harper with the
//          role+user provisioned (so agents resolve to flair-agent, not admin).
//
//   P0-1 — GET /Message (collection) leaks every row to any verified agent
//          unless the collection read is party-scoped (from/to === self).
//          Proven here: a message between two OTHER principals is absent from a
//          third agent's collection read; only its own party rows come back.
//
// Uses the same harness as flair-agent-deelevation.test.ts (startHarper +
// ensureFlairAgentRole/User + a TPS-Ed25519 header). No embeddings/Memory seed —
// Message never embeds, so this needs no model.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import nacl from "tweetnacl";
import { randomUUID } from "node:crypto";
import { startHarper, stopHarper, HarperInstance } from "../helpers/harper-lifecycle";
import { ensureFlairAgentRole, ensureFlairAgentUser } from "../../src/cli";
import { sealMessage, type MessageEnvelope } from "../../resources/relay-lib";

interface TestAgent { id: string; publicKey: string; secretKey: Uint8Array; }

// base64url so BOTH the TPS-Ed25519 auth path (ed25519-auth.ts importEd25519Key
// → b64.ts, which normalizes base64url) AND relay-lib's verifyMessageSignature
// (Buffer.from(key, "base64url")) decode the same 32 bytes with no ambiguity.
function mkAgent(id: string): TestAgent {
  const kp = nacl.sign.keyPair();
  return { id, publicKey: Buffer.from(kp.publicKey).toString("base64url"), secretKey: kp.secretKey };
}

function ed25519Header(agent: TestAgent, method: string, path: string): string {
  const ts = Date.now().toString();
  const nonce = randomUUID();
  const payload = `${agent.id}:${ts}:${nonce}:${method}:${path}`;
  const sig = nacl.sign.detached(new TextEncoder().encode(payload), agent.secretKey);
  return `TPS-Ed25519 ${agent.id}:${ts}:${nonce}:${Buffer.from(sig).toString("base64")}`;
}

async function adminOp(harper: HarperInstance, op: Record<string, any>): Promise<Response> {
  return fetch(harper.opsURL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`),
    },
    body: JSON.stringify(op),
  });
}

/** Read a Message row by id as the super_user admin (bypasses the party scope),
 *  so a test can assert a foreign row's state is UNCHANGED after a rejected
 *  agent mutation — the ground-truth invariant, independent of the HTTP code. */
async function readRowAsAdmin(id: string): Promise<any | null> {
  const res = await fetch(`${harper.httpURL}/Message/${encodeURIComponent(id)}`, {
    headers: { Authorization: "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`) },
  });
  if (!res.ok) return null;
  return res.json().catch(() => null);
}

let harper: HarperInstance;
let orgScope = "local";
const agent = mkAgent("relay-agent");
const other = mkAgent("relay-other");
const third = mkAgent("relay-third");
const byId: Record<string, TestAgent> = { [agent.id]: agent, [other.id]: other, [third.id]: third };

/** Seal a message from `fromId` (using its secret key) with the server-resolved
 *  orgScope, then POST it to /Message as that agent over TPS-Ed25519. */
async function sendAs(fromId: string, toId: string, seq: number, over: Partial<MessageEnvelope> = {}) {
  const sender = byId[fromId];
  const base: MessageEnvelope = {
    id: over.id ?? `${fromId}-${toId}-${seq}-${randomUUID().slice(0, 8)}`,
    orgScope,
    from: fromId,
    to: toId,
    threadId: over.threadId ?? `${fromId}:${toId}:thread`,
    seq,
    kind: "message",
    body: over.body ?? `hello ${seq}`,
    createdAt: over.createdAt ?? new Date().toISOString(),
    senderModel: "opus",
    senderProvider: "anthropic",
    senderRunId: "run-1",
    ...over,
  };
  const sealed = sealMessage(base, sender.secretKey);
  const path = "/Message";
  const res = await fetch(`${harper.httpURL}${path}`, {
    method: "POST",
    headers: { Authorization: ed25519Header(sender, "POST", path), "Content-Type": "application/json" },
    body: JSON.stringify(sealed),
  });
  const text = await res.text();
  return { status: res.status, text, id: sealed.id! };
}

describe("Flair Relay S1 — de-elevated flair_agent can send/ack, and reads are party-scoped", () => {
  beforeAll(async () => {
    harper = await startHarper();

    // Provision the least-privilege role + shared user via the REAL functions,
    // so verified agents resolve to flair-agent (the de-elevated path).
    await ensureFlairAgentRole(harper.opsURL, harper.admin.username, harper.admin.password);
    await ensureFlairAgentUser(harper.opsURL, harper.admin.username, harper.admin.password);

    for (const a of [agent, other, third]) {
      const res = await adminOp(harper, {
        operation: "insert", database: "flair", table: "Agent",
        records: [{ id: a.id, name: a.id, role: "agent", publicKey: a.publicKey, createdAt: new Date().toISOString() }],
      });
      expect(res.status).toBe(200);
    }

    // Resolve the org exactly the way relaySend does server-side (localInstanceId
    // → the sole Instance row's id, or the "local" sentinel when none exists).
    // orgScope is inside the SIGNED body and enforce-equal on send, so the test
    // must sign the value the server will resolve.
    const instRes = await fetch(`${harper.httpURL}/Instance/`, {
      headers: { Authorization: "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`) },
    });
    if (instRes.ok) {
      const rows = await instRes.json().catch(() => null);
      if (Array.isArray(rows) && rows.length > 0 && rows[0]?.id) orgScope = String(rows[0].id);
    }
  }, 180_000);

  afterAll(async () => { if (harper) await stopHarper(harper); });

  // P0-2 (a+b): the whole S1 surface is admin-only without the grant + the
  // allowCreate overrides. A de-elevated agent's send must not 403.
  test("P0-2: agent POST /Message is authorized under flair_agent (not 403)", async () => {
    const r = await sendAs(agent.id, other.id, 0);
    expect([401, 403], `POST /Message returned ${r.status}: ${r.text.slice(0, 300)}`).not.toContain(r.status);
    expect(r.status, `POST /Message returned ${r.status}: ${r.text.slice(0, 300)}`).toBeLessThan(300);
  }, 60_000);

  // A real ack: `other` sends to `agent`, agent reads its inbox (exercises the
  // indexed `to` query against real Harper), then acks (POST /MessageAck) — the
  // core primitive, admin-only as shipped without the allowCreate override.
  test("P0-2: agent POST /MessageAck is authorized under flair_agent (not 403)", async () => {
    const sent = await sendAs(other.id, agent.id, 0, { threadId: "other:agent:ack" });
    expect(sent.status, `other→agent send ${sent.status}: ${sent.text.slice(0, 300)}`).toBeLessThan(300);

    const inboxPath = `/MessageInbox/${agent.id}`;
    const inboxRes = await fetch(`${harper.httpURL}${inboxPath}`, {
      headers: { Authorization: ed25519Header(agent, "GET", inboxPath) },
    });
    const inboxText = await inboxRes.text();
    expect(inboxRes.status, `inbox ${inboxRes.status}: ${inboxText.slice(0, 300)}`).toBe(200);
    const inbox = JSON.parse(inboxText);
    expect(Array.isArray(inbox) ? inbox.map((m: any) => m.id) : [], "inbox should contain the sent message").toContain(sent.id);

    const ackPath = "/MessageAck";
    const ackRes = await fetch(`${harper.httpURL}${ackPath}`, {
      method: "POST",
      headers: { Authorization: ed25519Header(agent, "POST", ackPath), "Content-Type": "application/json" },
      body: JSON.stringify({ id: sent.id }),
    });
    const ackText = await ackRes.text();
    expect([401, 403], `POST /MessageAck returned ${ackRes.status}: ${ackText.slice(0, 300)}`).not.toContain(ackRes.status);
    expect(ackRes.status, `POST /MessageAck returned ${ackRes.status}: ${ackText.slice(0, 300)}`).toBeLessThan(300);
  }, 60_000);

  // P0-1: a message between two OTHER principals must NOT appear in a third
  // agent's collection read, and every returned row must be one the reader is a
  // party to (from/to === self).
  test("P0-1: GET /Message (collection) does NOT leak other principals' rows", async () => {
    // agent is a party to this one (from === agent)…
    const mine = await sendAs(agent.id, other.id, 1, { threadId: "agent:other:leak" });
    expect(mine.status, `agent send ${mine.status}: ${mine.text.slice(0, 300)}`).toBeLessThan(300);
    // …and NOT a party to this one (other → third).
    const foreign = await sendAs(other.id, third.id, 0, { threadId: "other:third:leak" });
    expect(foreign.status, `other→third send ${foreign.status}: ${foreign.text.slice(0, 300)}`).toBeLessThan(300);

    const path = "/Message/";
    const res = await fetch(`${harper.httpURL}${path}`, {
      headers: { Authorization: ed25519Header(agent, "GET", path) },
    });
    const text = await res.text();
    expect(res.status, `GET /Message collection ${res.status}: ${text.slice(0, 300)}`).toBe(200);
    const rows = JSON.parse(text);
    expect(Array.isArray(rows), `collection read should be an array, got: ${text.slice(0, 200)}`).toBe(true);

    const ids = rows.map((r: any) => r.id);
    expect(ids, "agent's OWN row must be visible").toContain(mine.id);
    expect(ids, "another principal's row must NOT leak").not.toContain(foreign.id);
    // Every returned row is one the reader is a party to — the invariant, not
    // just the two probe ids.
    for (const r of rows) {
      expect(
        r.from === agent.id || r.to === agent.id,
        `leaked a row agent is not a party to: from=${r.from} to=${r.to}`,
      ).toBe(true);
    }
  }, 60_000);

  // Kern P0 (the remaining blocker): PATCH is a DISTINCT Harper verb. Resource.patch
  // is type:update, whose authorize step consults the role's `update` grant — with
  // `update:true` it PASSED for any de-elevated agent and TableResource.patch ran
  // update()+save() directly, NEVER calling Message.put() (so put()'s FORBIDDEN
  // guard AND relayConsume's recipient-only check were both bypassed). Any verified
  // agent could set state / rewrite body/from/to on ANYONE's message. The fix is
  // `update:false` in the grant (closes it at the platform gate) + a Message.patch()
  // override (defense-in-depth). This asserts a de-elevated agent CANNOT mutate a
  // FOREIGN row via PATCH — nor DELETE/COPY/MOVE. The ground-truth invariant is the
  // row-unchanged check via admin read, which holds regardless of the exact HTTP code.
  test("Kern P0: de-elevated agent cannot mutate a foreign row via PATCH/DELETE/COPY/MOVE", async () => {
    // A row `agent` is NOT a party to (from=other, to=third).
    const foreign = await sendAs(other.id, third.id, 5, { threadId: "other:third:tamper", body: "original" });
    expect(foreign.status, `foreign send ${foreign.status}: ${foreign.text.slice(0, 300)}`).toBeLessThan(300);
    const before = await readRowAsAdmin(foreign.id);
    expect(before, "admin must be able to read the seeded foreign row").not.toBeNull();
    expect(before.body, "seeded foreign row body").toBe("original");
    expect(before.state, "seeded foreign row starts unconsumed").not.toBe("consumed");

    const path = `/Message/${foreign.id}`;

    // PATCH — the attack Kern identified: tamper body + force state.
    const patchRes = await fetch(`${harper.httpURL}${path}`, {
      method: "PATCH",
      headers: { Authorization: ed25519Header(agent, "PATCH", path), "Content-Type": "application/json" },
      body: JSON.stringify({ body: "tampered", state: "consumed" }),
    });
    const patchText = await patchRes.text();
    expect(patchRes.status, `PATCH must be a success? got ${patchRes.status}: ${patchText.slice(0, 200)}`).toBeGreaterThanOrEqual(400);
    expect([401, 403, 405], `PATCH /Message/<foreign> returned ${patchRes.status}: ${patchText.slice(0, 200)}`).toContain(patchRes.status);

    // DELETE — already double-guarded (grant delete:false + delete() override); assert it.
    const delRes = await fetch(`${harper.httpURL}${path}`, {
      method: "DELETE",
      headers: { Authorization: ed25519Header(agent, "DELETE", path) },
    });
    const delText = await delRes.text();
    expect(delRes.status, `DELETE must not succeed; got ${delRes.status}: ${delText.slice(0, 200)}`).toBeGreaterThanOrEqual(400);
    expect([401, 403, 405], `DELETE /Message/<foreign> returned ${delRes.status}: ${delText.slice(0, 200)}`).toContain(delRes.status);

    // COPY / MOVE — enumerate the rest of the mutation verb surface.
    for (const verb of ["COPY", "MOVE"]) {
      const res = await fetch(`${harper.httpURL}${path}`, {
        method: verb,
        headers: {
          Authorization: ed25519Header(agent, verb, path),
          Destination: `/Message/${agent.id}-stolen-${verb.toLowerCase()}`,
        },
      });
      const text = await res.text();
      expect(res.status, `${verb} must not succeed; got ${res.status}: ${text.slice(0, 200)}`).toBeGreaterThanOrEqual(400);
    }

    // Ground truth: after all four rejected verbs, the foreign row is BYTE-FOR-BYTE
    // unchanged and still present — no tamper, no state flip, no delete/move.
    const after = await readRowAsAdmin(foreign.id);
    expect(after, "foreign row must still exist (no DELETE/MOVE succeeded)").not.toBeNull();
    expect(after.body, "foreign row body must be untampered").toBe("original");
    expect(after.state, "foreign row state must not have been flipped to consumed").not.toBe("consumed");
    expect(after.from, "foreign row `from` must be unchanged").toBe(other.id);
    expect(after.to, "foreign row `to` must be unchanged").toBe(third.id);
  }, 60_000);
});
