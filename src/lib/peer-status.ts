/**
 * peer-status.ts — the ONE `Peer.status` vocabulary, used by the federation
 * CLI rendering (flair#2141 S3a).
 *
 * `Peer.status` (schemas/federation.graphql) is a federation MEMBERSHIP state,
 * not a heartbeat:
 *
 *   paired        — a key is pinned and membership is established
 *   connected     — recent contact with the peer
 *   disconnected  — membership intact, freshness degraded (no recent contact)
 *   revoked       — membership terminated (terminal; the row is retained)
 *
 * `active` is an `Instance.status` value and is deliberately NOT a Peer status:
 * the federation status table used to render `active` green beside the real
 * membership words, which read as "this peer is a member" for a word that never
 * appears on a Peer row.
 *
 * Deliberately dependency-free (no `harper`, no `resource`): `src/` must not
 * import `resources/`, and `resources/` may import `src/lib/` (the same seam
 * `instance-identity-row.ts` and `harper-port-value.ts` use), so this module is
 * the single place the two layers can meet.
 */

export const PEER_STATUS = {
  PAIRED: "paired",
  CONNECTED: "connected",
  DISCONNECTED: "disconnected",
  REVOKED: "revoked",
} as const;

export type PeerStatus = (typeof PEER_STATUS)[keyof typeof PEER_STATUS];

/** Every Peer.status value, in schema declaration order. */
export const PEER_STATUS_VALUES: readonly PeerStatus[] = [
  PEER_STATUS.PAIRED,
  PEER_STATUS.CONNECTED,
  PEER_STATUS.DISCONNECTED,
  PEER_STATUS.REVOKED,
];

/**
 * The membership statuses: a peer carrying one of these is a directory member.
 * `revoked` is NOT a member, and a missing or unrecognized status is not a
 * member either (membership is granted only by an affirmative status).
 */
export const PEER_MEMBERSHIP_STATUSES: readonly PeerStatus[] = [
  PEER_STATUS.PAIRED,
  PEER_STATUS.CONNECTED,
  PEER_STATUS.DISCONNECTED,
];

/** True for a value that is exactly one of the four Peer.status values. */
export function isPeerStatus(value: unknown): value is PeerStatus {
  return typeof value === "string" && (PEER_STATUS_VALUES as readonly string[]).includes(value);
}

/** True for a value that grants directory membership (see above). */
export function isPeerMemberStatus(value: unknown): value is PeerStatus {
  return typeof value === "string" && (PEER_MEMBERSHIP_STATUSES as readonly string[]).includes(value);
}
