/**
 * coordination-write-auth.test.ts — Handler-level no-forge tests for the
 * coordination write surface (ops-wmgx / Kris #510).
 *
 * Exercises WorkspaceState.post() and OrgEvent.post() directly, mocking
 * @harperfast/harper so the resource classes load + their writes are capturable
 * outside a Harper runtime (same technique as resolve-agent-auth.test.ts). These
 * are the security-critical assertions the integration harness can't make at the
 * unit level:
 *
 *   - An authenticated agent's write is attributed to ITS OWN id (from the auth
 *     context, i.e. the verified Ed25519 signature).
 *   - NO FORGING: a body that names a DIFFERENT agent is ignored — the persisted
 *     record carries the authenticated agent's id, not the forged one.
 *   - Anonymous writes are rejected (401).
 *   - Admin may write on behalf of another agent (body honored).
 *
 * The auth verdict is injected via getContext().request.tpsAgent /
 * tpsAgentIsAdmin — exactly what the non-rejecting gate sets after verifying the
 * signature (see auth-middleware.ts) and what resolveAgentAuth() reads.
 *
 * ── WorkspaceState.allowRead() + get() ownership scoping (memory-soul-read-
 * gate family fix, ops-oox7) ─────────────────────────────────────────────────
 * These tests are ADDED HERE (not a separate file) deliberately: this file
 * already `mock.module("@harperfast/harper", ...)` + dynamically imports
 * "../../resources/WorkspaceState.ts". bun runs every test/unit/ file in ONE
 * process and dynamic imports are cached by resolved path — a second file
 * doing the same mock+import would silently reuse whichever mock won the
 * import race (see memory-soul-read-gate.test.ts's doc comment for the full
 * mechanics of this collision class). Reusing this file's existing
 * mock/import avoids that entirely.
 */

import { mock, describe, it, expect, beforeEach } from "bun:test";

// Capture what each resource ultimately persists.
let workspacePut: any = null;
let orgEventPut: any = null;

// In-memory WorkspaceState store, keyed by id — backs get()/search() for the
// allowRead/get() ownership-scoping tests below. post()/put() still also set
// `workspacePut` for the pre-existing attribution tests.
let workspaceStore: Map<string, any>;

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

// Mock @harperfast/harper:
//   - databases.flair.WorkspaceState / OrgEvent are constructable base classes
//     (the resources do `class X extends databases.flair.X`).
//   - The base post()/put() capture their argument so we can assert attribution,
//     AND persist into workspaceStore so get()/search() ownership-scoping tests
//     have real records to scope against.
//   - resolveAgentAuth (in agent-auth.ts) also imports databases; its agent path
//     calls Agent.get / Agent.search, but our tests use the tpsAgent annotation
//     path which returns before touching those — so a thin stub is enough.
class BaseWorkspaceState {
  async post(content: any) {
    workspacePut = content;
    workspaceStore.set(content.id ?? `ws-${Math.random().toString(36).slice(2)}`, { ...content });
    return { ok: true, ...content };
  }
  async put(content: any) {
    workspacePut = content;
    workspaceStore.set(content.id, { ...content });
    return { ok: true, ...content };
  }
  async get(target: any) {
    const id = typeof target === "string" ? target : target?.id;
    return workspaceStore.get(id) ?? null;
  }
  async search(query: any) {
    const conditions = Array.isArray(query) ? query : Array.isArray(query?.conditions) ? query.conditions : [];
    let records = Array.from(workspaceStore.values());
    for (const cond of conditions) records = records.filter((r) => matchesCondition(r, cond));
    async function* gen() {
      for (const r of records) yield r;
    }
    return gen();
  }
  async delete(id: any) { workspaceStore.delete(id); return { ok: true }; }
}
class BaseOrgEvent {
  async put(content: any) { orgEventPut = content; return { ok: true, ...content }; }
  async get(_id: any) { return null; }
  async delete(_id: any) { return { ok: true }; }
}

const databasesMock = {
  flair: {
    WorkspaceState: BaseWorkspaceState,
    OrgEvent: Object.assign(BaseOrgEvent, {
      // OrgEvent.post() calls `databases.flair.OrgEvent.put(content)` directly
      // (Harper-5 upsert), so the static put must capture too.
      put: async (content: any) => { orgEventPut = content; return { ok: true, ...content }; },
    }),
    Agent: { get: async () => null, search: async () => [] },
  },
};

mock.module("@harperfast/harper", () => ({ databases: databasesMock }));

const { WorkspaceState } = await import("../../resources/WorkspaceState.ts");
const { OrgEvent } = await import("../../resources/OrgEvent.ts");

// Build a resource instance whose getContext() returns the given auth context.
function makeWorkspace(ctxRequest: any) {
  const r: any = new (WorkspaceState as any)();
  r.getContext = () => ({ request: ctxRequest });
  return r;
}
function makeOrgEvent(ctxRequest: any) {
  const r: any = new (OrgEvent as any)();
  r.getContext = () => ({ request: ctxRequest });
  return r;
}

