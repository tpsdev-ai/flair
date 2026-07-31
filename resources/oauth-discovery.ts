/**
 * oauth-discovery.ts — the ONE builder for every OAuth discovery document
 * flair serves, the paths they are served at, and the request handlers that
 * serve them. Deliberately free of any `harper` import so all of it is
 * directly unit-testable; the Harper route registration lives next door in
 * resources/oauth-wellknown.ts.
 *
 * Three surfaces render these documents:
 *
 *   - `GET /OAuthMetadata`                          (resources/OAuth.ts, historical path)
 *   - `GET /.well-known/oauth-authorization-server` (RFC 8414)
 *   - `GET /.well-known/oauth-protected-resource`   (RFC 9728)
 *
 * The first two return the SAME object from the SAME function — `/OAuthMetadata`
 * is an ALIAS, not a second implementation. Two endpoints that can drift apart
 * is the defect this module exists to make impossible: a field added to the
 * authorization-server document appears at both paths or at neither, and there
 * is no code path that can produce one without the other.
 *
 * ── Issuer derivation is NOT redefined here ─────────────────────────────────
 * `oauthPublicBaseUrl()` is the expression `OAuthMetadata.get()` already used,
 * moved verbatim: `FLAIR_PUBLIC_URL`, else the loopback bind address. Operators
 * MUST set `FLAIR_PUBLIC_URL` on any non-loopback deployment (docs/deploying-on-
 * fabric.md, resources/AdminInstance.ts) or every URL in every one of these
 * documents points at the CLIENT's own localhost. That requirement, and the
 * `loadEnv` declaration that makes a component `.env` actually reach
 * `process.env`, shipped in flair#1005 — deliberately untouched here.
 */

import { mcpOAuthEnabled } from "./mcp-oauth-flag.js";
import { dcrEnabled } from "./dcr-gate.js";

/** RFC 9728 §3.1 — Protected Resource Metadata well-known path. */
export const PRM_PATH = "/.well-known/oauth-protected-resource";

/** RFC 8414 §3 — Authorization Server Metadata well-known path. */
export const AS_METADATA_PATH = "/.well-known/oauth-authorization-server";

/**
 * The public origin every URL in every discovery document derives from.
 *
 * Verbatim the expression `OAuthMetadata.get()` carried before this module
 * existed — moved, not changed. See the header note on flair#1005.
 */
export function oauthPublicBaseUrl(): string {
  return process.env.FLAIR_PUBLIC_URL || `http://127.0.0.1:${process.env.HTTP_PORT || 19926}`;
}

/**
 * The RFC 8707 resource identifier of flair's MCP surface: `<base>/mcp`.
 *
 * Matches `mcpResource()` in resources/mcp-oauth-flag.ts by construction —
 * that is the URI `withMCPAuth` audience-binds tokens to when the Model-2
 * surface is enabled, so the protected-resource document must name the same
 * string or a client would audience-bind its token to something `/mcp` rejects.
 *
 * It names `/mcp` even when `FLAIR_MCP_OAUTH` is off and `/mcp` therefore
 * 404s. That is a coherent state, not a lie: RFC 9728 metadata describes how a
 * resource WOULD be authorized; a client that discovers the authorization
 * server and then finds no `/mcp` has learned something true. The alternative —
 * naming the origin itself as the protected resource — would be the actual
 * lie, because no flair REST resource accepts a bearer token (see
 * resources/oauth-wellknown.ts's header for that measurement).
 */
export function mcpResourceUri(baseUrl: string = oauthPublicBaseUrl()): string {
  return `${baseUrl.replace(/\/+$/, "")}/mcp`;
}

/**
 * RFC 8414 Authorization Server Metadata — flair's own OAuth 2.1 AS
 * (resources/OAuth.ts): `/OAuthAuthorize`, `/OAuthToken`, `/OAuthRegister`,
 * `/OAuthRevoke`.
 *
 * Served at BOTH `/.well-known/oauth-authorization-server` and `/OAuthMetadata`.
 *
 * `registration_endpoint` is present ONLY while dynamic client registration is
 * actually enabled (resources/dcr-gate.ts). RFC 8414 s2 makes the field
 * OPTIONAL, and advertising an endpoint that refuses every request is a
 * discovery document that misdirects: a client would follow it, be refused, and
 * have learned nothing it can act on. Omitting it tells the truth — this server
 * does not do dynamic registration — which is a state a spec-compliant client
 * already knows how to handle.
 */
