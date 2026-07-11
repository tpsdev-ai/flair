import type { AgentAuthVerdict } from "./agent-auth.js";

/**
 * ─── Write-time provenance stamp (memory-provenance slice 1) ────────────────
 *
 * Foundational capture for an emergent-trust model: every write gets a
 * structured, versioned `provenance` JSON blob recording what the server can
 * actually VERIFY about the write, plus (optionally) what the caller merely
 * CLAIMS. Deliberately minimal — verified fields only:
 *
 *   { v: 1,
 *     verified: { agentId: <string|null>, timestamp: <ISO string> },
 *     claimed?: { model: <string> } }
 *
 * - `verified.agentId` comes from the ALREADY-RESOLVED auth verdict
 *   (resolveAgentAuth) — never from anything the caller can forge on the
 *   request body. `kind: "agent"` → the Ed25519-verified agentId. Any other
 *   verdict (in practice only `kind: "internal"` — a trusted in-process call
 *   with no per-agent identity to attribute) stamps `null` rather than
 *   throwing; `kind: "anonymous"` never reaches here — every write path
 *   already 401s it before this point.
 * - `verified.timestamp` reuses the server-clock `createdAt` the caller has
 *   already computed by this point (never client-suppliable) — the same
 *   "stamp a dynamic attribute the server controls" mechanism as e.g. the
 *   `embeddingModel = getModelId()` stamp in resources/Memory.ts.
 * - `claimed.model` is an OPTIONAL, UNVERIFIED passthrough: included only
 *   when the incoming write payload itself already carries a non-empty
 *   string `model` field. No client/CLI sets one today — this just means the
 *   server won't discard it if/when a future write path does. Never
 *   invented, never defaulted, and the `claimed` key is omitted entirely
 *   (not stamped as `{}`) when absent.
 *
 * Originally introduced in resources/Memory.ts (Memory.post()/Memory.put());
 * extracted here so Relationship.ts (and any future write path) can reuse the
 * EXACT same shape rather than inventing a table-specific format — the
 * K&S-approved contract for the relationship-write-path spec is "reuse
 * buildProvenance as-is," which this module makes literal (one function, one
 * shape, imported by every writer) instead of a copy that could drift.
 */
export function buildProvenance(auth: AgentAuthVerdict, createdAt: string, content: any): string {
  const provenance: {
    v: 1;
    verified: { agentId: string | null; timestamp: string };
    claimed?: { model: string };
  } = {
    v: 1,
    verified: {
      agentId: auth.kind === "agent" ? auth.agentId : null,
      timestamp: createdAt,
    },
  };
  if (typeof content?.model === "string" && content.model.length > 0) {
    provenance.claimed = { model: content.model };
  }
  return JSON.stringify(provenance);
}
