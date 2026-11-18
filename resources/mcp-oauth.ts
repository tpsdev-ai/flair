/**
 * mcp-oauth.ts — registers the Model-2 OAuth-guarded /mcp surface.
 *
 * Wraps the custom `mcpHandler` (mcp-handler.ts) with `@harperfast/oauth`'s
 * `withMCPAuth` (a fail-closed Bearer-token guard) and mounts it on the `/mcp`
 * urlPath subroute — its OWN dispatch chain, so flair's default auth-middleware
 * never runs for /mcp and can't clobber the Bearer challenge.
 *
 * With MCP disabled, registration does not mount `/mcp`. At load, the guard
 * clears GitHub credentials when both are present and the redirect is missing,
 * regardless of the flag (unless `FLAIR_MCP_NO_AUTOSTART` is set).
 *
 * The `@harperfast/oauth` authorization-server config itself (providers, mcp.*,
 * DCR gating) lives in `config.yaml` under the `@harperfast/oauth` key, but is
 * only meaningful when an operator has set the issuer + enabled the flag (see
 * docs). The plugin serves DCR / authorize / token / JWKS / discovery.
 */

import * as harper from "harper";
import { mcpOAuthEnabled, mcpAuthConfig, mcpIssuer } from "./mcp-oauth-flag.js";
// flair#2270: run the degraded-start guard BEFORE the @harperfast/oauth
// component resolves its config. Imported for its module-load side effect (this
// module is itself loaded during jsResource boot, ahead of the component);
// `mcpOAuthDegraded()` is read below to report the state by variable name.
import { mcpOAuthDegraded } from "./mcp-oauth-env-guard.js";
import { checkMcpRateLimit } from "./rate-limit.js";
import { MULTI_WORKER_GUARD_HTTP_NAME } from "./multi-worker-guard.js";

/**
 * Boot guard (flair#1021, flair#1322), after the flag and degraded-start checks.
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
 * When the two readers disagree, the error names `true` (the recommended
 * setting, which both accept) and the remedy. It does not hardcode an issuer URL.
 */
const OAUTH_COMPONENT_KEY = "@harperfast/oauth";

/**
 * A plain record in this realm or another. Harper runs this module in a VM,
 * so `config` can be a host-realm object whose prototype is not this realm's
 * `Object.prototype`.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  try {
    if (value == null || typeof value !== "object" || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    if (proto === null) return true;
    // `Object.prototype` in any realm: its prototype is null, and it is that
    // realm's `Object` constructor's prototype. Class instances sit one step
    // further out and are not records.
    if (Object.getPrototypeOf(proto) !== null) return false;
    const ctor = (proto as { constructor?: unknown }).constructor;
    return typeof ctor === "function" && (ctor as { prototype?: unknown }).prototype === proto;
  } catch {
    return false;
  }
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
  if (!isRecord(hc)) {
    return { kind: "unreadable", detail: "application config is missing or unreadable" };
  }
  let keyCount = 0;
  let readableGet = false;
  try {
    keyCount = Object.keys(hc).length;
    readableGet = typeof hc.get === "function";
  } catch {
    return { kind: "unreadable", detail: "application config is unreadable" };
  }
  // `{}` is unreadable: a missing document can arrive as an empty object.
  // A get-backed config may have no enumerable keys and still hold the component.
  if (keyCount === 0 && !readableGet) {
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
  if (!isRecord(component)) {
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
 */
