/**
 * mcp-handler.test.ts — the Model-2 custom /mcp handler + sub→Agent resolution.
 *
 * These are the auth-critical assertions the integration harness can't make at
 * the unit level:
 *
 *   - tools/list returns EXACTLY the 12 curated tools (no raw CRUD, no extras).
 *   - sub → Agent resolution: an existing Credential(kind:"idp", idpSubject=sub)
 *     maps to its principalId; an unknown sub with JIT OFF is DENIED (not run as
 *     anonymous/admin); an unknown sub with JIT ON provisions a NON-admin agent.
 *   - tools/call scopes to the RESOLVED agent: the delegated handler receives a
 *     context whose request.tpsAgent is the resolved principalId — never the
 *     tool arguments (no forging).
 *   - a tools/call whose token has no sub, or an unresolvable sub, is denied.
 *   - unknown tool / bad JSON-RPC → proper errors.
 *
 * We mock harper (databases: Credential/Agent) AND the 7 delegated
 * handler modules, so each tool's invocation is capturable and we can assert the
 * exact agent context + args it forwards.
 */

import { mock, describe, it, expect, beforeEach, afterEach, afterAll } from "bun:test";

// ─── Capture state for the mocked handlers ───────────────────────────────────
let lastCall: { resource: string; ctx: any; args: any } | null = null;

/**
 * Base for every capture double, shaped like Harper's real `Resource` on the
 * two points that decide whether an in-process delegation works at all:
 *
 *   - `isCollection` is a GETTER WITH NO SETTER on the prototype, backed by a
 *     PRIVATE field. Assigning to it from outside throws under ESM's strict
 *     mode — exactly what the real class does. The doubles previously carried a
 *     public `isCollection = false` data field, which silently ACCEPTED the
 *     assignment mcp-tools.ts used to make and let the whole suite pass green
 *     while `memory_store`/`memory_update`/`workspace_set`/`orgevent` threw
 *     `TypeError: Cannot set property isCollection …` against a real Harper.
 *   - `static getResource(target, context, options)` is the only way to obtain
 *     a collection-bound instance, mirroring Harper's own signature — which is
 *     what resources/in-process.ts's collectionResource() calls.
 *
 * Keep both properties. A double that is easier to satisfy than the real class
 * cannot catch this class of bug.
 */
