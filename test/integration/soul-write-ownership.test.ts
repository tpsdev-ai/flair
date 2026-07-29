// soul-write-ownership.test.ts — the Soul half of the write-authorization
// coverage gap.
//
// A soul entry is a principal's identity data. Only its owner (or an admin) may
// write it. That rule was enforced by a middleware guard which had TWO
// independent holes, either of which alone lets one agent rewrite another's:
//
//   1. THE VERB LIST. The guard enumerated PUT and POST. Its three siblings in
//      the same block (OrgEvent, WorkspaceState, Memory) all enumerate PATCH
//      as well; this one did not, and Harper routes PATCH to a resource method
//      that carries no ownership check of its own.
//
//   2. THE THING IT COMPARED. It compared the request BODY's `agentId` against
//      the caller, and only denied when that field was present and mismatched.
//      A body that simply omits `agentId` — which a partial write naturally
//      does — was compared against nothing and passed, whatever record the URL
//      pointed at. The resource-level check behind it uses "validate-truthy"
//      attribution, which by design also passes an ABSENT owner field.
//
// Closing one leaves the other reachable through whichever verbs remain, so
// these pin both: the guard now runs on every mutating verb, and it resolves
// the owner of the TARGET RECORD from the path rather than trusting the body —
// the same shape as the Memory ownership guard, which is the resource in this
// codebase that already had it right.
//
// MODEL: test/integration/admin-field-truth.test.ts.
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

/** Read a soul entry straight out of the table, bypassing every resource gate. */
async function rawSoul(harper: HarperInstance, id: string): Promise<any> {
  const res = await adminOp(harper, {
    operation: "search_by_id", database: "flair", table: "Soul",
    ids: [id], get_attributes: ["id", "agentId", "key", "value"],
  });
  const rows = await res.json();
  return Array.isArray(rows) ? rows[0] : null;
}

async function seedSoul(harper: HarperInstance, agentId: string, key: string, value: string): Promise<string> {
  const id = `${agentId}:${key}`;
  const now = new Date().toISOString();
  const res = await adminOp(harper, {
    operation: "upsert", database: "flair", table: "Soul",
    records: [{ id, agentId, key, value, durability: "permanent", createdAt: now, updatedAt: now }],
  });
  expect(res.status, `soul seed ${id} returned ${res.status}`).toBe(200);
  return id;
}

