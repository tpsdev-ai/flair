/**
 * POST /RecordUsage — the usage-feedback signal (flair#683).
 *
 * A generic "record that a memory was actually used" surface: an agent that
 * grounded an answer or decision on a recalled memory reports it here.
 * Distinct from — and NEVER wired to — retrieval: `Memory.retrievalCount`
 * (bumped on every SemanticSearch hit, resources/SemanticSearch.ts:~551) is
 * the WEAK, self-reinforcing signal root-caused in flair#623 ("a search hit
 * counted as usage"); `Memory.usageCount` (this endpoint's only writer) is
 * the STRONG signal driving `usageBoost` in resources/scoring.ts, which
 * REPLACES `retrievalBoost` in `compositeScore` outright (see that
 * function's doc).
 *
 * WHY THIS IS ITS OWN ENDPOINT, NOT `Memory.put()` (Sherlock, K&S verdict —
 * FLAIR-USAGE-FEEDBACK-SIGNAL.md): usage feedback is fundamentally a
 * CROSS-AGENT write — agent B reports using agent A's memory, so the write
 * target is A's record, not B's own. `Memory.put()`'s ownership check
 * (resources/Memory.ts: "a non-admin agent may only write memories it
 * owns") would 403 every single legitimate call. Bypassing that check
 * instead would open the door to modifying ANY field on another agent's
 * memory through this surface — not just the count. So this endpoint does
 * the narrowest possible thing instead: a TARGETED `usageCount`-only
 * bump (read-full-record, merge just this one field, write — see
 * _recordOne() below) against the RAW `Memory` table object, entirely
 * bypassing the `Memory` RESOURCE class (and its ownership gate) — its own
 * auth model is verified-agent + within-org + explicitly NO ownership
 * requirement.
 *
 * WHY THIS ISN'T A @table-BACKED RESOURCE: the actual dedup ledger (one row
 * per (agentId, memoryId) contribution) lives in the `MemoryUsage` table
 * (schemas/memory.graphql), guarded by resources/MemoryUsage.ts. But this
 * endpoint's whole shape is "POST a list of ids that got used" — and Harper's
 * base TableResource has no default `post()` implementation for a
 * static-style raw-table call outside an `isCollection`-instantiated
 * resource (confirmed live: `databases.flair.MemoryUsage.post(...)` throws
 * "The MemoryUsage does not have a post method implemented", HTTP 405 — the
 * SAME class of gotcha resources/Memory.ts documents for a raw HTTP POST to
 * `/Memory`, but here it bites even an in-process call). So the ledger row
 * itself is written via `.put()` (upsert with the deterministic composite
 * id — see _recordOne()), and this endpoint's OWN HTTP surface lives on a
 * plain action `Resource` (same shape as resources/MemoryReflect.ts /
 * resources/SemanticSearch.ts) rather than extending a @table class, so POST
 * actually routes here. It talks to BOTH `Memory` and `MemoryUsage` via
 * their raw table objects (bypassing each resource class's own auth
 * wrapper — the same "call the other table directly" pattern
 * resources/Memory.ts already uses for `MemoryGrant` in hasWriteGrant()).
 *
 * ANTI-GAMING (Sherlock): usage feedback is a write that affects RANKING —
 * an abuse surface (inflate usageCount to boost a memory). Three-layer
 * defense:
 *   1. Rate limiter — a ~30 RPM bucket per agent (resources/rate-limiter.ts,
 *      "usage" bucket), same shape as every other write path here.
 *   2. Dedup bound — each (agentId, memoryId) pair contributes AT MOST 1 to
 *      usageCount, enforced by the MemoryUsage ledger (a fresh ledger row
 *      required before any increment; a repeat call is a silent no-op).
 *   3. The capped, floor-gated `usageBoost` itself (resources/scoring.ts) —
 *      even a fully-gamed usageCount can only nudge a score by +10% above
 *      the relevance floor; it's a tie-breaker, never an override. Sybil
 *      (many distinct agent identities) has a bounded blast radius per
 *      identity, and Ed25519-verified identity isn't free to mint at scale.
 *
 * NO ID ENUMERATION (Sherlock): the response is IDENTICAL — `{ recorded:
 * true }` — for every syntactically-valid input, regardless of whether a
 * given id was a fresh increment, an already-counted no-op (this agent
 * already contributed), or a not-found no-op (no such memory). A caller
 * cannot distinguish "that id doesn't exist" from "you already used it" by
 * inspecting the response; per-id/per-batch success is deliberately never
 * reported (see RECORDED_RESPONSE's doc below for why even partial-batch
 * counts would leak information).
 *
 * ATTRIBUTION is OPAQUE (Sherlock): an optional free-text hint about what
 * used the memory. Never parsed, never fed to an LLM, never rendered —
 * sanitized (control-character-stripped, length-capped) and stored as-is,
 * for audit/analytics only. Treat it as untrusted data, always.
 */
