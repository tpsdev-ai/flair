/**
 * presence-internal.ts — shared internal-path helper for reading the FULL
 * Presence roster from server-side call sites that are NOT the /Presence
 * HTTP endpoint itself.
 *
 * Extracted from resources/AttentionQuery.ts's `queryPresence()` /
 * `presenceDelegationContext()` (flair#677/#678) so the synthetic-
 * delegation-context trick has exactly ONE implementation, reused by every
 * consumer instead of re-derived per call site:
 *
 *   Read teammates' `currentTask` via the exported `Presence` resource's
 *   get() (preserves its verified-agent content gate, #592) — NEVER the raw
 *   table. Presence.get()'s gate keys off a fresh TPS-Ed25519 SIGNATURE
 *   (verifyAgentRequest), not an annotation, specifically to close the
 *   authorizeLocal-forged-identity vector (flair#610) — so a server-side
 *   caller can't just re-run resolveAgentAuth's verdict through it. Instead
 *   this pre-seeds verifyAgentRequest's OWN per-request memoization cache
 *   (`request._flairAgentAuth` — see resources/agent-auth.ts's
 *   verifyAgentRequest doc: "memoized... including null... we verify once
 *   and cache the result on the request") with the verdict THIS request
 *   already established via resolveAgentAuth. This is not a forgery: by the
 *   time a caller has an AgentAuthVerdict to pass in here, `auth.kind` is
 *   already constrained to "agent" (a real Ed25519 signature verified
 *   upstream) or "internal" (a trusted in-process call) — it relays an
 *   already-established fact instead of re-running a doomed second
 *   signature check (the original request's nonce was already consumed by
 *   auth-middleware.ts, so re-verifying the SAME raw request would collide
 *   with the shared nonce store and spuriously read as a replay).
 *
 * See resources/AttentionQuery.ts's module doc ("Presence") for the full
 * security rationale — this file only carries the code, not a second copy
 * of the writeup.
 *
 * Consumers:
 *   - resources/AttentionQuery.ts (flair#678) — entity substring match
 *     against currentTask.
 *   - resources/MemoryBootstrap.ts's collision-surfacing block (flair#681) —
 *     the freshness gate (presenceStatus/lastHeartbeatAt) joined against
 *     WorkspaceState/OrgEvent entity overlap + #550's Memory semantic match.
 */
import type { AgentAuthVerdict } from "./agent-auth.js";

function presenceDelegationContext(auth: AgentAuthVerdict): any {
  const agentAuth = auth.kind === "agent"
    ? { agentId: auth.agentId, isAdmin: auth.isAdmin }
    : { agentId: "internal", isAdmin: true };
  return { request: { _flairAgentAuth: agentAuth } };
}

/**
 * The full presence roster (one row per agent — bounded, per the K&S
 * verdict: "Presence is a bounded scan, one row/agent, tiny"), via the
 * exported `Presence` resource's get(). Fails open to `[]` on any error
 * (Presence being briefly unavailable should never break a caller that
 * treats presence as one signal among several, not a hard dependency).
 */
export async function getPresenceRoster(auth: AgentAuthVerdict): Promise<any[]> {
  try {
    const { Presence } = await import("./Presence.js");
    const p: any = new (Presence as any)();
    p.getContext = () => presenceDelegationContext(auth);
    const roster = await p.get();
    if (roster instanceof Response) return [];
    if (!Array.isArray(roster)) return [];
    return roster;
  } catch {
    return [];
  }
}
