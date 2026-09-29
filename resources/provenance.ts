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
 *     verified: { agentId: <string|null>, timestamp: <ISO string>, receivedAt: <ISO string> },
 *     claimed?: { createdAt?: <string>, model?: <string>, client?: <string> } }
 *
 * - `verified.agentId` comes from the ALREADY-RESOLVED auth verdict
 *   (resolveAgentAuth) — never from anything the caller can forge on the
 *   request body. `kind: "agent"` → the Ed25519-verified agentId. Any other
 *   verdict (in practice only `kind: "internal"` — a trusted in-process call
 *   with no per-agent identity to attribute) stamps `null` rather than
 *   throwing; `kind: "anonymous"` never reaches here — every write path
 *   already 401s it before this point.
 * - `verified.timestamp` is stamped from the SERVER clock at write time
 *   (flair#1960) — the SAME single clock read as `verified.receivedAt`, because
 *   both assert the server's write instant (a second read could differ by
 *   milliseconds and make the two fields disagree). Never client-suppliable:
 *   the caller's `createdAt` is a CLAIM and is recorded separately under
 *   `claimed.createdAt` (below), never here. Every field under `verified` is
 *   server-derived.
 *   The clock is an injectable `() => Date` (defaulting to the wall clock) so
 *   the "one read" contract is TESTABLE: a counting/advancing fake clock fails
 *   the test deterministically if a second read is ever added (flair#1960 r2 —
 *   comparing two wall-clock reads only catches a drift of >0 ms, and two reads
 *   almost always land in the SAME millisecond, so the old equality-only test
 *   CAUGHT a second read only ~7 times in 10,000 — it MISSED it the other
 *   ~9,993). Production callers never pass one.
 * - The host pointer (`hostSource`) is NOT provenance (flair#1940 A5): it lives
 *   in its own `MemoryHostSource` table, is never part of this `{ v, verified,
 *   claimed }` blob, and is written on the Memory write path in the same
 *   transaction as the Memory row (t1/t2). `provenance` therefore stays a field
 *   the server controls and is never client-writable.
 * - `claimed.createdAt` (flair#1960) is the caller's claim on the record's
 *   creation time — the `createdAt` the write carries, sanitized like the
 *   other claims (string-only, control-char strip, trim, 200-char cap,
 *   drop-if-empty). It is a CLAIM, never verified: the server's own write
 *   instant lives in `verified.timestamp`. The record's own `createdAt` field
 *   still carries the caller's value unchanged.
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
 * - The `claimed` key is omitted entirely (not stamped as `{}`) when
 *   `createdAt`, `model` and `client` are ALL absent after sanitization (e.g.
 *   an empty or all-control-chars `createdAt` with no model/client claims).
 *
 * Originally introduced in resources/Memory.ts (Memory.post()/Memory.put());
 * extracted here so Relationship.ts (and any future write path) can reuse the
 * EXACT same shape rather than inventing a table-specific format — the
 * K&S-approved contract for the relationship-write-path spec is "reuse
 * buildProvenance as-is," which this module makes literal (one function, one
 * shape, imported by every writer) instead of a copy that could drift.
 */
export function buildProvenance(
  auth: AgentAuthVerdict,
  createdAt: string,
  content: any,
  clock: () => Date = () => new Date(),
): string {
  // ONE clock read per write, shared by BOTH server-derived timestamps
  // (flair#1960): `verified.timestamp` and `verified.receivedAt` assert the
  // same server write instant, so a single `clock()` call keeps them identical
  // instead of letting a second read drift them apart by milliseconds.
  const serverNow = clock().toISOString();
  const provenance: {
    v: 1;
    verified: { agentId: string | null; timestamp: string; receivedAt: string };
    claimed?: { createdAt?: string; model?: string; client?: string };
  } = {
    v: 1,
    verified: {
      agentId: auth.kind === "agent" ? auth.agentId : null,
      // flair#1960: the server's write instant — NEVER the caller's `createdAt`.
      timestamp: serverNow,
      // flair#1940 A4: the server's RECEIPT time — same clock read as above.
      receivedAt: serverNow,
    },
  };
  // The caller's `createdAt` is their CLAIM on the record's creation time; it is
  // recorded under `claimed` (sanitized like the other claims) so a reader can
  // compare the claim against the server's `verified.timestamp`. The record's
  // own `createdAt` field keeps the claim unchanged (flair#1960).
  const claimedCreatedAt = sanitizeClaim(createdAt);
  const model = sanitizeClaim(content?.model);
  const client = sanitizeClaim(content?.claimedClient);
  if (claimedCreatedAt !== undefined || model !== undefined || client !== undefined) {
    provenance.claimed = {};
    if (claimedCreatedAt !== undefined) provenance.claimed.createdAt = claimedCreatedAt;
    if (model !== undefined) provenance.claimed.model = model;
    if (client !== undefined) provenance.claimed.client = client;
  }
  return JSON.stringify(provenance);
}

/**
 * The fields whose change makes a memory write SEMANTIC — the text the record
 * actually says, plus its creation claim. A PATCH that changes one of these is
 * re-authoring content (and, for `createdAt`, re-authoring the creation claim),
 * so it MUST re-stamp provenance from the resolved auth and the server clock
 * rather than carry a previously stored `verified.*` value forward (flair#1960
 * r2). `createdAt` is included (flair#1960 r4): a createdAt-only PATCH is
 * allowed and reaches `super.patch`, so if it were NOT semantic the row's
 * `createdAt` could change while `provenance.claimed.createdAt` kept the old
 * value. Making it semantic means a changed creation claim re-stamps, and
 * `claimed.createdAt` follows the row.
 */
export const MEMORY_SEMANTIC_FIELDS = Object.freeze(["content", "subject", "summary", "createdAt"] as const);

/**
 * The fields whose change makes a relationship write SEMANTIC — its identity
 * (what it links), plus its creation claim. Same rule as MEMORY_SEMANTIC_FIELDS:
 * a semantic PATCH re-stamps provenance; a metadata-only PATCH
 * (confidence/source/etc.) leaves the stored, previously-stamped blob in place.
 * `createdAt` is included (flair#1960 r4) for the same reason: a changed
 * creation claim is a re-authored claim, so the PATCH re-stamps and
 * `claimed.createdAt` follows the row.
 */
export const RELATIONSHIP_SEMANTIC_FIELDS = Object.freeze(["subject", "predicate", "object", "createdAt"] as const);

/**
 * True when `content` changes at least one of `fields` relative to the STORED
 * record — the trigger for a provenance re-stamp on the update (PATCH) path.
 *
 * A value that is ABSENT from the write body is never a change (Harper PATCH
 * merges; a missing key means "leave the stored value"), so this only looks at
 * keys actually present in `content`. A non-object body, or a body whose target
 * is not a string/primitive change, is not semantic.
 */
export function isSemanticPatch(content: any, existing: any, fields: readonly string[]): boolean {
  if (!content || typeof content !== "object" || Array.isArray(content)) return false;
  if (!existing || typeof existing !== "object") return false;
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(content, field)) continue;
    if (content[field] !== existing[field]) return true;
  }
  return false;
}

/**
 * The response a PATCH returns when its stored-row READ FAILS (flair#1960 r3).
 *
 * A read ERROR is not the same as "no stored row" (a `null`/`undefined`
 * result). Both PATCH paths used to coalesce a thrown read into `null`; the
 * semantic predicate then returns `false` for `null`, and the patch falls
 * through to `super.patch()` as if it were a METADATA-ONLY write — which keeps
 * a legacy stored blob (including a caller-chosen `verified.timestamp`) in
 * place. Without the stored record there is no way to tell a semantic PATCH
 * from a metadata-only one, so the only safe outcome is to REFUSE the write
 * rather than fail open. 500: a server-side read fault, fail-closed.
 */
export function storedRowReadFailedResponse(table: "Memory" | "Relationship"): Response {
  return new Response(
    JSON.stringify({
      error: "stored_row_read_failed",
      message: `cannot read the stored ${table} row; refusing the write`,
    }),
    { status: 500, headers: { "content-type": "application/json" } },
  );
}
