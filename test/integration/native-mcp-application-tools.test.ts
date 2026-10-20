// Harper's native MCP application tools on flair's resources decide the caller
// as one without a valid credential (resources/protocol-context.ts
// isPermissionMarkedRequestlessContext, resources/agent-auth.ts).
//
// Flair's configuration has no root `mcp:` block, so Harper's native MCP
// component does not load where Flair runs. This file starts a test-Harper with
// `mcp.application` configured (StartHarperOptions.appendRootConfigYaml), the
// state of an instance whose configuration turned it on. Harper then registers
// get_/search_/create_/update_/delete_ tools for flair's resources, and builds
// each call's context as `{ user, authorize: true, checkPermission }` with no
// request. Harper clears `authorize` before the resource's authorization hooks
// and handler run and leaves `checkPermission`; flair resolves that context as
// a caller without a valid credential, because no principal bridge from
// Harper's MCP session to a flair caller exists.
//
// What it checks, for a non-admin Harper user whose role grants read on Memory
// only, calling each tool by name (create_Agent, update_Agent and delete_Agent
// are absent from that session's tools/list and are called anyway):
//   - get_Memory and search_Memory return no other principal's private row;
//   - get_AdminMemory returns no admin page and no memory content;
//   - create_Agent creates no Agent row, update_Agent changes no Agent row, and
//     delete_Agent removes none, read back afterwards through the operations
//     API as well as from the reply;
//   - each of those calls answers a tool error carrying Harper's access refusal.
// An administrator's create_Agent over the same route is refused the same way.
// The control: the same non-admin user's REST calls for the same operations
// are refused and change nothing, as before; an administrator's REST read
// returns the private row (so it exists), and get_Health over MCP answers the
// non-admin session (so the tool route reaches flair).
//
// Mutation check: drop the checkPermission classification from
// isProtocolLayerContext and this file goes red.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { startHarper, stopHarper, HarperInstance } from "../helpers/harper-lifecycle";
import { assertOwnInstance } from "../helpers/own-harper-instance";
import { McpSession, type RpcReply } from "../helpers/native-mcp";

const MCP_PATH = "/native-mcp";
const NON_ADMIN = { username: "mcp-app-reader", password: "mcp-app-reader-test-only", role: "mcp-app-reader" };
/** Harper's AccessViolation message for a caller with a Harper user (utility/errors/hdbError.ts). */
const ACCESS_REFUSAL = "Unauthorized access to resource";

/** The tool-error payload Harper's application tools return for a call that threw. */
function toolError(reply: RpcReply): { isError: boolean; message?: string } {
  const result = reply.body?.result;
  let message: string | undefined;
  try { message = JSON.parse(result?.content?.[0]?.text ?? "{}").message; } catch { message = undefined; }
  return { isError: result?.isError === true, message };
}

