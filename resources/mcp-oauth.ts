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

import * as harper from "harper";
import { mcpOAuthEnabled, mcpAuthConfig } from "./mcp-oauth-flag.js";
// NOTE: mcpHandler is intentionally NOT statically imported here — it's resolved
// lazily (deps.mcpHandler ?? dynamic import) inside registerMcpOAuthRoute, same
// as loadWithMCPAuth below. A static `import { mcpHandler } from "./mcp-handler.js"`
// forced any test that wanted to mock this module to `mock.module(...)` it — a
// process-global, unrestored bun mock (bun test runs all files in one process)
// that raced mcp-handler.test.ts's own real `await import("./mcp-handler.js")`
// and intermittently poisoned it (undefined resolveAgentFromSub → 35 tests fail
// together). See resources/mcp-tools.ts's LOADERS/__setHandlers doc for the same
// "inject, don't mock.module shared resources/*.ts" rationale.

/**
 * Register the guarded /mcp route iff the flag is on. Called once at module load
 * (and directly in tests). Kept async + guarded: `@harperfast/oauth` is only
 * imported when the flag is on, so a flair install that never enables MCP-OAuth
 * doesn't need the dep resolved at boot, and a broken/absent plugin degrades to
 * "no /mcp route" (fail-safe: the surface simply doesn't mount) rather than
 * crashing flair.
 *
 * Returns true if the route was mounted, false otherwise. The load-time caller
 * ignores the return value, but the same decision is recorded in `routeState`
 * and readable via `mcpRouteState()` — see the doc on `McpRouteState` for why
 * consumers must read that rather than the flag.
 */
export interface RegisterDeps {
  /** The Harper server to register the route on (injectable for tests). */
  server?: { http: (handler: any, options: any) => void };
  /** Loader for withMCPAuth (injectable for tests; defaults to the real plugin). */
  loadWithMCPAuth?: () => Promise<(handler: any, options?: any) => any>;
  /** The /mcp request handler (injectable for tests; defaults to a lazy import
   *  of ./mcp-handler.js — never statically imported, see the note at the top). */
  mcpHandler?: any;
}

/**
 * ── The recorded mount decision (flair#1001) ────────────────────────────────
 *
 * Whether `/mcp` is actually being served, as decided and recorded by
 * `registerMcpOAuthRoute` itself. Anything that wants to *describe* the surface
 * — the admin Endpoints table is the first such consumer — reads this instead of
 * re-reading `FLAIR_MCP_OAUTH`.
 *
 * That distinction is the whole point. The admin Instance page used to render a
 * literal `<publicUrl>/mcp` row on every install, so a default install's own
 * dashboard advertised an endpoint that answers 404 exactly like a path that does
 * not exist. A second, independent read of the flag would not have fixed that —
 * it would have moved the disagreement one level up, and the flag alone is not
 * even sufficient (flag on + no issuer → the route still does not mount). So the
 * router publishes what it did, and there is deliberately NO exported setter:
 * `decide()` below is module-private, which makes a second writer — and therefore
 * a second source of truth — structurally impossible rather than merely
 * discouraged.
 */
export type McpRouteState =
  | { mounted: true }
  | {
      mounted: false;
      /** Short operator-facing status, e.g. an admin table cell badge. */
      status: string;
      /** Why it is not mounted, and what would change that. */
      reason: string;
    };

/**
 * Initial value: no route has been registered yet, which is literally true until
 * `registerMcpOAuthRoute` runs — a reader between module load and registration
 * would get a 404 from `/mcp`, so reporting "not mounted" is accurate rather
 * than merely safe. It also stays correct for an embedder that sets
 * FLAIR_MCP_NO_AUTOSTART and never calls the registration function.
 */
let routeState: McpRouteState = {
  mounted: false,
  status: "Not mounted",
  reason: "MCP route registration has not run.",
};

/** Read the mount decision the router recorded. */
export function mcpRouteState(): McpRouteState {
  return routeState;
}

/**
 * Record a decision and return its `mounted` value. Every `return` in
 * `registerMcpOAuthRoute` goes through here, so a branch cannot decide the
 * route's fate without publishing that decision.
 */
