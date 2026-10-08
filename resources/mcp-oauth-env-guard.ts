import { guardMcpOAuthEnv, readMcpProviderReadiness, type DegradedGuardDecision, type McpProviderReadiness } from "../src/lib/mcp-oauth-env-core.js";

interface GuardState {
  decision: DegradedGuardDecision;
  readiness: McpProviderReadiness;
  decisions: WeakMap<Record<string, string | undefined>, {
    decision: DegradedGuardDecision;
    readiness: McpProviderReadiness;
  }>;
}
const GUARD_STATE = Symbol.for("flair.mcpOAuthEnvGuard");
const guardProcess = process as typeof process & { [GUARD_STATE]?: GuardState };
const state = guardProcess[GUARD_STATE] ??= {
  decision: { degraded: false, neutralizedVars: [] },
  readiness: readMcpProviderReadiness(process.env),
  decisions: new WeakMap(),
};

export function mcpOAuthProviderReadiness() {
  return { ...state.readiness };
}

export function runMcpOAuthEnvGuard(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): DegradedGuardDecision {
  const previous = state.decisions.get(env);
  if (previous) {
    state.readiness = previous.readiness;
    state.decision = previous.decision;
    return previous.decision;
  }
  state.readiness = readMcpProviderReadiness(env);
  const decision = state.decision = guardMcpOAuthEnv(env);
  state.decisions.set(env, { decision, readiness: state.readiness });
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
  return state.decision;
}

// A unit test can set FLAIR_MCP_NO_AUTOSTART before import to avoid env mutation.
if (process.env.FLAIR_MCP_NO_AUTOSTART == null) {
  runMcpOAuthEnvGuard();
}
