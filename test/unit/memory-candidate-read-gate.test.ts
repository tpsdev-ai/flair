/**
 * memory-candidate-read-gate.test.ts — regression guard for flair#849.
 *
 * MemoryCandidate shipped with a `@table` schema declaration but NO
 * `@export` and no resource file at all, so `flair rem candidates` /
 * `flair rem promote` / `flair rem reject` (src/cli.ts) 404'd on every call
 * — a clean-room dogfood blocker. This file exercises the fix:
 * resources/MemoryCandidate.ts's allowRead()/get()/search()/post()/put()/
 * delete(), same "owner-only" composition Relationship.ts uses (parameterized
 * from RECORD_TYPES.MemoryCandidate — see record-types.ts's doc comment for
 * why "owner-only", not "open-within-org": a candidate is an unreviewed
 * draft distillation and must not be org-readable before promotion).
 *
 * Same mocking technique as relationship-read-gate.test.ts /
 * memory-grant-read-gate.test.ts: mock harper so the resource
 * class loads outside a real Harper runtime, then exercise allowRead()/
 * get()/search()/post()/put()/delete() directly against an in-memory store.
 * No other test/unit/ file imports resources/MemoryCandidate.ts, so this
 * file owns that mock+import with no collision risk.
 */
import { describe, it, expect, beforeEach, mock } from "bun:test";

let candidateStore: Map<string, any>;

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

class BaseMemoryCandidate {
  async get(target?: any) {
    const id = typeof target === "string" ? target : target?.id;
    return candidateStore.get(id) ?? null;
  }
  async post(content: any) {
    const id = content.id ?? `cand_${Math.random().toString(36).slice(2)}`;
    content.id = id;
    candidateStore.set(id, { ...content });
    return { ...content };
  }
  async put(content: any) {
    candidateStore.set(content.id, { ...content });
    return { ...content };
  }
  async delete(id: any) {
    candidateStore.delete(id);
    return { ok: true };
  }
  search(query?: any) {
    const conditions = Array.isArray(query) ? query : Array.isArray(query?.conditions) ? query.conditions : [];
    let records = Array.from(candidateStore.values());
    for (const cond of conditions) records = records.filter((r) => matchesCondition(r, cond));
    async function* gen() {
      for (const r of records) yield r;
    }
    return gen();
  }
}

const databasesMock = {
  flair: {
    MemoryCandidate: BaseMemoryCandidate,
    Agent: { get: async () => null, search: async () => [] },
  },
};

mock.module("harper", () => ({ databases: databasesMock, Resource: class {} }));

const { MemoryCandidate } = await import("../../resources/MemoryCandidate.ts");

function makeCandidate(ctxRequest: any) {
  const r: any = new (MemoryCandidate as any)();
  r.getContext = () => ({ request: ctxRequest });
  return r;
}
const agentCtx = (agentId: string, isAdmin = false) => ({ tpsAgent: agentId, tpsAgentIsAdmin: isAdmin });
const anonCtx = () => ({ tpsAnonymous: true });

const candidateRow = (overrides: Partial<Record<string, any>> = {}) => ({
  id: "cand_1",
  agentId: "agent-owner",
  claim: "secret-lesson-learned",
  status: "pending",
  generatedBy: "test-model",
  generatedAt: "2026-07-01T00:00:00.000Z",
  ...overrides,
});

beforeEach(() => {
  candidateStore = new Map();
});

// ─── allowRead() ────────────────────────────────────────────────────────────

describe("MemoryCandidate.allowRead — identity gate (flair#849)", () => {
  it("anonymous is denied", async () => {
    const r = makeCandidate(anonCtx());
    expect(await (r as any).allowRead()).toBe(false);
  });

  it("a verified non-admin agent is allowed (per-record scoping is in get()/search())", async () => {
    const r = makeCandidate(agentCtx("agent-1"));
    expect(await (r as any).allowRead()).toBe(true);
  });

  it("an admin agent is allowed", async () => {
    const r = makeCandidate(agentCtx("agent-admin", true));
    expect(await (r as any).allowRead()).toBe(true);
  });

  it("an internal call (no request context) is allowed", async () => {
    const r: any = new (MemoryCandidate as any)();
    r.getContext = () => undefined;
    expect(await r.allowRead()).toBe(true);
  });
});

