/**
 * Interpolation-literal env guard (flair#1250).
 *
 * An MCP host config template often forwards env like
 *   "env": { "FLAIR_URL": "${FLAIR_URL}" }
 * expecting the host to substitute `${FLAIR_URL}` with the real value. When the
 * variable is unset and the host does NOT substitute (Cursor's plugin `mcp.json`
 * is exactly this shape — see packages/cursor-flair/mcp.json), flair-mcp is
 * handed the LITERAL string `"${FLAIR_URL}"`. That literal is truthy, so it wins
 * every `value ?? default` / `value || default` chain and the sensible default
 * (flair-client's `http://localhost:19926`) never applies — the connection then
 * fails in a way that points nowhere near the real cause.
 *
 * This module treats such a literal as "unset" so the default applies instead.
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

/**
 * Connection env vars that flair-client's OWN constructor reads straight from
 * `process.env` as a fallback (see flair-client/src/client.ts:
 * `this.url = config.url ?? readEnvOrUnset("FLAIR_URL") ?? DEFAULT_URL`). For
 * these, skipping the literal only at flair-mcp's call site was NOT enough:
 * flair-client re-read `process.env` and resurrected the `${...}` literal,
 * defeating its own default. As of flair#1254 flair-client's env fallbacks
 * apply this same literal-as-unset guard themselves, so the strip below is
 * defense-in-depth rather than the only line — kept deliberately (an older
 * flair-client on a consumer's disk does not have #1254).
 *
 * Only FLAIR_URL qualifies today: it is re-read by flair-client AND flair-mcp
 * still constructs a client when it is a literal. FLAIR_AGENT_ID is also re-read
 * by flair-client, but flair-mcp's `if (!agentId)` guard (using readEnvOrUnset)
 * short-circuits before any client is built, so no strip is needed. FLAIR_KEY_PATH
 * flair-client never reads from env, so guarding it at the call site suffices.
 */
export const ENV_RESURRECTED_BY_FLAIR_CLIENT = ["FLAIR_URL"] as const;

/**
 * Delete any of `names` whose value is an unsubstituted `${...}` interpolation
 * literal from `env`, so downstream readers — flair-mcp's own reads AND
 * flair-client's internal `process.env` fallback — see the var as unset and
 * apply their default. Idempotent; mutates the live process env by default and
 * accepts an injectable env for tests. Real (substituted) values are untouched.
 */
export function stripInterpolationLiteralsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  names: readonly string[] = ENV_RESURRECTED_BY_FLAIR_CLIENT,
): void {
  for (const name of names) {
    const v = env[name];
    if (typeof v === "string" && isUnsubstitutedInterpolation(v)) {
      delete env[name];
    }
  }
}
