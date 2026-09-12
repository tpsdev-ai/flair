/**
 * Pure classifier for federation peer liveness — no Harper imports.
 *
 * flair#1499: HealthDetail used to count `status === "connected"` (a value
 * pairing never writes — spokes stay `paired` even after a successful
 * lastSyncAt advance) and then take the oldest lastSyncAt across ALL peers,
 * including revoked. A healthy hub synced a minute ago plus a revoked row
 * from June therefore rendered as "0 connected" and fired
 * "federation peers all disconnected >24h".
 *
 * Three contact states, plus revoked (which never drives the staleness
 * warning). Same class as #988: missing/unreadable evidence is UNKNOWN,
 * never DISCONNECTED.
 *
 *   (a) real lastSyncAt within the window → connected
 *   (b) real lastSyncAt older than the window → disconnected
 *   (c) no parseable lastSyncAt → unknown (never rendered as (b))
 *   revoked stored status → revoked (excluded from the >24h warning)
 */

export const PEER_STALE_MS = 24 * 3600 * 1000;

export const FEDERATION_PEERS_ALL_DISCONNECTED_WARNING =
  "federation peers all disconnected >24h";

export type PeerContactLiveness = "connected" | "disconnected" | "unknown";
export type PeerLiveness = PeerContactLiveness | "revoked";

export interface PeerLivenessInput {
  status?: string | null;
  lastSyncAt?: unknown;
}

export interface PeerLivenessSummary {
  total: number;
  connected: number;
  disconnected: number;
  revoked: number;
  unknown: number;
  /** True only when every non-revoked peer has a real last-contact > window. */
  allNonRevokedDisconnected: boolean;
}

/** Parse a written last-contact stamp. Missing / unparseable → null, never 0/epoch. */
export function parseLastContactMs(lastSyncAt: unknown): number | null {
  if (typeof lastSyncAt !== "string") return null;
  const trimmed = lastSyncAt.trim();
  if (!trimmed) return null;
  const t = Date.parse(trimmed);
  return Number.isFinite(t) ? t : null;
}

export function classifyPeerLiveness(
  peer: PeerLivenessInput,
  nowMs: number,
  windowMs: number = PEER_STALE_MS,
): PeerLiveness {
  if (peer.status === "revoked") return "revoked";
  const ts = parseLastContactMs(peer.lastSyncAt);
  if (ts === null) return "unknown";
  // Future / equal-now stamps are contact within the window (clock skew).
  if (nowMs - ts > windowMs) return "disconnected";
  return "connected";
}

export function summarizePeerLiveness(
  peers: readonly PeerLivenessInput[],
  nowMs: number,
  windowMs: number = PEER_STALE_MS,
): PeerLivenessSummary {
  let connected = 0;
  let disconnected = 0;
  let revoked = 0;
  let unknown = 0;
  for (const peer of peers) {
    const liveness = classifyPeerLiveness(peer, nowMs, windowMs);
    if (liveness === "connected") connected++;
    else if (liveness === "disconnected") disconnected++;
    else if (liveness === "revoked") revoked++;
    else unknown++;
  }
  const nonRevoked = peers.length - revoked;
  return {
    total: peers.length,
    connected,
    disconnected,
    revoked,
    unknown,
    allNonRevokedDisconnected: nonRevoked > 0 && disconnected === nonRevoked,
  };
}

export function federationPeersAllDisconnectedWarning(
  summary: Pick<PeerLivenessSummary, "allNonRevokedDisconnected">,
): { level: "warn"; message: string } | null {
  if (!summary.allNonRevokedDisconnected) return null;
  return { level: "warn", message: FEDERATION_PEERS_ALL_DISCONNECTED_WARNING };
}
