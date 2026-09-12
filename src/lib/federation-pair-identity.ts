/**
 * Federation pair identity contract (flair#822).
 *
 * Hub `/FederationPair` must return `instance { id, publicKey }`. A missing
 * or empty publicKey is identity-incomplete: the spoke must not store `""`
 * on its local hub-Peer row. Older hubs that omit `instance` can still be
 * recovered via GET `/FederationInstance`; if that also lacks a key, pair
 * fails closed.
 */

export const HUB_IDENTITY_INCOMPLETE = "hub_instance_identity_incomplete";

export type PairInstanceIdentity = {
  id: string;
  publicKey: string;
  role?: string;
};

export type HubPeerIdentity = {
  id: string;
  publicKey: string;
};

function nonEmptyString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function instanceFields(value: unknown): { id: string; publicKey: string; role: string } {
  const row = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  return {
    id: nonEmptyString(row?.id),
    publicKey: nonEmptyString(row?.publicKey),
    role: nonEmptyString(row?.role),
  };
}

/**
 * Hub: shape the `/FederationPair` `instance` object, or refuse.
 * Requires both `id` and `publicKey` — a pair response without them is
 * how spokes used to write `publicKey: ""` and `id: "hub"`.
 */
export function pairResponseInstance(
  ourInstance: unknown,
): { ok: true; instance: PairInstanceIdentity } | { ok: false; error: string } {
  const { id, publicKey, role } = instanceFields(ourInstance);
  if (!id || !publicKey) {
    return {
      ok: false,
      error:
        "hub Instance row is missing id or publicKey — pair cannot complete the identity handshake",
    };
  }
  return {
    ok: true,
    instance: role ? { id, publicKey, role } : { id, publicKey },
  };
}

/**
 * Spoke: accept a pair JSON body only when `instance.publicKey` is present.
 * `id` may fall back to `"hub"` if the key is present but the id is not —
 * the defect is an empty key, not a missing id.
 */
export function hubPeerFromPairResult(
  result: unknown,
): { ok: true; peer: HubPeerIdentity } | { ok: false; reason: "missing_public_key" } {
  const inst =
    result && typeof result === "object"
      ? (result as { instance?: unknown }).instance
      : undefined;
  const { id, publicKey } = instanceFields(inst);
  if (!publicKey) return { ok: false, reason: "missing_public_key" };
  return { ok: true, peer: { id: id || "hub", publicKey } };
}

export type ResolveHubPeerIdentityResult =
  | { ok: true; peer: HubPeerIdentity; source: "pair" | "federation_instance" }
  | { ok: false; error: string };

/**
 * Spoke resolver: pair response first, then optional GET `/FederationInstance`.
 * Never returns a peer with an empty publicKey.
 */
export async function resolveHubPeerIdentity(
  pairResult: unknown,
  opts?: { fetchInstance?: () => Promise<unknown> },
): Promise<ResolveHubPeerIdentityResult> {
  const fromPair = hubPeerFromPairResult(pairResult);
  if (fromPair.ok) return { ...fromPair, source: "pair" };

  if (opts?.fetchInstance) {
    try {
      const fetched = await opts.fetchInstance();
      const recovered = hubPeerFromPairResult({ instance: fetched });
      if (recovered.ok) return { ...recovered, source: "federation_instance" };
    } catch {
      // Fall through to the closed-fail error.
    }
  }

  return {
    ok: false,
    error:
      "hub pair response omitted instance.publicKey and GET /FederationInstance did not supply one — refusing to store an empty hub Peer key",
  };
}
