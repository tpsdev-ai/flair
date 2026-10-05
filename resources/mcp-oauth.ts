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
import { checkMcpRateLimit } from "./rate-limit.js";
import { MULTI_WORKER_GUARD_HTTP_NAME } from "./multi-worker-guard.js";

/**
 * Boot guard (flair#1021, flair#1322). Runs only when `FLAIR_MCP_OAUTH` is on.
 *
 * The `@harperfast/oauth` component must be declared, and its effective
 * `mcp.enabled` must be true. Effective means the component's own read:
 * whole-token `${VAR}` expansion, then `true`/`false` only. Any other string
 * (`1`, `yes`, `on`, an unresolved placeholder, garbage) is deleted and the
 * disabled default applies. Key presence is not that state — the block ships
 * in config.yaml, so a pre-0.46 `FLAIR_MCP_OAUTH=1` used to mount `/mcp` while
 * the authorization server stayed off.
 *
 * A config read that throws, or that returns an empty or unreadable body,
 * refuses. That result is not a missing component and it is not success.
 *
 * When the two readers disagree, the error names `true` (the value both
 * accept) and the remedy. It does not hardcode an issuer URL.
 */
const OAUTH_COMPONENT_KEY = "@harperfast/oauth";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** `@harperfast/oauth` `expandEnvVar`: whole-token `${NAME}` only. */
function expandWholeTokenEnv(value: unknown): unknown {
  if (typeof value !== "string" || !value.startsWith("${") || !value.endsWith("}")) return value;
  const envValue = process.env[value.slice(2, -1)];
  return envValue !== undefined ? envValue : value;
}

type ComponentRead =
  | { kind: "absent" }
  | { kind: "present"; component: Record<string, unknown> }
  | { kind: "unreadable"; detail: string };

function readOAuthComponent(harperNs: any): ComponentRead {
  let hc: any;
  try {
    const h = harperNs ?? harper;
    hc = h?.app?.config ?? h?.config;
  } catch {
    return { kind: "unreadable", detail: "config lookup failed" };
  }
  if (!isPlainObject(hc)) {
    return { kind: "unreadable", detail: "application config is missing or unreadable" };
  }
  let keyCount = 0;
  try {
    keyCount = Object.keys(hc).length;
  } catch {
    return { kind: "unreadable", detail: "application config is unreadable" };
  }
  if (keyCount === 0) {
    return { kind: "unreadable", detail: "application config is empty" };
  }

  let component: unknown;
  try {
    if (typeof hc.get === "function") component = hc.get(OAUTH_COMPONENT_KEY);
  } catch {
    return { kind: "unreadable", detail: "config lookup failed" };
  }
  if (component == null) {
    try {
      component = hc[OAUTH_COMPONENT_KEY];
    } catch {
      return { kind: "unreadable", detail: "config lookup failed" };
    }
  }
  if (component == null) return { kind: "absent" };
  if (!isPlainObject(component)) {
    return { kind: "unreadable", detail: "component entry is not an object" };
  }
  return { kind: "present", component };
}

type EnabledRead =
  | { kind: "bool"; enabled: boolean; configured: unknown }
  | { kind: "unreadable"; detail: string };

/**
 * The component's effective `mcp.enabled` after `coerceConfigBoolean`.
 * Omitted, null, or a deleted non-boolean string is the disabled default.
 * A value that is not a boolean or a string cannot be read that way.
 */
function readEffectiveMcpEnabled(component: Record<string, unknown>): EnabledRead {
  if (!Object.prototype.hasOwnProperty.call(component, "mcp") || component.mcp == null) {
    return { kind: "bool", enabled: false, configured: undefined };
  }
  if (!isPlainObject(component.mcp)) {
    return { kind: "unreadable", detail: "mcp entry is not an object" };
  }
  if (!Object.prototype.hasOwnProperty.call(component.mcp, "enabled") || component.mcp.enabled === undefined) {
    return { kind: "bool", enabled: false, configured: undefined };
  }
  const configured = component.mcp.enabled;
  if (configured === null) return { kind: "bool", enabled: false, configured };
  const expanded = expandWholeTokenEnv(configured);
  if (typeof expanded === "boolean") return { kind: "bool", enabled: expanded, configured };
  if (typeof expanded === "string") {
    const v = expanded.trim().toLowerCase();
    if (v === "true") return { kind: "bool", enabled: true, configured };
    if (v === "false") return { kind: "bool", enabled: false, configured };
    return { kind: "bool", enabled: false, configured };
  }
  return { kind: "unreadable", detail: "mcp.enabled is not a boolean or string" };
}

function unreadableConfigError(detail: string): Error {
  return new Error(
    "FLAIR_MCP_OAUTH is enabled but the @harperfast/oauth configuration could not be read (" +
      detail +
      "). Refusing to mount /mcp. " +
      'Remedy: make config.yaml\'s "@harperfast/oauth" entry a readable object, ' +
      "with mcp.enabled set to true or to ${FLAIR_MCP_OAUTH}, and set FLAIR_MCP_OAUTH=true.",
  );
}