// ─── get() — by-id owner scoping ────────────────────────────────────────────

describe("MemoryCandidate.get() — anonymous denied, owner-scoped for non-admin, unfiltered for internal/admin", () => {
  it("anonymous get(<id>) → 404, never leaks candidate content", async () => {
    candidateStore.set("cand_1", candidateRow());
    const r = makeCandidate(anonCtx());
    const res = await (r as any).get("cand_1");
    expect(res instanceof Response).toBe(true);
    expect((res as Response).status).toBe(404);
    const body = await (res as Response).json();
    expect(JSON.stringify(body)).not.toContain("secret-lesson-learned");
  });

  it("verified non-admin get() of ANOTHER agent's candidate → 404 (not 403 — no existence confirmation)", async () => {
    candidateStore.set("cand_1", candidateRow({ agentId: "agent-owner" }));
    const r = makeCandidate(agentCtx("agent-attacker"));
    const res = await (r as any).get("cand_1");
    expect(res instanceof Response).toBe(true);
    expect((res as Response).status).toBe(404);
  });

  it("verified non-admin get() of ITS OWN candidate → returns the real record", async () => {
    candidateStore.set("cand_1", candidateRow({ agentId: "agent-owner" }));
    const r = makeCandidate(agentCtx("agent-owner"));
    const res = await (r as any).get("cand_1");
    expect(res instanceof Response).toBe(false);
    expect((res as any).claim).toBe("secret-lesson-learned");
  });

  it("a non-existent id for a non-admin agent → 404 (same as denied — no oracle for existence)", async () => {
    const r = makeCandidate(agentCtx("agent-owner"));
    const res = await (r as any).get("does-not-exist");
    expect(res instanceof Response).toBe(true);
    expect((res as Response).status).toBe(404);
  });

  it("internal call (no request context) → returns any id unchanged (FLAIR-NIGHTLY-REM staging path)", async () => {
    candidateStore.set("cand_1", candidateRow({ agentId: "agent-owner" }));
    const r: any = new (MemoryCandidate as any)();
    r.getContext = () => undefined;
    const res = await r.get("cand_1");
    expect(res instanceof Response).toBe(false);
    expect((res as any).claim).toBe("secret-lesson-learned");
  });

  it("admin agent → returns any id unchanged, no ownership check", async () => {
    candidateStore.set("cand_1", candidateRow({ agentId: "agent-owner" }));
    const r = makeCandidate(agentCtx("agent-admin", true));
    const res = await (r as any).get("cand_1");
    expect(res instanceof Response).toBe(false);
    expect((res as any).claim).toBe("secret-lesson-learned");
  });
});

// ─── search() — collection owner scoping (the flair rem candidates path) ──

