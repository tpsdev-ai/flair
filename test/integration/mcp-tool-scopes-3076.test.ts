// mcp-tool-scopes-3076.test.ts — each native /mcp tool requires the OAuth scope
// its operation needs (flair#3076).
//
// Per tool: a token that grants every other scope but not the tool's own is
// refused with insufficient_scope naming that scope, and the tool has no
// effect; a token that grants only that scope reaches the tool. Also: a
// memory:read token cannot store or delete; a token with no scope claim is
// refused every tool call and still lists tools; memory:admin neither stands in
// for memory:write nor lifts a non-admin principal's bound; the 401 challenge
// names the scopes to request.
//
// Harness: the mcp-principal-status.test.ts pattern. An ephemeral Harper with
// MCP OAuth on and a pinned issuer, a signing key this test controls seeded
// into oauth.harper_oauth_mcp_keys, tokens minted with jose, and subjects mapped
// to non-admin principals with provisionIdpIdentityMapping. Every request goes
// to this test's own loopback instance.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { SignJWT, importPKCS8 } from "jose";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";
import { assertOwnInstance, basicAuthOf } from "../helpers/own-harper-instance";
import { provisionIdpIdentityMapping } from "../../src/lib/mcp-enable";
import { TOOLS } from "../../resources/mcp-tools";

const ISSUER = "https://mcp-scope-test.flair.internal";
const RESOURCE = `${ISSUER}/mcp`;
const KID = "mcp-scope-test-key";
const sfx = Date.now().toString(36);

// P calls the tools; Q owns the records P must not reach. Both are non-admin.
const P = { id: `mcpscope-p-${sfx}`, sub: `idp-sub-scope-p-${sfx}` };
const Q = { id: `mcpscope-q-${sfx}`, sub: `idp-sub-scope-q-${sfx}` };

const ALL_SCOPES = [
  "memory:read", "memory:write", "memory:admin",
  "principal:read", "principal:admin",
  "connector:read", "connector:admin",
];
const REQUESTED = "memory:read memory:write principal:read";

// The scope each tool requires, pinned here rather than read from the source.
const EXPECTED: Record<string, string> = {
  memory_search: "memory:read",
  memory_get: "memory:read",
  skill_search: "memory:read",
  skill_get: "memory:read",
  bootstrap: "memory:read",
  soul_get: "memory:read",
  attention: "memory:read",
  memory_store: "memory:write",
  memory_update: "memory:write",
  memory_delete: "memory:write",
  memory_basement: "memory:write",
  memory_restore: "memory:write",
  skill_store: "memory:write",
  flair_workspace_set: "memory:write",
  flair_orgevent: "memory:write",
  record_usage: "memory:write",
  team_directory: "principal:read",
  soul_set: "principal:admin",
};

let harper: HarperInstance;
let privateKeyPem: string;

async function adminOp(op: Record<string, any>): Promise<Response> {
  assertOwnInstance(harper);
  return fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: basicAuthOf(harper) },
    body: JSON.stringify(op),
  });
}

/** Rows for one search; a failed or non-list read throws, so [] is only ever a real empty answer. */
async function rows(table: string, attribute: string, value: string): Promise<any[]> {
  const res = await adminOp({
    operation: "search_by_value", database: "flair", table,
    search_attribute: attribute, search_value: value, get_attributes: ["*"],
  });
  const text = await res.text();
  if (res.status !== 200) throw new Error(`${table} read → HTTP ${res.status}: ${text.slice(0, 300)}`);
  const body = JSON.parse(text);
  if (!Array.isArray(body)) throw new Error(`${table} read answered a non-list: ${text.slice(0, 300)}`);
  return body;
}
const rowById = async (table: string, id: string) => (await rows(table, "id", id))[0];

async function mintToken(sub: string, scope: string | undefined): Promise<string> {
  const key = await importPKCS8(privateKeyPem, "RS256");
  const claims: Record<string, unknown> = { client_id: "mcp-scope-test-client" };
  if (scope !== undefined) claims.scope = scope;
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: KID, typ: "at+jwt" })
    .setIssuer(ISSUER)
    .setAudience(RESOURCE)
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(key);
}

interface McpReply { status: number; wwwAuth: string | null; body: any }

