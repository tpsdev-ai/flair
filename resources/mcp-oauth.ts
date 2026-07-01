/**
 * mcp-oauth.ts — registers the Model-2 OAuth-guarded /mcp surface.
 *
 * Wraps the custom `mcpHandler` (mcp-handler.ts) with `@harperfast/oauth`'s
 * `withMCPAuth` (a fail-closed Bearer-token guard) and mounts it on the `/mcp`
 * urlPath subroute — its OWN dispatch chain, so flair's default auth-middleware
 * never runs for /mcp and can't clobber the Bearer challenge.
 *
 * ── Default-OFF (byte-identical when off) ───────────────────────────────────
 * The route is registered ONLY when `FLAIR_MCP_OAUTH` is truthy. When off, this
 * module does NOTHING at load — no `server.http` call, no `@harperfast/oauth`
 * import, no config injection. flair's default auth chain and prod behavior are
 * unchanged. This is the no-op contract the flag guarantees.
 *
 * The `@harperfast/oauth` authorization-server config itself (providers, mcp.*,
 * DCR gating) lives in `config.yaml` under the `@harperfast/oauth` key, but is
 * only meaningful when an operator has set the issuer + enabled the flag (see
 * docs). The plugin serves DCR / authorize / token / JWKS / discovery.
 */

import * as harper from "@harperfast/harper";
import { mcpOAuthEnabled, mcpAuthConfig } from "./mcp-oauth-flag.js";
import { mcpHandler } from "./mcp-handler.js";

/**
 * Register the guarded /mcp route iff the flag is on. Called once at module load
 * (and directly in tests). Kept async + guarded: `@harperfast/oauth` is only
 * imported when the flag is on, so a flair install that never enables MCP-OAuth
 * doesn't need the dep resolved at boot, and a broken/absent plugin degrades to
 * "no /mcp route" (fail-safe: the surface simply doesn't mount) rather than
 * crashing flair.
 *
 * Returns true if the route was mounted, false otherwise — the return value is
 * for tests/observability; the load-time caller ignores it.
 */
export interface RegisterDeps {
  /** The Harper server to register the route on (injectable for tests). */
  server?: { http: (handler: any, options: any) => void };
  /** Loader for withMCPAuth (injectable for tests; defaults to the real plugin). */
  loadWithMCPAuth?: () => Promise<(handler: any, options?: any) => any>;
}

async function defaultLoadWithMCPAuth(): Promise<(handler: any, options?: any) => any> {
  // Dynamic import so the dep is only required when the surface is enabled.
  const mod = (await import("@harperfast/oauth")) as any;
  return mod.withMCPAuth;
}

export async function registerMcpOAuthRoute(deps: RegisterDeps = {}): Promise<boolean> {
  if (!mcpOAuthEnabled()) return false; // OFF → no route, no import, no side effects.

  const config = mcpAuthConfig();
  if (!config) {
    // Flag on but issuer unset → we cannot safely pin iss/aud. Do NOT mount an
    // unconfigured guard (withMCPAuth would fail closed anyway, but not mounting
    // is the clearer signal). Log and bail — the operator must set FLAIR_MCP_ISSUER.
    console.error(
      "[mcp-oauth] FLAIR_MCP_OAUTH is on but no issuer configured " +
        "(set FLAIR_MCP_ISSUER or FLAIR_PUBLIC_URL) — /mcp NOT mounted.",
    );
    return false;
  }

  let withMCPAuth: (handler: any, options?: any) => any;
  try {
    withMCPAuth = await (deps.loadWithMCPAuth ?? defaultLoadWithMCPAuth)();
  } catch (err: any) {
    console.error(
      "[mcp-oauth] @harperfast/oauth not available — /mcp NOT mounted: " + (err?.message ?? err),
    );
    return false;
  }

  if (typeof withMCPAuth !== "function") {
    console.error("[mcp-oauth] @harperfast/oauth has no withMCPAuth export — /mcp NOT mounted.");
    return false;
  }

  // Read `server` lazily off the namespace (it's a runtime global on the Harper
  // module, not a static named export) so this module links cleanly even where a
  // stub build of @harperfast/harper lacks the export.
  const srv = deps.server ?? ((harper as any).server);

  // Primary registration: urlPath subroute → own chain (flair's auth-middleware
  // does not run here). `getConfig` pins iss/resource to the AS's values so the
  // wrapper's iss/aud checks match the minted tokens even if this component
  // resolves a different node_modules copy of the plugin (docs/mcp-oauth.md
  // §"Using withMCPAuth from a different component").
  srv.http(
    withMCPAuth(mcpHandler, {
      getConfig: () => mcpAuthConfig(),
    }),
    { urlPath: "/mcp" },
  );

  console.error(`[mcp-oauth] /mcp mounted (OAuth-guarded); issuer=${config.issuer}`);
  return true;
}

// Fire-and-forget at module load. Any failure is contained inside
// registerMcpOAuthRoute (it logs and returns) so it can never crash flair boot.
// When the flag is off it returns immediately without importing the plugin or
// touching `server` — the byte-identical no-op contract.
//
// Skipped ONLY when a test explicitly opts out via FLAIR_MCP_NO_AUTOSTART, so
// importing this module in a unit test doesn't trigger the real plugin/handler
// import chain under a partial harper mock (registration is exercised directly
// via the exported fn). Production never sets this, so boot behavior is
// unchanged — and when the flag is off, registerMcpOAuthRoute() is a no-op
// regardless. (bun test runs under Node's runtime here via the harper toolchain;
// we don't gate on the runtime to avoid disabling the feature in a bun-hosted
// deployment.)
if (process.env.FLAIR_MCP_NO_AUTOSTART == null) {
  void registerMcpOAuthRoute().catch((err) => {
    console.error("[mcp-oauth] route registration failed (surface not mounted): " + (err?.message ?? err));
  });
}