describe("MemoryCandidate.search() — anonymous denied, owner-scoped for non-admin, unfiltered for internal/admin", () => {
  it("anonymous search() → 401", async () => {
    const r = makeCandidate(anonCtx());
    const res = await (r as any).search({ conditions: [] });
    expect(res instanceof Response).toBe(true);
    expect((res as Response).status).toBe(401);
  });

  it("a non-admin agent sees ONLY its own candidates — enforced SERVER-side, independent of what the client query asks for (mutation-sensitive: a client-side-only agentId filter, like the CLI's own, would pass this even if server scoping were removed)", async () => {
    candidateStore.set("cand_mine", candidateRow({ id: "cand_mine", agentId: "agent-1", status: "pending" }));
    candidateStore.set("cand_theirs", candidateRow({ id: "cand_theirs", agentId: "agent-2", status: "pending" }));
    const r = makeCandidate(agentCtx("agent-1"));
    // Deliberately NO agentId condition in the client query — only `status`.
    // If server-side owner scoping were missing/broken, this returns BOTH
    // rows; the assertion below only holds because search() itself injects
    // the owner condition.
    const res: any = await r.search({
      conditions: [{ attribute: "status", comparator: "equals", value: "pending" }],
      operator: "and",
    });
    const results: any[] = [];
    for await (const rec of res) results.push(rec);
    expect(results.map((rec) => rec.id)).toEqual(["cand_mine"]);
  });

  it("a non-admin agent sees ONLY its own candidates when the query mirrors the CLI's exact POST /MemoryCandidate/search_by_conditions shape (agentId + status conditions, client-side self-scoped)", async () => {
    candidateStore.set("cand_mine", candidateRow({ id: "cand_mine", agentId: "agent-1", status: "pending" }));
    candidateStore.set("cand_theirs", candidateRow({ id: "cand_theirs", agentId: "agent-2", status: "pending" }));
    const r = makeCandidate(agentCtx("agent-1"));
    // Mirrors src/cli.ts's exact query shape after Harper's search_by_conditions
    // wire translation: {conditions:[{attribute,comparator,value}, ...], operator}.
    const res: any = await r.search({
      conditions: [
        { attribute: "agentId", comparator: "equals", value: "agent-1" },
        { attribute: "status", comparator: "equals", value: "pending" },
      ],
      operator: "and",
    });
    const results: any[] = [];
    for await (const rec of res) results.push(rec);
    expect(results.map((rec) => rec.id)).toEqual(["cand_mine"]);
  });

  it("a non-admin agent's search() cannot use a wildcard condition + operator:'or' to broaden visibility past its own rows (boolean-injection guard)", async () => {
    candidateStore.set("cand_mine", candidateRow({ id: "cand_mine", agentId: "agent-1" }));
    candidateStore.set("cand_theirs", candidateRow({ id: "cand_theirs", agentId: "agent-2" }));
    const r = makeCandidate(agentCtx("agent-1"));
    // A malicious caller supplies a condition that matches EVERY row (no
    // record's agentId equals this sentinel) combined with operator:"or",
    // hoping the "or" escapes to the top level and unions in every agent's
    // rows. The owner condition is always the outermost AND (Relationship.ts's
    // same discipline) — the attacker's wildcard+"or" stays trapped inside a
    // nested group that itself must still satisfy the AND, so it can only
    // ever narrow the caller's OWN rows, never broaden past them.
    const res: any = await r.search({
      conditions: [{ attribute: "agentId", comparator: "not_equal", value: "no-such-agent-sentinel" }],
      operator: "or",
    });
    const results: any[] = [];
    for await (const rec of res) results.push(rec);
    expect(results.map((rec) => rec.id)).toEqual(["cand_mine"]);
  });

  it("an admin agent sees every candidate, unfiltered", async () => {
    candidateStore.set("cand_mine", candidateRow({ id: "cand_mine", agentId: "agent-1" }));
    candidateStore.set("cand_theirs", candidateRow({ id: "cand_theirs", agentId: "agent-2" }));
    const r = makeCandidate(agentCtx("agent-admin", true));
    const res: any = await r.search({ conditions: [] });
    const results: any[] = [];
    for await (const rec of res) results.push(rec);
    expect(results.map((rec) => rec.id).sort()).toEqual(["cand_mine", "cand_theirs"]);
  });

  it("an internal call (no request context) is unfiltered — the FLAIR-NIGHTLY-REM dedup-scan path (MemoryReflect.ts)", async () => {
    candidateStore.set("cand_mine", candidateRow({ id: "cand_mine", agentId: "agent-1" }));
    candidateStore.set("cand_theirs", candidateRow({ id: "cand_theirs", agentId: "agent-2" }));
    const r: any = new (MemoryCandidate as any)();
    r.getContext = () => undefined;
    const res: any = await r.search({});
    const results: any[] = [];
    for await (const rec of res) results.push(rec);
    expect(results.map((rec) => rec.id).sort()).toEqual(["cand_mine", "cand_theirs"]);
  });
});