export function readEffectiveMcpEnabled(component: Record<string, unknown>): EnabledRead {
  try {
    if (!Object.prototype.hasOwnProperty.call(component, "mcp") || component.mcp == null) {
      return { kind: "bool", enabled: false, configured: undefined };
    }
    if (!isRecord(component.mcp)) {
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
  } catch {
    return { kind: "unreadable", detail: "mcp config lookup failed" };
  }
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
      'Restore the complete "@harperfast/oauth" entry from the config.yaml that ships with this Flair version. ' +
      "This is a PARTIAL declaration of that entry; it leaves out the providers block:\n" +
      "\n" +
      '  "@harperfast/oauth":\n' +
      '    package: "@harperfast/oauth"\n' +
      "    mcp:\n" +
      "      enabled: ${FLAIR_MCP_OAUTH}\n" +
      "      issuer: ${FLAIR_MCP_ISSUER}\n" +
      "\n" +
      "This alone does not start the authorization server: the component also needs at least one provider " +
      "with its client ID, client secret and redirect URI set (the shipped entry configures github through " +
      "OAUTH_GITHUB_CLIENT_ID, OAUTH_GITHUB_CLIENT_SECRET and OAUTH_GITHUB_REDIRECT_URI). " +
      "Then set FLAIR_MCP_OAUTH=true and set FLAIR_MCP_ISSUER to this instance's public origin.",
  );
}

function boundedConfigValue(value: string): string {
  return JSON.stringify(value.length > 64 ? `${value.slice(0, 64)}…` : value);
}

function disagreementError(rawEnv: string, configured: unknown): Error {
  const base =
    `FLAIR_MCP_OAUTH is ${boundedConfigValue(rawEnv)}, which Flair treats as enabled, ` +
    "but the @harperfast/oauth component's effective mcp.enabled is not true. " +
    "Use true, the recommended value; both readers accept it.";
  const isEnvRef = configured === "${FLAIR_MCP_OAUTH}";
  const remedy = isEnvRef ? "Set FLAIR_MCP_OAUTH=true." : "Set mcp.enabled to true.";
  return new Error(`${base} ${remedy}`);
}

function issuerUnreadableError(phase: "mount" | "serve" = "mount"): Error {
  return new Error(
    "mcp.issuer could not be read. Set FLAIR_MCP_ISSUER to an absolute http(s) origin " +
    "and set mcp.issuer to ${FLAIR_MCP_ISSUER}. Refusing to " + phase + " /mcp.",
  );
}

/**
 * FLAIR_MCP_ISSUER is unset or blank at request time. That is its own fault,
 * not an unreadable component value: withMCPAuth verifies tokens against this
 * variable, so without it a request has nothing to check against, whether or
 * not the live config is readable.
 */
function issuerEnvMissingError(): Error {
  return new Error(
    "FLAIR_MCP_ISSUER is unset or blank, so a /mcp request cannot be checked against " +
    "the authorization server's issuer. Refusing to serve /mcp. " +
    "Set FLAIR_MCP_ISSUER to this instance's public origin.",
  );
}

function liveMcpConfigUnreadableError(): Error {
  return new Error(
    "The live @harperfast/oauth MCP configuration could not be verified. Refusing to serve /mcp. " +
    "Inspect the registered @harperfast/oauth component and ensure its mcp settings are a plain mapping " +
    "with enabled and issuer.",
  );
}

/**
 * The live @harperfast/oauth MCP config is absent, or present with
 * `enabled !== true`: the authorization server cannot mint a token for this
 * surface, so the guard would deny every request. Absent is also what a
 * component with no valid provider leaves behind, so the remedy names one.
 */
function mcpAuthUnavailableError(): Error {
  return new Error(
    "The @harperfast/oauth component is not serving an MCP authorization configuration " +
    "(its live mcpConfig is absent or disabled). Refusing to serve /mcp. " +
    "Configure a valid OAuth provider for the component — its client ID, client secret " +
    "and redirect URI — and set FLAIR_MCP_OAUTH=true and FLAIR_MCP_ISSUER to this " +
    "instance's public origin, with mcp.enabled true and mcp.issuer set to " +
    "${FLAIR_MCP_ISSUER}, then restart.",
  );
}

/**
 * The boot guard's issuer rule, over one candidate value: the failed rule, or
 * undefined when the value is a canonical origin that also matches
 * FLAIR_MCP_ISSUER after the trailing-slash trim. A valid origin returns
 * undefined when FLAIR_MCP_ISSUER is unset — the rule cannot compare against an
 * absent reference — so the request-time check refuses an unset issuer before
 * calling this. flair#3032: the per-request check below holds this same rule
 * against the authorization server's live issuer, so the two checks cannot
 * drift apart.
 */
