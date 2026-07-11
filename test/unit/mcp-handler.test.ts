/**
 * mcp-handler.test.ts — the Model-2 custom /mcp handler + sub→Agent resolution.
 *
 * These are the auth-critical assertions the integration harness can't make at
 * the unit level:
 *
 *   - tools/list returns EXACTLY the 11 curated tools (no raw CRUD, no extras).
 *   - sub → Agent resolution: an existing Credential(kind:"idp", idpSubject=sub)
 *     maps to its principalId; an unknown sub with JIT OFF is DENIED (not run as
 *     anonymous/admin); an unknown sub with JIT ON provisions a NON-admin agent.
 *   - tools/call scopes to the RESOLVED agent: the delegated handler receives a
 *     context whose request.tpsAgent is the resolved principalId — never the
 *     tool arguments (no forging).
 *   - a tools/call whose token has no sub, or an unresolvable sub, is denied.
 *   - unknown tool / bad JSON-RPC → proper errors.
 *
 * We mock @harperfast/harper (databases: Credential/Agent) AND the 7 delegated
 * handler modules, so each tool's invocation is capturable and we can assert the
 * exact agent context + args it forwards.
 */

import { mock, describe, it, expect, beforeEach, afterEach, afterAll } from "bun:test";

// ─── Capture state for the mocked handlers ───────────────────────────────────
let lastCall: { resource: string; ctx: any; args: any } | null = null;

// Each mocked handler records the delegation context (getContext via ctor arg2)
// and the args it was called with, then returns a marker so we can assert the
// dispatch reached the right tool.
function makeHandlerMock(resource: string, method: string) {
  return class {
    _ctx: any;
    constructor(_id: any, ctx: any) { this._ctx = ctx; }
    async [method](args: any) {
      lastCall = { resource, ctx: this._ctx, args };
      return { ok: true, resource, agentId: this._ctx?.request?.tpsAgent };
    }
  };
}

// Memory has post/get/delete on the same class.
class MemoryMock {
  _ctx: any;
  isCollection = false;
  constructor(_id: any, ctx: any) { this._ctx = ctx; }
  async post(args: any) { lastCall = { resource: "Memory.post", ctx: this._ctx, args }; return { ok: true, resource: "Memory.post", agentId: this._ctx?.request?.tpsAgent }; }
  async put(args: any) { lastCall = { resource: "Memory.put", ctx: this._ctx, args }; return { ok: true, resource: "Memory.put", agentId: this._ctx?.request?.tpsAgent }; }
  async get(id: any) {
    lastCall = { resource: "Memory.get", ctx: this._ctx, args: id };
    if (id === "missing-id") return null;
    return { id, agentId: this._ctx?.request?.tpsAgent, content: "existing content", ok: true, resource: "Memory.get" };
  }
  async delete(id: any) { lastCall = { resource: "Memory.delete", ctx: this._ctx, args: id }; return { ok: true, resource: "Memory.delete", agentId: this._ctx?.request?.tpsAgent }; }
}
class SoulMock {
  _ctx: any;
  isCollection = false;
  constructor(_id: any, ctx: any) { this._ctx = ctx; }
  async put(args: any) { lastCall = { resource: "Soul.put", ctx: this._ctx, args }; return { ok: true, resource: "Soul.put", agentId: this._ctx?.request?.tpsAgent }; }
  async get(id: any) { lastCall = { resource: "Soul.get", ctx: this._ctx, args: id }; return { ok: true, resource: "Soul.get", agentId: this._ctx?.request?.tpsAgent }; }
}

// ─── Mock @harperfast/harper: Credential + Agent tables ──────────────────────
// Configurable per-test via these mutable fixtures.
let credentials: any[] = [];
let agents: Record<string, any> = {};
const puts: { table: string; record: any }[] = [];