describe("Harper's native MCP application tools on flair resources", () => {
  let harper: HarperInstance;
  const sessions: McpSession[] = [];
  const run = `mcpapp-${crypto.randomUUID().slice(0, 8)}`;
  const owner = `${run}-owner`;
  const privateId = `${run}-private`;
  const privateContent = `${run}-private-content`;
  const basic = () => "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`);
  const readerBasic = "Basic " + btoa(`${NON_ADMIN.username}:${NON_ADMIN.password}`);

  async function adminOp(body: Record<string, unknown>): Promise<Response> {
    assertOwnInstance(harper);
    return fetch(harper.opsURL, { method: "POST", headers: { "Content-Type": "application/json", Authorization: basic() }, body: JSON.stringify(body) });
  }

  async function rest(method: string, path: string, authorization: string, body?: unknown): Promise<{ status: number; text: string }> {
    assertOwnInstance(harper);
    const res = await fetch(`${harper.httpURL}${path}`, {
      method,
      headers: { Authorization: authorization, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, text: await res.text() };
  }

  /** The stored Agent row with this id, read through the operations API; null when there is none. */
  async function storedAgent(id: string): Promise<Record<string, unknown> | null> {
    const res = await adminOp({ operation: "search_by_value", database: "flair", table: "Agent", search_attribute: "id", search_value: id, get_attributes: ["*"] });
    const text = await res.text();
    expect(res.status, text.slice(0, 300)).toBe(200);
    const rows = JSON.parse(text);
    expect(Array.isArray(rows), text.slice(0, 300)).toBe(true);
    expect(rows.length).toBeLessThanOrEqual(1);
    return rows[0] ?? null;
  }

  async function openSession(authorization: string): Promise<McpSession> {
    assertOwnInstance(harper);
    const session = new McpSession(`${harper.httpURL}${MCP_PATH}`, authorization);
    sessions.push(session);
    await session.open();
    return session;
  }

  beforeAll(async () => {
    harper = await startHarper({ appendRootConfigYaml: `mcp:\n  application:\n    mountPath: ${MCP_PATH}\n` });
    assertOwnInstance(harper);
    const role = await adminOp({
      operation: "add_role",
      role: NON_ADMIN.role,
      permission: { super_user: false, flair: { tables: { Memory: { read: true, insert: false, update: false, delete: false, attribute_permissions: [] } } } },
    });
    expect(role.status, await role.text()).toBe(200);
    const user = await adminOp({ operation: "add_user", role: NON_ADMIN.role, username: NON_ADMIN.username, password: NON_ADMIN.password, active: true });
    expect(user.status, await user.text()).toBe(200);

    const now = new Date().toISOString();
    const agent = await adminOp({
      operation: "upsert", database: "flair", table: "Agent",
      records: [{ id: owner, name: owner, displayName: owner, publicKey: `${run}-public-key`, kind: "agent", type: "agent", status: "active", role: "agent", admin: false, createdAt: now, updatedAt: now }],
    });
    expect(agent.status, await agent.text()).toBe(200);
    const memory = await adminOp({
      operation: "upsert", database: "flair", table: "Memory",
      records: [{ id: privateId, agentId: owner, content: privateContent, visibility: "private", durability: "standard", createdAt: now, updatedAt: now }],
    });
    expect(memory.status, await memory.text()).toBe(200);
  }, 180_000);

  afterAll(async () => {
    for (const s of sessions) await s.close();
    if (harper) await stopHarper(harper);
  }, 60_000);

  test("a non-admin session's tool calls by name are refused for admin-only and owner-scoped resources, with nothing returned, created, changed or removed", async () => {
    const admin = await openSession(basic());
    const reader = await openSession(readerBasic);

    const called = ["get_Memory", "search_Memory", "get_AdminMemory", "create_Agent", "update_Agent", "delete_Agent"];
    const registered = await admin.listToolNames();
    for (const name of [...called, "get_Health"]) expect(registered.has(name), `${name} is registered for the administrator`).toBe(true);
    const listedToReader = await reader.listToolNames();
    for (const name of ["create_Agent", "update_Agent", "delete_Agent"]) {
      expect(listedToReader.has(name), `${name} is absent from the non-admin's tools/list`).toBe(false);
    }

    // Positive control: the tool route reaches flair for this session.
    const health = await reader.callTool("get_Health", {});
    expect(health.status, health.text.slice(0, 300)).toBe(200);
    expect(toolError(health).isError, health.text.slice(0, 300)).toBe(false);
    expect(health.body?.result?.structuredContent?.ok, health.text.slice(0, 300)).toBe(true);

    const before = await storedAgent(owner);
    expect(before?.admin).toBe(false);
    const created = `${run}-created`;

    const replies: Array<[string, RpcReply]> = [
      ["get_Memory", await reader.callTool("get_Memory", { id: privateId })],
      ["search_Memory", await reader.callTool("search_Memory", {})],
      ["get_AdminMemory", await reader.callTool("get_AdminMemory", {})],
      ["create_Agent", await reader.callTool("create_Agent", { id: created, name: created, publicKey: `${run}-created-key` })],
      ["update_Agent", await reader.callTool("update_Agent", { ...before, id: owner, admin: true, role: "admin", displayName: `${run}-changed` })],
      ["delete_Agent", await reader.callTool("delete_Agent", { id: owner })],
    ];
    for (const [name, reply] of replies) {
      expect(reply.status, `${name}: ${reply.text.slice(0, 300)}`).toBe(200);
      expect(reply.body?.error, `${name} reaches the tool's handler (not an unknown tool)`).toBeUndefined();
      expect({ name, ...toolError(reply) }).toEqual({ name, isError: true, message: ACCESS_REFUSAL });
      expect(reply.text, name).not.toContain(privateContent);
    }

    // Stored state, read fresh through the operations API.
    expect(await storedAgent(created), "create_Agent created no Agent row").toBeNull();
    expect(await storedAgent(owner), "update_Agent and delete_Agent left the Agent row as it was").toEqual(before);
  }, 180_000);

  test("an administrator's create_Agent over the same route is refused too", async () => {
    const admin = await openSession(basic());
    const created = `${run}-admin-created`;
    const reply = await admin.callTool("create_Agent", { id: created, name: created, publicKey: `${run}-admin-key` });
    expect(reply.status, reply.text.slice(0, 300)).toBe(200);
    expect(toolError(reply)).toEqual({ isError: true, message: ACCESS_REFUSAL });
    expect(await storedAgent(created)).toBeNull();
  }, 120_000);

  test("control: the same non-admin user's REST calls are refused and change nothing; an administrator's REST read returns the private row", async () => {
    const adminRead = await rest("GET", `/Memory/${privateId}`, basic());
    expect(adminRead.status, adminRead.text.slice(0, 300)).toBe(200);
    expect(adminRead.text).toContain(privateContent);

    const before = await storedAgent(owner);
    const created = `${run}-rest-created`;
    const calls: Array<[string, { status: number; text: string }]> = [
      ["GET /Memory/<id>", await rest("GET", `/Memory/${privateId}`, readerBasic)],
      ["GET /Memory/", await rest("GET", `/Memory/?agentId=${owner}`, readerBasic)],
      ["GET /AdminMemory", await rest("GET", "/AdminMemory", readerBasic)],
      ["POST /Agent/", await rest("POST", "/Agent/", readerBasic, { id: created, name: created, publicKey: `${run}-rest-key` })],
      ["PUT /Agent/<id>", await rest("PUT", `/Agent/${owner}`, readerBasic, { ...before, admin: true, role: "admin" })],
      ["DELETE /Agent/<id>", await rest("DELETE", `/Agent/${owner}`, readerBasic)],
    ];
    for (const [label, res] of calls) {
      expect({ label, refused: res.status === 401 || res.status === 403 }, `${label}: ${res.status} ${res.text.slice(0, 200)}`)
        .toEqual({ label, refused: true });
      expect(res.text, label).not.toContain(privateContent);
    }
    expect(await storedAgent(created)).toBeNull();
    expect(await storedAgent(owner)).toEqual(before);
  }, 120_000);
});
