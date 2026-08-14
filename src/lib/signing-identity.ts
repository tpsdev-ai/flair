/**
 * signing-identity.ts — the ONE canonical signing-identity resolver (flair#1183).
 *
 * Before this file existed, every CLI command family answered "which agent am
 * I signing this request AS?" with its own chain, and they disagreed:
 *
 *   - `search`/`bootstrap`/`status`/`presence`/`workspace` resolved
 *     `--agent flag > FLAIR_AGENT_ID env` (via `resolveAgentIdOrEnv`), then
 *     hand-signed with that id.
 *   - Everything routed through `api()` (memory search/list, soul list, and
 *     the writes) RE-derived the signer inside `api()` as
 *     `FLAIR_AGENT_ID env > body.agentId`. That inverts the precedence: a
 *     command the operator ran with `--agent X` while `FLAIR_AGENT_ID=Y` was
 *     exported in the shell SIGNED as Y, even though the record it wrote and
 *     the query it filtered both named X. Against a remote target where Y is
 *     not registered, the server answered `unknown_agent` — three parties
 *     (operator, CLI, server) silently disagreeing about who was calling.
 *   - The `soul` family had NO env/flag resolution of its own at all: it put
 *     `--agent` into the request body and leaned entirely on `api()`'s
 *     env-first extraction, so even the `FLAIR_KEY_DIR` workaround that forced
 *     the identity on the other commands could not steer it. That was the
 *     worst rung — the "stale rung" the issue calls out.
 *
 * This module makes the precedence ONE thing, documented and testable:
 *
 *   ── Resolution order ──────────────────────────────────────────────────────
 *   1. FLAG   — an explicit `--agent <id>`. The operator naming an identity on
 *               THIS invocation always wins.
 *   2. ENV    — `FLAIR_AGENT_ID`. Ambient but still a deliberate operator/CI
 *               choice for the session.
 *   3. CONFIG — the "config profile": the machine's ambient signing credential
 *               (the `~/.flair/admin-pass` file and the Ed25519 agent-key floor
 *               under `~/.flair/keys`). This tier is applied DOWNSTREAM by
 *               `authedRequest` (src/lib/auth-resolve.ts, tiers 4-5), not by a
 *               name lookup here — a forgotten `--agent` must never silently
 *               resolve to some other configured identity. `resolveSigningIdentity`
 *               models this tier via its `configProfileAgentId` parameter so the
 *               full documented precedence is expressible and unit-testable; the
 *               CLI leaves it unset and delegates the tier to `authedRequest`.
 *   4. NONE   — nothing resolved by flag/env; the caller decides whether that is
 *               fatal (agent-scoped commands demand an explicit identity) or
 *               whether to let `authedRequest` apply the tier-3 ambient credential.
 *
 * The signer is resolved ONCE, at the command boundary, and threaded down to
 * `api()`/`authedRequest` as an authoritative value — `api()` no longer
 * re-derives it from the environment behind the caller's back.
 */

export type SigningIdentitySource = "flag" | "env" | "config" | "none";

export interface ResolvedSigningIdentity {
  /** The agent id to sign as, or null when nothing resolved. */
  agentId: string | null;
  /** Which tier won — for the debug line and for tests to pin precedence. */
  source: SigningIdentitySource;
}

/**
 * The canonical resolver. Pure: every input is a parameter, so precedence is
 * testable in isolation with no filesystem or process state.
 *
 * `configProfileAgentId` is the tier-3 value (the machine's wired agent id);
 * pass `undefined`/`null` when there is no config profile, or when the caller
 * deliberately does not consult one. `env` is injectable for tests; it
 * defaults to `process.env`.
 */
export function resolveSigningIdentity(
  opts: { agent?: string | null | undefined },
  configProfileAgentId?: string | null | undefined,
  env: { FLAIR_AGENT_ID?: string | undefined } = process.env,
): ResolvedSigningIdentity {
  if (opts.agent) return { agentId: opts.agent, source: "flag" };
  const envId = env.FLAIR_AGENT_ID;
  if (envId) return { agentId: envId, source: "env" };
  if (configProfileAgentId) return { agentId: configProfileAgentId, source: "config" };
  return { agentId: null, source: "none" };
}

/** Human label for a source, used in the debug line and error text. */
export function describeSigningIdentitySource(source: SigningIdentitySource): string {
  switch (source) {
    case "flag": return "--agent flag";
    case "env": return "FLAIR_AGENT_ID env";
    case "config": return "config profile";
    case "none": return "no --agent flag, FLAIR_AGENT_ID env, or config-profile agent";
  }
}

/**
 * The one-line diagnostic. Names the resolved agentId AND which tier won, so
 * an operator can see — without guessing — who the CLI is about to sign as.
 * Pure string builder; the gate + write live in `emitSigningIdentityDebug`.
 */
export function formatSigningIdentityDebug(
  resolved: ResolvedSigningIdentity,
  command?: string,
): string {
  const where = command ? ` for '${command}'` : "";
  if (resolved.agentId === null) {
    return `[flair] signing identity${where}: <none> — ${describeSigningIdentitySource("none")} resolved`;
  }
  return `[flair] signing identity${where}: ${resolved.agentId} (source: ${describeSigningIdentitySource(resolved.source)})`;
}

/**
 * Emit the debug line to stderr, gated behind `FLAIR_DEBUG` (any non-empty
 * value). stderr, never stdout, so `--json` output stays clean and pipeable.
 * `env` and `write` are injectable for tests.
 */
export function emitSigningIdentityDebug(
  resolved: ResolvedSigningIdentity,
  command?: string,
  env: { FLAIR_DEBUG?: string | undefined } = process.env,
  write: (s: string) => void = (s) => { process.stderr.write(s); },
): void {
  if (!env.FLAIR_DEBUG) return;
  write(formatSigningIdentityDebug(resolved, command) + "\n");
}