const agentCtx = (agentId: string, isAdmin = false) => ({ tpsAgent: agentId, tpsAgentIsAdmin: isAdmin });
const anonCtx = () => ({ tpsAnonymous: true });

beforeEach(() => {
  workspacePut = null;
  orgEventPut = null;
  workspaceStore = new Map();
});

describe("WorkspaceState.post() — agent-self attribution (no forging)", () => {
  it("attributes the record to the authenticated agent (from signature, not body)", async () => {
    const ws = makeWorkspace(agentCtx("agent-alpha"));
    await ws.post({ ref: "main", provider: "cli" });
    expect(workspacePut.agentId).toBe("agent-alpha");
  });

  it("NO FORGING: body agentId naming a DIFFERENT agent is overwritten with the authenticated id", async () => {
    const ws = makeWorkspace(agentCtx("agent-alpha"));
    await ws.post({ agentId: "agent-victim", ref: "main", provider: "cli" });
    // The forged agentId must NOT survive — persisted record is the real agent.
    expect(workspacePut.agentId).toBe("agent-alpha");
    expect(workspacePut.agentId).not.toBe("agent-victim");
  });

  it("anonymous write → 401 (and nothing persisted)", async () => {
    const ws = makeWorkspace(anonCtx());
    const res = await ws.post({ agentId: "agent-alpha", ref: "main", provider: "cli" });
    expect((res as Response).status).toBe(401);
    expect(workspacePut).toBeNull();
  });

  it("admin may write on behalf of another agent (body agentId honored)", async () => {
    const ws = makeWorkspace(agentCtx("admin-1", true));
    await ws.post({ agentId: "agent-beta", ref: "main", provider: "cli" });
    expect(workspacePut.agentId).toBe("agent-beta");
  });
});

describe("OrgEvent.post() — agent-self attribution (no forging)", () => {
  it("attributes the event to the authenticated agent (from signature, not body)", async () => {
    const oe = makeOrgEvent(agentCtx("agent-alpha"));
    await oe.post({ kind: "status", summary: "alive" });
    expect(orgEventPut.authorId).toBe("agent-alpha");
  });

  it("NO FORGING: body authorId naming a DIFFERENT agent is overwritten with the authenticated id", async () => {
    const oe = makeOrgEvent(agentCtx("agent-alpha"));
    await oe.post({ authorId: "agent-victim", kind: "coord.claim", summary: "spoof attempt" });
    // The forged authorId must NOT survive — event is attributed to the real agent.
    expect(orgEventPut.authorId).toBe("agent-alpha");
    expect(orgEventPut.authorId).not.toBe("agent-victim");
  });

  it("anonymous write → 401 (and nothing persisted)", async () => {
    const oe = makeOrgEvent(anonCtx());
    const res = await oe.post({ authorId: "agent-alpha", kind: "status", summary: "x" });
    expect((res as Response).status).toBe(401);
    expect(orgEventPut).toBeNull();
  });

  it("admin may publish on behalf of another agent (body authorId honored)", async () => {
    const oe = makeOrgEvent(agentCtx("admin-1", true));
    await oe.post({ authorId: "agent-beta", kind: "status", summary: "x" });
    expect(orgEventPut.authorId).toBe("agent-beta");
  });

  it("generated id embeds the authenticated author (not the forged one)", async () => {
    const oe = makeOrgEvent(agentCtx("agent-alpha"));
    await oe.post({ authorId: "agent-victim", kind: "status", summary: "x" });
    expect(String(orgEventPut.id).startsWith("agent-alpha-")).toBe(true);
  });
});

// ─── WorkspaceState.allowRead + get() ownership scoping (ops-oox7) ──────────
//
// Regression guard for the family read-gate fix: WorkspaceState.ts previously
// gated post()/put()/delete() but never defined `allowRead()` nor overrode
// `get()`. Harper routes `GET /WorkspaceState/<id>` to get() and the
// collection-describe `GET /WorkspaceState` outside search(), so BOTH were
// ungated — an anonymous caller got a 200 with full record content.
describe("WorkspaceState.allowRead — closes the anonymous GET /WorkspaceState/<id> and describe leak", () => {
  it("anonymous is denied", async () => {
    const ws = makeWorkspace(anonCtx());
    expect(await (ws as any).allowRead()).toBe(false);
  });

  it("a verified non-admin agent is allowed (per-record scoping is in get())", async () => {
    const ws = makeWorkspace(agentCtx("agent-1"));
    expect(await (ws as any).allowRead()).toBe(true);
  });

  it("an admin agent is allowed", async () => {
    const ws = makeWorkspace(agentCtx("agent-admin", true));
    expect(await (ws as any).allowRead()).toBe(true);
  });

  it("an internal call (no request context) is allowed", async () => {
    const r: any = new (WorkspaceState as any)();
    r.getContext = () => undefined;
    expect(await r.allowRead()).toBe(true);
  });
});