import { Resource, databases } from "@harperfast/harper";
import { resolveAgentAuth } from "./agent-auth.js";
import { checkRateLimit, rateLimitResponse } from "./rate-limiter.js";
import { withDetachedTxn } from "./table-helpers.js";

const UNAUTH = () =>
  new Response(JSON.stringify({ error: "authentication required" }), { status: 401, headers: { "Content-Type": "application/json" } });
const BAD_REQUEST = (msg: string) =>
  new Response(JSON.stringify({ error: msg }), { status: 400, headers: { "Content-Type": "application/json" } });

const MAX_IDS_PER_CALL = 20;
const MAX_ATTRIBUTION_LENGTH = 500;

/**
 * Strip control/non-printable characters and cap length. Attribution is
 * OPAQUE (module doc) — this is baseline hygiene against a caller smuggling
 * something (terminal escapes, a giant blob) into stored data, not content
 * moderation or safety scanning (content-safety.ts's scanContent() is for
 * memory CONTENT that gets injected into agent context via bootstrap;
 * attribution is never surfaced that way, so that scanner doesn't apply
 * here — deliberately a separate, narrower sanitizer).
 */
function sanitizeAttribution(raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  const cleaned = raw
    .replace(/[\x00-\x1F\x7F-\x9F]/g, " ") // strip C0/C1 control chars
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return undefined;
  return cleaned.slice(0, MAX_ATTRIBUTION_LENGTH);
}

/**
 * The INVARIANT response for any syntactically-valid request, regardless of
 * outcome (fresh increment / already-counted / not-found — see module doc's
 * "NO ID ENUMERATION"). Deliberately does not report per-id or even
 * aggregate success counts: for a batch of N ids where one is fake, a
 * response like `{ recorded: 4, of: 5 }` would let a caller binary-search
 * which id in a batch doesn't exist just as surely as a per-id breakdown
 * would. The only externally observable state change is the actual
 * `usageCount` on a memory the caller is independently authorized to READ
 * (via Memory.get/search/SemanticSearch) — a SEPARATE, already-scoped call,
 * never this endpoint.
 */
const RECORDED_RESPONSE = { recorded: true };

export class RecordUsage extends Resource {
  // Any verified agent may report usage — any further scoping (which memory,
  // whether it's a dup) is enforced inside post() itself, never here.
  async allowCreate(): Promise<boolean> {
    return (await resolveAgentAuth((this as any).getContext?.())).kind !== "anonymous";
  }

  async post(data: any) {
    const ctx = (this as any).getContext?.();
    const auth = await resolveAgentAuth(ctx);
    if (auth.kind === "anonymous") return UNAUTH();

    // Usage feedback attributes a contribution to a SPECIFIC agent identity
    // (the MemoryUsage ledger's dedup key) — a trusted internal call with no
    // per-agent identity, or an admin acting with no agent context, has
    // nothing to attribute a contribution TO. Agent-facing only.
    if (auth.kind !== "agent") {
      return BAD_REQUEST("usage feedback requires a verified agent identity");
    }
    const agentId = auth.agentId;

    const rl = checkRateLimit(agentId, "usage");
    if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs!, "usage");

    const rawIds: unknown = data?.memoryIds ?? (typeof data?.memoryId === "string" ? [data.memoryId] : undefined);
    if (!Array.isArray(rawIds) || rawIds.length === 0 || !rawIds.every((id) => typeof id === "string" && id.length > 0)) {
      return BAD_REQUEST("memoryIds must be a non-empty array of memory id strings");
    }
    if (rawIds.length > MAX_IDS_PER_CALL) {
      return BAD_REQUEST(`memoryIds exceeds the per-call limit of ${MAX_IDS_PER_CALL}`);
    }
    const memoryIds = [...new Set(rawIds as string[])]; // dedupe within THIS call too

    const attribution = sanitizeAttribution(data?.attribution);
    const now = new Date().toISOString();

    for (const memoryId of memoryIds) {
      try {
        await this._recordOne(ctx, agentId, memoryId, attribution, now);
      } catch (err) {
        // Never let one bad id fail the whole batch, and never let an
        // internal error leak existence information either — log
        // server-side, collapse to the same no-op the response already
        // returns for every other outcome.
        console.error("RecordUsage.post: failed to record usage (treated as no-op)", { memoryId, err });
      }
    }

