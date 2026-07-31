/**
 * admin-instance-endpoints.test.ts — flair#1001: the admin Endpoints table
 * advertised `<publicUrl>/mcp` on every install, while `/mcp` is default-OFF
 * and 404s on a default install (indistinguishable from a path that does not
 * exist, while a registered POST route on the same instance answers 400).
 *
 * These tests render the REAL `AdminInstance.get()` HTML and drive the REAL
 * `registerMcpOAuthRoute()` to establish each state — so they cover the whole
 * path (router decision → recorded state → rendered row) rather than a
 * re-implementation of it. That matters here specifically: the bug being fixed
 * IS a second, independent description of the routing decision drifting from
 * the router, so a test that re-derives the flag would reproduce the defect one
 * level up.
 *
 * BOTH states are covered. A test that only asserted the flag-off row would
 * pass while the flag-on row rendered wrongly.
 *
 * harper is mocked (a superset shape matching mcp-oauth-register.test.ts) because
 * `resources/AdminInstance.ts` extends `Resource` and its `agent-auth` import
 * reads `databases` — importing the real `harper` outside a Harper process throws
 * ("Unable to determine database storage path"), which is the positive control
 * for why the mock is needed rather than an alternative to it.
 */
import { mock, describe, it, expect, beforeEach, afterAll } from "bun:test";

// Suppress mcp-oauth.ts's load-time fire-and-forget registration — each test
// calls registerMcpOAuthRoute() directly with injected deps.
process.env.FLAIR_MCP_NO_AUTOSTART = "1";

class NoopBase { constructor(_id?: any, _ctx?: any) {} }
const dbStub = new Proxy({}, { get: () => new Proxy({}, { get: () => NoopBase }) });
mock.module("harper", () => ({
  server: { http: () => {} },
  Resource: NoopBase,
  databases: { flair: dbStub },
}));

const { AdminInstance } = await import("../../resources/AdminInstance.ts");
const { registerMcpOAuthRoute } = await import("../../resources/mcp-oauth.ts");

const ENV = ["FLAIR_MCP_OAUTH", "FLAIR_MCP_ISSUER", "FLAIR_PUBLIC_URL"];
function clearEnv() { for (const k of ENV) delete process.env[k]; }

/** Injected deps so registration never touches the real plugin or Harper server. */
function makeDeps() {
  return {
    server: { http: (_h: any, _o: any) => {} },
    loadWithMCPAuth: async () => (handler: any, _options: any) => handler,
    mcpHandler: () => ({ status: 200 }),
  };
}

/**
 * Render the real Instance page. No FLAIR_PUBLIC_URL is set, so the public URL
 * is derived from the Host header → `https://flair.example.com`.
 */
async function renderInstancePage(): Promise<string> {
  const inst: any = new (AdminInstance as any)();
  inst.getContext = () => ({ request: { headers: { Host: "flair.example.com" } } });
  const res = await inst.get();
  return await res.text();
}

const MCP_URL = "https://flair.example.com/mcp";

beforeEach(clearEnv);
// Leave the module-global route state back at "not mounted" for any later file.
afterAll(async () => { clearEnv(); await registerMcpOAuthRoute(makeDeps()); });

describe("AdminInstance Endpoints table — MCP row (flair#1001)", () => {
  it("flag OFF (default install): no /mcp URL, row says not enabled and names the variable", async () => {
    const mounted = await registerMcpOAuthRoute(makeDeps());
    expect(mounted).toBe(false); // precondition: the route really is not mounted

    const html = await renderInstancePage();
    expect(html).toContain("Endpoints");
    // The defect: a live-looking URL for a path that 404s.
    expect(html).not.toContain(MCP_URL);
    // Actionable instead of silent — the operator learns the surface exists.
    expect(html).toContain("Not enabled");
    expect(html).toContain("FLAIR_MCP_OAUTH");
  });

  it("flag ON + issuer (route mounted): the /mcp URL is shown and no disabled marker", async () => {
    process.env.FLAIR_MCP_OAUTH = "1";
    process.env.FLAIR_MCP_ISSUER = "https://flair.example.com";
    const mounted = await registerMcpOAuthRoute(makeDeps());
    expect(mounted).toBe(true); // precondition: the route really is mounted

    const html = await renderInstancePage();
    expect(html).toContain(`<code>${MCP_URL}</code>`);
    expect(html).not.toContain("Not enabled");
    expect(html).not.toContain("FLAIR_MCP_OAUTH");
  });

  it("flag ON but issuer unset (route NOT mounted): no /mcp URL, row names the issuer variable", async () => {
    process.env.FLAIR_MCP_OAUTH = "1";
    const mounted = await registerMcpOAuthRoute(makeDeps());
    expect(mounted).toBe(false); // flag alone does not mount the route

    const html = await renderInstancePage();
    expect(html).not.toContain(MCP_URL);
    expect(html).toContain("FLAIR_MCP_ISSUER");
  });

  it("the sibling rows are unconditional routes and render in both states", async () => {
    // Confirmed against a default install: GET /OAuthMetadata 200,
    // GET /OAuthAuthorize 400, POST /OAuthToken 400, GET /AdminDashboard 401 —
    // all registered, unlike /mcp which 404s exactly like a nonexistent path.
    const siblings = [
      "https://flair.example.com/OAuthMetadata",
      "https://flair.example.com/OAuthAuthorize",
      "https://flair.example.com/OAuthToken",
      "https://flair.example.com/AdminDashboard",
    ];

    await registerMcpOAuthRoute(makeDeps()); // flag OFF
    const offHtml = await renderInstancePage();
    for (const url of siblings) expect(offHtml).toContain(`<code>${url}</code>`);

    process.env.FLAIR_MCP_OAUTH = "1";
    process.env.FLAIR_MCP_ISSUER = "https://flair.example.com";
    await registerMcpOAuthRoute(makeDeps()); // flag ON
    const onHtml = await renderInstancePage();
    for (const url of siblings) expect(onHtml).toContain(`<code>${url}</code>`);
  });
});
