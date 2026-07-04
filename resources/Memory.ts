import { databases } from "@harperfast/harper";
import { patchRecord, withDetachedTxn } from "./table-helpers.js";
import { isAdmin, resolveAgentAuth, allowVerified, type AgentAuthVerdict } from "./agent-auth.js";
import { getEmbedding, getModelId } from "./embeddings-provider.js";
import { scanFields, isStrictMode } from "./content-safety.js";
import { checkRateLimit, rateLimitResponse } from "./rate-limiter.js";
import {
  DEDUP_COSINE_THRESHOLD_DEFAULT,
  DEDUP_LEXICAL_THRESHOLD_DEFAULT,
  DEDUP_MIN_CONTENT_LENGTH,
  computeMatchConfidence,
  cosineSimilarity,
  isConservativeMatch,
  type DedupMatch,
} from "./dedup.js";

const FORBIDDEN = (msg: string) =>
  new Response(JSON.stringify({ error: msg }), { status: 403, headers: { "Content-Type": "application/json" } });
const UNAUTH = () =>
  new Response(JSON.stringify({ error: "authentication required" }), { status: 401, headers: { "Content-Type": "application/json" } });
const NOT_FOUND = () =>
  new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: { "Content-Type": "application/json" } });

/**
 * Owner ids a non-admin agent may READ: itself, plus any owner who has
 * granted it a "read" or "search" scoped MemoryGrant. Shared by search()
 * (collection scoping) and get() (per-id ownership check, memory-soul-read-
 * gate fix) so the two paths cannot drift apart — this was previously
 * computed inline only inside search().
 */
async function resolveAllowedOwners(authAgentId: string): Promise<string[]> {
  const allowedOwners: string[] = [authAgentId];
  try {
    for await (const grant of (databases as any).flair.MemoryGrant.search({
      conditions: [{ attribute: "granteeId", comparator: "equals", value: authAgentId }],
    })) {
      if (grant.ownerId && (grant.scope === "read" || grant.scope === "search")) {
        allowedOwners.push(grant.ownerId);
      }
    }
  } catch { /* MemoryGrant table not yet populated — ignore */ }
  return allowedOwners;
}

/**
 * ─── Server-side conservative-duplicate gate (memory-integrity fix) ──────────
 *
 * NEVER SUPPRESSES A WRITE. This gate only computes a SIGNAL — the caller
 * (Memory.post / Memory.put) always proceeds to write the new record. When a
 * conservative match is found, the signal is attached to the RESPONSE only
 * (deduplicated/matchedId/matchConfidence). There must be no code path where
 * finding a match causes the write to be skipped: that was the #526 bug (two
 * topically-close but DISTINCT findings — one about replication
 * route-directionality, one about DDL/schema replication — and the SECOND was
 * silently dropped because the old client-side gate returned the existing
 * record instead of writing).
 *
 * Conservative match = raw cosine >= cosineThreshold AND Jaccard token-overlap
 * >= lexicalThreshold, checked ONLY against the SINGLE top-cosine candidate
 * (scoped to the same agentId as the write — never cross-agent). If that one
 * candidate fails either gate, there is no match; we do not fall back to the
 * 2nd-most-similar candidate.
 *
 * Previously this lived client-side (packages/flair-client/src/client.ts,
 * pre-fix) and only ran for callers that opted into `dedup:true` over HTTP
 * PUT — the Model-2 /mcp handler (resources/mcp-tools.ts), which calls
 * Memory.post() directly, got ZERO dedup checking. Moving the gate here makes
 * it apply uniformly regardless of transport (HTTP PUT vs in-process post()).
 *
 * NOTE on HTTP verbs: the Memory schema only exposes PUT over HTTP (a raw
 * HTTP POST /Memory returns "Memory does not have a post method implemented"
 * — see src/cli.ts's `flair test` command and commit 2fa6d22 / ops-pj5).
 * `Memory.post()` IS reachable, but only via an in-process resource
 * instantiation (as resources/mcp-tools.ts does) — never via the real HTTP
 * POST route. Because flair-client's write() (used by flair-mcp, the CLI, and
 * every other integration package) issues an HTTP PUT, the actual
 * field-observed bug (#526) flows through Memory.put(), not Memory.post().
 * The gate below is therefore a SHARED helper invoked from both post() and
 * put() — anchored in the same place the design calls out (Memory.post), but
 * wired into put() too so the write path real callers actually use is
 * protected. See memory-integrity-fix report for the full writeup of this
 * deviation from a literal "gate lives only in Memory.post" reading.
 */