    // Deliberately does NOT report which ids succeeded / were already
    // counted / were not found — see RECORDED_RESPONSE's doc.
    return RECORDED_RESPONSE;
  }

  /**
   * One (agentId, memoryId) contribution.
   *
   * Ledger-row-create FIRST, THEN the Memory.usageCount bump — so a crash
   * between the two leaves the SAFE failure state (ledger row exists, count
   * not yet bumped: a later retry just re-checks and no-ops) rather than the
   * reverse (count bumped, no ledger row → a retry would double-count).
   *
   * Every discrete Harper call is wrapped INDIVIDUALLY in its own
   * withDetachedTxn — never one wrap around a multi-step helper. A request
   * that reads/writes MULTIPLE tables (or the same table twice) in sequence
   * can otherwise inherit a closed transaction from a prior call's drained
   * chain (table-helpers.ts's withDetachedTxn doc); resources/Memory.ts's
   * closeSupersededRecord documents exactly why a single wrap around a
   * multi-await async function does NOT protect a later call inside it —
   * this mirrors that function's literal shape (get wrapped, then a
   * SEPARATE put wrapped) rather than delegating to the generic
   * patchRecord() helper, which would combine both into one un-safe wrap.
   *
   * The final get-then-put for the increment is a best-effort (non-atomic)
   * read-modify-write, same class of race already accepted elsewhere in
   * this codebase for count fields (e.g. retrievalCount's bump in
   * SemanticSearch.ts) — a concurrent contribution from a DIFFERENT agent
   * landing between this call's read and write could lose one increment.
   * Re-fetching immediately before the write (rather than reusing the
   * earlier existence-check read) narrows, without eliminating, that
   * window. Not solved here: bounded, low-severity (an undercount, never an
   * inflation), and orthogonal to the anti-gaming properties the cap/floor
   * and dedup ledger actually defend.
   */
  private async _recordOne(
    ctx: any,
    agentId: string,
    memoryId: string,
    attribution: string | undefined,
    now: string,
  ): Promise<void> {
    const ledgerId = `${agentId}:${memoryId}`;

    // Bypasses resources/MemoryUsage.ts's own auth wrapper by design — this
    // IS the trusted internal caller that resource's module doc describes
    // (same "raw table object" pattern resources/Memory.ts uses for
    // MemoryGrant).
    const existingContribution = await withDetachedTxn(ctx, () =>
      (databases as any).flair.MemoryUsage.get(ledgerId),
    ).catch(() => null);
    if (existingContribution) return; // already counted by this agent — silent no-op

    const memoryExists = await withDetachedTxn(ctx, () => (databases as any).flair.Memory.get(memoryId)).catch(() => null);
    if (!memoryExists) return; // no such memory — silent no-op (no enumeration)

    const ledgerRecord: Record<string, unknown> = { id: ledgerId, agentId, memoryId, createdAt: now };
    if (attribution) ledgerRecord.attribution = attribution;
    // .put(), not .post(): Harper's raw TableResource has no default post()
    // implementation for a static-style (non-`isCollection`-instantiated)
    // call — confirmed live ("The MemoryUsage does not have a post method
    // implemented", statusCode 405) — the SAME class of gotcha
    // resources/Memory.ts documents for HTTP POST, but here it bites even
    // this in-process call. Irrelevant anyway: ledgerId is already a
    // deterministic composite key, so this is a create-with-explicit-id —
    // exactly what PUT (upsert) is for, not an auto-generated-id insert.
    await withDetachedTxn(ctx, () => (databases as any).flair.MemoryUsage.put(ledgerRecord));

    // Targeted usageCount-ONLY bump: read-full-record, merge just this one
    // field, write — against the RAW Memory table, NEVER Memory.put() (the
    // resource class): that would 403 this cross-agent write via its
    // ownership check, and bypassing that check directly would risk letting
    // this endpoint smuggle OTHER field changes through instead of just the
    // count (module doc's "WHY THIS IS ITS OWN ENDPOINT").
    const fresh = await withDetachedTxn(ctx, () => (databases as any).flair.Memory.get(memoryId)).catch(() => null);
    if (!fresh) return; // deleted between the checks above and now — no-op
    await withDetachedTxn(ctx, () =>
      (databases as any).flair.Memory.put({ ...fresh, usageCount: (fresh.usageCount ?? 0) + 1 }),
    );
  }
}