// Constructable no-op base classes so the REAL resource modules (which do
// `class X extends databases.flair.X` or `extends Resource`) link + load — we
// then OVERRIDE them via __setHandlers, so these bases are never actually hit by
// a tool call. They exist only to satisfy the import graph.
class NoopBase { constructor(_id?: any, _ctx?: any) {} }
const databasesMock = {
  flair: {
    Credential: Object.assign(class extends NoopBase {}, {
      search: async function* (_q: any) { for (const c of credentials) yield c; },
      put: async (r: any) => { puts.push({ table: "Credential", record: r }); return r; },
    }),
    Agent: Object.assign(class extends NoopBase {}, {
      get: async (id: string) => agents[id] ?? null,
      put: async (r: any) => { puts.push({ table: "Agent", record: r }); agents[r.id] = r; return r; },
    }),
    Memory: class extends NoopBase {},
    Soul: class extends NoopBase {},
    WorkspaceState: class extends NoopBase {},
    OrgEvent: Object.assign(class extends NoopBase {}, { put: async (r: any) => r }),
    MemoryGrant: { search: async function* () {} },
  },
};
// AttentionQuery.ts `extends Resource` (not a table subclass), so it needs no
// databasesMock.flair entry of its own — only __setHandlers below, same as
// SemanticSearch/BootstrapMemories.
mock.module("@harperfast/harper", () => ({ databases: databasesMock, Resource: NoopBase, server: { http: () => {} } }));

const { mcpHandler, resolveAgentFromSub } = await import("../../resources/mcp-handler.ts");
const { __setHandlers } = await import("../../resources/mcp-tools.ts");

// Inject capture doubles for the delegated handlers via the tools registry —
// NOT `mock.module` on the shared resources/*.ts (which is process-global in bun
// and would leak into every other test file). Restored in afterAll.
const restoreHandlers = __setHandlers({
  SemanticSearch: makeHandlerMock("SemanticSearch.post", "post"),
  Memory: MemoryMock,
  BootstrapMemories: makeHandlerMock("BootstrapMemories.post", "post"),
  Soul: SoulMock,
  WorkspaceState: makeHandlerMock("WorkspaceState.post", "post"),
  OrgEvent: makeHandlerMock("OrgEvent.post", "post"),
  AttentionQuery: makeHandlerMock("AttentionQuery.post", "post"),
});

// ─── Helpers ─────────────────────────────────────────────────────────────────
function post(body: any, mcp?: any) {
  return {
    method: "POST",
    mcp,
    text: async () => JSON.stringify(body),
  };
}
async function parse(res: any) {
  return res?.body ? JSON.parse(res.body) : res;
}

beforeEach(() => {
  lastCall = null;
  credentials = [];
  agents = {};
  puts.length = 0;
  delete process.env.FLAIR_MCP_JIT_PROVISION;
});
afterEach(() => {
  delete process.env.FLAIR_MCP_JIT_PROVISION;
});
afterAll(() => {
  restoreHandlers();
});

// ─── tools/list ──────────────────────────────────────────────────────────────
describe("tools/list — exactly the 11 curated tools", () => {
  it("returns exactly 11, matching the flair-mcp surface plus attention (flair#677), no raw CRUD mutators", async () => {
    const res = await mcpHandler(post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { sub: "s" }));
    const body = await parse(res);
    const names = body.result.tools.map((t: any) => t.name).sort();
    expect(names).toEqual([
      "attention",
      "bootstrap",
      "flair_orgevent",
      "flair_workspace_set",
      "memory_delete",
      "memory_get",
      "memory_search",
      "memory_store",
      "memory_update",
      "soul_get",
      "soul_set",
    ]);
    // No raw create_/delete_ resource mutators leaked in. (memory_update
    // itself is a curated semantic tool, not a raw `update_<resource>`
    // mutator — it's explicitly allow-listed here rather than excluded.)
    expect(names.some((n: string) => /^(create|delete)_/.test(n))).toBe(false);
  });
});

// ─── initialize / ping ───────────────────────────────────────────────────────
describe("protocol handshake", () => {
  it("initialize advertises tools capability", async () => {
    const res = await mcpHandler(post({ jsonrpc: "2.0", id: 1, method: "initialize" }, { sub: "s" }));
    const body = await parse(res);
    expect(body.result.capabilities.tools).toBeDefined();
    expect(body.result.serverInfo.name).toBe("flair");
  });
  it("ping → empty result", async () => {
    const res = await mcpHandler(post({ jsonrpc: "2.0", id: 2, method: "ping" }, { sub: "s" }));
    expect((await parse(res)).result).toEqual({});
  });
});

