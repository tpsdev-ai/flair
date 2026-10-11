/**
 * orgevent-post-id-ownership-2333.test.ts — flair#2333 slice 4 (N2), real Harper.
 *
 * OrgEvent.post() is reachable over REST: since Harper 5.2 a bare
 * `POST /OrgEvent` is routed to the resource's post() override (see the
 * "sanity" case in workspace-orgevent-cli-e2e.test.ts). post() mints an id when
 * the body carries none, but a caller-supplied id was written straight through
 * to the underlying table write with no ownership guard, so agent B could POST
 * with agent A's existing event id and overwrite A's event.
 *
 * These cases drive a spawned Harper over real HTTP. An event owned by agent A
 * exists; agent B POSTs with that id. Safe outcome: the write is refused and A's
 * stored event is unchanged. A control case shows a fresh id still writes.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import nacl from "tweetnacl";
import { HarperInstance, startHarper, stopHarper } from "../helpers/harper-lifecycle";

interface TestAgent { id: string; publicKey: string; secretKey: Uint8Array; }
function mkAgent(id: string): TestAgent {
  const kp = nacl.sign.keyPair();
  return { id, publicKey: Buffer.from(kp.publicKey).toString("base64"), secretKey: kp.secretKey };
}
function ed25519Header(agent: TestAgent, method: string, path: string): string {
  const ts = Date.now().toString();
  const nonce = randomUUID();
  const payload = `${agent.id}:${ts}:${nonce}:${method}:${path}`;
  const sig = nacl.sign.detached(new TextEncoder().encode(payload), agent.secretKey);
  return `TPS-Ed25519 ${agent.id}:${ts}:${nonce}:${Buffer.from(sig).toString("base64")}`;
}
function assertOwnInstance(harper: HarperInstance): void {
  const http = new URL(harper.httpURL);
  const ops = new URL(harper.opsURL);
  for (const u of [http, ops]) {
    const port = Number(u.port);
    if (u.hostname !== "127.0.0.1" || !(port > 0) || port === 9925 || port === 9926) {
      throw new Error(`refusing to run against ${u.href}: not this test's ephemeral instance`);
    }
  }
  if (http.port === ops.port || !harper.process?.pid || !harper.installDir.startsWith(tmpdir())) {
    throw new Error(`refusing to run: ${harper.httpURL} / ${harper.opsURL} is not an instance this test started`);
  }
}
async function authSend(harper: HarperInstance, agent: TestAgent, method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${harper.httpURL}${path}`, {
    method,
    headers: { Authorization: ed25519Header(agent, method, path), "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function adminOp(harper: HarperInstance, op: Record<string, any>): Promise<Response> {
  return fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`) },
    body: JSON.stringify(op),
  });
}
async function seedAgent(harper: HarperInstance, agent: TestAgent): Promise<void> {
  const res = await adminOp(harper, {
    operation: "insert", database: "flair", table: "Agent",
    records: [{ id: agent.id, name: agent.id, role: "agent", publicKey: agent.publicKey, createdAt: new Date().toISOString() }],
  });
  expect(res.status, `seed agent returned ${res.status}`).toBe(200);
}
async function readEvent(harper: HarperInstance, id: string): Promise<any> {
  const res = await adminOp(harper, {
    operation: "search_by_hash", database: "flair", table: "OrgEvent", hash_values: [id], get_attributes: ["*"],
  });
  const text = await res.text();
  expect(res.status, `search_by_hash returned ${res.status}: ${text.slice(0, 200)}`).toBe(200);
  return (JSON.parse(text) as any[])[0] ?? null;
}

let harper: HarperInstance;
const owner = mkAgent("oep-owner");
const other = mkAgent("oep-other");

const OWNED_ID = "oep-owner-event";

beforeAll(async () => {
  harper = await startHarper();
  assertOwnInstance(harper);
  await seedAgent(harper, owner);
  await seedAgent(harper, other);
  // The owner's event, created the way a client with the id in hand would.
  const res = await authSend(harper, owner, "PUT", `/OrgEvent/${OWNED_ID}`, {
    id: OWNED_ID, authorId: owner.id, kind: "status", summary: "the owner's original event", createdAt: new Date().toISOString(),
  });
  expect(res.status, (await res.text()).slice(0, 300)).toBeLessThan(300);
  const row = await readEvent(harper, OWNED_ID);
  expect(row?.authorId, "owner event was not created").toBe(owner.id);
}, 240_000);

afterAll(async () => { if (harper) await stopHarper(harper); });

describe("flair#2333 N2 — a non-admin agent cannot overwrite another agent's OrgEvent", () => {
  it("a POST naming another agent's existing event id is refused and leaves the event unchanged", async () => {
    const res = await authSend(harper, other, "POST", "/OrgEvent", {
      id: OWNED_ID, kind: "coord.claim", summary: "overwrite attempt by another agent",
    });
    expect(res.status, (await res.text()).slice(0, 300)).toBe(403);
    const row = await readEvent(harper, OWNED_ID);
    expect(row?.authorId).toBe(owner.id);
    expect(row?.summary).toBe("the owner's original event");
    expect(row?.kind).toBe("status");
  }, 30_000);

  it("a POST naming another agent's id AND that agent's authorId is refused too", async () => {
    const res = await authSend(harper, other, "POST", "/OrgEvent", {
      id: OWNED_ID, authorId: owner.id, kind: "coord.claim", summary: "forged-author overwrite attempt",
    });
    expect(res.status, (await res.text()).slice(0, 300)).toBe(403);
    const row = await readEvent(harper, OWNED_ID);
    expect(row?.authorId).toBe(owner.id);
    expect(row?.summary).toBe("the owner's original event");
  }, 30_000);

  it("control: a POST with a fresh id still writes as the caller", async () => {
    const res = await authSend(harper, other, "POST", "/OrgEvent", {
      kind: "status", summary: "a fresh event from the other agent",
    });
    expect(res.status, (await res.text()).slice(0, 300)).toBeLessThan(300);
    const row = await readEvent(harper, OWNED_ID);
    // The owner's row is still intact after a legitimate write by another agent.
    expect(row?.summary).toBe("the owner's original event");
  }, 30_000);
});