describe("WorkspaceState.get() — anonymous denied, owner-scoped for non-admin, unfiltered for internal/admin", () => {
  it("anonymous get(<id>) → 404, never leaks record content", async () => {
    workspaceStore.set("ws-1", { id: "ws-1", agentId: "agent-owner", state: { secret: true } });
    const ws = makeWorkspace(anonCtx());
    const res = await (ws as any).get("ws-1");
    expect(res instanceof Response).toBe(true);
    expect((res as Response).status).toBe(404);
  });

  it("verified non-admin get() of ANOTHER agent's id → 404 (not 403 — no existence confirmation)", async () => {
    workspaceStore.set("ws-1", { id: "ws-1", agentId: "agent-owner", state: {} });
    const ws = makeWorkspace(agentCtx("agent-attacker"));
    const res = await (ws as any).get("ws-1");
    expect(res instanceof Response).toBe(true);
    expect((res as Response).status).toBe(404);
  });

  it("verified non-admin get() of ITS OWN id → returns the real record", async () => {
    workspaceStore.set("ws-1", { id: "ws-1", agentId: "agent-owner", state: { x: 1 } });
    const ws = makeWorkspace(agentCtx("agent-owner"));
    const res = await (ws as any).get("ws-1");
    expect(res instanceof Response).toBe(false);
    expect((res as any).state.x).toBe(1);
  });

  it("a non-existent id for a non-admin agent → 404", async () => {
    const ws = makeWorkspace(agentCtx("agent-owner"));
    const res = await (ws as any).get("does-not-exist");
    expect(res instanceof Response).toBe(true);
    expect((res as Response).status).toBe(404);
  });

  it("internal call (no request context) → returns any id unchanged", async () => {
    workspaceStore.set("ws-1", { id: "ws-1", agentId: "agent-owner", state: { secret: true } });
    const r: any = new (WorkspaceState as any)();
    r.getContext = () => undefined;
    const res = await r.get("ws-1");
    expect(res instanceof Response).toBe(false);
    expect((res as any).state.secret).toBe(true);
  });

  it("admin agent → returns any id unchanged, no ownership check", async () => {
    workspaceStore.set("ws-1", { id: "ws-1", agentId: "agent-owner", state: { secret: true } });
    const ws = makeWorkspace(agentCtx("agent-admin", true));
    const res = await (ws as any).get("ws-1");
    expect(res instanceof Response).toBe(false);
    expect((res as any).state.secret).toBe(true);
  });

  it("a collection/query target (isCollection: true) delegates to search(), never a raw super.get() over the whole set", async () => {
    workspaceStore.set("ws-own", { id: "ws-own", agentId: "agent-1", state: {} });
    workspaceStore.set("ws-other", { id: "ws-other", agentId: "agent-other", state: {} });
    const ws = makeWorkspace(agentCtx("agent-1"));
    // Real Harper passes a RequestTarget object with isCollection:true for the
    // bare-collection / query-string GET form — NOT a string id. Without the
    // isCollection branch in get(), this would flow into super.get(target),
    // which has no notion of a query and would behave unpredictably; the fix
    // routes it through search() instead, which scopes by agentId.
    const res: any = await (ws as any).get({ isCollection: true, conditions: [] });
    const results: any[] = [];
    for await (const r of res) results.push(r);
    expect(results.map((r) => r.id)).toEqual(["ws-own"]);
  });
});

describe("WorkspaceState.delete() — ownership check uses the raw record (super.get), not the new scoped get()", () => {
  it("owner can still delete its own workspace-state record", async () => {
    workspaceStore.set("ws-1", { id: "ws-1", agentId: "agent-owner" });
    const ws = makeWorkspace(agentCtx("agent-owner"));
    await (ws as any).delete("ws-1");
    expect(workspaceStore.has("ws-1")).toBe(false);
  });

  it("a non-admin cannot delete ANOTHER agent's workspace-state record (403, untouched)", async () => {
    workspaceStore.set("ws-1", { id: "ws-1", agentId: "agent-owner" });
    const ws = makeWorkspace(agentCtx("agent-attacker"));
    const res = await (ws as any).delete("ws-1");
    expect(res instanceof Response).toBe(true);
    expect((res as Response).status).toBe(403);
    expect(workspaceStore.has("ws-1")).toBe(true); // untouched
  });

  it("deleting a non-existent id is a clean no-op (not mis-routed into FORBIDDEN by the new get() override)", async () => {
    const ws = makeWorkspace(agentCtx("agent-owner"));
    const res = await (ws as any).delete("does-not-exist");
    // super.delete() on the mock always returns { ok: true } — asserting it's
    // NOT the FORBIDDEN Response proves delete() used super.get() (raw lookup,
    // null for a missing id), not this.get() (which would 404 a denied id as
    // a truthy Response and fall through into the ownership-mismatch branch).
    expect(res instanceof Response).toBe(false);
  });
});
