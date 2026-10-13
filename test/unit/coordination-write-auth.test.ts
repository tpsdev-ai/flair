/**
 * coordination-write-auth.test.ts — Handler-level no-forge tests for the
 * coordination write surface (Kris #510).
 *
 * Exercises WorkspaceState.post() and OrgEvent.post() directly, mocking
 * harper so the resource classes load + their writes are capturable
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
 * gate family fix) ─────────────────────────────────────────────────
 * These tests are ADDED HERE (not a separate file) deliberately: this file
 * already `mock.module("harper", ...)` + dynamically imports
 * "../../resources/WorkspaceState.ts". bun runs every test/unit/ file in ONE
 * process and dynamic imports are cached by resolved path — a second file
 * doing the same mock+import would silently reuse whichever mock won the
 * import race (see memory-soul-read-gate.test.ts's doc comment for the full
 * mechanics of this collision class). Reusing this file's existing
 * mock/import avoids that entirely.
 */

import { mock, describe, it, expect, beforeEach, afterEach, setSystemTime } from "bun:test";

// Capture what each resource ultimately persists.
let workspacePut: any = null;
let orgEventPut: any = null;
let orgEventPatch: { id: unknown; content: any } | null = null;
const READ_FAILS_MARKER = "read-fails";

// In-memory OrgEvent store, keyed by id — backs OrgEvent.post()'s ownership read
// (`databases.flair.OrgEvent.get`) and static put().
let orgEventStore: Map<string, any>;

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

// Mock harper:
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
    // Respect query.operator — Harper combines top-level conditions with
    // the query's operator (default "and").
    const topLevel = Array.isArray(query) ? { conditions: query, operator: "and" } : query || {};
    const conds = Array.isArray(topLevel.conditions) ? topLevel.conditions : [];
    const op = topLevel.operator || "and";
    let records = Array.from(workspaceStore.values());
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
  async delete(id: any) { workspaceStore.delete(id); return true; }
  // Harper's table is static-callable (`databases.flair.WorkspaceState.get/delete`),
  // which is how the owner-delete confirmation reaches it (flair#2355).
  static get(target: any) { return new BaseWorkspaceState().get(target); }
  static delete(id: any) { workspaceStore.delete(id); return Promise.resolve(true); }
}
class BaseOrgEvent {
  async put(content: any) { orgEventPut = content; orgEventStore.set(content.id, { ...content }); return { ok: true, ...content }; }
  // A no-argument get() reads the row the instance addresses (Harper's loaded row).
  async get(id: any) { return orgEventStore.get(id ?? (this as any).getId?.()) ?? null; }
  async delete(id: any) { orgEventStore.delete(id); return { ok: true }; }
  // PATCH merges into the row the instance addresses, creating it when absent
  // (the table-patch-policy guard is not part of this mock).
  async patch(content: any) {
    const id = (this as any).getId?.();
    orgEventPatch = { id, content: { ...content } };
    orgEventStore.set(id, { ...(orgEventStore.get(id) ?? { id }), ...content });
    return undefined;
  }
  // OrgEvent.post() and the createdAt check read the stored row through the
  // static table call (`databases.flair.OrgEvent.get(id, {})`), which Harper
  // exposes. An id carrying READ_FAILS_MARKER makes that read reject.
  static get(id: any) {
    if (typeof id === "string" && id.includes(READ_FAILS_MARKER)) return Promise.reject(new Error("injected stored-row read failure"));
    return orgEventStore.get(id) ?? null;
  }
  static delete(id: any) { orgEventStore.delete(id); return Promise.resolve({ ok: true }); }
}

const databasesMock = {
  flair: {
    WorkspaceState: BaseWorkspaceState,
    OrgEvent: Object.assign(BaseOrgEvent, {
      // OrgEvent.post() calls `databases.flair.OrgEvent.put(content)` directly
      // (Harper-5 upsert), so the static put must capture AND persist too.
      put: async (content: any) => { orgEventPut = content; orgEventStore.set(content.id, { ...content }); return { ok: true, ...content }; },
    }),
    Agent: { get: async () => null, search: async () => [] },
  },
};

mock.module("harper", () => ({ server: { http: () => {}, getUser: async () => null }, databases: databasesMock, Resource: class {} }));

// Harper assigns `transaction` onto the global at load; the owner-delete
// confirmation (resources/owner-delete-recheck.ts) creates one when the caller
// has none. This mock's delete is not staged, so the stand-in just runs the cb.
(globalThis as any).transaction = (_ctx: any, cb: () => any) => cb();

