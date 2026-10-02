import { afterAll, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";

const savedEnv = { ...process.env };
process.env.FLAIR_MCP_NO_AUTOSTART = "1";
process.env.FLAIR_MCP_OAUTH = "true";
process.env.FLAIR_MCP_ISSUER = "https://provider-readiness.flair.test";

mock.module("harper", () => ({ Resource: class {}, server: {}, databases: {}, logger: { info() {}, warn() {}, error() {} } }));
const { handleApplication, OAuthResource } = await import("@harperfast/oauth");
const { MCPKeyStore, resetMCPKeysTableCache } = await import("../../node_modules/@harperfast/oauth/dist/lib/mcp/keyStore.js");
const { signAccessToken } = await import("../../node_modules/@harperfast/oauth/dist/lib/mcp/tokenIssuer.js");
const { registerMcpOAuthRoute } = await import("../../resources/mcp-oauth.ts");

afterAll(() => {
  process.env = savedEnv;
  OAuthResource.mcpConfig = undefined;
  resetMCPKeysTableCache();
  delete (globalThis as any).databases;
});

test("no provider denies a valid token against a persisted key; provider removal also denies it", async () => {
  const rows = new Map<string, any>();
  (globalThis as any).databases = { oauth: { harper_oauth_mcp_keys: {
    async put(row: any) { rows.set(row.kid, row); },
    async *search() { yield* rows.values(); },
  } } };
  resetMCPKeysTableCache();
  const issuer = process.env.FLAIR_MCP_ISSUER!;
  const mcp = { enabled: true, issuer, resource: `${issuer}/mcp` };
  const key = await new MCPKeyStore().getSigningKey(mcp);
  const { token } = signAccessToken({ issuer, audience: mcp.resource, subject: "agent", clientId: "client", ttlSeconds: 900 }, key);
  expect(rows.has(key.kid)).toBe(true);

  const entries = new Map<string, any>();
  const resources = {
    set(path: string, Resource: any) { entries.set(path, { Resource }); },
    get(path: string) { return entries.get(path); },
  };
  const configure = async (providers: Record<string, any>) => {
    const options = Object.assign(new EventEmitter(), { getAll: () => ({ providers, mcp }) });
    await handleApplication({ options, resources, server: { http() {} }, on() {} } as any);
  };
  await configure({});
  expect(OAuthResource.mcpConfig).toBeUndefined();
  let guarded: any;
  let reached = 0;
  await registerMcpOAuthRoute({
    harper: { resources },
    skipComponentGuard: true,
    server: { http(handler: any) { guarded = handler; } },
    mcpHandler: async () => { reached++; return { status: 200 }; },
  });
  const request = () => ({ pathname: "/mcp", headers: { authorization: `Bearer ${token}` } });
  expect((await guarded(request())).status).toBe(401);
  expect(reached).toBe(0);

  await configure({ github: { provider: "github", clientId: "client", clientSecret: "secret", redirectUri: `${issuer}/oauth` } });
  entries.set("oauth", { Resource: { mcpConfig: OAuthResource.mcpConfig } });
  OAuthResource.mcpConfig = undefined;
  expect((await guarded(request())).status).toBe(200);
  expect(reached).toBe(1);
  await configure({});
  expect((await guarded(request())).status).toBe(401);
  expect(reached).toBe(1);
  expect(rows.has(key.kid)).toBe(true);
});
