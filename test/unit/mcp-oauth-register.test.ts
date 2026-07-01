/**
 * mcp-oauth-register.test.ts — the flag-OFF NO-OP contract for /mcp registration.
 *
 * registerMcpOAuthRoute() must:
 *   - flag OFF  → NEVER call server.http, NEVER load the oauth plugin (returns
 *     false). This is the byte-identical boot contract.
 *   - flag ON but no issuer → NEVER mount (no floating-issuer guard) → false.
 *   - flag ON + issuer → register withMCPAuth(handler) on urlPath '/mcp' ONLY.
 *
 * We call the exported registration function directly with injected deps (a spy
 * server + a stub withMCPAuth loader), so the test never depends on the load-time
 * side effect or the real Harper `server`. @harperfast/harper is mocked only so
 * the module's static `import { server }` resolves; the module-level fire-and-
 * forget call runs with the flag OFF (default) and returns before touching it.
 */

import { mock, describe, it, expect, beforeEach } from "bun:test";

// Suppress the module-level auto-registration on import — we call
// registerMcpOAuthRoute() directly with injected deps.
process.env.FLAIR_MCP_NO_AUTOSTART = "1";

// A complete-enough harper mock: `server` (what mcp-oauth.ts reads) PLUS
// `Resource` + `databases` so that if the real mcp-handler → mcp-tools → resource
// import graph loads under this mock (module-cache ordering in the full suite),
// it still links. `mock.module` is process-global in bun, so a superset mock is
// the safe shape.
class NoopBase { constructor(_id?: any, _ctx?: any) {} }
const dbStub = new Proxy({}, { get: () => new Proxy({}, { get: () => NoopBase }) });
mock.module("@harperfast/harper", () => ({
  server: { http: () => {} },
  Resource: NoopBase,
  databases: { flair: dbStub },
}));
// mcp-handler.ts (imported by mcp-oauth.ts) pulls in the resource handlers +
// databases; stub so the import graph loads outside a Harper runtime.
mock.module("../../resources/mcp-handler.ts", () => ({ mcpHandler: () => ({ status: 200 }) }));

const { registerMcpOAuthRoute } = await import("../../resources/mcp-oauth.ts");

const ENV = ["FLAIR_MCP_OAUTH", "FLAIR_MCP_ISSUER", "FLAIR_PUBLIC_URL"];
function clearEnv() { for (const k of ENV) delete process.env[k]; }

let httpCalls: { handler: any; options: any }[];
let withMCPAuthCalls: { handler: any; options: any }[];
let loadCount: number;

function makeDeps() {
  httpCalls = [];
  withMCPAuthCalls = [];
  loadCount = 0;
  return {
    server: { http: (handler: any, options: any) => { httpCalls.push({ handler, options }); } },
    loadWithMCPAuth: async () => {
      loadCount++;
      return (handler: any, options: any) => {
        withMCPAuthCalls.push({ handler, options });
        return { __wrapped: true, handler, options };
      };
    },
  };
}

beforeEach(clearEnv);

describe("registerMcpOAuthRoute — flag-OFF no-op", () => {
  it("flag OFF → server.http NEVER called, plugin NEVER loaded, returns false", async () => {
    clearEnv();
    const deps = makeDeps();
    const mounted = await registerMcpOAuthRoute(deps);
    expect(mounted).toBe(false);
    expect(httpCalls).toHaveLength(0);
    expect(loadCount).toBe(0); // the oauth plugin is not even imported when off
  });

  it("flag ON but no issuer → NOT mounted (no floating iss), returns false", async () => {
    clearEnv();
    process.env.FLAIR_MCP_OAUTH = "1";
    const deps = makeDeps();
    const mounted = await registerMcpOAuthRoute(deps);
    expect(mounted).toBe(false);
    expect(httpCalls).toHaveLength(0);
    expect(loadCount).toBe(0); // bails before loading the plugin
  });

  it("flag ON + issuer → withMCPAuth(handler) mounted on urlPath '/mcp'", async () => {
    clearEnv();
    process.env.FLAIR_MCP_OAUTH = "1";
    process.env.FLAIR_MCP_ISSUER = "https://flair.example.com";
    const deps = makeDeps();
    const mounted = await registerMcpOAuthRoute(deps);
    expect(mounted).toBe(true);
    expect(httpCalls).toHaveLength(1);
    // Registered on the /mcp urlPath subroute (its own chain).
    expect(httpCalls[0].options).toEqual({ urlPath: "/mcp" });
    // The registered handler is the withMCPAuth-wrapped one.
    expect(httpCalls[0].handler.__wrapped).toBe(true);
    // getConfig pins iss/resource for the wrapper.
    expect(withMCPAuthCalls).toHaveLength(1);
    const cfg = withMCPAuthCalls[0].options.getConfig();
    expect(cfg).toEqual({
      enabled: true,
      issuer: "https://flair.example.com",
      resource: "https://flair.example.com/mcp",
    });
  });
});