let rpcId = 0;
async function mcp(token: string | null, method: string, params?: Record<string, unknown>): Promise<McpReply> {
  assertOwnInstance(harper);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${harper.httpURL}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  const text = await res.text();
  let body: any;
  try { body = JSON.parse(text); } catch { body = { unparsed: text.slice(0, 300) }; }
  return { status: res.status, wwwAuth: res.headers.get("www-authenticate"), body };
}

const call = (token: string, name: string, args: Record<string, unknown>) =>
  mcp(token, "tools/call", { name, arguments: args });

/** The scopes a challenge header names in its scope="…" parameter. */
function challengeScopes(wwwAuth: string | null): string[] {
  const m = /\bscope="([^"]*)"/.exec(wwwAuth ?? "");
  return m ? m[1].split(" ").filter(Boolean) : [];
}

/** A refusal for want of `scope`: HTTP 403, the JSON-RPC error naming it, and the Bearer challenge. */
function expectInsufficientScope(r: McpReply, scope: string, what: string): void {
  const detail = `${what}: ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`;
  expect(r.status, detail).toBe(403);
  expect(r.body?.result, detail).toBeUndefined();
  expect(r.body?.error?.code, detail).toBe(-32001);
  expect(r.body?.error?.message, detail).toContain("insufficient_scope");
  expect(r.body?.error?.message, detail).toContain(`'${scope}'`);
  expect(r.wwwAuth ?? "", detail).toMatch(/^Bearer\s+error="insufficient_scope"/);
  expect(challengeScopes(r.wwwAuth), detail).toContain(scope);
}

/** The call reached the tool: HTTP 200 and a tools/call result. */
function expectReached(r: McpReply, what: string): any {
  const detail = `${what}: ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`;
  expect(r.status, detail).toBe(200);
  expect(r.body?.error, detail).toBeUndefined();
  expect(r.body?.result, detail).toBeDefined();
  return r.body.result;
}

/** The tool ran and returned a non-error result. */
function expectServed(r: McpReply, what: string): any {
  const result = expectReached(r, what);
  expect(result.isError, `${what}: ${JSON.stringify(result).slice(0, 300)}`).toBe(false);
  return result.structuredContent;
}

let writer: string; // P, memory:read memory:write — seeds fixtures
let qWriter: string; // Q, memory:read memory:write

/** Store one memory as `token`'s principal and return its id. */
async function seedMemory(token: string, content: string, visibility = "private"): Promise<string> {
  const stored = expectServed(await call(token, "memory_store", { content, visibility }), `seed ${content}`);
  expect(typeof stored?.id).toBe("string");
  return stored.id;
}

/** Everything but `scope`, so a refusal can only be for that one scope. */
const allBut = (scope: string) => ALL_SCOPES.filter((s) => s !== scope).join(" ");

interface ToolCase {
  /** Arguments for the call, after any fixture the case needs. */
  prepare: () => Promise<Record<string, unknown>>;
  /** After the refused call: the tool had no effect. */
  unchanged?: (args: Record<string, unknown>) => Promise<void>;
  /** After the call with the scope: the tool's own answer. */
  reached: (r: McpReply, args: Record<string, unknown>) => Promise<void>;
}

const marker = (tool: string, phase: string) => `mcpscope ${tool} ${phase} ${sfx}`;