async function findConservativeDedupMatch(
  ctx: any,
  agentId: string | undefined,
  contentText: string,
  embedding: number[] | null | undefined,
  cosineThreshold: number,
  lexicalThreshold: number,
): Promise<DedupMatch | null> {
  if (!agentId || !embedding || embedding.length === 0) return null;
  try {
    const query: any = {
      sort: { attribute: "embedding", target: embedding, distance: "cosine" },
      conditions: [
        { attribute: "agentId", comparator: "equals", value: agentId },
        { attribute: "archived", comparator: "not_equal", value: true },
      ],
      select: ["id", "content", "$distance"],
      limit: 1,
    };
    let top: any = null;
    // Detach ctx.transaction around this search — same rationale as
    // Memory.search()/SemanticSearch.ts: a drained search generator can leave
    // a CLOSED transaction in ctx's chain that the subsequent WRITE
    // (super.post/super.put, right after this gate runs) would otherwise
    // inherit. Detaching here protects that write, not this read.
    const results = withDetachedTxn(ctx, () => (databases as any).flair.Memory.search(query));
    for await (const record of results) {
      top = record;
      break; // single top-cosine candidate only — never fall back further
    }
    if (!top) return null;

    // ─── ops-ume4: Harper's cosine-sort query omits $distance for a SINGLETON
    // result set ─────────────────────────────────────────────────────────────
    // Initial working theory was a per-agentId HNSW "cold-start" (first-ever
    // query cold, second query warm) and the initially-recommended fix was a
    // same-query retry. Empirically FALSIFIED: a plain retry of the identical
    // query, 8x with 300ms delays (2.4s total), never recovered a `$distance`
    // for a genuinely singleton candidate set (exactly one record matching
    // `agentId equals X AND archived not_equal true`). The actual trigger,
    // confirmed by direct probing: when this query's post-filter result set
    // has exactly ONE matching record, `$distance` comes back `undefined` for
    // it — regardless of how many prior queries have run for that agentId,
    // how long you wait, or how many other agentIds/records already exist in
    // the table. The moment a SECOND matching record exists, `$distance` is
    // populated correctly on the very first query ever issued for that
    // agentId — no warm-up needed. In practice the singleton case is exactly
    // an agent's SECOND-ever memory (compared against their first) — the most
    // common real-world trigger for this bug, and why it looked "permanent
    // per-agent for the first near-dup query."
    //
    // Also NOT a query-shape/conditions issue: the `{operator:"or"}` wrap
    // SemanticSearch.ts uses elsewhere is unrelated, and neither raising
    // `limit` past 1 nor changing the conditions shape changes the result —
    // confirmed empirically. Harper's SORT ordering is correct even in the
    // singleton case (the right record comes back as `top`); only the
    // numeric `$distance` annotation is missing. Also confirmed: selecting
    // "embedding" directly on THIS sort-by-embedding query does not help
    // either — it comes back as a bare scalar (Harper appears to special-case
    // the sort attribute in `select`), not the stored vector.
    //
    // Fix: when `$distance` is undefined, fetch the ONE candidate's full
    // record by id (a plain point lookup — not a vector-sort query, so
    // unaffected by the quirk above) and compute cosine similarity ourselves
    // in JS from its real stored `embedding` vector against this write's own
    // `embedding` (this function's parameter), via the same math Harper would
    // have used (dedup.ts's cosineSimilarity, Harper-free and unit-tested).
    // This sidesteps the underlying engine quirk entirely rather than
    // depending on its timing, and works identically whether this is the
    // agent's first query ever or its thousandth. Never suppresses the write
    // either way: if the candidate's embedding is somehow also missing (e.g.
    // a legacy record written before embeddings existed), `cosineSimilarity`
    // returns 0 — the same safe "no match" signal the pre-fix `?? 1`
    // fallback produced.
    let cosine: number;
    if (top.$distance !== undefined) {
      cosine = 1 - top.$distance;
    } else {
      console.error(
        "Memory.findConservativeDedupMatch: $distance undefined on a singleton cosine result (ops-ume4) — " +
        "falling back to a manual cosine computation from the candidate's stored embedding",
        { agentId, candidateId: top.id },
      );
      const fullCandidate = await withDetachedTxn(ctx, () => (databases as any).flair.Memory.get(top.id));
      const candidateEmbedding = Array.isArray(fullCandidate?.embedding) ? fullCandidate.embedding : [];
      cosine = cosineSimilarity(embedding, candidateEmbedding);
    }
    const confidence = computeMatchConfidence(contentText, top.content, cosine);
    if (!isConservativeMatch(confidence.cosine, confidence.lexical, cosineThreshold, lexicalThreshold)) {
      return null;
    }
    return { matchedId: top.id, cosine: confidence.cosine, lexical: confidence.lexical };
  } catch {
    // Dedup-check failures (embedding engine down, search error, etc.) must
    // NEVER block or alter the write — treat as "no match found".
    return null;
  }
}

