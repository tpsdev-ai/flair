// Harper's native MCP `resources/subscribe` on flair's tables follows the
// table-subscription policy (resources/table-subscription-policy.ts).
//
// Flair's configuration has no root `mcp:` block, so Harper's native MCP
// component does not load where Flair runs. This file starts a test-Harper with
// `mcp.application` configured (StartHarperOptions.appendRootConfigYaml), the
// state of an instance whose configuration turned it on, and drives that
// component as an MCP client does: `initialize`, `notifications/initialized`,
// the session's SSE stream (GET), `resources/list`, then `resources/subscribe`
// on the table resources the list advertises.
//
// Harper calls a table's static subscribe() for that route with
// `{ user, authorize: true, request: <RequestTarget> }`, a context with no HTTP
// request. Flair resolves it as a caller without a verified credential, and no
// principal bridge from Harper's MCP session to a Flair caller exists, so the
// route refuses every caller, administrators included:
//   - Harper's administrator (Basic) and a non-admin Harper user with read
//     permission on Memory each get a JSON-RPC error, not a result, for
//     `resources/subscribe` on the collection resource of every flair table
//     the list advertises and on a committed Memory row's resource; Harper's
//     log records the policy's refusal for each of those calls, and no
//     response carries a marker row's content;
//   - a marker row committed to every one of those tables afterwards reaches
//     neither session's SSE stream as a notification or as row content.
// The positive controls: both sessions initialize, `resources/list` answers
// and advertises Memory, and each session's SSE stream is open.
//
// Mutation checks: remove the subscribe() guard, or drop both the guard's
// protocol-entry rule and resolveAgentAuth's protocol-layer rule, and this file
// goes red.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { tmpdir } from "node:os";
import { startHarper, stopHarper, HarperInstance } from "../helpers/harper-lifecycle";
import { commitMarkerRow, flairTableShapes } from "../helpers/table-markers";
import { McpSession } from "../helpers/native-mcp";

const MCP_PATH = "/native-mcp";
const POLICY_REFUSAL = "table subscriptions need an administrator credential";
const NON_ADMIN = { username: "mcp-reader", password: "mcp-reader-test-only", role: "mcp-reader" };

// Paths another resource serves instead of the table (see
// table-subscription-default-deny.test.ts). They implement no subscription of
// their own, so a subscription there receives nothing of the table: they are
// held to delivering nothing, not to the policy's refusal.
const NOT_TABLE_ROUTES = new Set(["AgentReadPosition", "OAuthToken"]);

/**
 * Refuse to talk to anything but this test's own ephemeral instance: loopback,
 * the OS-assigned ports this instance was started on, never a production port,
 * and a data directory under the temp dir.
 */
function assertOwnInstance(harper: HarperInstance): void {
  for (const [label, href] of [["http", harper.httpURL], ["ops", harper.opsURL]] as const) {
    const u = new URL(href);
    const port = Number(u.port);
    if (u.hostname !== "127.0.0.1" || !(port > 0) || port === 9925 || port === 9926) {
      throw new Error(`refusing to run against ${label} target ${u.href}: not this test's ephemeral instance`);
    }
  }
  if (!harper.process?.pid || !harper.installDir.startsWith(tmpdir())) {
    throw new Error(`refusing to run: ${harper.httpURL} is not an instance this test started`);
  }
}