class HarperShapedBase {
  #collection = false;
  _ctx: any;
  constructor(_id: any, ctx: any) { this._ctx = ctx; }
  get isCollection() { return this.#collection; }
  static getResource(_target: any, ctx: any, options?: any) {
    const r = new (this as any)(undefined, ctx) as HarperShapedBase;
    if (options?.isCollection) r.#collection = true;
    return r;
  }
}

// Each mocked handler records the delegation context (getContext via ctor arg2)
// and the args it was called with, then returns a marker so we can assert the
// dispatch reached the right tool.
function makeHandlerMock(resource: string, method: string) {
  return class extends HarperShapedBase {
    async [method](args: any) {
      lastCall = { resource, ctx: this._ctx, args };
      return { ok: true, resource, agentId: this._ctx?.request?.tpsAgent };
    }
  };
}

// Memory has post/get/delete on the same class.
//
// flair#1181 — the by-id read/delete doubles are shaped like Harper's REAL
// static-vs-instance split, because the divergence between them IS the bug:
//   - STATIC `Cls.get(target, ctx)` / `Cls.delete(target, ctx)` is the
//     transactional wrapper the fixed tools call. It loads the row and hands
//     the override a RequestTarget (never a bare string), then returns the
//     loaded record. This is also the Ed25519 REST path.
//   - INSTANCE `.get(<string>)` on an UNLOADED record (tables leave
//     `loadAsInstance` at its `undefined` default) routes to `getProperty()` —
//     a field accessor — and returns `undefined`. That is the #1181 404: the
//     read never loads the row, so makeByIdReadGate's `!record` branch fires
//     on the caller's OWN record. The fixed tools no longer call the instance
//     form; this faithful shape makes any regression back to
//     `new Cls(undefined, ctx).get(id)` fail loudly (undefined → 404).
// A double whose instance-get returns canned data (as this one used to) is
// easier to satisfy than the real class and cannot catch this class of bug.
class MemoryMock extends HarperShapedBase {
  async post(args: any) { lastCall = { resource: "Memory.post", ctx: this._ctx, args, isCollection: this.isCollection } as any; return { ok: true, resource: "Memory.post", agentId: this._ctx?.request?.tpsAgent }; }
  // flair#1181 — the default memory_update merge now writes via the STATIC
  // `Cls.put(merged, ctx)` transactional path (the instance put on an unloaded
  // `new Cls(undefined, ctx)` throws "Invalid primary key type: undefined").
  // The instance put below is left for faithfulness but is no longer reached.
  static async put(record: any, ctx: any) { lastCall = { resource: "Memory.put", ctx, args: record }; return { ok: true, resource: "Memory.put", agentId: ctx?.request?.tpsAgent }; }
  async put(args: any) { lastCall = { resource: "Memory.put#instance", ctx: this._ctx, args }; return { ok: true, resource: "Memory.put#instance", agentId: this._ctx?.request?.tpsAgent }; }
  static async get(target: any, ctx: any) {
    const id = typeof target === "string" ? target : target?.id;
    lastCall = { resource: "Memory.get", ctx, args: id };
    if (id === "missing-id") return null;
    // flair#1188 — a real by-id load returns the FULL stored row, INCLUDING the
    // raw `embedding` vector. Modeled here so memory_get's default-strip (and
    // its includeEmbedding opt-in) is exercised against a record that actually
    // carries the vector, not a double that quietly lacks it.
    const rec: any = { id, agentId: ctx?.request?.tpsAgent, content: "existing content", ok: true, resource: "Memory.get", embedding: [0.11, 0.22, 0.33] };
    // includeTrust is folded into the RequestTarget as a plain property by the
    // fixed memory_get (static Cls.get has no opts slot); Memory.get()'s
    // wantsTrust() reads it there and attachTrust() stamps a `trust` block.
    if (target && typeof target === "object" && target.includeTrust === true) rec.trust = { tier: "unverified" };
    return rec;
  }
  static async delete(target: any, ctx: any) {
    const id = typeof target === "string" ? target : target?.id;
    lastCall = { resource: "Memory.delete", ctx, args: id };
    return { ok: true, resource: "Memory.delete", agentId: ctx?.request?.tpsAgent };
  }
  // The #1181 bug, modeled: instance get(<string>) → getProperty → undefined.
  async get(target: any) { lastCall = { resource: "Memory.get#instance-getProperty", ctx: this._ctx, args: target }; return undefined; }
}
class SoulMock extends HarperShapedBase {
  // flair#1181 — soul_set now writes through a COLLECTION-bound `post()`
  // (collectionResource(Cls, ctx).post(...)), the same create path as
  // memory_store / workspace_set / orgevent. `isCollection` is recorded so a
  // regression to a bare `new Cls(undefined, ctx).post()` (isCollection false →
  // 405 against real Harper) or back to the unloaded-instance `put()` (throws
  // "Invalid primary key type: undefined") fails this test loudly.
  async post(args: any) { lastCall = { resource: "Soul.post", ctx: this._ctx, args, isCollection: this.isCollection } as any; return { ok: true, resource: "Soul.post", agentId: this._ctx?.request?.tpsAgent }; }
  // The pre-#1181 instance put — left for faithfulness, no longer reached.
  async put(args: any) { lastCall = { resource: "Soul.put#instance", ctx: this._ctx, args }; return { ok: true, resource: "Soul.put#instance", agentId: this._ctx?.request?.tpsAgent }; }
  static async get(target: any, ctx: any) {
    const id = typeof target === "string" ? target : target?.id;
    lastCall = { resource: "Soul.get", ctx, args: id };
    return { ok: true, resource: "Soul.get", id, agentId: ctx?.request?.tpsAgent };
  }
  // The #1181 bug, modeled: instance get(<string>) → getProperty → undefined.
  async get(target: any) { lastCall = { resource: "Soul.get#instance-getProperty", ctx: this._ctx, args: target }; return undefined; }
}

// ─── Mock harper: Credential + Agent tables ──────────────────────
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
mock.module("harper", () => ({ databases: databasesMock, Resource: NoopBase, server: { http: () => {}, getUser: async () => null } }));

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
  RecordUsage: makeHandlerMock("RecordUsage.post", "post"),
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
describe("tools/list — exactly the 12 curated tools", () => {
  it("returns exactly 12, matching the flair-mcp surface plus attention (flair#677) + record_usage (flair#683), no raw CRUD mutators", async () => {
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
      "record_usage",
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
  it("initialize returns the real package version, not a hardcoded string", async () => {
    const res = await mcpHandler(post({ jsonrpc: "2.0", id: 1, method: "initialize" }, { sub: "s" }));
    const body = await parse(res);
    expect(body.result.serverInfo.name).toBe("flair");
    // Must be a semver-like string (e.g. "0.33.0"), not the old hardcoded "0.1.0".
    expect(body.result.serverInfo.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(body.result.serverInfo.version).not.toBe("0.1.0");
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
    agents["agt_admin"] = { id: "agt_admin", role: "admin", admin: true };
    const agent = await resolveAgentFromSub("sub-admin");
    expect(agent).toEqual({ agentId: "agt_admin", isAdmin: true });
  });

  // flair#941 — this surface used to OR the two admin fields together while the
  // primary HTTP gate read only `role`, so the SAME record was an administrator
  // here and an ordinary agent there. Both now resolve through the one shared
  // predicate. A record carrying only the `admin` mirror was never an admin on
  // the HTTP gate, and is no longer one here either.
  it("a record carrying ONLY the admin mirror is NOT an admin — both surfaces agree", async () => {
    credentials = [{ principalId: "agt_mirror", kind: "idp", idpSubject: "sub-mirror", status: "active" }];
    agents["agt_mirror"] = { id: "agt_mirror", admin: true };
    const agent = await resolveAgentFromSub("sub-mirror");
    expect(agent).toEqual({ agentId: "agt_mirror", isAdmin: false });
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

  // ─── flair#718 authorship-provenance: clientId threading ──────────────────
  it("no clientId passed → resolved agent has NO clientId property at all (not stamped as undefined)", async () => {
    credentials = [{ principalId: "agt_alice", kind: "idp", idpSubject: "sub-alice", status: "active" }];
    const agent = await resolveAgentFromSub("sub-alice");
    expect(agent).toEqual({ agentId: "agt_alice", isAdmin: false });
    expect("clientId" in (agent as any)).toBe(false);
  });

  it("clientId passed → copied onto the resolved agent unchanged (existing-credential path)", async () => {
    credentials = [{ principalId: "agt_alice", kind: "idp", idpSubject: "sub-alice", status: "active" }];
    const agent = await resolveAgentFromSub("sub-alice", "flair_cl_abc123");
    expect(agent).toEqual({ agentId: "agt_alice", isAdmin: false, clientId: "flair_cl_abc123" });
  });

  it("clientId passed on the JIT-provision path is also copied onto the resolved agent", async () => {
    process.env.FLAIR_MCP_JIT_PROVISION = "1";
    const agent = await resolveAgentFromSub("fresh-sub-2", "flair_cl_jit");
    expect(agent?.clientId).toBe("flair_cl_jit");
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

  it("bootstrap response includes flairVersion (flair#831)", async () => {
    const res = await mcpHandler(post(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "bootstrap", arguments: {} } },
      { sub: "sub-bob" },
    ));
    const body = await parse(res);
    // The delegated request body must NOT carry flairVersion — the
    // documented invariant is that a plain bootstrap delegates a
    // byte-identical body (includeTrust/abstain are opt-in only).
    expect(lastCall?.args).not.toHaveProperty("flairVersion");
    // The RESPONSE is where the agent learns the server version.
    expect(body.result.structuredContent).toHaveProperty("flairVersion");
    expect(typeof body.result.structuredContent.flairVersion).toBe("string");
    expect(body.result.structuredContent.flairVersion.length).toBeGreaterThan(0);
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

  // ─── flair#991: writer-controlled visibility on the native /mcp surface ────
  //
  // Before this, `grep -c visibility resources/mcp-tools.ts` returned 0: an
  // agent on the built-in /mcp endpoint could not express sharing intent at
  // all, so every memory it wrote took the durability-keyed default (private
  // for the standard durability memory_store sends) with no argument able to
  // change it. The whole writer-controlled sharing model was unreachable from
  // the surface, while packages/flair-mcp's stdio server exposed it fine.
  describe("flair#991 — memory_store carries writer-controlled visibility", () => {
    it("advertises visibility on the tools/list schema, enumerated to the two implemented values", async () => {
      const res = await mcpHandler(post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { sub: "s" }));
      const body = await parse(res);
      const store = body.result.tools.find((t: any) => t.name === "memory_store");
      const vis = store.inputSchema.properties.visibility;
      expect(vis).toBeDefined();
      // The enum is the discoverability half: an agent reading the schema
      // must not have to guess that "office"/"public" are not tiers.
      expect(vis.enum).toEqual(["private", "shared"]);
      // The durability-keyed default is the thing a caller cannot infer from
      // anywhere else, so the describe string has to name it.
      expect(vis.description).toContain("permanent/persistent -> shared");
      expect(vis.description).toContain("standard/ephemeral -> private");
      // visibility must stay OPTIONAL — requiring it would break every
      // existing caller and force a decision the server already makes well.
      expect(store.inputSchema.required).toEqual(["content"]);
    });

    it("forwards visibility: shared to the Memory write body", async () => {
      await mcpHandler(post(
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "memory_store", arguments: { content: "a team-visible note", visibility: "shared" } } },
        { sub: "sub-bob" },
      ));
      expect(lastCall?.resource).toBe("Memory.post");
      expect(lastCall?.args.visibility).toBe("shared");
    });

    it("forwards visibility: private to the Memory write body", async () => {
      await mcpHandler(post(
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "memory_store", arguments: { content: "an owner-only note", visibility: "private" } } },
        { sub: "sub-bob" },
      ));
      expect(lastCall?.args.visibility).toBe("private");
    });

    it("omitting visibility leaves it absent from the body entirely (server applies its durability-keyed default)", async () => {
      await mcpHandler(post(
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "memory_store", arguments: { content: "no sharing intent expressed" } } },
        { sub: "sub-bob" },
      ));
      expect(lastCall?.resource).toBe("Memory.post");
      // Not `undefined` — absent. A key present with an undefined value would
      // still be a body change for a call that expressed no intent.
      expect(lastCall?.args).not.toHaveProperty("visibility");
    });

    // ── A typo must never widen who can read a memory ──────────────────────
    // isPrivateVisibility() is an exact match on "private", so every other
    // string reads as non-private and goes to every agent on the instance.
    // Forwarding an unrecognized value writes an org-readable row the caller
    // believes is owner-only; silently dropping it falls back to the
    // durability default, which for a permanent write is `shared` — the same
    // outcome with nothing left in the record to explain it. Reject.
    for (const bad of ["prvate", "office", "public", "Private", "", 1, true]) {
      it(`rejects visibility ${JSON.stringify(bad)} and performs no write`, async () => {
        lastCall = null;
        const res = await mcpHandler(post(
          { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "memory_store", arguments: { content: "misspelled sharing intent", visibility: bad } } },
          { sub: "sub-bob" },
        ));
        const body = await parse(res);
        const payload = body.result.structuredContent ?? body.result;
        expect(JSON.stringify(payload)).toContain("invalid_visibility");
        // The load-bearing half: nothing reached the Memory resource. A guard
        // that reports an error AFTER writing has prevented nothing.
        expect(lastCall).toBeNull();
      });
    }

    it("an explicit visibility: null is treated as 'no intent expressed', not as an invalid value", async () => {
      await mcpHandler(post(
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "memory_store", arguments: { content: "explicit null", visibility: null } } },
        { sub: "sub-bob" },
      ));
      expect(lastCall?.resource).toBe("Memory.post");
      expect(lastCall?.args).not.toHaveProperty("visibility");
    });
  });

  // ─── flair#718 authorship-provenance: OAuth client_id → claimedClient ──────
  describe("flair#718 authorship-provenance — claimedClient stamped from the OAuth token's client_id", () => {
    it("memory_store: request.mcp.client_id flows into the body as claimedClient", async () => {
      await mcpHandler(post(
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "memory_store", arguments: { content: "hi" } } },
        { sub: "sub-bob", client_id: "flair_cl_abc123" },
      ));
      expect(lastCall?.resource).toBe("Memory.post");
      expect(lastCall?.args.claimedClient).toBe("flair_cl_abc123");
    });

    it("memory_store: NO client_id on the token → claimedClient is absent from the body entirely (not undefined)", async () => {
      await mcpHandler(post(
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "memory_store", arguments: { content: "hi" } } },
        { sub: "sub-bob" },
      ));
      expect(lastCall?.resource).toBe("Memory.post");
      expect(lastCall?.args).not.toHaveProperty("claimedClient");
    });

    it("memory_store: `client_name` on the token is NEVER used — only `client_id` (Sherlock flair#718 binding refinement)", async () => {
      await mcpHandler(post(
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "memory_store", arguments: { content: "hi" } } },
        { sub: "sub-bob", client_name: "My Pretty Claude Desktop" },
      ));
      expect(lastCall?.args).not.toHaveProperty("claimedClient");
    });

    it("memory_store: a non-string client_id on the token is ignored, not coerced/forwarded", async () => {
      await mcpHandler(post(
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "memory_store", arguments: { content: "hi" } } },
        { sub: "sub-bob", client_id: 12345 },
      ));
      expect(lastCall?.args).not.toHaveProperty("claimedClient");
    });

    it("memory_update (default mode): client_id flows into the PUT body as claimedClient", async () => {
      await mcpHandler(post(
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "memory_update", arguments: { id: "mem-1", content: "updated" } } },
        { sub: "sub-bob", client_id: "flair_cl_def456" },
      ));
      expect(lastCall?.resource).toBe("Memory.put");
      expect(lastCall?.args.claimedClient).toBe("flair_cl_def456");
    });

    it("memory_update (preserveHistory mode): client_id flows into the new-version POST body as claimedClient", async () => {
      await mcpHandler(post(
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "memory_update", arguments: { id: "mem-1", content: "new version", preserveHistory: true } } },
        { sub: "sub-bob", client_id: "flair_cl_ghi789" },
      ));
      expect(lastCall?.resource).toBe("Memory.post");
      expect(lastCall?.args.claimedClient).toBe("flair_cl_ghi789");
    });

    it("a body-supplied claimedClient argument (forgery attempt) is ignored — only the resolved token's client_id is used", async () => {
      await mcpHandler(post(
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "memory_store", arguments: { content: "hi", claimedClient: "forged-client" } } },
        { sub: "sub-bob", client_id: "flair_cl_real" },
      ));
      expect(lastCall?.args.claimedClient).toBe("flair_cl_real");
    });
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

  // ─── flair#1181 — by-id reads use the STATIC Cls.get/delete, not an
  // instance new Cls(undefined, ctx).get(id) that getProperty's to undefined ──
  //
  // These are the tool surfaces the connector 404'd on (memory_get, soul_get)
  // or that silently mis-behaved (memory_delete's permanent-guard skipped)
  // because the read never loaded the row. The doubles above are shaped like
  // real Harper (static loads the row; instance-get(<string>) → undefined), so
  // a regression back to the instance pattern fails here. The cross-agent
  // scope proof (own-only, no widening) is in the real-gate integration test
  // test/integration/mcp-byid-read-static-pattern — the double replaces the
  // gate, so scope can only be pinned against a real Memory + makeByIdReadGate.
  it("memory_get (flair#1181) returns the caller's OWN record via the STATIC by-id read, not a 404", async () => {
    const res = await mcpHandler(post(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "memory_get", arguments: { id: "mem-own-1" } } },
      { sub: "sub-bob" },
    ));
    const body = await parse(res);
    // Dispatched to the STATIC load (resource marker set only by the static get).
    expect(lastCall?.resource).toBe("Memory.get");
    expect(lastCall?.args).toBe("mem-own-1");
    expect(body.result.isError).toBeFalsy();
    expect(body.result.structuredContent.id).toBe("mem-own-1");
    // Scoped to the caller — identity comes from the resolved agent, never args.
    expect(body.result.structuredContent.agentId).toBe("agt_bob");
    expect(body.result.structuredContent.content).toBe("existing content");
    // flair#1188 — the raw embedding vector is stripped from the default
    // response (it is thousands of noise tokens on a chat surface).
    expect(body.result.structuredContent).not.toHaveProperty("embedding");
  });

  it("memory_get omits the embedding by default but returns it when includeEmbedding=true (flair#1188)", async () => {
    // Default: stripped (asserted in the test above). Opt-in: present.
    const res = await mcpHandler(post(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "memory_get", arguments: { id: "mem-own-1", includeEmbedding: true } } },
      { sub: "sub-bob" },
    ));
    const body = await parse(res);
    expect(body.result.isError).toBeFalsy();
    expect(body.result.structuredContent.id).toBe("mem-own-1");
    // The vector is included only because the caller explicitly asked for it.
    expect(Array.isArray(body.result.structuredContent.embedding)).toBe(true);
    expect(body.result.structuredContent.embedding).toEqual([0.11, 0.22, 0.33]);
  });

  it("memory_get with includeTrust folds the flag into the RequestTarget so the trust block survives (flair#1181/#744)", async () => {
    const res = await mcpHandler(post(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "memory_get", arguments: { id: "mem-own-1", includeTrust: true } } },
      { sub: "sub-bob" },
    ));
    const body = await parse(res);
    // The static Cls.get has no opts slot; includeTrust must arrive as a plain
    // property on the target object, which Memory.get()'s wantsTrust() reads.
    expect(body.result.structuredContent.trust).toBeDefined();
    expect(body.result.structuredContent.trust.tier).toBe("unverified");
  });

  it("MUTATION GUARD (flair#1181): the pre-fix INSTANCE pattern returns undefined for the caller's own id; the STATIC pattern returns the record", async () => {
    // Proves the double faithfully models Harper's static-vs-instance divergence
    // (so the tests above can catch a regression). Revert memory_get in
    // resources/mcp-tools.ts to `new Cls(undefined, ctx).get(id)` and the
    // positive control above fails with the 404 this asserts the instance path
    // produces.
    const Cls: any = MemoryMock;
    const ctx = { request: { tpsAgent: "agt_bob" } };
    const viaInstance = await new Cls(undefined, ctx).get("mem-own-1");
    expect(viaInstance).toBeUndefined(); // getProperty on an unloaded record
    const viaStatic = await Cls.get("mem-own-1", ctx);
    expect(viaStatic?.id).toBe("mem-own-1");
    expect(viaStatic?.agentId).toBe("agt_bob");
  });

  it("memory_delete (flair#1181) dispatches to the STATIC Cls.delete so Memory.delete()'s permanent-guard load can run", async () => {
    const res = await mcpHandler(post(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "memory_delete", arguments: { id: "mem-own-1" } } },
      { sub: "sub-bob" },
    ));
    const body = await parse(res);
    expect(lastCall?.resource).toBe("Memory.delete");
    expect(lastCall?.args).toBe("mem-own-1");
    expect(body.result.isError).toBeFalsy();
  });

  it("soul_get (flair#1181) reads the caller's own soul via the STATIC by-id read", async () => {
    const res = await mcpHandler(post(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "soul_get", arguments: { key: "role" } } },
      { sub: "sub-bob" },
    ));
    const body = await parse(res);
    expect(lastCall?.resource).toBe("Soul.get");
    // id is derived from the RESOLVED agent (`${agentId}:${key}`), never args.
    expect(lastCall?.args).toBe("agt_bob:role");
    expect(body.result.isError).toBeFalsy();
    expect(body.result.structuredContent.agentId).toBe("agt_bob");
  });

  it("soul_set POSTs (collection-bound) with id = agentId:key (so soul_get can find it)", async () => {
    await mcpHandler(post(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "soul_set", arguments: { key: "role", value: "cofounder" } } },
      { sub: "sub-bob" },
    ));
    // flair#1181 — the write goes through the collection-bound create path
    // (Soul.post via collectionResource), NOT the old unloaded-instance put()
    // that threw "Invalid primary key type: undefined" against a real store.
    expect(lastCall?.resource).toBe("Soul.post");
    expect((lastCall as any)?.isCollection).toBe(true);
    // id is still derived from the RESOLVED agent (`${agentId}:${key}`), never
    // args, so soul_get's `${agentId}:${key}` lookup finds the entry.
    expect(lastCall?.args.id).toBe("agt_bob:role");
    expect(lastCall?.args.agentId).toBe("agt_bob");
    expect(lastCall?.args.key).toBe("role");
    expect(lastCall?.args.value).toBe("cofounder");
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

  it("record_usage (flair#683) delegates to RecordUsage.post with the resolved agent's identity, forwarding memoryIds + attribution — never a forged agentId", async () => {
    await mcpHandler(post(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "record_usage", arguments: { memoryIds: ["mem-a", "mem-b"], attribution: "grounded the CP-4 spec" } } },
      { sub: "sub-bob" },
    ));
    expect(lastCall?.resource).toBe("RecordUsage.post");
    expect(lastCall?.args).toEqual({ memoryIds: ["mem-a", "mem-b"], attribution: "grounded the CP-4 spec" });
    expect(lastCall?.ctx.request.tpsAgent).toBe("agt_bob");
  });

  it("record_usage accepts the singular memoryId convenience alias", async () => {
    await mcpHandler(post(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "record_usage", arguments: { memoryId: "mem-solo" } } },
      { sub: "sub-bob" },
    ));
    expect(lastCall?.resource).toBe("RecordUsage.post");
    expect(lastCall?.args).toEqual({ memoryIds: ["mem-solo"], attribution: undefined });
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

