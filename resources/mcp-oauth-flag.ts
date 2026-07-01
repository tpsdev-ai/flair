/**
 * mcp-oauth-flag.ts — the feature flag + AS config for the native-MCP OAuth
 * surface (FLAIR-NATIVE-MCP-OAUTH, Model 2).
 *
 * Model 2 = a CUSTOM in-process `/mcp` JSON-RPC handler wrapped with
 * `@harperfast/oauth`'s `withMCPAuth` (a fail-closed Bearer-token guard). It is
 * DISTINCT from the native-application-MCP surface (design A / the
 * `native-mcp-surface` branch's `static mcpTools`) — Model 2 does not use
 * Harper's native MCP transport at all, so it is not blocked by the Harper
 * native-MCP timing/worker gating gaps. The curated 9 tools are curated
 * BY CONSTRUCTION (the handler only implements those 9).
 *
 * ── Default-OFF ─────────────────────────────────────────────────────────────
 * The whole surface is gated behind `FLAIR_MCP_OAUTH`, default-OFF. When off:
 *   - NO `/mcp` route is registered (mcpOAuthResource() early-returns).
 *   - The `@harperfast/oauth` authorization-server config is NOT injected.
 *   - flair's default auth chain is byte-identical to today.
 * There is zero prod-behavior change until an operator explicitly opts in AND
 * Sherlock signs off on live enablement.
 *
 * NOTE — separate flag from the native-MCP surface: `FLAIR_MCP_ENABLED` gates the
 * design-A native surface (other branch); `FLAIR_MCP_OAUTH` gates THIS Model-2
 * OAuth-guarded custom handler. They are independent flags for independent
 * mechanisms; neither implies the other.
 */

/**
 * Is the Model-2 OAuth-guarded /mcp surface enabled? Default-OFF.
 *
 * Read from `FLAIR_MCP_OAUTH` — truthy values: "1", "true", "yes", "on"
 * (case-insensitive). Anything else (incl. unset / empty) → OFF.
 */
export function mcpOAuthEnabled(): boolean {
  const raw = (process.env.FLAIR_MCP_OAUTH ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

/**
 * The public origin the authorization server pins `iss` (and, via it, `aud`) to.
 * REQUIRED when the surface is enabled — the @harperfast/oauth plugin refuses to
 * start without `mcp.issuer`, and pinning it (rather than letting it float with
 * the client-controlled Host header) is the audience-confusion defense called
 * out in the plugin's production checklist.
 *
 * Configurable via `FLAIR_MCP_ISSUER` (fall back to `FLAIR_PUBLIC_URL`, which the
 * XAA token path already uses as the canonical public base). No hardcoded
 * default — an operator turning the flag on MUST set the public origin.
 */
export function mcpIssuer(): string | undefined {
  const raw = (process.env.FLAIR_MCP_ISSUER ?? process.env.FLAIR_PUBLIC_URL ?? "").trim();
  return raw || undefined;
}

/**
 * The RFC-8707 resource identifier tokens are audience-bound to. This is the
 * public URL of the `/mcp` endpoint itself: `<issuer>/mcp`. `withMCPAuth`
 * verifies the `aud` claim equals this, so the token minted for flair's `/mcp`
 * cannot be replayed against a different resource server.
 */
export function mcpResource(): string | undefined {
  const iss = mcpIssuer();
  if (!iss) return undefined;
  return `${iss.replace(/\/+$/, "")}/mcp`;
}

/**
 * `getConfig` payload injected into `withMCPAuth` so it verifies against the
 * exact issuer/resource the authorization-server component mints tokens with —
 * required because flair's `/mcp` handler and the @harperfast/oauth plugin may
 * resolve different `node_modules` copies (docs/mcp-oauth.md §"Using withMCPAuth
 * from a different component"), in which case the wrapper's live-config lookup
 * reads `undefined` and fails closed. Pinning it here makes the iss/aud checks
 * match the minted tokens.
 *
 * Returns undefined when the surface is off or the issuer is unset (the wrapper
 * then denies — never serves a guarded route unconfigured, which is the safe
 * failure mode).
 */
export function mcpAuthConfig(): { enabled: boolean; issuer: string; resource: string } | undefined {
  if (!mcpOAuthEnabled()) return undefined;
  const issuer = mcpIssuer();
  const resource = mcpResource();
  if (!issuer || !resource) return undefined;
  return { enabled: true, issuer, resource };
}