function decide(state: McpRouteState): boolean {
  routeState = state;
  return state.mounted;
}

async function defaultLoadWithMCPAuth(): Promise<(handler: any, options?: any) => any> {
  // Dynamic import so the dep is only required when the surface is enabled.
  const mod = (await import("@harperfast/oauth")) as any;
  return mod.withMCPAuth;
}

export async function registerMcpOAuthRoute(deps: RegisterDeps = {}): Promise<boolean> {
  if (!mcpOAuthEnabled()) {
    // OFF → no route, no import, no side effects.
    return decide({
      mounted: false,
      status: "Not enabled",
      reason: "Set FLAIR_MCP_OAUTH=1 (and an issuer) to serve MCP over HTTP.",
    });
  }

  const config = mcpAuthConfig();
  if (!config) {
    // Flag on but issuer unset → we cannot safely pin iss/aud. Do NOT mount an
    // unconfigured guard (withMCPAuth would fail closed anyway, but not mounting
    // is the clearer signal). Log and bail — the operator must set FLAIR_MCP_ISSUER.
    console.error(
      "[mcp-oauth] FLAIR_MCP_OAUTH is on but no issuer configured " +
        "(set FLAIR_MCP_ISSUER or FLAIR_PUBLIC_URL) — /mcp NOT mounted.",
    );
    return decide({
      mounted: false,
      status: "Not mounted",
      reason:
        "FLAIR_MCP_OAUTH is on but no issuer is configured — set FLAIR_MCP_ISSUER (or FLAIR_PUBLIC_URL).",
    });
  }

  let withMCPAuth: (handler: any, options?: any) => any;
  try {
    withMCPAuth = await (deps.loadWithMCPAuth ?? defaultLoadWithMCPAuth)();
  } catch (err: any) {
    console.error(
      "[mcp-oauth] @harperfast/oauth not available — /mcp NOT mounted: " + (err?.message ?? err),
    );
    // The underlying error text stays in the log rather than being carried into
    // an operator-facing string: it is arbitrary text from a dependency, and the
    // admin page is HTML.
    return decide({
      mounted: false,
      status: "Not mounted",
      reason: "The @harperfast/oauth plugin could not be loaded — see the server log.",
    });
  }

  if (typeof withMCPAuth !== "function") {
    console.error("[mcp-oauth] @harperfast/oauth has no withMCPAuth export — /mcp NOT mounted.");
    return decide({
      mounted: false,
      status: "Not mounted",
      reason: "The @harperfast/oauth plugin has no withMCPAuth export — see the server log.",
    });
  }

  // Resolve the handler lazily (injected in tests; real module otherwise) — see
  // the top-of-file note on why it isn't a static import.
  const handler = deps.mcpHandler ?? (await import("./mcp-handler.js")).mcpHandler;

  // Read `server` lazily off the namespace (it's a runtime global on the Harper
  // module, not a static named export) so this module links cleanly even where a
  // stub build of harper lacks the export.
  const srv = deps.server ?? ((harper as any).server);

  // Primary registration: urlPath subroute → own chain (flair's auth-middleware
  // does not run here). `getConfig` pins iss/resource to the AS's values so the
  // wrapper's iss/aud checks match the minted tokens even if this component
  // resolves a different node_modules copy of the plugin (docs/mcp-oauth.md
  // §"Using withMCPAuth from a different component").
  srv.http(
    withMCPAuth(handler, {
      getConfig: () => mcpAuthConfig(),
    }),
    { urlPath: "/mcp" },
  );

  console.error(`[mcp-oauth] /mcp mounted (OAuth-guarded); issuer=${config.issuer}`);
  return decide({ mounted: true });
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
    // A throw escaping registerMcpOAuthRoute means the mount never happened, so
    // record that too — otherwise mcpRouteState() would keep reporting whatever
    // the last completed decision was.
    decide({
      mounted: false,
      status: "Not mounted",
      reason: "MCP route registration failed — see the server log.",
    });
    console.error("[mcp-oauth] route registration failed (surface not mounted): " + (err?.message ?? err));
  });
}