function componentAbsentError(): Error {
  return new Error(
    "FLAIR_MCP_OAUTH is enabled but the @harperfast/oauth component is not declared in config.yaml. " +
      "The authorization server cannot start without it — discovery, authorize, token, and JWKS endpoints will all 404.\n" +
      "Restore this entry:\n" +
      "\n" +
      '  "@harperfast/oauth":\n' +
      '    package: "@harperfast/oauth"\n' +
      "    mcp:\n" +
      "      enabled: ${FLAIR_MCP_OAUTH}\n" +
      "      issuer: ${FLAIR_MCP_ISSUER}\n" +
      "\n" +
      "Then set FLAIR_MCP_OAUTH=true and set FLAIR_MCP_ISSUER to this instance's public origin.",
  );
}

function disagreementError(rawEnv: string, configured: unknown): Error {
  const base =
    `FLAIR_MCP_OAUTH is ${JSON.stringify(rawEnv)}, which Flair treats as enabled, ` +
    "but the @harperfast/oauth component's effective mcp.enabled is not true. " +
    "The value both readers accept is true.";
  const isEnvRef = typeof configured === "string" && configured.trim() === "${FLAIR_MCP_OAUTH}";
  const remedy = isEnvRef ? "Set FLAIR_MCP_OAUTH=true." : "Set mcp.enabled to true.";
  return new Error(`${base} ${remedy}`);
}

export function assertHarperOAuthComponentDeclared(harperNs?: any) {
  if (!mcpOAuthEnabled()) return;
  const read = readOAuthComponent(harperNs);
  if (read.kind === "unreadable") throw unreadableConfigError(read.detail);
  if (read.kind === "absent") throw componentAbsentError();
  const enabled = readEffectiveMcpEnabled(read.component);
  if (enabled.kind === "unreadable") throw unreadableConfigError(enabled.detail);
  if (!enabled.enabled) {
    throw disagreementError((process.env.FLAIR_MCP_OAUTH ?? "").trim(), enabled.configured);
  }
}
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
  /** Skip the boot guard that checks @harperfast/oauth is declared in config.yaml.
   *  Tests that use a Harper mock without a real config.yaml set this to true. */
  skipComponentGuard?: boolean;
  /** Harper namespace for the boot guard (injectable for tests; defaults to the
   *  real `harper` import). Tests inject a mock so they don't depend on
   *  process-global mock.module ordering. */
  harper?: any;
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

/**
 * Wrap the /mcp handler in the per-subject rate limit.
 *
 * Placed INSIDE `withMCPAuth` — i.e. the guard runs first and this runs second —
 * so the key is the RS256-verified `sub` from the token rather than a network
 * address. That is the identity worth limiting on for an authenticated surface:
 * it is the authorization server's own assertion, it survives the caller
 * changing address, and it is exactly the thing "a valid token can hammer the
 * tools" is about. Authentication is not a rate limit.
 *
 * The consequence of that placement, stated rather than left implicit: requests
 * bearing an INVALID token are rejected by `withMCPAuth` before this runs and so
 * are not counted here. Those cost one JWT verification against a locally-cached
 * key and touch no flair table or tool, which is a materially cheaper path than
 * a tool call — but it is not zero, and it is not throttled at this layer.
 *
 * Exported for tests: the limiter's behaviour is asserted directly on this
 * wrapper, without needing the plugin present.
 */
export function rateLimitedMcpHandler(handler: (request: any) => Promise<any>): (request: any) => Promise<any> {
  return async (request: any) => {
    const limited = checkMcpRateLimit(request);
    if (limited) return limited;
    return handler(request);
  };
}

export async function registerMcpOAuthRoute(deps: RegisterDeps = {}): Promise<boolean> {
  if (!mcpOAuthEnabled()) {
    // OFF → no route, no import, no side effects.
    return decide({
      mounted: false,
      status: "Not enabled",
      // "true" not "1": this reader accepts 1/true/yes/on, but the component
      // accepts only "true"/"false". The boot guard refuses to mount /mcp
      // when those disagree. This reason names the value that enables both.
      reason: "Set FLAIR_MCP_OAUTH=true (and an issuer) to serve MCP over HTTP.",
    });
  }

  // Boot guard: the component must be declared and its effective mcp.enabled
  // must be true. A legacy 1/yes/on leaves the component off; the guard throws
  // instead of mounting /mcp.
  if (!deps.skipComponentGuard) {
    assertHarperOAuthComponentDeclared(deps.harper);
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

  // Mount /mcp after the guard.
  srv.http(
    withMCPAuth(rateLimitedMcpHandler(handler), {
      getConfig: () => (deps.harper ?? harper).server?.resources?.get("oauth")?.Resource?.mcpConfig?.enabled === true
        ? mcpAuthConfig()
        : undefined,
    }),
    { urlPath: "/mcp", after: MULTI_WORKER_GUARD_HTTP_NAME },
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
