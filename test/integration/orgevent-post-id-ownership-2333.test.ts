/**
 * orgevent-post-id-ownership-2333.test.ts — flair#2333 slice 4, real Harper.
 *
 * Checks ownership refusal for a row observed at the guard's lookup, creation,
 * and random UUID ids with a frozen child clock over real HTTP.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
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
/** Every OrgEvent authored by `authorId`. A POST's response body is empty, so
 *  this is how the tests recover the id/createdAt of a minted event. */
async function eventsByAuthor(harper: HarperInstance, authorId: string): Promise<any[]> {
  const res = await adminOp(harper, {
    operation: "search_by_value", database: "flair", table: "OrgEvent",
    search_attribute: "authorId", search_value: authorId, get_attributes: ["*"],
  });
  const text = await res.text();
  expect(res.status, `search_by_value returned ${res.status}: ${text.slice(0, 200)}`).toBe(200);
  return JSON.parse(text) as any[];
}

let harper: HarperInstance;
const owner = mkAgent("oep-owner");
const other = mkAgent("oep-other");

const OWNED_ID = "oep-owner-event";

beforeAll(async () => {
  // Freeze only this instance's child clock for the same-millisecond case.
  const clockPreload = fileURLToPath(new URL("../helpers/harper-freeze-clock.cjs", import.meta.url));
  harper = await startHarper({
    env: {
      FLAIR_TEST_FROZEN_NOW: String(Date.now()),
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require=${clockPreload}`.trim(),
    },
  });
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

describe("flair#2333 N2 — a non-admin POST is refused for an OrgEvent observed at the guard's lookup as owned by another agent", () => {
  it("refuses a POST for a row observed at the guard's lookup as owned by another agent", async () => {
    const res = await authSend(harper, other, "POST", "/OrgEvent", {
      id: OWNED_ID, kind: "coord.claim", summary: "overwrite attempt by another agent",
    });
    expect(res.status, (await res.text()).slice(0, 300)).toBe(403);
    const row = await readEvent(harper, OWNED_ID);
    expect(row?.authorId).toBe(owner.id);
    expect(row?.summary).toBe("the owner's original event");
    expect(row?.kind).toBe("status");
  }, 30_000);

  it("refuses a POST claiming the observed owner's authorId", async () => {
    const res = await authSend(harper, other, "POST", "/OrgEvent", {
      id: OWNED_ID, authorId: owner.id, kind: "coord.claim", summary: "forged-author overwrite attempt",
    });
    expect(res.status, (await res.text()).slice(0, 300)).toBe(403);
    const row = await readEvent(harper, OWNED_ID);
    expect(row?.authorId).toBe(owner.id);
    expect(row?.summary).toBe("the owner's original event");
  }, 30_000);

  it("control: a POST with a fresh (minted) id still writes as the caller", async () => {
    const res = await authSend(harper, other, "POST", "/OrgEvent", {
      kind: "status", summary: "a fresh event from the other agent",
    });
    expect(res.status, (await res.text()).slice(0, 300)).toBeLessThan(300);
    // Read back the event the POST actually created (by author+summary — the POST
    // body is empty) so the fresh write is shown to land as the caller's own event.
    const mine = (await eventsByAuthor(harper, other.id)).filter(
      (r) => r.summary === "a fresh event from the other agent",
    );
    expect(mine.length, "the fresh POST was not stored as the caller's own event").toBe(1);
    expect(mine[0].authorId).toBe(other.id);
    // The owner's row is still intact after a legitimate write by another agent.
    const row = await readEvent(harper, OWNED_ID);
    expect(row?.summary).toBe("the owner's original event");
  }, 30_000);
});

describe("flair#2333 H9 — avoids deterministic same-millisecond collisions (random UUID, real Harper)", () => {
  it("avoids deterministic same-millisecond collisions (random UUID)", async () => {
    const summaries = [`h9-same-ms-a-${randomUUID()}`, `h9-same-ms-b-${randomUUID()}`];
    for (const summary of summaries) {
      const res = await authSend(harper, other, "POST", "/OrgEvent", { kind: "status", summary });
      expect(res.status, (await res.text()).slice(0, 200)).toBeLessThan(300);
    }
    const rows = (await eventsByAuthor(harper, other.id)).filter((r) => summaries.includes(String(r.summary)));
    // Both same-millisecond posts are stored...
    expect(rows.length, "a same-millisecond post reused another event's id").toBe(2);
    // ...under one server millisecond...
    expect(new Set(rows.map((r) => String(r.createdAt))).size, "the two posts did not share a millisecond").toBe(1);
    // ...with two distinct ids, each readable back by id.
    const ids = rows.map((r) => String(r.id));
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) {
      const row = await readEvent(harper, id);
      expect(row, `same-millisecond event ${id} was not stored`).toBeTruthy();
      expect(summaries.includes(String(row.summary))).toBe(true);
    }
  }, 30_000);
});
