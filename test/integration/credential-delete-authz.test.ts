// Credential.delete() cross-agent authorization — real-Harper integration
// test (follow-up to ops-sgjr / #569).
//
// Credential.ts's delete() (~line 112) has the byte-identical non-admin
// ownership guard that Relationship.delete() had — it calls `super.get()` with
// NO id argument before allowing the delete:
//
//   if (!isAdminAgent) {
//     const existing = await super.get();            // <-- no target passed
//     if (existing?.principalId && existing.principalId !== authAgent) {
//       return 403 "only admin principals can revoke other principals'
//                   credentials"
//     }
//   }
//   return super.delete(_);                            // _ is the real target
//
// INVESTIGATED: same conclusion as Relationship (ops-sgjr, #569) — this is NOT
// a bypass, verified against a real Harper instance below. Harper's REST layer
// resolves a Table resource instance to the URL's id via
// getResource()->_loadRecord() (Table.ts) BEFORE calling ANY instance method
// (get/put/delete/patch), binding `this.#record` to the target record. Table's
// instance get(target?) (Table.ts ~line 1172), called with target===undefined,
// falls through every special-cased branch (string-property, search-target,
// collection-describe, the loadAsInstance===false path) since none match on
// undefined, and lands on the final fallback that returns `this.#record` —
// i.e. the already-bound target record, not an empty/collection result.
// (Credential's own get() override at ~line 47 relies on this exact mechanism:
// it too calls `super.get()` with no args and reads `result.principalId` off
// the bound record — independent corroboration the no-arg pattern resolves the
// target here.) Confirmed: the cross-agent DELETE below returns exactly the
// ownership guard's own 403 body, not a generic Harper RBAC denial, proving
// the guard's `existing.principalId` really is the target's owner.
//
// NOTE on setup: flair-agent is intentionally NOT provisioned, so verified
// agents fall back to admin super_user at the Harper RBAC layer (see
// ed25519-auth-hnsw.test.ts). That is the STRONGEST form of this test: with
// Harper's table gate always passing, a broken (no-op) ownership guard would
// let the cross-agent DELETE succeed. The 403 therefore comes purely from the
// resource-level guard under test.
//
// Kept as a permanent regression guard (same rationale as #569 — correctness
// relies on the implicit invariant that Credential does not set
// `getReturnMutable`, which isn't visible from delete()'s own code).
//
// MODEL: test/integration/relationship-delete-authz.test.ts.
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
const owner = mkAgent("credauthz-owner");
const other = mkAgent("credauthz-other");
const adminAgent = mkAgent("credauthz-admin");

async function putCredential(agent: TestAgent, id: string): Promise<Response> {
  const path = `/Credential/${id}`;
  return fetch(`${harper.httpURL}${path}`, {
    method: "PUT",
    headers: { Authorization: ed25519Header(agent, "PUT", path), "Content-Type": "application/json" },
    // principalId defaults to the authenticated agent; kind must be a valid enum.
    body: JSON.stringify({ id, principalId: agent.id, kind: "bearer-token" }),
  });
}

async function deleteCredential(agent: TestAgent, id: string): Promise<Response> {
  const path = `/Credential/${id}`;
  return fetch(`${harper.httpURL}${path}`, {
    method: "DELETE",
    headers: { Authorization: ed25519Header(agent, "DELETE", path) },
  });
}

async function getCredentialAsAdmin(id: string): Promise<any> {
  // Direct DB read via ops API (bypasses the resource's own read gate) so we
  // can assert existence/non-existence independent of Credential.get()'s own
  // behavior (which strips tokenHash and 403s non-owners).
  const res = await adminOp(harper, {
    operation: "search_by_value",
    database: "flair",
    table: "Credential",
    search_attribute: "id",
    search_value: id,
    get_attributes: ["id", "principalId", "kind", "status"],
  });
  const body: any = await res.json();
  return Array.isArray(body) && body.length > 0 ? body[0] : null;
}

describe("Credential.delete() cross-agent authorization (ops-sgjr follow-up)", () => {
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

  test("REPRO: non-admin cross-agent DELETE is rejected with 403 and the record survives", async () => {
    const id = `repro-${randomUUID()}`;
    const putRes = await putCredential(owner, id);
    expect([200, 204], `owner PUT returned ${putRes.status}: ${(await putRes.text()).slice(0, 200)}`).toContain(putRes.status);

    const before = await getCredentialAsAdmin(id);
    expect(before, "seed record should exist before the cross-agent delete attempt").not.toBeNull();
    expect(before.principalId).toBe(owner.id);

    const delRes = await deleteCredential(other, id);
    const delText = await delRes.text();

    const after = await getCredentialAsAdmin(id);

    // The assertion the guard must uphold. If the guard were a no-op, the
    // super_user-fallback table gate would let this delete succeed → status
    // 200/204 and `after` null, failing here.
    expect(delRes.status, `cross-agent DELETE by non-owner returned ${delRes.status}: ${delText.slice(0, 300)}`).toBe(403);
    expect(delText, `403 must be the resource guard's own message, not a generic RBAC denial`).toContain("only admin principals can revoke");
    expect(after, "record must still exist after a blocked cross-agent delete").not.toBeNull();
    expect(after?.principalId).toBe(owner.id);
  }, 30_000);

  test("owner deleting their own credential succeeds", async () => {
    const id = `owner-own-${randomUUID()}`;
    const putRes = await putCredential(owner, id);
    expect([200, 204]).toContain(putRes.status);
    expect(await getCredentialAsAdmin(id)).not.toBeNull();

    const delRes = await deleteCredential(owner, id);
    const delText = await delRes.text();
    expect([200, 204], `owner DELETE returned ${delRes.status}: ${delText.slice(0, 300)}`).toContain(delRes.status);
    expect(await getCredentialAsAdmin(id)).toBeNull();
  }, 30_000);

  test("admin deleting another principal's credential succeeds", async () => {
    const id = `admin-any-${randomUUID()}`;
    const putRes = await putCredential(owner, id);
    expect([200, 204]).toContain(putRes.status);
    expect(await getCredentialAsAdmin(id)).not.toBeNull();

    const delRes = await deleteCredential(adminAgent, id);
    const delText = await delRes.text();
    expect([200, 204], `admin DELETE returned ${delRes.status}: ${delText.slice(0, 300)}`).toContain(delRes.status);
    expect(await getCredentialAsAdmin(id)).toBeNull();
  }, 30_000);

  test("non-admin DELETE of a non-existent id is handled sensibly (not a 500)", async () => {
    const id = `does-not-exist-${randomUUID()}`;
    const delRes = await deleteCredential(other, id);
    expect(delRes.status, `DELETE of missing id returned ${delRes.status}`).toBeLessThan(500);
  }, 30_000);
});
