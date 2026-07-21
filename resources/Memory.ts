import { databases } from "@harperfast/harper";
import { patchRecord, withDetachedTxn } from "./table-helpers.js";
import { isAdmin, resolveAgentAuth, type AgentAuthVerdict } from "./agent-auth.js";
import { localInstanceId } from "./instance-identity.js";
import { getEmbedding, getModelId } from "./embeddings-provider.js";
import { scanFields, isStrictMode } from "./content-safety.js";
import { invalidEntitiesResponse } from "./entity-vocab.js";
import { checkRateLimit, rateLimitResponse } from "./rate-limiter.js";
import { resolveAllowedOwners } from "./memory-read-scope.js";
import {
  DEDUP_COSINE_THRESHOLD_DEFAULT,
  DEDUP_LEXICAL_THRESHOLD_DEFAULT,
  DEDUP_MIN_CONTENT_LENGTH,
  computeMatchConfidence,
  cosineSimilarity,
  isConservativeMatch,
  type DedupMatch,
} from "./dedup.js";
import {
  buildProvenance,
  makeAuthGate,
  makeReadScope,
  makeByIdReadGate,
  resolveAuthGate,
  stampAttribution,
  FORBIDDEN,
  UNAUTH,
} from "./record-type-kit.js";
import { RECORD_TYPES } from "./record-types.js";
import { attachTrust } from "./trust-block.js";
import { recordCitations } from "./usage-recording.js";

/**
 * flair#744 slice 1 — read the opt-in `includeTrust` flag for a by-id get.
 * Two entry shapes: an in-process caller (resources/mcp-tools.ts's memory_get)
 * passes it explicitly via the `opts` arg; an HTTP `GET /Memory/<id>?includeTrust=true`
 * carries it as a query param on the RequestTarget. Defensive across the
 * RequestTarget/URLSearchParams shapes Harper may hand us; anything other than
 * a literal "true" reads as off, so the default response stays byte-identical.
 */
function wantsTrust(target: any, opts: { includeTrust?: boolean } | undefined): boolean {
  if (opts?.includeTrust === true) return true;
  const raw =
    target?.get?.("includeTrust") ??
    target?.searchParams?.get?.("includeTrust") ??
    undefined;
  return raw === "true" || raw === true;
}

/**
 * Owner ids a non-admin agent may READ (resolveAllowedOwners) live in
 * ./memory-read-scope.ts — still exported/used elsewhere (admin tooling).
 * The full read-scope condition + private-exclusion predicate is now
 * consumed through ./record-type-kit.ts's makeReadScope(), parameterized
 * from RECORD_TYPES.Memory (record-types slice 2, flair#520) rather than a
 * hand-typed "open-within-org" literal — the registry is now the single
 * source of truth this class draws its read-scope mode from. makeReadScope
 * delegates "open-within-org" to ./memory-read-scope.ts's resolveReadScope()
 * UNCHANGED — the ONE centralized helper every cross-agent Memory read path
 * (search()/get() here, SemanticSearch.ts, MemoryBootstrap.ts, auth-
 * middleware.ts's by-id guard) resolves its scope through, so the scoping
 * rule cannot drift per-path again (a SemanticSearch inline
 * `visibility === "office"` OR-clause leaked office memories to any
 * authenticated agent because the rule had scattered). See memory-read-
 * scope.ts's doc for the migration invariant (no-visibility-field reads as
 * "shared", never "private").
 *
 * Exported (not just a module-local const) solely so
 * test/unit/record-types-registry.test.ts's drift tripwire can introspect
 * the composed resolver's tagged `.mode`/`.ownerField` (see makeReadScope's
 * doc in record-type-kit.ts) against RECORD_TYPES.Memory — not for any
 * other runtime consumer.
 */