// ─── Body size cap (flair#1033) ──────────────────────────────────────────────

/** Build a request double with optional headers. */
function requestWithHeaders(body: any, mcp: any, headers: Record<string, string> = {}) {
  return {
    method: "POST",
    mcp,
    headers: {
      get: (name: string) => headers[name.toLowerCase()] ?? null,
    },
    text: async () => JSON.stringify(body),
  };
}

/** Build a request double whose body is a string (simulates a pre-read body). */
function requestWithStringBody(bodyStr: string, mcp: any, headers: Record<string, string> = {}) {
  return {
    method: "POST",
    mcp,
    headers: {
      get: (name: string) => headers[name.toLowerCase()] ?? null,
    },
    body: bodyStr,
  };
}

/** Build a request double whose body is an async iterable (simulates Harper's RequestBody). */
function requestWithStreamBody(chunks: string[], mcp: any, headers: Record<string, string> = {}) {
  return {
    method: "POST",
    mcp,
    headers: {
      get: (name: string) => headers[name.toLowerCase()] ?? null,
    },
    body: {
      [Symbol.asyncIterator]() {
        let i = 0;
        return {
          next: async () => {
            if (i >= chunks.length) return { done: true, value: undefined };
            return { done: false, value: chunks[i++] };
          },
        };
      },
    },
  };
}