/**
 * Run the dedup gate for a create-shaped write. Mutates `content.embedding` /
 * `content.embeddingModel` when it computes a fresh embedding, so the
 * existing "generate embedding if missing" step later in post()/put() reuses
 * it instead of recomputing. Always strips the client-forwarded hint fields
 * (dedup / dedupThreshold / lexicalThreshold) so they never persist onto the
 * stored record — they are passthrough tuning hints, not schema fields.
 *
 * Returns the match signal, or null (no match / gate not applicable).
 */
async function runDedupGate(ctx: any, content: any): Promise<DedupMatch | null> {
  const cosineThreshold = typeof content.dedupThreshold === "number" ? content.dedupThreshold : DEDUP_COSINE_THRESHOLD_DEFAULT;
  const lexicalThreshold = typeof content.lexicalThreshold === "number" ? content.lexicalThreshold : DEDUP_LEXICAL_THRESHOLD_DEFAULT;
  delete content.dedup;
  delete content.dedupThreshold;
  delete content.lexicalThreshold;

  if (typeof content.content !== "string" || content.content.length < DEDUP_MIN_CONTENT_LENGTH) {
    return null;
  }

  let embedding: number[] | null = Array.isArray(content.embedding) ? content.embedding : null;
  if (!embedding) {
    try {
      embedding = await getEmbedding(content.content);
    } catch {
      embedding = null;
    }
    if (embedding) {
      content.embedding = embedding;
      content.embeddingModel = getModelId();
    }
  }
  if (!embedding) return null;

  return findConservativeDedupMatch(ctx, content.agentId, content.content, embedding, cosineThreshold, lexicalThreshold);
}

/** Build the final write response: always `written: true`, always includes
 *  `id`, and layers the dedup collision signal on top when present. Never a
 *  code path where a match suppresses these base fields. */
function buildWriteResponse(content: any, result: any, dedupMatch: DedupMatch | null): any {
  const base = result && typeof result === "object" && !Array.isArray(result) ? result : {};
  const response: any = {
    id: content.id,
    ...base,
    written: true,
    deduplicated: !!dedupMatch,
  };
  if (dedupMatch) {
    response.matchedId = dedupMatch.matchedId;
    response.matchConfidence = { cosine: dedupMatch.cosine, lexical: dedupMatch.lexical };
  }
  return response;
}

/**
 * Read-modify-write close of a superseded record, with the SAME transaction
 * detachment discipline as findConservativeDedupMatch (each discrete Harper
 * call individually wrapped — see withDetachedTxn's doc for why a single
 * wrap around a multi-await async function would not protect the later
 * call). Does NOT swallow failures (ops-a4t5 fix) — throws so the caller can
 * log it. Never called before the new record is already written.
 */
