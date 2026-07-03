/**
 * integration-read-gate.test.ts — regression guard for the memory-soul-
 * read-gate FAMILY fix (ops-oox7): Integration.ts previously gated
 * search()/post()/put()/delete() but never defined `allowRead()` nor
 * overrode `get()`. Harper routes `GET /Integration/<id>` to get() and the
 * collection-describe `GET /Integration` outside search(), so both were
 * ungated — an anonymous caller got a 200 with full record content.
 *
 * Same mocking technique as memory-integrity.test.ts / coordination-write-
 * auth.test.ts. No other test/unit/ file imports resources/Integration.ts,
 * so this file owns that mock+import with no collision risk.
 */
import { describe, it, expect, beforeEach, mock } from "bun:test";

let integrationStore: Map<string, any>;

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

class BaseIntegration {
  async get(target?: any) {
    const id = typeof target === "string" ? target : target?.id;
    return integrationStore.get(id) ?? null;
  }
  async post(content: any) {
    const id = content.id ?? `int-${Math.random().toString(36).slice(2)}`;
    content.id = id;
    integrationStore.set(id, { ...content });
    return { ...content };
  }
  async put(content: any) {
    integrationStore.set(content.id, { ...content });
    return { ...content };
  }
  async delete(id: any) {
    integrationStore.delete(id);
    return { ok: true };
  }
  search(query?: any) {
    const conditions = Array.isArray(query) ? query : Array.isArray(query?.conditions) ? query.conditions : [];
    let records = Array.from(integrationStore.values());
    for (const cond of conditions) records = records.filter((r) => matchesCondition(r, cond));
    async function* gen() {
      for (const r of records) yield r;
    }
    return gen();
  }
}

const databasesMock = {
  flair: {
    Integration: BaseIntegration,
    Agent: { get: async () => null, search: async () => [] },
  },
};

mock.module("@harperfast/harper", () => ({ databases: databasesMock, Resource: class {} }));

const { Integration } = await import("../../resources/Integration.ts");

function makeIntegration(ctxRequest: any) {
  const r: any = new (Integration as any)();
  r.getContext = () => ({ request: ctxRequest });
  return r;
}
const agentCtx = (agentId: string, isAdmin = false) => ({ tpsAgent: agentId, tpsAgentIsAdmin: isAdmin });
const anonCtx = () => ({ tpsAnonymous: true });

beforeEach(() => {
  integrationStore = new Map();
});

describe("Integration.allowRead — closes the anonymous GET /Integration/<id> and describe leak", () => {
  it("anonymous is denied", async () => {
    const i = makeIntegration(anonCtx());
    expect(await (i as any).allowRead()).toBe(false);
  });

  it("a verified non-admin agent is allowed (per-record scoping is in get())", async () => {
    const i = makeIntegration(agentCtx("agent-1"));
    expect(await (i as any).allowRead()).toBe(true);
  });

  it("an admin agent is allowed", async () => {
    const i = makeIntegration(agentCtx("agent-admin", true));
    expect(await (i as any).allowRead()).toBe(true);
  });

  it("an internal call (no request context) is allowed", async () => {
    const r: any = new (Integration as any)();
    r.getContext = () => undefined;
    expect(await r.allowRead()).toBe(true);
  });
});

describe("Integration.get() — anonymous denied, owner-scoped for non-admin, unfiltered for internal/admin", () => {
  it("anonymous get(<id>) → 404, never leaks record content", async () => {
    integrationStore.set("int-1", { id: "int-1", agentId: "agent-owner", platform: "slack", encryptedCredential: "secret-blob" });
    const i = makeIntegration(anonCtx());
    const res = await (i as any).get("int-1");
    expect(res instanceof Response).toBe(true);
    expect((res as Response).status).toBe(404);
    const body = await (res as Response).json();
    expect(JSON.stringify(body)).not.toContain("secret-blob");
  });

  it("verified non-admin get() of ANOTHER agent's id → 404 (not 403 — no existence confirmation)", async () => {
    integrationStore.set("int-1", { id: "int-1", agentId: "agent-owner", platform: "slack" });
    const i = makeIntegration(agentCtx("agent-attacker"));
    const res = await (i as any).get("int-1");
    expect(res instanceof Response).toBe(true);
    expect((res as Response).status).toBe(404);
  });

  it("verified non-admin get() of ITS OWN id → returns the real record", async () => {
    integrationStore.set("int-1", { id: "int-1", agentId: "agent-owner", platform: "slack" });
    const i = makeIntegration(agentCtx("agent-owner"));
    const res = await (i as any).get("int-1");
    expect(res instanceof Response).toBe(false);
    expect((res as any).platform).toBe("slack");
  });

  it("a non-existent id for a non-admin agent → 404 (same as denied — no oracle for existence)", async () => {
    const i = makeIntegration(agentCtx("agent-owner"));
    const res = await (i as any).get("does-not-exist");
    expect(res instanceof Response).toBe(true);
    expect((res as Response).status).toBe(404);
  });

  it("internal call (no request context) → returns any id unchanged", async () => {
    integrationStore.set("int-1", { id: "int-1", agentId: "agent-owner", platform: "secret-platform" });
    const r: any = new (Integration as any)();
    r.getContext = () => undefined;
    const res = await r.get("int-1");
    expect(res instanceof Response).toBe(false);
    expect((res as any).platform).toBe("secret-platform");
  });

  it("admin agent → returns any id unchanged, no ownership check", async () => {
    integrationStore.set("int-1", { id: "int-1", agentId: "agent-owner", platform: "secret-platform" });
    const i = makeIntegration(agentCtx("agent-admin", true));
    const res = await (i as any).get("int-1");
    expect(res instanceof Response).toBe(false);
    expect((res as any).platform).toBe("secret-platform");
  });

  it("a collection/query target (isCollection: true) delegates to search(), scoped by agentId", async () => {
    integrationStore.set("int-own", { id: "int-own", agentId: "agent-1", platform: "own" });
    integrationStore.set("int-other", { id: "int-other", agentId: "agent-other", platform: "other" });
    const i = makeIntegration(agentCtx("agent-1"));
    const res: any = await (i as any).get({ isCollection: true, conditions: [] });
    const results: any[] = [];
    for await (const rec of res) results.push(rec);
    expect(results.map((rec) => rec.id)).toEqual(["int-own"]);
  });
});

describe("Integration.delete() — ownership check uses the raw record (super.get), not the new scoped get()", () => {
  it("owner can still delete its own integration", async () => {
    integrationStore.set("int-1", { id: "int-1", agentId: "agent-owner" });
    const i = makeIntegration(agentCtx("agent-owner"));
    await (i as any).delete("int-1");
    expect(integrationStore.has("int-1")).toBe(false);
  });

  it("a non-admin cannot delete ANOTHER agent's integration (403, untouched)", async () => {
    integrationStore.set("int-1", { id: "int-1", agentId: "agent-owner" });
    const i = makeIntegration(agentCtx("agent-attacker"));
    const res = await (i as any).delete("int-1");
    expect(res instanceof Response).toBe(true);
    expect((res as Response).status).toBe(403);
    expect(integrationStore.has("int-1")).toBe(true);
  });

  it("deleting a non-existent id is a clean no-op (not mis-routed into FORBIDDEN by the new get() override)", async () => {
    const i = makeIntegration(agentCtx("agent-owner"));
    const res = await (i as any).delete("does-not-exist");
    expect(res instanceof Response).toBe(false);
  });
});
