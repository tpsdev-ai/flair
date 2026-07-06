/**
 * semantic-search-scoping.test.ts — unit coverage for
 * resources/SemanticSearch.ts's read-scoping.
 *
 * The original grant-gated read model (superseded by within-org-read-open,
 * see resources/memory-read-scope.ts's module doc): SemanticSearch used to
 * have its OWN inline grant-resolution loop PLUS a `visibility === "office"`
 * global OR-clause: ANY authenticated agent could read ANY other agent's
 * memory once it happened to carry `visibility: "office"` — no grant
 * required at all (the office-visibility read leak, an unintentional LEAK).
 * Both are gone; SemanticSearch now
 * resolves its scope through the ONE centralized helper
 * (resources/memory-read-scope.ts resolveReadScope()), the same one
 * Memory.search()/Memory.get() use — which now DELIBERATELY grants that same
 * "any non-private record, any agent" read, org-wide, as an intentional
 * design decision (Kern-approved), not a leak. Only `visibility: "private"`
 * remains owner-only.
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

describe("SemanticSearch.post() — centralized read-scoping", () => {
  it("anonymous is denied (401)", async () => {
    reset();
    const s = makeSearch(anonCtx());
    const res = await s.post({});
    expect(res instanceof Response).toBe(true);
    expect((res as Response).status).toBe(401);
  });

  it("sees its own records PLUS every other agent's non-private records — no grant required", async () => {
    reset();
    memoryStore.set("m1", { id: "m1", agentId: "agent-1", content: "mine", visibility: "private" });
    memoryStore.set("m2", { id: "m2", agentId: "agent-other", content: "not mine, but org-open", visibility: "shared" });
    memoryStore.set("m3", { id: "m3", agentId: "agent-other", content: "not mine, private", visibility: "private" });
    const s = makeSearch(agentCtx("agent-1"));
    const res: any = await s.post({});
    const ids = res.results.map((r: any) => r.id).sort();
    // m1 (own, private is irrelevant for the owner) and m2 (another agent's
    // shared record — org-open, no grant needed) both surface; m3 (another
    // agent's PRIVATE record) is the only one excluded.
    expect(ids).toEqual(["m1", "m2"]);
  });

  it("within-org-read-open (was: office-OR leak closed): an UNGRANTED owner's SHARED memory IS now returned — this is the intended, documented broadening, not a leak", async () => {
    reset();
    memoryStore.set("shared-no-grant", { id: "shared-no-grant", agentId: "agent-owner", content: "shared, no grant held, still org-open", visibility: "shared" });
    const s = makeSearch(agentCtx("agent-stranger"));
    const res: any = await s.post({});
    expect(res.results.map((r: any) => r.id)).toContain("shared-no-grant");
  });

  it("private-exclusion still holds without a grant: a stranger never sees another agent's PRIVATE memory", async () => {
    reset();
    memoryStore.set("private-no-grant", { id: "private-no-grant", agentId: "agent-owner", content: "private, no grant held", visibility: "private" });
    const s = makeSearch(agentCtx("agent-stranger"));
    const res: any = await s.post({});
    expect(res.results.map((r: any) => r.id)).not.toContain("private-no-grant");
  });

  it("any reader sees the owner's SHARED memory, never the owner's PRIVATE one — no grant held at all", async () => {
    reset();
    memoryStore.set("shared-1", { id: "shared-1", agentId: "agent-owner", content: "shared finding", visibility: "shared" });
    memoryStore.set("private-1", { id: "private-1", agentId: "agent-owner", content: "private note", visibility: "private" });
    // Deliberately no MemoryGrant pushed — proving the grant isn't what
    // makes shared-1 visible.

    const s = makeSearch(agentCtx("agent-grantee"));
    const res: any = await s.post({});
    const ids = res.results.map((r: any) => r.id).sort();
    expect(ids).toEqual(["shared-1"]);
    expect(ids).not.toContain("private-1");
  });

  it("migration invariant: any reader sees a NO-visibility-field owner record (absent reads as non-private) — no grant held at all", async () => {
    reset();
    memoryStore.set("legacy-1", { id: "legacy-1", agentId: "agent-owner", content: "pre-migration finding" }); // no visibility field
    // Deliberately no MemoryGrant pushed.

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

  // ─── ops-syzm: singleton $distance-omission fallback ───────────────────────
  // This mock's Memory.search() never annotates `$distance` on returned
  // records (that's a Harper-computed sort-query field with no equivalent in
  // the in-memory mock) — so any test that takes the HNSW (qEmb-truthy)
  // branch below exercises the undefined-$distance fallback path by
  // construction, standing in for Harper's real singleton-result-set quirk
  // (see resources/SemanticSearch.ts's scoring block for the full writeup,
  // and test/integration/semantic-search-singleton-score.test.ts for the
  // real-Harper reproduction this was root-caused against).
  it("ops-syzm: undefined $distance falls back to a point-lookup cosine computation instead of scoring 0", async () => {
    reset();
    const qEmb = [1, 0, 0];
    // Orthogonal to qEmb — the pre-fix `?? 1` fallback and the fixed
    // point-lookup cosine computation would BOTH read as "not similar" here,
    // so this record is a control: it must never be mistaken for a match.
    memoryStore.set("m-orthogonal", { id: "m-orthogonal", agentId: "agent-1", content: "unrelated", visibility: "private", embedding: [0, 1, 0] });
    // Identical to qEmb — cosineSimilarity == 1 exactly. Pre-fix this record
    // would score 0 (distanceToSimilarity(undefined ?? 1) === 0); post-fix it
    // must score a real positive similarity via the embedding point-lookup.
    memoryStore.set("m-identical", { id: "m-identical", agentId: "agent-1", content: "matches the query", visibility: "private", embedding: [1, 0, 0] });

    const s = makeSearch(agentCtx("agent-1"));
    const res: any = await s.post({ queryEmbedding: qEmb, scoring: "raw", limit: 10 });

    const byId = new Map(res.results.map((r: any) => [r.id, r]));
    expect(byId.get("m-identical")?._score).toBe(1);
    expect(byId.get("m-orthogonal")?._score).toBe(0);
  });
});
