/**
 * OAuth consent page — every value interpolated into the page is escaped, and
 * `state` is validated as opaque (printable ASCII, bounded) before rendering.
 * An unknown scope is refused with `invalid_scope`. The page also carries a
 * Content-Security-Policy and `X-Content-Type-Options: nosniff`.
 *
 * Isolated lane: this file stubs `harper` for `databases`, so it must run
 * one-process-per-file (flair#1817) — the shared `test/unit` process would let
 * its stub poison a sibling file's module cache.
 */
import { mock, describe, it, expect, beforeEach } from "bun:test";

interface StoredClient { name: string; redirectUris: string[]; }
const CLIENTS = new Map<string, StoredClient>();

// Same shape as the sibling isolated tests' harper stub: `Resource` and every
// unknown `databases.flair.*` model is a no-op class (XAA.ts extends
// `databases.flair.IdpConfig` at load time), while `OAuthClient.get` answers
// from CLIENTS.
class NoopBase { constructor(_id?: any, _ctx?: any) {} }
const flairStub = new Proxy({}, {
  get: (_t, prop) => (prop === "OAuthClient" ? { get: async (id: string) => CLIENTS.get(id) ?? null } : NoopBase),
});

mock.module("harper", () => ({
  server: { http: () => {}, getUser: async () => null },
  Resource: NoopBase,
  databases: { flair: flairStub },
}));

const { OAuthAuthorize } = await import("../../resources/OAuth.ts");

const BASE = "https://flair.example.com/OAuthAuthorize";
const CLIENT_ID = "flair_cl_test";
const ALLOWED_REDIRECT_URI = "https://claude.com/api/mcp/auth_callback";
/** Bland probe: angle brackets and quotes, not a script tag. */
const VALUE = "a<b>c\"d'e`f";
const ESCAPED = "a&lt;b&gt;c&quot;d&#39;e&#96;f";

beforeEach(() => {
  CLIENTS.clear();
  CLIENTS.set(CLIENT_ID, { name: "Example App", redirectUris: [] });
});

function q(params: Record<string, string>): string {
  return "?" + new URLSearchParams({ response_type: "code", client_id: CLIENT_ID, ...params }).toString();
}
function authorize(query: string): Promise<Response> {
  const inst: any = new (OAuthAuthorize as any)();
  inst.getContext = () => ({ request: { url: `${BASE}${query}` } });
  return inst.get();
}

describe("OAuth consent page — escaping and validation", () => {
  it("renders a normal consent request, with each interpolated value rendered correctly", async () => {
    const res = await authorize(q({ scope: "memory:read", state: "abc123" }));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<h1>Authorize Example App</h1>");
    expect(html).toContain('<div class="scope">memory:read</div>');
    expect(html).toContain(`name="client_id" value="${CLIENT_ID}"`);
    expect(html).toContain(`name="redirect_uri" value="${ALLOWED_REDIRECT_URI}"`);
    expect(html).toContain('name="scope" value="memory:read"');
    expect(html).toContain('name="state" value="abc123"');
    expect(html).toContain('<form method="POST" action="/OAuthAuthorize"');
  });

  it("escapes the state rendered into the hidden input", async () => {
    const html = await (await authorize(q({ state: VALUE }))).text();
    expect(html).toContain(`name="state" value="${ESCAPED}"`);
    expect(html).not.toContain(VALUE);
  });

  it("escapes code_challenge and code_challenge_method", async () => {
    const html = await (
      await authorize(q({ code_challenge: VALUE, code_challenge_method: VALUE }))
    ).text();
    expect(html).toContain(`name="code_challenge" value="${ESCAPED}"`);
    expect(html).toContain(`name="code_challenge_method" value="${ESCAPED}"`);
    expect(html).not.toContain(VALUE);
  });

  it("escapes the client name rendered in the heading", async () => {
    CLIENTS.set(CLIENT_ID, { name: VALUE, redirectUris: [] });
    const html = await (await authorize(q({}))).text();
    expect(html).toContain(`<h1>Authorize ${ESCAPED}</h1>`);
    expect(html).not.toContain(VALUE);
  });

  it("refuses a redirect_uri or client_id that carries markup", async () => {
    const badRedirect = await authorize(q({ redirect_uri: VALUE }));
    expect(badRedirect.status).toBe(400);
    expect(await badRedirect.json()).toMatchObject({ error: "invalid_redirect_uri" });

    const badClient = await authorize(q({ client_id: VALUE }));
    expect(badClient.status).toBe(400);
    expect(await badClient.json()).toMatchObject({ error: "invalid_client" });
  });

  it("refuses a state that is not printable ASCII, and one that is too long", async () => {
    const newline = await authorize(q({ state: "a\nb" }));
    expect(newline.status).toBe(400);
    expect(await newline.json()).toMatchObject({ error: "invalid_request" });

    const long = await authorize(q({ state: "x".repeat(513) }));
    expect(long.status).toBe(400);

    const maxLength = await authorize(q({ state: "x".repeat(512) }));
    expect(maxLength.status).toBe(200);
  });

  it("refuses an unknown scope with invalid_scope", async () => {
    const res = await authorize(q({ scope: "memory:read not:a:scope" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_scope" });
  });

  it("sends a Content-Security-Policy and nosniff on the consent page", async () => {
    const res = await authorize(q({}));
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("style-src 'unsafe-inline'");
    // The consent form's POST answers with a 302 to the pinned callback, and
    // `form-action` is enforced across redirects — so the directive allows
    // 'self' AND exactly the callback's origin (derived from the same constant).
    expect(csp).toContain(`form-action 'self' ${new URL(ALLOWED_REDIRECT_URI).origin}`);
    const formAction = csp
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith("form-action"));
    expect(formAction).toBe(`form-action 'self' ${new URL(ALLOWED_REDIRECT_URI).origin}`);
    expect(csp).not.toContain("script-src");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("keeps a real consent flow working: the form renders and the deny POST still redirects", async () => {
    const res = await authorize(q({ scope: "memory:read memory:write", state: "s1" }));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('name="action" value="approve"');
    expect(html).toContain('name="action" value="deny"');
    expect(html).toContain('<div class="scope">memory:read</div>');
    expect(html).toContain('<div class="scope">memory:write</div>');

    const inst: any = new (OAuthAuthorize as any)();
    inst.getContext = () => ({ request: { headers: { Host: "flair.example.com" } } });
    const denied = await inst.post({ action: "deny", client_id: CLIENT_ID, redirect_uri: "", state: "s1" });
    expect(denied.status).toBe(302);
    expect(denied.headers.get("location")).toContain("access_denied");
  });
});
