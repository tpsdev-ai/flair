/**
 * memory-search-scope.test.ts — boolean-injection guard for Memory.search().
 *
 * The bug (authz-hardening slice 2a): Memory.search() used a flat prepend —
 * `query.conditions = [agentIdCondition, ...query.conditions]` — which let a
 * caller-supplied `operator: "or"` survive and turn the scope condition into
 * one OR-branch.  MemoryCandidate.search() got this right (nested AND block);
 * Memory.search() and WorkspaceState.search() both had the same flat-prepend
 * defect despite a docstring claiming the correct behaviour.
 *
 * The fix extracts the correct composition into record-type-kit.ts's
 * makeScopedSearch(), which both resources now compose.
 *
 * No other test/unit/ file imports resources/Memory.ts with a harper mock
 * (memory-soul-read-gate.test.ts deliberately avoids it — see its docstring),
 * so this file owns the mock+import with no collision risk.
 */
import { describe, it, expect, beforeEach, mock } from "bun:test";

process.env.FLAIR_RATE_LIMIT_ENABLED = "false";
delete (process.env as any).FLAIR_PUBLIC;

// ─── In-memory Harper Memory mock ───────────────────────────────────────────

let memoryStore: Map<string, any>;
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

class BaseMemory {
  async get(target?: any) {
    const id = typeof target === "string" ? target : target?.id;
    return memoryStore.get(id) ?? null;
  }
  async put(content: any) {
    memoryStore.set(content.id, { ...content });
    return { ...content };
  }
  async post(content: any) {
    const id = content.id ?? `mem-${Math.random().toString(36).slice(2)}`;
    content.id = id;
    memoryStore.set(id, { ...content });
    return { ...content };
  }
  search(query?: any) {
    // Respect query.operator — Harper combines top-level conditions with
    // the query's operator (default "and").  This is the behaviour the
    // boolean-injection guard protects against: a caller-supplied
    // `operator: "or"` at the top level would OR the scope condition with
    // the caller's conditions if the scope is flat-prepended instead of
    // nested.
    const topLevel = Array.isArray(query) ? { conditions: query, operator: "and" } : query || {};
    const conds = Array.isArray(topLevel.conditions) ? topLevel.conditions : [];
    const op = topLevel.operator || "and";
    let records = Array.from(memoryStore.values());
    if (conds.length > 0) {
      records = records.filter((r) => {
        const results = conds.map((c: any) => matchesCondition(r, c));
        return op === "or" ? results.some(Boolean) : results.every(Boolean);
      });
    }
    async function* gen() {
      for (const r of records) yield r;
    }
    return gen();
  }
  async delete(id: any) {
    memoryStore.delete(id);
    return { ok: true };
  }
}

const databasesMock = {
  flair: {
    Memory: BaseMemory,
    Agent: { get: async () => null, search: async () => [] },
    Instance: {
      search: () => {
        async function* gen() {
          if (instanceRow) yield instanceRow;
        }
        return gen();
      },
    },
    MemoryGrant: {
      search: () => {
        async function* gen() {
          // empty — no grants in these tests
        }
        return gen();
      },
    },
  },
};

mock.module("harper", () => ({
  server: { http: () => {}, getUser: async () => null },
  databases: databasesMock,
  Resource: class {},
}));

const { Memory } = await import("../../resources/Memory.ts");
const { _resetLocalInstanceIdCacheForTests } = await import("../../resources/instance-identity.ts");

function makeMemory(ctxRequest: any) {
  const r: any = new (Memory as any)();
  r.getContext = () => ({ request: ctxRequest });
  return r;
}
const agentCtx = (agentId: string, isAdmin = false) => ({ tpsAgent: agentId, tpsAgentIsAdmin: isAdmin });
const anonCtx = () => ({ tpsAnonymous: true });

function memoryRow(overrides: Record<string, any> = {}) {
  return {
    id: `mem-${Math.random().toString(36).slice(2)}`,
    agentId: "agent-1",
    content: "test memory",
    visibility: "shared",
    ...overrides,
  };
}

beforeEach(() => {
  memoryStore = new Map();
  instanceRow = null;
  _resetLocalInstanceIdCacheForTests();
});

