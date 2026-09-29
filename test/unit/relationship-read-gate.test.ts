/**
 * relationship-read-gate.test.ts — regression guard for the memory-soul-
 * read-gate FAMILY fix: Relationship.ts previously gated
 * post()/put()/delete() (via search()'s own 401 and put()/delete()'s
 * tpsAgent checks) but never defined `allowRead()` nor overrode `get()`.
 * Harper routes `GET /Relationship/<id>` to get() and the collection-
 * describe `GET /Relationship` outside search(), so both were ungated — an
 * anonymous caller got a 200 with full record content.
 *
 * Same mocking technique as memory-integrity.test.ts / coordination-write-
 * auth.test.ts: mock harper so the resource class loads outside
 * a real Harper runtime, then exercise allowRead()/get() directly. No other
 * test/unit/ file imports resources/Relationship.ts, so this file owns that
 * mock+import with no collision risk (see memory-soul-read-gate.test.ts's
 * doc comment for why that matters — bun runs test/unit/ in one process and
 * dynamic imports are cached by resolved path).
 */
import { describe, it, expect, beforeEach, mock, spyOn } from "bun:test";

process.env.FLAIR_RATE_LIMIT_ENABLED = "false";

let relationshipStore: Map<string, any>;
// federation-edge-hardening slice 1: resources/instance-identity.ts's
// localInstanceId() reads this via databases.flair.Instance.search().
let instanceRow: any = null;

function matchesCondition(record: any, cond: any): boolean {
  if (cond.operator && Array.isArray(cond.conditions)) {
    const results = cond.conditions.map((c: any) => matchesCondition(record, c));
    return cond.operator === "or" ? results.some(Boolean) : results.every(Boolean);
  }
  const fieldVal = record[cond.attribute];
  if (cond.comparator === "equals") return fieldVal === cond.value;
  if (cond.comparator === "not_equal") return fieldVal !== cond.value;
  return true;
}

class BaseRelationship {
  async get(target?: any) {
    const id = typeof target === "string" ? target : (target?.id ?? (this as any)._targetId);
    return relationshipStore.get(id) ?? null;
  }
  // Real Harper PATCH merges the body into the stored row; the id comes from the
  // URL, which the double models as an explicit `_targetId` on the instance.
  async patch(content: any) {
    const id = content?.id ?? (this as any)._targetId;
    const merged = { ...(relationshipStore.get(id) ?? {}), ...content };
    relationshipStore.set(id, merged);
    return { ...merged };
  }
  // Real Harper's table is statically callable
  // (`databases.flair.Relationship.get(id)`), which is how
  // resources/originator-instance.ts's resolveStoredRow reads the pre-existing
  // row for the create/update decision.
  static async get(id: any) {
    return relationshipStore.get(id) ?? null;
  }
  getId() { return (this as any)._targetId; }
  async put(content: any) {
    const id = this.getId() ?? content.id;
    const rec = { ...content, id };
    relationshipStore.set(id, rec);
    return rec;
  }
  // By-id PATCH merge (Harper binds the resource instance to the URL id;
  // Relationship.patch() delegates via `super.patch(content, query)`).
  async delete(id: any) {
    relationshipStore.delete(id);
    return { ok: true };
  }
  search(query?: any) {
    const conditions = Array.isArray(query) ? query : Array.isArray(query?.conditions) ? query.conditions : [];
    let records = Array.from(relationshipStore.values());
    for (const cond of conditions) records = records.filter((r) => matchesCondition(r, cond));
    async function* gen() {
      for (const r of records) yield r;
    }
    return gen();
  }
}

const databasesMock = {
  flair: {
    Relationship: BaseRelationship,
    Agent: { get: async () => null, search: async () => [] },
    Instance: {
      search: () => {
        async function* gen() {
          if (instanceRow) yield instanceRow;
        }
        return gen();
      },
    },
  },
};

mock.module("harper", () => ({ server: { http: () => {}, getUser: async () => null }, databases: databasesMock, Resource: class {} }));

const { Relationship } = await import("../../resources/Relationship.ts");
const { _resetLocalInstanceIdCacheForTests } = await import("../../resources/instance-identity.ts");

function makeRelationship(ctxRequest: any) {
  const r: any = new (Relationship as any)();
  r.getContext = () => ({ request: ctxRequest });
  return r;
}
const agentCtx = (agentId: string, isAdmin = false) => ({ tpsAgent: agentId, tpsAgentIsAdmin: isAdmin });
const anonCtx = () => ({ tpsAnonymous: true });