function cases(): Record<string, ToolCase> {
  const served = async (r: McpReply) => { expectServed(r, "with the scope"); };
  return {
    memory_search: { prepare: async () => ({ query: "mcpscope" }), reached: served },
    memory_get: {
      prepare: async () => ({ id: await seedMemory(writer, marker("memory_get", "seed")) }),
      reached: async (r, args) => { expect(expectServed(r, "memory_get").id).toBe(args.id); },
    },
    skill_search: { prepare: async () => ({ task: "mcpscope" }), reached: served },
    skill_get: {
      prepare: async () => {
        const stored = expectServed(await call(writer, "skill_store", { content: marker("skill_get", "seed"), trigger: "when checking scopes" }), "seed skill");
        return { id: stored.id };
      },
      reached: async (r, args) => { expect(expectServed(r, "skill_get").id).toBe(args.id); },
    },
    bootstrap: { prepare: async () => ({}), reached: served },
    soul_get: {
      prepare: async () => {
        const written = await fetch(`${harper.httpURL}/Soul/`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: basicAuthOf(harper) },
          body: JSON.stringify({ id: `${P.id}:role`, agentId: P.id, key: "role", value: "scope-test role", durability: "permanent" }),
        });
        expect(written.status, await written.clone().text()).toBeLessThan(300);
        return { key: "role" };
      },
      reached: async (r) => { expect(expectServed(r, "soul_get").value).toBe("scope-test role"); },
    },
    attention: { prepare: async () => ({ entity: "repo:example/scope-test" }), reached: served },
    memory_store: {
      prepare: async () => ({ content: marker("memory_store", "write") }),
      unchanged: async (args) => { expect(await rows("Memory", "content", String(args.content))).toEqual([]); },
      reached: async (r, args) => {
        expectServed(r, "memory_store");
        expect((await rows("Memory", "content", String(args.content))).map((x) => x.agentId)).toEqual([P.id]);
      },
    },
    memory_update: {
      prepare: async () => ({ id: await seedMemory(writer, marker("memory_update", "before")), content: marker("memory_update", "after") }),
      unchanged: async (args) => { expect((await rowById("Memory", String(args.id)))?.content).toBe(marker("memory_update", "before")); },
      reached: async (r, args) => {
        expectServed(r, "memory_update");
        expect((await rowById("Memory", String(args.id)))?.content).toBe(marker("memory_update", "after"));
      },
    },
    memory_delete: {
      prepare: async () => ({ id: await seedMemory(writer, marker("memory_delete", "seed")) }),
      unchanged: async (args) => { expect((await rowById("Memory", String(args.id)))?.id).toBe(args.id); },
      reached: async (r, args) => {
        expectServed(r, "memory_delete");
        expect(await rowById("Memory", String(args.id))).toBeUndefined();
      },
    },
    memory_basement: {
      prepare: async () => ({ id: await seedMemory(writer, marker("memory_basement", "seed")) }),
      unchanged: async (args) => { expect((await rowById("Memory", String(args.id)))?.archived === true).toBe(false); },
      reached: async (r, args) => {
        expectServed(r, "memory_basement");
        expect((await rowById("Memory", String(args.id)))?.archived).toBe(true);
      },
    },
    memory_restore: {
      prepare: async () => {
        const id = await seedMemory(writer, marker("memory_restore", "seed"));
        expectServed(await call(writer, "memory_basement", { id }), "seed basement");
        expect((await rowById("Memory", id))?.archived).toBe(true);
        return { id };
      },
      unchanged: async (args) => { expect((await rowById("Memory", String(args.id)))?.archived).toBe(true); },
      reached: async (r, args) => {
        expectServed(r, "memory_restore");
        expect((await rowById("Memory", String(args.id)))?.archived === true).toBe(false);
      },
    },
    skill_store: {
      prepare: async () => ({ content: marker("skill_store", "write"), trigger: "when checking scopes" }),
      unchanged: async (args) => { expect(await rows("Memory", "content", String(args.content))).toEqual([]); },
      reached: async (r, args) => {
        expectServed(r, "skill_store");
        expect((await rows("Memory", "content", String(args.content))).map((x) => x.agentId)).toEqual([P.id]);
      },
    },
    flair_workspace_set: {
      prepare: async () => ({ ref: `mcpscope-ws-${sfx}` }),
      unchanged: async (args) => { expect(await rowById("WorkspaceState", `${P.id}:${args.ref}`)).toBeUndefined(); },
      reached: async (r, args) => {
        expectServed(r, "flair_workspace_set");
        expect((await rowById("WorkspaceState", `${P.id}:${args.ref}`))?.agentId).toBe(P.id);
      },
    },
    flair_orgevent: {
      prepare: async () => ({ kind: "status", summary: marker("flair_orgevent", "publish") }),
      unchanged: async (args) => { expect(await rows("OrgEvent", "summary", String(args.summary))).toEqual([]); },
      reached: async (r, args) => {
        expectServed(r, "flair_orgevent");
        expect((await rows("OrgEvent", "summary", String(args.summary))).map((x) => x.authorId)).toEqual([P.id]);
      },
    },
    record_usage: {
      // Q's org-visible memory, which P may read and so may report using.
      prepare: async () => ({ memoryId: await seedMemory(qWriter, marker("record_usage", "seed"), "shared") }),
      unchanged: async (args) => { expect(await rowById("MemoryUsage", `${P.id}:${args.memoryId}`)).toBeUndefined(); },
      reached: async (r, args) => {
        expectServed(r, "record_usage");
        expect((await rowById("MemoryUsage", `${P.id}:${args.memoryId}`))?.agentId).toBe(P.id);
      },
    },
    team_directory: { prepare: async () => ({}), reached: served },
    soul_set: {
      prepare: async () => ({ key: "voice", value: marker("soul_set", "write") }),
      unchanged: async () => { expect(await rowById("Soul", `${P.id}:voice`)).toBeUndefined(); },
      // With the scope, the call reaches the tool, which refuses every runtime Soul write.
      reached: async (r) => {
        const result = expectReached(r, "soul_set");
        expect(result.isError).toBe(true);
        expect(result.structuredContent?.error).toContain("soul_write_requires_operator");
        expect(await rowById("Soul", `${P.id}:voice`)).toBeUndefined();
      },
    },
  };
}

