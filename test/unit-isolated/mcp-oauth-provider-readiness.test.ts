import { afterAll, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { server as HarperServer } from "../../node_modules/harper/dist/index.js";

type Registry = Pick<typeof HarperServer.resources, "get" | "set">;
type HarperNamespace = Pick<typeof import("../../node_modules/harper/dist/index.js"), "server">;
type HarperMock = {
  [K in keyof HarperNamespace]: Pick<HarperNamespace[K], "http"> & {
    [R in keyof Pick<HarperNamespace[K], "resources">]: Registry;
  };
};

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

async function fixture() {
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

  const entries = new Map<string, NonNullable<ReturnType<Registry["get"]>>>();
  const resources: Registry = {
    set(path, Resource, exportTypes) { entries.set(path, { Resource, path, exportTypes, hasSubPaths: false, relativeURL: "" }); },
    get(path) { return entries.get(path); },
  };
  const configure = async (providers: Record<string, any>, enabled = true) => {
    const options = Object.assign(new EventEmitter(), { getAll: () => ({ providers, mcp: { ...mcp, enabled } }) });
    await handleApplication({ options, resources, server: { http() {} }, on() {} } as any);
  };
  let guarded: any;
  let reached = 0;
  const harper: HarperMock = { server: { resources } };
  await registerMcpOAuthRoute({
    harper,
    skipComponentGuard: true,
    server: { http(handler: any) { guarded = handler; } },
    mcpHandler: async () => { reached++; return { status: 200 }; },
  });
  const request = () => ({ pathname: "/mcp", headers: { authorization: `Bearer ${token}` } });
  return { configure, resources, request: () => guarded(request()), reached: () => reached, rows, key };
}

const providers = { github: { provider: "github", clientId: "client", clientSecret: "secret", redirectUri: `${process.env.FLAIR_MCP_ISSUER}/oauth` } };

test("configured provider and enabled MCP accept a valid token through Harper's server registry", async () => {
  const f = await fixture();
  await f.configure(providers);
  expect(OAuthResource.mcpConfig?.enabled).toBe(true);
  f.resources.set("oauth", { mcpConfig: OAuthResource.mcpConfig });
  OAuthResource.mcpConfig = undefined;
  expect((await f.request()).status).toBe(200);
  expect(f.reached()).toBe(1);
});

test("no provider denies a valid token against a persisted key; provider removal also denies it", async () => {
  const f = await fixture();
  await f.configure({});
  expect((await f.request()).status).toBe(401);
  expect(f.reached()).toBe(0);
  await f.configure(providers);
  expect((await f.request()).status).toBe(200);
  await f.configure({});
  expect((await f.request()).status).toBe(401);
  expect(f.reached()).toBe(1);
  expect(f.rows.has(f.key.kid)).toBe(true);
});

test("disabled MCP denies a previously valid token with the provider still configured", async () => {
  const f = await fixture();
  await f.configure(providers);
  expect((await f.request()).status).toBe(200);
  await f.configure(providers, false);
  expect((await f.request()).status).toBe(401);
  expect(f.reached()).toBe(1);
});

test("unconfigured provider denies a previously valid token", async () => {
  const f = await fixture();
  await f.configure(providers);
  expect((await f.request()).status).toBe(200);
  await f.configure({ github: { ...providers.github, clientId: "", clientSecret: "" } });
  expect((await f.request()).status).toBe(401);
  expect(f.reached()).toBe(1);
});