beforeEach(() => {
  relationshipStore = new Map();
  instanceRow = null;
  _resetLocalInstanceIdCacheForTests();
});

describe("Relationship.allowRead — closes the anonymous GET /Relationship/<id> and describe leak", () => {
  it("anonymous is denied", async () => {
    const r = makeRelationship(anonCtx());
    expect(await (r as any).allowRead()).toBe(false);
  });

  it("a verified non-admin agent is allowed (per-record scoping is in get())", async () => {
    const r = makeRelationship(agentCtx("agent-1"));
    expect(await (r as any).allowRead()).toBe(true);
  });

  it("an admin agent is allowed", async () => {
    const r = makeRelationship(agentCtx("agent-admin", true));
    expect(await (r as any).allowRead()).toBe(true);
  });

  it("an internal call (no request context) is allowed", async () => {
    const r: any = new (Relationship as any)();
    r.getContext = () => undefined;
    expect(await r.allowRead()).toBe(true);
  });
});

describe("Relationship.get() — anonymous denied, owner-scoped for non-admin, unfiltered for internal/admin", () => {
  it("anonymous get(<id>) → 404, never leaks record content", async () => {
    relationshipStore.set("rel-1", { id: "rel-1", agentId: "agent-owner", subject: "nathan", predicate: "manages", object: "flint" });
    const r = makeRelationship(anonCtx());
    const res = await (r as any).get("rel-1");
    expect(res instanceof Response).toBe(true);
    expect((res as Response).status).toBe(404);
    const body = await (res as Response).json();
    expect(JSON.stringify(body)).not.toContain("nathan");
  });

  it("verified non-admin get() of ANOTHER agent's id → 404 (not 403 — no existence confirmation)", async () => {
    relationshipStore.set("rel-1", { id: "rel-1", agentId: "agent-owner", subject: "a", predicate: "b", object: "c" });
    const r = makeRelationship(agentCtx("agent-attacker"));
    const res = await (r as any).get("rel-1");
    expect(res instanceof Response).toBe(true);
    expect((res as Response).status).toBe(404);
  });

  it("verified non-admin get() of ITS OWN id → returns the real record", async () => {
    relationshipStore.set("rel-1", { id: "rel-1", agentId: "agent-owner", subject: "a", predicate: "b", object: "c" });
    const r = makeRelationship(agentCtx("agent-owner"));
    const res = await (r as any).get("rel-1");
    expect(res instanceof Response).toBe(false);
    expect((res as any).subject).toBe("a");
  });

  it("a non-existent id for a non-admin agent → 404 (same as denied — no oracle for existence)", async () => {
    const r = makeRelationship(agentCtx("agent-owner"));
    const res = await (r as any).get("does-not-exist");
    expect(res instanceof Response).toBe(true);
    expect((res as Response).status).toBe(404);
  });

  it("internal call (no request context) → returns any id unchanged", async () => {
    relationshipStore.set("rel-1", { id: "rel-1", agentId: "agent-owner", subject: "secret-subject", predicate: "b", object: "c" });
    const r: any = new (Relationship as any)();
    r.getContext = () => undefined;
    const res = await r.get("rel-1");
    expect(res instanceof Response).toBe(false);
    expect((res as any).subject).toBe("secret-subject");
  });

  it("admin agent → returns any id unchanged, no ownership check", async () => {
    relationshipStore.set("rel-1", { id: "rel-1", agentId: "agent-owner", subject: "secret-subject", predicate: "b", object: "c" });
    const r = makeRelationship(agentCtx("agent-admin", true));
    const res = await (r as any).get("rel-1");
    expect(res instanceof Response).toBe(false);
    expect((res as any).subject).toBe("secret-subject");
  });

  it("a collection/query target (isCollection: true) delegates to search(), scoped by agentId", async () => {
    relationshipStore.set("rel-own", { id: "rel-own", agentId: "agent-1", subject: "a", predicate: "b", object: "c" });
    relationshipStore.set("rel-other", { id: "rel-other", agentId: "agent-other", subject: "x", predicate: "y", object: "z" });
    const r = makeRelationship(agentCtx("agent-1"));
    const res: any = await (r as any).get({ isCollection: true, conditions: [] });
    const results: any[] = [];
    for await (const rec of res) results.push(rec);
    expect(results.map((rec) => rec.id)).toEqual(["rel-own"]);
  });
});

