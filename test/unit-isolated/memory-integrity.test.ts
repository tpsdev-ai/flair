/**
 * memory-integrity.test.ts — regression guard for the memory-integrity fix
 * (flair#526 silent-drop, flair#548 stale-read-after-update, the supersede
 * silent-fail fix).
 *
 * Exercises resources/Memory.ts (post/put) directly against a mocked
 * harper, same technique as coordination-write-auth.test.ts and
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
import { agentStore, middlewareCapture } from "../helpers/harper-mock.js";
import { createFakeReplayNonceTable } from "../helpers/fake-replay-store.ts";

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

// flair#504 Phase 2 (nomic search prefixes): records every inputType this
// mock's getEmbedding() receives, so a later assertion can pin that
// Memory.ts's dedup gate / post() / put() call sites all pass 'document' —
// the classification K&S's review made non-negotiable (all three MUST move
// together; the dedup-gate embedding IS the stored vector).
let embedInputTypeCalls: (string | undefined)[] = [];

mock.module("../../resources/embeddings-provider.ts", () => ({
  getEmbedding: async (_text: string, inputType?: string) => {
    embedInputTypeCalls.push(inputType);
    return FAKE_EMBEDDING;
  },
  getModelId: () => "mock-embedding-model",
  // embedding-space-guard slice 1: the guard (imported transitively via
  // Memory.ts) imports EMBEDDING_ENGINE — keep this mock a superset of every
  // consumer's named imports (see this mock's getMode note).
  EMBEDDING_ENGINE: "gguf",
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
// federation-edge-hardening slice 1: the local instance's own identity row
// (resources/instance-identity.ts's localInstanceId() reads this). null by
// default in most describe blocks above (no Instance table row — matches a
// never-federated instance); the originatorInstanceId describe block below
// sets this to a fixed test id.
let instanceRow: any = null;
// flair#1896: additional Instance rows, so a test can put the table in the
// several-rows state (localInstanceId() must then stamp NOTHING).
let extraInstanceRows: any[] = [];
// Singleton-cosine-fallback simulation switch: when true, memorySearchGen's
// cosine-sort branch omits `$distance` from every candidate (real Harper's
// observed behavior for a SINGLETON cosine-query result set) instead of
// computing a real one — letting the "manual-cosine fallback" describe block
// below exercise findConservativeDedupMatch's manual-cosine fallback
// deterministically, without needing a live Harper.
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
  // ── post()/put() return what REAL Harper returns, not the record ──────────
  // node_modules/harper/dist/resources/Resource.js's `async post(target,
  // newRecord)` returns `resource.#id` (or `newRecord?.[primaryKey]` on the
  // loadAsInstance===false branch) — the PRIMARY KEY, a string. Table does not
  // override post, and its put() resolves the write, never an echo of the
  // record. Either way `buildWriteResponse`'s `typeof result === "object"`
  // guard discards it and `base` is `{}`, so the response is composed purely
  // from the fields Memory.ts sets explicitly.
  //
  // These doubles used to return `{ ...content }`. That was more permissive
  // than the real class in exactly the way this file's own mock doc warns
  // about: every stored field appeared to be echoed back in the write
  // response for free, so an assertion on `response.visibility` passed
  // whether or not Memory.ts actually put it there. Returning the real shape
  // is what makes those assertions mean something.
  async post(content: any) {
    const id = content.id ?? `mock-${++idCounter}`;
    content.id = id; // mutate in place — matches real Harper create() semantics
    callOrder.push(`post:${id}`);
    memoryStore.set(id, { ...content });
    return id;
  }
  async put(content: any) {
    // Real Harper binds the resource to the URL target (`getId()`); a PUT writes
    // to THAT id. `_targetId` models the URL-bound target; unset for a direct
    // in-process call, where the body id IS the write key. See
    // resources/originator-instance.ts.
    const id = (this as any).getId?.() ?? content.id;
    callOrder.push(`put:${id}`);
    memoryStore.set(id, { ...content, id });
    return undefined;
  }
  getId() { return (this as any)._targetId; }
  async get(target: any) {
    // Real Harper's get() receives a RequestTarget object (pathname, search,
    // id, isCollection, sort) for HTTP-routed reads, NOT a plain string — only
    // direct in-process calls (e.g. this file's other post()/put() helpers)
    // pass a bare id. Support both so get() unit tests can exercise the real
    // RequestTarget shape without breaking the existing string-id
    // call sites in this file. A no-argument call models the URL-bound target
    // via an explicit `_targetId` the test sets.
    const id = typeof target === "string" ? target : (target?.id ?? (this as any)._targetId);
    return memoryStore.get(id) ?? null;
  }
  // Real Harper PATCH merges the body into the stored row; the id comes from the
  // URL, which the double models as an explicit `_targetId` on the instance.
  async patch(content: any) {
    const id = content?.id ?? (this as any)._targetId;
    const merged = { ...(memoryStore.get(id) ?? {}), ...content };
    memoryStore.set(id, merged);
    return { ...merged };
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
  // flair#1940: the Memory write path reaches the row table through its STATIC
  // callables (databases.flair.Memory.post/delete), mirroring how Memory.ts's
  // own pre-existing fetches use the static `get`. Real Harper's table is
  // static-callable, so the double must be too.
  static async post(content: any, _ctx?: any) {
    return new BaseMemory().post(content);
  }
  static async patch(content: any) {
    const id = content?.id ?? content;
    const prev = memoryStore.get(id) ?? {};
    memoryStore.set(id, { ...prev, ...content });
    return memoryStore.get(id);
  }
  static async update(id: string, row: any) {
    memoryStore.set(id, { ...row });
    return { ...row };
  }
  static async delete(id: any) {
    memoryStore.delete(typeof id === "string" ? id : id?.id);
    return true;
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
    Agent: {
      get: async (id: string) => agentStore.get(id) ?? null,
      search: async function* () {
        for (const a of agentStore.values()) yield a;
      },
    },
    // federation-edge-hardening slice 1: resources/instance-identity.ts's
    // localInstanceId() reads this table to find THIS instance's own row.
    Instance: {
      search: () => {
        async function* gen() {
          if (instanceRow) yield instanceRow;
          for (const r of extraInstanceRows) yield r;
        }
        return gen();
      },
    },
    // A signed request records its nonce here (flair#2061). Present so a
    // harper-mocking sibling in this process can import auth-middleware
    // whichever mock is in effect (flair#2307 item 6).
    ReplayNonce: createFakeReplayNonceTable(),
  },
};

mock.module("harper", () => ({
  databases: databasesMock,
  // A SHARED identity for the `server`/`Resource`/`RequestTarget` surface:
  // bun's mock.module is process-global, so a second file that mocks `harper`
  // in the same process must present a compatible shape or the module cache
  // serves whichever registration won. These exports let a harper-mocking
  // sibling (test/unit/memory-selection-middleware-1940.test.ts) import
  // auth-middleware whichever mock is in effect (flair#2307 item 6).
  server: {
    getUser: async (_user: string, _pass: string | null, _request: any) => null,
    http: (fn: any, _opts?: any) => {
      middlewareCapture.value = fn;
    },
  },
  Resource: class {},
  RequestTarget: class {},
}));

const { Memory } = await import("../../resources/Memory.ts");
const { _resetLocalInstanceIdCacheForTests } = await import("../../resources/instance-identity.ts");
const { jaccardSimilarity, isConservativeMatch, computeMatchConfidence, cosineSimilarity } = await import("../../resources/dedup.ts");
const { tokenize } = await import("../../resources/bm25.ts");
// Dynamic (not static) import — MUST run after mock.module() above, same
// reason as the three imports directly above: a static `import ... from`
// here would be hoisted and evaluate before the harper mock is
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
  instanceRow = null;
  extraInstanceRows = [];
  embedInputTypeCalls = [];
  _resetLocalInstanceIdCacheForTests();
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
// flair#1940: Harper assigns `transaction` onto the global at load, and the
// Memory write path creates one when a caller has no request context, refusing
// to run a write unwrapped. Provide it in this isolated mock.
(globalThis as any).transaction = (ctx: any, cb: (txn: any) => any) => {
  if (ctx?.transaction && ctx.transaction.open === 1) return cb(ctx.transaction);
  const txn: any = { open: 1, saveCommits: false, abort() { this.open = 0; }, commit() { this.open = 0; } };
  const c = ctx && typeof ctx === "object" ? ctx : {};
  c.transaction = txn;
  let r: any;
  try { r = cb(txn); } catch (e) { txn.abort(); throw e; }
  if (r && typeof r.then === "function") {
    return r.then((v: any) => { txn.commit(); return v; }, (e: any) => { txn.abort(); throw e; });
  }
  txn.commit();
  return r;
};

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

  // cosineSimilarity backs the manual-cosine fallback in findConservativeDedupMatch
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

// ─── flair#504 Phase 2: Memory.ts's document-write call sites pass 'document' ─
// K&S's non-negotiable: the dedup gate (runDedupGate), post()'s "generate
// embedding if missing" step, and put()'s regen branch all classify as
// DOCUMENT writes and must all pass inputType='document' — the dedup gate's
// embedding IS the stored vector, so a split prefix would break dedup via a
// mixed-space cosine compare. This pins that classification at the call-site
// level (not just embeddings-provider.ts's own unit test for the value
// itself — see embeddings-provider-input-type.test.ts).
describe("flair#504 Phase 2 — Memory.ts document call sites pass inputType='document'", () => {
  it("post() on a fresh (no dedup match) write calls getEmbedding with 'document'", async () => {
    const m = makeMemory(agentCtx("agent-1"));
    await m.post({ agentId: "agent-1", content: FINDING_A });
    expect(embedInputTypeCalls.length).toBeGreaterThan(0);
    expect(embedInputTypeCalls.every((t) => t === "document")).toBe(true);
  });

  it("put() create (fresh id, no pre-existing record) calls getEmbedding with 'document'", async () => {
    const m = makeMemory(agentCtx("agent-1"));
    await m.put({ id: "agent-1-p2-put-create", agentId: "agent-1", content: FINDING_B_DISTINCT });
    expect(embedInputTypeCalls.length).toBeGreaterThan(0);
    expect(embedInputTypeCalls.every((t) => t === "document")).toBe(true);
  });

  it("put() regen branch (content changed on an existing record) calls getEmbedding with 'document'", async () => {
    const m = makeMemory(agentCtx("agent-1"));
    const created = await m.post({ agentId: "agent-1", content: "Original content for the regen-branch test, long enough for the gate." });
    embedInputTypeCalls = []; // isolate the regen call from post()'s own embed call above
    const mUpdate = makeMemory(agentCtx("agent-1"));
    await mUpdate.put({ id: created.id, agentId: "agent-1", content: "Changed content for the regen-branch test, long enough for the gate and distinct from the original." });
    expect(embedInputTypeCalls.length).toBeGreaterThan(0);
    expect(embedInputTypeCalls.every((t) => t === "document")).toBe(true);
  });
});

// ─── findConservativeDedupMatch's manual-cosine fallback ────────────────────
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
describe("findConservativeDedupMatch falls back to a manual cosine computation when $distance is undefined", () => {
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

// ─── flair#704: explicit `supersedes: null` treated as absent ──────────────
// JSON writers that serialize optional fields as null (e.g.
// `JSON.stringify({supersedes: x ?? null})`) previously hit the same "must
// be a string" 400 that a genuinely malformed value would — even though
// OMITTING the key entirely worked fine. Fixed in
// validateAndAuthorizeSupersedes (additive-schema convention, flair#695: an
// explicit null on an optional/nullable field reads as absent). These tests
// prove: (1) null succeeds and the stored row has NO supersedes key at all
// — not a literal null, genuinely absent, matching the omitted-key case
// byte-for-byte — for both post() and put(); (2) a valid string value is
// completely unaffected; (3) a genuinely malformed (non-string, non-null)
// value is STILL rejected with 400 on both post() and put() — the leniency
// is null-specific, not a general type-check weakening.
describe("flair#704: Memory.put/post — explicit supersedes: null treated as absent", () => {
  it("Memory.post: supersedes: null succeeds; stored row has no supersedes key (byte-for-byte matches the omitted-key case)", async () => {
    const mNull = makeMemory(agentCtx("agent-1"));
    const rNull = await mNull.post({ agentId: "agent-1", content: "Null-supersedes write, long enough for the gate.", supersedes: null });
    expect(rNull instanceof Response).toBe(false);
    expect((rNull as any).written).toBe(true);
    const storedNull = await BaseMemory.get((rNull as any).id);
    expect("supersedes" in storedNull).toBe(false);
    expect(storedNull.supersedes).toBeUndefined();

    const mOmit = makeMemory(agentCtx("agent-1"));
    const rOmit = await mOmit.post({ agentId: "agent-1", content: "Omitted-supersedes write, long enough for the gate." });
    const storedOmit = await BaseMemory.get((rOmit as any).id);
    expect("supersedes" in storedOmit).toBe(false);

    // Byte-for-byte: identical key SET on both stored rows (id/content/embedding
    // differ by design — those aren't the field under test).
    expect(Object.keys(storedNull).sort()).toEqual(Object.keys(storedOmit).sort());
  });

  it("Memory.put (fresh id): supersedes: null succeeds; stored row has no supersedes key (matches the omitted-key create case)", async () => {
    const mNull = makeMemory(agentCtx("agent-1"));
    const rNull = await mNull.put({ id: "agent-1-put-null-supersedes", agentId: "agent-1", content: "Fresh PUT with null supersedes, long enough for the gate.", supersedes: null });
    expect(rNull instanceof Response).toBe(false);
    const storedNull = await BaseMemory.get("agent-1-put-null-supersedes");
    expect("supersedes" in storedNull).toBe(false);

    const mOmit = makeMemory(agentCtx("agent-1"));
    const rOmit = await mOmit.put({ id: "agent-1-put-omit-supersedes", agentId: "agent-1", content: "Fresh PUT with supersedes omitted, long enough for the gate." });
    const storedOmit = await BaseMemory.get("agent-1-put-omit-supersedes");
    expect("supersedes" in storedOmit).toBe(false);
    expect(Object.keys(storedNull).sort()).toEqual(Object.keys(storedOmit).sort());
  });

  it("Memory.put on an EXISTING record: an explicit supersedes: null in the merged payload clears a previously-set value (never persists literal null)", async () => {
    const mOwner = makeMemory(agentCtx("agent-1"));
    const target = await mOwner.post({ agentId: "agent-1", content: "Target record for the clear-via-null test, long enough for the gate." });
    const mCreate = makeMemory(agentCtx("agent-1"));
    const created = await mCreate.post({ agentId: "agent-1", content: "Record that starts out superseding target.", supersedes: target.id });
    expect((await BaseMemory.get(created.id)).supersedes).toBe(target.id);

    // Simulate a JSON writer's merge-and-clear: read existing, overwrite
    // supersedes with an explicit null, PUT back (full-record replacement).
    const existing = await BaseMemory.get(created.id);
    const merged = { ...existing, supersedes: null, updatedAt: new Date().toISOString() };
    const mUpdate = makeMemory(agentCtx("agent-1"));
    const res = await mUpdate.put(merged);
    expect(res instanceof Response).toBe(false);

    const after = await BaseMemory.get(created.id);
    expect("supersedes" in after).toBe(false);
    expect(after.supersedes).toBeUndefined();
  });

  it("supersedes with a valid string id is completely unaffected by the null-leniency fix (post and put)", async () => {
    const mOwner = makeMemory(agentCtx("agent-1"));
    const owned = await mOwner.post({ agentId: "agent-1", content: "Original, long enough for the gate." });

    const mPost = makeMemory(agentCtx("agent-1"));
    const rPost = await mPost.post({ agentId: "agent-1", content: "New version via post, long enough for the gate.", supersedes: owned.id });
    expect(rPost instanceof Response).toBe(false);
    expect((await BaseMemory.get((rPost as any).id)).supersedes).toBe(owned.id);

    const mPut = makeMemory(agentCtx("agent-1"));
    const rPut = await mPut.put({ id: "agent-1-put-valid-supersedes", agentId: "agent-1", content: "New version via put, long enough for the gate.", supersedes: owned.id });
    expect(rPut instanceof Response).toBe(false);
    expect((await BaseMemory.get("agent-1-put-valid-supersedes")).supersedes).toBe(owned.id);
  });

  it("a genuinely malformed (non-string, non-null) supersedes is still rejected with 400 on both post() and put() — leniency is null-specific, not a general weakening", async () => {
    const mPost = makeMemory(agentCtx("agent-1"));
    const resPost = await mPost.post({ agentId: "agent-1", content: "Bad supersedes via post, long enough for the gate.", supersedes: 12345 });
    expect(resPost instanceof Response).toBe(true);
    expect((resPost as Response).status).toBe(400);

    const mPut = makeMemory(agentCtx("agent-1"));
    const resPut = await mPut.put({ id: "agent-1-put-bad-supersedes", agentId: "agent-1", content: "Bad supersedes via put, long enough for the gate.", supersedes: 12345 });
    expect(resPut instanceof Response).toBe(true);
    expect((resPut as Response).status).toBe(400);
  });
});

// ─── Supersede transaction — write-new BEFORE close-old, observable failure ──
describe("supersede transaction (write-new-before-close-old fix)", () => {
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
      // under it (simulates a lost/racing record) AFTER the authorization read
      // and the new write, so only the LATER close step sees it gone (a target
      // already missing at the authorization read refuses the write instead —
      // see the flair#2307 describe below).
      const realPost = BaseMemory.post;
      const postSpy = spyOn(BaseMemory, "post").mockImplementation(async (content: any, ctx?: any) => {
        const written = await realPost(content, ctx);
        memoryStore.delete(owned.id);
        return written;
      });

      const mNew = makeMemory(owner);
      const result = await mNew.post({ agentId: "agent-1", content: "New version, long enough for the gate.", supersedes: owned.id }).finally(() => postSpy.mockRestore());

      // The new record's write must have succeeded regardless of the failed close.
      expect((result as any).written).toBe(true);
      expect(memoryStore.has((result as any).id)).toBe(true);

      // The failure was logged, not swallowed. The log uses a
      // constant format string + a structured data object (the record ids are
      // agent-controlled, so they must not sit in console.error's format
      // position — semgrep unsafe-formatstring), so flatten object args too.
      expect(errorSpy).toHaveBeenCalled();
      const loggedMsg = errorSpy.mock.calls
        .map((c) => c.map((a) => (a && typeof a === "object" ? JSON.stringify(a, (_k, v) => (v instanceof Error ? v.message : v)) : String(a))).join(" "))
        .join("\n");
      expect(loggedMsg).toContain("failed to close superseded record after writing new record");
      expect(loggedMsg).toContain(owned.id);
    } finally {
      errorSpy.mockRestore();
    }
  });
});

// ─── flair#2307: one canonical supersede target ─────────────────────────────
// The `supersedes` reference is resolved once; the reserved-id check, the
// authorization read, the stored reference and the close all use that id. A
// failed or missing target read refuses the write.
describe("flair#2307: a supersede authorizes, stores and closes one target", () => {
  const SUCCESSOR = "Successor text for the canonical target, long enough for the gate.";

  for (const reference of ["sup-own.agentId", "sup-own%2EagentId"]) {
    it(`a reference written as ${JSON.stringify(reference)} stores and closes the row it was authorized against`, async () => {
      memoryStore.set("sup-own", { id: "sup-own", agentId: "agent-1", content: "Own row, long enough for the gate." });
      memoryStore.set(reference, { id: reference, agentId: "agent-other", content: "Another agent's row, long enough for the gate." });

      const res: any = await makeMemory(agentCtx("agent-1")).post({ agentId: "agent-1", content: SUCCESSOR, supersedes: reference });

      expect(res instanceof Response).toBe(false);
      expect(memoryStore.get(res.id).supersedes).toBe("sup-own");
      expect(memoryStore.get("sup-own").validTo).toBeDefined();
      expect(memoryStore.get(reference).validTo).toBeUndefined(); // assertion: the other agent's row is not closed
    });
  }

  for (const failingRead of [1, 2]) {
    it(`a failed target read (read #${failingRead}) refuses the write with supersedes_target_unreadable and writes nothing`, async () => {
      memoryStore.set("sup-target", { id: "sup-target", agentId: "agent-1", content: "Target row, long enough for the gate." });
      const realGet = BaseMemory.get;
      let reads = 0;
      const getSpy = spyOn(BaseMemory, "get").mockImplementation(async (id: any) => {
        if (id === "sup-target" && ++reads >= failingRead) throw new Error("simulated read failure");
        return realGet(id);
      });
      try {
        const res = await makeMemory(agentCtx("agent-1")).post({ agentId: "agent-1", content: SUCCESSOR, supersedes: "sup-target" });
        expect(res instanceof Response).toBe(true);
        expect((res as Response).status).toBe(503);
        expect((await (res as Response).json()).error).toBe("supersedes_target_unreadable");
      } finally {
        getSpy.mockRestore();
      }
      expect([...memoryStore.keys()]).toEqual(["sup-target"]); // nothing written
      expect(memoryStore.get("sup-target").validTo).toBeUndefined();
    });
  }

  it("a target that does not exist refuses the write with supersedes_target_missing and writes nothing", async () => {
    const res = await makeMemory(agentCtx("agent-1")).post({ agentId: "agent-1", content: SUCCESSOR, supersedes: "sup-nowhere" });
    expect(res instanceof Response).toBe(true);
    expect((res as Response).status).toBe(409);
    expect((await (res as Response).json()).error).toBe("supersedes_target_missing");
    expect(memoryStore.size).toBe(0);
  });

  it("a re-PUT that keeps a successor's stored reference to a since-deleted target is accepted and closes nothing", async () => {
    memoryStore.set("sup-old", { id: "sup-old", agentId: "agent-1", content: "Old row, long enough for the gate." });
    const created: any = await makeMemory(agentCtx("agent-1")).put({ id: "sup-new", agentId: "agent-1", content: SUCCESSOR, supersedes: "sup-old" });
    expect(created instanceof Response).toBe(false);
    memoryStore.delete("sup-old");

    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const again = await makeMemory(agentCtx("agent-1")).put({ ...memoryStore.get("sup-new"), content: "Edited successor text, long enough for the gate." });
      expect(again instanceof Response).toBe(false);
    } finally {
      errorSpy.mockRestore();
    }
    expect(memoryStore.get("sup-new").supersedes).toBe("sup-old");
    expect(memoryStore.has("sup-old")).toBe(false); // assertion: nothing re-created by a close
  });

  it("a target whose owner changed after authorization is not closed", async () => {
    memoryStore.set("sup-swap", { id: "sup-swap", agentId: "agent-1", content: "Own row, long enough for the gate." });
    const realPost = BaseMemory.post;
    const postSpy = spyOn(BaseMemory, "post").mockImplementation(async (content: any, ctx?: any) => {
      const written = await realPost(content, ctx);
      memoryStore.set("sup-swap", { id: "sup-swap", agentId: "agent-other", content: "Another agent's row, long enough for the gate." });
      return written;
    });
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const res: any = await makeMemory(agentCtx("agent-1")).post({ agentId: "agent-1", content: SUCCESSOR, supersedes: "sup-swap" });
      expect(res instanceof Response).toBe(false);
      expect(memoryStore.has(res.id)).toBe(true);
    } finally {
      postSpy.mockRestore();
      errorSpy.mockRestore();
    }
    expect(memoryStore.get("sup-swap").agentId).toBe("agent-other");
    expect(memoryStore.get("sup-swap").validTo).toBeUndefined();
  });

  it("an owner change between the close's read and its write is not overwritten", async () => {
    memoryStore.set("sup-race", { id: "sup-race", agentId: "agent-1", content: "Own row, long enough for the gate." });
    // A stand-in for Harper's optimistic transactions: every write bumps the
    // row's version; a transaction records the version of each row read through
    // it and stages the writes made through it, and at commit applies them only
    // if none of the rows it read has changed (otherwise it aborts). A write
    // made outside a transaction applies at once.
    const versions = new Map<string, number>();
    const bump = (id: string) => versions.set(id, (versions.get(id) ?? 0) + 1);
    const savedTransaction = (globalThis as any).transaction;
    (globalThis as any).transaction = async (ctx: any, cb: (txn: any) => any) => {
      if (ctx?.transaction?.open === 1) return cb(ctx.transaction);
      const txn: any = { open: 1, saveCommits: false, reads: new Map<string, number>(), writes: [] as any[] };
      ctx.transaction = txn;
      try {
        const result = await cb(txn);
        for (const [id, seen] of txn.reads) {
          if ((versions.get(id) ?? 0) !== seen) throw new Error(`transaction conflict on ${id}`);
        }
        for (const row of txn.writes) {
          memoryStore.set(row.id, { ...row });
          bump(row.id);
        }
        return result;
      } finally {
        txn.open = 0;
      }
    };
    const txnOf = (c: any) => (c?.transaction?.open === 1 && c.transaction.reads ? c.transaction : null);
    const realGet = BaseMemory.get;
    const realPut = BaseMemory.put;
    const realPost = BaseMemory.post;
    let successorWritten = false;
    let injected = false;
    const getSpy = spyOn(BaseMemory, "get").mockImplementation(async (id: any, c?: any) => {
      txnOf(c)?.reads.set(id, versions.get(id) ?? 0);
      const row = await realGet(id);
      if (id === "sup-race" && successorWritten && !injected) {
        // The close has read the row; a competing writer changes its owner
        // before the close writes.
        injected = true;
        memoryStore.set("sup-race", { ...row, agentId: "agent-other" });
        bump("sup-race");
      }
      return row;
    });
    const putSpy = spyOn(BaseMemory, "put").mockImplementation(async (content: any, c?: any) => {
      const txn = txnOf(c);
      if (txn) {
        txn.writes.push({ ...content });
        return { ...content };
      }
      const r = await realPut(content);
      bump(content.id);
      return r;
    });
    const postSpy = spyOn(BaseMemory, "post").mockImplementation(async (content: any, ctx?: any) => {
      const written = await realPost(content, ctx);
      successorWritten = true;
      return written;
    });
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    let res: any;
    try {
      res = await makeMemory(agentCtx("agent-1")).post({ agentId: "agent-1", content: SUCCESSOR, supersedes: "sup-race" });
    } finally {
      getSpy.mockRestore();
      putSpy.mockRestore();
      postSpy.mockRestore();
      errorSpy.mockRestore();
      (globalThis as any).transaction = savedTransaction;
    }
    expect(injected).toBe(true);
    expect(res instanceof Response).toBe(false);
    expect(memoryStore.has(res.id)).toBe(true);
    expect(memoryStore.get("sup-race").agentId).toBe("agent-other"); // assertion: the competing owner change is not overwritten
    expect(memoryStore.get("sup-race").validTo).toBeUndefined();
  });

  for (const [name, setup, status, error] of [
    ["a missing target", () => {}, 409, "supersedes_target_missing"],
    ["an unreadable target", () => memoryStore.set("sup-target", { id: "sup-target", agentId: "agent-1", content: "Target row, long enough for the gate." }), 503, "supersedes_target_unreadable"],
  ] as const) {
    it(`a write refused for ${name} leaves its derivedFrom source rows unchanged`, async () => {
      const source = { id: "src-1", agentId: "agent-1", content: "Source row the new one derives from, long enough." };
      memoryStore.set("src-1", { ...source });
      setup();
      // The first read of the target (the skill-body predecessor read) succeeds;
      // the authorization read after it fails.
      const realGet = BaseMemory.get;
      let targetReads = 0;
      const getSpy = spyOn(BaseMemory, "get").mockImplementation(async (id: any) => {
        if (id === "sup-target" && ++targetReads >= 2) throw new Error("simulated read failure");
        return realGet(id);
      });
      let res: any;
      try {
        res = await makeMemory(agentCtx("agent-1")).post({
          agentId: "agent-1", content: SUCCESSOR, derivedFrom: ["src-1"],
          supersedes: name === "a missing target" ? "sup-nowhere" : "sup-target",
        });
        await new Promise((r) => setTimeout(r, 10)); // let any unawaited bookkeeping land
      } finally {
        getSpy.mockRestore();
      }
      expect(res instanceof Response).toBe(true);
      expect((res as Response).status).toBe(status);
      expect((await (res as Response).json()).error).toBe(error);
      expect(memoryStore.get("src-1")).toEqual(source); // assertion: the source row is unchanged (no lastReflected)
    });
  }

  it("an accepted write with derivedFrom stamps lastReflected on its source rows", async () => {
    memoryStore.set("src-1", { id: "src-1", agentId: "agent-1", content: "Source row the new one derives from, long enough." });
    memoryStore.set("sup-ok", { id: "sup-ok", agentId: "agent-1", content: "Own row, long enough for the gate." });
    const res: any = await makeMemory(agentCtx("agent-1")).post({ agentId: "agent-1", content: SUCCESSOR, derivedFrom: ["src-1"], supersedes: "sup-ok" });
    expect(res instanceof Response).toBe(false);
    expect(memoryStore.get("src-1").lastReflected).toBe(memoryStore.get(res.id).updatedAt);
    expect(memoryStore.get("sup-ok").validTo).toBeDefined();
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
// also `mock.module("harper", ...)` + dynamically imports
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

  it("verified non-admin get() of ANOTHER agent's PRIVATE id → 404 (not 403 — no existence confirmation)", async () => {
    // within-org-read-open: a no-visibility-field or "shared" record from
    // another agent is now readable by design (see the describe block below)
    // — `private` is the ONLY remaining owner-only exception, so this test
    // must set it explicitly to still exercise the denial path.
    memoryStore.set("mem-1", { id: "mem-1", agentId: "agent-owner", content: "secret", visibility: "private" });
    const m = makeMemory(agentCtx("agent-attacker"));
    const res = await (m as any).get("mem-1");
    expect(res instanceof Response).toBe(true);
    expect((res as Response).status).toBe(404);
  });

  it("within-org-read-open: verified non-admin get() of ANOTHER agent's NON-private record now succeeds (no grant needed)", async () => {
    memoryStore.set("mem-1", { id: "mem-1", agentId: "agent-owner", content: "org-open content" }); // no visibility field
    const m = makeMemory(agentCtx("agent-stranger"));
    const res = await (m as any).get("mem-1");
    expect(res instanceof Response).toBe(false);
    expect((res as any).content).toBe("org-open content");
  });

  it("verified non-admin get() of ITS OWN id → returns the real record", async () => {
    memoryStore.set("mem-1", { id: "mem-1", agentId: "agent-owner", content: "my content" });
    const m = makeMemory(agentCtx("agent-owner"));
    const res = await (m as any).get("mem-1");
    expect(res instanceof Response).toBe(false);
    expect((res as any).content).toBe("my content");
  });

  it("non-admin get() of a non-private owner's id → returns the record (a held grant is no longer required, but still doesn't hurt)", async () => {
    memoryStore.set("mem-1", { id: "mem-1", agentId: "agent-owner", content: "shared content" });
    memoryGrants.push({ granteeId: "agent-grantee", ownerId: "agent-owner", scope: "read" });
    const m = makeMemory(agentCtx("agent-grantee"));
    const res = await (m as any).get("mem-1");
    expect(res instanceof Response).toBe(false);
    expect((res as any).content).toBe("shared content");
  });

  it("non-admin get() of a non-private owner's id (a search-scoped grant present too) → returns the record", async () => {
    memoryStore.set("mem-1", { id: "mem-1", agentId: "agent-owner", content: "shared via search scope" });
    memoryGrants.push({ granteeId: "agent-grantee", ownerId: "agent-owner", scope: "search" });
    const m = makeMemory(agentCtx("agent-grantee"));
    const res = await (m as any).get("mem-1");
    expect(res instanceof Response).toBe(false);
    expect((res as any).content).toBe("shared via search scope");
  });

  it("grants no longer factor into reads at all — even a WRITE-scoped grant does not unlock another agent's PRIVATE record → still 404", async () => {
    memoryStore.set("mem-1", { id: "mem-1", agentId: "agent-owner", content: "secret", visibility: "private" });
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

// ─── Shift the isCollection routing class left to the unit layer ───────────
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

describe("Memory.get() — RequestTarget routing, isCollection branch", () => {
  it("collection/query target (isCollection: true) delegates to search() and returns the reader's open read-scope — not a 404, not a single-record mis-route (the exact regression)", async () => {
    memoryStore.set("mem-own", { id: "mem-own", agentId: "agent-1", content: "mine" });
    memoryStore.set("mem-other", { id: "mem-other", agentId: "agent-other", content: "not mine, but org-open" }); // no visibility field
    memoryStore.set("mem-other-private", { id: "mem-other-private", agentId: "agent-other", content: "not mine, private", visibility: "private" });
    const m = makeMemory(agentCtx("agent-1"));
    const target = requestTarget({ search: "?agentId=agent-1", isCollection: true });
    const res: any = await (m as any).get(target);

    // THE regression: if the isCollection branch is lost, this falls through
    // to super.get(target) — a result-set has no `.agentId`, so the ownership
    // check 404s a perfectly valid authenticated self-query.
    expect(res instanceof Response).toBe(false);

    const results: any[] = [];
    for await (const r of res) results.push(r);
    // within-org-read-open: own record AND another agent's non-private
    // record both come back — only the other agent's PRIVATE record is
    // excluded (proves routing AND scoping compose correctly).
    expect(results.map((r) => r.id).sort()).toEqual(["mem-other", "mem-own"]);
  });

  it("by-id target (isCollection: false, id set) — own id returns the record", async () => {
    memoryStore.set("mem-1", { id: "mem-1", agentId: "agent-owner", content: "my content" });
    const m = makeMemory(agentCtx("agent-owner"));
    const target = requestTarget({ pathname: "/Memory/mem-1", id: "mem-1", isCollection: false });
    const res = await (m as any).get(target);
    expect(res instanceof Response).toBe(false);
    expect((res as any).content).toBe("my content");
  });

  it("by-id target — another agent's PRIVATE id → 404 (never 403 — no existence oracle)", async () => {
    memoryStore.set("mem-1", { id: "mem-1", agentId: "agent-owner", content: "secret", visibility: "private" });
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

describe("Memory.search() — within-org-read-open parity with get()", () => {
  it("non-admin search sees own records + every other agent's non-private records — a grant is no longer required", async () => {
    memoryStore.set("mem-own", { id: "mem-own", agentId: "agent-1", content: "mine" });
    memoryStore.set("mem-granted", { id: "mem-granted", agentId: "agent-owner", content: "shared" });
    memoryStore.set("mem-other", { id: "mem-other", agentId: "agent-other", content: "not mine, but org-open" }); // no visibility field
    memoryStore.set("mem-other-private", { id: "mem-other-private", agentId: "agent-other", content: "not mine, private", visibility: "private" });
    memoryGrants.push({ granteeId: "agent-1", ownerId: "agent-owner", scope: "read" });

    const m = makeMemory(agentCtx("agent-1"));
    const results: any[] = [];
    for await (const r of await (m as any).search({ conditions: [] })) results.push(r);
    const ids = results.map((r) => r.id).sort();
    // mem-granted and mem-other are both visible now regardless of the
    // grant (org-open) — only mem-other-private (explicitly private) is
    // excluded.
    expect(ids).toEqual(["mem-granted", "mem-other", "mem-own"]);
  });
});

// ─── Private/shared visibility + centralized read-scoping ──────────────────
//
// Security boundary tests. resources/memory-read-scope.ts's resolveReadScope()
// is the ONE centralized helper Memory.search()/Memory.get() (this file),
// SemanticSearch.ts, MemoryBootstrap.ts, and auth-middleware.ts's by-id guard
// all resolve their scope through — see that module's doc for the full
// rationale (closes the office-visibility read leak, the SemanticSearch
// office-OR global leak).
// scopeAllowedOwners/resolveReadScope are imported dynamically near the top
// of this file (after mock.module) alongside Memory/dedup/bm25.

describe("durability-keyed default visibility (write path)", () => {
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

  it("Memory.post: an explicit visibility overrides the durability default — EXCEPT ephemeral, which is private-only (flair#1257)", async () => {
    // Narrowing override on a durable tier: permanent defaults to shared,
    // explicit private wins.
    const m = makeMemory(agentCtx("agent-1"));
    const r = await m.post({ agentId: "agent-1", content: "Explicitly private despite being permanent.", durability: "permanent", visibility: "private" });
    expect((await BaseMemory.get(r.id)).visibility).toBe("private");

    // Widening override on a non-ephemeral tier: standard defaults to private,
    // explicit shared wins. (This carries the claim the ephemeral+shared case
    // below used to carry, on a tier where widening is still legal.)
    const m3 = makeMemory(agentCtx("agent-1"));
    const r3 = await m3.post({ agentId: "agent-1", content: "Explicitly shared while standard, long enough for the gate.", durability: "standard", visibility: "shared" });
    expect((await BaseMemory.get(r3.id)).visibility).toBe("shared");

    // ...but ephemeral+shared is REFUSED with 400 (flair#1257 hard
    // precondition, K&S-ratified): ephemeral is the continuity-journal tier
    // and is private-only — the pre-#1257 contract this test used to encode
    // ("an explicit visibility ALWAYS overrides") deliberately no longer
    // holds for it. Positive control: the refusal names the guard's error
    // code and writes nothing.
    const sizeBefore = memoryStore.size;
    const m2 = makeMemory(agentCtx("agent-1"));
    const r2 = await m2.post({ agentId: "agent-1", content: "Explicitly shared despite being ephemeral.", durability: "ephemeral", visibility: "shared" });
    expect(r2 instanceof Response).toBe(true);
    expect((r2 as Response).status).toBe(400);
    expect((await (r2 as Response).json()).error).toBe("invalid_visibility_for_durability");
    expect(memoryStore.size).toBe(sizeBefore); // the refusal stored nothing
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

// ─── The write RESPONSE names the visibility the row landed on (flair#991) ───
//
// Every test above asserts the stamped default by re-reading the row out of
// the store. A caller cannot do that: it gets only the write response, and
// that response used to be `{ id, written, deduplicated }` — no visibility
// field anywhere. So the one property of a memory that is decided by a rule
// the writer never typed was also the one property the writer could not
// observe. `flair memory add` printed that response verbatim (docs/
// quickstart.md's step 4 output block is a literal copy of it), the native
// /mcp memory_store returned it unchanged, and packages/flair-mcp read
// `result.visibility` to print an "effective visibility" line — reading a
// field that was never there, so it always rendered "(server default)".
describe("write response reports the landed visibility (flair#991)", () => {
  it("Memory.post: a bare standard write reports visibility: private in the RESPONSE, not just in the stored row", async () => {
    const m = makeMemory(agentCtx("agent-1"));
    const r = await m.post({ agentId: "agent-1", content: "A bare write with no visibility argument at all." });
    expect(r.visibility).toBe("private");
    // and it agrees with what was actually persisted
    expect((await BaseMemory.get(r.id)).visibility).toBe("private");
  });

  it("Memory.post: a persistent write reports visibility: shared in the RESPONSE", async () => {
    const m = makeMemory(agentCtx("agent-1"));
    const r = await m.post({ agentId: "agent-1", content: "A durable lesson, long enough for the gate.", durability: "persistent" });
    expect(r.visibility).toBe("shared");
    expect((await BaseMemory.get(r.id)).visibility).toBe("shared");
  });

  it("Memory.post: an explicit visibility is echoed back, so the caller can confirm the override took", async () => {
    const m = makeMemory(agentCtx("agent-1"));
    const r = await m.post({ agentId: "agent-1", content: "Explicitly private despite the durability.", durability: "permanent", visibility: "private" });
    expect(r.visibility).toBe("private");
  });

  it("Memory.put (fresh id): the response reports the stamped default too", async () => {
    const m = makeMemory(agentCtx("agent-1"));
    const r = await m.put({ id: "agent-1-response-visibility", agentId: "agent-1", content: "Fresh PUT create, long enough for the gate.", durability: "permanent" });
    expect(r.visibility).toBe("shared");
  });

  it("the base write-response fields are unchanged — visibility is additive, never a replacement", async () => {
    const m = makeMemory(agentCtx("agent-1"));
    const r = await m.post({ agentId: "agent-1", content: "Base response shape must not regress." });
    expect(r.id).toBeTruthy();
    expect(r.written).toBe(true);
    expect(r.deduplicated).toBe(false);
  });

  it("a pre-migration record patched through put() reports NO visibility key rather than null", async () => {
    // Absent means "non-private" to isPrivateVisibility(); reporting `null`
    // here would read to a caller as "owner-only", the exact inversion of
    // what the migration invariant guarantees. Omit the key instead.
    memoryStore.set("legacy-resp", { id: "legacy-resp", agentId: "agent-1", content: "Pre-migration content." });
    const existing = await BaseMemory.get("legacy-resp");
    const m = makeMemory(agentCtx("agent-1"));
    const r = await m.put({ ...existing, content: "Patched pre-migration content.", updatedAt: new Date().toISOString() });
    expect(r).not.toHaveProperty("visibility");
  });
});

describe("within-org-read-open — migration-equivalence (no-visibility-field memories)", () => {
  it("Memory.search: any reader sees a no-visibility-field owner record (absent reads as non-private, org-open) — no grant needed", async () => {
    memoryStore.set("legacy-owned", { id: "legacy-owned", agentId: "agent-owner", content: "pre-migration finding" }); // no visibility field at all
    // Deliberately NO grant pushed — proving the grant is no longer what
    // makes this visible.
    const m = makeMemory(agentCtx("agent-stranger"));
    const results: any[] = [];
    for await (const r of await (m as any).search({ conditions: [] })) results.push(r);
    expect(results.map((r) => r.id)).toEqual(["legacy-owned"]);
  });

  it("Memory.get: any reader can get() a no-visibility-field owner record by id (absent reads as non-private) — no grant needed", async () => {
    memoryStore.set("legacy-1", { id: "legacy-1", agentId: "agent-owner", content: "pre-migration finding" });
    const m = makeMemory(agentCtx("agent-stranger"));
    const res = await (m as any).get("legacy-1");
    expect(res instanceof Response).toBe(false);
    expect((res as any).content).toBe("pre-migration finding");
  });

  it("a no-visibility-field record is visible even to a total stranger with NO grant at all (the intended, documented broadening — see resources/memory-read-scope.ts's doc)", async () => {
    memoryStore.set("legacy-ungranted", { id: "legacy-ungranted", agentId: "agent-owner", content: "pre-migration finding" });
    // No grant pushed at all.
    const m = makeMemory(agentCtx("agent-stranger"));
    const res = await (m as any).get("legacy-ungranted");
    expect(res instanceof Response).toBe(false);
    expect((res as any).content).toBe("pre-migration finding");
  });
});

describe("within-org-read-open — private-exclusion invariant (the ONE remaining boundary)", () => {
  it("Memory.search: an owner's PRIVATE memory is never returned to another agent, grant or not", async () => {
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

  it("Memory.get: an owner's PRIVATE memory 404s for any other agent (non-enumerating — same shape whether or not a grant is held)", async () => {
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

  it("a total stranger with NO grant at all NOW sees a SHARED memory (the intended, documented broadening — within-org-read-open)", async () => {
    memoryStore.set("mem-shared", { id: "mem-shared", agentId: "agent-owner", content: "shared finding", visibility: "shared" });
    const m = makeMemory(agentCtx("agent-stranger"));
    const res = await (m as any).get("mem-shared");
    expect(res instanceof Response).toBe(false);
    expect((res as any).content).toBe("shared finding");
  });
});

describe("within-org-read-open — resolveReadScope() condition shape + injection safety", () => {
  it("condition is ALWAYS (self) OR (visibility != 'private') — no grant lookup, no branching on held grants", async () => {
    const scope = await resolveReadScope("agent-1");
    expect(scope.condition).toEqual({
      operator: "or",
      conditions: [
        { attribute: "agentId", comparator: "equals", value: "agent-1" },
        { attribute: "visibility", comparator: "not_equal", value: "private" },
      ],
    });
  });

  it("allowedOwners is vestigial for reads now — always [authAgentId], regardless of any grants that exist", async () => {
    memoryGrants.push({ granteeId: "agent-1", ownerId: "agent-owner", scope: "read" });
    const scope = await resolveReadScope("agent-1");
    expect(scope.allowedOwners).toEqual(["agent-1"]);
  });

  it("resolveReadScope() does NOT query MemoryGrant at all — reads are open, the per-read grant lookup is gone", async () => {
    const grantSearchSpy = spyOn((databasesMock as any).flair.MemoryGrant, "search");
    await resolveReadScope("agent-1");
    expect(grantSearchSpy).not.toHaveBeenCalled();
    grantSearchSpy.mockRestore();
  });

  it("uses not_equal 'private' — NEVER equals 'shared' (the migration-invariant is baked into the condition itself)", async () => {
    const scope = await resolveReadScope("agent-1");
    const json = JSON.stringify(scope.condition);
    expect(json).toContain("not_equal");
    expect(json).not.toContain('"equals","value":"shared"');
  });

  it("isAllowed() agrees with the condition shape for every combination", async () => {
    const scope = await resolveReadScope("agent-1");
    expect(scope.isAllowed({ agentId: "agent-1", visibility: "private" })).toBe(true); // own private
    expect(scope.isAllowed({ agentId: "agent-owner", visibility: "shared" })).toBe(true); // non-owner + shared
    expect(scope.isAllowed({ agentId: "agent-owner" })).toBe(true); // non-owner + no field (migration invariant)
    expect(scope.isAllowed({ agentId: "agent-owner", visibility: "private" })).toBe(false); // non-owner + PRIVATE
    expect(scope.isAllowed({ agentId: "agent-stranger", visibility: "shared" })).toBe(true); // ANY non-owner + shared — org-open, no grant needed
    expect(scope.isAllowed(null)).toBe(false);
    expect(scope.isAllowed(undefined)).toBe(false);
  });

  it("injection: a reader cannot craft a search query to surface another agent's private record", async () => {
    memoryStore.set("mem-private", { id: "mem-private", agentId: "agent-owner", content: "private note", visibility: "private" });

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
    const m = makeMemory(agentCtx("agent-stranger"));
    const results: any[] = [];
    for await (const r of await (m as any).search(attackerQuery)) results.push(r);
    expect(results.map((r: any) => r.id)).not.toContain("mem-private");
  });

  it("resolveAllowedOwners() (the owner-set-only helper) is unchanged in shape — still self + granted owner ids; still exported for admin/listing tooling, just no longer consumed by resolveReadScope()", async () => {
    memoryGrants.push({ granteeId: "agent-1", ownerId: "agent-owner-a", scope: "read" });
    memoryGrants.push({ granteeId: "agent-1", ownerId: "agent-owner-b", scope: "search" });
    const owners = await scopeAllowedOwners("agent-1");
    expect(owners.sort()).toEqual(["agent-1", "agent-owner-a", "agent-owner-b"]);
  });
});

describe("Memory PUT/PATCH URL suffix refusal", () => {
  for (const method of ["put", "patch"]) {
    for (const existing of [true, false]) {
      it(`${method} refuses a parsed URL suffix with a clean body id (${existing ? "existing" : "missing"} row)`, async () => {
        const id = "url-suffix-target";
        const row = { id, agentId: "agent-owner", content: "keep" };
        if (existing) memoryStore.set(id, row);
        const m: any = makeMemory(agentCtx("agent-owner"));
        m._targetId = id;
        const res = await m[method]({ id, agentId: "agent-owner", content: "changed" }, {
          id, pathname: `/${id}.content`, property: "content",
        });
        expect(res).toBeInstanceOf(Response);
        expect(res.status).toBe(400);
        expect((await res.json()).error).toBe("memory_id_content_suffix");
        expect(memoryStore.get(id)).toEqual(existing ? row : undefined);
        expect(memoryStore.has(`${id}.content`)).toBe(false);
      });
    }
  }
});

describe("Memory.delete() — ownership check uses the raw record (super.get), not the new scoped get()", () => {
  it("refuses a parsed `.content` DELETE target before checking ownership", async () => {
    const ownershipRead = spyOn(BaseMemory.prototype, "get");
    try {
      for (const actor of ["agent-owner", "agent-attacker"]) {
        memoryStore.set("mem-1", { id: "mem-1", agentId: "agent-owner", content: "keep" });
        const m: any = makeMemory(agentCtx(actor));
        m._targetId = "mem-1";
        const res = await m.delete({ id: "mem-1", pathname: "/mem-1.content", property: "content" });
        expect(res.status).toBe(400);
        expect((await res.json()).error).toBe("memory_id_content_suffix");
        expect(ownershipRead).not.toHaveBeenCalled();
        expect(await BaseMemory.get("mem-1")).toEqual({ id: "mem-1", agentId: "agent-owner", content: "keep" });
      }
    } finally {
      ownershipRead.mockRestore();
    }
  });

  it("owner can still delete its own non-permanent memory", async () => {
    memoryStore.set("mem-1", { id: "mem-1", agentId: "agent-owner", durability: "standard" });
    const m = makeMemory(agentCtx("agent-owner"));
    await (m as any).delete("mem-1");
    expect(await BaseMemory.get("mem-1")).toBeNull();
  });

  it("a non-admin cannot delete another agent's permanent memory through the read-scoped get override", async () => {
    memoryStore.set("mem-1", { id: "mem-1", agentId: "agent-owner", durability: "permanent" });
    const m = makeMemory(agentCtx("agent-attacker"));
    const res = await (m as any).delete("mem-1");
    expect(res instanceof Response).toBe(true);
    expect((res as Response).status).toBe(403);
    expect(await BaseMemory.get("mem-1")).not.toBeNull(); // untouched
  });

  it("owners and admins can explicitly delete permanent memories", async () => {
    for (const actor of [agentCtx("agent-owner"), agentCtx("agent-admin", true)]) {
      memoryStore.set("mem-1", { id: "mem-1", agentId: "agent-owner", durability: "permanent" });
      await (makeMemory(actor) as any).delete("mem-1");
      expect(await BaseMemory.get("mem-1")).toBeNull();
    }
  });
});

// ─── memory-provenance slice 1: write-time provenance stamp ─────────────────
//
// Foundational capture for an emergent-trust model (see resources/Memory.ts's
// buildProvenance() doc). Deliberately minimal — verified fields only:
//   { v: 1, verified: { agentId, timestamp, receivedAt }, claimed?: { createdAt, model, client } }
//
// These tests live in THIS file (rather than a new one) for the same reason
// the within-org-read-open migration-equivalence block above does: bun runs every
// test/unit/ file in one process, and resources/Memory.ts's `class Memory
// extends (databases as any).flair.Memory` superclass reference is captured
// ONCE at whichever file's mock.module("harper", ...) + dynamic
// import wins first — a second file doing the same thing would silently
// collide instead of getting its own isolated Memory/mock pairing. This
// file's existing mock/import is reused instead.
describe("memory-provenance slice 1 — Memory.post() write-time stamp", () => {
  it("stamps valid, parseable JSON with v:1 and the authed agent's id", async () => {
    const m = makeMemory(agentCtx("agent-1"));
    const r = await m.post({ agentId: "agent-1", content: "A note long enough for the dedup gate to inspect." });
    const stored = await BaseMemory.get(r.id);
    expect(typeof stored.provenance).toBe("string");
    const prov = JSON.parse(stored.provenance);
    expect(prov.v).toBe(1);
    expect(prov.verified.agentId).toBe("agent-1");
    expect(typeof prov.verified.timestamp).toBe("string");
    // flair#1960: the SERVER write instant, shared with receivedAt — never the
    // caller's createdAt. That createdAt is the writer's claim: it stays on the
    // row AND is recorded under claimed.createdAt.
    expect(prov.verified.timestamp).toBe(prov.verified.receivedAt);
    expect(prov.claimed.createdAt).toBe(stored.createdAt);
  });

  it("omits claimed.model when the write payload has no model field", async () => {
    const m = makeMemory(agentCtx("agent-1"));
    const r = await m.post({ agentId: "agent-1", content: "No model field on this write at all." });
    const prov = JSON.parse((await BaseMemory.get(r.id)).provenance);
    expect(prov.claimed.model).toBeUndefined();
  });

  it("flair#1960: a caller-supplied past createdAt gets a SERVER-time verified.timestamp, keeps the claim on the row, and records it under claimed.createdAt", async () => {
    const before = Date.now();
    const past = "2001-01-01T00:00:00.000Z";
    const m = makeMemory(agentCtx("agent-1"));
    const r = await m.post({ agentId: "agent-1", content: "Backdated note, long enough for the dedup gate to inspect.", createdAt: past });
    const stored = await BaseMemory.get(r.id);
    const prov = JSON.parse(stored.provenance);
    expect(stored.createdAt).toBe(past); // the record keeps the caller's claim
    expect(prov.claimed.createdAt).toBe(past); // the claim is recorded, labelled claimed
    expect(prov.verified.timestamp).not.toBe(past); // verified is the server clock
    const stamped = Date.parse(prov.verified.timestamp);
    expect(Number.isFinite(stamped)).toBe(true);
    expect(stamped).toBeGreaterThanOrEqual(before - 5000);
    expect(stamped).toBeLessThanOrEqual(Date.now() + 5000);
  });

  it("includes claimed.model ONLY when the payload carries one — never invented", async () => {
    const m = makeMemory(agentCtx("agent-1"));
    const r = await m.post({ agentId: "agent-1", content: "This write claims a model, unverified.", model: "claude-opus-4-7" });
    const prov = JSON.parse((await BaseMemory.get(r.id)).provenance);
    expect(prov.claimed.model).toBe("claude-opus-4-7");
    // claimed.model is UNVERIFIED passthrough — verified.agentId is still the
    // authenticated identity, entirely independent of the claimed model.
    expect(prov.verified.agentId).toBe("agent-1");
  });

  it("an empty-string model is treated as absent (not a real claim)", async () => {
    const m = makeMemory(agentCtx("agent-1"));
    const r = await m.post({ agentId: "agent-1", content: "Empty-string model field on this write.", model: "" });
    const prov = JSON.parse((await BaseMemory.get(r.id)).provenance);
    expect(prov.claimed.model).toBeUndefined();
  });

  it("no authenticated agent (internal call) stamps verified.agentId: null — never throws", async () => {
    const r: any = new (Memory as any)();
    r.getContext = () => undefined; // no request at all → resolveAgentAuth() → { kind: "internal" }
    const result = await r.post({ agentId: "agent-1", content: "Internal in-process write, long enough for the gate." });
    expect(result.written).toBe(true);
    const stored = await BaseMemory.get(result.id);
    const prov = JSON.parse(stored.provenance);
    expect(prov.v).toBe(1);
    expect(prov.verified.agentId).toBeNull();
    expect(typeof prov.verified.timestamp).toBe("string");
  });
});

describe("memory-provenance slice 1 — Memory.put() stamps the identical shape (shared helper)", () => {
  it("a fresh PUT (not-yet-existing id) stamps provenance the same as post()", async () => {
    const m = makeMemory(agentCtx("agent-1"));
    const r = await m.put({ id: "agent-1-fresh-prov", agentId: "agent-1", content: "Fresh PUT create, long enough for the gate." });
    const stored = await BaseMemory.get(r.id);
    const prov = JSON.parse(stored.provenance);
    expect(prov.v).toBe(1);
    expect(prov.verified.agentId).toBe("agent-1");
    expect(typeof prov.verified.timestamp).toBe("string");
  });

  it("an update (same-id overwrite) re-stamps provenance reflecting the CURRENT authenticated actor", async () => {
    const owner = agentCtx("agent-1");
    const m = makeMemory(owner);
    const initial = await m.post({ agentId: "agent-1", content: "Original note, long enough for the gate." });

    const existing = await BaseMemory.get(initial.id);
    const merged = { ...existing, content: "Updated note, long enough for the gate.", updatedAt: new Date().toISOString() };
    delete (merged as any).embedding;
    delete (merged as any).embeddingModel;

    const mUpdate = makeMemory(owner);
    await mUpdate.put(merged);

    const after = await BaseMemory.get(initial.id);
    const prov = JSON.parse(after.provenance);
    expect(prov.v).toBe(1);
    expect(prov.verified.agentId).toBe("agent-1");
  });

  it("claimed.model passthrough on put() is gated identically to post()", async () => {
    const m = makeMemory(agentCtx("agent-1"));
    const r = await m.put({ id: "agent-1-put-model", agentId: "agent-1", content: "PUT with a claimed model field.", model: "gpt-5" });
    const prov = JSON.parse((await BaseMemory.get(r.id)).provenance);
    expect(prov.claimed.model).toBe("gpt-5");

    const m2 = makeMemory(agentCtx("agent-1"));
    const r2 = await m2.put({ id: "agent-1-put-no-model", agentId: "agent-1", content: "PUT with no claimed model field." });
    const prov2 = JSON.parse((await BaseMemory.get(r2.id)).provenance);
    expect(prov2.claimed.model).toBeUndefined();
  });

  it("flair#1960: put() with a caller-supplied past createdAt stamps a server-time verified.timestamp and records the claim", async () => {
    const before = Date.now();
    const past = "2001-01-01T00:00:00.000Z";
    const m = makeMemory(agentCtx("agent-1"));
    const r = await m.put({ id: "agent-1-backdated-put", agentId: "agent-1", content: "Backdated PUT, long enough for the gate.", createdAt: past });
    const stored = await BaseMemory.get(r.id);
    const prov = JSON.parse(stored.provenance);
    expect(stored.createdAt).toBe(past);
    expect(prov.claimed.createdAt).toBe(past);
    expect(prov.verified.timestamp).not.toBe(past);
    const stamped = Date.parse(prov.verified.timestamp);
    expect(stamped).toBeGreaterThanOrEqual(before - 5000);
    expect(stamped).toBeLessThanOrEqual(Date.now() + 5000);
  });

  it("no authenticated agent (internal call) via put() also stamps verified.agentId: null — never throws", async () => {
    const r: any = new (Memory as any)();
    r.getContext = () => undefined;
    const result = await r.put({ id: "internal-put-prov", agentId: "agent-1", content: "Internal in-process PUT, long enough for the gate." });
    expect(result.written).toBe(true);
    const prov = JSON.parse((await BaseMemory.get(result.id)).provenance);
    expect(prov.verified.agentId).toBeNull();
  });
});

describe("flair#1960 r2 — Memory.patch() re-stamps provenance on a semantic write", () => {
  it("a semantic PATCH on a backdated-legacy row re-stamps verified.* from the server clock (never carries the stored caller-chosen timestamp forward)", async () => {
    const before = Date.now();
    // A LEGACY row: provenance written before this release, whose
    // verified.timestamp came from the caller's createdAt at the time.
    memoryStore.set("prov-patch-legacy", {
      id: "prov-patch-legacy",
      agentId: "agent-1",
      content: "original body",
      durability: "standard",
      createdAt: "2001-01-01T00:00:00.000Z",
      provenance: JSON.stringify({ v: 1, verified: { agentId: "agent-1", timestamp: "2001-01-01T00:00:00.000Z" } }),
    });
    const m: any = makeMemory(agentCtx("agent-1"));
    m._targetId = "prov-patch-legacy";
    await m.patch({
      content: "a genuinely new body",
      // Forged verified fields in the body — must never land.
      provenance: JSON.stringify({ v: 1, verified: { agentId: "attacker", timestamp: "1999-01-01T00:00:00.000Z" } }),
    });
    const stored = memoryStore.get("prov-patch-legacy");
    expect(stored.content).toBe("a genuinely new body"); // control: the patch landed
    const prov = JSON.parse(stored.provenance);
    expect(prov.verified.agentId).toBe("agent-1"); // forged agentId did not land
    expect(prov.verified.timestamp).not.toBe("2001-01-01T00:00:00.000Z"); // not the legacy stored value
    expect(prov.verified.timestamp).not.toBe("1999-01-01T00:00:00.000Z"); // not the forged body value
    const stamped = Date.parse(prov.verified.timestamp);
    expect(stamped).toBeGreaterThanOrEqual(before - 5000);
    expect(stamped).toBeLessThanOrEqual(Date.now() + 5000);
    expect(prov.verified.timestamp).toBe(prov.verified.receivedAt);
    expect(prov.claimed.createdAt).toBe("2001-01-01T00:00:00.000Z"); // the record's own creation claim, recorded under claimed
  });

  it("a metadata-only PATCH (no semantic field change) strips a forged provenance but keeps the stored blob", async () => {
    const legacy = JSON.stringify({ v: 1, verified: { agentId: "agent-1", timestamp: "2001-01-01T00:00:00.000Z" } });
    memoryStore.set("prov-patch-meta", {
      id: "prov-patch-meta", agentId: "agent-1", content: "unchanged body", durability: "standard", provenance: legacy,
    });
    const m: any = makeMemory(agentCtx("agent-1"));
    m._targetId = "prov-patch-meta";
    await m.patch({ tags: ["tagged"], provenance: JSON.stringify({ v: 1, verified: { agentId: "attacker", timestamp: "1999-01-01T00:00:00.000Z" } }) });
    const stored = memoryStore.get("prov-patch-meta");
    expect(stored.tags).toEqual(["tagged"]); // control: the patch landed
    expect(stored.content).toBe("unchanged body");
    expect(stored.provenance).toBe(legacy); // no new content authored ⇒ stored blob preserved, forged value never landed
  });
});

describe("flair#1960 r3 — Memory.patch() refuses a PATCH when the stored-row READ fails", () => {
  // The pre-fix control coalesced a thrown stored-row read into `null`
  // (`.catch(() => null)`); `isSemanticPatch` returns false for `null`, so the
  // patch fell through to `super.patch()` as a METADATA-ONLY write and kept the
  // legacy stored blob. A read ERROR is not "no stored row" — the PATCH must be
  // refused, never degraded to a blob-preserving decision.
  it("a stored-row read ERROR refuses the PATCH (500) and never delegates to the by-id store write (super.patch)", async () => {
    const legacy = JSON.stringify({ v: 1, verified: { agentId: "agent-1", timestamp: "2001-01-01T00:00:00.000Z" } });
    memoryStore.set("prov-patch-readfail", {
      id: "prov-patch-readfail",
      agentId: "agent-1",
      content: "original body",
      durability: "standard",
      provenance: legacy,
    });
    const m: any = makeMemory(agentCtx("agent-1"));
    m._targetId = "prov-patch-readfail";
    // r4/merge: the semantic-PATCH decision and the originatorInstanceId
    // create/update decision share ONE stored-row read — the #1965
    // resolveStoredRow, which reads through the URL-bound target id via the
    // table reader (BaseMemory.get). Make THAT read fail: the write must be
    // refused, never degraded to a metadata-only blob-preserving decision.
    const getSpy = spyOn(BaseMemory, "get").mockImplementation(async () => {
      throw new Error("simulated stored-row read failure");
    });
    let superPatchCalls = 0;
    const realPatch = BaseMemory.prototype.patch;
    const patchSpy = spyOn(BaseMemory.prototype, "patch").mockImplementation(function (this: any, content: any) {
      superPatchCalls += 1;
      return realPatch.call(this, content);
    });
    try {
      const res = await m.patch({ content: "a genuinely new body" });
      expect(superPatchCalls).toBe(0); // never delegated to the blob-preserving by-id store write
      expect(res instanceof Response).toBe(true);
      expect((res as Response).status).toBe(500);
      await expect((res as Response).json()).resolves.toMatchObject({ error: "stored_row_lookup_failed" });
      expect(memoryStore.get("prov-patch-readfail").content).toBe("original body"); // nothing landed
      expect(memoryStore.get("prov-patch-readfail").provenance).toBe(legacy);
    } finally {
      getSpy.mockRestore();
      patchSpy.mockRestore();
    }
  });
});

describe("flair#1960 r4 — createdAt is SEMANTIC (a changed creation claim re-stamps provenance)", () => {
  it("a createdAt-only PATCH re-stamps provenance and claimed.createdAt follows the new row createdAt", async () => {
    const before = Date.now();
    memoryStore.set("prov-patch-createdat", {
      id: "prov-patch-createdat",
      agentId: "agent-1",
      content: "body",
      durability: "standard",
      createdAt: "2001-01-01T00:00:00.000Z",
      provenance: JSON.stringify({
        v: 1,
        verified: { agentId: "agent-1", timestamp: "2001-01-01T00:00:00.000Z", receivedAt: "2001-01-01T00:00:00.000Z" },
        claimed: { createdAt: "2001-01-01T00:00:00.000Z" },
      }),
    });
    const m: any = makeMemory(agentCtx("agent-1"));
    m._targetId = "prov-patch-createdat";
    // A createdAt-ONLY patch: no content change. Before r4 this returned false
    // from isSemanticPatch, so the row's createdAt moved while the stored
    // claimed.createdAt kept the old value.
    await m.patch({ createdAt: "2002-02-02T03:04:05.678Z" });
    const stored = memoryStore.get("prov-patch-createdat");
    expect(stored.createdAt).toBe("2002-02-02T03:04:05.678Z"); // control: the patch landed
    const prov = JSON.parse(stored.provenance);
    // Provenance is RE-STAMPED from the server clock, not carried forward...
    const stamped = Date.parse(prov.verified.timestamp);
    expect(stamped).toBeGreaterThanOrEqual(before - 5000);
    expect(stamped).toBeLessThanOrEqual(Date.now() + 5000);
    expect(prov.verified.timestamp).toBe(prov.verified.receivedAt);
    expect(prov.verified.timestamp).not.toBe("2001-01-01T00:00:00.000Z"); // stale stored stamp not carried forward
    // ...and the claim follows the row: claimed.createdAt is the new row createdAt (sanitized).
    expect(prov.claimed.createdAt).toBe("2002-02-02T03:04:05.678Z");
    expect(prov.claimed.createdAt).toBe(stored.createdAt);
  });

  it("a createdAt-only PATCH whose value needs sanitizing records the sanitized claim, matching the new row createdAt sanitized", async () => {
    memoryStore.set("prov-patch-createdat-san", {
      id: "prov-patch-createdat-san",
      agentId: "agent-1",
      content: "body",
      durability: "standard",
      createdAt: "2001-01-01T00:00:00.000Z",
    });
    const m: any = makeMemory(agentCtx("agent-1"));
    m._targetId = "prov-patch-createdat-san";
    const RAW = "  2002-02-02T03:04:05.678Z\n";
    await m.patch({ createdAt: RAW });
    const stored = memoryStore.get("prov-patch-createdat-san");
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
    memoryStore.set("prov-patch-meta-r4", {
      id: "prov-patch-meta-r4", agentId: "agent-1", content: "unchanged body", durability: "standard",
      createdAt: "2001-01-01T00:00:00.000Z", provenance: legacy,
    });
    const m: any = makeMemory(agentCtx("agent-1"));
    m._targetId = "prov-patch-meta-r4";
    await m.patch({ tags: ["tagged"] });
    const stored = memoryStore.get("prov-patch-meta-r4");
    expect(stored.tags).toEqual(["tagged"]); // control: the patch landed
    expect(stored.provenance).toBe(legacy); // no semantic change ⇒ stored blob preserved
    expect(JSON.parse(stored.provenance).claimed.createdAt).toBe("2001-01-01T00:00:00.000Z");
  });
});

describe("memory-provenance slice 1 — migration-equivalence (no-provenance-field memories)", () => {
  it("an existing/old row with no provenance field reads back fine — provenance is purely additive, not required for reads", async () => {
    memoryStore.set("legacy-no-prov", { id: "legacy-no-prov", agentId: "agent-owner", content: "pre-migration content, no provenance field at all." });
    const m = makeMemory(agentCtx("agent-owner"));
    const res = await (m as any).get("legacy-no-prov");
    expect(res instanceof Response).toBe(false);
    expect((res as any).content).toBe("pre-migration content, no provenance field at all.");
    expect((res as any).provenance).toBeUndefined();
  });

  it("search() over a mix of legacy (no provenance) and new (stamped) records returns both, unaffected by the new field", async () => {
    memoryStore.set("legacy-no-prov", { id: "legacy-no-prov", agentId: "agent-1", content: "legacy record, no provenance" });
    const m = makeMemory(agentCtx("agent-1"));
    await m.post({ agentId: "agent-1", content: "new record, gets provenance stamped, long enough for the gate." });

    const results: any[] = [];
    for await (const r of await (m as any).search({ conditions: [] })) results.push(r);
    const ids = results.map((r) => r.id).sort();
    expect(ids).toContain("legacy-no-prov");
    expect(results.length).toBe(2);
  });

  it("updating a legacy (no-provenance) record via put() adds provenance additively without disturbing any other field", async () => {
    memoryStore.set("legacy-2", { id: "legacy-2", agentId: "agent-1", content: "legacy content", durability: "standard", archived: false });
    const existing = await BaseMemory.get("legacy-2");
    expect(existing.provenance).toBeUndefined();

    const merged = { ...existing, content: "patched legacy content", updatedAt: new Date().toISOString() };
    const m = makeMemory(agentCtx("agent-1"));
    await m.put(merged);

    const after = await BaseMemory.get("legacy-2");
    expect(after.content).toBe("patched legacy content"); // untouched aside from the intended patch
    expect(typeof after.provenance).toBe("string"); // additively gains provenance on this write
    const prov = JSON.parse(after.provenance);
    expect(prov.v).toBe(1);
  });
});

// ─── federation-edge-hardening slice 1 / flair#1965: originatorInstanceId stamp ──
//
// originatorInstanceId names the federation instance that AUTHORED a record and
// is server-stamped — never client-writable (schemas/memory.graphql). The rule
// (resources/originator-instance.ts): a CREATE stamps the local instance id and
// IGNORES any request-body value; an UPDATE keeps the STORED value — a body value
// neither replaces nor clears it, and an update that omits the field leaves it.
// Distinct from the legacy `_originatorInstanceId` (Federation.ts's mergeRecord —
// receiver-stamped at merge time), which the federation merge writes. These tests
// live in THIS file for the same mock+import-collision reason as the
// memory-provenance slice 1 block above (this file already owns the Memory
// mock+import).
describe("federation-edge-hardening slice 1 / flair#1965 — Memory.post() stamps a server-set originatorInstanceId", () => {
  it("stamps the local instance id on a fresh local write", async () => {
    instanceRow = { id: "flair_local_test" };
    const m = makeMemory(agentCtx("agent-1"));
    const r = await m.post({ agentId: "agent-1", content: "A note long enough for the dedup gate to inspect." });
    const stored = await BaseMemory.get(r.id);
    expect(stored.originatorInstanceId).toBe("flair_local_test");
  });

  it("stamps null when this instance has no Instance row yet (never federation-bootstrapped) — never invents one", async () => {
    instanceRow = null;
    const m = makeMemory(agentCtx("agent-1"));
    const r = await m.post({ agentId: "agent-1", content: "Written before this instance ever paired." });
    const stored = await BaseMemory.get(r.id);
    expect(stored.originatorInstanceId).toBeNull();
  });

  it("IGNORES a request-body originatorInstanceId and stamps the local id — a client can never set it on create", async () => {
    // The body claims instance B as its origin; the server-stamped contract
    // means the claim is discarded and THIS instance's id is stamped.
    instanceRow = { id: "flair_local_test" };
    const m = makeMemory(agentCtx("agent-1"));
    const r = await m.post({
      agentId: "agent-1",
      content: "This body claims instance B as its origin, long enough for the gate.",
      originatorInstanceId: "instance-B",
    });
    const stored = await BaseMemory.get(r.id);
    expect(stored.originatorInstanceId).toBe("flair_local_test");
    expect(stored.originatorInstanceId).not.toBe("instance-B");
  });

  it("flair#1896 — with SEVERAL Instance rows the write SUCCEEDS and stamps NOTHING (never an arbitrary identity)", async () => {
    // Several rows is a state doctor reports and init refuses to create; the
    // write path must not fail on it (a throw would lose every local write on
    // a legacy install) and must not pick a row (stamping one attributes the
    // record to an identity peers may not have pinned). A null
    // originatorInstanceId is the defined local-origin state.
    instanceRow = { id: "flair_row_a" };
    extraInstanceRows = [{ id: "flair_row_b" }];
    const errSpy = spyOn(console, "error"); // the one-per-process refusal line
    const m = makeMemory(agentCtx("agent-1"));
    const r = await m.post({ agentId: "agent-1", content: "Written while this instance's table holds two rows." });
    expect(r instanceof Response).toBe(false);
    const stored = await BaseMemory.get(r.id);
    expect(stored.originatorInstanceId).toBeNull();
    expect(stored.originatorInstanceId).not.toBe("flair_row_a");
    expect(stored.originatorInstanceId).not.toBe("flair_row_b");
    errSpy.mockRestore();
  });
});

describe("federation-edge-hardening slice 1 / flair#1965 — Memory.put() create vs update", () => {
  it("CREATE (PUT, not-yet-existing id) stamps the local instance id and ignores a body value", async () => {
    instanceRow = { id: "flair_local_test" };
    const m = makeMemory(agentCtx("agent-1"));
    const r = await m.put({
      id: "agent-1-fresh-origin",
      agentId: "agent-1",
      content: "Fresh PUT create claiming instance B, long enough for the gate.",
      originatorInstanceId: "instance-B",
    });
    const stored = await BaseMemory.get(r.id);
    expect(stored.originatorInstanceId).toBe("flair_local_test");
    expect(stored.originatorInstanceId).not.toBe("instance-B");
  });

  it("UPDATE (PUT) with a body value LEAVES the stored value — a client cannot change or clear it", async () => {
    instanceRow = { id: "flair_local_test" };
    memoryStore.set("agent-1-synced-origin", {
      id: "agent-1-synced-origin",
      agentId: "agent-1",
      content: "authored on instance B",
      originatorInstanceId: "instance-B",
    });
    const m = makeMemory(agentCtx("agent-1"));
    await m.put({
      id: "agent-1-synced-origin",
      agentId: "agent-1",
      content: "Edited locally after sync, long enough for the gate.",
      originatorInstanceId: "instance-attacker",
    });
    const after = await BaseMemory.get("agent-1-synced-origin");
    expect(after.originatorInstanceId).toBe("instance-B");
    expect(after.originatorInstanceId).not.toBe("instance-attacker");
    expect(after.content).toBe("Edited locally after sync, long enough for the gate.");
  });

  it("UPDATE (PUT) that OMITS the field leaves the stored value", async () => {
    instanceRow = { id: "flair_local_test" };
    memoryStore.set("agent-1-synced-origin2", {
      id: "agent-1-synced-origin2",
      agentId: "agent-1",
      content: "authored on instance B",
      originatorInstanceId: "instance-B",
    });
    const m = makeMemory(agentCtx("agent-1"));
    await m.put({
      id: "agent-1-synced-origin2",
      agentId: "agent-1",
      content: "Edited locally after sync, long enough for the gate.",
    });
    const after = await BaseMemory.get("agent-1-synced-origin2");
    expect(after.originatorInstanceId).toBe("instance-B");
  });

  it("PATCH cannot set or clear originatorInstanceId — the stored value stands", async () => {
    instanceRow = { id: "flair_local_test" };
    memoryStore.set("memory-patch", {
      id: "memory-patch",
      agentId: "agent-1",
      content: "authored on instance B",
      durability: "standard",
      originatorInstanceId: "instance-B",
    });
    const m: any = makeMemory(agentCtx("agent-1"));
    m._targetId = "memory-patch";
    await m.patch({ originatorInstanceId: "instance-attacker" });
    expect(memoryStore.get("memory-patch").originatorInstanceId).toBe("instance-B");
  });

  it("no authenticated agent (internal call) via put() still stamps the local instance id on a CREATE — never throws", async () => {
    instanceRow = { id: "flair_local_test" };
    const r: any = new (Memory as any)();
    r.getContext = () => undefined;
    const result = await r.put({ id: "internal-put-origin", agentId: "agent-1", content: "Internal in-process PUT, long enough for the gate." });
    expect(result.written).toBe(true);
    const stored = await BaseMemory.get(result.id);
    expect(stored.originatorInstanceId).toBe("flair_local_test");
  });
});

describe("flair#1965 r3 — Memory stored-row resolution is fail-closed and URL-bound", () => {
  it("a FAILED stored-row read refuses a PATCH (500) — never read as 'no row' and stamped as a create", async () => {
    instanceRow = { id: "flair_local_test" };
    memoryStore.set("mem-r3-readfail", { id: "mem-r3-readfail", agentId: "agent-1", content: "authored on B", durability: "standard", originatorInstanceId: "instance-B" });
    const m: any = makeMemory(agentCtx("agent-1"));
    m._targetId = "mem-r3-readfail";
    const spy = spyOn(BaseMemory, "get").mockImplementation(async () => { throw new Error("simulated stored-row read failure"); });
    try {
      const res: any = await m.patch({ content: "an edit, long enough for the gate" });
      expect(res instanceof Response).toBe(true);
      expect((res as Response).status).toBe(500);
      expect((await (res as Response).json()).error).toBe("stored_row_lookup_failed");
      const stored = memoryStore.get("mem-r3-readfail");
      expect(stored.content).toBe("authored on B"); // nothing written
      expect(stored.originatorInstanceId).toBe("instance-B"); // never re-stamped
    } finally {
      spy.mockRestore();
    }
  });

  it("a PATCH whose body id disagrees with the URL target is refused (400)", async () => {
    instanceRow = { id: "flair_local_test" };
    memoryStore.set("mem-r3-real", { id: "mem-r3-real", agentId: "agent-1", content: "real", durability: "standard", originatorInstanceId: "instance-B" });
    const m: any = makeMemory(agentCtx("agent-1"));
    m._targetId = "mem-r3-real";
    const res: any = await m.patch({ id: "mem-r3-decoy", content: "decoy, long enough for the gate" });
    expect(res instanceof Response).toBe(true);
    expect((res as Response).status).toBe(400);
    expect((await (res as Response).json()).error).toBe("id_target_mismatch");
    expect(memoryStore.get("mem-r3-decoy")).toBeUndefined();
    expect(memoryStore.get("mem-r3-real").content).toBe("real");
  });

  it("the _reindex re-PUT refuses a FAILED stored-row read (500) and a missing row (404)", async () => {
    instanceRow = { id: "flair_local_test" };
    memoryStore.set("mem-r3-reindex", { id: "mem-r3-reindex", agentId: "agent-1", content: "x", type: "session", originatorInstanceId: "instance-B" });
    const m1: any = makeMemory({});
    const spy = spyOn(BaseMemory, "get").mockImplementation(async () => { throw new Error("simulated stored-row read failure"); });
    try {
      const res: any = await m1.put({ _reindex: true, id: "mem-r3-reindex", agentId: "agent-1", content: "x", type: "session" });
      expect(res instanceof Response).toBe(true);
      expect((res as Response).status).toBe(500);
      expect((await (res as Response).json()).error).toBe("stored_row_lookup_failed");
    } finally {
      spy.mockRestore();
    }
    // A reindex names an EXISTING row; a missing row is refused, never created.
    const m2: any = makeMemory({});
    const res2: any = await m2.put({ _reindex: true, id: "mem-r3-missing", agentId: "agent-1", content: "x", type: "session" });
    expect(res2 instanceof Response).toBe(true);
    expect((res2 as Response).status).toBe(404);
    expect(memoryStore.get("mem-r3-missing")).toBeUndefined();
  });
});

describe("federation-edge-hardening slice 1 — migration-equivalence (no-originatorInstanceId-field memories)", () => {
  it("an existing/old row with no originatorInstanceId field reads back fine — the field is purely additive, not required for reads", async () => {
    memoryStore.set("legacy-no-origin", { id: "legacy-no-origin", agentId: "agent-owner", content: "pre-migration content, no originatorInstanceId field at all." });
    const m = makeMemory(agentCtx("agent-owner"));
    const res = await (m as any).get("legacy-no-origin");
    expect(res instanceof Response).toBe(false);
    expect((res as any).content).toBe("pre-migration content, no originatorInstanceId field at all.");
    expect((res as any).originatorInstanceId).toBeUndefined();
  });

  it("search() over a mix of legacy (no originatorInstanceId) and new (stamped) records returns both, unaffected by the new field", async () => {
    instanceRow = { id: "flair_local_test" };
    memoryStore.set("legacy-no-origin", { id: "legacy-no-origin", agentId: "agent-1", content: "legacy record, no originatorInstanceId" });
    const m = makeMemory(agentCtx("agent-1"));
    await m.post({ agentId: "agent-1", content: "new record, gets originatorInstanceId stamped, long enough for the gate." });

    const results: any[] = [];
    for await (const r of await (m as any).search({ conditions: [] })) results.push(r);
    const ids = results.map((r) => r.id).sort();
    expect(ids).toContain("legacy-no-origin");
    expect(results.length).toBe(2);
  });

  it("updating a legacy (no-originatorInstanceId) record via put() keeps it un-stamped — the field is set on CREATE, never invented on UPDATE", async () => {
    instanceRow = { id: "flair_local_test" };
    memoryStore.set("legacy-origin-2", { id: "legacy-origin-2", agentId: "agent-1", content: "legacy content", durability: "standard", archived: false });
    const existing = await BaseMemory.get("legacy-origin-2");
    expect(existing.originatorInstanceId).toBeUndefined();

    const merged = { ...existing, content: "patched legacy content", updatedAt: new Date().toISOString() };
    const m = makeMemory(agentCtx("agent-1"));
    await m.put(merged);

    const after = await BaseMemory.get("legacy-origin-2");
    expect(after.content).toBe("patched legacy content"); // untouched aside from the intended patch
    expect(after.originatorInstanceId).toBeUndefined(); // an UPDATE keeps the STORED value; a legacy row stays un-stamped
  });
});

// ─── flair#718 authorship-provenance: claimedClient is folded into
// provenance.claimed.client and STRIPPED from the row itself ───────────────
//
// Reuses this file's existing mock/import (see the memory-soul-read-gate
// collision-avoidance comment above): a second file mock.module-ing
// "harper" + importing "../../resources/Memory.ts" would race
// this file's Memory class singleton.
describe("flair#718 authorship-provenance — Memory.post()/put() claimedClient handling", () => {
  it("post(): a claimedClient on the write body is folded into provenance.claimed.client, and NEVER persisted as a top-level row field", async () => {
    const m = makeMemory(agentCtx("agent-1"));
    const r: any = await m.post({
      agentId: "agent-1",
      content: "A memory written via the claude-code MCP client, long enough for the gate.",
      claimedClient: "claude-code",
    });
    expect(r.written).toBe(true);

    const stored = await BaseMemory.get(r.id);
    // Row-level: claimedClient must NEVER appear on the persisted record.
    expect(stored.claimedClient).toBeUndefined();
    expect("claimedClient" in stored).toBe(false);
    // Provenance JSON: the SAME value lands in claimed.client.
    expect(typeof stored.provenance).toBe("string");
    const prov = JSON.parse(stored.provenance);
    expect(prov.claimed.client).toBe("claude-code");
  });

  it("put() (fresh create via explicit id): same fold + strip behavior as post()", async () => {
    const m = makeMemory(agentCtx("agent-1"));
    const r: any = await m.put({
      id: "agent-1-put-claimed-client",
      agentId: "agent-1",
      content: "A fresh PUT-created memory carrying claimedClient, long enough for the gate.",
      claimedClient: "codex",
    });
    expect(r.written).toBe(true);

    const stored = await BaseMemory.get("agent-1-put-claimed-client");
    expect("claimedClient" in stored).toBe(false);
    const prov = JSON.parse(stored.provenance);
    expect(prov.claimed.client).toBe("codex");
  });

  it("put() (update of an existing record): a fresh claimedClient on the update is stamped into the NEW provenance and still never persisted as a row field", async () => {
    const m = makeMemory(agentCtx("agent-1"));
    const created: any = await m.post({ agentId: "agent-1", content: "Original content, long enough for the gate.", claimedClient: "claude-code" });

    const existing = await BaseMemory.get(created.id);
    const merged = { ...existing, content: "Updated via a different client, long enough for the gate.", updatedAt: new Date().toISOString(), claimedClient: "gemini" };
    delete (merged as any).embedding;
    delete (merged as any).embeddingModel;

    const mUpdate = makeMemory(agentCtx("agent-1"));
    await mUpdate.put(merged);

    const after = await BaseMemory.get(created.id);
    expect("claimedClient" in after).toBe(false);
    const prov = JSON.parse(after.provenance);
    expect(prov.claimed.client).toBe("gemini"); // reflects the CURRENT write, not the original post()
  });

  it("absent claimedClient → provenance carries no claimed.client (claimed.createdAt is still stamped)", async () => {
    const m = makeMemory(agentCtx("agent-1"));
    const r: any = await m.post({ agentId: "agent-1", content: "A plain memory with no client label, long enough for the gate." });
    const stored = await BaseMemory.get(r.id);
    const prov = JSON.parse(stored.provenance);
    expect(prov.claimed.client).toBeUndefined();
    expect(prov.claimed.createdAt).toBe(stored.createdAt);
  });

  it("claimedClient is dropped from the row EVEN when the write is otherwise denied's opposite case — a successful cross-write scenario (supersede) also strips it", async () => {
    const mOwner = makeMemory(agentCtx("agent-1"));
    const owned: any = await mOwner.post({ agentId: "agent-1", content: "Original finding, long enough for the gate.", claimedClient: "cursor" });

    const mNew = makeMemory(agentCtx("agent-1"));
    const res: any = await mNew.post({
      agentId: "agent-1",
      content: "Replacement finding via supersede, long enough for the gate.",
      supersedes: owned.id,
      claimedClient: "codex",
    });
    expect(res.written).toBe(true);

    const stored = await BaseMemory.get(res.id);
    expect("claimedClient" in stored).toBe(false);
    const prov = JSON.parse(stored.provenance);
    expect(prov.claimed.client).toBe("codex");
  });
});

// ─── flair#1383: identified pre-0.18.0 clients are refused on write paths ──
function clientHeaderCtx(agentId: string, token: string | null) {
  return {
    tpsAgent: agentId,
    tpsAgentIsAdmin: false,
    headers: {
      get: (name: string) => (
        token && name.toLowerCase() === "x-flair-client" ? token : null
      ),
      asObject: token ? { "x-flair-client": token } : {},
    },
  };
}

describe("flair#1383 — Memory write path refuses an identified pre-0.18.0 client", () => {
  it("post() with X-Flair-Client: flair-client/0.17.0 is 426 and writes nothing", async () => {
    const m = makeMemory(clientHeaderCtx("agent-1", "flair-client/0.17.0"));
    const r: any = await m.post({
      agentId: "agent-1",
      content: "A write from a stale adapter, long enough for the gate.",
    });
    expect(r).toBeInstanceOf(Response);
    expect(r.status).toBe(426);
    const body = await r.json();
    expect(body.error).toBe("stale_flair_client");
    expect(body.clientVersion).toBe("0.17.0");
    expect(body.message).toContain("Upgrade the adapter, not the server");
    expect(memoryStore.size).toBe(0);
  });

  it("put() with X-Flair-Client: flair-client/0.17.0 is 426 and writes nothing", async () => {
    const m = makeMemory(clientHeaderCtx("agent-1", "flair-client/0.17.0"));
    const r: any = await m.put({
      id: "agent-1-stale",
      agentId: "agent-1",
      content: "A PUT from a stale adapter, long enough for the gate.",
    });
    expect(r).toBeInstanceOf(Response);
    expect(r.status).toBe(426);
    expect(memoryStore.has("agent-1-stale")).toBe(false);
  });

  it("put() with flairClientVersion: 0.17.0 on the body is 426 and the field is not stored", async () => {
    const m = makeMemory(agentCtx("agent-1"));
    const r: any = await m.put({
      id: "agent-1-body-ver",
      agentId: "agent-1",
      content: "A PUT declaring an old client in the body, long enough for the gate.",
      flairClientVersion: "0.17.0",
    });
    expect(r).toBeInstanceOf(Response);
    expect(r.status).toBe(426);
    expect(memoryStore.has("agent-1-body-ver")).toBe(false);
  });

  it("raw HTTP with no X-Flair-Client still writes", async () => {
    // Signed REST: auth middleware stamps tpsAgent. No library version header.
    const m = makeMemory(agentCtx("agent-1"));
    const r: any = await m.post({
      agentId: "agent-1",
      content: "Raw HTTP unversioned write, long enough for the gate.",
    });
    expect(r.written).toBe(true);
    expect(memoryStore.size).toBe(1);
  });

  it("/mcp in-process with no version still writes (delegationContext headers are x-tps-agent only)", async () => {
    // resources/mcp-tools.ts delegationContext: headers.get returns only
    // x-tps-agent. Missing version is served — not treated as old.
    const mcpInProcess = {
      tpsAgent: "agent-1",
      tpsAgentIsAdmin: false,
      headers: {
        get: (k: string) => (k.toLowerCase() === "x-tps-agent" ? "agent-1" : undefined),
      },
    };
    const m = makeMemory(mcpInProcess);
    const r: any = await m.post({
      agentId: "agent-1",
      content: "In-process /mcp unversioned write, long enough for the gate.",
    });
    expect(r.written).toBe(true);
    expect(memoryStore.size).toBe(1);
  });

  it("0.18.0+ still writes", async () => {
    const m = makeMemory(clientHeaderCtx("agent-1", "flair-client/0.18.0"));
    const r: any = await m.post({
      agentId: "agent-1",
      content: "A write from the first safe client, long enough for the gate.",
    });
    expect(r.written).toBe(true);
    expect(memoryStore.size).toBe(1);
  });
});

// ─── flair#1965 r2 — URL-target resolution + PATCH-create stamping ──────────
// Blocker 2: the stored-row lookup must use the URL-BOUND target id, never a
// body `id`; a mismatch (or a failed read) REFUSES the write. Blocker 3: a
// PATCH whose URL target has no stored row is a CREATE and must stamp the local
// id (Harper's patch path does not require an existing row).
describe("flair#1965 r2 — Memory PUT resolves the URL-bound target; PATCH creates are stamped", () => {
  it("REFUSES a PUT whose body id differs from the URL target id (a body id is not the row this write lands on)", async () => {
    instanceRow = { id: "flair_local_test" };
    memoryStore.set("mem-real", { id: "mem-real", agentId: "agent-1", content: "real row", originatorInstanceId: "instance-B" });
    const m: any = makeMemory(agentCtx("agent-1"));
    m._targetId = "mem-real";
    const res: any = await m.put({ id: "mem-decoy", agentId: "agent-1", content: "decoy content, long enough for the gate.", originatorInstanceId: "instance-attacker" });
    expect(res instanceof Response).toBe(true);
    expect((res as Response).status).toBe(400);
    expect(memoryStore.get("mem-decoy")).toBeUndefined(); // nothing landed on the body id
    expect(memoryStore.get("mem-real").originatorInstanceId).toBe("instance-B"); // the target row is untouched
  });

  it("a PUT whose body id MATCHES the URL target updates that row, keeping its stored value", async () => {
    instanceRow = { id: "flair_local_test" };
    memoryStore.set("mem-target", { id: "mem-target", agentId: "agent-1", content: "target row", visibility: "shared", originatorInstanceId: "instance-B" });
    const m: any = makeMemory(agentCtx("agent-1"));
    m._targetId = "mem-target";
    const res: any = await m.put({ id: "mem-target", agentId: "agent-1", content: "target row updated here, long enough for the gate.", visibility: "shared" });
    expect(res instanceof Response).toBe(false);
    expect(memoryStore.get("mem-target").content).toBe("target row updated here, long enough for the gate.");
    expect(memoryStore.get("mem-target").originatorInstanceId).toBe("instance-B");
  });

  it("PATCH that CREATES a row (URL target has no stored row) stamps the local instance id", async () => {
    instanceRow = { id: "flair_local_test" };
    const m: any = makeMemory(agentCtx("agent-1"));
    m._targetId = "mem-patch-create";
    const res: any = await m.patch({ agentId: "agent-1", content: "brand new via patch, long enough for the gate." });
    expect(res instanceof Response).toBe(false);
    expect(memoryStore.get("mem-patch-create").originatorInstanceId).toBe("flair_local_test");
  });
});
