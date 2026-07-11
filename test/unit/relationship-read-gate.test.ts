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
 * auth.test.ts: mock @harperfast/harper so the resource class loads outside
 * a real Harper runtime, then exercise allowRead()/get() directly. No other
 * test/unit/ file imports resources/Relationship.ts, so this file owns that
 * mock+import with no collision risk (see memory-soul-read-gate.test.ts's
 * doc comment for why that matters — bun runs test/unit/ in one process and
 * dynamic imports are cached by resolved path).
 */
import { describe, it, expect, beforeEach, mock } from "bun:test";

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
    const id = typeof target === "string" ? target : target?.id;
    return relationshipStore.get(id) ?? null;
  }
  async put(content: any) {
    relationshipStore.set(content.id, { ...content });
    return { ...content };
  }
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

mock.module("@harperfast/harper", () => ({ databases: databasesMock, Resource: class {} }));

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

// ─── federation-edge-hardening slice 1: write-time originatorInstanceId stamp ──
// See resources/Memory.ts's stampOriginatorInstanceId doc for the full
// contract. Relationship.ts only exposes put() as a write path (no post()
// override — same idiom as Memory.ts's HTTP-reachable-only-via-PUT note).
describe("federation-edge-hardening slice 1 — Relationship.put() write-time originatorInstanceId stamp", () => {
  it("stamps the local instance id on a fresh local write", async () => {
    instanceRow = { id: "flair_local_test" };
    const r = makeRelationship(agentCtx("agent-1"));
    const res: any = await r.put({ id: "rel-fresh", subject: "nathan", predicate: "manages", object: "flint" });
    expect(res.originatorInstanceId).toBe("flair_local_test");
  });

  it("stamps null when this instance has no Instance row yet — never invents one", async () => {
    instanceRow = null;
    const r = makeRelationship(agentCtx("agent-1"));
    const res: any = await r.put({ id: "rel-no-instance", subject: "nathan", predicate: "manages", object: "flint" });
    expect(res.originatorInstanceId).toBeNull();
  });

  it("THE KEY TEST — a relationship already carrying another instance's originatorInstanceId is NEVER clobbered with the local id", async () => {
    instanceRow = { id: "flair_local_test" };
    const r = makeRelationship(agentCtx("agent-1"));
    const res: any = await r.put({
      id: "rel-synced",
      subject: "nathan",
      predicate: "manages",
      object: "flint",
      originatorInstanceId: "instance-B",
    });
    expect(res.originatorInstanceId).toBe("instance-B");
    expect(res.originatorInstanceId).not.toBe("flair_local_test");
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

  it("uses the SAME shape as Memory's provenance — {v, verified:{agentId,timestamp}} — no Relationship-specific format", async () => {
    const r = makeRelationship(agentCtx("agent-1"));
    const res: any = await r.put({ id: "rel-prov-3", subject: "nathan", predicate: "manages", object: "flint" });
    const prov = JSON.parse(res.provenance);
    expect(Object.keys(prov).sort()).toEqual(["v", "verified"]);
    expect(Object.keys(prov.verified).sort()).toEqual(["agentId", "timestamp"]);
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