// ─── federation-edge-hardening slice 1 / flair#1965: originatorInstanceId stamp ──
// See resources/originator-instance.ts for the full contract. Relationship has no
// post(), so put() carries both create and update: a body value on create is
// replaced by the local id; on update the stored value stands.
describe("federation-edge-hardening slice 1 / flair#1965 — Relationship originatorInstanceId is server-stamped", () => {
  it("CREATE (put, no stored row) stamps the local instance id", async () => {
    instanceRow = { id: "flair_local_test" };
    const r = makeRelationship(agentCtx("agent-1"));
    const res: any = await r.put({ id: "rel-fresh", subject: "nathan", predicate: "manages", object: "flint" });
    expect(res.originatorInstanceId).toBe("flair_local_test");
  });

  it("CREATE (put) IGNORES a request-body originatorInstanceId and stamps the local id", async () => {
    instanceRow = { id: "flair_local_test" };
    const r = makeRelationship(agentCtx("agent-1"));
    const res: any = await r.put({
      id: "rel-synced",
      subject: "nathan",
      predicate: "manages",
      object: "flint",
      originatorInstanceId: "instance-B",
    });
    expect(res.originatorInstanceId).toBe("flair_local_test");
    expect(res.originatorInstanceId).not.toBe("instance-B");
  });

  it("stamps null when this instance has no Instance row yet — never invents one", async () => {
    instanceRow = null;
    const r = makeRelationship(agentCtx("agent-1"));
    const res: any = await r.put({ id: "rel-no-instance", subject: "nathan", predicate: "manages", object: "flint" });
    expect(res.originatorInstanceId).toBeNull();
  });

  it("UPDATE (put) with a body value LEAVES the stored value — a client cannot change it", async () => {
    instanceRow = { id: "flair_local_test" };
    relationshipStore.set("rel-upd", {
      id: "rel-upd", agentId: "agent-1", subject: "nathan", predicate: "manages", object: "flint",
      originatorInstanceId: "instance-B",
    });
    const r = makeRelationship(agentCtx("agent-1"));
    const res: any = await r.put({
      id: "rel-upd", subject: "nathan", predicate: "manages", object: "flint",
      originatorInstanceId: "instance-attacker",
    });
    expect(res.originatorInstanceId).toBe("instance-B");
    expect(res.originatorInstanceId).not.toBe("instance-attacker");
  });

  it("UPDATE (put) that OMITS the field leaves the stored value", async () => {
    instanceRow = { id: "flair_local_test" };
    relationshipStore.set("rel-upd2", {
      id: "rel-upd2", agentId: "agent-1", subject: "nathan", predicate: "manages", object: "flint",
      originatorInstanceId: "instance-B",
    });
    const r = makeRelationship(agentCtx("agent-1"));
    const res: any = await r.put({ id: "rel-upd2", subject: "nathan", predicate: "manages", object: "flint" });
    expect(res.originatorInstanceId).toBe("instance-B");
  });

  it("PATCH cannot set or clear originatorInstanceId — the stored value stands", async () => {
    instanceRow = { id: "flair_local_test" };
    relationshipStore.set("rel-patch", {
      id: "rel-patch", agentId: "agent-1", subject: "nathan", predicate: "manages", object: "flint",
      originatorInstanceId: "instance-B",
    });
    const r: any = makeRelationship(agentCtx("agent-1"));
    r._targetId = "rel-patch";
    await r.patch({ originatorInstanceId: "instance-attacker" });
    expect(relationshipStore.get("rel-patch").originatorInstanceId).toBe("instance-B");
  });
});

