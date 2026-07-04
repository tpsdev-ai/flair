/**
 * semantic-search-scoping.test.ts — ops-2dm3 Layer 1 unit coverage for
 * resources/SemanticSearch.ts's read-scoping.
 *
 * Before this change, SemanticSearch had its OWN inline grant-resolution loop
 * PLUS a `visibility === "office"` global OR-clause: ANY authenticated agent
 * could read ANY other agent's memory once it happened to carry
 * `visibility: "office"` — no grant required at all (ops-nzxa). Both are
 * gone; SemanticSearch now resolves its scope through the ONE centralized
 * helper (resources/memory-read-scope.ts resolveReadScope()), the same one
 * Memory.search()/Memory.get() use.
 *
 * These tests exercise the SHIPPED SemanticSearch.post() directly against a
 * mocked @harperfast/harper, using the "no embedding, no q" keyword-fallback
 * path (resources/SemanticSearch.ts's final `else` branch) so the scoping
 * conditions[] alone determine what comes back — no embeddings-provider
 * dependency, deterministic. Same in-memory-store mocking technique as
 * test/unit/memory-integrity.test.ts; this file owns SemanticSearch.ts's
 * mock+import exclusively (no other test/unit/ file imports it), avoiding the
 * class-capture collision documented there.
 */
import { describe, it, expect, mock } from "bun:test";

process.env.FLAIR_RATE_LIMIT_ENABLED = "false";
delete (process.env as any).FLAIR_PUBLIC;
delete (process.env as any).FLAIR_HYBRID_RETRIEVAL;

// None of this file's tests set `q`/`queryEmbedding`, so SemanticSearch.ts
// never actually CALLS getEmbedding/getMode — but `bun test test/unit` runs
// every file in one process, and another file's `mock.module` for this same
// specifier can win the module cache race. Mock it explicitly here too (a
// superset of SemanticSearch.ts's named imports) so this file never depends
// on another file's mock being complete.
mock.module("../../resources/embeddings-provider.ts", () => ({
  getEmbedding: async () => null,
  getMode: () => "none",
}));

// ─── In-memory Harper Memory / MemoryGrant mock (search-only; SemanticSearch
// never post()/put()s Memory directly, only patches retrievalCount via
// patchRecord — a fire-and-forget best-effort call we don't need to assert) ──

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

let memoryStore: Map<string, any>;
let memoryGrants: any[];

function memorySearchGen(query: any) {
  const conditions = Array.isArray(query) ? query : Array.isArray(query?.conditions) ? query.conditions : [];
  let records = Array.from(memoryStore.values());
  for (const cond of conditions) records = records.filter((r) => matchesCondition(r, cond));
  async function* gen() {
    for (const r of records) yield r;
  }
  return gen();
}

const databasesMock = {
  flair: {
    Memory: {
      search: (query: any) => memorySearchGen(query),
      get: async (id: any) => memoryStore.get(typeof id === "string" ? id : id?.id) ?? null,
      put: async (content: any) => { memoryStore.set(content.id, { ...content }); return { ...content }; },
    },
    MemoryGrant: {
      search: (query: any) => {
        const conditions = Array.isArray(query?.conditions) ? query.conditions : [];
        let grants = memoryGrants.slice();
        for (const cond of conditions) grants = grants.filter((g) => matchesCondition(g, cond));
        async function* gen() {
          for (const g of grants) yield g;
        }
        return gen();
      },
    },
    Agent: { get: async () => null, search: async () => [] },
  },
};

class ResourceBase {}

mock.module("@harperfast/harper", () => ({ databases: databasesMock, Resource: ResourceBase }));

const { SemanticSearch } = await import("../../resources/SemanticSearch.ts");

function makeSearch(ctxRequest: any) {
  const r: any = new (SemanticSearch as any)();
  r.getContext = () => ({ request: ctxRequest });
  return r;
}
const agentCtx = (agentId: string, isAdmin = false) => ({ tpsAgent: agentId, tpsAgentIsAdmin: isAdmin });
const anonCtx = () => ({ tpsAnonymous: true });

