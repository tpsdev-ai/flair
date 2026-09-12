/**
 * Spoke pair identity (flair#822).
 *
 * Pair already returns `instance.{id,publicKey}` when the hub has a
 * FederationInstance row (flair#213). An empty spoke hub-Peer key means
 * that row was missing at pair time — a symptom of open #839, not a
 * pair-response-shape bug. Chip is fail-closed: ERROR, never store
 * `publicKey: ""`. Do not GET `/FederationInstance` from the spoke —
 * that path is admin-gated (bootstrap Basic cannot read it) and
 * find-or-creates a new Instance on a miss, which would invent a hub
 * row. A spoke Peer write does not provision the missing hub row.
 */

export type HubPeerIdentity = {
  id: string;
  publicKey: string;
};

function nonEmptyString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function instancePublicKey(value: unknown): { id: string; publicKey: string } {
  const row = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  return {
    id: nonEmptyString(row?.id),
    publicKey: nonEmptyString(row?.publicKey),
  };
}

/**
 * Accept a pair JSON body only when `instance.publicKey` is non-empty.
 * `id` may fall back to `"hub"` if the key is present but the id is not.
 */
export function hubPeerFromPairResult(
  result: unknown,
): { ok: true; peer: HubPeerIdentity } | { ok: false; reason: "missing_public_key" } {
  const inst =
    result && typeof result === "object"
      ? (result as { instance?: unknown }).instance
      : undefined;
  const { id, publicKey } = instancePublicKey(inst);
  if (!publicKey) return { ok: false, reason: "missing_public_key" };
  return { ok: true, peer: { id: id || "hub", publicKey } };
}

export const EMPTY_HUB_PEER_KEY_ERROR =
  "hub pair response omitted instance.publicKey — refusing to store an empty hub Peer key. " +
  "The hub likely has no FederationInstance row (flair#839); a spoke Peer write does not create one.";

export type ResolveHubPeerIdentityResult =
  | { ok: true; peer: HubPeerIdentity; source: "pair" }
  | { ok: false; error: string };

/**
 * Fail-closed: pair `instance.publicKey` or ERROR. Never returns an empty key.
 * Does not fetch `/FederationInstance` (admin-gated + find-or-create).
 */
export function resolveHubPeerIdentity(pairResult: unknown): ResolveHubPeerIdentityResult {
  const fromPair = hubPeerFromPairResult(pairResult);
  if (fromPair.ok) return { ...fromPair, source: "pair" };
  return { ok: false, error: EMPTY_HUB_PEER_KEY_ERROR };
}