async function closeSupersededRecord(ctx: any, oldId: string, patch: Record<string, unknown>): Promise<void> {
  const existing = await withDetachedTxn(ctx, () => (databases as any).flair.Memory.get(oldId));
  if (!existing) {
    throw new Error(`supersede-close: record ${oldId} not found`);
  }
  await withDetachedTxn(ctx, () => (databases as any).flair.Memory.put({ ...existing, ...patch }));
}

/** Does an agent hold a "write" grant from `ownerId`? Same MemoryGrant lookup
 *  pattern as Memory.search()/SemanticSearch.ts (read/search scopes) — reused
 *  here for the "write" scope that gates cross-agent supersede. */
async function hasWriteGrant(granteeId: string, ownerId: string): Promise<boolean> {
  try {
    for await (const grant of (databases as any).flair.MemoryGrant.search({
      conditions: [
        { attribute: "granteeId", comparator: "equals", value: granteeId },
        { attribute: "ownerId", comparator: "equals", value: ownerId },
      ],
    })) {
      if (grant.scope === "write") return true;
    }
  } catch {
    /* MemoryGrant table not yet populated — no grant */
  }
  return false;
}

/**
 * Shared by post() AND put(): the Memory schema only exposes a working HTTP
 * PUT route (a raw HTTP POST /Memory 404s with "Memory does not have a post
 * method implemented" — see src/cli.ts's `flair test` command / commit
 * 2fa6d22 / ops-pj5). Memory.post() IS reachable, but only via an in-process
 * resource instantiation (resources/mcp-tools.ts does this). Since
 * flair-client's write()/update() — used by flair-mcp, the CLI, and every
 * other integration package — issue HTTP PUT, `supersedes` must be fully
 * handled (validated, authorized, and closed) from BOTH entry points for the
 * real-world write path to actually get the fix, not just the in-process one.
 *
 * Validates the `supersedes` field's shape and, for a cross-agent supersede,
 * requires a "write" MemoryGrant from the target's owner (reuses the existing
 * agent-auth/grant machinery — no parallel auth logic). Returns a Response to
 * short-circuit with (400/403), or null to continue.
 */
async function validateAndAuthorizeSupersedes(content: any, auth: AgentAuthVerdict): Promise<Response | null> {
  if (content.supersedes !== undefined && typeof content.supersedes !== "string") {
    return new Response(JSON.stringify({ error: "supersedes must be a string (memory ID)" }), {
      status: 400, headers: { "Content-Type": "application/json" },
    });
  }
  if (content.supersedes && auth.kind === "agent" && !auth.isAdmin) {
    const target = await (databases as any).flair.Memory.get(content.supersedes).catch(() => null);
    if (target && target.agentId !== auth.agentId) {
      if (!(await hasWriteGrant(auth.agentId, target.agentId))) {
        return FORBIDDEN("forbidden: cannot supersede a memory owned by another agent without a write grant");
      }
    }
  }
  return null;
}

/**
 * Close the superseded record — called AFTER the new record has already been
 * written (write-new-BEFORE-close-old, ops-a4t5 fix). Safe failure state is
 * two active records (recoverable), never a tombstoned-old-with-lost-new.
 * Failure is logged (observable), never silently swallowed. No-op if
 * `content.supersedes` is not set.
 */
async function closeSupersededIfNeeded(ctx: any, content: any, methodLabel: "post" | "put"): Promise<void> {
  if (!content.supersedes) return;
  try {
    await closeSupersededRecord(ctx, content.supersedes, {
      validTo: content.validFrom ?? content.createdAt,
      updatedAt: content.createdAt ?? content.updatedAt,
    });
  } catch (err) {
    // Constant format string + structured data: memory ids are agent-controlled,
    // so interpolating them into console.error's format position (with a trailing
    // `err` arg) would let an id containing %s/%o consume/hide the real error
    // (semgrep unsafe-formatstring). Keep all dynamic values in the data object.
    console.error(
      "Memory.closeSuperseded: failed to close superseded record after writing new record " +
      "(ops-a4t5 — observable, not silent; new record is safely written, old record remains active until retried)",
      { method: methodLabel, supersededId: content.supersedes, newRecordId: content.id, err },
    );
  }
}