// ─── relationship-write-path: auth reconcile (put/delete → resolveAgentAuth) ──
//
// Both K&S caught that Relationship.put() AND delete() used the OLDER
// `request.tpsAgent`-direct pattern (no internal/admin verdict handling,
// anonymous and true-internal calls indistinguishable). This is the SAME
// mock+import file that owns Relationship.ts's dynamic import (see the header
// doc comment above) — these tests exercise the REAL class's put()/delete()
// against resolveAgentAuth's three-way verdict, mirroring the style already
// used for allowRead()/get() above.
describe("relationship-write-path — Relationship.put() auth reconcile (resolveAgentAuth)", () => {
  it("anonymous is denied with 401, nothing written", async () => {
    const r = makeRelationship(anonCtx());
    const res: any = await r.put({ id: "rel-anon", subject: "a", predicate: "b", object: "c" });
    expect(res instanceof Response).toBe(true);
    expect(res.status).toBe(401);
    expect(relationshipStore.has("rel-anon")).toBe(false);
  });

  it("a verified non-admin agent's write is stamped with agentId from the verdict, even when the body omits it", async () => {
    const r = makeRelationship(agentCtx("agent-1"));
    const res: any = await r.put({ id: "rel-1", subject: "nathan", predicate: "manages", object: "flint" });
    expect(res instanceof Response).toBe(false);
    expect(res.agentId).toBe("agent-1");
  });

  it("a non-admin agent CANNOT write a relationship claiming another agent's id in the body — 403, not silently rewritten", async () => {
    const r = makeRelationship(agentCtx("agent-attacker"));
    const res: any = await r.put({ id: "rel-2", agentId: "agent-victim", subject: "a", predicate: "b", object: "c" });
    expect(res instanceof Response).toBe(true);
    expect(res.status).toBe(403);
    expect(relationshipStore.has("rel-2")).toBe(false);
  });

  it("a non-admin agent's body agentId is ALWAYS overwritten from the verdict, even when it already matches (never trust the body)", async () => {
    const r = makeRelationship(agentCtx("agent-1"));
    const res: any = await r.put({ id: "rel-3", agentId: "agent-1", subject: "a", predicate: "b", object: "c" });
    expect(res instanceof Response).toBe(false);
    expect(res.agentId).toBe("agent-1");
  });

  it("an admin agent may write on behalf of another agentId — unfiltered, matches the get()/search()/delete() admin-bypass idiom", async () => {
    const r = makeRelationship(agentCtx("agent-admin", true));
    const res: any = await r.put({ id: "rel-4", agentId: "agent-other", subject: "a", predicate: "b", object: "c" });
    expect(res instanceof Response).toBe(false);
    expect(res.agentId).toBe("agent-other");
  });

  it("an internal call (no request context) passes agentId through unchanged — trusted, forward-looking parity with Memory.post()/put()", async () => {
    const r: any = new (Relationship as any)();
    r.getContext = () => undefined;
    const res: any = await r.put({ id: "rel-5", agentId: "agent-internal-caller", subject: "a", predicate: "b", object: "c" });
    expect(res instanceof Response).toBe(false);
    expect(res.agentId).toBe("agent-internal-caller");
  });

  it("an admin/internal write missing agentId entirely is rejected 400 (schema requires it) rather than writing a null-owner row", async () => {
    const r = makeRelationship(agentCtx("agent-admin", true));
    const res: any = await r.put({ id: "rel-6", subject: "a", predicate: "b", object: "c" });
    expect(res instanceof Response).toBe(true);
    expect(res.status).toBe(400);
  });
});

describe("relationship-write-path — Relationship.delete() auth reconcile (resolveAgentAuth)", () => {
  it("anonymous is denied with 401", async () => {
    relationshipStore.set("rel-del-1", { id: "rel-del-1", agentId: "owner", subject: "a", predicate: "b", object: "c" });
    const r = makeRelationship(anonCtx());
    const res: any = await r.delete("rel-del-1");
    expect(res instanceof Response).toBe(true);
    expect(res.status).toBe(401);
    expect(relationshipStore.has("rel-del-1")).toBe(true);
  });

  it("an internal call (no request context) is trusted and can delete", async () => {
    relationshipStore.set("rel-del-2", { id: "rel-del-2", agentId: "owner", subject: "a", predicate: "b", object: "c" });
    const r: any = new (Relationship as any)();
    r.getContext = () => undefined;
    await r.delete("rel-del-2");
    expect(relationshipStore.has("rel-del-2")).toBe(false);
  });

  it("an admin agent is trusted and can delete", async () => {
    relationshipStore.set("rel-del-3", { id: "rel-del-3", agentId: "owner", subject: "a", predicate: "b", object: "c" });
    const r = makeRelationship(agentCtx("agent-admin", true));
    await r.delete("rel-del-3");
    expect(relationshipStore.has("rel-del-3")).toBe(false);
  });

  // Cross-agent ownership denial (non-admin) is a Harper Table-resource
  // binding invariant this in-memory mock cannot faithfully reproduce (the
  // real `super.get()` with no target resolves to the URL-bound record — see
  // test/integration/relationship-delete-authz.test.ts's header doc, which
  // is the permanent regression guard for that exact behavior against a
  // REAL Harper instance). This test only confirms the auth-verdict dispatch
  // reaches the ownership-check branch without throwing for a non-admin.
  it("a non-admin agent's delete of its own relationship id does not throw", async () => {
    relationshipStore.set("rel-del-4", { id: "rel-del-4", agentId: "agent-1", subject: "a", predicate: "b", object: "c" });
    const r = makeRelationship(agentCtx("agent-1"));
    await expect(r.delete("rel-del-4")).resolves.toBeDefined();
  });
});

