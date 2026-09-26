// ONE agent-identity resolution for the Flair scripts (flair#1822).
//
// A shipped default identity is a trust anchor by omission: an invocation that
// forgets its env var acts as a specific principal, and on a host holding that
// principal's key the write (or read) is performed as the wrong author
// (flair#1816). So there is no default — the identity is the caller's, or the
// script refuses, BEFORE any key load or network call.
//
// Only `node:` builtins: these run from a plain checkout, no bundler.

/** The remedy sentence every refusal repeats, verbatim. */
export const AGENT_IDENTITY_REMEDY = 'Set FLAIR_AGENT_ID or pass --agent <id>';

/**
 * Pull `--agent <id>` out of `args`. Returns `{ agentId, rest }` where `rest`
 * is `args` without the flag (so a caller that joins the remainder into content
 * cannot fold the flag in). A value-less `--agent`, or a second one, is a hard
 * error. Never touches the filesystem.
 */
export function takeAgentFlag(args) {
  const i = args.indexOf('--agent');
  if (i === -1) return { agentId: undefined, rest: args };
  const value = args[i + 1];
  if (value === undefined || value === '' || value.startsWith('--')) {
    console.error('--agent requires a value');
    process.exit(1);
  }
  const rest = args.slice(0, i).concat(args.slice(i + 2));
  if (rest.includes('--agent')) {
    console.error('--agent may only be given once');
    process.exit(1);
  }
  return { agentId: value, rest };
}

/**
 * Resolve the explicit identity: `FLAIR_AGENT_ID` wins, then `--agent <id>`.
 * Returns null when neither is set — there is deliberately NO default.
 */
export function resolveAgentIdentity({ flagValue, env = process.env } = {}) {
  const fromEnv = env.FLAIR_AGENT_ID;
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv;
  if (typeof flagValue === 'string' && flagValue.length > 0) return flagValue;
  return null;
}

/**
 * Resolve the identity or refuse. On absence, prints the refusal naming BOTH
 * remedies and exits 1 — before any key load or network call. `action` names
 * what is being refused (e.g. "bootstrap", "sync"). Never touches the
 * filesystem: a refusal is not allowed to depend on a key file existing.
 */
export function requireAgentIdentity({ flagValue, action = 'run', env = process.env } = {}) {
  const id = resolveAgentIdentity({ flagValue, env });
  if (!id) {
    console.error(
      `refusing to ${action}: no agent identity. ${AGENT_IDENTITY_REMEDY}. ` +
        'A default identity would act as a principal the caller did not choose (flair#1822).',
    );
    process.exit(1);
  }
  return id;
}
