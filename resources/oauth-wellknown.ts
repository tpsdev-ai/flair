/**
 * oauth-wellknown.ts — mounts flair's OAuth discovery documents at the two
 * well-known paths every spec-compliant client probes (flair#1000 item 2).
 *
 * Before this, flair published a correct authorization-server document at
 * `/OAuthMetadata` — a path nothing in the ecosystem asks for — and 404'd at
 * `/.well-known/oauth-authorization-server` (RFC 8414) and
 * `/.well-known/oauth-protected-resource` (RFC 9728, which the MCP
 * authorization specification makes a MUST). A remote MCP client could not
 * discover flair no matter what else was configured.
 *
 * The documents themselves, and every path-screening decision, live in
 * resources/oauth-discovery.ts — this file is only the Harper wiring.
 *
 * ── Why `server.http({ urlPath })` and not a Resource ───────────────────────
 * Harper's REST layer maps a Resource CLASS NAME to a path segment; no class
 * name produces `/.well-known/oauth-protected-resource`. A urlPath mount is the
 * supported route for paths outside the Resource naming scheme — the same
 * mechanism resources/mcp-oauth.ts uses for `/mcp` and @harperfast/oauth uses
 * for its own well-known documents.
 *
 * A urlPath mount gets its OWN dispatch chain, so neither flair's
 * auth-middleware nor Harper's `authentication` middleware runs for these
 * paths. That is required, not incidental: RFC 8414 §3 and RFC 9728 §3 both
 * require the documents be retrievable WITHOUT authentication, and Harper's
 * auth layer stamps `WWW-Authenticate: Basic` on any 401 it wraps.
 * (`/.well-known/oauth-authorization-server` remains in auth-middleware.ts's
 * public allowlist; that entry is now belt-and-braces — a request for it never
 * reaches the default chain.)
 *
 * ── Deference to @harperfast/oauth when the Model-2 surface is on ───────────
 * `FLAIR_MCP_OAUTH` mounts an OAuth-guarded `/mcp` wrapped in the plugin's
 * `withMCPAuth` (resources/mcp-oauth.ts). Tokens for THAT surface are minted by
 * the PLUGIN's authorization server (`/oauth/mcp/token`, JWTs verified against
 * its JWKS), NOT by flair's own OAuth 2.1 AS, which mints opaque `flair_at_…`
 * strings the guard rejects. Advertising flair's AS as the authorization server
 * for `/mcp` in that state would hand a client a token `/mcp` is guaranteed to
 * refuse.
 *
 * So when the flag is on these handlers serve nothing and fall through, and the
 * plugin's own well-known handlers (registered by its `handleApplication` when
 * an operator declares the `'@harperfast/oauth'` component) answer with the
 * document describing the AS that actually guards the surface. Making this a
 * function of flair's own flag keeps it deterministic: two handlers mounted on
 * an identical urlPath share one dispatch group and run in REGISTRATION order,
 * so without an explicit rule the answer would depend on where an operator
 * happened to put a key in config.yaml.
 *
 * Gap named rather than papered over: flag ON with the plugin component NOT
 * declared serves neither document (404, exactly as before this change). That
 * instance is already non-functional — `/mcp` is guarded by a verifier with no
 * authorization server behind it, so there is no token to discover.
 *
 * ── What this does NOT change: the 401 challenge (flair#1000 item 3) ────────
 * flair's REST surface deliberately keeps the challenge it has, because a
 * Bearer challenge there would be FALSE. A bearer token cannot reach a flair
 * resource at all: Harper's own auth layer claims every `Bearer …` header for
 * itself and validates it as a Harper OPERATION token, so
 * `Authorization: Bearer <anything>` answers 401 `{"error":"invalid token"}`
 * before any code under resources/ runs (measured against a live instance; the
 * strategy switch is in node_modules/harper/dist/security/auth.js). flair's own
 * `/OAuthToken` mints opaque `flair_at_…` values that nothing under resources/
 * ever validates, so there is not even a token that WOULD work.
 *
 * Advertising `WWW-Authenticate: Bearer resource_metadata=…` on `/Memory` would
 * therefore announce, per RFC 7235 §4.1, a scheme usable at that resource, and
 * send every MCP client that believed it around a loop that ends in exactly the
 * same 401 with no recovery — strictly worse than the honest challenge, because
 * it misdirects instead of refusing.
 *
 * It would also mean rewriting headers on EVERY 401 in the instance. Harper's
 * auth layer owns that header for every 401 raised at or below it —
 * `response.headers.set('WWW-Authenticate', 'Basic')`, a set and not an append
 * (security/auth.js). flair's middleware is registered ahead of it (config.yaml
 * orders `jsResource` before `authentication`) so it *could* override on the way
 * out — verified by `/Admin` keeping its own `Basic realm="Flair Admin"` — but
 * only by awaiting and inspecting every response on the hottest path in the
 * chain, for every existing Basic and Ed25519 caller, to publish a scheme none
 * of them can use.
 *
 * The challenge belongs on the one surface that DOES take a bearer token —
 * `/mcp` — and it is already there: with `FLAIR_MCP_OAUTH` on, `withMCPAuth`
 * answers `POST /mcp` with
 * `401 WWW-Authenticate: Bearer resource_metadata="<issuer>/.well-known/oauth-protected-resource/mcp"`.
 * Until this change that URL 404'd, which is the sense in which item 3 was
 * broken end to end: the challenge existed and pointed at nothing. flair now
 * answers that exact path (and @harperfast/oauth answers it when the flag is on
 * and the plugin is declared), so the discovery loop closes.
 */

import { server } from "harper";
import {
  AS_METADATA_PATH,
  PRM_PATH,
  asMetadataPathMatches,
  buildAuthorizationServerMetadata,
  buildProtectedResourceMetadata,
  makeWellKnownHandler,
  prmPathMatches,
} from "./oauth-discovery.js";
import { mcpOAuthEnabled } from "./mcp-oauth-flag.js";

export interface WellKnownDeps {
  /** Injectable for tests; defaults to the real Harper server. */
  server?: { http: (handler: any, options: any) => void };
  /** Injectable for tests; defaults to the real FLAIR_MCP_OAUTH read. */
  isMcpOAuthEnabled?: () => boolean;
}

/**
 * Mount both documents. Called once at module load, and directly from tests.
 * Returns the urlPaths mounted so a caller can assert on them.
 */
export function registerOAuthWellKnownRoutes(deps: WellKnownDeps = {}): string[] {
  const srv = deps.server ?? ((server as any));
  if (typeof srv?.http !== "function") return [];
  const enabled = deps.isMcpOAuthEnabled ?? mcpOAuthEnabled;

  srv.http(makeWellKnownHandler(prmPathMatches, buildProtectedResourceMetadata, enabled), { urlPath: PRM_PATH });
  srv.http(makeWellKnownHandler(asMetadataPathMatches, buildAuthorizationServerMetadata, enabled), { urlPath: AS_METADATA_PATH });

  return [PRM_PATH, AS_METADATA_PATH];
}

// Registered at module load, like resources/auth-middleware.ts. The opt-out
// exists only so a unit test can import this module under a partial `harper`
// mock without registering routes; production never sets it.
if (process.env.FLAIR_WELLKNOWN_NO_AUTOSTART == null) {
  registerOAuthWellKnownRoutes();
}
