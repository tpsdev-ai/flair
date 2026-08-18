/**
 * Interpolation-literal env guard (flair#1254, generalizing flair#1250/#1253).
 *
 * An MCP/agent host config template often forwards env like
 *   "env": { "FLAIR_URL": "${FLAIR_URL}" }
 * expecting the host to substitute `${FLAIR_URL}` with the real value. When
 * the variable is unset and the host does NOT substitute, the consumer process
 * is handed the LITERAL string `"${FLAIR_URL}"`. That literal is truthy, so it
 * wins every `value ?? default` / `value || default` chain and the sensible
 * default never applies — the connection then fails pointing nowhere near the
 * real cause.
 *
 * flair#1253 stripped such literals at flair-mcp's process boundary, but the
 * root exposure is HERE: FlairClient's constructor independently re-reads
 * `process.env.FLAIR_*` as its own fallback, so every consumer of this client
 * (CLI, adk, langgraph, n8n, ...) had the identical exposure and would each
 * have needed its own boundary strip. This guard makes the client's own env
 * fallbacks treat a wholesale `${...}` literal as absent, so the existing
 * defaults (DEFAULT_URL, key-path derivation, no-basic-auth) apply instead —
 * no new hardcoded defaults are introduced. flair-mcp's boundary strip stays
 * as defense-in-depth.
 *
 * Semantics intentionally identical to packages/flair-mcp/src/env-guard.ts.
 * Duplicated (not imported) because the dependency points the other way:
 * flair-mcp depends on flair-client, and flair-client is zero-dep.
 */

/**
 * True iff `value` is an unsubstituted interpolation literal like `${FLAIR_URL}`
 * — i.e. the whole (trimmed) value is a single `${...}` placeholder the host
 * never expanded. A value that merely CONTAINS a `${...}` (e.g. a real URL with
 * a fragment) is left alone: only a wholesale placeholder is treated as unset.
 */
export function isUnsubstitutedInterpolation(value: string): boolean {
  return /^\$\{.*\}$/.test(value.trim());
}

/**
 * Read an env var, treating an unsubstituted `${...}` interpolation literal as
 * unset: returns `undefined` for such a literal (and for a genuinely absent
 * var) so a downstream default applies instead of the literal being used
 * verbatim. A real value is returned unchanged (NOT trimmed — only the
 * placeholder check trims).
 */
export function readEnvOrUnset(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const v = env[name];
  if (v === undefined) return undefined;
  return isUnsubstitutedInterpolation(v) ? undefined : v;
}