// ─── sub → Agent resolution ──────────────────────────────────────────────────
describe("resolveAgentFromSub", () => {
  it("existing idp Credential → its principalId", async () => {
    credentials = [{ principalId: "agt_alice", kind: "idp", idpSubject: "sub-alice", status: "active" }];
    const agent = await resolveAgentFromSub("sub-alice");
    expect(agent).toEqual({ agentId: "agt_alice", isAdmin: false });
  });

  it("admin Agent record → isAdmin true", async () => {
    credentials = [{ principalId: "agt_admin", kind: "idp", idpSubject: "sub-admin", status: "active" }];
    agents["agt_admin"] = { id: "agt_admin", admin: true };
    const agent = await resolveAgentFromSub("sub-admin");
    expect(agent).toEqual({ agentId: "agt_admin", isAdmin: true });
  });

  it("revoked Credential is skipped", async () => {
    credentials = [{ principalId: "agt_x", kind: "idp", idpSubject: "sub-x", status: "revoked" }];
    expect(await resolveAgentFromSub("sub-x")).toBeNull();
  });

  it("unknown sub, JIT OFF → null (DENY, no provisioning)", async () => {
    expect(await resolveAgentFromSub("nobody")).toBeNull();
    expect(puts).toHaveLength(0); // nothing created
  });

  it("unknown sub, JIT ON → provisions a NON-admin Agent + Credential", async () => {
    process.env.FLAIR_MCP_JIT_PROVISION = "1";
    const agent = await resolveAgentFromSub("fresh-sub");
    expect(agent).not.toBeNull();
    expect(agent!.isAdmin).toBe(false);
    // Created exactly one Agent + one Credential, both keyed to the sub.
    const agentPut = puts.find((p) => p.table === "Agent");
    const credPut = puts.find((p) => p.table === "Credential");
    expect(agentPut?.record.admin).toBe(false);
    expect(agentPut?.record.kind).toBe("agent");
    expect(credPut?.record.kind).toBe("idp");
    expect(credPut?.record.idpSubject).toBe("fresh-sub");
    expect(credPut?.record.principalId).toBe(agent!.agentId);
  });

  it("empty sub → null", async () => {
    expect(await resolveAgentFromSub("")).toBeNull();
  });
});

// ─── tools/call scoping ──────────────────────────────────────────────────────
describe("tools/call — scopes to the resolved agent (no forging)", () => {
  beforeEach(() => {
    credentials = [{ principalId: "agt_bob", kind: "idp", idpSubject: "sub-bob", status: "active" }];
  });

  it("memory_search delegates with request.tpsAgent = resolved id", async () => {
    const res = await mcpHandler(post(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "memory_search", arguments: { query: "hi", limit: 3 } } },
      { sub: "sub-bob" },
    ));
    const body = await parse(res);
    expect(lastCall?.resource).toBe("SemanticSearch.post");
    expect(lastCall?.ctx.request.tpsAgent).toBe("agt_bob");
    expect(lastCall?.args).toEqual({ q: "hi", limit: 3 });
    expect(body.result.structuredContent.agentId).toBe("agt_bob");
  });

  it("memory_store uses resolved agentId, ignores a forged body agentId", async () => {
    await mcpHandler(post(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "memory_store", arguments: { content: "x", agentId: "agt_victim" } } },
      { sub: "sub-bob" },
    ));
    // The tool sets agentId from the RESOLVED agent, not the (forged) arg.
    expect(lastCall?.resource).toBe("Memory.post");
    expect(lastCall?.args.agentId).toBe("agt_bob");
    expect(lastCall?.ctx.request.tpsAgent).toBe("agt_bob");
  });

  it("memory_update (default) reads then PUTs the same id, merging new content", async () => {
    await mcpHandler(post(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "memory_update", arguments: { id: "mem-1", content: "updated content" } } },
      { sub: "sub-bob" },
    ));
    expect(lastCall?.resource).toBe("Memory.put");
    expect(lastCall?.args.id).toBe("mem-1");
    expect(lastCall?.args.content).toBe("updated content");
    // Stale embedding must be cleared so the server regenerates it.
    expect(lastCall?.args).not.toHaveProperty("embedding");
  });

  it("memory_update (preserveHistory) POSTs a NEW id with supersedes = old id", async () => {
    await mcpHandler(post(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "memory_update", arguments: { id: "mem-1", content: "new version", preserveHistory: true } } },
      { sub: "sub-bob" },
    ));
    expect(lastCall?.resource).toBe("Memory.post");
    expect(lastCall?.args.id).not.toBe("mem-1");
    expect(lastCall?.args.supersedes).toBe("mem-1");
    expect(lastCall?.args.content).toBe("new version");
    expect(lastCall?.ctx.request.tpsAgent).toBe("agt_bob");
  });

  it("memory_update on a missing id returns a 404-shaped error, no write attempted", async () => {
    const res = await mcpHandler(post(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "memory_update", arguments: { id: "missing-id", content: "x" } } },
      { sub: "sub-bob" },
    ));
    const body = await parse(res);
    expect(lastCall?.resource).toBe("Memory.get");
    expect(body.result.isError).toBe(true);
    expect(body.result.structuredContent.status).toBe(404);
  });

  it("soul_set PUTs with id = agentId:key (so soul_get can find it)", async () => {
    await mcpHandler(post(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "soul_set", arguments: { key: "role", value: "cofounder" } } },
      { sub: "sub-bob" },
    ));
    expect(lastCall?.resource).toBe("Soul.put");
    expect(lastCall?.args.id).toBe("agt_bob:role");
    expect(lastCall?.args.agentId).toBe("agt_bob");
    expect(lastCall?.args.key).toBe("role");
  });

  it("flair_orgevent carries NO authorId in the body (attributed from identity)", async () => {
    await mcpHandler(post(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "flair_orgevent", arguments: { kind: "status", summary: "alive", targets: ["x"] } } },
      { sub: "sub-bob" },
    ));
    expect(lastCall?.resource).toBe("OrgEvent.post");
    expect(lastCall?.args).not.toHaveProperty("authorId");
    expect(lastCall?.args.targetIds).toEqual(["x"]);
    expect(lastCall?.ctx.request.tpsAgent).toBe("agt_bob");
  });

  it("flair_workspace_set carries NO agentId in the body", async () => {
    await mcpHandler(post(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "flair_workspace_set", arguments: { ref: "main", phase: "implement" } } },
      { sub: "sub-bob" },
    ));
    expect(lastCall?.resource).toBe("WorkspaceState.post");
    expect(lastCall?.args).not.toHaveProperty("agentId");
    expect(lastCall?.args.ref).toBe("main");
    expect(lastCall?.args.id).toBe("agt_bob:main");
  });

  it("attention (flair#677) delegates to AttentionQuery.post with the resolved agent's identity, forwarding entity + days only", async () => {
    await mcpHandler(post(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "attention", arguments: { entity: "repo:tpsdev-ai/flair", days: 14 } } },
      { sub: "sub-bob" },
    ));
    expect(lastCall?.resource).toBe("AttentionQuery.post");
    expect(lastCall?.args).toEqual({ entity: "repo:tpsdev-ai/flair", days: 14 });
    expect(lastCall?.ctx.request.tpsAgent).toBe("agt_bob");
  });
});

