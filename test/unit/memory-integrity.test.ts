/**
 * memory-integrity.test.ts — regression guard for the memory-integrity fix
 * (flair#526 silent-drop, flair#548 stale-read-after-update, ops-a4t5
 * supersede silent-fail).
 *
 * Exercises resources/Memory.ts (post/put) directly against a mocked
 * @harperfast/harper, same technique as coordination-write-auth.test.ts and
 * resolve-agent-auth.test.ts. The auth verdict is injected via
 * getContext().request.tpsAgent/tpsAgentIsAdmin — exactly what the
 * non-rejecting gate sets after verifying a signature.
 *
 * ── Deterministic dedup testing without a real embedding model ──────────────
 * getEmbedding() is mocked to return the SAME constant vector for every
 * input, so raw cosine similarity is ALWAYS 1.0 between any two memories in
 * this file. This is deliberate: it isolates the Jaccard/lexical gate as the
 * ONLY discriminator, proving the co-gate requirement (cosine AND lexical)
 * rather than the pre-fix raw-cosine-only behavior, which — under this same
 * fake — would flag literally every second write as a "duplicate". The
 * lexical side of the gate runs on the REAL text via the real tokenize()/
 * jaccardSimilarity() implementations — nothing about that math is mocked.
 */
import { describe, it, expect, beforeEach, mock, spyOn } from "bun:test";

// Defensive: `bun test <dir>` runs every file in one process, and
// resources/rate-limiter.ts reads process.env LAZILY (not cached at import
// time). test/unit/rate-limiter.test.ts enables rate limiting for its own
// assertions and restores it in afterAll — but this file's Memory.post()
// calls (many, reusing a handful of fixed agent ids) must never be affected
// by that or any future env leak, so pin it OFF explicitly here regardless
// of load order.
process.env.FLAIR_RATE_LIMIT_ENABLED = "false";
delete (process.env as any).FLAIR_PUBLIC;

const FAKE_EMBEDDING = [1, 0, 0, 0];

mock.module("../../resources/embeddings-provider.ts", () => ({
  getEmbedding: async (_text: string) => FAKE_EMBEDDING,
  getModelId: () => "mock-embedding-model",
  // getMode is unused by this file's own tests, but MUST still be exported —
  // `bun test test/unit` runs every file in one process, and another file's
  // dynamic import of a module that (transitively) imports embeddings-
  // provider.ts can resolve to whichever mock reached the module cache
  // first. An incomplete mock here previously broke
  // test/unit/semantic-search-scoping.test.ts (SemanticSearch.ts imports
  // getMode too) with "Export named 'getMode' not found" when run in the
  // same process — keep this mock's export surface a superset of every
  // consumer's named imports, not just this file's own.
  getMode: () => "local",
}));

// ─── In-memory Harper Memory / MemoryGrant / Agent mock ─────────────────────