export class Memory extends (databases as any).flair.Memory {
  /**
   * Self-authorize now that the global gate is non-rejecting. Closes the P0
   * leak: Harper routes `GET /Memory/<id>` to get() and the collection
   * describe (`GET /Memory`) to a path outside search() — neither was gated
   * before this fix, so an anonymous caller got a 200 with full record
   * content / schema even though search() (and the write paths) correctly
   * 401/403'd. Per-record ownership/grant scoping happens in get() below;
   * the collection scope is still in search().
   *
   * allowCreate/allowUpdate/allowDelete are deliberately NOT added here:
   * post()/put()/delete() already self-enforce per-agent ownership inline
   * (resolveAgentAuth + explicit agentId checks in post()/put(), and the
   * isAdmin durability check in delete()). Adding allow* on top of that,
   * unverified, risks regressing owner writes/deletes on a P0 security fix
   * that is scoped to the read leak — left as-is on purpose.
   */
  allowRead() { return allowVerified((this as any).getContext?.()); }

  /**
   * Override get() to scope by-id reads the same way search() scopes
   * collection reads (memory-soul-read-gate fix). Never distinguishes
   * "doesn't exist" from "exists but not yours" — both return 404, never
   * 403, so a denied caller can't use get() to enumerate other agents'
   * memory ids.
   */
  async get(target?: any) {
    // Collection / query reads — the `GET /Memory/?<query>` form and the bare
    // collection — arrive as a RequestTarget with `isCollection === true`, and
    // are governed by search() (same owner/grant scoping). Only a genuine by-id
    // get is ownership-checked below. Without this guard, get() would receive
    // the query's RequestTarget, super.get() would return the (truthy) result
    // set, the single-record check would find no `.agentId` on it, and a valid
    // authenticated self-query would 404 (regression caught by the auth-
    // middleware e2e "TPS-Ed25519 on GET /Memory/?agentId=X → 200"). A by-id
    // get (RequestTarget with isCollection false, or a bare id) falls through.
    if (!target || (typeof target === "object" && target.isCollection)) {
      return this.search(target);
    }

    const ctx = (this as any).getContext?.();
    const auth = await resolveAgentAuth(ctx);

    // Anonymous by-id read is already blocked at the allowRead() gate (403);
    // this is defense-in-depth if get() is ever reached directly.
    if (auth.kind === "anonymous") {
      return NOT_FOUND();
    }

    // Trusted internal call or admin agent — unfiltered, unchanged behavior.
    if (auth.kind === "internal" || (auth.kind === "agent" && auth.isAdmin)) {
      return super.get(target);
    }

    // Non-admin agent: only its own memories, or an owner's memories it holds
    // a read/search MemoryGrant for (same owner-set as search() — shared
    // resolveAllowedOwners helper so the two paths cannot drift).
    const record = await super.get(target);
    if (!record) return NOT_FOUND();

    const allowedOwners = await resolveAllowedOwners(auth.agentId);
    if (!allowedOwners.includes(record.agentId)) return NOT_FOUND();

    return record;
  }

