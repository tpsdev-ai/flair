/**
 * memory-grant-read-gate.test.ts — regression guard for the memory-soul-
 * read-gate FAMILY fix: MemoryGrant.ts previously gated
 * search()/post()/put()/delete() but never defined `allowRead()` nor
 * overrode `get()`. Harper routes `GET /MemoryGrant/<id>` to get() and the
 * collection-describe `GET /MemoryGrant` outside search(), so both were
 * ungated — an anonymous caller got a 200 with full grant content.
 *
 * MemoryGrant's ownership model differs from the other three (WorkspaceState/
 * Relationship/Integration are single-owner via `agentId`): a grant is
 * visible to EITHER the owner (ownerId) OR the grantee (granteeId) — mirrors
 * search()'s existing owner-OR-grantee scope. get()'s ownership check is
 * tested for both sides below.
 *
 * Same mocking technique as memory-integrity.test.ts / coordination-write-
 * auth.test.ts. No other test/unit/ file imports resources/MemoryGrant.ts,
 * so this file owns that mock+import with no collision risk.
 */
import { describe, it, expect, beforeEach, mock } from "bun:test";

let grantStore: Map<string, any>;

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

class BaseMemoryGrant {
  async get(target?: any) {
    const id = typeof target === "string" ? target : target?.id;
    return grantStore.get(id) ?? null;
  }
  async post(content: any) {
    const id = content.id ?? `grant-${Math.random().toString(36).slice(2)}`;
    content.id = id;
    grantStore.set(id, { ...content });
    return { ...content };
  }
  async put(content: any) {
    grantStore.set(content.id, { ...content });
    return { ...content };
  }
  async delete(id: any) {
    grantStore.delete(id);
    return { ok: true };
  }
  search(query?: any) {
    const conditions = Array.isArray(query) ? query : Array.isArray(query?.conditions) ? query.conditions : [];
    let records = Array.from(grantStore.values());
    for (const cond of conditions) records = records.filter((r) => matchesCondition(r, cond));
    async function* gen() {
      for (const r of records) yield r;
    }
    return gen();
  }
}

const databasesMock = {
  flair: {
    MemoryGrant: BaseMemoryGrant,
    Agent: { get: async () => null, search: async () => [] },
  },
};

mock.module("@harperfast/harper", () => ({ databases: databasesMock, Resource: class {} }));

const { MemoryGrant } = await import("../../resources/MemoryGrant.ts");

function makeGrant(ctxRequest: any) {
  const r: any = new (MemoryGrant as any)();
  r.getContext = () => ({ request: ctxRequest });
  return r;
}
const agentCtx = (agentId: string, isAdmin = false) => ({ tpsAgent: agentId, tpsAgentIsAdmin: isAdmin });
const anonCtx = () => ({ tpsAnonymous: true });

beforeEach(() => {
  grantStore = new Map();
});

describe("MemoryGrant.allowRead — closes the anonymous GET /MemoryGrant/<id> and describe leak", () => {
  it("anonymous is denied", async () => {
    const g = makeGrant(anonCtx());
    expect(await (g as any).allowRead()).toBe(false);
  });

  it("a verified non-admin agent is allowed (per-record scoping is in get())", async () => {
    const g = makeGrant(agentCtx("agent-1"));
    expect(await (g as any).allowRead()).toBe(true);
  });

  it("an admin agent is allowed", async () => {
    const g = makeGrant(agentCtx("agent-admin", true));
    expect(await (g as any).allowRead()).toBe(true);
  });

  it("an internal call (no request context) is allowed", async () => {
    const r: any = new (MemoryGrant as any)();
    r.getContext = () => undefined;
    expect(await r.allowRead()).toBe(true);
  });
});

describe("MemoryGrant.get() — anonymous denied, owner-OR-grantee scoped for non-admin, unfiltered for internal/admin", () => {
  it("anonymous get(<id>) → 404, never leaks grant content", async () => {
    grantStore.set("grant-1", { id: "grant-1", ownerId: "agent-owner", granteeId: "agent-grantee", scope: "read" });
    const g = makeGrant(anonCtx());
    const res = await (g as any).get("grant-1");
    expect(res instanceof Response).toBe(true);
    expect((res as Response).status).toBe(404);
  });

  it("verified non-admin get() of a grant where it's NEITHER owner NOR grantee → 404", async () => {
    grantStore.set("grant-1", { id: "grant-1", ownerId: "agent-owner", granteeId: "agent-grantee", scope: "read" });
    const g = makeGrant(agentCtx("agent-attacker"));
    const res = await (g as any).get("grant-1");
    expect(res instanceof Response).toBe(true);
    expect((res as Response).status).toBe(404);
  });

  it("the OWNER can get() its own grant", async () => {
    grantStore.set("grant-1", { id: "grant-1", ownerId: "agent-owner", granteeId: "agent-grantee", scope: "read" });
    const g = makeGrant(agentCtx("agent-owner"));
    const res = await (g as any).get("grant-1");
    expect(res instanceof Response).toBe(false);
    expect((res as any).scope).toBe("read");
  });

  it("the GRANTEE can also get() the same grant (owner-OR-grantee, not owner-only)", async () => {
    grantStore.set("grant-1", { id: "grant-1", ownerId: "agent-owner", granteeId: "agent-grantee", scope: "read" });
    const g = makeGrant(agentCtx("agent-grantee"));
    const res = await (g as any).get("grant-1");
    expect(res instanceof Response).toBe(false);
    expect((res as any).scope).toBe("read");
  });

  it("a non-existent id for a non-admin agent → 404 (same as denied — no oracle for existence)", async () => {
    const g = makeGrant(agentCtx("agent-owner"));
    const res = await (g as any).get("does-not-exist");
    expect(res instanceof Response).toBe(true);
    expect((res as Response).status).toBe(404);
  });

  it("internal call (no request context) → returns any id unchanged", async () => {
    grantStore.set("grant-1", { id: "grant-1", ownerId: "agent-owner", granteeId: "agent-grantee", scope: "secret-scope" });
    const r: any = new (MemoryGrant as any)();
    r.getContext = () => undefined;
    const res = await r.get("grant-1");
    expect(res instanceof Response).toBe(false);
    expect((res as any).scope).toBe("secret-scope");
  });

  it("admin agent → returns any id unchanged, no ownership check", async () => {
    grantStore.set("grant-1", { id: "grant-1", ownerId: "agent-owner", granteeId: "agent-grantee", scope: "secret-scope" });
    const g = makeGrant(agentCtx("agent-admin", true));
    const res = await (g as any).get("grant-1");
    expect(res instanceof Response).toBe(false);
    expect((res as any).scope).toBe("secret-scope");
  });

  it("a collection/query target (isCollection: true) delegates to search(), scoped by owner-OR-grantee", async () => {
    grantStore.set("grant-owned", { id: "grant-owned", ownerId: "agent-1", granteeId: "agent-x", scope: "read" });
    grantStore.set("grant-granted", { id: "grant-granted", ownerId: "agent-y", granteeId: "agent-1", scope: "read" });
    grantStore.set("grant-unrelated", { id: "grant-unrelated", ownerId: "agent-y", granteeId: "agent-x", scope: "read" });
    const g = makeGrant(agentCtx("agent-1"));
    const res: any = await (g as any).get({ isCollection: true, conditions: [] });
    const results: any[] = [];
    for await (const rec of res) results.push(rec);
    expect(results.map((rec) => rec.id).sort()).toEqual(["grant-granted", "grant-owned"]);
  });
});
