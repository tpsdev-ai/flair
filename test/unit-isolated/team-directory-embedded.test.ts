import { describe, it, expect, mock } from "bun:test";

let credentials: any[] = [];
const agents: Record<string, any> = {};
mock.module("harper", () => ({
  Resource: class {},
  server: { http: () => {}, getUser: async () => null },
  databases: { flair: {
    Agent: {
      get: async (id: string) => agents[id] ?? null,
      search: async function* () { for (const agent of Object.values(agents)) yield agent; },
    },
    Credential: {
      search: async function* () { for (const credential of credentials) yield credential; },
      get: async (id: string) => credentials.find((credential) => credential.id === id) ?? null,
      patch: async () => {},
    },
    Integration: {
      search: async function* () {
        yield { agentId: "td-subject", platform: "tps-mail", email: "subject@example.test", directoryPublishedAt: "2026-10-01T00:00:00.000Z" };
      },
    },
  } },
}));
const { mcpHandler } = await import("../../resources/mcp-handler.ts");
function post(body: any, mcp: any) { return { method: "POST", mcp, body: JSON.stringify(body) }; }
async function parse(res: any) { return JSON.parse(res.body); }

describe("embedded team_directory tools/call", () => {
  function seed(kind = "agent") {
    credentials = [{ id: "td-credential", kind: "idp", idpSubject: "td-sub", principalId: "td-reader", status: "active" }];
    agents["td-reader"] = { id: "td-reader", kind, status: "active" };
    agents["td-subject"] = { id: "td-subject", kind: "agent", status: "active" };
  }

  it("returns the published contact", async () => {
    seed();
    const rpc = await parse(await mcpHandler(post({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "team_directory", arguments: { id: "td-subject", limit: 1 } } }, { sub: "td-sub" })));
    expect(rpc.error).toBeUndefined();
    expect(rpc.result.isError).toBe(false);
    expect(rpc.result.structuredContent.entries.map((e: any) => e.agentId)).toEqual(["td-subject"]);
    expect(rpc.result.structuredContent.entries[0].email).toBe("subject@example.test");
    expect(JSON.parse(rpc.result.content[0].text)).toEqual(rpc.result.structuredContent);
  });

  it("returns the tool error for a human reader", async () => {
    seed("human");
    const rpc = await parse(await mcpHandler(post({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "team_directory", arguments: {} } }, { sub: "td-sub" })));
    expect(rpc.error).toBeUndefined();
    expect(rpc.result.isError).toBe(true);
    expect(rpc.result.structuredContent).toEqual({ error: "team_directory_reader_not_active", status: 403 });
    expect(JSON.parse(rpc.result.content[0].text)).toEqual(rpc.result.structuredContent);
  });

  it("rejects a string limit before dispatch", async () => {
    seed();
    const rpc = await parse(await mcpHandler(post({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "team_directory", arguments: { limit: "1" } } }, { sub: "td-sub" })));
    expect(rpc.error.code).toBe(-32602);
    expect(rpc.result).toBeUndefined();
  });
});