const { WorkspaceState } = await import("../../resources/WorkspaceState.ts");
const { OrgEvent } = await import("../../resources/OrgEvent.ts");

// Build a resource instance whose getContext() returns the given auth context.
function makeWorkspace(ctxRequest: any) {
  const r: any = new (WorkspaceState as any)();
  r.getContext = () => ({ request: ctxRequest });
  return r;
}
function makeOrgEvent(ctxRequest: any, id?: string) {
  const r: any = new (OrgEvent as any)();
  r.getContext = () => ({ request: ctxRequest });
  if (id !== undefined) r.getId = () => id;
  return r;
}

const agentCtx = (agentId: string, isAdmin = false) => ({ tpsAgent: agentId, tpsAgentIsAdmin: isAdmin });
const anonCtx = () => ({ tpsAnonymous: true });

beforeEach(() => {
  workspacePut = null;
  orgEventPut = null;
  orgEventPatch = null;
  workspaceStore = new Map();
  orgEventStore = new Map();
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

// ─── OrgEvent.post() id ownership + collision-resistant ids (flair#2333 N2/H9) ───────────────
describe("OrgEvent.post() — refuses a non-admin POST for a row observed at the guard's lookup as owned by another agent (N2)", () => {
  it("refuses a POST for a row observed at the guard's lookup as owned by another agent", async () => {
    orgEventStore.set("owned-1", { id: "owned-1", authorId: "agent-a", kind: "status", summary: "original" });
    const oe = makeOrgEvent(agentCtx("agent-b"));
    const res = await oe.post({ id: "owned-1", kind: "coord.claim", summary: "overwrite attempt" });
    expect(res instanceof Response).toBe(true);
    expect((res as Response).status).toBe(403);
    expect(orgEventStore.get("owned-1").summary).toBe("original");
    expect(orgEventStore.get("owned-1").authorId).toBe("agent-a");
  });

  it("refuses a POST claiming the observed owner's authorId", async () => {
    orgEventStore.set("owned-2", { id: "owned-2", authorId: "agent-a", kind: "status", summary: "original" });
    const oe = makeOrgEvent(agentCtx("agent-b"));
    const res = await oe.post({ id: "owned-2", authorId: "agent-a", kind: "coord.claim", summary: "forged" });
    expect(res instanceof Response).toBe(true);
    expect((res as Response).status).toBe(403);
    expect(orgEventStore.get("owned-2").authorId).toBe("agent-a");
  });

  it("allows an agent to write an id it already owns", async () => {
    orgEventStore.set("mine-1", { id: "mine-1", authorId: "agent-b", kind: "status", summary: "before" });
    const oe = makeOrgEvent(agentCtx("agent-b"));
    const res = await oe.post({ id: "mine-1", kind: "status", summary: "after" });
    expect(res instanceof Response).toBe(false);
    expect(orgEventStore.get("mine-1").summary).toBe("after");
  });

  it("an admin may write an id owned by another agent", async () => {
    orgEventStore.set("owned-3", { id: "owned-3", authorId: "agent-a", kind: "status", summary: "original" });
    const oe = makeOrgEvent(agentCtx("admin-1", true));
    const res = await oe.post({ id: "owned-3", authorId: "agent-a", kind: "status", summary: "admin edit" });
    expect(res instanceof Response).toBe(false);
    expect(orgEventStore.get("owned-3").summary).toBe("admin edit");
  });
});

describe("OrgEvent.post() — avoids deterministic same-millisecond collisions (random UUID, H9)", () => {
  afterEach(() => { setSystemTime(); });

  it("avoids deterministic same-millisecond collisions (random UUID)", async () => {
    setSystemTime(new Date("2026-10-11T00:00:00.000Z"));
    const oe = makeOrgEvent(agentCtx("agent-alpha"));
    await oe.post({ kind: "status", summary: "first" });
    const first = String(orgEventPut.id);
    await oe.post({ kind: "status", summary: "second" });
    const second = String(orgEventPut.id);
    expect(second).not.toBe(first);
    expect(orgEventStore.size).toBe(2);
    expect([...orgEventStore.values()].map((r) => r.summary).sort()).toEqual(["first", "second"]);
  });
});

// ─── OrgEvent createdAt: assigned by the server on create; cannot be changed ──
describe("OrgEvent — the server assigns createdAt on create, it cannot be changed, and an id the check does not read is refused", () => {
  const SERVER_NOW = "2026-10-13T12:00:00.000Z";
  const STORED_AT = "2026-10-01T09:30:00.000Z";
  const FUTURE = "2099-01-01T00:00:00.000Z";
  const PAST = "2001-01-01T00:00:00.000Z";
  const seed = (id: string, authorId = "agent-alpha") =>
    orgEventStore.set(id, { id, authorId, kind: "status", summary: "stored", createdAt: STORED_AT });
  /** put() throws its createdAt refusal; this returns whatever the call settled to. */
  const settle = async (p: Promise<unknown>) => { try { return await p; } catch (e) { return e; } };
  const errorOf = async (res: unknown) => JSON.parse(await (res as Response).clone().text()).error;

  beforeEach(() => { setSystemTime(new Date(SERVER_NOW)); });
  afterEach(() => { setSystemTime(); });

  for (const [label, createdAt] of [["future", FUTURE], ["past", PAST]] as const) {
    it(`POST create with a ${label} createdAt stores the server time`, async () => {
      const res = await makeOrgEvent(agentCtx("agent-alpha")).post({ kind: "status", summary: "x", createdAt });
      expect(res instanceof Response).toBe(false);
      expect(orgEventPut.createdAt).toBe(SERVER_NOW);
    });

    it(`PUT create with a ${label} createdAt stores the server time`, async () => {
      const res = await settle(makeOrgEvent(agentCtx("agent-alpha"), "new-1").put({ id: "new-1", authorId: "agent-alpha", kind: "status", summary: "x", createdAt }));
      expect(res instanceof Response).toBe(false);
      expect(orgEventStore.get("new-1").createdAt).toBe(SERVER_NOW);
    });

    it(`an admin PUT create with a ${label} createdAt stores the server time`, async () => {
      const res = await settle(makeOrgEvent(agentCtx("admin-1", true), "new-2").put({ id: "new-2", authorId: "agent-beta", kind: "status", summary: "x", createdAt }));
      expect(res instanceof Response).toBe(false);
      expect(orgEventStore.get("new-2").createdAt).toBe(SERVER_NOW);
    });

    it(`an admin PATCH that creates a row with a ${label} createdAt stores the server time`, async () => {
      const res = await makeOrgEvent(agentCtx("admin-1", true), "new-3").patch({ authorId: "admin-1", kind: "status", summary: "x", createdAt });
      expect(res instanceof Response).toBe(false);
      expect(orgEventStore.get("new-3").createdAt).toBe(SERVER_NOW);
    });
  }

  it("POST to an existing own id without createdAt keeps the stored value", async () => {
    seed("own-1");
    const res = await makeOrgEvent(agentCtx("agent-alpha")).post({ id: "own-1", kind: "status", summary: "after" });
    expect(res instanceof Response).toBe(false);
    expect(orgEventStore.get("own-1")).toMatchObject({ summary: "after", createdAt: STORED_AT });
  });

  it("POST to an existing own id with a different createdAt is refused (409) and the row is unchanged", async () => {
    seed("own-2");
    const before = { ...orgEventStore.get("own-2") };
    const res = await makeOrgEvent(agentCtx("agent-alpha")).post({ id: "own-2", kind: "status", summary: "after", createdAt: PAST });
    expect((res as Response).status).toBe(409);
    expect(await errorOf(res)).toBe("created_at_immutable");
    expect(orgEventStore.get("own-2")).toEqual(before);
    expect(orgEventPut).toBeNull();
  });

  it("PUT update without createdAt keeps the stored value", async () => {
    seed("own-3");
    const res = await settle(makeOrgEvent(agentCtx("agent-alpha"), "own-3").put({ id: "own-3", authorId: "agent-alpha", kind: "status", summary: "after" }));
    expect(res instanceof Response).toBe(false);
    expect(orgEventStore.get("own-3")).toMatchObject({ summary: "after", createdAt: STORED_AT });
  });

  for (const [who, ctx] of [["an agent", agentCtx("agent-alpha")], ["an admin", agentCtx("admin-1", true)]] as const) {
    it(`PUT update by ${who} that changes createdAt is refused (409) and the row is unchanged`, async () => {
      seed("own-4");
      const before = { ...orgEventStore.get("own-4") };
      const res = await settle(makeOrgEvent(ctx, "own-4").put({ id: "own-4", authorId: "agent-alpha", kind: "status", summary: "after", createdAt: FUTURE }));
      expect(res).toBeInstanceOf(Response);
      expect((res as Response).status).toBe(409);
      expect(await errorOf(res)).toBe("created_at_immutable");
      expect(orgEventStore.get("own-4")).toEqual(before);
      expect(orgEventPut).toBeNull();
    });

    it(`PATCH by ${who} that changes createdAt is refused (409) and the row is unchanged`, async () => {
      seed("own-5");
      const before = { ...orgEventStore.get("own-5") };
      const res = await makeOrgEvent(ctx, "own-5").patch({ summary: "after", createdAt: PAST });
      expect((res as Response).status).toBe(409);
      expect(await errorOf(res)).toBe("created_at_immutable");
      expect(orgEventStore.get("own-5")).toEqual(before);
      expect(orgEventPatch).toBeNull();
    });
  }

  it("PATCH without createdAt keeps the stored value", async () => {
    seed("own-6");
    const res = await makeOrgEvent(agentCtx("agent-alpha"), "own-6").patch({ summary: "after" });
    expect(res instanceof Response).toBe(false);
    expect(orgEventPatch!.content).toEqual({ summary: "after" });
    expect(orgEventStore.get("own-6")).toMatchObject({ summary: "after", createdAt: STORED_AT });
  });

  it("an admin PUT of an array body applies the rule to each element under its own id", async () => {
    seed("arr-old", "admin-1");
    const created = await settle(makeOrgEvent(agentCtx("admin-1", true), "path-id").put([
      { id: "arr-new", authorId: "admin-1", kind: "status", summary: "x", createdAt: FUTURE },
      { id: "arr-old", authorId: "admin-1", kind: "status", summary: "y" },
    ]));
    expect(created instanceof Response).toBe(false);
    expect(orgEventPut.map((r: any) => r.createdAt)).toEqual([SERVER_NOW, STORED_AT]);

    orgEventPut = null;
    const before = { ...orgEventStore.get("arr-old") };
    const refused = await settle(makeOrgEvent(agentCtx("admin-1", true), "path-id").put([
      { id: "arr-new-2", authorId: "admin-1", kind: "status", summary: "x" },
      { id: "arr-old", authorId: "admin-1", kind: "status", summary: "z", createdAt: PAST },
    ]));
    expect((refused as Response).status).toBe(409);
    expect(orgEventPut).toBeNull();
    expect(orgEventStore.get("arr-old")).toEqual(before);
  });

  it("a write whose stored-event read fails is refused (503) and nothing is written", async () => {
    const id = `${READ_FAILS_MARKER}-1`;
    const admin = agentCtx("admin-1", true);
    const posted = await makeOrgEvent(admin).post({ id, authorId: "admin-1", kind: "status", summary: "x" });
    const put = await settle(makeOrgEvent(admin, id).put({ id, authorId: "admin-1", kind: "status", summary: "x" }));
    const patched = await makeOrgEvent(admin, id).patch({ summary: "x" });
    for (const res of [posted, put, patched]) {
      expect((res as Response).status).toBe(503);
      expect(await errorOf(res)).toBe("created_at_check_unavailable");
    }
    expect(orgEventPut).toBeNull();
    expect(orgEventPatch).toBeNull();
  });

  it("a record whose id the check does not read is refused with invalid_event_id (400) before any write", async () => {
    orgEventStore.set("", { id: "", authorId: "agent-alpha", kind: "status", summary: "stored", createdAt: STORED_AT });
    const before = { ...orgEventStore.get("") };
    for (const ctx of [agentCtx("agent-alpha"), agentCtx("admin-1", true)]) {
      const results = [
        // PUT naming the empty id, with createdAt changed and omitted.
        await settle(makeOrgEvent(ctx, "").put({ id: "", authorId: "agent-alpha", kind: "status", summary: "x", createdAt: PAST })),
        await settle(makeOrgEvent(ctx, "").put({ id: "", authorId: "agent-alpha", kind: "status", summary: "x" })),
        // An array body with one such element refuses the whole write (an
        // array body reaches this check only for an administrator; a non-admin
        // agent's is refused earlier by attribution).
        ...(ctx.tpsAgentIsAdmin ? [await settle(makeOrgEvent(ctx, "arr-path").put([
          { id: "ok-new", authorId: "agent-alpha", kind: "status", summary: "x" },
          { id: "", authorId: "agent-alpha", kind: "status", summary: "x" },
        ]))] : []),
        // POST naming an id that is not a non-empty string or array of strings.
        await makeOrgEvent(ctx).post({ id: [], authorId: "agent-alpha", kind: "status", summary: "x" }),
        // PATCH of the empty id, and of a resource with no id.
        await makeOrgEvent(ctx, "").patch({ summary: "x", createdAt: PAST }),
        await makeOrgEvent(ctx).patch({ summary: "x" }),
      ];
      for (const res of results) {
        expect((res as Response).status).toBe(400);
        expect(await errorOf(res)).toBe("invalid_event_id");
      }
    }
    expect(orgEventPut).toBeNull();
    expect(orgEventPatch).toBeNull();
    expect(orgEventStore.get("")).toEqual(before);
    expect(orgEventStore.has("ok-new")).toBe(false);
  });

  it("an internal call keeps the createdAt it supplies on PUT and PATCH; POST stamps the server time", async () => {
    seed("int-1");
    const internal = (id?: string) => {
      const r: any = new (OrgEvent as any)();
      r.getContext = () => undefined;
      if (id !== undefined) r.getId = () => id;
      return r;
    };
    await internal("int-2").put({ id: "int-2", authorId: "flair-migrations", kind: "migration", summary: "x", createdAt: PAST });
    expect(orgEventStore.get("int-2").createdAt).toBe(PAST);
    await internal("int-1").patch({ createdAt: FUTURE });
    expect(orgEventStore.get("int-1").createdAt).toBe(FUTURE);
    await internal().post({ authorId: "flair-migrations", kind: "migration", summary: "y", createdAt: PAST });
    expect(orgEventPut.createdAt).toBe(SERVER_NOW);
  });
});

// ─── WorkspaceState.allowRead + get() ownership scoping (read-gate family fix) ──
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
    // super.delete() on the mock returns true and is not the FORBIDDEN Response:
    // no forbidden Response came back. This observes the outcome only — it does
    // not by itself prove which get() ran.
    expect(res instanceof Response).toBe(false);
  });
});