function issuerFailedRule(issuer: unknown): string | undefined {
  let failedRule: string;
  // new URL() removes ASCII tab, LF and CR anywhere and trims C0 controls
  // and spaces at the ends; other embedded C0 controls or spaces in a host throw.
  // Refuse whitespace and controls anyway: the component keeps the raw issuer.
  if (typeof issuer !== "string") return "not a string";
  if (/[\u0000-\u0020\u007F]/.test(issuer)) return "has whitespace or control characters";
  try {
    const parsedIssuer = new URL(issuer);
    const pathWithoutTrailingSlash = parsedIssuer.pathname.replace(/\/+$/, "");
    if (parsedIssuer.protocol !== "http:" && parsedIssuer.protocol !== "https:") failedRule = "not http/https";
    else if (pathWithoutTrailingSlash !== "") failedRule = "has a path";
    // Stricter than @harperfast/oauth 2.9.0 on purpose: an empty `?` or `#` leaves
    // URL.search/hash empty, so the component accepts it, then prefixes every endpoint
    // with the raw value (`https://host?/oauth/mcp/token`). Refuse any raw delimiter.
    else if (parsedIssuer.search !== "" || parsedIssuer.hash !== "" || /[?#]/.test(issuer)) failedRule = "has a query/hash";
    else if (parsedIssuer.username !== "" || parsedIssuer.password !== "") failedRule = "has userinfo";
    else if (issuer.replace(/\/+$/, "") !== parsedIssuer.origin) failedRule = "not in canonical origin form";
    // flair#3032: the authorization server mints tokens for THIS value, while
    // withMCPAuth verifies them against mcpIssuer(). A literal that disagrees
    // with FLAIR_MCP_ISSUER mounts /mcp with tokens that cannot verify there.
    else {
      const envIssuer = mcpIssuer();
      if (envIssuer !== undefined && issuer.replace(/\/+$/, "") !== envIssuer.replace(/\/+$/, "")) {
        failedRule = "differs from FLAIR_MCP_ISSUER";
      } else return undefined;
    }
  } catch {
    failedRule = "not absolute";
  }
  return failedRule;
}

function issuerRefusalError(
  configured: unknown,
  failedRule: string,
  phase: "mount" | "serve" = "mount",
): Error {
  const envName = typeof configured === "string" && configured.startsWith("${") && configured.endsWith("}")
    ? configured.slice(2, -1) : undefined;
  const detail = envName === undefined ? ` (${failedRule})`
    : process.env[envName] === undefined ? ` (environment variable ${JSON.stringify(envName)} is unset)`
    : ` (environment variable ${JSON.stringify(envName)} value fails the rule: ${failedRule})`;
  if (failedRule === "differs from FLAIR_MCP_ISSUER") {
    return new Error(
      "The @harperfast/oauth component's mcp.issuer is a valid absolute http(s) origin" + detail +
      ", but withMCPAuth verifies tokens against FLAIR_MCP_ISSUER, so the tokens the component mints cannot verify here. " +
      `Refusing to ${phase} /mcp. Set FLAIR_MCP_ISSUER and mcp.issuer to the same public origin, ` +
      "or set mcp.issuer to ${FLAIR_MCP_ISSUER}.",
    );
  }
  return new Error(
    "The @harperfast/oauth component's mcp.issuer must be an absolute http(s) origin" + detail +
    `. Refusing to ${phase} /mcp. Set FLAIR_MCP_ISSUER to an absolute http(s) origin ` +
    "without a path, query, fragment or userinfo, written as scheme://host[:port] with a lowercase host, " +
    "no default port, and at most a trailing slash, and set mcp.issuer to ${FLAIR_MCP_ISSUER}.",
  );
}

function assertEffectiveMcpIssuer(component: Record<string, unknown>): void {
  let configured: unknown;
  let issuer: unknown;
  try {
    configured = (component.mcp as Record<string, unknown>).issuer;
    issuer = expandWholeTokenEnv(configured);
  } catch {
    throw issuerUnreadableError();
  }
  const failedRule = issuerFailedRule(issuer);
  if (failedRule !== undefined) throw issuerRefusalError(configured, failedRule);
}

/**
 * The authorization server's live MCP config: `OAuthResource.mcpConfig` on the
 * registered oauth resource. A successful `@harperfast/oauth` reload
 * (`updateConfiguration` → `OAuthResource.configure`) replaces it with
 * `expandEnvVarsDeep(options.mcp)`; a reload that leaves no valid provider clears
 * it. That static is the value the component actually mints and advertises with —
 * the raw config.yaml entry can still hold a `${VAR}` reference and is only what
 * the boot guard reads. A cleared config is reported as unavailable below.
 */
type LiveMcpConfigRead =
  | { kind: "absent" }
  | { kind: "present"; config: Record<string, unknown> }
  | { kind: "unreadable" };

function readLiveMcpConfig(harperNs: any): LiveMcpConfigRead {
  let config: unknown;
  try {
    config = (harperNs ?? harper).server?.resources?.get("oauth")?.Resource?.mcpConfig;
  } catch {
    return { kind: "unreadable" };
  }
  // No live MCP config means the component is not serving an authorization
  // server for this surface at all; the wrapper's own enabled check denies.
  if (config == null) return { kind: "absent" };
  if (!isRecord(config)) return { kind: "unreadable" };
  return { kind: "present", config };
}

/**
 * flair#3032 — hold the boot guard's issuer rule on every /mcp request.
 *
 * The boot guard runs once, at registration. When the authorization server's
 * issuer changes on a running instance, /mcp stays registered and every new
 * token would be refused as a generic `invalid_token`. This re-runs the same
 * `issuerFailedRule` (same trailing-slash trim, same `differs from
 * FLAIR_MCP_ISSUER` rule) against the live issuer, and refuses with the boot
 * guard's named error and remedy. Flair refuses when it cannot verify the
 * live config. A missing FLAIR_MCP_ISSUER is a separate
 * refusal with its own message: the request cannot be checked at all.
 *
 * `served` means the live config is present, enabled, and its issuer passed
 * the rule. Every other outcome refuses.
 */
type McpRequestCheck =
  | { kind: "served" }
  | { kind: "refused"; code: string; status: string; reason: string };

function checkLiveMcpConfig(harperNs: any): McpRequestCheck {
  const unavailable = (reason: string): McpRequestCheck => ({
    kind: "refused",
    code: "mcp_auth_unavailable",
    status: "MCP auth unavailable",
    reason,
  });

  // withMCPAuth verifies against FLAIR_MCP_ISSUER; without it at request time
  // there is no comparison to hold, so this is a refusal, never a skip. It is
  // not a component read failure, so it gets its own message.
  if (mcpIssuer() === undefined) return unavailable(issuerEnvMissingError().message);

  const read = readLiveMcpConfig(harperNs);
  if (read.kind === "unreadable") return unavailable(liveMcpConfigUnreadableError().message);
  // No live config, or a disabled one, cannot mint a token for this surface.
  if (read.kind === "absent") return unavailable(mcpAuthUnavailableError().message);

  let enabled: unknown;
  let issuer: unknown;
  try {
    enabled = read.config.enabled;
  } catch {
    return unavailable(liveMcpConfigUnreadableError().message);
  }
  try {
    issuer = read.config.issuer;
  } catch {
    return unavailable(issuerUnreadableError("serve").message);
  }
  if (enabled !== true) return unavailable(mcpAuthUnavailableError().message);
  if (issuer === undefined || issuer === null) return unavailable(issuerUnreadableError("serve").message);

  const failedRule = issuerFailedRule(issuer);
  if (failedRule === undefined) return { kind: "served" };
  return {
    kind: "refused",
    code: "mcp_issuer_refused",
    status: "Issuer refused",
    // No configured value: the live issuer never belongs in the response or
    // the log, so the refusal names only the rule and the remedy.
    reason: issuerRefusalError(undefined, failedRule, "serve").message,
  };
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
  assertEffectiveMcpIssuer(read.component);
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
 * `registerMcpOAuthRoute` itself. When the route is mounted, the answer is
 * derived on read from the live @harperfast/oauth config (flair#3032), so a
 * config change is reported without waiting for a /mcp request. Anything that
 * wants to *describe* the surface — the admin Endpoints table is the first such
 * consumer — reads this instead of re-reading `FLAIR_MCP_OAUTH`.
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

/**
 * The namespace whose `/mcp` route is mounted, captured at mount time. A read
 * of `mcpRouteState()` evaluates the same refusal helper against it, so the
 * recorded answer tracks the live config instead of the last request.
 */
let mountedNamespace: any | undefined;

/**
 * Read the mount decision, derived from the live config when the route is
 * mounted. A mounted route whose live config would now be refused reports the
 * refusal, never "mounted".
 */
export function mcpRouteState(): McpRouteState {
  if (routeState.mounted && mountedNamespace !== undefined) {
    const check = checkLiveMcpConfig(mountedNamespace);
    if (check.kind === "refused") {
      return { mounted: false, status: check.status, reason: check.reason };
    }
  }
  return routeState;
}

/**
 * Record a decision and return its `mounted` value. Every `return` in
 * `registerMcpOAuthRoute` goes through here, so a branch cannot decide the
 * route's fate without publishing that decision.
 */
function decide(state: McpRouteState): boolean {
  routeState = state;
  if (!state.mounted) mountedNamespace = undefined;
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
      // maps only true/false strings (trimmed, any case) to a boolean, so
      // 1/yes/on leave it disabled. This reason names true, which both accept.
      reason: "Set FLAIR_MCP_OAUTH=true (and an issuer) to serve MCP over HTTP.",
    });
  }

  // flair#2270: the install is enabled but a required OAuth variable is
  // missing, so the auth server cannot serve this surface. Do NOT mount a
  // guarded /mcp that could only fail closed against a provider that is not
  // there — report MCP auth unavailable, by variable name.
  const degraded = mcpOAuthDegraded();
  if (degraded.degraded) {
    return decide({
      mounted: false,
      status: "MCP auth unavailable",
      reason: `${degraded.reason}. Set it (or re-run: flair mcp enable), then restart.`,
    });
  }

  // Boot guard (flair#1021, flair#1322): the component must be declared and its
  // effective mcp.enabled must be true.
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
        "(set FLAIR_MCP_ISSUER) — /mcp NOT mounted.",
    );
    return decide({
      mounted: false,
      status: "Not mounted",
      reason:
        "FLAIR_MCP_OAUTH is on but no issuer is configured — set FLAIR_MCP_ISSUER.",
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

  // Mount /mcp after the guard. The listener below holds the issuer rule on
  // every request before the wrapper runs (flair#3032), so a live issuer
  // change is answered with the boot guard's named refusal instead of the
  // wrapper's generic invalid_token.
  const harperNs = deps.harper ?? harper;
  const guardedMcp = withMCPAuth(rateLimitedMcpHandler(handler), {
    getConfig: () => {
      try {
        const live = readLiveMcpConfig(harperNs);
        if (live.kind !== "present" || live.config.enabled !== true) return undefined;
        if (issuerFailedRule(live.config.issuer) !== undefined) return undefined;
        return mcpAuthConfig();
      } catch {
        return undefined;
      }
    },
  });

  srv.http(
    async (request: any, next: any) => {
      const check = checkLiveMcpConfig(harperNs);
      if (check.kind === "refused") {
        // The body carries the named refusal, which names the rule and the
        // remedy but no resolved issuer value.
        return {
          status: 503,
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
          body: JSON.stringify({ error: check.code, error_description: check.reason }),
        };
      }
      // Reaching the wrapper means the live config is present, enabled, and
      // its issuer passed the rule; mounted state is derived on read, never
      // recorded for a request that may then be denied.
      return guardedMcp(request, next);
    },
    { urlPath: "/mcp", after: MULTI_WORKER_GUARD_HTTP_NAME },
  );

  console.error(`[mcp-oauth] /mcp mounted (OAuth-guarded); issuer=${config.issuer}`);
  mountedNamespace = harperNs;
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
