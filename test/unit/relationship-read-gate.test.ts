/**
 * relationship-read-gate.test.ts — regression guard for the memory-soul-
 * read-gate FAMILY fix (ops-oox7): Relationship.ts previously gated
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