// ─── tools/call denial paths ─────────────────────────────────────────────────
describe("tools/call — denial", () => {
  it("no verified sub → denied, handler never invoked", async () => {
    const res = await mcpHandler(post(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "memory_search", arguments: { query: "x" } } },
      {}, // request.mcp present but no sub
    ));
    const body = await parse(res);
    expect(body.error).toBeDefined();
    expect(lastCall).toBeNull();
  });

  it("unresolvable sub (JIT off) → forbidden, handler never invoked", async () => {
    credentials = [];
    const res = await mcpHandler(post(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "memory_search", arguments: { query: "x" } } },
      { sub: "ghost" },
    ));
    const body = await parse(res);
    expect(body.error.message).toContain("not a provisioned flair agent");
    expect(lastCall).toBeNull();
  });

  it("unknown tool → invalid params, handler never invoked", async () => {
    const res = await mcpHandler(post(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "drop_all_tables", arguments: {} } },
      { sub: "sub-bob" },
    ));
    const body = await parse(res);
    expect(body.error.message).toContain("unknown tool");
    expect(lastCall).toBeNull();
  });
});

// ─── protocol errors ─────────────────────────────────────────────────────────
describe("protocol errors", () => {
  it("non-POST → 405", async () => {
    const res = await mcpHandler({ method: "GET", mcp: { sub: "s" } });
    expect(res.status).toBe(405);
  });
  it("invalid JSON → parse error", async () => {
    const res = await mcpHandler({ method: "POST", mcp: { sub: "s" }, text: async () => "{not json" });
    const body = await parse(res);
    expect(body.error.code).toBe(-32700);
  });
  it("non-JSON-RPC object → invalid request", async () => {
    const res = await mcpHandler(post({ hello: "world" }, { sub: "s" }));
    const body = await parse(res);
    expect(body.error.code).toBe(-32600);
  });
  it("unknown method → method not found", async () => {
    const res = await mcpHandler(post({ jsonrpc: "2.0", id: 9, method: "resources/list" }, { sub: "s" }));
    const body = await parse(res);
    expect(body.error.code).toBe(-32601);
  });
});