// ─── relationship-write-path: provenance stamp (reuses Memory's buildProvenance) ──
describe("relationship-write-path — Relationship.put() write-time provenance stamp", () => {
  it("stamps verified.agentId from the resolved auth verdict for a verified agent", async () => {
    const r = makeRelationship(agentCtx("agent-1"));
    const res: any = await r.put({ id: "rel-prov-1", subject: "nathan", predicate: "manages", object: "flint" });
    expect(typeof res.provenance).toBe("string");
    const prov = JSON.parse(res.provenance);
    expect(prov.v).toBe(1);
    expect(prov.verified.agentId).toBe("agent-1");
    expect(typeof prov.verified.timestamp).toBe("string");
  });

  it("stamps verified.agentId=null for an internal (in-process, no per-agent identity) call", async () => {
    const r: any = new (Relationship as any)();
    r.getContext = () => undefined;
    const res: any = await r.put({ id: "rel-prov-2", agentId: "some-agent", subject: "nathan", predicate: "manages", object: "flint" });
    const prov = JSON.parse(res.provenance);
    expect(prov.verified.agentId).toBeNull();
  });

  it("uses the SAME shape as Memory's provenance — {v, verified:{agentId,timestamp,receivedAt}, claimed?} — no Relationship-specific format", async () => {
    const r = makeRelationship(agentCtx("agent-1"));
    const res: any = await r.put({ id: "rel-prov-3", subject: "nathan", predicate: "manages", object: "flint" });
    const prov = JSON.parse(res.provenance);
    // flair#1960: every write carries claimed.createdAt, so `claimed` is present
    // — still the identical shape Memory writes, no Relationship-specific format.
    expect(Object.keys(prov).sort()).toEqual(["claimed", "v", "verified"]);
    expect(Object.keys(prov.verified).sort()).toEqual(["agentId", "receivedAt", "timestamp"]);
  });

  it("flair#1960: a caller-supplied past createdAt is recorded as claimed.createdAt while verified.timestamp is the server clock", async () => {
    const before = Date.now();
    const past = "2001-01-01T00:00:00.000Z";
    const r = makeRelationship(agentCtx("agent-1"));
    const res: any = await r.put({ id: "rel-prov-backdated", subject: "nathan", predicate: "manages", object: "flint", createdAt: past });
    const prov = JSON.parse(res.provenance);
    expect(res.createdAt).toBe(past);
    expect(prov.claimed.createdAt).toBe(past);
    expect(prov.verified.timestamp).not.toBe(past);
    const stamped = Date.parse(prov.verified.timestamp);
    expect(stamped).toBeGreaterThanOrEqual(before - 5000);
    expect(stamped).toBeLessThanOrEqual(Date.now() + 5000);
  });

  // ─── migration-equivalence (same discipline as flair#684's usageCount) ──────
  it("a pre-provenance relationship row (no provenance field at all) still reads back fine via get() — additive/nullable, not required", async () => {
    relationshipStore.set("legacy-no-prov", {
      id: "legacy-no-prov", agentId: "agent-owner", subject: "nathan", predicate: "manages", object: "flint",
    });
    const r = makeRelationship(agentCtx("agent-owner"));
    const res: any = await r.get("legacy-no-prov");
    expect(res instanceof Response).toBe(false);
    expect(res.subject).toBe("nathan");
    expect(res.provenance).toBeUndefined();
  });

  it("updating a legacy (no-provenance) relationship via put() adds provenance additively without disturbing other fields", async () => {
    relationshipStore.set("legacy-update", {
      id: "legacy-update", agentId: "agent-owner", subject: "nathan", predicate: "manages", object: "flint", confidence: 1.0,
    });
    const existing = relationshipStore.get("legacy-update");
    expect(existing.provenance).toBeUndefined();

    const r = makeRelationship(agentCtx("agent-owner"));
    const res: any = await r.put({ ...existing, confidence: 0.5 });
    expect(typeof res.provenance).toBe("string");
    expect(res.subject).toBe("nathan");
    expect(res.confidence).toBe(0.5);
  });

  it("search() over a mix of legacy (no provenance) and new (stamped) relationships returns both, unaffected by the new field", async () => {
    relationshipStore.set("legacy-no-prov-2", { id: "legacy-no-prov-2", agentId: "agent-1", subject: "a", predicate: "b", object: "c" });
    const r = makeRelationship(agentCtx("agent-1"));
    await r.put({ id: "new-with-prov", subject: "d", predicate: "e", object: "f" });

    const results: any[] = [];
    for await (const rec of await r.search()) results.push(rec);
    const ids = results.map((rec) => rec.id).sort();
    expect(ids).toEqual(["legacy-no-prov-2", "new-with-prov"].sort());
  });
});