// ─── Boolean-injection guard (authz-hardening slice 2a) ────────────────────

describe("WorkspaceState.search() — boolean-injection guard (authz-hardening slice 2a)", () => {
  it("a non-admin agent's search() cannot use operator:'or' + wildcard to see another agent's workspace records", async () => {
    workspaceStore.set("ws-mine", { id: "ws-mine", agentId: "agent-1", ref: "main" });
    workspaceStore.set("ws-theirs", { id: "ws-theirs", agentId: "agent-2", ref: "main" });

    const ws = makeWorkspace(agentCtx("agent-1"));

    // A malicious caller supplies a condition that matches EVERY row (no
    // record's agentId equals this sentinel) combined with operator:"or",
    // hoping the "or" escapes to the top level and unions in every agent's
    // rows.  The owner condition is always the outermost AND — the attacker's
    // wildcard+"or" stays trapped inside a nested group that itself must
    // still satisfy the AND, so it can only ever narrow the caller's OWN
    // rows, never broaden past them.
    const res: any = await ws.search({
      conditions: [{ attribute: "agentId", comparator: "not_equal", value: "no-such-agent-sentinel" }],
      operator: "or",
    });
    const results: any[] = [];
    for await (const rec of res) results.push(rec);
    expect(results.map((rec) => rec.id)).toEqual(["ws-mine"]);
  });

  it("a non-admin agent sees only own workspace records with a normal scoped search", async () => {
    workspaceStore.set("ws-mine", { id: "ws-mine", agentId: "agent-1" });
    workspaceStore.set("ws-theirs", { id: "ws-theirs", agentId: "agent-2" });

    const ws = makeWorkspace(agentCtx("agent-1"));
    const res: any = await ws.search({ conditions: [] });
    const results: any[] = [];
    for await (const rec of res) results.push(rec);
    expect(results.map((rec) => rec.id)).toEqual(["ws-mine"]);
  });

  it("an admin agent sees all workspace records, unfiltered", async () => {
    workspaceStore.set("ws-mine", { id: "ws-mine", agentId: "agent-1" });
    workspaceStore.set("ws-theirs", { id: "ws-theirs", agentId: "agent-2" });

    const ws = makeWorkspace(agentCtx("agent-admin", true));
    const res: any = await ws.search({ conditions: [] });
    const results: any[] = [];
    for await (const rec of res) results.push(rec);
    expect(results.map((rec) => rec.id).sort()).toEqual(["ws-mine", "ws-theirs"]);
  });

  it("anonymous is denied with 401", async () => {
    workspaceStore.set("ws-1", { id: "ws-1", agentId: "agent-1" });
    const ws = makeWorkspace(anonCtx());
    const res: any = await ws.search({ conditions: [] });
    expect(res instanceof Response).toBe(true);
    expect((res as Response).status).toBe(401);
  });
});

// ─── MUTATION-CHECK NOTE ────────────────────────────────────────────────────
// The boolean-injection test above was manually mutation-tested during
// development: temporarily reverting WorkspaceState.search() to the flat
// prepend — `query.conditions = [agentIdCondition, ...existing]` — made the
// test FAIL (observed "ws-theirs" in the result), confirming the guard is
// not vacuously true.  Reverted before commit.
