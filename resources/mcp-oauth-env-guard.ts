/**
 * mcp-oauth-env-guard.ts — the degraded-start backstop for flair#2270.
 *
 * Runs at flair boot (this file is a `jsResource`, loaded before Harper resolves
 * the `@harperfast/oauth` component's config). If the install's MCP surface is
 * enabled and the github provider's credentials are staged but the redirect
 * variable the shipped `config.yaml` now references
 * (`OAUTH_GITHUB_REDIRECT_URI`) is missing, `@harperfast/oauth` refuses to load
 * the provider and the failure takes the WHOLE instance down — `/health` 500.
 *
 * Rather than let one not-fully-configured provider kill the instance, the
 * guard leaves the provider unconfigured so the component starts: MCP auth is
 * reported unavailable by name (`OAUTH_GITHUB_REDIRECT_URI`), `/health` is not
 * 500, and the instance is degraded, never down. The upgrade path
 * (`planRedirectMigration`) stages the variable so a healthy start is the norm;
 * this is what keeps an install from being left unhealthy when it is not.
 *
 * No value is ever printed: the guard names variables only.
 */

import { guardMcpOAuthEnv, type DegradedGuardDecision } from "../src/lib/mcp-oauth-env-core.js";

let decision: DegradedGuardDecision = { degraded: false, neutralizedVars: [] };

/**
 * Run the guard against `env` (defaults to `process.env`). Idempotent and safe
 * to call from tests directly. Returns the decision (names/booleans only).
 */
export function runMcpOAuthEnvGuard(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): DegradedGuardDecision {
  decision = guardMcpOAuthEnv(env);
  if (decision.degraded) {
    console.error(
      `[mcp-oauth] MCP auth unavailable: ${decision.reason}. ` +
        `The instance is DEGRADED (not failing) — the provider was left unconfigured for this process. ` +
        `Set the variable (or re-run: flair mcp enable), then restart.`,
    );
  }
  return decision;
}

/** The decision recorded at boot; read by `/mcp` route reporting. */
export function mcpOAuthDegraded(): DegradedGuardDecision {
  return decision;
}

// Fire once at module load. Guarded by the same opt-out the MCP route module
// uses so a unit test importing this file never mutates the runner's env.
if (process.env.FLAIR_MCP_NO_AUTOSTART == null) {
  runMcpOAuthEnvGuard();
}