export const memoryReadScope = makeReadScope(RECORD_TYPES.Memory.readScope, RECORD_TYPES.Memory.ownerField);
const memoryByIdReadGate = makeByIdReadGate(memoryReadScope);
// See makeAuthGate's doc (record-type-kit.ts): must be wired as a genuine
// prototype method below, never a class-field assignment — Harper's
// relationship-traversal RBAC path reads allowRead off the prototype.
const memoryAuthGate = makeAuthGate();

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

    // ─── Harper's cosine-sort query omits $distance for a SINGLETON
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
        "Memory.findConservativeDedupMatch: $distance undefined on a singleton cosine result — " +
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

  // flair#504 Phase 2: 'document' — this embedding IS the stored vector (the
  // "generate embedding if missing" step in post()/put() below reuses
  // whatever this computes), so it MUST use the same inputType as every
  // other document-write site or dedup's cosine compare would cross prefixed
  // and unprefixed spaces. All three Memory doc sites (here, post(), put())
  // move together in one commit for exactly that reason — see
  // embeddings-provider.ts's file header for why the VALUE must be the
  // literal 'document', never the prefix string.
  //
  // Dedup-during-transition transient (documented per Kern's review, not a
  // bug to fix here): mid stage-2 re-embed, a NEW write embeds 'document'
  // (prefixed) but may compare against an OLDER stored vector that hasn't
  // been re-embedded yet (unprefixed) — cross-space cosine, so dedup can
  // miss a near-duplicate during that window. Bounded (the re-embed pass is
  // batched and finishes in minutes), self-healing once the pass completes,
  // and a missed dedup is a duplicate row, not data loss — quality, not
  // correctness. Stage 1 (this PR) doesn't trigger this at all: no re-embed
  // runs, so there's no mixed-space window until stage 2's separate,
  // deliberate ops step.
  let embedding: number[] | null = Array.isArray(content.embedding) ? content.embedding : null;
  if (!embedding) {
    try {
      embedding = await getEmbedding(content.content, "document");
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
 * call). Does NOT swallow failures — throws so the caller can
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
 *
 * flair#704: an explicit `supersedes: null` — the shape most JSON writers
 * produce for an unset optional field (`JSON.stringify({supersedes: undefined})`
 * drops the key, but plenty of writers instead do `{supersedes: x ?? null}`)
 * — must be treated identically to the key being OMITTED, per the
 * additive-schema convention (flair#695: an explicit null on an
 * optional/nullable field reads as absent, not as a distinct value). Fixed by
 * deleting the key BEFORE the type check below, so (a) the check never
 * rejects it, and (b) `super.put()`/`super.post()` — Harper full-record
 * replacement, see table-helpers.ts's header comment — never persists a
 * literal `null` where "absent" was intended: the stored row ends up
 * byte-for-byte identical to the omitted-key case, so every downstream
 * `!content.supersedes` / `content.supersedes &&` check below (and in
 * closeSupersededIfNeeded) already treats it as unset with no further
 * changes needed.
 */
async function validateAndAuthorizeSupersedes(content: any, auth: AgentAuthVerdict): Promise<Response | null> {
  if (content.supersedes === null) {
    delete content.supersedes;
  }
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
 * written (write-new-BEFORE-close-old). Safe failure state is
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
      "(observable, not silent; new record is safely written, old record remains active until retried)",
      { method: methodLabel, supersededId: content.supersedes, newRecordId: content.id, err },
    );
  }
}

/**
 * ─── Durability-keyed default visibility (Layer 1, part A) ─────────────────
 *
 * Writer intent: an explicit `visibility` on the write ALWAYS overrides this
 * (callers check `content.visibility == null` before calling this). When
 * unset, the default is keyed off durability — a durable write (the agent
 * chose to make this stick around) defaults to shared; anything else
 * defaults to private. "absent" durability (not yet defaulted by the caller)
 * falls into the private branch, matching the spec's
 * "standard|ephemeral|absent → private".
 */
function defaultVisibilityForDurability(durability: unknown): "private" | "shared" {
  return durability === "permanent" || durability === "persistent" ? "shared" : "private";
}

