// record-owner-guard.test.ts — the shared record-ownership rule, against a real
// Harper, on every resource it covers.
//
// Harper maps verbs to resource methods one-to-one, so an ownership rule written
// in a resource's put() is enforced on PUT and nothing else. Nearly every flair
// resource wrote its rules there, and none of them implemented patch() — so
// PATCH reached the table with only `allowVerified()` behind it. Measured before
// the fix, every resource below returned 204 and the victim's row was mutated.
//
// The rule now lives in ONE place (resources/record-owner-guard.ts, applied by
// resources/auth-middleware.ts) and reads ownership from the STORED record named
// by the path — not from the request body, which is the caller's claim and which
// a partial write omits entirely.
//
// Each resource gets BOTH assertions:
//   - a non-owner is refused, and the stored row is unchanged;
//   - the OWNER can still write its own row on the same verb.
// The second is not decoration. Over-blocking is the failure mode a security fix
// reaches for, and without it every "denied" assertion here would pass just as
// happily if the guard had simply broken writes for everyone.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import nacl from "tweetnacl";
import { randomUUID } from "node:crypto";
import { startHarper, stopHarper, HarperInstance } from "../helpers/harper-lifecycle";

interface TestAgent { id: string; publicKey: string; secretKey: Uint8Array; }

function mkAgent(id: string): TestAgent {
  const kp = nacl.sign.keyPair();
  return { id, publicKey: Buffer.from(kp.publicKey).toString("base64"), secretKey: kp.secretKey };
}

function ed25519Header(a: TestAgent, method: string, path: string): string {
  const ts = Date.now().toString();
  const nonce = randomUUID();
  const sig = nacl.sign.detached(new TextEncoder().encode(`${a.id}:${ts}:${nonce}:${method}:${path}`), a.secretKey);
  return `TPS-Ed25519 ${a.id}:${ts}:${nonce}:${Buffer.from(sig).toString("base64")}`;
}

async function adminOp(h: HarperInstance, op: Record<string, any>): Promise<Response> {
  return fetch(h.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Basic " + btoa(`${h.admin.username}:${h.admin.password}`) },
    body: JSON.stringify(op),
  });
}

async function rawRec(h: HarperInstance, table: string, id: string, attrs: string[]): Promise<any> {
  const res = await adminOp(h, { operation: "search_by_id", database: "flair", table, ids: [id], get_attributes: attrs });
  const rows = await res.json();
  return Array.isArray(rows) ? rows[0] : null;
}

async function seed(h: HarperInstance, table: string, rec: Record<string, any>): Promise<void> {
  const r = await adminOp(h, { operation: "upsert", database: "flair", table, records: [rec] });
  expect(r.status, `seed ${table} returned ${r.status}`).toBe(200);
}