function cosineSim(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

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
let callOrder: string[];
let idCounter: number;
// ops-ume4 simulation switch: when true, memorySearchGen's cosine-sort branch
// omits `$distance` from every candidate (real Harper's observed behavior for
// a SINGLETON cosine-query result set) instead of computing a real one —
// letting the "ops-ume4 fallback" describe block below exercise
// findConservativeDedupMatch's manual-cosine fallback deterministically,
// without needing a live Harper.
let forceUndefinedDistance = false;

function memorySearchGen(query: any) {
  let records = Array.from(memoryStore.values());
  // Memory.search()'s instance method passes either a query OBJECT
  // ({conditions: [...], ...}) or, in its "plain array / internal call"
  // fallback branch, the conditions ARRAY directly (memory-soul-read-gate
  // fix — search() previously was only ever exercised here via post()/put()'s
  // internal dedup-gate calls, which always pass an object; the instance
  // search() itself, now covered below, hits the plain-array branch too).
  const conditions = Array.isArray(query) ? query : Array.isArray(query?.conditions) ? query.conditions : [];
  for (const cond of conditions) records = records.filter((r) => matchesCondition(r, cond));
  if (query?.sort?.attribute === "embedding" && query.sort.distance === "cosine") {
    const target = query.sort.target;
    if (forceUndefinedDistance) {
      records = records.map((r) => ({ ...r, $distance: undefined }));
    } else {
      records = records
        .map((r) => ({ ...r, $distance: Array.isArray(r.embedding) ? 1 - cosineSim(r.embedding, target) : 1 }))
        .sort((a, b) => a.$distance - b.$distance);
    }
  }
  const limit = typeof query?.limit === "number" ? query.limit : undefined;
  const sliced = limit !== undefined ? records.slice(0, limit) : records;
  async function* gen() {
    for (const r of sliced) yield r;
  }
  return gen();
}

class BaseMemory {
  async post(content: any) {
    const id = content.id ?? `mock-${++idCounter}`;
    content.id = id; // mutate in place — matches real Harper create() semantics
    callOrder.push(`post:${id}`);
    const rec = { ...content };
    memoryStore.set(id, rec);
    return rec;
  }
  async put(content: any) {
    callOrder.push(`put:${content.id}`);
    const rec = { ...content };
    memoryStore.set(content.id, rec);
    return rec;
  }
  async get(target: any) {
    // Real Harper's get() receives a RequestTarget object (pathname, search,
    // id, isCollection, sort) for HTTP-routed reads, NOT a plain string — only
    // direct in-process calls (e.g. this file's other post()/put() helpers)
    // pass a bare id. Support both so get() unit tests can exercise the real
    // RequestTarget shape (ops-qjyq) without breaking the existing string-id
    // call sites in this file.
    const id = typeof target === "string" ? target : target?.id;
    return memoryStore.get(id) ?? null;
  }
  async delete(id: any) {
    memoryStore.delete(id);
    return { ok: true };
  }
  search(query: any) {
    return memorySearchGen(query);
  }

  static async get(id: any) {
    return memoryStore.get(id) ?? null;
  }
  static async put(content: any) {
    callOrder.push(`static-put:${content.id}`);
    const rec = { ...content };
    memoryStore.set(content.id, rec);
    return rec;
  }
  static search(query: any) {
    return memorySearchGen(query);
  }
}

const databasesMock = {
  flair: {
    Memory: BaseMemory,
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

mock.module("@harperfast/harper", () => ({ databases: databasesMock, Resource: class {} }));

const { Memory } = await import("../../resources/Memory.ts");
const { jaccardSimilarity, isConservativeMatch, computeMatchConfidence, cosineSimilarity } = await import("../../resources/dedup.ts");
const { tokenize } = await import("../../resources/bm25.ts");
// Dynamic (not static) import — MUST run after mock.module() above, same
// reason as the three imports directly above: a static `import ... from`
// here would be hoisted and evaluate before the @harperfast/harper mock is
// registered, binding this module's `databases` to the REAL package instead.
const { resolveAllowedOwners: scopeAllowedOwners, resolveReadScope } = await import("../../resources/memory-read-scope.ts");

function makeMemory(ctxRequest: any) {
  const r: any = new (Memory as any)();
  r.getContext = () => ({ request: ctxRequest });
  return r;
}
const agentCtx = (agentId: string, isAdmin = false) => ({ tpsAgent: agentId, tpsAgentIsAdmin: isAdmin });
const anonCtx = () => ({ tpsAnonymous: true });

beforeEach(() => {
  memoryStore = new Map();
  memoryGrants = [];
  callOrder = [];
  idCounter = 0;
  forceUndefinedDistance = false;
});

// ─── Fixture text for the #526 replay ────────────────────────────────────────
// Models the real field case: two findings that share vocabulary (both about
// federation "replication") but are substantively DIFFERENT facts, plus a
// genuine reword of one of them (same substance, different phrasing).
const FINDING_A =
  "Federation replication direction is governed by a per-pair sends and receives knob in the pairing config.";
const FINDING_B_DISTINCT =
  "DDL and schema changes never replicate automatically across a federation pair; you must apply column additions manually on each spoke.";
const FINDING_A_REWORDED =
  "Federation replication direction is controlled by a per-pair sends/receives knob inside the pairing configuration.";

// ─── Pure Jaccard / cosine co-gate math (Harper-free, no mocking needed) ─────
describe("dedup co-gate — pure math (resources/dedup.ts)", () => {
  it("topic collision: shares vocabulary but is substantively distinct → LOW jaccard", () => {
    const j = jaccardSimilarity(tokenize(FINDING_A), tokenize(FINDING_B_DISTINCT));
    expect(j).toBeLessThan(0.5);
  });

  it("true near-duplicate: reworded but same substance → HIGH jaccard", () => {
    const j = jaccardSimilarity(tokenize(FINDING_A), tokenize(FINDING_A_REWORDED));
    expect(j).toBeGreaterThanOrEqual(0.5);
  });

  it("isConservativeMatch requires BOTH cosine and lexical thresholds to clear", () => {
    expect(isConservativeMatch(0.99, 0.2)).toBe(false); // high cosine, low lexical — topic collision
    expect(isConservativeMatch(0.99, 0.6)).toBe(true); // both high — true near-dup
    expect(isConservativeMatch(0.8, 0.9)).toBe(false); // low cosine, high lexical
  });

  it("computeMatchConfidence rounds to 3dp and derives lexical from real tokenize()", () => {
    const conf = computeMatchConfidence("hello world foo", "hello world bar", 0.99996);
    expect(conf.cosine).toBe(1);
    expect(conf.lexical).toBeGreaterThan(0);
    expect(conf.lexical).toBeLessThan(1);
  });

  it("jaccardSimilarity of two empty/no-overlap sets is 0, never treated as a match", () => {
    expect(jaccardSimilarity([], [])).toBe(0);
    expect(jaccardSimilarity(["a", "b"], [])).toBe(0);
  });

  // cosineSimilarity backs the ops-ume4 fallback in findConservativeDedupMatch
  // (resources/Memory.ts) — computed directly in JS when Harper's cosine-sort
  // query doesn't attach a $distance (see that function's doc comment).
  it("cosineSimilarity: identical vectors → 1, orthogonal vectors → 0", () => {
    expect(cosineSimilarity([1, 0, 0, 0], [1, 0, 0, 0])).toBeCloseTo(1, 10);
    expect(cosineSimilarity([1, 0, 0, 0], [0, 1, 0, 0])).toBe(0);
  });

  it("cosineSimilarity: a known non-trivial angle computes the exact expected value", () => {
    const a = [1, 0, 0, 0];
    const near = [0.9, Math.sqrt(1 - 0.81), 0, 0]; // unit vector
    expect(cosineSimilarity(a, near)).toBeCloseTo(0.9, 10);
  });

  it("cosineSimilarity: mismatched length, empty, or zero-magnitude vectors safely yield 0 (never a false 'identical')", () => {
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
    expect(cosineSimilarity([], [])).toBe(0);
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
  });
});

// ─── #526 replay + never-silent-loss ─────────────────────────────────────────
describe("Memory.post — server-side dedup gate never suppresses a write", () => {
  it("#526 replay: two topically-close but DISTINCT findings are BOTH written (not merged)", async () => {
    const m1 = makeMemory(agentCtx("agent-1"));
    const r1 = await m1.post({ agentId: "agent-1", content: FINDING_A });
    expect(r1.written).toBe(true);

    const m2 = makeMemory(agentCtx("agent-1"));
    const r2 = await m2.post({ agentId: "agent-1", content: FINDING_B_DISTINCT });

    // THE regression: both records must exist — the second must NOT have
    // been dropped/merged into the first, even though cosine is (mocked) 1.0.
    expect(memoryStore.size).toBe(2);
    expect(r2.written).toBe(true);
    expect(r2.id).not.toBe(r1.id);
    expect(r2.deduplicated).toBe(false);
    const stored2 = await BaseMemory.get(r2.id);
    expect(stored2.content).toBe(FINDING_B_DISTINCT);
  });

  it("a true near-duplicate is flagged (deduplicated:true) but STILL written as a new record", async () => {
    const m1 = makeMemory(agentCtx("agent-1"));
    const r1 = await m1.post({ agentId: "agent-1", content: FINDING_A });

    const m2 = makeMemory(agentCtx("agent-1"));
    const r2 = await m2.post({ agentId: "agent-1", content: FINDING_A_REWORDED });

    expect(memoryStore.size).toBe(2); // never-suppress invariant
    expect(r2.written).toBe(true);
    expect(r2.deduplicated).toBe(true);
    expect(r2.matchedId).toBe(r1.id);
    expect(r2.matchConfidence.cosine).toBeGreaterThanOrEqual(0.95);
    expect(r2.matchConfidence.lexical).toBeGreaterThanOrEqual(0.5);
    const stored2 = await BaseMemory.get(r2.id);
    expect(stored2.content).toBe(FINDING_A_REWORDED); // new content, never swapped for the old
  });

  it("never-silent-loss: a store whose content matches an existing record still produces a written record", async () => {
    const m1 = makeMemory(agentCtx("agent-1"));
    await m1.post({ agentId: "agent-1", content: FINDING_A });
    const before = memoryStore.size;

    const m2 = makeMemory(agentCtx("agent-1"));
    const r2 = await m2.post({ agentId: "agent-1", content: FINDING_A_REWORDED });

    expect(memoryStore.size).toBe(before + 1);
    expect(await BaseMemory.get(r2.id)).not.toBeNull();
  });

  it("short content (<20 chars) bypasses the gate entirely — identical short content is never flagged", async () => {
    const m1 = makeMemory(agentCtx("agent-1"));
    await m1.post({ agentId: "agent-1", content: "hi there" });

    const m2 = makeMemory(agentCtx("agent-1"));
    const r2 = await m2.post({ agentId: "agent-1", content: "hi there" });

    expect(r2.deduplicated).toBe(false);
    expect(memoryStore.size).toBe(2);
  });

  it("collision-signal shape: deduplicated:true + matchedId present when flagged; written always true", async () => {
    const m1 = makeMemory(agentCtx("agent-1"));
    const r1 = await m1.post({ agentId: "agent-1", content: FINDING_A });
    expect(r1.written).toBe(true);
    expect(r1.deduplicated).toBe(false);
    expect(r1.matchedId).toBeUndefined();

    const m2 = makeMemory(agentCtx("agent-1"));
    const r2 = await m2.post({ agentId: "agent-1", content: FINDING_A_REWORDED });
    expect(r2.written).toBe(true);
    expect(r2.deduplicated).toBe(true);
    expect(typeof r2.matchedId).toBe("string");
    expect(r2.matchConfidence).toEqual({ cosine: expect.any(Number), lexical: expect.any(Number) });
  });

  it("dedup match is scoped to the SAME agentId — no cross-agent false positive", async () => {
    const m1 = makeMemory(agentCtx("agent-1"));
    await m1.post({ agentId: "agent-1", content: FINDING_A });

    const m2 = makeMemory(agentCtx("agent-2"));
    const r2 = await m2.post({ agentId: "agent-2", content: FINDING_A_REWORDED }); // same text, different agent

    expect(r2.deduplicated).toBe(false);
    expect(memoryStore.size).toBe(2);
  });

  it("anonymous write is still denied (401), and never reaches the dedup gate", async () => {
    const m = makeMemory(anonCtx());
    const res = await m.post({ agentId: "agent-1", content: FINDING_A });
    expect(res instanceof Response).toBe(true);
    expect((res as Response).status).toBe(401);
    expect(memoryStore.size).toBe(0);
  });
});

// ─── ops-ume4: findConservativeDedupMatch's manual-cosine fallback ───────────
// Real Harper's cosine-sort query omits `$distance` (comes back `undefined`)
// when its post-filter result set is a SINGLETON — in practice, an agent's
// SECOND-ever memory compared against its first. That behavior can't be
// reproduced by memorySearchGen's default mock, which always computes a
// real $distance (see this file's top-of-file doc comment) — so this block
// flips forceUndefinedDistance to simulate exactly that shape and proves
// findConservativeDedupMatch's fallback (resources/Memory.ts: fetch the
// candidate's full record and compute cosine manually via dedup.ts's
// cosineSimilarity) fires correctly. See
// test/integration/dedup-supersede-e2e.test.ts's Scenario 2 for the same
// behavior proven against REAL Harper.
describe("ops-ume4: findConservativeDedupMatch falls back to a manual cosine computation when $distance is undefined", () => {
  it("a near-duplicate whose ONLY candidate has $distance undefined is still correctly flagged (real cosine, not the pre-fix 0 sentinel)", async () => {
    const m1 = makeMemory(agentCtx("agent-1"));
    const r1 = await m1.post({ agentId: "agent-1", content: FINDING_A });
    expect(r1.written).toBe(true);

    forceUndefinedDistance = true;
    const m2 = makeMemory(agentCtx("agent-1"));
    const r2 = await m2.post({ agentId: "agent-1", content: FINDING_A_REWORDED });
    forceUndefinedDistance = false;

    expect(r2.written).toBe(true); // never-suppress invariant
    expect(r2.deduplicated).toBe(true);
    expect(r2.matchedId).toBe(r1.id);
    // This mock's getEmbedding() returns the SAME constant vector for every
    // input (file-level FAKE_EMBEDDING), so a correctly-firing fallback
    // computes cosine === 1 exactly. The pre-fix code (`1 - (undefined ?? 1)`)
    // would have computed cosine === 0 here instead, forcing
    // deduplicated:false regardless of true similarity — this is the
    // regression the fallback closes.
    expect(r2.matchConfidence.cosine).toBe(1);
  });

  it("if the candidate's stored embedding is ALSO missing (legacy record), the fallback safely yields cosine 0 — never suppresses the write", async () => {
    memoryStore.set("legacy-1", { id: "legacy-1", agentId: "agent-1", content: FINDING_A, archived: false });

    forceUndefinedDistance = true;
    const m2 = makeMemory(agentCtx("agent-1"));
    const r2 = await m2.post({ agentId: "agent-1", content: FINDING_A_REWORDED });
    forceUndefinedDistance = false;

    expect(r2.written).toBe(true); // never-suppress invariant, even in this double-degenerate case
    expect(r2.deduplicated).toBe(false); // cosineSimilarity(embedding, []) === 0 — safe no-match signal
  });
});

// ─── #548 replay: memory_update same-id overwrite ────────────────────────────
describe("#548 replay: memory_update — same-id overwrite reflects new content", () => {
  it("a subsequent read returns the NEW content (not stale); the old id resolves to current", async () => {
    const owner = agentCtx("agent-1");
    const m = makeMemory(owner);
    const initial = await m.post({ agentId: "agent-1", content: "Deploy status: pending review (evolving state)." });
    const id = initial.id;

    // Simulate memory_update's default mode: read existing, merge new content
    // on top (never a bare partial — Harper PUT is full-record replacement),
    // clear the stale embedding, PUT to the SAME id. Dedup-bypassed (no
    // dedup/dedupThreshold hints set, and the id already exists).
    const existing = await BaseMemory.get(id);
    const merged: any = { ...existing, content: "Deploy status: shipped and verified in prod.", updatedAt: new Date().toISOString() };
    delete merged.embedding;
    delete merged.embeddingModel;

    const mUpdate = makeMemory(owner);
    const putResult = await mUpdate.put(merged);

    expect(putResult.written).toBe(true);
    expect(putResult.deduplicated).toBe(false); // update is dedup-bypassed, never flagged

    const after = await BaseMemory.get(id);
    expect(after.content).toBe("Deploy status: shipped and verified in prod.");
    expect(after.id).toBe(id); // the OLD id resolves to the CURRENT content
    expect(memoryStore.size).toBe(1); // same-id overwrite — no duplicate record
  });

  it("update requires ownership — a non-owner's PUT to another agent's memory id is denied, content untouched", async () => {
    const mOwner = makeMemory(agentCtx("agent-owner"));
    const owned = await mOwner.post({ agentId: "agent-owner", content: "Owner's evolving-state memory, long enough for the gate." });

    const existing = await BaseMemory.get(owned.id);
    const mAttacker = makeMemory(agentCtx("agent-attacker"));
    const res = await mAttacker.put({ ...existing, content: "Hijacked content" });

    expect(res instanceof Response).toBe(true);
    expect((res as Response).status).toBe(403);
    const stillOriginal = await BaseMemory.get(owned.id);
    expect(stillOriginal.content).toBe("Owner's evolving-state memory, long enough for the gate.");
  });

  it("a fresh PUT with a not-yet-existing id still runs the dedup gate (only an EXISTING id bypasses it)", async () => {
    const owner = agentCtx("agent-1");
    const m1 = makeMemory(owner);
    await m1.post({ agentId: "agent-1", content: FINDING_A });

    const m2 = makeMemory(owner);
    const r2 = await m2.put({ id: "agent-1-fresh-put-id", agentId: "agent-1", content: FINDING_A_REWORDED });

    expect(r2.written).toBe(true);
    expect(r2.deduplicated).toBe(true); // fresh id via PUT — not an update, gate applies
    expect(memoryStore.size).toBe(2);
  });
});

// ─── Supersede auth — reuses existing ownership/grant machinery ─────────────
describe("supersede auth (memory_update preserveHistory mode)", () => {
  it("cross-agent supersede WITHOUT a write grant is denied (403), nothing written, old record untouched", async () => {
    const mOwner = makeMemory(agentCtx("agent-owner"));
    const owned = await mOwner.post({ agentId: "agent-owner", content: "Owner's original finding, long enough for the dedup gate." });

    const mAttacker = makeMemory(agentCtx("agent-attacker"));
    const res = await mAttacker.post({
      agentId: "agent-attacker",
      content: "Attacker's replacement content, long enough for the gate too.",
      supersedes: owned.id,
    });

    expect(res instanceof Response).toBe(true);
    expect((res as Response).status).toBe(403);
    expect(memoryStore.size).toBe(1); // nothing new written
    const stillOwned = await BaseMemory.get(owned.id);
    expect(stillOwned.validTo).toBeUndefined(); // old record untouched
  });

  it("cross-agent supersede WITH a write grant succeeds and closes the old record", async () => {
    const mOwner = makeMemory(agentCtx("agent-owner"));
    const owned = await mOwner.post({ agentId: "agent-owner", content: "Owner's original finding, long enough for the dedup gate." });

    memoryGrants.push({ granteeId: "agent-attacker", ownerId: "agent-owner", scope: "write" });

    const mGranted = makeMemory(agentCtx("agent-attacker"));
    const res = await mGranted.post({
      agentId: "agent-attacker",
      content: "Granted agent's replacement content, long enough for the gate too.",
      supersedes: owned.id,
    });

    expect(res instanceof Response).toBe(false);
    expect((res as any).written).toBe(true);
    const closedOld = await BaseMemory.get(owned.id);
    expect(closedOld.validTo).toBeDefined();
  });

  it("a read-only grant (scope: read) does NOT satisfy the write-grant requirement", async () => {
    const mOwner = makeMemory(agentCtx("agent-owner"));
    const owned = await mOwner.post({ agentId: "agent-owner", content: "Owner's original finding, long enough for the dedup gate." });

    memoryGrants.push({ granteeId: "agent-attacker", ownerId: "agent-owner", scope: "read" });

    const mAttacker = makeMemory(agentCtx("agent-attacker"));
    const res = await mAttacker.post({
      agentId: "agent-attacker",
      content: "Attacker's replacement content, long enough for the gate too.",
      supersedes: owned.id,
    });

    expect(res instanceof Response).toBe(true);
    expect((res as Response).status).toBe(403);
  });

  it("same-owner supersede needs no grant", async () => {
    const m = makeMemory(agentCtx("agent-1"));
    const owned = await m.post({ agentId: "agent-1", content: "Original finding text, long enough for the gate." });

    const m2 = makeMemory(agentCtx("agent-1"));
    const res = await m2.post({ agentId: "agent-1", content: "Updated finding text, long enough for the gate.", supersedes: owned.id });

    expect((res as any).written).toBe(true);
    const closedOld = await BaseMemory.get(owned.id);
    expect(closedOld.validTo).toBeDefined();
  });

  it("supersedes must be a string — a non-string value is rejected with 400", async () => {
    const m = makeMemory(agentCtx("agent-1"));
    const res = await m.post({ agentId: "agent-1", content: "Some content, long enough for the gate.", supersedes: 12345 });
    expect(res instanceof Response).toBe(true);
    expect((res as Response).status).toBe(400);
  });
});

// ─── Supersede transaction — write-new BEFORE close-old, observable failure ──
describe("supersede transaction (ops-a4t5 fix)", () => {
  it("write-new happens BEFORE close-old (call order)", async () => {
    const owner = agentCtx("agent-1");
    const mOwner = makeMemory(owner);
    const owned = await mOwner.post({ agentId: "agent-1", content: "Original evolving state, long enough for the gate." });
    callOrder.length = 0; // reset — only care about the ordering of the SECOND write

    const mNew = makeMemory(owner);
    await mNew.post({ agentId: "agent-1", content: "New version, long enough for the gate.", supersedes: owned.id });

    const newWriteIdx = callOrder.findIndex((c) => c.startsWith("post:"));
    const closeWriteIdx = callOrder.findIndex((c) => c.startsWith("static-put:"));
    expect(newWriteIdx).toBeGreaterThanOrEqual(0);
    expect(closeWriteIdx).toBeGreaterThan(newWriteIdx);
  });

  it("a close-old failure is logged (observable), never silent — and the new record is still safely written", async () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const owner = agentCtx("agent-1");
      const mOwner = makeMemory(owner);
      const owned = await mOwner.post({ agentId: "agent-1", content: "Original evolving state, long enough for the gate." });

      // Force the close-old step to fail: remove the target record out from
      // under it (simulates a lost/racing record) right before the superseding
      // write — the write-new-before-close-old ordering means the auth check's
      // earlier .get() already ran/passed for a same-owner supersede (no grant
      // lookup needed), so removing it here only affects the LATER close step.
      memoryStore.delete(owned.id);

      const mNew = makeMemory(owner);
      const result = await mNew.post({ agentId: "agent-1", content: "New version, long enough for the gate.", supersedes: owned.id });

      // The new record's write must have succeeded regardless of the failed close.
      expect((result as any).written).toBe(true);
      expect(memoryStore.has((result as any).id)).toBe(true);

      // The failure was logged, not swallowed (ops-a4t5). The log uses a
      // constant format string + a structured data object (the record ids are
      // agent-controlled, so they must not sit in console.error's format
      // position — semgrep unsafe-formatstring), so flatten object args too.
      expect(errorSpy).toHaveBeenCalled();
      const loggedMsg = errorSpy.mock.calls
        .map((c) => c.map((a) => (a && typeof a === "object" ? JSON.stringify(a, (_k, v) => (v instanceof Error ? v.message : v)) : String(a))).join(" "))
        .join("\n");
      expect(loggedMsg).toContain("ops-a4t5");
      expect(loggedMsg).toContain(owned.id);
    } finally {
      errorSpy.mockRestore();
    }
  });
});

// ─── memory-soul-read-gate fix: Memory.allowRead + Memory.get() ownership scoping ──
//
// P0 regression guard for the read-gate fix: Memory.ts previously gated the
// WRITE paths (post/put, above) and search(), but neither defined
// `allowRead()` nor overrode `get()`. Harper routes `GET /Memory/<id>` to
// get() and the collection-describe `GET /Memory` outside search(), so BOTH
// were ungated — an anonymous caller got a 200 with full record content.
//
// These tests live in THIS file (rather than a separate one) deliberately:
// bun runs every file in test/unit/ in one process, and a second file that
// also `mock.module("@harperfast/harper", ...)` + dynamically imports
// "../../resources/Memory.ts" collides with THIS file's mock — the Memory
// class is a singleton across the whole run (its `class Memory extends
// (databases as any).flair.Memory` superclass reference is captured once, at
// whichever file's import happens to win), so a second competing import
// silently makes both files' Memory instances write into ONE file's
// in-memory store instead of their own. Reusing this file's existing
// mock/import avoids that collision entirely. (Soul.ts has no other
// importer in test/unit/, so its read-gate tests are a separate file.)
describe("Memory.allowRead — closes the anonymous GET /Memory/<id> and describe leak", () => {
  it("anonymous is denied", async () => {
    const m = makeMemory(anonCtx());
    expect(await (m as any).allowRead()).toBe(false);
  });

  it("a verified non-admin agent is allowed (per-record scoping is in get())", async () => {
    const m = makeMemory(agentCtx("agent-1"));
    expect(await (m as any).allowRead()).toBe(true);
  });

  it("an admin agent is allowed", async () => {
    const m = makeMemory(agentCtx("agent-admin", true));
    expect(await (m as any).allowRead()).toBe(true);
  });

  it("an internal call (no request context) is allowed", async () => {
    const r: any = new (Memory as any)();
    r.getContext = () => undefined;
    expect(await r.allowRead()).toBe(true);
  });
});

describe("Memory.get() — anonymous denied, owner/grant scoped for non-admin, unfiltered for internal/admin", () => {
  it("anonymous get(<id>) → 404, never leaks record content", async () => {
    memoryStore.set("mem-1", { id: "mem-1", agentId: "agent-owner", content: "secret" });
    const m = makeMemory(anonCtx());
    const res = await (m as any).get("mem-1");
    expect(res instanceof Response).toBe(true);
    expect((res as Response).status).toBe(404);
    const body = await (res as Response).json();
    expect(JSON.stringify(body)).not.toContain("secret");
  });

  it("verified non-admin get() of ANOTHER agent's id → 404 (not 403 — no existence confirmation)", async () => {
    memoryStore.set("mem-1", { id: "mem-1", agentId: "agent-owner", content: "secret" });
    const m = makeMemory(agentCtx("agent-attacker"));
    const res = await (m as any).get("mem-1");
    expect(res instanceof Response).toBe(true);
    expect((res as Response).status).toBe(404);
  });

  it("verified non-admin get() of ITS OWN id → returns the real record", async () => {
    memoryStore.set("mem-1", { id: "mem-1", agentId: "agent-owner", content: "my content" });
    const m = makeMemory(agentCtx("agent-owner"));
    const res = await (m as any).get("mem-1");
    expect(res instanceof Response).toBe(false);
    expect((res as any).content).toBe("my content");
  });

  it("verified non-admin get() of a GRANTED owner's id (scope: read) → returns the record", async () => {
    memoryStore.set("mem-1", { id: "mem-1", agentId: "agent-owner", content: "shared content" });
    memoryGrants.push({ granteeId: "agent-grantee", ownerId: "agent-owner", scope: "read" });
    const m = makeMemory(agentCtx("agent-grantee"));
    const res = await (m as any).get("mem-1");
    expect(res instanceof Response).toBe(false);
    expect((res as any).content).toBe("shared content");
  });

  it("verified non-admin get() of a GRANTED owner's id (scope: search) → returns the record too", async () => {
    memoryStore.set("mem-1", { id: "mem-1", agentId: "agent-owner", content: "shared via search scope" });
    memoryGrants.push({ granteeId: "agent-grantee", ownerId: "agent-owner", scope: "search" });
    const m = makeMemory(agentCtx("agent-grantee"));
    const res = await (m as any).get("mem-1");
    expect(res instanceof Response).toBe(false);
    expect((res as any).content).toBe("shared via search scope");
  });

  it("a WRITE-scoped grant does NOT satisfy the read/get requirement → still 404", async () => {
    memoryStore.set("mem-1", { id: "mem-1", agentId: "agent-owner", content: "secret" });
    memoryGrants.push({ granteeId: "agent-grantee", ownerId: "agent-owner", scope: "write" });
    const m = makeMemory(agentCtx("agent-grantee"));
    const res = await (m as any).get("mem-1");
    expect(res instanceof Response).toBe(true);
    expect((res as Response).status).toBe(404);
  });

  it("a non-existent id for a non-admin agent → 404 (same as denied — no oracle for existence)", async () => {
    const m = makeMemory(agentCtx("agent-owner"));
    const res = await (m as any).get("does-not-exist");
    expect(res instanceof Response).toBe(true);
    expect((res as Response).status).toBe(404);
  });

  it("internal call (no request context) → returns any id unchanged", async () => {
    memoryStore.set("mem-1", { id: "mem-1", agentId: "agent-owner", content: "secret" });
    const r: any = new (Memory as any)();
    r.getContext = () => undefined;
    const res = await r.get("mem-1");
    expect(res instanceof Response).toBe(false);
    expect((res as any).content).toBe("secret");
  });

  it("admin agent → returns any id unchanged, no ownership check", async () => {
    memoryStore.set("mem-1", { id: "mem-1", agentId: "agent-owner", content: "secret" });
    const m = makeMemory(agentCtx("agent-admin", true));
    const res = await (m as any).get("mem-1");
    expect(res instanceof Response).toBe(false);
    expect((res as any).content).toBe("secret");
  });
});

// ─── ops-qjyq: shift the isCollection routing class left to the unit layer ──
//
// The above Memory.get() describe block only ever calls get("mem-1") — a
// plain string. Real Harper's get() is invoked with a RequestTarget object
// (pathname, search, id, isCollection, sort), NOT a plain string. A bug where
// Memory.get() failed to branch on target.isCollection was caught ONLY by the
// real-Harper integration suite: super.get(target) received the whole
// RequestTarget, found no truthy `.agentId` on it, and a valid authenticated
// self-query (`GET /Memory/?agentId=X`) 404'd. These tests use a RequestTarget-
// shaped plain object (not a string) so this routing class can be caught here,
// at the unit layer, in ~seconds instead of the 75s integration job.
function requestTarget(overrides: Partial<{ pathname: string; search: string; id: string; isCollection: boolean; sort: any }>) {
  return { pathname: "/Memory/", search: "", id: undefined, isCollection: false, sort: undefined, ...overrides };
}

describe("Memory.get() — RequestTarget routing, isCollection branch (ops-qjyq)", () => {
  it("collection/query target (isCollection: true) delegates to search() and returns the caller's OWN records — not a 404, not a single-record mis-route (the exact regression)", async () => {
    memoryStore.set("mem-own", { id: "mem-own", agentId: "agent-1", content: "mine" });
    memoryStore.set("mem-other", { id: "mem-other", agentId: "agent-other", content: "not mine" });
    const m = makeMemory(agentCtx("agent-1"));
    const target = requestTarget({ search: "?agentId=agent-1", isCollection: true });
    const res: any = await (m as any).get(target);

    // THE regression: if the isCollection branch is lost, this falls through
    // to super.get(target) — a result-set has no `.agentId`, so the ownership
    // check 404s a perfectly valid authenticated self-query.
    expect(res instanceof Response).toBe(false);

    const results: any[] = [];
    for await (const r of res) results.push(r);
    expect(results.map((r) => r.id)).toEqual(["mem-own"]);
  });

  it("by-id target (isCollection: false, id set) — own id returns the record", async () => {
    memoryStore.set("mem-1", { id: "mem-1", agentId: "agent-owner", content: "my content" });
    const m = makeMemory(agentCtx("agent-owner"));
    const target = requestTarget({ pathname: "/Memory/mem-1", id: "mem-1", isCollection: false });
    const res = await (m as any).get(target);
    expect(res instanceof Response).toBe(false);
    expect((res as any).content).toBe("my content");
  });

  it("by-id target — another agent's id → 404 (never 403 — no existence oracle)", async () => {
    memoryStore.set("mem-1", { id: "mem-1", agentId: "agent-owner", content: "secret" });
    const m = makeMemory(agentCtx("agent-attacker"));
    const target = requestTarget({ pathname: "/Memory/mem-1", id: "mem-1", isCollection: false });
    const res = await (m as any).get(target);
    expect(res instanceof Response).toBe(true);
    expect((res as Response).status).toBe(404);
  });

  it("by-id target — admin agent is unfiltered", async () => {
    memoryStore.set("mem-1", { id: "mem-1", agentId: "agent-owner", content: "secret" });
    const m = makeMemory(agentCtx("agent-admin", true));
    const target = requestTarget({ pathname: "/Memory/mem-1", id: "mem-1", isCollection: false });
    const res = await (m as any).get(target);
    expect(res instanceof Response).toBe(false);
    expect((res as any).content).toBe("secret");
  });

  it("by-id target — internal call (no request context) is unfiltered", async () => {
    memoryStore.set("mem-1", { id: "mem-1", agentId: "agent-owner", content: "secret" });
    const r: any = new (Memory as any)();
    r.getContext = () => undefined;
    const target = requestTarget({ pathname: "/Memory/mem-1", id: "mem-1", isCollection: false });
    const res = await r.get(target);
    expect(res instanceof Response).toBe(false);
    expect((res as any).content).toBe("secret");
  });

  it("anonymous with a by-id RequestTarget → 404 (blocked, same as the string-id path)", async () => {
    memoryStore.set("mem-1", { id: "mem-1", agentId: "agent-owner", content: "secret" });
    const m = makeMemory(anonCtx());
    const target = requestTarget({ pathname: "/Memory/mem-1", id: "mem-1", isCollection: false });
    const res = await (m as any).get(target);
    expect(res instanceof Response).toBe(true);
    expect((res as Response).status).toBe(404);
  });
});

describe("Memory.search() — grant scoping parity with get() (shared resolveAllowedOwners helper)", () => {
  it("non-admin search sees own + granted-owner records, not an unrelated agent's", async () => {
    memoryStore.set("mem-own", { id: "mem-own", agentId: "agent-1", content: "mine" });
    memoryStore.set("mem-granted", { id: "mem-granted", agentId: "agent-owner", content: "shared" });
    memoryStore.set("mem-other", { id: "mem-other", agentId: "agent-other", content: "not mine" });
    memoryGrants.push({ granteeId: "agent-1", ownerId: "agent-owner", scope: "read" });

    const m = makeMemory(agentCtx("agent-1"));
    const results: any[] = [];
    for await (const r of await (m as any).search({ conditions: [] })) results.push(r);
    const ids = results.map((r) => r.id).sort();
    expect(ids).toEqual(["mem-granted", "mem-own"]);
  });
});

// ─── ops-2dm3 Layer 1: private/shared visibility + centralized read-scoping ──
//
// Security boundary tests. resources/memory-read-scope.ts's resolveReadScope()
// is the ONE centralized helper Memory.search()/Memory.get() (this file),
// SemanticSearch.ts, MemoryBootstrap.ts, and auth-middleware.ts's by-id guard
// all resolve their scope through — see that module's doc for the full
// rationale (closes ops-nzxa, the SemanticSearch office-OR global leak).
// scopeAllowedOwners/resolveReadScope are imported dynamically near the top
// of this file (after mock.module) alongside Memory/dedup/bm25.

describe("ops-2dm3 Layer 1 — durability-keyed default visibility (write path)", () => {
  it("Memory.post: persistent write with no visibility → stored shared", async () => {
    const m = makeMemory(agentCtx("agent-1"));
    const r = await m.post({ agentId: "agent-1", content: "A persistent lesson, long enough for the gate.", durability: "persistent" });
    expect((await BaseMemory.get(r.id)).visibility).toBe("shared");
  });

  it("Memory.post: permanent write with no visibility → stored shared", async () => {
    const m = makeMemory(agentCtx("agent-1"));
    const r = await m.post({ agentId: "agent-1", content: "A permanent principle, long enough for the gate.", durability: "permanent" });
    expect((await BaseMemory.get(r.id)).visibility).toBe("shared");
  });

  it("Memory.post: ephemeral write with no visibility → stored private", async () => {
    const m = makeMemory(agentCtx("agent-1"));
    const r = await m.post({ agentId: "agent-1", content: "Scratch state, long enough for the gate.", durability: "ephemeral" });
    expect((await BaseMemory.get(r.id)).visibility).toBe("private");
  });

  it("Memory.post: standard (or absent) durability with no visibility → stored private", async () => {
    const m = makeMemory(agentCtx("agent-1"));
    const r1 = await m.post({ agentId: "agent-1", content: "Working memory, long enough for the gate.", durability: "standard" });
    expect((await BaseMemory.get(r1.id)).visibility).toBe("private");

    const m2 = makeMemory(agentCtx("agent-1"));
    const r2 = await m2.post({ agentId: "agent-1", content: "No durability set at all, long enough for the gate." });
    expect((await BaseMemory.get(r2.id)).visibility).toBe("private");
  });

  it("Memory.post: an explicit visibility ALWAYS overrides the durability default", async () => {
    const m = makeMemory(agentCtx("agent-1"));
    const r = await m.post({ agentId: "agent-1", content: "Explicitly private despite being permanent.", durability: "permanent", visibility: "private" });
    expect((await BaseMemory.get(r.id)).visibility).toBe("private");

    const m2 = makeMemory(agentCtx("agent-1"));
    const r2 = await m2.post({ agentId: "agent-1", content: "Explicitly shared despite being ephemeral.", durability: "ephemeral", visibility: "shared" });
    expect((await BaseMemory.get(r2.id)).visibility).toBe("shared");
  });

  it("Memory.put (fresh id, not yet existing): same durability-keyed default applies", async () => {
    const m = makeMemory(agentCtx("agent-1"));
    const r = await m.put({ id: "agent-1-fresh-visibility", agentId: "agent-1", content: "Fresh PUT create, long enough for the gate.", durability: "persistent" });
    expect((await BaseMemory.get(r.id)).visibility).toBe("shared");
  });

  it("Memory.put on an EXISTING id (update/patch) NEVER stamps a default — visibility is left exactly as merged in", async () => {
    // Simulate memory_update's default same-id overwrite: read existing
    // (already has a stored visibility from its post()), merge new content on
    // top, PUT back. The merged payload carries the EXISTING visibility
    // forward — put() must not recompute/overwrite it from durability.
    const m = makeMemory(agentCtx("agent-1"));
    const initial = await m.post({ agentId: "agent-1", content: "Original note, long enough for the gate.", durability: "standard", visibility: "shared" });
    expect((await BaseMemory.get(initial.id)).visibility).toBe("shared"); // explicit override honored

    const existing = await BaseMemory.get(initial.id);
    const merged = { ...existing, content: "Updated note, long enough for the gate.", updatedAt: new Date().toISOString() };
    delete (merged as any).embedding;
    delete (merged as any).embeddingModel;

    const mUpdate = makeMemory(agentCtx("agent-1"));
    await mUpdate.put(merged);
    // Still "shared" — untouched by the update, NOT recomputed to "private"
    // (which is what durability:"standard"'s default would incorrectly stamp
    // if the fresh-record guard were broken).
    expect((await BaseMemory.get(initial.id)).visibility).toBe("shared");
  });

  it("Memory.put on an EXISTING id with NO stored visibility (pre-migration record) stays absent — never stamped", async () => {
    // A pre-migration record has no visibility field at all (simulates data
    // written before this field existed).
    memoryStore.set("legacy-1", { id: "legacy-1", agentId: "agent-1", content: "Pre-migration content.", durability: "standard" });
    const existing = await BaseMemory.get("legacy-1");
    expect(existing.visibility).toBeUndefined();

    const merged = { ...existing, content: "Patched pre-migration content.", updatedAt: new Date().toISOString() };
    const m = makeMemory(agentCtx("agent-1"));
    await m.put(merged);

    const after = await BaseMemory.get("legacy-1");
    expect(after.visibility).toBeUndefined(); // NOT stamped to "private" (standard's default)
  });
});

describe("ops-2dm3 Layer 1 — migration-equivalence (no-visibility-field memories)", () => {
  it("Memory.search: a grant-holder sees a no-visibility-field owner record exactly as before (absent reads as shared)", async () => {
    memoryStore.set("legacy-owned", { id: "legacy-owned", agentId: "agent-owner", content: "pre-migration finding" }); // no visibility field at all
    memoryGrants.push({ granteeId: "agent-grantee", ownerId: "agent-owner", scope: "read" });

    const m = makeMemory(agentCtx("agent-grantee"));
    const results: any[] = [];
    for await (const r of await (m as any).search({ conditions: [] })) results.push(r);
    expect(results.map((r) => r.id)).toEqual(["legacy-owned"]);
  });

  it("Memory.get: a grant-holder can get() a no-visibility-field owner record by id (absent reads as shared)", async () => {
    memoryStore.set("legacy-1", { id: "legacy-1", agentId: "agent-owner", content: "pre-migration finding" });
    memoryGrants.push({ granteeId: "agent-grantee", ownerId: "agent-owner", scope: "read" });

    const m = makeMemory(agentCtx("agent-grantee"));
    const res = await (m as any).get("legacy-1");
    expect(res instanceof Response).toBe(false);
    expect((res as any).content).toBe("pre-migration finding");
  });

  it("without a grant, a no-visibility-field record is STILL invisible (absence of a grant, not the field, is what gates access)", async () => {
    memoryStore.set("legacy-ungranted", { id: "legacy-ungranted", agentId: "agent-owner", content: "pre-migration finding" });
    // No grant pushed at all.
    const m = makeMemory(agentCtx("agent-stranger"));
    const res = await (m as any).get("legacy-ungranted");
    expect(res instanceof Response).toBe(true);
    expect((res as Response).status).toBe(404);
  });
});

describe("ops-2dm3 Layer 1 — private-exclusion invariant (the K&S acceptance criterion)", () => {
  it("Memory.search: a granted owner's PRIVATE memory is never returned to the grant-holder", async () => {
    memoryStore.set("mem-shared", { id: "mem-shared", agentId: "agent-owner", content: "shared finding", visibility: "shared" });
    memoryStore.set("mem-private", { id: "mem-private", agentId: "agent-owner", content: "private note", visibility: "private" });
    memoryGrants.push({ granteeId: "agent-grantee", ownerId: "agent-owner", scope: "read" });

    const m = makeMemory(agentCtx("agent-grantee"));
    const results: any[] = [];
    for await (const r of await (m as any).search({ conditions: [] })) results.push(r);
    const ids = results.map((r) => r.id).sort();
    expect(ids).toEqual(["mem-shared"]);
    expect(ids).not.toContain("mem-private");
  });

  it("Memory.get: a granted owner's PRIVATE memory 404s for the grant-holder (non-enumerating — same shape as no-grant)", async () => {
    memoryStore.set("mem-private", { id: "mem-private", agentId: "agent-owner", content: "private note", visibility: "private" });
    memoryGrants.push({ granteeId: "agent-grantee", ownerId: "agent-owner", scope: "read" });

    const m = makeMemory(agentCtx("agent-grantee"));
    const res = await (m as any).get("mem-private");
    expect(res instanceof Response).toBe(true);
    expect((res as Response).status).toBe(404);
  });

  it("the OWNER still sees its own private memory via both search() and get()", async () => {
    memoryStore.set("mem-private", { id: "mem-private", agentId: "agent-owner", content: "my private note", visibility: "private" });

    const m = makeMemory(agentCtx("agent-owner"));
    const getRes = await (m as any).get("mem-private");
    expect(getRes instanceof Response).toBe(false);
    expect((getRes as any).content).toBe("my private note");

    const m2 = makeMemory(agentCtx("agent-owner"));
    const results: any[] = [];
    for await (const r of await (m2 as any).search({ conditions: [] })) results.push(r);
    expect(results.map((r) => r.id)).toEqual(["mem-private"]);
  });

  it("admin sees a private memory unfiltered (internal/admin bypass unaffected)", async () => {
    memoryStore.set("mem-private", { id: "mem-private", agentId: "agent-owner", content: "private note", visibility: "private" });
    const m = makeMemory(agentCtx("agent-admin", true));
    const res = await (m as any).get("mem-private");
    expect(res instanceof Response).toBe(false);
    expect((res as any).content).toBe("private note");
  });

  it("a stranger with NO grant at all cannot see a SHARED memory either (grant is still required — private-exclusion narrows, never replaces, the grant gate)", async () => {
    memoryStore.set("mem-shared", { id: "mem-shared", agentId: "agent-owner", content: "shared finding", visibility: "shared" });
    const m = makeMemory(agentCtx("agent-stranger"));
    const res = await (m as any).get("mem-shared");
    expect(res instanceof Response).toBe(true);
    expect((res as Response).status).toBe(404);
  });
});

describe("ops-2dm3 Layer 1 — resolveReadScope() condition shape + injection safety", () => {
  it("no grants held → condition is the plain self leaf (unchanged shape from pre-2dm3)", async () => {
    const scope = await resolveReadScope("agent-1");
    expect(scope.allowedOwners).toEqual(["agent-1"]);
    expect(scope.condition).toEqual({ attribute: "agentId", comparator: "equals", value: "agent-1" });
  });

  it("one grant held → condition is (self) OR (owner AND visibility != 'private')", async () => {
    memoryGrants.push({ granteeId: "agent-1", ownerId: "agent-owner", scope: "read" });
    const scope = await resolveReadScope("agent-1");
    expect(scope.condition).toEqual({
      operator: "or",
      conditions: [
        { attribute: "agentId", comparator: "equals", value: "agent-1" },
        {
          operator: "and",
          conditions: [
            { attribute: "agentId", comparator: "equals", value: "agent-owner" },
            { attribute: "visibility", comparator: "not_equal", value: "private" },
          ],
        },
      ],
    });
  });

  it("uses not_equal 'private' — NEVER equals 'shared' (the migration-invariant is baked into the condition itself)", async () => {
    memoryGrants.push({ granteeId: "agent-1", ownerId: "agent-owner", scope: "search" });
    const scope = await resolveReadScope("agent-1");
    const json = JSON.stringify(scope.condition);
    expect(json).toContain("not_equal");
    expect(json).not.toContain('"equals","value":"shared"');
  });

  it("isAllowed() agrees with the condition shape for every combination", async () => {
    memoryGrants.push({ granteeId: "agent-1", ownerId: "agent-owner", scope: "read" });
    const scope = await resolveReadScope("agent-1");
    expect(scope.isAllowed({ agentId: "agent-1", visibility: "private" })).toBe(true); // own private
    expect(scope.isAllowed({ agentId: "agent-owner", visibility: "shared" })).toBe(true); // granted + shared
    expect(scope.isAllowed({ agentId: "agent-owner" })).toBe(true); // granted + no field (migration invariant)
    expect(scope.isAllowed({ agentId: "agent-owner", visibility: "private" })).toBe(false); // granted + PRIVATE
    expect(scope.isAllowed({ agentId: "agent-stranger", visibility: "shared" })).toBe(false); // ungranted
    expect(scope.isAllowed(null)).toBe(false);
    expect(scope.isAllowed(undefined)).toBe(false);
  });

  it("injection: a reader cannot craft a search query to surface a granted owner's private record", async () => {
    memoryStore.set("mem-private", { id: "mem-private", agentId: "agent-owner", content: "private note", visibility: "private" });
    memoryGrants.push({ granteeId: "agent-grantee", ownerId: "agent-owner", scope: "read" });

    // Attacker-supplied conditions try to OR their way around the scope, or
    // directly assert visibility equals "private" to force a match — Memory.
    // search() always wraps the resolved scope condition as the OUTERMOST
    // element of an implicit-AND conditions[] array, so a user-supplied
    // "or"/wildcard condition can only ever narrow the result set further,
    // never broaden past the scope.
    const attackerQuery = {
      conditions: [
        { attribute: "visibility", comparator: "equals", value: "private" },
        "or",
        { attribute: "id", comparator: "starts_with", value: "" },
      ],
    };
    const m = makeMemory(agentCtx("agent-grantee"));
    const results: any[] = [];
    for await (const r of await (m as any).search(attackerQuery)) results.push(r);
    expect(results.map((r: any) => r.id)).not.toContain("mem-private");
  });

  it("resolveAllowedOwners() (the owner-set-only helper) is unchanged in shape — still self + granted owner ids", async () => {
    memoryGrants.push({ granteeId: "agent-1", ownerId: "agent-owner-a", scope: "read" });
    memoryGrants.push({ granteeId: "agent-1", ownerId: "agent-owner-b", scope: "search" });
    const owners = await scopeAllowedOwners("agent-1");
    expect(owners.sort()).toEqual(["agent-1", "agent-owner-a", "agent-owner-b"]);
  });
});

describe("Memory.delete() — durability/ownership check uses the raw record (super.get), not the new scoped get()", () => {
  it("owner can still delete its own non-permanent memory", async () => {
    memoryStore.set("mem-1", { id: "mem-1", agentId: "agent-owner", durability: "standard" });
    const m = makeMemory(agentCtx("agent-owner"));
    await (m as any).delete("mem-1");
    expect(await BaseMemory.get("mem-1")).toBeNull();
  });

  it("a non-admin cannot delete ANOTHER agent's PERMANENT memory (durability check still fires — not bypassed by the new get() override)", async () => {
    memoryStore.set("mem-1", { id: "mem-1", agentId: "agent-owner", durability: "permanent" });
    const m = makeMemory(agentCtx("agent-attacker"));
    const res = await (m as any).delete("mem-1");
    expect(res instanceof Response).toBe(true);
    expect((res as Response).status).toBe(403);
    expect(await BaseMemory.get("mem-1")).not.toBeNull(); // untouched
  });
});
