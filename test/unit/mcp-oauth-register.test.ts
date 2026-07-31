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
 * side effect or the real Harper `server`. harper is mocked only so
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
mock.module("harper", () => ({
  server: { http: () => {} },
  Resource: NoopBase,
  databases: { flair: dbStub },
}));
// NO mock.module for ./mcp-handler.ts: mcp-oauth.ts no longer statically imports
// it (it's resolved lazily / via deps.mcpHandler), so loading mcp-oauth.ts here
// doesn't pull in the resource graph and there's nothing to stub for link-time.
// The handler is injected via deps.mcpHandler in makeDeps() below. Crucially,
// this file must NOT process-globally mock a module that mcp-handler.test.ts
// legitimately `await import(...)`s for real — that was the source of the
// intermittent "35 tests failed" flake in mcp-handler.test.ts.

const { registerMcpOAuthRoute, mcpRouteState, rateLimitedMcpHandler } = await import("../../resources/mcp-oauth.ts");
const { __resetBucketsForTest } = await import("../../resources/rate-limit.ts");

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
    // Inject the /mcp handler directly (replaces the old process-global
    // mock.module of ./mcp-handler.ts) — same shape the mock used to return.
    mcpHandler: () => ({ status: 200 }),
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

  it("the handler handed to withMCPAuth is the RATE-LIMITED one, not the bare handler", async () => {
    // The wrapper has to sit INSIDE withMCPAuth so it can key on the verified
    // token subject. If a future edit passes `handler` straight through, /mcp
    // goes back to being unthrottled for anyone holding a valid token — with no
    // other symptom. This asserts the composition, so that edit fails here.
    clearEnv();
    process.env.FLAIR_MCP_OAUTH = "1";
    process.env.FLAIR_MCP_ISSUER = "https://flair.example.com";
    const deps = makeDeps();
    await registerMcpOAuthRoute(deps);
    expect(withMCPAuthCalls[0].handler).not.toBe(deps.mcpHandler);
  });
});

describe("rateLimitedMcpHandler", () => {
  const MCP_ENV = ["FLAIR_MCP_RATE_LIMIT", "FLAIR_RATE_LIMIT"];
  let savedMcpEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    __resetBucketsForTest();
    savedMcpEnv = {};
    for (const k of MCP_ENV) { savedMcpEnv[k] = process.env[k]; delete process.env[k]; }
  });

  const restore = () => {
    for (const k of MCP_ENV) {
      if (savedMcpEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedMcpEnv[k];
    }
  };

  const call = (sub: string) => ({ mcp: { sub, client_id: "cid" }, ip: "203.0.113.7" });

  it("POSITIVE CONTROL: calls under the limit reach the real handler", async () => {
    process.env.FLAIR_MCP_RATE_LIMIT = "3";
    let reached = 0;
    const wrapped = rateLimitedMcpHandler(async () => { reached++; return { status: 200 }; });
    for (let i = 0; i < 3; i++) expect((await wrapped(call("s1"))).status).toBe(200);
    expect(reached).toBe(3);
    restore();
  });

  it("over the limit it returns 429 and the real handler is NEVER invoked", async () => {
    process.env.FLAIR_MCP_RATE_LIMIT = "2";
    let reached = 0;
    const wrapped = rateLimitedMcpHandler(async () => { reached++; return { status: 200 }; });
    for (let i = 0; i < 2; i++) await wrapped(call("s1"));
    const res = await wrapped(call("s1"));
    expect(res.status).toBe(429);
    expect(reached).toBe(2); // the tool surface was not touched by the rejected call
    restore();
  });

  it("a different verified subject is unaffected by another's exhausted budget", async () => {
    process.env.FLAIR_MCP_RATE_LIMIT = "2";
    const wrapped = rateLimitedMcpHandler(async () => ({ status: 200 }));
    for (let i = 0; i < 3; i++) await wrapped(call("s1"));
    expect((await wrapped(call("s1"))).status).toBe(429);
    expect((await wrapped(call("s2"))).status).toBe(200);
    restore();
  });
});

/**
 * flair#1001 — the router publishes what it decided, so consumers that describe
 * the surface (the admin Endpoints table) never have to re-read the flag and
 * cannot disagree with the routing decision. These assertions pin the recorded
 * state to the same branch that produced the `mounted` return value.
 */
describe("mcpRouteState — the router's own record of the mount decision", () => {
  it("flag OFF → not mounted, and the status names the flag that would enable it", async () => {
    clearEnv();
    await registerMcpOAuthRoute(makeDeps());
    const state = mcpRouteState();
    expect(state.mounted).toBe(false);
    expect((state as any).status).toBe("Not enabled");
    expect((state as any).reason).toContain("FLAIR_MCP_OAUTH");
  });

  it("flag ON but no issuer → still not mounted, and the reason names the issuer variable", async () => {
    clearEnv();
    process.env.FLAIR_MCP_OAUTH = "1";
    await registerMcpOAuthRoute(makeDeps());
    const state = mcpRouteState();
    // The flag alone is not enough — this is why a consumer re-reading
    // FLAIR_MCP_OAUTH would still advertise a /mcp that 404s.
    expect(state.mounted).toBe(false);
    expect((state as any).reason).toContain("FLAIR_MCP_ISSUER");
  });

  it("flag ON + issuer → mounted, matching the route that was actually registered", async () => {
    clearEnv();
    process.env.FLAIR_MCP_OAUTH = "1";
    process.env.FLAIR_MCP_ISSUER = "https://flair.example.com";
    await registerMcpOAuthRoute(makeDeps());
    expect(mcpRouteState().mounted).toBe(true);
    expect(httpCalls[0].options).toEqual({ urlPath: "/mcp" });
  });

  it("the recorded state always agrees with the returned mounted value", async () => {
    for (const env of [
      {},
      { FLAIR_MCP_OAUTH: "1" },
      { FLAIR_MCP_OAUTH: "1", FLAIR_MCP_ISSUER: "https://flair.example.com" },
      { FLAIR_MCP_OAUTH: "off", FLAIR_MCP_ISSUER: "https://flair.example.com" },
    ] as Array<Record<string, string>>) {
      clearEnv();
      Object.assign(process.env, env);
      const mounted = await registerMcpOAuthRoute(makeDeps());
      expect(mcpRouteState().mounted).toBe(mounted);
    }
    clearEnv();
  });
});