// ─── flair#1960 r2 — Relationship.patch() forge-proof provenance ───────────
describe("flair#1960 r2 — Relationship.patch() derives provenance from the server, never the body", () => {
  it("a semantic PATCH on a backdated-legacy row re-stamps verified.* and a FORGED verified.agentId/timestamp never lands", async () => {
    const before = Date.now();
    relationshipStore.set("rel-prov-patch", {
      id: "rel-prov-patch", agentId: "agent-1", subject: "nathan", predicate: "manages", object: "flint",
      createdAt: "2001-01-01T00:00:00.000Z",
      provenance: JSON.stringify({ v: 1, verified: { agentId: "agent-1", timestamp: "2001-01-01T00:00:00.000Z" } }),
    });
    const r: any = makeRelationship(agentCtx("agent-1"));
    r._targetId = "rel-prov-patch";
    await r.patch({
      subject: "nathan-renamed", // semantic change
      provenance: JSON.stringify({ v: 1, verified: { agentId: "attacker", timestamp: "1999-01-01T00:00:00.000Z" } }),
    });
    const stored = relationshipStore.get("rel-prov-patch");
    expect(stored.subject).toBe("nathan-renamed"); // control: the patch landed
    const prov = JSON.parse(stored.provenance);
    expect(prov.verified.agentId).toBe("agent-1"); // forged agentId did not land
    expect(prov.verified.timestamp).not.toBe("1999-01-01T00:00:00.000Z"); // forged timestamp did not land
    expect(prov.verified.timestamp).not.toBe("2001-01-01T00:00:00.000Z"); // legacy stored value not carried forward
    const stamped = Date.parse(prov.verified.timestamp);
    expect(stamped).toBeGreaterThanOrEqual(before - 5000);
    expect(stamped).toBeLessThanOrEqual(Date.now() + 5000);
    expect(prov.verified.timestamp).toBe(prov.verified.receivedAt);
  });

  it("a metadata-only PATCH strips a forged provenance but keeps the stored blob", async () => {
    const legacy = JSON.stringify({ v: 1, verified: { agentId: "agent-1", timestamp: "2001-01-01T00:00:00.000Z" } });
    relationshipStore.set("rel-prov-patch-meta", {
      id: "rel-prov-patch-meta", agentId: "agent-1", subject: "a", predicate: "b", object: "c", confidence: 1.0, provenance: legacy,
    });
    const r: any = makeRelationship(agentCtx("agent-1"));
    r._targetId = "rel-prov-patch-meta";
    await r.patch({ confidence: 0.4, provenance: JSON.stringify({ v: 1, verified: { agentId: "attacker", timestamp: "1999-01-01T00:00:00.000Z" } }) });
    const stored = relationshipStore.get("rel-prov-patch-meta");
    expect(stored.confidence).toBe(0.4); // control: the patch landed
    expect(stored.provenance).toBe(legacy); // no semantic change ⇒ stored blob preserved, forged value never landed
  });
});