  /**
   * Override search() to scope collection GETs by authenticated agent.
   *
   * Security Critical: the agentId condition is wrapped as the outermost
   * `and` block so user-supplied query operators cannot bypass it via
   * boolean injection (e.g. [..., "or", { wildcard }]).
   *
   * Admin agents and unauthenticated internal calls pass through unfiltered.
   * Non-admin calls also check MemoryGrant to include granted memories.
   */
  async search(query?: any) {
    // Access request context via Harper's Resource instance context.
    const ctx = (this as any).getContext?.();
    const auth = await resolveAgentAuth(ctx);

    // Anonymous HTTP must NOT read memories. (Previously `!authAgent` was treated
    // as unfiltered — the anonymous-read leak once the gate stops rejecting.)
    if (auth.kind === "anonymous") {
      return new Response(JSON.stringify({ error: "authentication required" }), {
        status: 401, headers: { "content-type": "application/json" },
      });
    }

    // Trusted internal call (no request context) or admin agent — unfiltered.
    if (auth.kind === "internal" || (auth.kind === "agent" && auth.isAdmin)) {
      return super.search(query);
    }

    // Non-admin agent: scope to own + granted owners.
    const authAgent = auth.agentId;
    const allowedOwners = await resolveAllowedOwners(authAgent);

    // Build the agentId scope condition
    const agentIdCondition: any = allowedOwners.length === 1
      ? { attribute: "agentId", comparator: "equals", value: allowedOwners[0] }
      : { conditions: allowedOwners.map(id => ({ attribute: "agentId", comparator: "equals", value: id })), operator: "or" };

    // Harper passes `query` as a RequestTarget (extends URLSearchParams) or a
    // conditions array. For URL-based GET /Memory?... calls, URL params are no
    // longer translated to conditions here — callers should use
    // POST /Memory/search_by_conditions with an explicit conditions array.
    // For programmatic calls with a conditions array, we wrap with the agentId scope.
    if (query && typeof query === "object" && !Array.isArray(query)) {
      if (Array.isArray(query.conditions) && query.conditions.length > 0) {
        query.conditions = [agentIdCondition, ...query.conditions];
        return withDetachedTxn(ctx, () => super.search(query));
      }
      // Fallback: no conditions array present — just scope and pass through
    }

    // Fallback: plain array or no query (internal calls)
    const conditions = Array.isArray(query) && query.length > 0
      ? [agentIdCondition, ...query]
      : [agentIdCondition];
    return withDetachedTxn(ctx, () => super.search(conditions));
  }

  async post(content: any, context?: any) {
    // Rate limiting — use authenticated agent ID, not client-supplied body field
    const ctx = (this as any).getContext?.();
    const authenticatedAgent: string | undefined = ctx?.request?.tpsAgent;
    if (authenticatedAgent) {
      const rl = checkRateLimit(authenticatedAgent, "general");
      if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs!, "write");
    }

    // Create ownership: a non-admin agent may only write memories it owns. Use
    // resolveAgentAuth (reads the gate's tpsAgent annotation) — NOT context.user
    // .username, which is the fallback "admin" super_user while de-elevation is
    // dormant and would wrongly 403 every agent's own write. internal/admin → pass.
    let auth: AgentAuthVerdict;
    {
      auth = await resolveAgentAuth(ctx);
      // Anonymous HTTP must NOT write. Pre-flip the global gate rejected no-auth
      // upstream; with the non-rejecting gate, each write path self-enforces (same
      // rule search() applies to reads).
      if (auth.kind === "anonymous") {
        return UNAUTH();
      }
      if (auth.kind === "agent" && !auth.isAdmin && content?.agentId && content.agentId !== auth.agentId) {
        return FORBIDDEN("forbidden: cannot write memory owned by another agent");
      }
    }

    content.durability ||= "standard";
    content.createdAt = new Date().toISOString();
    content.updatedAt = content.createdAt;
    content.archived = content.archived ?? false;

    // Validate derivedFrom source IDs exist (best-effort, non-blocking)
    if (Array.isArray(content.derivedFrom) && content.derivedFrom.length > 0) {
      const now = content.createdAt;
      for (const sourceId of content.derivedFrom) {
        try {
          const src = await (databases as any).flair.Memory.get(sourceId);
          if (src) {
            patchRecord((databases as any).flair.Memory, sourceId, { lastReflected: now }).catch(() => {});
          }
        } catch {}
      }
    }

    // supersedes: optional reference to the ID of the memory this one
    // replaces. Validates shape + cross-agent-write authorization (shared
    // with put() — see validateAndAuthorizeSupersedes doc).
    const supersedesError = await validateAndAuthorizeSupersedes(content, auth);
    if (supersedesError) return supersedesError;

    // Temporal validity: validFrom defaults to now, validTo left null for active facts.
    if (!content.validFrom) {
      content.validFrom = content.createdAt;
    }

    if (content.durability === "ephemeral" && !content.expiresAt) {
      const ttlHours = Number(process.env.FLAIR_EPHEMERAL_TTL_HOURS || 24);
      content.expiresAt = new Date(Date.now() + ttlHours * 3600_000).toISOString();
    }