async function write(
  harper: HarperInstance, agent: TestAgent, method: string, path: string, body?: unknown,
): Promise<Response> {
  return fetch(`${harper.httpURL}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: ed25519Header(agent, method, path),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

let harper: HarperInstance;
const victim = mkAgent("soul-victim");
const attacker = mkAgent("soul-attacker");

describe("Soul writes are owner-scoped on every mutating verb", () => {
  beforeAll(async () => {
    harper = await startHarper();
    const now = new Date().toISOString();
    for (const a of [victim, attacker]) {
      const res = await adminOp(harper, {
        operation: "insert", database: "flair", table: "Agent",
        records: [{ id: a.id, name: a.id, role: "agent", admin: false, publicKey: a.publicKey, createdAt: now }],
      });
      expect(res.status, `agent seed ${a.id} returned ${res.status}`).toBe(200);
    }
  }, 180_000);

  afterAll(async () => { if (harper) await stopHarper(harper); });

  // ── POSITIVE CONTROL ──────────────────────────────────────────────────────
  // Without these, every "denied" assertion below would pass just as happily if
  // the fix had simply broken Soul writes outright.
  describe("positive control — an agent can still write its OWN soul", () => {
    test("PUT to its own soul entry succeeds and persists", async () => {
      const key = `own-put-${randomUUID().slice(0, 6)}`;
      const id = `${victim.id}:${key}`;
      const res = await write(harper, victim, "PUT", `/Soul/${encodeURIComponent(id)}`, {
        id, agentId: victim.id, key, value: "self-authored", durability: "permanent",
        createdAt: new Date().toISOString(),
      });
      expect(res.status, `own PUT returned ${res.status}: ${await res.text()}`).toBeLessThan(300);
      expect((await rawSoul(harper, id))?.value).toBe("self-authored");
    }, 30_000);

    test("PATCH to its own soul entry succeeds and persists", async () => {
      const id = await seedSoul(harper, victim.id, `own-patch-${randomUUID().slice(0, 6)}`, "before");
      const res = await write(harper, victim, "PATCH", `/Soul/${encodeURIComponent(id)}`, { value: "after" });
      expect(res.status, `own PATCH returned ${res.status}: ${await res.text()}`).toBeLessThan(300);
      expect((await rawSoul(harper, id))?.value).toBe("after");
    }, 30_000);

    test("an admin may still write another principal's soul", async () => {
      const id = await seedSoul(harper, victim.id, `admin-write-${randomUUID().slice(0, 6)}`, "before");
      const res = await fetch(`${harper.opsURL}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`),
        },
        body: JSON.stringify({
          operation: "upsert", database: "flair", table: "Soul",
          records: [{ id, agentId: victim.id, key: "admin-write", value: "by-admin", durability: "permanent" }],
        }),
      });
      expect(res.status).toBe(200);
      expect((await rawSoul(harper, id))?.value).toBe("by-admin");
    }, 30_000);
  });

  // ── Hole 1: the verb list ────────────────────────────────────────────────
  describe("cross-agent writes are refused on every mutating verb", () => {
    test("PATCH another agent's soul entry is refused", async () => {
      const id = await seedSoul(harper, victim.id, `x-patch-${randomUUID().slice(0, 6)}`, "original");
      const res = await write(harper, attacker, "PATCH", `/Soul/${encodeURIComponent(id)}`, { value: "TAMPERED" });
      expect(res.status, `cross-agent PATCH returned ${res.status}`).toBe(403);
      expect((await rawSoul(harper, id))?.value, "value was overwritten despite the refusal").toBe("original");
    }, 30_000);

    test("DELETE another agent's soul entry is refused", async () => {
      const id = await seedSoul(harper, victim.id, `x-del-${randomUUID().slice(0, 6)}`, "original");
      const res = await write(harper, attacker, "DELETE", `/Soul/${encodeURIComponent(id)}`);
      expect(res.status, `cross-agent DELETE returned ${res.status}`).toBe(403);
      expect(await rawSoul(harper, id), "record was deleted despite the refusal").toBeTruthy();
    }, 30_000);
  });

  // ── Hole 2: what the guard compared ──────────────────────────────────────
  // The body-only check denied a PRESENT, mismatched agentId. Omitting the
  // field entirely was compared against nothing.
  describe("a body that omits agentId does not bypass the ownership check", () => {
    test("PUT another agent's soul entry WITHOUT agentId in the body is refused", async () => {
      const id = await seedSoul(harper, victim.id, `x-put-noattr-${randomUUID().slice(0, 6)}`, "original");
      const res = await write(harper, attacker, "PUT", `/Soul/${encodeURIComponent(id)}`, {
        id, key: "x", value: "TAMPERED", durability: "permanent", createdAt: new Date().toISOString(),
      });
      expect(res.status, `cross-agent PUT (no agentId) returned ${res.status}`).toBe(403);
      expect((await rawSoul(harper, id))?.value, "value was overwritten despite the refusal").toBe("original");
    }, 30_000);

    test("PATCH another agent's soul entry WITHOUT agentId in the body is refused", async () => {
      const id = await seedSoul(harper, victim.id, `x-patch-noattr-${randomUUID().slice(0, 6)}`, "original");
      const res = await write(harper, attacker, "PATCH", `/Soul/${encodeURIComponent(id)}`, { value: "TAMPERED" });
      expect(res.status, `cross-agent PATCH (no agentId) returned ${res.status}`).toBe(403);
      expect((await rawSoul(harper, id))?.value).toBe("original");
    }, 30_000);

    test("a forged, PRESENT agentId is still refused (the original rule still holds)", async () => {
      const id = await seedSoul(harper, victim.id, `x-forge-${randomUUID().slice(0, 6)}`, "original");
      const res = await write(harper, attacker, "PUT", `/Soul/${encodeURIComponent(id)}`, {
        id, agentId: victim.id, key: "x", value: "TAMPERED", durability: "permanent",
        createdAt: new Date().toISOString(),
      });
      expect(res.status, `cross-agent PUT (forged agentId) returned ${res.status}`).toBe(403);
      expect((await rawSoul(harper, id))?.value).toBe("original");
    }, 30_000);
  });
});