// ─── flair#1960 r3 — Relationship.patch() fail-closed read + claimedClient strip ──
describe("flair#1960 r3 — Relationship.patch() controls", () => {
  it("a stored-row read ERROR refuses the PATCH (500) and never delegates to the by-id store write (super.patch)", async () => {
    const legacy = JSON.stringify({ v: 1, verified: { agentId: "agent-1", timestamp: "2001-01-01T00:00:00.000Z" } });
    relationshipStore.set("rel-readfail", {
      id: "rel-readfail", agentId: "agent-1", subject: "nathan", predicate: "manages", object: "flint", provenance: legacy,
    });
    const r: any = makeRelationship(agentCtx("agent-1"));
    r._targetId = "rel-readfail";
    // r4/merge: the semantic-PATCH decision and the originatorInstanceId
    // create/update decision share ONE stored-row read — the #1965
    // resolveStoredRow, which reads through the URL-bound target id via the
    // table reader (BaseRelationship.get). Make THAT read fail: the write must
    // be refused, never degraded to a metadata-only, blob-preserving decision.
    const getSpy = spyOn(BaseRelationship, "get").mockImplementation(async () => {
      throw new Error("simulated stored-row read failure");
    });
    let superPatchCalls = 0;
    const realPatch = BaseRelationship.prototype.patch;
    const patchSpy = spyOn(BaseRelationship.prototype, "patch").mockImplementation(function (this: any, content: any) {
      superPatchCalls += 1;
      return realPatch.call(this, content);
    });
    try {
      const res = await r.patch({ subject: "nathan-renamed" });
      expect(superPatchCalls).toBe(0); // never delegated to the blob-preserving by-id store write
      expect(res instanceof Response).toBe(true);
      expect((res as Response).status).toBe(500);
      await expect((res as Response).json()).resolves.toMatchObject({ error: "stored_row_lookup_failed" });
      expect(relationshipStore.get("rel-readfail").subject).toBe("nathan"); // nothing landed
      expect(relationshipStore.get("rel-readfail").provenance).toBe(legacy);
    } finally {
      getSpy.mockRestore();
      patchSpy.mockRestore();
    }
  });

  it("a semantic PATCH body's claimedClient is folded into claimed.client and NEVER persisted as a row field", async () => {
    relationshipStore.set("rel-cc-sem", {
      id: "rel-cc-sem", agentId: "agent-1", subject: "a", predicate: "b", object: "c", createdAt: "2001-01-01T00:00:00.000Z",
    });
    const r: any = makeRelationship(agentCtx("agent-1"));
    r._targetId = "rel-cc-sem";
    await r.patch({ subject: "a-renamed", claimedClient: "codex" }); // semantic change
    const stored = relationshipStore.get("rel-cc-sem");
    expect(stored.subject).toBe("a-renamed"); // control: the patch landed
    expect("claimedClient" in stored).toBe(false); // never a top-level row field
    const prov = JSON.parse(stored.provenance);
    expect(prov.claimed.client).toBe("codex"); // folded into provenance only
  });

  it("a metadata-only PATCH body's claimedClient is never persisted as a row field either", async () => {
    const legacy = JSON.stringify({ v: 1, verified: { agentId: "agent-1", timestamp: "2001-01-01T00:00:00.000Z" } });
    relationshipStore.set("rel-cc-meta", {
      id: "rel-cc-meta", agentId: "agent-1", subject: "a", predicate: "b", object: "c", confidence: 1.0, provenance: legacy,
    });
    const r: any = makeRelationship(agentCtx("agent-1"));
    r._targetId = "rel-cc-meta";
    await r.patch({ confidence: 0.4, claimedClient: "codex" }); // metadata-only
    const stored = relationshipStore.get("rel-cc-meta");
    expect(stored.confidence).toBe(0.4); // control: the patch landed
    expect("claimedClient" in stored).toBe(false); // never a top-level row field
    expect(stored.provenance).toBe(legacy); // no semantic change ⇒ stored blob preserved
  });
});

// ─── flair#1960 r4 — createdAt is SEMANTIC for Relationship.patch() ────────
describe("flair#1960 r4 — a createdAt-only Relationship PATCH re-stamps provenance", () => {
  it("re-stamps provenance and claimed.createdAt follows the new row createdAt", async () => {
    const before = Date.now();
    relationshipStore.set("rel-createdat", {
      id: "rel-createdat", agentId: "agent-1", subject: "a", predicate: "b", object: "c",
      createdAt: "2001-01-01T00:00:00.000Z",
      provenance: JSON.stringify({
        v: 1,
        verified: { agentId: "agent-1", timestamp: "2001-01-01T00:00:00.000Z", receivedAt: "2001-01-01T00:00:00.000Z" },
        claimed: { createdAt: "2001-01-01T00:00:00.000Z" },
      }),
    });
    const r: any = makeRelationship(agentCtx("agent-1"));
    r._targetId = "rel-createdat";
    // createdAt-ONLY (no identity change) — must still re-stamp.
    await r.patch({ createdAt: "2002-02-02T03:04:05.678Z" });
    const stored = relationshipStore.get("rel-createdat");
    expect(stored.createdAt).toBe("2002-02-02T03:04:05.678Z"); // control: the patch landed
    const prov = JSON.parse(stored.provenance);
    const stamped = Date.parse(prov.verified.timestamp);
    expect(stamped).toBeGreaterThanOrEqual(before - 5000);
    expect(stamped).toBeLessThanOrEqual(Date.now() + 5000);
    expect(prov.verified.timestamp).toBe(prov.verified.receivedAt);
    expect(prov.verified.timestamp).not.toBe("2001-01-01T00:00:00.000Z"); // stale stored stamp not carried forward
    expect(prov.claimed.createdAt).toBe("2002-02-02T03:04:05.678Z"); // the claim follows the row
    expect(prov.claimed.createdAt).toBe(stored.createdAt);
  });

  it("a createdAt-only PATCH whose value needs sanitizing records the sanitized claim", async () => {
    relationshipStore.set("rel-createdat-san", {
      id: "rel-createdat-san", agentId: "agent-1", subject: "a", predicate: "b", object: "c",
      createdAt: "2001-01-01T00:00:00.000Z",
    });
    const r: any = makeRelationship(agentCtx("agent-1"));
    r._targetId = "rel-createdat-san";
    const RAW = "  2002-02-02T03:04:05.678Z\n";
    await r.patch({ createdAt: RAW });
    const stored = relationshipStore.get("rel-createdat-san");
    expect(stored.createdAt).toBe(RAW); // the row keeps the caller's value unchanged
    const prov = JSON.parse(stored.provenance);
    expect(prov.claimed.createdAt).toBe("2002-02-02T03:04:05.678Z"); // sanitized: control chars stripped, trimmed
    expect(prov.claimed.createdAt).toBe(stored.createdAt.trim()); // = sanitizeClaim(row.createdAt)
  });

  it("a metadata-only PATCH still preserves the stored provenance (and its claimed.createdAt)", async () => {
    const legacy = JSON.stringify({
      v: 1,
      verified: { agentId: "agent-1", timestamp: "2001-01-01T00:00:00.000Z", receivedAt: "2001-01-01T00:00:00.000Z" },
      claimed: { createdAt: "2001-01-01T00:00:00.000Z" },
    });
    relationshipStore.set("rel-createdat-meta", {
      id: "rel-createdat-meta", agentId: "agent-1", subject: "a", predicate: "b", object: "c", confidence: 1.0, provenance: legacy,
    });
    const r: any = makeRelationship(agentCtx("agent-1"));
    r._targetId = "rel-createdat-meta";
    await r.patch({ confidence: 0.4 });
    const stored = relationshipStore.get("rel-createdat-meta");
    expect(stored.confidence).toBe(0.4); // control: the patch landed
    expect(stored.provenance).toBe(legacy); // no semantic change ⇒ stored blob preserved
    expect(JSON.parse(stored.provenance).claimed.createdAt).toBe("2001-01-01T00:00:00.000Z");
  });
});