// ─── MUTATION-CHECK NOTE ────────────────────────────────────────────────────
// The two "sees ONLY its own candidates" / boolean-injection tests above were
// manually mutation-tested during development: temporarily short-circuiting
// search() to `return super.search(query);` right after the `denied` check
// (treating every `scoped` outcome as `unfiltered`, the same bypass a
// regression could introduce) made BOTH tests FAIL (each observed
// `cand_theirs` in the result), confirming neither is vacuously true.
// Reverted before commit — see flair#849's fix report for the before/after
// test output.

// ─── post() — no-forge attribution (owner self-attribution only) ──────────

describe("MemoryCandidate.post() — anonymous denied, non-admin can only self-attribute", () => {
  it("anonymous is denied with 401, nothing written", async () => {
    const r = makeCandidate(anonCtx());
    const res: any = await r.post({ id: "cand-anon", agentId: "agent-1", claim: "x" });
    expect(res instanceof Response).toBe(true);
    expect(res.status).toBe(401);
    expect(candidateStore.has("cand-anon")).toBe(false);
  });

  it("a non-admin agent may create a candidate attributed to itself", async () => {
    const r = makeCandidate(agentCtx("agent-1"));
    const res: any = await r.post({ id: "cand-mine", agentId: "agent-1", claim: "x" });
    expect(res instanceof Response).toBe(false);
    expect(res.agentId).toBe("agent-1");
  });

  it("a non-admin agent CANNOT create a candidate claiming another agent's id — 403, nothing written", async () => {
    const r = makeCandidate(agentCtx("agent-attacker"));
    const res: any = await r.post({ id: "cand-forged", agentId: "agent-victim", claim: "x" });
    expect(res instanceof Response).toBe(true);
    expect(res.status).toBe(403);
    expect(candidateStore.has("cand-forged")).toBe(false);
  });

  it("an admin agent may create on behalf of another agentId — unfiltered", async () => {
    const r = makeCandidate(agentCtx("agent-admin", true));
    const res: any = await r.post({ id: "cand-admin", agentId: "agent-other", claim: "x" });
    expect(res instanceof Response).toBe(false);
    expect(res.agentId).toBe("agent-other");
  });

  it("an internal call passes agentId through unchanged — the FLAIR-NIGHTLY-REM staging writer's shape", async () => {
    const r: any = new (MemoryCandidate as any)();
    r.getContext = () => undefined;
    const res: any = await r.post({ id: "cand-internal", agentId: "agent-internal", claim: "x" });
    expect(res instanceof Response).toBe(false);
    expect(res.agentId).toBe("agent-internal");
  });
});

// ─── put() — no-forge attribution (the promote/reject write path) ─────────

