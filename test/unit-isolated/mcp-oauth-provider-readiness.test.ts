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
const { handleApplication, OAuthResource, withMCPAuth } = await import("@harperfast/oauth");
const { MCPKeyStore, resetMCPKeysTableCache } = await import("../../node_modules/@harperfast/oauth/dist/lib/mcp/keyStore.js");
const { signAccessToken } = await import("../../node_modules/@harperfast/oauth/dist/lib/mcp/tokenIssuer.js");
const { registerMcpOAuthRoute, mcpRouteState } = await import("../../resources/mcp-oauth.ts");

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
  const configure = async (
    providers: Record<string, any>,
    enabled = true,
    issuer = process.env.FLAIR_MCP_ISSUER!,
  ) => {
    const options = Object.assign(new EventEmitter(), {
      getAll: () => ({ providers, mcp: { ...mcp, issuer, enabled } }),
    });
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
  return { configure, resources, request: (input = request()) => guarded(input), reached: () => reached, rows, key };
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
  const noProvider = await f.request();
  expect(noProvider.status).toBe(503);
  expect(noProvider.body).toContain("not serving an MCP authorization configuration");
  expect(f.reached()).toBe(0);
  await f.configure(providers);
  expect((await f.request()).status).toBe(200);
  await f.configure({ github: { ...providers.github, clientId: "", clientSecret: "" } });
  const removed = await f.request();
  expect(removed.status).toBe(503);
  expect(removed.body).toContain("not serving an MCP authorization configuration");
  expect(f.reached()).toBe(1);
  expect(f.rows.has(f.key.kid)).toBe(true);
});

test("public 503 mirrors wrapper denial CORS headers and configured responses stay unchanged", async () => {
  const f = await fixture();
  const wrapper = withMCPAuth(async () => ({ status: 200 }));
  for (const origin of [undefined, "https://browser.flair.test", "https://other-browser.flair.test"]) {
    const request: any = { method: "GET", pathname: "/mcp", headers: origin ? { origin } : {} };
    await f.configure({});
    const denial = await wrapper(request, () => {});
    expect(denial.status).toBe(401);
    const corsHeaders = Object.fromEntries(Object.entries(denial.headers!).filter(([name]) => name.startsWith("Access-Control-")));
    expect(corsHeaders).toEqual({
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Expose-Headers": "WWW-Authenticate",
    });
    const unavailable = await f.request(request);
    expect(unavailable.status).toBe(503);
    expect(unavailable.headers).toEqual({
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...corsHeaders,
    });
    await f.configure(providers);
    expect(await f.request(request)).toEqual(await wrapper(request, () => {}));
    expect(await f.request()).toEqual({ status: 200 });
  }
});

test("disabled MCP refuses a previously valid token with the provider still configured", async () => {
  const f = await fixture();
  await f.configure(providers);
  expect((await f.request()).status).toBe(200);
  await f.configure(providers, false);
  const disabled = await f.request();
  expect(disabled.status).toBe(503);
  expect(disabled.body).toContain("not serving an MCP authorization configuration");
  expect(f.reached()).toBe(1);
});

test("unconfigured provider refuses a previously valid token", async () => {
  const f = await fixture();
  await f.configure(providers);
  expect((await f.request()).status).toBe(200);
  await f.configure({ github: { ...providers.github, clientId: "", clientSecret: "" } });
  const unconfigured = await f.request();
  expect(unconfigured.status).toBe(503);
  expect(unconfigured.body).toContain("not serving an MCP authorization configuration");
  expect(f.reached()).toBe(1);
});

test("a live config removed or disabled after a refusal is unavailable and never reported mounted; restored config serves", async () => {
  const f = await fixture();
  await f.configure(providers);
  expect((await f.request()).status).toBe(200);
  expect(mcpRouteState().mounted).toBe(true);

  // A refusal while the authorization server is live.
  await f.configure(providers, true, "https://other-provider-readiness.flair.test");
  const refused = await f.request();
  expect(refused.status).toBe(503);
  expect(refused.body).toContain("differs from FLAIR_MCP_ISSUER");
  expect(mcpRouteState()).toMatchObject({ mounted: false, status: "Issuer refused" });

  // Removed: no valid provider remains, so the component clears mcpConfig.
  await f.configure({});
  expect(mcpRouteState()).toMatchObject({ mounted: false, status: "MCP auth unavailable" });
  const removed = await f.request();
  expect(removed.status).toBe(503);
  expect(removed.body).toContain("not serving an MCP authorization configuration");
  expect(mcpRouteState().mounted).toBe(false);

  // Disabled with the provider still configured.
  await f.configure(providers, false);
  expect(mcpRouteState()).toMatchObject({ mounted: false, status: "MCP auth unavailable" });
  const disabled = await f.request();
  expect(disabled.status).toBe(503);
  expect(disabled.body).toContain("not serving an MCP authorization configuration");

  // Restored.
  await f.configure(providers);
  expect(mcpRouteState().mounted).toBe(true);
  expect((await f.request()).status).toBe(200);
  expect(f.reached()).toBe(2);
});