/**
 * ─── Write-time provenance stamp (memory-provenance slice 1) ────────────────
 *
 * `buildProvenance` itself lives in ./provenance.ts, re-exported unmodified
 * via ./record-type-kit.ts (imported above) for a single kit import surface —
 * extracted so resources/Relationship.ts's write path can reuse the EXACT
 * same `{v, verified, claimed?}` shape (the relationship-write-path spec's
 * "reuse buildProvenance as-is" contract) instead of a hand-copied format
 * that could drift. See that module for the full field-by-field rationale
 * (verified.agentId from the auth verdict never the body, verified.timestamp
 * = the server-computed createdAt, optional unverified claimed.model /
 * claimed.client passthroughs — the latter added by flair#718 authorship-
 * provenance). Deliberately NOT implemented in this slice: a
 * context-fingerprint field — bootstrap doesn't return the IDs a fingerprint
 * would need, so it requires client cooperation that's out of scope here.
 */

/**
 * ─── Write-time originatorInstanceId stamp (federation-edge-hardening slice 1) ──
 *
 * Stamps this instance's own federation identity (resources/instance-
 * identity.ts's localInstanceId(), cached — never a DB read per write) onto
 * every LOCAL write. Deliberately a no-op when `content.originatorInstanceId`
 * already carries a non-null value: this is the anti-clobber rule that keeps
 * a federation-synced record's true origin intact.
 *
 * Why this can never clobber a synced record: FederationSync.post()
 * (resources/Federation.ts) merges incoming records via the RAW table object
 * (`(databases as any).flair.Memory.put(mergedData)`) — Harper's static
 * table-level put, not this Resource subclass's instance put() below. The
 * merge path never runs this function at all, so a record arriving from
 * instance B keeps whatever `originatorInstanceId` it already carried in
 * `mergedData` (that instance's own write-time stamp, carried through in the
 * synced row) with no risk of this instance overwriting it with its own id.
 * The `content.originatorInstanceId == null` guard below is still applied —
 * defense-in-depth for any future path that might route a synced payload
 * through this class's post()/put() — so the invariant holds even if that
 * assumption ever changes.
 *
 * `localInstanceId()` resolves to null on an instance that has never been
 * federation-bootstrapped (no Instance row yet) — the field is nullable by
 * design, so this stamps null rather than inventing an id.
 */
