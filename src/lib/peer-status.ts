/** Documented Peer.status CLI vocabulary. */
export const PEER_STATUS = {
  PAIRED: "paired",
  CONNECTED: "connected",
  DISCONNECTED: "disconnected",
  REVOKED: "revoked",
} as const;

export type PeerStatus = (typeof PEER_STATUS)[keyof typeof PEER_STATUS];

/** Values listed in the Peer.status schema comment. */
export const PEER_STATUS_VALUES: readonly PeerStatus[] = [
  PEER_STATUS.PAIRED,
  PEER_STATUS.CONNECTED,
  PEER_STATUS.DISCONNECTED,
  PEER_STATUS.REVOKED,
];

export const PEER_MEMBERSHIP_STATUSES: readonly PeerStatus[] = [
  PEER_STATUS.PAIRED,
  PEER_STATUS.CONNECTED,
  PEER_STATUS.DISCONNECTED,
];

/** Classify the documented CLI vocabulary. */
export function isPeerStatus(value: unknown): value is PeerStatus {
  return typeof value === "string" && (PEER_STATUS_VALUES as readonly string[]).includes(value);
}

/** Classify the documented membership statuses. */
export function isPeerMemberStatus(value: unknown): value is PeerStatus {
  return typeof value === "string" && (PEER_MEMBERSHIP_STATUSES as readonly string[]).includes(value);
}