async function patchAs(h: HarperInstance, agent: TestAgent, path: string, body: unknown): Promise<Response> {
  return fetch(`${h.httpURL}${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: ed25519Header(agent, "PATCH", path) },
    body: JSON.stringify(body),
  });
}

let harper: HarperInstance;
const owner = mkAgent("rog-owner");
const other = mkAgent("rog-other");
const NOW = new Date().toISOString();

/**
 * Every resource the shared guard covers that is reachable over REST and whose
 * rule is ownership. Each entry seeds a row owned by `owner`, then the same
 * PATCH is attempted by a non-owner (must be refused, row unchanged) and by the
 * owner (must succeed).
 */
const CASES: Array<{
  name: string;
  table: string;
  id: string;
  path: string;
  seed: Record<string, any>;
  patch: Record<string, any>;
  field: string;
  attrs: string[];
}> = [
  {
    name: "Credential", table: "Credential", id: "rog-cred", path: "/Credential/rog-cred",
    seed: { id: "rog-cred", principalId: owner.id, kind: "bearer-token", status: "active", createdAt: NOW },
    patch: { status: "revoked" }, field: "status", attrs: ["id", "principalId", "status"],
  },
  {
    name: "MemoryGrant", table: "MemoryGrant", id: "rog-grant", path: "/MemoryGrant/rog-grant",
    seed: { id: "rog-grant", ownerId: owner.id, granteeId: owner.id, scope: "all", createdAt: NOW },
    patch: { scope: "none" }, field: "scope", attrs: ["id", "ownerId", "scope"],
  },
  {
    name: "Integration", table: "Integration", id: "rog-integ", path: "/Integration/rog-integ",
    seed: { id: "rog-integ", agentId: owner.id, platform: "slack", username: "orig", createdAt: NOW },
    patch: { username: "changed" }, field: "username", attrs: ["id", "agentId", "username"],
  },
  {
    name: "Relationship", table: "Relationship", id: "rog-rel", path: "/Relationship/rog-rel",
    seed: { id: "rog-rel", agentId: owner.id, subject: "s", predicate: "p", object: "orig", createdAt: NOW },
    patch: { object: "changed" }, field: "object", attrs: ["id", "agentId", "object"],
  },
  {
    name: "WorkspaceState", table: "WorkspaceState", id: "rog-ws", path: "/WorkspaceState/rog-ws",
    seed: { id: "rog-ws", agentId: owner.id, ref: "orig", provider: "git", timestamp: NOW, createdAt: NOW },
    patch: { ref: "changed" }, field: "ref", attrs: ["id", "agentId", "ref"],
  },
  {
    name: "OrgEvent", table: "OrgEvent", id: "rog-oe", path: "/OrgEvent/rog-oe",
    seed: { id: "rog-oe", authorId: owner.id, kind: "k", summary: "orig", createdAt: NOW },
    patch: { summary: "changed" }, field: "summary", attrs: ["id", "authorId", "summary"],
  },
  {
    name: "MemoryCandidate", table: "MemoryCandidate", id: "rog-cand", path: "/MemoryCandidate/rog-cand",
    seed: { id: "rog-cand", agentId: owner.id, claim: "c", generatedAt: NOW, status: "pending", createdAt: NOW },
    patch: { status: "promoted" }, field: "status", attrs: ["id", "agentId", "status"],
  },
  {
    name: "Presence", table: "Presence", id: owner.id, path: `/Presence/${owner.id}`,
    seed: { agentId: owner.id, lastHeartbeatAt: Date.now(), activity: "coding" },
    patch: { activity: "planning" }, field: "activity", attrs: ["agentId", "activity"],
  },
  {
    name: "Soul", table: "Soul", id: `${owner.id}:k`, path: `/Soul/${encodeURIComponent(owner.id + ":k")}`,
    seed: { id: `${owner.id}:k`, agentId: owner.id, key: "k", value: "orig", durability: "permanent", createdAt: NOW, updatedAt: NOW },
    patch: { value: "changed" }, field: "value", attrs: ["id", "agentId", "value"],
  },
  {
    name: "Memory", table: "Memory", id: "rog-mem", path: "/Memory/rog-mem",
    seed: { id: "rog-mem", agentId: owner.id, content: "orig", durability: "persistent", createdAt: NOW, updatedAt: NOW },
    patch: { content: "changed" }, field: "content", attrs: ["id", "agentId", "content"],
  },
];

describe("shared record-ownership guard", () => {
  beforeAll(async () => {
    harper = await startHarper();
    for (const a of [owner, other]) {
      await seed(harper, "Agent", { id: a.id, name: a.id, role: "agent", admin: false, publicKey: a.publicKey, createdAt: NOW });
    }
    for (const c of CASES) await seed(harper, c.table, c.seed);
  }, 240_000);

  afterAll(async () => { if (harper) await stopHarper(harper); });

  describe("a non-owner cannot mutate another principal's record", () => {
    for (const c of CASES) {
      test(`${c.name}: cross-agent PATCH is refused and the row is unchanged`, async () => {
        const before = await rawRec(harper, c.table, c.id, c.attrs);
        const res = await patchAs(harper, other, c.path, c.patch);
        expect(res.status, `${c.name} cross-agent PATCH returned ${res.status}, expected 403`).toBe(403);
        const after = await rawRec(harper, c.table, c.id, c.attrs);
        expect(after?.[c.field], `${c.name} row was mutated despite the refusal`).toBe(before?.[c.field]);
      }, 30_000);
    }
  });

  // ── POSITIVE CONTROLS ─────────────────────────────────────────────────────
  describe("the owner can still write its own record", () => {
    for (const c of CASES) {
      test(`${c.name}: the owner's own PATCH succeeds and persists`, async () => {
        const res = await patchAs(harper, owner, c.path, c.patch);
        expect(res.status, `${c.name} owner PATCH returned ${res.status}: ${await res.text()}`).toBeLessThan(300);
        const after = await rawRec(harper, c.table, c.id, c.attrs);
        expect(after?.[c.field], `${c.name} owner's write did not persist`).toBe(c.patch[c.field]);
      }, 30_000);
    }
  });

  describe("administrators are unaffected", () => {
    test("an admin may write another principal's record", async () => {
      const res = await adminOp(harper, {
        operation: "upsert", database: "flair", table: "Integration",
        records: [{ id: "rog-integ", agentId: owner.id, platform: "slack", username: "by-admin" }],
      });
      expect(res.status).toBe(200);
      expect((await rawRec(harper, "Integration", "rog-integ", ["id", "username"]))?.username).toBe("by-admin");
    }, 30_000);
  });

  describe("creation is untouched — the guard only covers records that exist", () => {
    // The guard resolves the record named by the path and permits the write when
    // there is none. This exercises that branch directly: a PUT to an id that
    // does not exist yet is a create, and must not be refused. (Collection POST
    // is not used here — `POST /<Table>` returns 405 for these table resources
    // regardless of auth, which is a separate pre-existing quirk and would make
    // this assertion prove nothing about the guard.)
    test("an agent can create a NEW record at an id that does not exist yet", async () => {
      const key = `rog-new-${randomUUID().slice(0, 8)}`;
      const id = `${owner.id}:${key}`;
      const path = `/Soul/${encodeURIComponent(id)}`;
      const res = await fetch(`${harper.httpURL}${path}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: ed25519Header(owner, "PUT", path) },
        body: JSON.stringify({ id, agentId: owner.id, key, value: "created", durability: "permanent", createdAt: NOW }),
      });
      expect(res.status, `create-by-PUT returned ${res.status}: ${await res.text()}`).toBeLessThan(300);
      expect((await rawRec(harper, "Soul", id, ["id", "agentId", "value"]))?.value).toBe("created");
    }, 30_000);
  });

  // Two flows a blunter rule would have broken, called out explicitly because
  // they are the ones most likely to be quietly lost in a refactor: a heartbeat
  // is a collection POST that repeats forever, and a grant is the one place a
  // record legitimately names an agent OTHER than its owner.
  describe("flows a blunter ownership rule would have broken", () => {
    test("Presence: an agent's own heartbeat still succeeds", async () => {
      const path = "/Presence";
      const res = await fetch(`${harper.httpURL}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: ed25519Header(owner, "POST", path) },
        body: JSON.stringify({ agentId: owner.id, activity: "reviewing", currentTask: "heartbeat" }),
      });
      expect(res.status, `heartbeat returned ${res.status}: ${await res.text()}`).toBeLessThan(400);
    }, 30_000);

    test("MemoryGrant: an owner can still create a grant naming ANOTHER agent as grantee", async () => {
      const id = `rog-grant-new-${randomUUID().slice(0, 8)}`;
      const path = `/MemoryGrant/${id}`;
      const res = await fetch(`${harper.httpURL}${path}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: ed25519Header(owner, "PUT", path) },
        // granteeId is deliberately someone else — that is what a grant IS.
        body: JSON.stringify({ id, ownerId: owner.id, granteeId: other.id, scope: "all", createdAt: NOW }),
      });
      expect(res.status, `cross-agent grant returned ${res.status}: ${await res.text()}`).toBeLessThan(300);
      const rec = await rawRec(harper, "MemoryGrant", id, ["id", "ownerId", "granteeId"]);
      expect(rec?.granteeId, "the grant did not persist its grantee").toBe(other.id);
    }, 30_000);
  });

  describe("a ledger whose rule is stricter than ownership", () => {
    // MemoryUsage is append-only: even the OWNER may not rewrite a row. The
    // shared guard permits an owner's write, so this resource has to enforce
    // its own stricter rule on PATCH as well as PUT.
    test("MemoryUsage: the owner's own PATCH is refused (immutable ledger)", async () => {
      const id = `${owner.id}:rog-m1`;
      await seed(harper, "MemoryUsage", { id, agentId: owner.id, memoryId: "rog-m1", attribution: "orig", createdAt: NOW });
      const res = await patchAs(harper, owner, `/MemoryUsage/${encodeURIComponent(id)}`, { attribution: "changed" });
      expect(res.status, `MemoryUsage owner PATCH returned ${res.status}, expected 403`).toBe(403);
      expect((await rawRec(harper, "MemoryUsage", id, ["id", "attribution"]))?.attribution).toBe("orig");
    }, 30_000);

    test("MemoryUsage: a cross-agent PATCH is refused too", async () => {
      const id = `${owner.id}:rog-m2`;
      await seed(harper, "MemoryUsage", { id, agentId: owner.id, memoryId: "rog-m2", attribution: "orig", createdAt: NOW });
      const res = await patchAs(harper, other, `/MemoryUsage/${encodeURIComponent(id)}`, { attribution: "changed" });
      expect(res.status, `MemoryUsage cross-agent PATCH returned ${res.status}, expected 403`).toBe(403);
      expect((await rawRec(harper, "MemoryUsage", id, ["id", "attribution"]))?.attribution).toBe("orig");
    }, 30_000);
  });
});