async function stampOriginatorInstanceId(content: any): Promise<void> {
  if (content.originatorInstanceId == null) {
    content.originatorInstanceId = await localInstanceId();
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
  allowRead() { return memoryAuthGate.call(this); }

  /**
   * Override get() to scope by-id reads the same way search() scopes
   * collection reads (memory-soul-read-gate fix). Never distinguishes
   * "doesn't exist" from "exists but not yours" — both return 404, never
   * 403, so a denied caller can't use get() to enumerate other agents'
   * memory ids. Wired through record-type-kit.ts's makeByIdReadGate, scoped
   * with Memory's own "open-within-org" read-scope resolver above — same
   * dispatch shape Relationship.ts/WorkspaceState.ts's get() overrides use.
   */
  async get(target?: any, opts?: { includeTrust?: boolean }) {
    // Collection / query reads — the `GET /Memory/?<query>` form and the bare
    // collection — arrive as a RequestTarget with `isCollection === true`, and
    // are governed by search() (same owner/grant scoping). Only a genuine by-id
    // get is ownership-checked below. Without this guard, get() would receive
    // the query's RequestTarget, super.get() would return the (truthy) result
    // set, the single-record check would find no `.agentId` on it, and a valid
    // authenticated self-query would 404 (regression caught by the auth-
    // middleware e2e "TPS-Ed25519 on GET /Memory/?agentId=X → 200"). A by-id
    // get (RequestTarget with isCollection false, or a bare id) falls through.
    // makeByIdReadGate re-applies this same guard internally (delegating to
    // this.search via `.call(this, ...)`) — kept here too as documentation of
    // the invariant at the call site, harmless no-op double-check. The trust
    // block (flair#744) is NOT attached on the collection path — that routes to
    // search(), which is out of this slice's by-id `get` surface.
    if (!target || (typeof target === "object" && target.isCollection)) {
      return this.search(target);
    }
    const result = await memoryByIdReadGate.call(this, target, (t: any) => super.get(t));
    // flair#744 slice 1 — opt-in inline trust-evidence block, attached ONLY to
    // a genuine by-id record (never a NOT_FOUND `Response`, never null), and
    // ONLY after the ownership/read-scope gate above has already resolved. The
    // block informs the reader; it never re-enters an authority decision
    // (#735-spirit zero-authority invariant). Default OFF ⇒ the record is
    // returned untouched (attachTrust returns the same reference) ⇒
    // byte-identical to pre-slice-1.
    if (result && typeof result === "object" && !(result instanceof Response) && typeof (result as any).agentId === "string") {
      return attachTrust(result as any, wantsTrust(target, opts));
    }
    return result;
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

    // Anonymous HTTP must NOT read memories. (Previously `!authAgent` was treated
    // as unfiltered — the anonymous-read leak once the gate stops rejecting.)
    // Trusted internal call (no request context) or admin agent — unfiltered.
    // Non-admin agent: scoped below. Dispatch shape shared via
    // record-type-kit.ts's resolveAuthGate — same three-way branch
    // Relationship.ts/WorkspaceState.ts's search() use.
    const gate = await resolveAuthGate(ctx, UNAUTH());
    if (gate.kind === "denied") return gate.response;
    if (gate.kind === "unfiltered") return super.search(query);

    // Non-admin agent: scope to own (any visibility) + granted owners' SHARED
    // memories only (Layer 1 private-exclusion). Centralized in
    // memoryReadScope (record-type-kit.ts's makeReadScope(), parameterized
    // from RECORD_TYPES.Memory — see this file's header — delegating
    // "open-within-org" to memory-read-scope.ts's resolveReadScope()
    // unchanged) so get() above and search() here cannot drift.
    const scope = await memoryReadScope(gate.agentId);
    const agentIdCondition: any = scope.condition;

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
      // No-forge attribution — mode/field drawn from RECORD_TYPES.Memory
      // (record-types slice 2, flair#520) rather than a hand-typed literal.
      // "validate-truthy" (see record-type-kit.ts's stampAttribution doc):
      // reject a PRESENT, mismatched agentId; never stamp when absent (the
      // caller is expected to have set it).
      const attr = stampAttribution(auth, content, RECORD_TYPES.Memory.ownerField, RECORD_TYPES.Memory.attribution.post, "forbidden: cannot write memory owned by another agent");
      if (attr.denied) return attr.denied;
    }

    // flair#744 slice A: citation-on-write — consume-and-strip, same
    // discipline as `claimedClient` below. Pull the optional
    // `usedMemoryIds` off the write body now, BEFORE anything else touches
    // `content`, so it is NEVER persisted on the Memory record itself.
    // Recording happens POST-COMMIT, only when this was present (see the
    // failure-isolated recordCitations() call near the return below) —
    // omitted ⇒ `undefined` ⇒ zero new calls, byte-identical behavior.
    const usedMemoryIds = content?.usedMemoryIds;
    if (content && typeof content === "object") delete content.usedMemoryIds;

    content.durability ||= "standard";
    content.createdAt = new Date().toISOString();
    content.updatedAt = content.createdAt;
    content.archived = content.archived ?? false;

    // ─── Default visibility (durability-keyed) — Layer 1, part A ────────────
    // post() only ever creates a NEW record — patchRecord/supersede-close/
    // retrievalCount bumps all route through put() instead (see put()'s
    // pre-existing-record guard below), so there is no "don't overwrite an
    // existing record's visibility" concern here. Explicit visibility on the
    // write ALWAYS overrides; only stamp the default when the caller left it
    // unset. permanent|persistent → shared; standard|ephemeral|absent → private.
    if (content.visibility === undefined || content.visibility === null) {
      content.visibility = defaultVisibilityForDurability(content.durability);
    }

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

    // attention-plane vocabulary gate (flair#675): `entities`, if present,
    // must be well-formed vocabulary strings — see resources/entity-vocab.ts.
    // Field is additive/optional (v1 schema-only; no auto-derivation here —
    // that producer is a follow-up); absent entities is not an error.
    const entitiesError = invalidEntitiesResponse(content.entities);
    if (entitiesError) return entitiesError;

    if (content.durability === "ephemeral" && !content.expiresAt) {
      const ttlHours = Number(process.env.FLAIR_EPHEMERAL_TTL_HOURS || 24);
      content.expiresAt = new Date(Date.now() + ttlHours * 3600_000).toISOString();
    }

    // Content safety scan — covers content + summary (defense-in-depth for
    // agent-set summaries).
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
    // already computed one for this content). flair#504 Phase 2: 'document'
    // — see runDedupGate's comment above for why all three Memory doc sites
    // must move together.
    if (content.content && !content.embedding) {
      const vec = await getEmbedding(content.content, "document");
      if (vec) { content.embedding = vec; content.embeddingModel = getModelId(); }
    }

    // Write-time provenance stamp (memory-provenance slice 1) — see
    // buildProvenance's doc above. Stamped last, right before persist, so it
    // reflects the final resolved `content.createdAt`.
    content.provenance = buildProvenance(auth, content.createdAt, content);
    // flair#718 authorship-provenance: `claimedClient` is a WRITE-BODY-ONLY
    // passthrough — buildProvenance above already folded it into
    // `provenance.claimed.client` (sanitized/capped). Strip it from the row
    // itself so it is NEVER persisted as a second, undeclared/unsanitized
    // top-level field — authorship lives in the provenance JSON only.
    delete content.claimedClient;

    // Write-time originatorInstanceId stamp (federation-edge-hardening slice
    // 1) — see stampOriginatorInstanceId's doc above. No-op if already set
    // (never fires for a genuine local write — no client sets this field).
    await stampOriginatorInstanceId(content);

    // ── Write the new record FIRST ──────────────────────────────────────────
    const result = await super.post(content);

    // ── THEN close the superseded record ────────────────────────────────────
    // Write-new-BEFORE-close-old: the previous order (close-old via a fire-
    // and-forget `.catch(()=>{})` BEFORE the new write) could tombstone the
    // old record and then lose the new one if the write failed afterward.
    // Now the safe failure state is two active records (recoverable), never
    // a lost write — and the failure is logged, never silently swallowed.
    await closeSupersededIfNeeded(ctx, content, "post");

    // flair#744 slice A: citation-on-write — POST-COMMIT, fully
    // failure-isolated. The write above already succeeded and `result` is
    // final; crediting each cited memory through the shared usage ledger
    // (same path as POST /RecordUsage) must never affect this response —
    // any failure here is logged server-side and swallowed, never surfaced
    // to the caller, never rolls back or retries the write.
    if (usedMemoryIds !== undefined) {
      try {
        await recordCitations(ctx, auth, usedMemoryIds, new Date().toISOString());
      } catch (err) {
        console.error("Memory.post: citation recording failed (write already committed)", err);
      }
    }

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
      // No-forge attribution — mode/field drawn from RECORD_TYPES.Memory,
      // same rule as post(). "validate-truthy" (see record-type-kit.ts's
      // stampAttribution doc).
      const attr = stampAttribution(auth, content, RECORD_TYPES.Memory.ownerField, RECORD_TYPES.Memory.attribution.put, "forbidden: cannot write memory owned by another agent");
      if (attr.denied) return attr.denied;
    }

    // flair#744 slice A: citation-on-write — same consume-and-strip
    // discipline as post() above. Strip BEFORE anything else touches
    // `content` so it is never persisted on the row; recorded post-commit
    // below only when present.
    const usedMemoryIds = content?.usedMemoryIds;
    if (content && typeof content === "object") delete content.usedMemoryIds;

    const now = new Date().toISOString();
    content.updatedAt = now;
    // Set defaults that post() sets — put() is also used for new records via CLI
    content.archived = content.archived ?? false;
    content.createdAt = content.createdAt ?? now;

    // Fetch the pre-existing record (if any) ONCE — reused below both to
    // decide whether this PUT is a fresh create (dedup gate applies, default
    // visibility stamped) or an update/patch (dedup-bypassed, visibility left
    // untouched). See the dedup-gate block further down for why an existing
    // id skips the gate; the SAME "does a record already exist" check gates
    // the visibility default (Layer 1 part A): patchRecord/supersede-
    // close/retrievalCount bumps all route through put() with a MERGED
    // `{...existing, ...patch}` payload, and must never have their stored
    // visibility overwritten by a default recomputed from that merged content
    // — only a genuinely NEW id gets the default stamped.
    const preExisting = content.id
      ? await (databases as any).flair.Memory.get(content.id).catch(() => null)
      : null;

    // ─── Default visibility (durability-keyed) — Layer 1, part A ────────────
    // Explicit visibility on the write ALWAYS overrides; only stamp the
    // default when the caller left it unset AND this is a fresh record.
    // permanent|persistent → shared; standard|ephemeral|absent → private.
    if (!preExisting && (content.visibility === undefined || content.visibility === null)) {
      content.visibility = defaultVisibilityForDurability(content.durability);
    }

    // supersedes: optional reference to the ID of the memory this one
    // replaces. Validates shape + cross-agent-write authorization (shared
    // with post() — see validateAndAuthorizeSupersedes doc for why PUT needs
    // this too: it's the only HTTP-reachable create path).
    const supersedesError = await validateAndAuthorizeSupersedes(content, auth);
    if (supersedesError) return supersedesError;
    if (content.supersedes && !content.validFrom) {
      content.validFrom = content.createdAt;
    }

    // attention-plane vocabulary gate (flair#675) — see post()'s comment above.
    const entitiesError = invalidEntitiesResponse(content.entities);
    if (entitiesError) return entitiesError;

    // Content safety scan on updated content + summary.
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
    // already computed one for this content). flair#504 Phase 2: 'document'
    // — this is also the regen branch `flair reembed` triggers (clears
    // embedding/embeddingModel then hits this put()), so it's what actually
    // re-embeds a stale row WITH the prefix once stage 2 runs.
    if (content.content && !content.embedding) {
      const vec = await getEmbedding(content.content, "document");
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

    // Write-time provenance stamp (memory-provenance slice 1) — see
    // buildProvenance's doc above post(). Applies to every put() (fresh
    // create AND update/patch) — never gated on preExisting, so an update
    // always gets a freshly-stamped provenance reflecting the CURRENT
    // authenticated actor performing this write.
    content.provenance = buildProvenance(auth, content.createdAt, content);
    // flair#718 authorship-provenance — see post()'s identical comment above:
    // strip the write-body-only `claimedClient` passthrough now that it's
    // folded into `provenance.claimed.client`. Never persisted as a row field.
    delete content.claimedClient;

    // Write-time originatorInstanceId stamp (federation-edge-hardening slice
    // 1) — see stampOriginatorInstanceId's doc above post(). No-op if
    // already set: an update/patch of an existing local record carries its
    // own already-stamped originatorInstanceId forward unchanged (the
    // `{...existing, ...patch}` merge pattern every put() caller uses), and a
    // federation-synced record never reaches this method at all (see that
    // function's doc for why the merge path can't clobber it here either).
    await stampOriginatorInstanceId(content);

    // ── Write the new/updated record FIRST ──────────────────────────────────
    const result = await super.put(content);

    // ── THEN close the superseded record (see post()) ───────────────────────
    await closeSupersededIfNeeded(ctx, content, "put");

    // flair#744 slice A: citation-on-write — POST-COMMIT, fully
    // failure-isolated (see post()'s identical comment above).
    if (usedMemoryIds !== undefined) {
      try {
        await recordCitations(ctx, auth, usedMemoryIds, new Date().toISOString());
      } catch (err) {
        console.error("Memory.put: citation recording failed (write already committed)", err);
      }
    }

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
