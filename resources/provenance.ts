import type { AgentAuthVerdict } from "./agent-auth.js";

/**
 * Sanitize an optional, unverified `claimed.*` passthrough value (memory-
 * provenance slice 1 + flair#718 authorship-provenance). Shared by BOTH
 * `claimed.model` and `claimed.client` — same authority level, same
 * discipline, one implementation so they can't drift:
 *
 *   1. Must be a `string` — anything else (number, object, array) is dropped.
 *   2. Control characters (C0 + DEL, `\x00`-`\x1F`,`\x7F`) are stripped —
 *      this is caller-supplied, unverified data landing in a stored JSON
 *      blob; no newlines/nulls smuggled into logs or downstream renders.
 *   3. Trimmed.
 *   4. Length-capped at 200 chars (truncated, not rejected — a label this
 *      long is almost certainly malformed, but the write must never fail
 *      because of it).
 *   5. Dropped (returns `undefined`) if empty after the above — an
 *      all-control-chars or all-whitespace input is treated as absent, not
 *      stamped as `""`.
 *
 * Sherlock flair#718 review: `claimed.model` previously had only a
 * truthiness check (no cap, no sanitize) — folded into this same function
 * "while touching the same code" per that review's non-blocking recommendation.
 */
function sanitizeClaim(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(/[\x00-\x1F\x7F]/g, "").trim();
  if (cleaned.length === 0) return undefined;
  return cleaned.length > 200 ? cleaned.slice(0, 200) : cleaned;
}

/**
 * ─── Write-time provenance stamp (memory-provenance slice 1; claimed.client
 * added by flair#718 authorship-provenance) ──────────────────────────────────
 *
 * Foundational capture for an emergent-trust model: every write gets a
 * structured, versioned `provenance` JSON blob recording what the server can
 * actually VERIFY about the write, plus (optionally) what the caller merely
 * CLAIMS. Deliberately minimal — verified fields only:
 *
 *   { v: 1,
 *     verified: { agentId: <string|null>, timestamp: <ISO string> },
 *     claimed?: { model?: <string>, client?: <string> } }
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
 *   string `model` field (sanitized via sanitizeClaim above). Never
 *   invented, never defaulted.
 * - `claimed.client` (flair#718) is the SAME kind of OPTIONAL, UNVERIFIED
 *   passthrough, sourced from `content.claimedClient` (a deliberately
 *   distinct body-field name from the output key — see the write paths in
 *   resources/Memory.ts / resources/Relationship.ts, which strip this field
 *   from the row after calling buildProvenance so it is NEVER persisted
 *   outside this provenance blob). Records WHICH CLIENT authored a write
 *   under one shared principal (the personal deployment shape — see
 *   docs/auth.md "Deployment shapes"). `claimed` — never `verified` —
 *   because this is self-reported by an authenticated principal, not
 *   independently corroborated: it MUST grant zero authority anywhere
 *   (never read for access control, attribution weighting, or dedup
 *   decisions — Sherlock flair#718 binding refinement). On the native /mcp
 *   OAuth path, the caller is required to source this from the verified
 *   `client_id` token claim, never the user-controlled `client_name` — see
 *   resources/mcp-handler.ts's handleToolCall for that stamp site.
 * - The `claimed` key is omitted entirely (not stamped as `{}`) when both
 *   `model` and `client` are absent.
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
    claimed?: { model?: string; client?: string };
  } = {
    v: 1,
    verified: {
      agentId: auth.kind === "agent" ? auth.agentId : null,
      timestamp: createdAt,
    },
  };
  const model = sanitizeClaim(content?.model);
  const client = sanitizeClaim(content?.claimedClient);
  if (model !== undefined || client !== undefined) {
    provenance.claimed = {};
    if (model !== undefined) provenance.claimed.model = model;
    if (client !== undefined) provenance.claimed.client = client;
  }
  return JSON.stringify(provenance);
}
