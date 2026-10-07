/**
 * integration-read-gate.test.ts — regression guard for the memory-soul-
 * read-gate FAMILY fix: Integration.ts previously gated
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
let agents: Map<string, any>;
let failAgentStore = false;

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
  // The STATIC table read (resolveStoredRow uses `databases.flair.Integration.get`).
  static async get(id: any) {
    return integrationStore.get(id) ?? null;
  }
  async get(target?: any) {
    const id = typeof target === "string" ? target : target?.id;
    return integrationStore.get(id) ?? null;
  }
  async patch(content: any) {
    const prev = integrationStore.get(content.id) ?? {};
    const merged = { ...prev, ...content };
    integrationStore.set(content.id, merged);
    return { ...merged };
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
    Agent: {
      async get(id: string) {
        if (failAgentStore) throw new Error("agent store down");
        return agents.get(id) ?? null;
      },
      search() {
        if (failAgentStore) throw new Error("agent store down");
        async function* gen() {
          for (const a of agents.values()) yield a;
        }
        return gen();
      },
    },
  },
};

mock.module("harper", () => ({ server: { http: () => {}, getUser: async () => null }, databases: databasesMock, Resource: class {} }));

const { Integration } = await import("../../resources/Integration.ts");

function makeIntegration(ctxRequest: any, boundId?: string) {
  const r: any = new (Integration as any)();
  r.getContext = () => ({ request: ctxRequest });
  if (boundId) r.getId = () => boundId;
  return r;
}
const agentCtx = (agentId: string, isAdmin = false) => ({ tpsAgent: agentId, tpsAgentIsAdmin: isAdmin });
const anonCtx = () => ({ tpsAnonymous: true });

beforeEach(() => {
  integrationStore = new Map();
  agents = new Map();
  agents.set("agent-a", { id: "agent-a", kind: "agent", status: "active" });
  agents.set("agent-b", { id: "agent-b", kind: "agent", status: "active" });
  failAgentStore = false;
  // request-transaction.ts needs Harper's global transaction() for the owned
  // write scope; a passthrough keeps the publication path exercisable.
  (globalThis as any).transaction = async (ctx: any, cb: any) => cb(ctx ?? {});
});

describe("Integration timestamps", () => {
  for (const verb of ["post", "put", "patch"] as const) {
    it(`${verb} ignores caller timestamps and preserves stored createdAt on update`, async () => {
      const forged = "1999-01-01T00:00:00.000Z";
      const createdAt = "2026-09-01T00:00:00.000Z";
      if (verb !== "post") integrationStore.set("int-1", { id: "int-1", agentId: "agent-a", createdAt });
      const i = makeIntegration(operatorCtx(), "int-1");
      const before = Date.now();
      const res = await i[verb]({
        id: "int-1", agentId: "agent-a", platform: "tps-mail", email: "a@example.test",
        createdAt: forged, updatedAt: forged, directoryPublishedAt: forged,
      });
      const after = Date.now();
      expect(res instanceof Response).toBe(false);
      const row = integrationStore.get("int-1");
      expect(row.createdAt).not.toBe(forged);
      if (verb !== "post") expect(row.createdAt).toBe(createdAt);
      for (const field of verb === "post" ? ["createdAt", "updatedAt", "directoryPublishedAt"] : ["updatedAt", "directoryPublishedAt"]) {
        expect(Date.parse(row[field])).toBeGreaterThanOrEqual(before);
        expect(Date.parse(row[field])).toBeLessThanOrEqual(after);
      }
    });
  }
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

// ─── flair#2141 S3a — the team-directory publication gate ────────────────────

// A verified Basic administrator — the operator source.
const operatorCtx = () => ({
  tpsAgent: "operator",
  tpsAgentIsAdmin: true,
  headers: { get: (k: string) => (k.toLowerCase() === "authorization" ? "Basic b3BlcmF0b3I6cHc=" : undefined) },
});

function seedPublished(fields: Record<string, unknown> = {}) {
  integrationStore.set("int-1", {
    id: "int-1",
    agentId: "agent-a",
    platform: "tps-mail",
    email: "a@example.test",
    directoryPublishedAt: "2026-09-01T00:00:00.000Z",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...fields,
  });
}

describe("Integration directory publication — non-operator refusals", () => {
  it("a runtime agent cannot publish (403), nothing stored", async () => {
    const i = makeIntegration(agentCtx("agent-a"));
    const res = await (i as any).post({ id: "int-1", agentId: "agent-a", platform: "tps-mail", email: "a@example.test", directoryPublishedAt: "2026-10-01T00:00:00.000Z" });
    expect(res instanceof Response).toBe(true);
    expect((res as Response).status).toBe(403);
    expect(integrationStore.has("int-1")).toBe(false);
  });

  it("an admin AGENT (runtime credential, no Basic) still cannot publish", async () => {
    const i = makeIntegration(agentCtx("agent-a", true));
    const res = await (i as any).post({ id: "int-1", agentId: "agent-a", platform: "tps-mail", email: "a@example.test", directoryPublishedAt: "2026-10-01T00:00:00.000Z" });
    expect(res instanceof Response).toBe(true);
    expect((res as Response).status).toBe(403);
  });

  it("a runtime agent cannot withdraw a published entry (403), unchanged", async () => {
    seedPublished();
    const i = makeIntegration(agentCtx("agent-a"), "int-1");
    const res = await (i as any).put({ id: "int-1", agentId: "agent-a", platform: "tps-mail", email: "a@example.test", directoryPublishedAt: null });
    expect(res instanceof Response).toBe(true);
    expect((res as Response).status).toBe(403);
    expect(integrationStore.get("int-1").directoryPublishedAt).toBe("2026-09-01T00:00:00.000Z");
  });

  it("put refuses an address change without an explicit withdrawal (409)", async () => {
    seedPublished();
    const i = makeIntegration(agentCtx("agent-a"), "int-1");
    const res = await (i as any).put({ id: "int-1", agentId: "agent-a", platform: "tps-mail", email: "new@example.test" });
    expect(res instanceof Response).toBe(true);
    expect((res as Response).status).toBe(409);
    expect(integrationStore.get("int-1").email).toBe("a@example.test");
  });

  it("a full-row put that omits email or platform on a published row is refused (409)", async () => {
    for (const omitted of ["email", "platform"]) {
      seedPublished();
      const body: any = { id: "int-1", agentId: "agent-a", platform: "tps-mail", email: "a@example.test" };
      delete body[omitted];
      const i = makeIntegration(agentCtx("agent-a"), "int-1");
      const res = await (i as any).put(body);
      expect(res instanceof Response).toBe(true);
      expect((res as Response).status).toBe(409);
      expect(integrationStore.get("int-1").email).toBe("a@example.test");
      expect(integrationStore.get("int-1").platform).toBe("tps-mail");
    }
  });

  it("an admin agent cannot reassign a published row's agentId by patch or put (409), unchanged", async () => {
    for (const verb of ["patch", "put"] as const) {
      seedPublished();
      const i = makeIntegration(agentCtx("agent-admin", true), "int-1");
      const body = verb === "patch"
        ? { id: "int-1", agentId: "agent-b" }
        : { id: "int-1", agentId: "agent-b", platform: "tps-mail", email: "a@example.test" };
      const res = await (i as any)[verb](body);
      expect(res instanceof Response).toBe(true);
      expect((res as Response).status).toBe(409);
      expect(integrationStore.get("int-1").agentId).toBe("agent-a");
    }
  });

  it("an admin agent cannot delete by a collection target (403), nothing deleted", async () => {
    seedPublished();
    const i = makeIntegration(agentCtx("agent-admin", true));
    const res = await (i as any).delete({ isCollection: true, conditions: [] });
    expect(res instanceof Response).toBe(true);
    expect((res as Response).status).toBe(403);
    expect(integrationStore.has("int-1")).toBe(true);
  });

  it("a runtime owner cannot delete a published entry (403)", async () => {
    seedPublished();
    const i = makeIntegration(agentCtx("agent-a"), "int-1");
    const res = await (i as any).delete("int-1");
    expect(res instanceof Response).toBe(true);
    expect((res as Response).status).toBe(403);
    expect(integrationStore.has("int-1")).toBe(true);
  });
});

describe("Integration directory publication — operator publication", () => {
  it("publishes an exact agentId/platform/email with a server-stamped time", async () => {
    const i = makeIntegration(operatorCtx());
    const res = await (i as any).post({ id: "int-1", agentId: "agent-a", platform: "tps-mail", email: "a@example.test", directoryPublishedAt: "1999-01-01T00:00:00.000Z" });
    expect(res instanceof Response).toBe(false);
    const stored = integrationStore.get("int-1");
    expect(stored.platform).toBe("tps-mail");
    expect(stored.email).toBe("a@example.test");
    expect(stored.directoryPublishedAt).not.toBe("1999-01-01T00:00:00.000Z");
    expect(Number.isFinite(Date.parse(stored.directoryPublishedAt))).toBe(true);
    expect(Number.isFinite(Date.parse(stored.createdAt))).toBe(true);
    expect(Number.isFinite(Date.parse(stored.updatedAt))).toBe(true);
  });

  it("rejects a non-tps-mail platform (400)", async () => {
    const i = makeIntegration(operatorCtx());
    const res = await (i as any).post({ id: "int-1", agentId: "agent-a", platform: "slack", email: "a@example.test", directoryPublishedAt: "x" });
    expect(res instanceof Response).toBe(true);
    expect((res as Response).status).toBe(400);
  });

  it("rejects publishing an agent that is not an active agent-kind principal (403)", async () => {
    agents.set("agent-b", { id: "agent-b", kind: "agent", status: "deactivated" });
    const i = makeIntegration(operatorCtx());
    const res = await (i as any).post({ id: "int-2", agentId: "agent-b", platform: "tps-mail", email: "b@example.test", directoryPublishedAt: "x" });
    expect(res instanceof Response).toBe(true);
    expect((res as Response).status).toBe(403);
  });

  it("a failed Agent read refuses the publication (503), never a false 'no such agent' success", async () => {
    failAgentStore = true;
    const i = makeIntegration(operatorCtx());
    const res = await (i as any).post({ id: "int-1", agentId: "agent-a", platform: "tps-mail", email: "a@example.test", directoryPublishedAt: "x" });
    expect(res instanceof Response).toBe(true);
    expect((res as Response).status).toBe(503);
    expect(integrationStore.has("int-1")).toBe(false);
  });

  it("withdraws by stamping directoryPublishedAt to null (operator)", async () => {
    seedPublished();
    const i = makeIntegration(operatorCtx(), "int-1");
    const res = await (i as any).put({ id: "int-1", agentId: "agent-a", platform: "tps-mail", email: "a@example.test", directoryPublishedAt: null });
    expect(res instanceof Response).toBe(false);
    expect(integrationStore.get("int-1").directoryPublishedAt).toBeNull();
  });

  it("an operator republish with a new email on a published row is refused (409)", async () => {
    seedPublished();
    const i = makeIntegration(operatorCtx(), "int-1");
    const res = await (i as any).put({ id: "int-1", agentId: "agent-a", platform: "tps-mail", email: "new@example.test", directoryPublishedAt: "x" });
    expect(res instanceof Response).toBe(true);
    expect((res as Response).status).toBe(409);
    expect(integrationStore.get("int-1").email).toBe("a@example.test");
    expect(integrationStore.get("int-1").directoryPublishedAt).toBe("2026-09-01T00:00:00.000Z");
  });

  it("allows an address change once the entry is withdrawn", async () => {
    seedPublished({ directoryPublishedAt: null });
    const i = makeIntegration(operatorCtx(), "int-1");
    const res = await (i as any).put({ id: "int-1", agentId: "agent-a", platform: "tps-mail", email: "new@example.test" });
    expect(res instanceof Response).toBe(false);
    expect(integrationStore.get("int-1").email).toBe("new@example.test");
    expect(integrationStore.get("int-1").directoryPublishedAt).toBeNull();
  });
});

describe("Integration directory publication — patch", () => {
  it("a runtime agent cannot publish by patch (403)", async () => {
    seedPublished({ directoryPublishedAt: null });
    const i = makeIntegration(agentCtx("agent-a"), "int-1");
    const res = await (i as any).patch({ id: "int-1", agentId: "agent-a", platform: "tps-mail", email: "a@example.test", directoryPublishedAt: "2026-10-01T00:00:00.000Z" });
    expect(res instanceof Response).toBe(true);
    expect((res as Response).status).toBe(403);
    expect(integrationStore.get("int-1").directoryPublishedAt).toBeNull();
  });

  it("a runtime agent cannot withdraw by patch (403)", async () => {
    seedPublished();
    const i = makeIntegration(agentCtx("agent-a"), "int-1");
    const res = await (i as any).patch({ id: "int-1", directoryPublishedAt: null });
    expect(res instanceof Response).toBe(true);
    expect((res as Response).status).toBe(403);
    expect(integrationStore.get("int-1").directoryPublishedAt).toBe("2026-09-01T00:00:00.000Z");
  });

  it("a patch that changes a published address is refused (409)", async () => {
    seedPublished();
    const i = makeIntegration(agentCtx("agent-a"), "int-1");
    const res = await (i as any).patch({ id: "int-1", email: "new@example.test" });
    expect(res instanceof Response).toBe(true);
    expect((res as Response).status).toBe(409);
    expect(integrationStore.get("int-1").email).toBe("a@example.test");
  });

  it("an operator withdraws by patch", async () => {
    seedPublished();
    const i = makeIntegration(operatorCtx(), "int-1");
    const res = await (i as any).patch({ id: "int-1", directoryPublishedAt: null });
    expect(res instanceof Response).toBe(false);
    expect(integrationStore.get("int-1").directoryPublishedAt).toBeNull();
    expect(integrationStore.get("int-1").email).toBe("a@example.test");
  });

  it("an operator publishes by patch with a server-stamped time", async () => {
    seedPublished({ directoryPublishedAt: null });
    const i = makeIntegration(operatorCtx(), "int-1");
    const res = await (i as any).patch({ id: "int-1", agentId: "agent-a", platform: "tps-mail", email: "a@example.test", directoryPublishedAt: "1999-01-01T00:00:00.000Z" });
    expect(res instanceof Response).toBe(false);
    const stamp = integrationStore.get("int-1").directoryPublishedAt;
    expect(stamp).not.toBe("1999-01-01T00:00:00.000Z");
    expect(Number.isFinite(Date.parse(stamp))).toBe(true);
  });
});