describe("MemoryCandidate.put() — anonymous denied, non-admin cannot rewrite another agent's candidate", () => {
  it("anonymous is denied with 401, nothing written", async () => {
    const r = makeCandidate(anonCtx());
    const res: any = await r.put({ id: "cand-anon", agentId: "agent-1", status: "rejected" });
    expect(res instanceof Response).toBe(true);
    expect(res.status).toBe(401);
    expect(candidateStore.has("cand-anon")).toBe(false);
  });

  it("a non-admin agent may update its own candidate (the promote/reject shipped shape: ...candidate, status, reviewerId, etc.)", async () => {
    candidateStore.set("cand_1", candidateRow({ agentId: "agent-1" }));
    const r = makeCandidate(agentCtx("agent-1"));
    const res: any = await r.put({ ...candidateRow({ agentId: "agent-1" }), status: "rejected", reviewerId: "agent-1", reviewRationale: "not useful" });
    expect(res instanceof Response).toBe(false);
    expect(res.status).toBe("rejected");
  });

  it("a non-admin agent CANNOT update another agent's candidate — 403, unchanged in the store", async () => {
    candidateStore.set("cand_1", candidateRow({ agentId: "agent-owner" }));
    const r = makeCandidate(agentCtx("agent-attacker"));
    const res: any = await r.put({ ...candidateRow({ agentId: "agent-owner" }), status: "rejected", reviewerId: "agent-attacker" });
    expect(res instanceof Response).toBe(true);
    expect(res.status).toBe(403);
    expect(candidateStore.get("cand_1").status).toBe("pending");
  });

  it("an admin agent may update any candidate — unfiltered", async () => {
    candidateStore.set("cand_1", candidateRow({ agentId: "agent-owner" }));
    const r = makeCandidate(agentCtx("agent-admin", true));
    const res: any = await r.put({ ...candidateRow({ agentId: "agent-owner" }), status: "promoted", target: "memory", reviewerId: "agent-admin" });
    expect(res instanceof Response).toBe(false);
    expect(res.status).toBe("promoted");
  });

  it("an internal call passes through unfiltered", async () => {
    candidateStore.set("cand_1", candidateRow({ agentId: "agent-owner" }));
    const r: any = new (MemoryCandidate as any)();
    r.getContext = () => undefined;
    const res: any = await r.put({ ...candidateRow({ agentId: "agent-owner" }), status: "promoted" });
    expect(res instanceof Response).toBe(false);
    expect(res.status).toBe("promoted");
  });
});

// ─── delete() — owner-only, mirrors MemoryGrant.ts's delete() ─────────────

describe("MemoryCandidate.delete() — anonymous denied, owner-scoped for non-admin, unfiltered for internal/admin", () => {
  it("anonymous is denied with 401", async () => {
    candidateStore.set("cand-del-1", candidateRow({ id: "cand-del-1", agentId: "owner" }));
    const r = makeCandidate(anonCtx());
    const res: any = await r.delete("cand-del-1");
    expect(res instanceof Response).toBe(true);
    expect(res.status).toBe(401);
    expect(candidateStore.has("cand-del-1")).toBe(true);
  });

  it("a non-admin agent can delete its own candidate", async () => {
    candidateStore.set("cand-del-2", candidateRow({ id: "cand-del-2", agentId: "agent-1" }));
    const r = makeCandidate(agentCtx("agent-1"));
    await r.delete("cand-del-2");
    expect(candidateStore.has("cand-del-2")).toBe(false);
  });

  it("a non-admin agent CANNOT delete another agent's candidate — 403, untouched", async () => {
    candidateStore.set("cand-del-3", candidateRow({ id: "cand-del-3", agentId: "agent-owner" }));
    const r = makeCandidate(agentCtx("agent-attacker"));
    const res: any = await r.delete("cand-del-3");
    expect(res instanceof Response).toBe(true);
    expect(res.status).toBe(403);
    expect(candidateStore.has("cand-del-3")).toBe(true);
  });

  it("an internal call (no request context) is trusted and can delete", async () => {
    candidateStore.set("cand-del-4", candidateRow({ id: "cand-del-4", agentId: "owner" }));
    const r: any = new (MemoryCandidate as any)();
    r.getContext = () => undefined;
    await r.delete("cand-del-4");
    expect(candidateStore.has("cand-del-4")).toBe(false);
  });

  it("an admin agent is trusted and can delete", async () => {
    candidateStore.set("cand-del-5", candidateRow({ id: "cand-del-5", agentId: "owner" }));
    const r = makeCandidate(agentCtx("agent-admin", true));
    await r.delete("cand-del-5");
    expect(candidateStore.has("cand-del-5")).toBe(false);
  });

  it("deleting a non-existent id for a non-admin agent is a clean no-op (no FORBIDDEN oracle)", async () => {
    const r = makeCandidate(agentCtx("agent-1"));
    const res: any = await r.delete("does-not-exist");
    expect(res instanceof Response).toBe(false);
  });
});