describe("each /mcp tool requires the OAuth scope its operation needs (flair#3076)", () => {
  beforeAll(async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    privateKeyPem = privateKey;

    harper = await startHarper({
      serverEnv: {
        FLAIR_MCP_OAUTH: "true",
        FLAIR_MCP_ISSUER: ISSUER,
        OAUTH_GITHUB_CLIENT_ID: "mcp-scope-test-client",
        OAUTH_GITHUB_CLIENT_SECRET: "mcp-scope-test-secret",
        OAUTH_GITHUB_REDIRECT_URI: `${ISSUER}/oauth`,
        // An empty value reads as unset: JIT provisioning stays off.
        FLAIR_MCP_JIT_PROVISION: "",
        FLAIR_MCP_RATE_LIMIT: "1000",
      },
    });
    assertOwnInstance(harper);

    expect(Object.keys(EXPECTED).sort(), "this file pins a scope for every tool the registry serves").toEqual(Object.keys(TOOLS).sort());

    const seeded = await adminOp({
      operation: "insert", database: "oauth", table: "harper_oauth_mcp_keys",
      records: [{ kid: KID, alg: "RS256", public_key_pem: publicKey, private_key_pem: privateKey, created_at: Math.floor(Date.now() / 1000) }],
    });
    expect(seeded.status, await seeded.clone().text()).toBe(200);

    const now = new Date().toISOString();
    const agents = await adminOp({
      operation: "insert", database: "flair", table: "Agent",
      records: [P, Q].map((x) => ({ id: x.id, name: x.id, kind: "agent", type: "agent", role: "agent", status: "active", publicKey: `mcp-oauth:${x.sub}`, createdAt: now, updatedAt: now })),
    });
    expect(agents.status, await agents.clone().text()).toBe(200);

    // provisionIdpIdentityMapping reads a numeric opsPortOrUrl as a port on
    // 127.0.0.1, where this ephemeral instance's own ops API answers.
    const opsPort = Number(new URL(harper.opsURL).port);
    expect(harper.opsURL, "the ephemeral ops API").toBe(`http://127.0.0.1:${opsPort}`);
    for (const x of [P, Q]) {
      await provisionIdpIdentityMapping({
        opsPortOrUrl: opsPort,
        adminUser: harper.admin.username,
        adminPass: harper.admin.password,
        principal: x.id,
        principalKind: "agent",
        idpProvider: "scope-test-idp",
        idpSubject: x.sub,
      });
    }

    writer = await mintToken(P.sub, "memory:read memory:write");
    qWriter = await mintToken(Q.sub, "memory:read memory:write");
  }, 180_000);

  afterAll(async () => {
    if (harper) await stopHarper(harper);
  }, 30_000);

  for (const [tool, scope] of Object.entries(EXPECTED)) {
    test(`${tool} requires ${scope}: refused without it, with no effect; reaches the tool with it`, async () => {
      const c = cases()[tool];
      const args = await c.prepare();

      const without = await call(await mintToken(P.sub, allBut(scope)), tool, args);
      expectInsufficientScope(without, scope, `${tool} without ${scope}`);
      if (c.unchanged) await c.unchanged(args);

      const withScope = await call(await mintToken(P.sub, scope), tool, args);
      await c.reached(withScope, args);
    }, 60_000);
  }

  test("a memory:read token cannot store or delete, and can still search", async () => {
    const reader = await mintToken(P.sub, "memory:read");

    const content = marker("read-only", "store");
    expectInsufficientScope(await call(reader, "memory_store", { content }), "memory:write", "memory_store with memory:read");
    expect(await rows("Memory", "content", content)).toEqual([]);

    const id = await seedMemory(writer, marker("read-only", "delete target"));
    expectInsufficientScope(await call(reader, "memory_delete", { id }), "memory:write", "memory_delete with memory:read");
    expect((await rowById("Memory", id))?.id).toBe(id);

    expectServed(await call(reader, "memory_search", { query: "mcpscope" }), "memory_search with memory:read");

    // The challenge keeps the scopes the token was granted.
    const withOffline = await call(await mintToken(P.sub, "memory:read offline_access"), "memory_store", { content });
    expectInsufficientScope(withOffline, "memory:write", "memory_store with memory:read offline_access");
    expect(challengeScopes(withOffline.wwwAuth).sort()).toEqual(["memory:read", "memory:write", "offline_access", "principal:read"]);
  }, 60_000);

  test("a token with no scope claim is refused every tool call, and still initializes and lists tools", async () => {
    for (const scope of [undefined, ""]) {
      const token = await mintToken(P.sub, scope);
      const label = scope === undefined ? "no scope claim" : "an empty scope";

      const init = await mcp(token, "initialize", {});
      expect(init.status, label).toBe(200);
      expect(init.body?.result?.serverInfo?.name, label).toBe("flair");
      const list = await mcp(token, "tools/list");
      expect(list.status, label).toBe(200);
      expect((list.body?.result?.tools ?? []).length, label).toBeGreaterThan(10);

      for (const [tool, required] of Object.entries(EXPECTED)) {
        const args = tool === "memory_store" ? { content: marker("no-scope", label) } : {};
        const r = await call(token, tool, args);
        expectInsufficientScope(r, required, `${tool} with ${label}`);
        expect(challengeScopes(r.wwwAuth).sort(), `${tool} with ${label}`).toEqual(
          [...new Set([...REQUESTED.split(" "), required])].sort(),
        );
      }
      expect(await rows("Memory", "content", marker("no-scope", label))).toEqual([]);
    }
  }, 120_000);

  test("memory:admin neither stands in for memory:write nor lifts a non-admin principal's bound", async () => {
    const own = await seedMemory(writer, marker("admin-scope", "own"));
    const adminOnly = await mintToken(P.sub, "memory:admin");
    expectInsufficientScope(await call(adminOnly, "memory_delete", { id: own }), "memory:write", "memory_delete with memory:admin only");
    expect((await rowById("Memory", own))?.id).toBe(own);

    // Every scope: still P's authority, which does not reach Q's private memory.
    const everything = await mintToken(P.sub, ALL_SCOPES.join(" "));
    const theirs = await seedMemory(qWriter, marker("admin-scope", "theirs"));

    const del = expectReached(await call(everything, "memory_delete", { id: theirs }), "memory_delete of Q's memory");
    expect(del.isError, JSON.stringify(del).slice(0, 300)).toBe(true);
    expect((await rowById("Memory", theirs))?.agentId).toBe(Q.id);

    const upd = expectReached(await call(everything, "memory_update", { id: theirs, content: marker("admin-scope", "overwrite") }), "memory_update of Q's memory");
    expect(upd.isError, JSON.stringify(upd).slice(0, 300)).toBe(true);
    expect((await rowById("Memory", theirs))?.content).toBe(marker("admin-scope", "theirs"));

    const get = expectReached(await call(everything, "memory_get", { id: theirs }), "memory_get of Q's private memory");
    expect(get.isError, JSON.stringify(get).slice(0, 300)).toBe(true);
  }, 60_000);

  test("the 401 challenge names the scopes to request", async () => {
    const missing = await mcp(null, "tools/list");
    expect(missing.status).toBe(401);
    expect(missing.wwwAuth ?? "").toMatch(/^Bearer\s+resource_metadata="[^"]+"/);
    expect(challengeScopes(missing.wwwAuth)).toEqual(REQUESTED.split(" "));

    const invalid = await mcp("not-a-token", "tools/list");
    expect(invalid.status).toBe(401);
    expect(challengeScopes(invalid.wwwAuth)).toEqual(REQUESTED.split(" "));
  }, 30_000);
});