function reset() {
  memoryStore = new Map();
  memoryGrants = [];
}

describe("SemanticSearch.post() — ops-2dm3 Layer 1 centralized read-scoping", () => {
  it("anonymous is denied (401)", async () => {
    reset();
    const s = makeSearch(anonCtx());
    const res = await s.post({});
    expect(res instanceof Response).toBe(true);
    expect((res as Response).status).toBe(401);
  });

  it("sees only its own records when no grants are held", async () => {
    reset();
    memoryStore.set("m1", { id: "m1", agentId: "agent-1", content: "mine", visibility: "private" });
    memoryStore.set("m2", { id: "m2", agentId: "agent-other", content: "not mine", visibility: "shared" });
    const s = makeSearch(agentCtx("agent-1"));
    const res: any = await s.post({});
    const ids = res.results.map((r: any) => r.id).sort();
    expect(ids).toEqual(["m1"]);
  });

  it("office-OR leak CLOSED: an ungranted owner's SHARED memory is never returned (ops-nzxa)", async () => {
    reset();
    memoryStore.set("shared-no-grant", { id: "shared-no-grant", agentId: "agent-owner", content: "shared but no grant held", visibility: "shared" });
    const s = makeSearch(agentCtx("agent-stranger"));
    const res: any = await s.post({});
    expect(res.results.map((r: any) => r.id)).not.toContain("shared-no-grant");
    expect(res.results.length).toBe(0);
  });

  it("a grant-holder sees the owner's SHARED memory, never the owner's PRIVATE one", async () => {
    reset();
    memoryStore.set("shared-1", { id: "shared-1", agentId: "agent-owner", content: "shared finding", visibility: "shared" });
    memoryStore.set("private-1", { id: "private-1", agentId: "agent-owner", content: "private note", visibility: "private" });
    memoryGrants.push({ granteeId: "agent-grantee", ownerId: "agent-owner", scope: "read" });

    const s = makeSearch(agentCtx("agent-grantee"));
    const res: any = await s.post({});
    const ids = res.results.map((r: any) => r.id).sort();
    expect(ids).toEqual(["shared-1"]);
    expect(ids).not.toContain("private-1");
  });

  it("migration invariant: a grant-holder sees a NO-visibility-field owner record (absent reads as shared)", async () => {
    reset();
    memoryStore.set("legacy-1", { id: "legacy-1", agentId: "agent-owner", content: "pre-migration finding" }); // no visibility field
    memoryGrants.push({ granteeId: "agent-grantee", ownerId: "agent-owner", scope: "search" });

    const s = makeSearch(agentCtx("agent-grantee"));
    const res: any = await s.post({});
    expect(res.results.map((r: any) => r.id)).toEqual(["legacy-1"]);
  });

  it("the owner always sees its own private memory via this endpoint too", async () => {
    reset();
    memoryStore.set("mine-private", { id: "mine-private", agentId: "agent-1", content: "my private note", visibility: "private" });
    const s = makeSearch(agentCtx("agent-1"));
    const res: any = await s.post({});
    expect(res.results.map((r: any) => r.id)).toEqual(["mine-private"]);
  });

  it("admin (no bodyAgentId) is unfiltered — sees everything regardless of visibility/grant", async () => {
    reset();
    memoryStore.set("a", { id: "a", agentId: "agent-x", visibility: "private" });
    memoryStore.set("b", { id: "b", agentId: "agent-y", visibility: "shared" });
    const s = makeSearch(agentCtx("agent-admin", true));
    const res: any = await s.post({});
    const ids = res.results.map((r: any) => r.id).sort();
    expect(ids).toEqual(["a", "b"]);
  });

  it("archived records stay excluded regardless of the scoping change", async () => {
    reset();
    memoryStore.set("live", { id: "live", agentId: "agent-1", visibility: "private", archived: false });
    memoryStore.set("gone", { id: "gone", agentId: "agent-1", visibility: "private", archived: true });
    const s = makeSearch(agentCtx("agent-1"));
    const res: any = await s.post({});
    expect(res.results.map((r: any) => r.id)).toEqual(["live"]);
  });
});
