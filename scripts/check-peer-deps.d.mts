/** Types for scripts/check-peer-deps.mjs (flair#1936). */

export interface PeerViolation {
  /** The workspace package that declares the peer. */
  from: string;
  /** Repo-relative path of its package.json. */
  path: string;
  /** The peer dependency name. */
  peer: string;
  /** The declared peer range. */
  range: string;
  /** The version bun.lock resolves for the peer, or null when there is none. */
  version: string | null;
}

/**
 * The version bun.lock resolves for `peer` in `workspaceName`'s context: the
 * workspace's own nested resolution (`<workspaceName>/<peer>`) when present,
 * else the top-level `<peer>` resolution. undefined when neither exists.
 */
export function resolvedPeerVersion(
  lock: unknown,
  workspaceName: string,
  peer: string,
): string | undefined;

/**
 * Every violation: a non-optional declared peer that is unresolved in the lock
 * or whose resolved version does not satisfy the declared range.
 */
export function findPeerViolations(repoRoot: string): PeerViolation[];
