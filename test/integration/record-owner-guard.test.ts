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
import { OWNER_FIELDS } from "../../resources/record-owner-guard.js";

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

/** Any verb, signed as `agent`. Used for the owner-field, alias and COPY/MOVE cases. */
async function reqAs(h: HarperInstance, agent: TestAgent, method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${h.httpURL}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: ed25519Header(agent, method, path) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

// The tables whose write rule is plain owner-field immutability and are reachable
// over REST — everything in CASES except Presence, whose owner column is its
// primary key (the URL binds the row to its owner, so the field cannot be
// re-pointed by a body value). Matches the unit gate's IMMUTABILITY_EXEMPT.
const OWNER_FLIP_EXEMPT = new Set(["Presence"]);

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

  // ── OWNER-FIELD IMMUTABILITY ────────────────────────────────────────────────
  //
  // Owning a row is permission to write its ordinary fields, not to rewrite the
  // field that decides who owns it. A write that re-points the owner field at
  // another principal must be refused and the stored owner left byte-unchanged —
  // for every guarded, REST-reachable table, on the verb Harper routes past
  // put(). The owner field per table is read from the SAME production map the
  // guards use, so a table added to the guard is attacked here automatically.
  describe("the owner field of a record is immutable to a non-admin", () => {
    for (const c of CASES) {
      if (OWNER_FLIP_EXEMPT.has(c.table)) continue;
      test(`${c.name}: an owner cannot re-point the ${OWNER_FIELDS[c.table]} field to another principal`, async () => {
        const ownerField = OWNER_FIELDS[c.table];
        const before = await rawRec(harper, c.table, c.id, [ownerField]);
        expect(before?.[ownerField], `${c.name} fixture must be owned by the owner`).toBe(owner.id);
        const res = await patchAs(harper, owner, c.path, { [ownerField]: other.id });
        expect(res.status, `${c.name} owner-field change returned ${res.status}, expected 403`).toBe(403);
        const after = await rawRec(harper, c.table, c.id, [ownerField]);
        expect(after?.[ownerField], `${c.name} owner field was reassigned despite the refusal`).toBe(owner.id);
      }, 30_000);
    }

    // Positive control: the refusal is specific to the owner field. An owner's
    // ordinary self-update — a field that is NOT the owner field — still works.
    // Without this, the block above would pass just as happily if the guard had
    // broken owner writes wholesale (the over-restriction failure mode).
    test("an owner's ordinary (non-owner-field) self-update still succeeds", async () => {
      const c = CASES.find((x) => x.name === "Relationship")!;
      const res = await patchAs(harper, owner, c.path, { [c.field]: "still-writable" });
      expect(res.status, `owner self-update returned ${res.status}: ${await res.text()}`).toBeLessThan(300);
      expect((await rawRec(harper, c.table, c.id, [c.field]))?.[c.field]).toBe("still-writable");
    }, 30_000);
  });

  // ── Presence owner-field tripwire (primaryKey semantics) ────────────────────
  //
  // Presence is exempt from the owner-field matrix because its owner column
  // (agentId) IS its primary key: the URL binds a row to its owner, so a body
  // agentId cannot re-point it. That exemption is only safe while that remains
  // true. This tripwire asserts it directly on a real Harper — an owner writing
  // a DIFFERENT agentId in the body leaves the stored row's owner unchanged, on
  // both PATCH and PUT. If a future Harper change made the primary key
  // re-pointable by a body value, this fires and Presence must join the matrix.
  describe("Presence: the primary-key owner field cannot be re-pointed by a body value", () => {
    for (const verb of ["PATCH", "PUT"] as const) {
      test(`${verb} /Presence/<own-id> with a foreign agentId in the body leaves the owner unchanged`, async () => {
        const path = `/Presence/${owner.id}`;
        const body: any = verb === "PUT"
          ? { agentId: other.id, lastHeartbeatAt: Date.now(), activity: "tripwire" }
          : { agentId: other.id, activity: "tripwire" };
        await reqAs(harper, owner, verb, path, body);
        const after = await rawRec(harper, "Presence", owner.id, ["agentId", "activity"]);
        expect(after?.agentId, `${verb} re-pointed Presence.agentId — primaryKey semantics changed; add Presence to the owner-field matrix`).toBe(owner.id);
        // And no foreign-owned row was conjured at the other agent's id.
        const conjured = await rawRec(harper, "Presence", other.id, ["agentId"]);
        expect(conjured == null || conjured.agentId === other.id, `${verb} created an owner-mismatched Presence row`).toBe(true);
      }, 30_000);
    }
  });

  // ── COPY / MOVE are not a side door ─────────────────────────────────────────
  //
  // The ownership guard's mutating-verb set is POST/PUT/PATCH/DELETE. COPY and
  // MOVE sit outside it, which is safe only because Harper implements neither on
  // these table resources and returns 405. If a future Harper adds them, this
  // fires and the verb set has to grow with it.
  describe("COPY and MOVE are unimplemented on guarded resources", () => {
    for (const verb of ["COPY", "MOVE"]) {
      test(`${verb} on a guarded row is refused (405) and copies nothing`, async () => {
        const c = CASES.find((x) => x.name === "Memory")!;
        const stolenId = `rog-${verb.toLowerCase()}-stolen`;
        const res = await reqAs(harper, other, verb, c.path, { destination: `/Memory/${stolenId}` });
        expect(res.status, `${verb} returned ${res.status}, expected 405`).toBe(405);
        expect(await rawRec(harper, "Memory", stolenId, ["id"]), `${verb} created a row`).toBeFalsy();
      }, 30_000);
    }
  });

  // ── The lowercase single-record alias is not a bypass ───────────────────────
  //
  // The guard matches the table segment exactly, so `/memory/<id>` (lowercase)
  // is not one of its routes. That is only safe if the lowercase single-record
  // route does not resolve to the table at all — assert it, so a future routing
  // change that makes it resolve trips this instead of opening a quiet hole.
  test("a non-owner PATCH to the lowercase /memory/<id> route does not resolve and mutates nothing", async () => {
    const c = CASES.find((x) => x.name === "Memory")!;
    const before = await rawRec(harper, "Memory", c.id, ["content"]);
    const res = await reqAs(harper, other, "PATCH", `/memory/${c.id}`, { content: "via-lowercase" });
    expect(res.status, `lowercase /memory PATCH returned ${res.status}, expected 404 (no such route)`).toBe(404);
    const after = await rawRec(harper, "Memory", c.id, ["content"]);
    expect(after?.content, "the lowercase route reached the Memory row").toBe(before?.content);
  }, 30_000);

  // ── Coverage self-check ─────────────────────────────────────────────────────
  //
  // The owner-field-immutability matrix is driven off CASES. This asserts CASES
  // covers every guarded table that is reachable over REST (minus the flip-exempt
  // set and the two whose rule is not plain ownership), so a table added to
  // OWNER_FIELDS cannot slip in without an attack above. Mirrors the unit gate.
  test("the owner-field matrix covers every REST-reachable guarded table", async () => {
    const { existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    const RES = join(import.meta.dir, "..", "..", "resources");
    const EXEMPT = new Set([
      ...OWNER_FLIP_EXEMPT,
      "MemoryUsage", // append-only ledger — covered by its own stricter tests
      "Message",     // no non-admin direct writes — covered by unit tests
    ]);
    const required = Object.keys(OWNER_FIELDS)
      .filter((t) => existsSync(join(RES, `${t}.ts`))) // has a resource class → REST-reachable
      .filter((t) => !EXEMPT.has(t));
    const covered = new Set(CASES.filter((c) => !OWNER_FLIP_EXEMPT.has(c.table)).map((c) => c.table));
    const missing = required.filter((t) => !covered.has(t));
    expect(missing, `guarded, REST-reachable tables missing an owner-field-immutability case: ${missing.join(", ")}`).toEqual([]);
  });
});
