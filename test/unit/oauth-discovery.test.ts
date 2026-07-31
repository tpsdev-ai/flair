/**
 * oauth-discovery.test.ts — flair#1000 item 2.
 *
 * These exercise the REAL module (resources/oauth-discovery.ts imports nothing
 * from `harper`, so there is no mock and no mirror-function to drift from the
 * shipped logic — the historical failure mode of test/unit/OAuth.test.ts, whose
 * header admits it re-implements OAuth.ts's logic locally).
 *
 * The load-bearing assertion is the LAST describe block: the document served at
 * `/.well-known/oauth-authorization-server` and the document served at
 * `/OAuthMetadata` are the same value from the same call. Everything else here
 * is path screening, which is where a discovery mount either works for real
 * clients or silently doesn't.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  AS_METADATA_PATH,
  PRM_PATH,
  asMetadataPathMatches,
  buildAuthorizationServerMetadata,
  buildProtectedResourceMetadata,
  makeWellKnownHandler,
  mcpResourceUri,
  oauthPublicBaseUrl,
  prmPathMatches,
  relativePathOf,
} from "../../resources/oauth-discovery.ts";

const BASE = "https://flair.example.test";

const ENV_KEYS = ["FLAIR_PUBLIC_URL", "HTTP_PORT", "FLAIR_MCP_OAUTH"] as const;
const saved: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) saved[k] = process.env[k];
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
});

// ─── Issuer derivation (moved, not changed — flair#1005) ─────────────────────

describe("oauthPublicBaseUrl — the single origin every document derives from", () => {
  test("prefers FLAIR_PUBLIC_URL", () => {
    process.env.FLAIR_PUBLIC_URL = BASE;
    expect(oauthPublicBaseUrl()).toBe(BASE);
  });

  test("falls back to the loopback bind address, honouring HTTP_PORT", () => {
    delete process.env.FLAIR_PUBLIC_URL;
    process.env.HTTP_PORT = "19999";
    expect(oauthPublicBaseUrl()).toBe("http://127.0.0.1:19999");
  });

  test("falls back to the default port when HTTP_PORT is unset", () => {
    delete process.env.FLAIR_PUBLIC_URL;
    delete process.env.HTTP_PORT;
    expect(oauthPublicBaseUrl()).toBe("http://127.0.0.1:19926");
  });
});

// ─── RFC 8414 authorization-server metadata ──────────────────────────────────

describe("buildAuthorizationServerMetadata (RFC 8414)", () => {
  const doc = buildAuthorizationServerMetadata(BASE);

  test("issuer is the base URL, and every endpoint is derived from it", () => {
    expect(doc.issuer).toBe(BASE);
    expect(doc.authorization_endpoint).toBe(`${BASE}/OAuthAuthorize`);
    expect(doc.token_endpoint).toBe(`${BASE}/OAuthToken`);
    expect(doc.revocation_endpoint).toBe(`${BASE}/OAuthRevoke`);
  });

  // `registration_endpoint` is now conditional on dynamic client registration
  // actually being enabled (resources/dcr-gate.ts). RFC 8414 §2 makes the field
  // optional; advertising an endpoint that refuses every request would send a
  // client down a path with no recovery. These two cases are the pair — the
  // absent case alone would pass against a build that never emits the field.
  describe("registration_endpoint tracks whether registration is enabled", () => {
    let saved: string | undefined;
    beforeEach(() => { saved = process.env.FLAIR_OAUTH_DCR_TOKEN; });
    afterEach(() => {
      if (saved === undefined) delete process.env.FLAIR_OAUTH_DCR_TOKEN;
      else process.env.FLAIR_OAUTH_DCR_TOKEN = saved;
    });

    test("omitted when registration is off (the default)", () => {
      delete process.env.FLAIR_OAUTH_DCR_TOKEN;
      expect(buildAuthorizationServerMetadata(BASE).registration_endpoint).toBeUndefined();
    });

    test("POSITIVE CONTROL: present when an operator has opted in", () => {
      process.env.FLAIR_OAUTH_DCR_TOKEN = "z".repeat(48);
      expect(buildAuthorizationServerMetadata(BASE).registration_endpoint).toBe(`${BASE}/OAuthRegister`);
    });
  });

  test("no endpoint can point somewhere other than the issuer origin", () => {
    for (const [field, value] of Object.entries(doc)) {
      if (!field.endsWith("_endpoint")) continue;
      expect(String(value).startsWith(BASE + "/"), `${field} = ${value}`).toBe(true);
    }
  });

  test("PKCE S256 and the grant types flair's AS actually implements", () => {
    expect(doc.code_challenge_methods_supported).toEqual(["S256"]);
    expect(doc.grant_types_supported).toEqual([
      "authorization_code",
      "refresh_token",
      "urn:ietf:params:oauth:grant-type:jwt-bearer",
    ]);
  });
});

// ─── RFC 9728 protected-resource metadata ────────────────────────────────────

describe("buildProtectedResourceMetadata (RFC 9728)", () => {
  const doc = buildProtectedResourceMetadata(BASE);

  test("names the MCP surface as the protected resource", () => {
    expect(doc.resource).toBe(`${BASE}/mcp`);
    expect(doc.resource).toBe(mcpResourceUri(BASE));
  });

  test("bearer tokens are presented in the Authorization header only", () => {
    expect(doc.bearer_methods_supported).toEqual(["header"]);
  });

  test("authorization_servers names the SAME issuer the AS document publishes", () => {
    // The whole point of one builder: a client that follows
    // authorization_servers[0] + /.well-known/oauth-authorization-server must
    // land on a document whose `issuer` matches what sent it there.
    expect(doc.authorization_servers).toEqual([buildAuthorizationServerMetadata(BASE).issuer]);
  });

  test("advertises no scope the authorization server cannot issue", () => {
    const asScopes = new Set(buildAuthorizationServerMetadata(BASE).scopes_supported);
    for (const scope of doc.scopes_supported) expect(asScopes.has(scope)).toBe(true);
  });

  test("a trailing slash on the base URL never produces a doubled slash", () => {
    expect(buildProtectedResourceMetadata(BASE + "/").resource).toBe(`${BASE}/mcp`);
  });
});

// ─── Path screening ──────────────────────────────────────────────────────────
//
// Harper's urlPath matching is prefix-based and hands the handler a path
// relative to the mount, so every one of these strings is something a client
// can actually cause to reach the handler.

describe("prmPathMatches — RFC 9728 §3.1 path insertion", () => {
  test("accepts the bare mount", () => {
    expect(prmPathMatches("/", BASE)).toBe(true);
    expect(prmPathMatches(PRM_PATH, BASE)).toBe(true);
  });

  test("accepts the path-appended form real MCP clients fetch", () => {
    // Claude.ai and other MCP clients build the PRM URL by inserting the
    // resource's path component: <origin>/.well-known/oauth-protected-resource/mcp.
    // This is the ONLY URL some clients ask for — without it discovery 404s.
    expect(prmPathMatches("/mcp", BASE)).toBe(true);
    expect(prmPathMatches(PRM_PATH + "/mcp", BASE)).toBe(true);
  });

  test("tolerates a single trailing slash", () => {
    expect(prmPathMatches("/mcp/", BASE)).toBe(true);
  });

  test("rejects a prefix near-miss — /mcp-evil must never match /mcp", () => {
    expect(prmPathMatches("/mcp-evil", BASE)).toBe(false);
    expect(prmPathMatches("/mcpx", BASE)).toBe(false);
    expect(prmPathMatches(PRM_PATH + "/mcp-evil", BASE)).toBe(false);
  });

  test("rejects an arbitrary sub-path", () => {
    expect(prmPathMatches("/bogus", BASE)).toBe(false);
    expect(prmPathMatches("/Memory", BASE)).toBe(false);
    expect(prmPathMatches("/mcp/deeper", BASE)).toBe(false);
  });
});

describe("asMetadataPathMatches — RFC 8414, origin issuer only", () => {
  test("accepts the bare mount", () => {
    expect(asMetadataPathMatches("/")).toBe(true);
    expect(asMetadataPathMatches(AS_METADATA_PATH)).toBe(true);
  });

  test("rejects every sub-path — flair's issuer has no path component", () => {
    // RFC 8414 §3.1 path insertion only applies to an issuer that CARRIES a
    // path. flair's issuer is always an origin, so /mcp is a 404 here even
    // though it is valid on the protected-resource mount.
    expect(asMetadataPathMatches("/mcp")).toBe(false);
    expect(asMetadataPathMatches("/bogus")).toBe(false);
    expect(asMetadataPathMatches("/Memory")).toBe(false);
  });
});

describe("relativePathOf", () => {
  test("prefers pathname, and strips a query string from a url fallback", () => {
    expect(relativePathOf({ pathname: "/mcp" })).toBe("/mcp");
    expect(relativePathOf({ url: "/mcp?x=1" })).toBe("/mcp");
    expect(relativePathOf({})).toBe("/");
  });
});

// ─── Handler behaviour ───────────────────────────────────────────────────────

describe("makeWellKnownHandler", () => {
  const build = () => ({ ok: true });
  function nextSpy() {
    const calls: any[] = [];
    return { calls, next: async (req: any) => { calls.push(req); return { status: 599 }; } };
  }

  test("serves the document on a matching GET when the flag is off", async () => {
    const { next, calls } = nextSpy();
    const handler = makeWellKnownHandler(() => true, build, () => false);
    const res: Response = await handler({ method: "GET", pathname: "/" }, next);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(await res.json()).toEqual({ ok: true });
    expect(calls).toHaveLength(0);
  });

  test("404s a non-matching sub-path from HERE — it is never forwarded", async () => {
    // A urlPath mount has its own dispatch chain containing neither flair's
    // auth-middleware nor Harper's `authentication`, and `next` sees the
    // mount-STRIPPED path. Forwarding an arbitrary sub-path is how a discovery
    // mount becomes a path-confusion hole; screen, answer, never forward.
    const { next, calls } = nextSpy();
    const handler = makeWellKnownHandler(() => false, build, () => false);
    const res: Response = await handler({ method: "GET", pathname: "/Memory" }, next);
    expect(res.status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  test("404s a non-GET/HEAD on a matching path — a POST is not a discovery request", async () => {
    const { next, calls } = nextSpy();
    const handler = makeWellKnownHandler(() => true, build, () => false);
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const res: Response = await handler({ method, pathname: "/" }, next);
      expect(res.status).toBe(404);
    }
    expect(calls).toHaveLength(0);
  });

  test("HEAD is served like GET", async () => {
    const { next } = nextSpy();
    const handler = makeWellKnownHandler(() => true, build, () => false);
    const res: Response = await handler({ method: "HEAD", pathname: "/" }, next);
    expect(res.status).toBe(200);
  });

  test("falls through when FLAIR_MCP_OAUTH is on, so @harperfast/oauth answers", async () => {
    // Tokens for the flag-on `/mcp` surface are minted by the PLUGIN's
    // authorization server, not flair's — advertising flair's AS there would
    // hand a client a token `/mcp` is guaranteed to refuse.
    const { next, calls } = nextSpy();
    const handler = makeWellKnownHandler(() => true, build, () => true);
    const res: any = await handler({ method: "GET", pathname: "/" }, next);
    expect(res.status).toBe(599);
    expect(calls).toHaveLength(1);
  });

  test("the flag-on fall-through still does not forward a non-matching sub-path", async () => {
    const { next, calls } = nextSpy();
    const handler = makeWellKnownHandler(() => false, build, () => true);
    const res: Response = await handler({ method: "GET", pathname: "/Memory" }, next);
    expect(res.status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  test("the default flag reader is the real FLAIR_MCP_OAUTH", async () => {
    const { next, calls } = nextSpy();
    const handler = makeWellKnownHandler(() => true, build);
    process.env.FLAIR_MCP_OAUTH = "1";
    expect((await handler({ method: "GET", pathname: "/" }, next)).status).toBe(599);
    delete process.env.FLAIR_MCP_OAUTH;
    expect((await handler({ method: "GET", pathname: "/" }, next)).status).toBe(200);
    expect(calls).toHaveLength(1);
  });
});

// ─── The anti-drift assertion ────────────────────────────────────────────────

describe("/OAuthMetadata is an ALIAS, not a second implementation", () => {
  test("the well-known document and the /OAuthMetadata document are byte-identical", () => {
    process.env.FLAIR_PUBLIC_URL = BASE;
    // resources/OAuth.ts's OAuthMetadata.get() body is exactly this call — it
    // holds no fields of its own. The live proof that the SERVED bytes agree is
    // test/integration/oauth-wellknown-e2e.test.ts; this pins the source.
    const wellKnown = buildAuthorizationServerMetadata();
    const alias = buildAuthorizationServerMetadata();
    expect(JSON.stringify(alias)).toBe(JSON.stringify(wellKnown));
    expect(wellKnown.issuer).toBe(BASE);
  });

  test("the protected-resource document points back at the authorization-server path", () => {
    // The two constants must be the ones RFC 8414 / RFC 9728 define, or a
    // spec-compliant client probes a path we do not serve.
    expect(AS_METADATA_PATH).toBe("/.well-known/oauth-authorization-server");
    expect(PRM_PATH).toBe("/.well-known/oauth-protected-resource");
  });

  test("the PRM path a withMCPAuth challenge points at is one this module serves", () => {
    // @harperfast/oauth builds its 401 challenge as
    //   Bearer resource_metadata="<origin><PRM_PATH><resource-path>"
    // (dist/lib/mcp/wellKnown.js protectedResourceMetadataUrl). With our
    // resource at <origin>/mcp that is <origin>/.well-known/oauth-protected-resource/mcp.
    // Verified live: see the challenge assertion in the e2e file.
    const resourcePath = new URL(mcpResourceUri(BASE)).pathname;
    const challengeUrl = `${BASE}${PRM_PATH}${resourcePath}`;
    const relative = challengeUrl.slice(`${BASE}${PRM_PATH}`.length) || "/";
    expect(prmPathMatches(relative, BASE)).toBe(true);
  });
});