describe("Harper's native MCP resources/subscribe on flair tables", () => {
  let harper: HarperInstance;
  const sessions: McpSession[] = [];
  const basic = () => "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`);

  async function adminOp(body: Record<string, unknown>): Promise<Response> {
    assertOwnInstance(harper);
    return fetch(harper.opsURL, { method: "POST", headers: { "Content-Type": "application/json", Authorization: basic() }, body: JSON.stringify(body) });
  }

  /** The number of policy refusals Harper's log holds so far. */
  const refusalsLogged = () => (harper.getLog?.() ?? "").split(POLICY_REFUSAL).length - 1;

  async function waitForRefusals(count: number): Promise<number> {
    const deadline = Date.now() + 10_000;
    while (refusalsLogged() < count && Date.now() < deadline) await Bun.sleep(50);
    return refusalsLogged();
  }

  beforeAll(async () => {
    harper = await startHarper({ appendRootConfigYaml: `mcp:\n  application:\n    mountPath: ${MCP_PATH}\n` });
    assertOwnInstance(harper);
    expect(typeof harper.getLog, "the harness captures Harper's log").toBe("function");
    const role = await adminOp({
      operation: "add_role",
      role: NON_ADMIN.role,
      permission: { super_user: false, flair: { tables: { Memory: { read: true, insert: false, update: false, delete: false, attribute_permissions: [] } } } },
    });
    expect(role.status, await role.text()).toBe(200);
    const user = await adminOp({ operation: "add_user", role: NON_ADMIN.role, username: NON_ADMIN.username, password: NON_ADMIN.password, active: true });
    expect(user.status, await user.text()).toBe(200);
  }, 180_000);

  afterAll(async () => {
    for (const s of sessions) await s.close();
    if (harper) await stopHarper(harper);
  }, 60_000);

  test("refuses an administrator and a non-admin on every advertised table-owned route, with no row data on the response or the stream", async () => {
    const schema = await flairTableShapes(adminOp);
    const tables = [...schema.keys()];
    expect(tables).toContain("Memory");

    const callers = [
      ["administrator", basic()],
      ["non-admin", "Basic " + btoa(`${NON_ADMIN.username}:${NON_ADMIN.password}`)],
    ] as const;
    const opened: Array<{ who: string; session: McpSession }> = [];
    for (const [who, authorization] of callers) {
      const session = new McpSession(`${harper.httpURL}${MCP_PATH}`, authorization);
      sessions.push(session);
      await session.open();
      opened.push({ who, session });
    }

    // The flair tables the administrator's list advertises, by name, and the URI it advertises for each.
    const tableUris = new Map<string, string>();
    for (const r of await opened[0].session.listResources()) {
      if (tables.includes(r.name) && r.uri.startsWith("harper+rest:")) tableUris.set(r.name, r.uri);
    }
    expect([...tableUris.keys()], "resources/list advertises Memory").toContain("Memory");

    // A marker row committed to every advertised table before the subscriptions: no reply may carry one.
    const run = `mcp-${crypto.randomUUID().slice(0, 8)}`;
    for (const table of tableUris.keys()) await commitMarkerRow(adminOp, table, schema.get(table)!, `${run}-before-${table}`);
    const refused = [...tableUris].filter(([table]) => !NOT_TABLE_ROUTES.has(table)).map(([, uri]) => uri);
    refused.push(`${tableUris.get("Memory")}/${run}-before-Memory`);
    const notTable = [...tableUris].filter(([table]) => NOT_TABLE_ROUTES.has(table)).map(([, uri]) => uri);

    let expectedRefusals = refusalsLogged();
    for (const { who, session } of opened) {
      for (const uri of refused) {
        const reply = await session.rpc("resources/subscribe", { uri });
        expect({ who, uri, error: reply.body?.error !== undefined, result: reply.body?.result }).toEqual({ who, uri, error: true, result: undefined });
        expect(reply.text, `${who} ${uri}`).not.toContain(run);
        expectedRefusals++;
        expect(await waitForRefusals(expectedRefusals), `${who} ${uri}: Harper's log records the policy's refusal`).toBe(expectedRefusals);
      }
      for (const uri of notTable) {
        const reply = await session.rpc("resources/subscribe", { uri });
        expect(reply.text, `${who} ${uri}`).not.toContain(run);
      }
    }

    // A marker row committed to every advertised table afterwards, and a change
    // to each earlier one, reach no session's stream.
    for (const table of tableUris.keys()) {
      await commitMarkerRow(adminOp, table, schema.get(table)!, `${run}-after-${table}`);
      await commitMarkerRow(adminOp, table, schema.get(table)!, `${run}-before-${table}`);
    }
    await Bun.sleep(1_500);
    for (const { who, session } of opened) {
      const text = session.stream();
      expect({ who, notified: text.includes("notifications/resources/updated"), rowData: text.includes(run) })
        .toEqual({ who, notified: false, rowData: false });
    }
  }, 180_000);
});
