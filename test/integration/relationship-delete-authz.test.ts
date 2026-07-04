// Relationship.delete() cross-agent authorization — real-Harper integration
// test (ops-sgjr).
//
// Relationship.ts's delete() (~line 144) has a non-admin ownership guard that
// calls `super.get()` with NO id argument before allowing the delete:
//
//   if (!isAdminAgent) {
//     const existing = await super.get();            // <-- no target passed
//     if (existing?.agentId && existing.agentId !== authAgent) {
//       return 403 ...
//     }
//   }
//   return super.delete(_);                            // _ is the real target
//
// INVESTIGATED (ops-sgjr): this LOOKS like an authz bypass (get() with no id
// vs. the correctly-threaded `super.get(target)` in get() at ~line 39-69),
// but it is NOT — verified against a real Harper instance below. Harper's REST
// layer resolves a Table resource instance to the URL's id via
// getResource()->_loadRecord() (Table.ts) BEFORE calling ANY instance method
// (get/put/delete/patch), binding `this.#record` to the target record. Table's
// instance get(target?) (Table.ts ~line 1172), called with target===undefined,
// falls through every special-cased branch (string-property, search-target,
// collection-describe, the loadAsInstance===false path) since none match on
// undefined, and lands on the final fallback that returns `this.#record` —
// i.e. the already-bound target record, not an empty/collection result.
// Confirmed: the cross-agent DELETE below returns exactly the ownership
// guard's own 403 body (`"cannot delete another agent's relationship"`), not
// a generic Harper RBAC denial, proving the guard's `existing.agentId` really
// is the target's owner. This file is kept as a permanent regression guard
// (the correctness relies on an implicit invariant — Relationship not setting
// `getReturnMutable` — that isn't visible from delete()'s own code).
//
// MODEL: test/integration/flair-agent-deelevation.test.ts (mkAgent/ed25519Header
// /adminOp helpers, real Harper via startHarper()).
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import nacl from "tweetnacl";
import { randomUUID } from "node:crypto";
import { startHarper, stopHarper, HarperInstance } from "../helpers/harper-lifecycle";

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

let harper: HarperInstance;
const owner = mkAgent("relauthz-owner");
const other = mkAgent("relauthz-other");
const adminAgent = mkAgent("relauthz-admin");

async function putRelationship(agent: TestAgent, id: string): Promise<Response> {
  const path = `/Relationship/${id}`;
  return fetch(`${harper.httpURL}${path}`, {
    method: "PUT",
    headers: { Authorization: ed25519Header(agent, "PUT", path), "Content-Type": "application/json" },
    body: JSON.stringify({ id, subject: "nathan", predicate: "manages", object: "flint" }),
  });
}

async function deleteRelationship(agent: TestAgent, id: string): Promise<Response> {
  const path = `/Relationship/${id}`;
  return fetch(`${harper.httpURL}${path}`, {
    method: "DELETE",
    headers: { Authorization: ed25519Header(agent, "DELETE", path) },
  });
}

async function getRelationshipAsAdmin(id: string): Promise<any> {
  // Direct DB read via ops API (bypasses the resource's own read gate) so we
  // can assert existence/non-existence independent of Relationship.get()'s
  // own behavior.
  const res = await adminOp(harper, {
    operation: "search_by_value",
    database: "flair",
    table: "Relationship",
    search_attribute: "id",
    search_value: id,
    get_attributes: ["id", "agentId", "subject", "predicate", "object"],
  });
  const body: any = await res.json();
  return Array.isArray(body) && body.length > 0 ? body[0] : null;
}

describe("Relationship.delete() cross-agent authorization (ops-sgjr)", () => {
  beforeAll(async () => {
    harper = await startHarper();

    for (const a of [owner, other]) {
      const res = await adminOp(harper, {
        operation: "insert", database: "flair", table: "Agent",
        records: [{ id: a.id, name: a.id, role: "agent", publicKey: a.publicKey, createdAt: new Date().toISOString() }],
      });
      expect(res.status).toBe(200);
    }
    const adminRes = await adminOp(harper, {
      operation: "insert", database: "flair", table: "Agent",
      records: [{ id: adminAgent.id, name: adminAgent.id, role: "admin", publicKey: adminAgent.publicKey, createdAt: new Date().toISOString() }],
    });
    expect(adminRes.status).toBe(200);
  }, 180_000);

  afterAll(async () => { if (harper) await stopHarper(harper); });

  test("REPRO (ops-sgjr): non-admin cross-agent DELETE is rejected with 403 and the record survives", async () => {
    const id = `repro-${randomUUID()}`;
    const putRes = await putRelationship(owner, id);
    expect([200, 204], `owner PUT returned ${putRes.status}: ${(await putRes.text()).slice(0, 200)}`).toContain(putRes.status);

    const before = await getRelationshipAsAdmin(id);
    expect(before, "seed record should exist before the cross-agent delete attempt").not.toBeNull();
    expect(before.agentId).toBe(owner.id);

    const delRes = await deleteRelationship(other, id);
    const delText = await delRes.text();

    const after = await getRelationshipAsAdmin(id);

    // The assertion we WANT to hold (post-fix). If the bypass is real (pre-fix),
    // this will fail with delRes.status !== 403 and/or `after` being null.
    expect(delRes.status, `cross-agent DELETE by non-owner returned ${delRes.status}: ${delText.slice(0, 300)}`).toBe(403);
    expect(after, "record must still exist after a blocked cross-agent delete").not.toBeNull();
    expect(after?.agentId).toBe(owner.id);
  }, 30_000);

  test("owner deleting their own relationship succeeds", async () => {
    const id = `owner-own-${randomUUID()}`;
    const putRes = await putRelationship(owner, id);
    expect([200, 204]).toContain(putRes.status);
    expect(await getRelationshipAsAdmin(id)).not.toBeNull();

    const delRes = await deleteRelationship(owner, id);
    const delText = await delRes.text();
    expect([200, 204], `owner DELETE returned ${delRes.status}: ${delText.slice(0, 300)}`).toContain(delRes.status);
    expect(await getRelationshipAsAdmin(id)).toBeNull();
  }, 30_000);

  test("admin deleting another agent's relationship succeeds", async () => {
    const id = `admin-any-${randomUUID()}`;
    const putRes = await putRelationship(owner, id);
    expect([200, 204]).toContain(putRes.status);
    expect(await getRelationshipAsAdmin(id)).not.toBeNull();

    const delRes = await deleteRelationship(adminAgent, id);
    const delText = await delRes.text();
    expect([200, 204], `admin DELETE returned ${delRes.status}: ${delText.slice(0, 300)}`).toContain(delRes.status);
    expect(await getRelationshipAsAdmin(id)).toBeNull();
  }, 30_000);

  test("non-admin DELETE of a non-existent id is handled sensibly (not a 500)", async () => {
    const id = `does-not-exist-${randomUUID()}`;
    const delRes = await deleteRelationship(other, id);
    expect(delRes.status, `DELETE of missing id returned ${delRes.status}`).toBeLessThan(500);
  }, 30_000);
});
