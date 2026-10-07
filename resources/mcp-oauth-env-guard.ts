import { guardMcpOAuthEnv, readMcpProviderReadiness, type DegradedGuardDecision } from "../src/lib/mcp-oauth-env-core.js";

let decision: DegradedGuardDecision = { degraded: false, neutralizedVars: [] };

const decisions = new WeakMap<Record<string, string | undefined>, DegradedGuardDecision>();
let readiness = readMcpProviderReadiness(process.env);

export function mcpOAuthProviderReadiness() {
  return { ...readiness };
}

export function runMcpOAuthEnvGuard(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): DegradedGuardDecision {
  const previous = decisions.get(env);
  if (previous) return previous;
  readiness = readMcpProviderReadiness(env);
  decision = guardMcpOAuthEnv(env);
  decisions.set(env, decision);
  if (decision.degraded) {
    console.error(
      `[mcp-oauth] MCP auth unavailable: ${decision.reason}. ` +
        `The provider was left unconfigured for this process. ` +
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