export function buildAuthorizationServerMetadata(baseUrl: string = oauthPublicBaseUrl()) {
  return {
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/OAuthAuthorize`,
    token_endpoint: `${baseUrl}/OAuthToken`,
    ...(dcrEnabled() ? { registration_endpoint: `${baseUrl}/OAuthRegister` } : {}),
    revocation_endpoint: `${baseUrl}/OAuthRevoke`,
    response_types_supported: ["code"],
    grant_types_supported: [
      "authorization_code",
      "refresh_token",
      "urn:ietf:params:oauth:grant-type:jwt-bearer",
    ],
    token_endpoint_auth_methods_supported: ["none", "client_secret_basic"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: [
      "memory:read", "memory:write", "memory:admin",
      "principal:read", "principal:admin",
      "connector:read", "connector:admin",
    ],
    extensions_supported: [
      "io.modelcontextprotocol/enterprise-managed-authorization",
    ],
  };
}

/**
 * RFC 9728 Protected Resource Metadata for flair's MCP surface.
 *
 * `authorization_servers` names the SAME `issuer` string the authorization-
 * server document publishes — both come from `oauthPublicBaseUrl()`, so a
 * client that follows `authorization_servers[0]` +
 * `/.well-known/oauth-authorization-server` lands on a document whose `issuer`
 * matches what sent it there. That loop closing is asserted end-to-end in
 * test/integration/oauth-wellknown-e2e.test.ts.
 *
 * `scopes_supported` is deliberately the same list the AS advertises rather
 * than a second, narrower one — a resource advertising scopes the AS cannot
 * issue would send clients into a guaranteed `invalid_scope`.
 */
export function buildProtectedResourceMetadata(baseUrl: string = oauthPublicBaseUrl()) {
  const as = buildAuthorizationServerMetadata(baseUrl);
  return {
    resource: mcpResourceUri(baseUrl),
    authorization_servers: [as.issuer],
    // RFC 9728 §2 — the only presentation method `withMCPAuth` accepts is the
    // Authorization header; it never reads a form or query-parameter token.
    bearer_methods_supported: ["header"],
    scopes_supported: as.scopes_supported,
  };
}

// ─── Path screening ──────────────────────────────────────────────────────────
//
// Harper's `server.http({ urlPath })` matching is prefix-based and passes the
// path RELATIVE to the mount, so every sub-path of a mount reaches its handler
// and has to be screened here — otherwise
// `/.well-known/oauth-protected-resource/anything` would answer with flair's
// document.

/**
 * Does a request address the protected-resource document?
 *
 * Accepted:
 *   - `/`      the bare well-known path
 *   - `/mcp`   RFC 9728 §3.1 path-insertion for the resource `<base>/mcp`. MCP
 *              clients (Claude.ai among them) build the PRM URL by inserting
 *              the resource's path component and fetch THIS form, so without
 *              it the discovery loop 404s on the only URL a real client asks for.
 *   - the absolute forms of both, for Harper builds that pass an unstripped path.
 *
 * Exact-after-normalization, never a prefix test — `/mcp-evil` must not match
 * `/mcp`.
 */
export function prmPathMatches(relativePath: string, baseUrl: string = oauthPublicBaseUrl()): boolean {
  const path = normalizePath(relativePath);
  if (path === "/" || path === PRM_PATH) return true;
  const resourcePath = resourcePathOf(baseUrl);
  if (!resourcePath) return false;
  return path === resourcePath || path === PRM_PATH + resourcePath;
}

/**
 * Same screen for the authorization-server document. RFC 8414 §3.1 path-
 * insertion applies to an issuer that CARRIES a path component; flair's issuer
 * is always an origin, so only the bare path is valid here and every sub-path
 * is a 404.
 */
export function asMetadataPathMatches(relativePath: string): boolean {
  const path = normalizePath(relativePath);
  return path === "/" || path === AS_METADATA_PATH;
}

/** Strip a single trailing slash so `/mcp/` and `/mcp` screen identically. */
function normalizePath(path: string): string {
  if (!path) return "/";
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

/** The path component of the protected resource URI (`/mcp`), or "" if unparseable. */
function resourcePathOf(baseUrl: string): string {
  try {
    const { pathname } = new URL(mcpResourceUri(baseUrl));
    return pathname && pathname !== "/" ? pathname.replace(/\/+$/, "") : "";
  } catch {
    return "";
  }
}

// ─── Handlers ────────────────────────────────────────────────────────────────

function discoveryResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json",
      // Discovery documents are unauthenticated, non-secret, and fetched
      // cross-origin by browser-based MCP clients and inspectors. Simple `*` is
      // sufficient because no credentials are ever involved. Matches what
      // @harperfast/oauth sets on the same documents.
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, OPTIONS",
    },
  });
}

function notFound(): Response {
  return new Response(JSON.stringify({ error: "not_found" }), {
    status: 404,
    headers: { "content-type": "application/json" },
  });
}

/** The mount-relative path Harper hands the handler, query string removed. */
export function relativePathOf(request: any): string {
  const raw: string = request?.pathname ?? request?.url ?? "/";
  const q = raw.indexOf("?");
  return q >= 0 ? raw.slice(0, q) : raw;
}

/**
 * Build the handler for one well-known document.
 *
 * Three behaviours, in order:
 *
 *  1. A path under the mount that is NOT one of the accepted discovery forms
 *     gets a 404 from HERE — it is never passed to `next`. A urlPath mount has
 *     its OWN dispatch chain that contains neither flair's auth-middleware nor
 *     Harper's `authentication`, and `next` strips the mount prefix, so passing
 *     an arbitrary sub-path onward is how a discovery mount turns into a path-
 *     confusion hole. Screen, then answer; never forward.
 *  2. `FLAIR_MCP_OAUTH` on → fall through for the accepted forms, so
 *     @harperfast/oauth's own well-known handlers (identical urlPath, same
 *     dispatch group) answer for the surface they actually guard. See
 *     resources/oauth-wellknown.ts's header for why flair's AS must not be
 *     advertised in that state.
 *  3. Otherwise serve the document.
 *
 * Non-GET/HEAD is a 404 too: a POST to a discovery path is not a discovery
 * request and must not be answered with a 200 body.
 */
export function makeWellKnownHandler(
  matches: (relative: string) => boolean,
  build: () => unknown,
  isMcpOAuthEnabled: () => boolean = mcpOAuthEnabled,
) {
  return async (request: any, next: any) => {
    const method = String(request?.method ?? "GET").toUpperCase();
    if (!matches(relativePathOf(request)) || (method !== "GET" && method !== "HEAD")) {
      return notFound();
    }
    if (isMcpOAuthEnabled()) return next(request);
    return discoveryResponse(build());
  };
}