describe("body size cap", () => {
  it("rejects when Content-Length exceeds the cap (413, JSON-RPC error)", async () => {
    const bigBody = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
    const res = await mcpHandler(requestWithHeaders(
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { sub: "s" },
      { "content-length": String(300 * 1024) }, // 300 KB > 256 KB cap
    ));
    expect(res.status).toBe(413);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe(-32000);
    expect(body.error.message).toContain("too large");
  });

  it("POSITIVE CONTROL: a request under the cap succeeds", async () => {
    const res = await mcpHandler(requestWithHeaders(
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { sub: "s" },
      { "content-length": "128" },
    ));
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.result).toEqual({});
  });

  it("rejects an invalid (non-numeric) Content-Length", async () => {
    const res = await mcpHandler(requestWithHeaders(
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { sub: "s" },
      { "content-length": "eleventy" },
    ));
    expect(res.status).toBe(413);
    const body = JSON.parse(res.body);
    expect(body.error.message).toContain("invalid Content-Length");
  });

  it("rejects a negative Content-Length", async () => {
    const res = await mcpHandler(requestWithHeaders(
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { sub: "s" },
      { "content-length": "-1" },
    ));
    expect(res.status).toBe(413);
    const body = JSON.parse(res.body);
    expect(body.error.message).toContain("invalid Content-Length");
  });

  it("rejects a body that exceeds the cap during streaming read (no Content-Length header — chunked encoding path)", async () => {
    // Build a body that's 300 KB — over the 256 KB cap.
    const padding = "x".repeat(300 * 1024);
    const bigPayload = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", padding });
    const res = await mcpHandler(requestWithStreamBody(
      [bigPayload],
      { sub: "s" },
      // No content-length header — simulates chunked transfer encoding.
    ));
    expect(res.status).toBe(413);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe(-32000);
    expect(body.error.message).toContain("too large");
  });

  it("POSITIVE CONTROL: streaming read under the cap succeeds (no Content-Length)", async () => {
    const res = await mcpHandler(requestWithStreamBody(
      [JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" })],
      { sub: "s" },
    ));
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.result).toEqual({});
  });

  it("rejects a string body that exceeds the cap", async () => {
    const padding = "x".repeat(300 * 1024);
    const bigPayload = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", padding });
    const res = await mcpHandler(requestWithStringBody(bigPayload, { sub: "s" }));
    expect(res.status).toBe(413);
    const body = JSON.parse(res.body);
    expect(body.error.message).toContain("too large");
  });

  it("POSITIVE CONTROL: string body under the cap succeeds", async () => {
    const res = await mcpHandler(requestWithStringBody(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      { sub: "s" },
    ));
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.result).toEqual({});
  });

  it("accepts an empty body (no Content-Length, no body bytes)", async () => {
    const res = await mcpHandler(requestWithStreamBody([], { sub: "s" }));
    // Empty body → not valid JSON-RPC → parse error, not a size rejection.
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe(-32700);
  });
});