// ─── flair#718 authorship-provenance — Relationship.put() claimedClient ────
describe("flair#718 authorship-provenance — Relationship.put() claimedClient handling", () => {
  it("a claimedClient on the write body is folded into provenance.claimed.client, and NEVER persisted as a top-level row field", async () => {
    const r = makeRelationship(agentCtx("agent-1"));
    const res: any = await r.put({
      id: "rel-claimed-client-1",
      subject: "nathan",
      predicate: "manages",
      object: "flint",
      claimedClient: "codex",
    });
    expect("claimedClient" in res).toBe(false);
    const prov = JSON.parse(res.provenance);
    expect(prov.claimed.client).toBe("codex");

    const stored = relationshipStore.get("rel-claimed-client-1");
    expect("claimedClient" in stored).toBe(false);
  });

  it("absent claimedClient → provenance carries no claimed.client (only the claimed.createdAt time)", async () => {
    const r = makeRelationship(agentCtx("agent-1"));
    const res: any = await r.put({ id: "rel-claimed-client-2", subject: "a", predicate: "b", object: "c" });
    const prov = JSON.parse(res.provenance);
    expect(prov.claimed.client).toBeUndefined();
    expect(typeof prov.claimed.createdAt).toBe("string");
  });
});

// ─── flair#1965 round 2 — URL-target resolution + PATCH-create stamping ──────
describe("flair#1965 r2 — Relationship PUT resolves the URL-bound target; PATCH creates are stamped", () => {
  it("REFUSES a PUT whose body id differs from the URL target id", async () => {
    instanceRow = { id: "flair_local_test" };
    relationshipStore.set("rel-real", { id: "rel-real", agentId: "agent-1", subject: "a", predicate: "b", object: "c", originatorInstanceId: "instance-B" });
    const r: any = makeRelationship(agentCtx("agent-1"));
    r._targetId = "rel-real";
    const res: any = await r.put({ id: "rel-decoy", subject: "a", predicate: "b", object: "c", originatorInstanceId: "instance-attacker" });
    expect(res instanceof Response).toBe(true);
    expect(res.status).toBe(400);
    expect(relationshipStore.get("rel-decoy")).toBeUndefined();
    expect(relationshipStore.get("rel-real").originatorInstanceId).toBe("instance-B");
  });

  it("PATCH that CREATES a row (URL target has no stored row) stamps the local instance id", async () => {
    instanceRow = { id: "flair_local_test" };
    const r: any = makeRelationship(agentCtx("agent-1"));
    r._targetId = "rel-patch-new";
    await r.patch({ subject: "nathan", predicate: "manages", object: "flint" });
    expect(relationshipStore.get("rel-patch-new").originatorInstanceId).toBe("flair_local_test");
  });
});