    // Content safety scan — covers content + summary (defense-in-depth for
    // agent-set summaries, ops-i2jb).
    if (content.content || content.summary) {
      const safety = scanFields(content, ["content", "summary"]);
      if (!safety.safe) {
        if (isStrictMode()) {
          return new Response(JSON.stringify({
            error: "content_safety_violation",
            flags: safety.flags,
            message: "Content flagged for potential prompt injection. Set FLAIR_CONTENT_SAFETY=warn to allow with tagging.",
          }), { status: 400, headers: { "Content-Type": "application/json" } });
        }
        content._safetyFlags = safety.flags;
      }
    }

    // Server-side conservative-duplicate gate (memory-integrity fix). A
    // supersede write is an intentional version-link, not an ambiguous "is
    // this a duplicate of something else" situation — bypass the gate for it
    // (this also gives memory_update's preserveHistory mode dedup-bypass for
    // free, without a separate flag). NEVER suppresses the write either way.
    let dedupMatch: DedupMatch | null = null;
    if (!content.supersedes) {
      dedupMatch = await runDedupGate(ctx, content);
    } else {
      delete content.dedup;
      delete content.dedupThreshold;
      delete content.lexicalThreshold;
    }

    // Generate embedding from content text (no-op if the dedup gate above
    // already computed one for this content).
    if (content.content && !content.embedding) {
      const vec = await getEmbedding(content.content);
      if (vec) { content.embedding = vec; content.embeddingModel = getModelId(); }
    }

    // ── Write the new record FIRST ──────────────────────────────────────────
    const result = await super.post(content);

    // ── THEN close the superseded record (ops-a4t5 fix) ─────────────────────
    // Write-new-BEFORE-close-old: the previous order (close-old via a fire-
    // and-forget `.catch(()=>{})` BEFORE the new write) could tombstone the
    // old record and then lose the new one if the write failed afterward.
    // Now the safe failure state is two active records (recoverable), never
    // a lost write — and the failure is logged, never silently swallowed.
    await closeSupersededIfNeeded(ctx, content, "post");