// ─── Boolean-injection guard ────────────────────────────────────────────────

describe("Memory.search() — boolean-injection guard (authz-hardening slice 2a)", () => {
  it("a non-admin agent's search() cannot use operator:'or' + wildcard to see another agent's memories", async () => {
    // Seed: agent-1 owns one memory, agent-2 owns a PRIVATE memory.
    // Memory uses "open-within-org" scoping (own records OR non-private
    // records), so the other agent's record must be private for the
    // boolean-injection guard to be meaningful — a shared record from
    // another agent is legitimately visible.
    memoryStore.set("mem-mine", memoryRow({ id: "mem-mine", agentId: "agent-1", content: "my memory" }));
    memoryStore.set("mem-theirs", memoryRow({ id: "mem-theirs", agentId: "agent-2", content: "their memory", visibility: "private" }));

    const r = makeMemory(agentCtx("agent-1"));

    // A malicious caller supplies a condition that matches EVERY row (no
    // record's agentId equals this sentinel) combined with operator:"or",
    // hoping the "or" escapes to the top level and unions in every agent's
    // rows.  The owner condition is always the outermost AND — the attacker's
    // wildcard+"or" stays trapped inside a nested group that itself must
    // still satisfy the AND, so it can only ever narrow the caller's OWN
    // rows, never broaden past them.
    const res: any = await r.search({
      conditions: [{ attribute: "agentId", comparator: "not_equal", value: "no-such-agent-sentinel" }],
      operator: "or",
    });
    const results: any[] = [];
    for await (const rec of res) results.push(rec);
    expect(results.map((rec) => rec.id)).toEqual(["mem-mine"]);
  });

  it("a non-admin agent sees only own memories with a normal scoped search", async () => {
    memoryStore.set("mem-mine", memoryRow({ id: "mem-mine", agentId: "agent-1" }));
    memoryStore.set("mem-theirs", memoryRow({ id: "mem-theirs", agentId: "agent-2", visibility: "private" }));

    const r = makeMemory(agentCtx("agent-1"));
    const res: any = await r.search({ conditions: [] });
    const results: any[] = [];
    for await (const rec of res) results.push(rec);
    expect(results.map((rec) => rec.id)).toEqual(["mem-mine"]);
  });

  it("an admin agent sees all memories, unfiltered", async () => {
    memoryStore.set("mem-mine", memoryRow({ id: "mem-mine", agentId: "agent-1" }));
    memoryStore.set("mem-theirs", memoryRow({ id: "mem-theirs", agentId: "agent-2" }));

    const r = makeMemory(agentCtx("agent-admin", true));
    const res: any = await r.search({ conditions: [] });
    const results: any[] = [];
    for await (const rec of res) results.push(rec);
    expect(results.map((rec) => rec.id).sort()).toEqual(["mem-mine", "mem-theirs"]);
  });

  it("an internal call (no request context) is unfiltered", async () => {
    memoryStore.set("mem-mine", memoryRow({ id: "mem-mine", agentId: "agent-1" }));
    memoryStore.set("mem-theirs", memoryRow({ id: "mem-theirs", agentId: "agent-2" }));

    const r: any = new (Memory as any)();
    r.getContext = () => undefined;
    const res: any = await r.search({});
    const results: any[] = [];
    for await (const rec of res) results.push(rec);
    expect(results.map((rec) => rec.id).sort()).toEqual(["mem-mine", "mem-theirs"]);
  });

  it("anonymous is denied with 401", async () => {
    memoryStore.set("mem-1", memoryRow({ id: "mem-1", agentId: "agent-1" }));
    const r = makeMemory(anonCtx());
    const res: any = await r.search({ conditions: [] });
    expect(res instanceof Response).toBe(true);
    expect((res as Response).status).toBe(401);
  });
});

// ─── MUTATION-CHECK NOTE ────────────────────────────────────────────────────
// The boolean-injection test above was manually mutation-tested during
// development: temporarily reverting Memory.search() to the flat prepend —
// `query.conditions = [agentIdCondition, ...query.conditions]` — made the
// test FAIL (observed "mem-theirs" in the result), confirming the guard is
// not vacuously true.  Reverted before commit.
