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
  server: { http: () => {}, getUser: async () => null },
  Resource: NoopBase,
  databases: { flair: dbStub },
}));

const { AdminInstance } = await import("../../resources/AdminInstance.ts");
const { registerMcpOAuthRoute } = await import("../../resources/mcp-oauth.ts");
const { esc } = await import("../../resources/admin-layout.ts");

const ENV = ["FLAIR_MCP_OAUTH", "FLAIR_MCP_ISSUER", "FLAIR_PUBLIC_URL"];
function clearEnv() { for (const k of ENV) delete process.env[k]; }

/** Injected deps so registration never touches the real plugin or Harper server. */
function makeDeps() {
  return {
    server: { http: (_h: any, _o: any) => {} },
    loadWithMCPAuth: async () => (handler: any, _options: any) => handler,
    mcpHandler: () => ({ status: 200 }),
    skipComponentGuard: true,
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

// ── flair#1029: publicUrl output escaping ───────────────────────────────

describe("AdminInstance — publicUrl output escaping (flair#1029)", () => {
  /**
   * Render the Instance page with FLAIR_PUBLIC_URL set to `value`.
   * No Host header is provided, so resolvePublicUrl returns the env var.
   */
  async function renderWithPublicUrl(value: string): Promise<string> {
    process.env.FLAIR_PUBLIC_URL = value;
    const inst: any = new (AdminInstance as any)();
    inst.getContext = () => ({ request: {} });
    const res = await inst.get();
    return await res.text();
  }

  it("escapes HTML metacharacters in publicUrl at every interpolation site", async () => {
    const hostile = `https://evil.com/<script>alert('xss')</script>`;
    const html = await renderWithPublicUrl(hostile);

    // The raw metacharacters must not appear in the output.
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("alert('xss')");

    // The escaped equivalents must appear.
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("alert(&#39;xss&#39;)");

    // Every row in the Endpoints table must be escaped.
    // API row
    expect(html).toContain(`<code>${esc("https://evil.com/<script>alert('xss')</script>")}/</code>`);
    // OAuth Discovery row
    expect(html).toContain(`<code>${esc("https://evil.com/<script>alert('xss')</script>")}/OAuthMetadata</code>`);
    // OAuth Authorize row
    expect(html).toContain(`<code>${esc("https://evil.com/<script>alert('xss')</script>")}/OAuthAuthorize</code>`);
    // OAuth Token row
    expect(html).toContain(`<code>${esc("https://evil.com/<script>alert('xss')</script>")}/OAuthToken</code>`);
    // Admin row
    expect(html).toContain(`<code>${esc("https://evil.com/<script>alert('xss')</script>")}/AdminDashboard</code>`);
    // Public URL card
    expect(html).toContain(esc("https://evil.com/<script>alert('xss')</script>"));
  });

  it("positive control: an ordinary URL renders unchanged and still works as a link", async () => {
    const ordinary = "https://flair.example.com";
    const html = await renderWithPublicUrl(ordinary);

    // The URL must appear verbatim in every row.
    expect(html).toContain(`<code>${ordinary}/</code>`);
    expect(html).toContain(`<code>${ordinary}/OAuthMetadata</code>`);
    expect(html).toContain(`<code>${ordinary}/OAuthAuthorize</code>`);
    expect(html).toContain(`<code>${ordinary}/OAuthToken</code>`);
    expect(html).toContain(`<code>${ordinary}/AdminDashboard</code>`);

    // The Public URL card also shows it verbatim.
    expect(html).toContain(`<div style="font-family:monospace;font-size:0.9em;word-break:break-all">${ordinary}</div>`);

    // esc() is a no-op on ordinary URLs — verify that explicitly.
    expect(esc(ordinary)).toBe(ordinary);
  });
});