    return buildWriteResponse(content, result, dedupMatch);
  }

  async put(content: any) {
    // Reindex migration bypass: admin-only escape hatch used by the
    // MemoryReindex admin endpoint to re-PUT each existing record byte-for-byte
    // (no updatedAt bump, no embedding regen, no safety rescan) so Harper
    // repopulates secondary indices. Because this skips content safety and
    // auditability, it must be gated to admins. Internal calls (no auth
    // context) pass through, matching the pattern used in delete().
    if (content._reindex === true) {
      const ctx = (this as any).getContext?.();
      const request = ctx?.request ?? ctx;
      const actorId = request?.tpsAgent;
      if (actorId && !(await isAdmin(actorId))) {
        return new Response(JSON.stringify({ error: "reindex_admin_only" }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        });
      }
      delete content._reindex;
      return super.put(content);
    }

    // Create/update ownership (same rule as post): a non-admin agent may only
    // write memories it owns, via resolveAgentAuth (gate annotation), not
    // context.user.username (the dormant-de-elevation fallback is "admin").
    // The _reindex admin path above bypasses this.
    const ctx = (this as any).getContext?.();
    let auth: AgentAuthVerdict;
    {
      auth = await resolveAgentAuth(ctx);
      // Anonymous HTTP must NOT write (non-rejecting gate → self-enforce here).
      if (auth.kind === "anonymous") {
        return UNAUTH();
      }
      if (auth.kind === "agent" && !auth.isAdmin && content?.agentId && content.agentId !== auth.agentId) {
        return FORBIDDEN("forbidden: cannot write memory owned by another agent");
      }
    }

    const now = new Date().toISOString();
    content.updatedAt = now;
    // Set defaults that post() sets — put() is also used for new records via CLI
    content.archived = content.archived ?? false;
    content.createdAt = content.createdAt ?? now;

    // supersedes: optional reference to the ID of the memory this one
    // replaces. Validates shape + cross-agent-write authorization (shared
    // with post() — see validateAndAuthorizeSupersedes doc for why PUT needs
    // this too: it's the only HTTP-reachable create path).
    const supersedesError = await validateAndAuthorizeSupersedes(content, auth);
    if (supersedesError) return supersedesError;
    if (content.supersedes && !content.validFrom) {
      content.validFrom = content.createdAt;
    }

    // Content safety scan on updated content + summary (ops-i2jb).
    if (content.content || content.summary) {
      const safety = scanFields(content, ["content", "summary"]);
      if (!safety.safe) {
        if (isStrictMode()) {
          return new Response(JSON.stringify({
            error: "content_safety_violation",
            flags: safety.flags,
            message: "Content flagged for potential prompt injection.",
          }), { status: 400, headers: { "Content-Type": "application/json" } });
        }
        content._safetyFlags = safety.flags;
      } else {
        // Clear previous flags if both fields are now clean
        content._safetyFlags = null;
      }
    }

    // Server-side conservative-duplicate gate (memory-integrity fix). PUT is
    // an upsert: only run the gate for a FRESH create (target id does not yet
    // exist) that is NOT a supersede-link write. An update of an EXISTING id
    // (memory_update's default same-id overwrite path) is an intentional,
    // explicit overwrite, and a supersede-link write is an intentional
    // version-link — neither is an ambiguous "is this a duplicate of
    // something else" write, so both are dedup-bypassed automatically, no
    // separate flag needed. NEVER suppresses the write either way.
    let dedupMatch: DedupMatch | null = null;
    if (content.supersedes) {
      delete content.dedup;
      delete content.dedupThreshold;
      delete content.lexicalThreshold;
    } else if (content.id) {
      const preExisting = await (databases as any).flair.Memory.get(content.id).catch(() => null);
      if (!preExisting) {
        dedupMatch = await runDedupGate(ctx, content);
      } else {
        delete content.dedup;
        delete content.dedupThreshold;
        delete content.lexicalThreshold;
      }
    } else {
      dedupMatch = await runDedupGate(ctx, content);
    }

    // Re-generate embedding if content changed (no-op if the dedup gate above
    // already computed one for this content).
    if (content.content && !content.embedding) {
      const vec = await getEmbedding(content.content);
      if (vec) { content.embedding = vec; content.embeddingModel = getModelId(); }
    }

    // If archiving, record who + when
    if (content.archived === true && !content.archivedAt) {
      content.archivedAt = now;
      // archivedBy should be set by the caller (CLI stamps req.tpsAgent via query param)
    }

    // If approving promotion, record timestamp
    if (content.promotionStatus === "approved" && !content.promotedAt) {
      content.promotedAt = now;
    }

    // Upgrade to permanent when approved
    if (content.promotionStatus === "approved") {
      content.durability = "permanent";
    }

    // ── Write the new/updated record FIRST ──────────────────────────────────
    const result = await super.put(content);

    // ── THEN close the superseded record (ops-a4t5 fix; see post()) ────────
    await closeSupersededIfNeeded(ctx, content, "put");

    return buildWriteResponse(content, result, dedupMatch);
  }

  async delete(id: any) {
    // Use super.get(id), NOT this.get(id): the new get() override above 404s
    // (a truthy Response) for a non-owner/non-granted id, which would
    // otherwise short-circuit the `record.durability === "permanent"` check
    // below (a Response has no .durability) and silently bypass the
    // admin-only permanent-delete guard for cross-agent deletes. This keeps
    // delete()'s own pre-existing ownership/admin logic exactly as it was
    // before the read-gate fix — the read-scoping override must not leak
    // into delete()'s internal record lookup.
    const record = await super.get(id);
    if (!record) return super.delete(id);

    if (record.durability === "permanent") {
      // Middleware already guards this for non-admins, but belt-and-suspenders
      const ctx = (this as any).getContext?.();
      const request = ctx?.request ?? ctx;
      const actorId = request?.tpsAgent;
      if (actorId && !(await isAdmin(actorId))) {
        return new Response(JSON.stringify({ error: "permanent_memory_cannot_be_deleted_by_non_admin" }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    return super.delete(id);
  }
}
