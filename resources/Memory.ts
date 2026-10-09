import { databases } from "harper";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { patchRecord, withDetachedTxn } from "./table-helpers.js";
import { isAdmin, resolveAgentAuth, type AgentAuthVerdict } from "./agent-auth.js";
import { guardAuthorityFields } from "./authority-field-guard.js";
import { isForbiddenOwnerMutation } from "./record-owner-guard.js";
import { guardOwnerFieldImmutable } from "./owner-field-guard.js";
import { ownerChangedRefusal } from "./owner-delete-recheck.js";
import { applyFederationBookkeeping, applyOriginatorInstanceId, dropClientFederationBookkeeping, keepStoredOriginator, resolveStoredRow, stampOriginatorOnCreate } from "./originator-instance.js";
import { getEmbedding, getModelId } from "./embeddings-provider.js";
import { isEmbeddingSpaceUniform, noteWriteStamp } from "./embedding-space-guard.js";
import { scanFields, isStrictMode } from "./content-safety.js";
import { invalidEntitiesResponse } from "./entity-vocab.js";
import { checkRateLimit, rateLimitResponse } from "./rate-limiter.js";
import { resolveAllowedOwners } from "./memory-read-scope.js";
import { assertValidVisibility, assertVisibilityAllowedForDurability, PRIVATE_VISIBILITY, SHARED_VISIBILITY } from "./memory-visibility.js";
import { validateHostSource } from "./host-source.js";
import {
  buildPointerRow,
  extractPointerInputs,
  isPointerEchoOf,
  loadStoredPointer,
  projectRowsThroughPointers,
} from "./memory-host-source.js";
import { putPointerRow, deletePointerRowViaTable } from "./host-pointer-adapter.js";
import { DECLARED_MEMORY_ATTRIBUTES, stripUndeclaredMemoryAttributes, stripServerStampedFields } from "./memory-declared-attributes.js";
import { isJoinableTransaction, withOwnedTransaction, withSharedWriteTransaction } from "./request-transaction.js";
import { txnPausePoint } from "./txn-pause-point.js";
import { assertValidDurability, stampEphemeralExpiry } from "./memory-durability.js";
import { enforceSkillDurability, isSkillWrite, rejectSkillWritePath, refuseSkillWriteSource, skillEmbedText, skillScanGate } from "./skill-write.js";
import { buildSkillSuccessorRow, closedSkillPayloadReadable, defaultSkillHooks, resolveSkillHead, rowIsSkill, runSkillVersionWrite, skillVersionVisibility, skillPayloadUnchanged, prepareSkillBody, validateSkillSnapshots, authorizeSkillOwners, skillWriteConflict } from "./skill-version-write.js";
import { deriveSkillSubjectId } from "./skill-subject.js";
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
  makeScopedSearch,
  resolveAuthGate,
  stampAttribution,
  FORBIDDEN,
  UNAUTH,
  NOT_FOUND,
} from "./record-type-kit.js";
import { isSemanticPatch, MEMORY_SEMANTIC_FIELDS } from "./provenance.js";
import { RECORD_TYPES } from "./record-types.js";
import { attachTrust } from "./trust-block.js";
import { recordCitations } from "./usage-recording.js";
import { noteMemoryUpsert, noteMemoryDelete } from "./bm25-index-service.js";
import { recordMemoryDeletion } from "./memory-deletion-history.js";
import { applyHitStats, clearHitStats, overlayHitStatsResult } from "./hit-tracking.js";
import type { PointerRow } from "./host-source-visibility.js";
import { refuseStaleClientWrite, stripClientVersionPassthrough } from "./client-version-gate.js";
import { refuseReservedSeedWrite, reservedSeedWriteDenial, reservedSeedSubjectDenial, isReservedSeedId, writeTargetIds } from "./seed-reservation.js";
import { refuseContentSuffixId, resolveMemoryReferenceId, supersedesTargetMissing, supersedesTargetUnreadable } from "./memory-id-guard.js";

/** flair#1940 A1' — a named 400 for an invalid host pointer (reject, never
 *  truncate). Same shape the pre-A1' inline checks returned. */
function hostSourceBadRequest(error: string, message: string): Response {
  return new Response(JSON.stringify({ error, message }), {
    status: 400,
    headers: { "content-type": "application/json" },
  });
}

/**
 * flair#1940 round 18 — drop a caller `select`/`property` from a non-admin
 * collection read so the gated pointer join sees the stored rows. This is NOT a
 * selection parser: it removes the two keys and leaves every other query
 * property (conditions, operator, sort, limit, offset, ...) exactly as sent. A
 * query without a selection is returned unchanged.
 */
function withoutCallerSelection(query: any): any {
  if (!query || typeof query !== "object") return query;
  if ((query as any).select === undefined && (query as any).property === undefined) return query;
  const copy: any = Array.isArray(query) ? query.slice() : { ...query };
  delete copy.select;
  delete copy.property;
  return copy;
}

/**
 * Write the Memory row joining transaction `c` (0a). Resource.prototype.post
 * uses the instance's OWN `#context`, which an internal caller (a direct
 * `new Memory().post(...)`) does not have, and the base table has no `post` —
 * so the base collection `create(id, record, context)` is used, which honours
 * an explicit context and joins `c.transaction`. Returns the new id. Falls
 * back to the static post for the unit mock (which models post, not create).
 */
async function writeMemoryRowPost(cls: any, content: any, c: any): Promise<string> {
  if (typeof cls?.create === "function") {
    const created = await cls.create(content.id ?? null, content, c);
    if (typeof created === "string") return created;
    return created?.getId?.() ?? created?.id ?? content.id ?? "";
  }
  const r: any = await (databases as any).flair.Memory.post(content, c);
  return r?.id ?? content.id ?? "";
}

/** The authenticated author id for a pointer row, or "" when there is no
 *  principal (internal write). NEVER the body. */
function pointerAuthorId(auth: AgentAuthVerdict): string {
  return auth.kind === "agent" ? auth.agentId : "";
}

/** A fresh server-stamped row incarnation token (flair#1940 A1-iv item 1). */
function newInstanceToken(): string {
  return randomUUID();
}

/** Stamp the row incarnation token for a write: PRESERVE the existing row's
 *  token on an update, else generate a fresh one (call AFTER
 *  stripServerStampedFields, so a client-supplied value is gone first). */
function stampInstanceToken(content: any, existing: any): void {
  const preserved =
    existing && typeof existing.instanceToken === "string" && existing.instanceToken.length > 0
      ? existing.instanceToken
      : null;
  content.instanceToken = preserved ?? newInstanceToken();
}

/**
 * flair#1940 A1' — validate the write body's pointer inputs and build the
 * pointer row (canonical hostSource + scopeAtWrite + server-stamped
 * authorId/receivedAt). Returns a 400 `denial` on an invalid pointer/scope,
 * `row: null` when the body carries no pointer, else the row to persist.
 */
function buildPointerForWrite(args: {
  inputs: { hostSource: unknown; hostSourceScope: unknown };
  memoryId: string;
  visibility: string | null | undefined;
  auth: AgentAuthVerdict;
  memoryInstanceToken?: string | null;
  storedPointer?: PointerRow | null;
}): { row: ReturnType<typeof buildPointerRow> | null; denial?: Response } {
  const { inputs, memoryId, visibility, auth, memoryInstanceToken, storedPointer } = args;
  if (inputs.hostSource === undefined || inputs.hostSource === null) {
    if (inputs.hostSourceScope !== undefined) {
      return { row: null, denial: hostSourceBadRequest("invalid_host_source_scope", "hostSourceScope requires a hostSource") };
    }
    return { row: null };
  }
  const hs = validateHostSource(inputs.hostSource);
  if (!hs.ok) return { row: null, denial: hostSourceBadRequest("invalid_host_source", hs.error) };
  // Only an author's exact echo of the stored full canonical value preserves
  // the pointer row. A normally projected URL has its query and fragment
  // removed and is not an exact echo.
  if (
    inputs.hostSourceScope === undefined &&
    storedPointer &&
    isPointerEchoOf(inputs.hostSource, storedPointer, pointerAuthorId(auth))
  ) {
    return { row: null };
  }
  let scopeAtWrite: string | null = null;
  if (inputs.hostSourceScope !== undefined) {
    if (inputs.hostSourceScope !== "record") {
      return {
        row: null,
        denial: hostSourceBadRequest(
          "invalid_host_source_scope",
          `hostSourceScope must be "record" or omitted; a scope wider than the record is refused (got ${JSON.stringify(inputs.hostSourceScope)})`,
        ),
      };
    }
    scopeAtWrite = visibility ?? null;
  }
  return {
    row: buildPointerRow({
      memoryId,
      canonical: hs.canonical,
      scopeAtWrite,
      authorId: pointerAuthorId(auth),
      memoryInstanceToken: memoryInstanceToken ?? null,
      receivedAt: new Date().toISOString(),
    }),
  };
}

/** A fixed 500 body for a pointer that could not be persisted. The RESPONSE
 *  carries only a fixed message, never the raw error/stack (CodeQL:
 *  information exposure through a stack trace). */
function hostSourcePersistFailure(message: string): Response {
  return new Response(JSON.stringify({ error: "host_source_persist_failed", message }), {
    status: 500,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Abort the request's open transaction so the Memory row staged into it is
 * rolled back with the failed pointer row (flair#1940 A1' item 2). This is
 * exactly harper 5.2.8's `transaction.abort(context)` (dist/resources/
 * transaction.js): resolve `context.transaction` and abort it. The module is
 * not importable as a named export of the `harper` package (its exports map
 * exposes only "."), so we call the transaction object the context already
 * carries. A context with no open transaction has nothing to abort (the unit
 * lane's hand-built contexts).
 */
function abortRequestTransaction(ctx: any): void {
  const txn = ctx?.transaction;
  if (!txn || typeof txn.abort !== "function") return;
  // A failed abort is an ERROR, not a normal response (A1-iv item 4): if the
  // transaction cannot be aborted, the rollback is not established, so the
  // failure MUST propagate rather than being swallowed behind a 500 body.
  txn.abort();
}

/**
 * flair#1940 A1' item 2 — persist the pointer row in the SAME request
 * transaction as the Memory row. The request context is passed to the table
 * write so Harper's `txnForContext` joins the write to the request's open
 * transaction (`context.transaction`, joinable) instead of opening its own —
 * both tables live in database flair, so both rows commit together or not at
 * all. On failure the request transaction is ABORTED, so the already-staged
 * Memory row never commits, and the fixed 500 body is returned. There is no
 * compensating delete: the transaction is the mechanism. Returns null on
 * success.
 */
async function persistPointerRow(
  row: ReturnType<typeof buildPointerRow>,
  ctx: any,
): Promise<Response | null> {
  try {
    // The pointer-table ADAPTER (flair#1940 A1-iv item 6) writes via the real
    // MemoryHostSource table in production; a test drives a failing write from
    // TEST code (the shared Harper mock). A missing table throws (fail closed).
    await putPointerRow(row, ctx);
    return null;
  } catch (err) {
    // Abort the request transaction so NEITHER row commits, then fail the
    // write. No silent loss (A7): the write fails loudly.
    abortRequestTransaction(ctx);
    console.error("Memory: host-source pointer persist failed (write aborted)", err);
    return hostSourcePersistFailure("host-source pointer could not be persisted");
  }
}

/** flair#1940 A1' item 6 (A1'' item 2) — cascade: delete the pointer row where a
 *  Memory row dies. The delete is passed the request context so it JOINS the
 *  request transaction (both tables in database flair), so a failing pointer
 *  delete fails the whole operation atomically; failures are NEVER swallowed.
 *  Returns null on success, a fixed 500 body on failure (after aborting the
 *  request transaction so nothing commits). */
async function deletePointerRow(memoryId: string, ctx: any): Promise<Response | null> {
  try {
    // The pointer-table ADAPTER (A1-iv item 6); a missing table throws (fail
    // closed, never a silent skip).
    await deletePointerRowViaTable(memoryId, ctx);
    return null;
  } catch (err) {
    abortRequestTransaction(ctx);
    console.error("Memory: host-source pointer delete failed (delete aborted)", err);
    return new Response(JSON.stringify({ error: "host_source_delete_failed", message: "host-source pointer could not be deleted" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
}


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
  // flair#1181 — the in-process STATIC by-id read (resources/mcp-tools.ts
  // memory_get) folds includeTrust into the RequestTarget as a plain property,
  // because Harper's static `Cls.get(target, context)` has no opts slot (arg 2
  // is the context, not opts). This is the in-process analog of the two shapes
  // below; a real RequestTarget from the HTTP path never carries a plain
  // `includeTrust` property (it lives in the query string, read via `.get`),
  // so this is purely additive and does not affect the HTTP path.
  if (target?.includeTrust === true) return true;
  const raw =
    target?.get?.("includeTrust") ??
    target?.searchParams?.get?.("includeTrust") ??
    undefined;
  return raw === "true" || raw === true;
}

/**
 * resolveAllowedOwners (./memory-read-scope.ts) no longer bounds reads — a
 * non-admin reader sees its own records at any visibility plus every other
 * agent's non-private records (resolveReadScope()); the helper is kept for
 * admin tooling only.
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
const memoryScopedSearch = makeScopedSearch(memoryReadScope);
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
  // ── Vector-space uniformity guard (embedding-space-guard slice 1) ──────────
  // When the corpus is not uniform in the current embedding space, the cosine
  // compare below would cross vector spaces (Harper zero-pads / returns a
  // garbage score). No-op the dedup cosine leg — treat as no-match — through
  // the SAME single chokepoint the recall leg (SemanticSearch) consults.
  // ADVISORY ONLY: the write always proceeds (runDedupGate already computed and
  // stamped a fresh CURRENT-space embedding); this only skips a comparison that
  // can't be trusted while spaces are mixed. Never suppresses a write.
  if (!(await isEmbeddingSpaceUniform())) return null;
  try {
    const query: any = {
      sort: { attribute: "embedding", target: embedding, distance: "cosine" },
      conditions: [
        { attribute: "agentId", comparator: "equals", value: agentId },
        { attribute: "archived", comparator: "not_equal", value: true },
      ],
      // flair#1546 dedup footnote: `trigger`/`tags` widen the candidate
      // projection so the LEXICAL leg can compare trigger-vs-trigger for skill
      // rows (see the computeMatchConfidence call below). Non-skill candidates
      // are unaffected — skillEmbedText falls back to `content`.
      select: ["id", "content", "trigger", "tags", "$distance"],
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
    // flair#1546 dedup footnote (Kern, non-blocking): the lexical leg must
    // compare the SAME text the vector represents on BOTH sides. `contentText`
    // is already skillEmbedText(new) (the trigger for a skill write); the
    // candidate side must match — skillEmbedText(top) returns the candidate's
    // `trigger` when it is a skill row, its `content` otherwise. Pre-fix this
    // crossed the new row's trigger against the candidate's stored `content`
    // (trigger-vs-content), under-flagging near-duplicate skill triggers.
    const candidateLexText = skillEmbedText(top);
    const confidence = computeMatchConfidence(contentText, candidateLexText, cosine);
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

  // flair#1542: skill-tagged rows embed from `trigger`, not `content` — the
  // dedup gate must compare the SAME text the stored vector represents, or a
  // skill's dedup cosine would cross the trigger-space vector against
  // content-space candidates. Non-skill rows are byte-identical (skillEmbedText
  // returns `content`).
  const embedText = skillEmbedText(content);
  if (typeof embedText !== "string" || embedText.length < DEDUP_MIN_CONTENT_LENGTH) {
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
  // correctness. flair#1073: if that window lasts days (boot cycle marked
  // embedding-stamp complete without converging), /HealthDetail names the
  // outstanding migration and that duplicate detection is inactive — do
  // not treat a long-lived split as this documented transient.
  let embedding: number[] | null = Array.isArray(content.embedding) ? content.embedding : null;
  if (!embedding) {
    try {
      embedding = await getEmbedding(embedText, "document");
    } catch {
      embedding = null;
    }
    if (embedding) {
      content.embedding = embedding;
      content.embeddingModel = getModelId();
    }
  }
  if (!embedding) return null;

  return findConservativeDedupMatch(ctx, content.agentId, embedText, embedding, cosineThreshold, lexicalThreshold);
}

/** Build the final write response: always `written: true`, always includes
 *  `id`, includes `visibility` when the persisted row has one, and layers the dedup collision signal on top when
 *  present. Never a code path where a match suppresses these base fields.
 *
 *  ── Why `visibility` is in the write response (flair#991) ──────────────────
 *  Visibility is the one field on a memory the caller most often does NOT
 *  set and yet most needs to know: the durability-keyed default above stamps
 *  `private` for a bare write and `shared` for a permanent/persistent one, so
 *  "who can read this" is decided by a rule the writer never typed. Returning
 *  it makes the landed value observable on EVERY write surface at once —
 *  `flair memory add`'s printed JSON, the REST response, the native /mcp
 *  `memory_store` result, and packages/flair-mcp's `effectiveVisibility` line
 *  (which read this field all along and had nothing to read, so it always
 *  rendered "(server default)").
 *
 *  Read from `content`, not from `base`: `content.visibility` is the value
 *  that was actually persisted a few lines earlier, and assigning after the
 *  `...base` spread means the persisted value wins over anything the storage
 *  layer echoes back. Omitted (not `null`) when unset, which happens only for
 *  an existing record that has no stored writable visibility — reporting `null`
 *  there would read as "no one but the owner",
 *  the opposite of what an absent field means to `isPrivateVisibility()`. */
function buildWriteResponse(content: any, result: any, dedupMatch: DedupMatch | null): any {
  const base = result && typeof result === "object" && !Array.isArray(result) ? result : {};
  const response: any = {
    id: content.id,
    ...base,
    written: true,
    deduplicated: !!dedupMatch,
  };
  if (content.visibility !== undefined && content.visibility !== null) {
    response.visibility = content.visibility;
  }
  if (dedupMatch) {
    response.matchedId = dedupMatch.matchedId;
    response.matchConfidence = { cosine: dedupMatch.cosine, lexical: dedupMatch.lexical };
  }
  return response;
}

const REINDEX_BOOKKEEPING_FIELDS = new Set<string>([
  "embedding", "embeddingModel", "contentHash", "retrievalCount", "lastRetrieved", "usageCount",
]);
const REINDEX_PROTECTED_FIELDS = DECLARED_MEMORY_ATTRIBUTES.filter((field) => !REINDEX_BOOKKEEPING_FIELDS.has(field));

function reindexDrift(content: any, existing: Record<string, any>): string | null {
  const isSkill = rowIsSkill(existing);
  if (!isSkill && rowIsSkill(content)) return "tags";
  for (const field of REINDEX_PROTECTED_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(content, field)) continue;
    const submitted = content[field];
    const stored = existing[field];
    if (submitted === stored) continue;
    if ((field === "metadata" || Array.isArray(submitted)) && JSON.stringify(submitted ?? null) === JSON.stringify(stored ?? null)) continue;
    return field;
  }
  return null;
}

/** The row a `_reindex` re-PUT writes over `existing` (the stored row), or its
 *  refusal. Memory.put()'s `_reindex` branch and the MemoryReindex write-back
 *  both build their row here (flair#2354). */
export function buildReindexRow(
  content: any,
  existing: Record<string, any> | null | undefined,
): { row: Record<string, any> } | { status: 404 | 409; error: string; message: string } {
  delete content._reindex;
  // A1' item 1: the reindex branch keeps declared and named retained
  // attributes. Pinned by test/unit/memory-host-source.test.ts
  // (r20-put-reindex) — RED if this call is removed.
  stripUndeclaredMemoryAttributes(content);
  // A1-iv items 1/3: strip a client-supplied server-stamped field, then
  // PRESERVE the existing row's incarnation token (reindex is a re-PUT of
  // an existing row, never a reincarnation).
  const reindexBody = { ...content };
  stripServerStampedFields(content);
  // A reindex is a re-PUT of an EXISTING row, so an absent stored row is
  // refused — it is never re-created/re-stamped.
  if (!existing) {
    return { status: 404, error: "reindex_row_not_found", message: "the _reindex re-PUT requires an existing stored row" };
  }
  const drift = reindexDrift(reindexBody, existing);
  if (drift) {
    return { status: 409, error: "reindex_would_change_row", message: `the _reindex re-PUT may not change '${drift}'` };
  }
  stampInstanceToken(content, existing);
  for (const field of REINDEX_PROTECTED_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(content, field) && existing[field] !== undefined) {
      content[field] = existing[field];
    }
  }
  // Keep the EXISTING row's STORED provenance byte-for-byte. The rest of
  // the row is filtered above and may gain an absent incarnation token.
  // The body's provenance was stripped above so it cannot be forged;
  // restoring it from `existing` (never from the submitted value)
  // keeps provenance byte-identical across a corpus-wide reindex.
  // Pinned by test/unit/memory-host-source.test.ts (r20-put-reindex) — RED
  // if this restore is removed.
  if (typeof existing.provenance === "string") {
    content.provenance = existing.provenance;
  }
  // flair#1965: a reindex is a re-PUT of an EXISTING row (an UPDATE), so the
  // row's stored originatorInstanceId stands; a body value is dropped, and a
  // legacy row with no value is left un-stamped. See
  // resources/originator-instance.ts.
  keepStoredOriginator(content, existing);
  // The receiver-side federation bookkeeping likewise stands as stored.
  applyFederationBookkeeping(content, existing);
  // Preserve stored visibility on updates before applying write policy:
  // a reindex payload that omits it keeps the record's stored value.
  if (content.visibility === undefined || content.visibility === null) {
    if (existing.visibility === PRIVATE_VISIBILITY || existing.visibility === SHARED_VISIBILITY) {
      content.visibility = existing.visibility;
    }
  }
  return { row: content };
}

/** Aborts the close's owned transaction: the row changed after the transaction read it. */
class CloseTargetChanged extends Error {}

/** Attempts of the close before it gives up on a row that keeps changing. */
const SUPERSEDE_CLOSE_ATTEMPTS = 3;

/**
 * Read-modify-write close for ordinary Memory writes. Does NOT swallow failures —
 * throws so the caller can log it. Never called before the new record is
 * already written.
 *
 * flair#2307: the read and write run in ONE owned
 * transaction (withOwnedTransaction, the MemoryMaintenance pattern: the
 * request's transaction is detached and a fresh one this call owns is created),
 * and the write is built from the row read inside it. `expectedOwner`, when
 * supplied by a non-admin agent's close plan, is the owner the authorization
 * read saw; a differing owner at the transaction read throws instead of closing.
 * Admin and internal close plans have no expected owner.
 *
 * Harper 5.2.8 has no compare-and-set on a table write: a transaction does not
 * fail when a row it read is changed by another write before it commits;
 * Harper applies both writes, ordered by transaction timestamp. So once the
 * write is staged, and before the transaction commits, the close re-reads the
 * committed row outside the transaction (an empty context: Harper's latest
 * committed state, not this transaction's snapshot or its staged write). If
 * that row is no longer the one read inside the transaction, the transaction
 * is aborted (the staged write is discarded) and the close starts over from
 * the committed row: SUPERSEDE_CLOSE_ATTEMPTS (three) attempts in all, so at
 * most two retries. A change committed after that re-read and before the commit is not
 * seen by it; Harper orders the two writes by timestamp.
 */
async function closeSupersededRecord(ctx: any, oldId: string, patch: Record<string, unknown>, expectedOwner?: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    let closedRow: any;
    try {
      closedRow = await withOwnedTransaction(ctx, async (c) => {
        const existing = await (databases as any).flair.Memory.get(oldId, c);
        if (!existing) {
          throw new Error(`supersede-close: record ${oldId} not found`);
        }
        if (expectedOwner !== undefined && existing.agentId !== expectedOwner) {
          throw new Error(`supersede-close: record ${oldId} is no longer owned by the authorized owner`);
        }
        // Test-only: inert unless the fault-injection env opt-in is set and armed.
        const pause = txnPausePoint("supersede-close");
        if (pause) await pause;
        const closed = { ...existing, ...patch };
        stripUndeclaredMemoryAttributes(closed);
        await (databases as any).flair.Memory.put(closed, c);
        const committed = await (databases as any).flair.Memory.get(oldId, {});
        if (!isDeepStrictEqual(committed, existing)) throw new CloseTargetChanged();
        return closed;
      });
    } catch (err) {
      if (!(err instanceof CloseTargetChanged)) throw err;
      if (attempt < SUPERSEDE_CLOSE_ATTEMPTS) continue;
      throw new Error(`supersede-close: record ${oldId} changed during each of ${SUPERSEDE_CLOSE_ATTEMPTS} attempts; not closed`);
    }
    // flair#1357 — a supersede-close sets `validTo`, which the retrieval filters
    // read, so the lexical index has to see it as eagerly as a content write.
    noteMemoryUpsert(closedRow);
    return;
  }
}

/**
 * Stamp `lastReflected` on each existing `derivedFrom` source of a new row
 * (best-effort bookkeeping; a failure is swallowed). Called only after the new
 * row was written (flair#2307): a refused write changes no source row.
 * lastReflected keys off updatedAt (the write moment), NOT createdAt — since
 * #1336 a create may carry a backdated caller createdAt, and the reflection
 * bookkeeping must record when the derivation actually ran.
 */
async function markDerivedSourcesReflected(content: any): Promise<void> {
  if (!Array.isArray(content.derivedFrom) || content.derivedFrom.length === 0) return;
  const now = content.updatedAt;
  for (const sourceId of content.derivedFrom) {
    try {
      const src = await (databases as any).flair.Memory.get(sourceId);
      if (src) {
        const reflectPatch = { lastReflected: now };
        stripUndeclaredMemoryAttributes(reflectPatch);
        await patchRecord((databases as any).flair.Memory, sourceId, reflectPatch, {
          pausePre: () => txnPausePoint("last-reflected-pre"), pausePoint: () => txnPausePoint("last-reflected"), expectedRow: src,
        }).catch(() => {});
      }
    } catch {}
  }
}

/** Does an agent hold a "write" grant from `ownerId`? Same MemoryGrant lookup
 *  the read paths used before the open-within-org reframe (reads no longer
 *  consult MemoryGrant); it survives here for the "write" scope that gates
 *  cross-agent supersede. */
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
 * agent-auth/grant machinery — no parallel auth logic). Returns `denial` (a
 * Response to short-circuit with) or the `close` the write is authorized to
 * perform once the new record is written (null: close nothing).
 *
 * flair#2307: `content.supersedes` is already the canonical id
 * (canonicalizeSupersedes), so the reserved-id check, the authorization read,
 * the stored reference and the close all name the same row. For a non-admin
 * agent, a failed target read refuses (supersedesTargetUnreadable) and a
 * missing target refuses (supersedesTargetMissing) — except a reference that is
 * unchanged from the stored row's own `supersedes` (a re-PUT of a successor
 * whose predecessor was since deleted), which is kept and closes nothing.
 * For a non-admin agent's ordinary Memory write, the close carries the owner the read saw;
 * closeSupersededRecord aborts on a change visible at its committed re-read.
 * Later changes follow Harper's timestamp order (see the PR residual-gap note).
 * An admin or internal write has no authorization read or owner comparison.
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
async function validateAndAuthorizeSupersedes(
  content: any,
  auth: AgentAuthVerdict,
  ctx: any,
  stored: Record<string, any> | null,
): Promise<{ denial: Response | null; close: SupersedeClose | null }> {
  const refuse = (denial: Response) => ({ denial, close: null });
  if (content.supersedes === null) {
    delete content.supersedes;
  }
  if (content.supersedes !== undefined && typeof content.supersedes !== "string") {
    return refuse(new Response(JSON.stringify({ error: "supersedes must be a string (memory ID)" }), {
      status: 400, headers: { "Content-Type": "application/json" },
    }));
  }
  // flair#2141 S2: superseding closes the target row, so a reserved seed id
  // needs operator authority here too (resources/seed-reservation.ts).
  const seedDenial = reservedSeedWriteDenial("Memory", [content.supersedes], ctx, auth);
  if (seedDenial) return refuse(seedDenial);
  if (!content.supersedes) return { denial: null, close: null };
  if (auth.kind !== "agent" || auth.isAdmin) return { denial: null, close: { id: content.supersedes } };
  let target: any;
  try {
    target = await (databases as any).flair.Memory.get(content.supersedes);
  } catch (err) {
    return refuse(supersedesTargetUnreadable(err));
  }
  if (!target) {
    if (stored?.supersedes === content.supersedes) return { denial: null, close: null };
    return refuse(supersedesTargetMissing());
  }
  if (target.agentId !== auth.agentId && !(await hasWriteGrant(auth.agentId, target.agentId))) {
    return refuse(FORBIDDEN("forbidden: cannot supersede a memory owned by another agent without a write grant"));
  }
  return { denial: null, close: { id: content.supersedes, ownerId: target.agentId } };
}

/** The close a write is authorized to perform on its `supersedes` target. */
interface SupersedeClose {
  id: string;
  /** The owner the authorization read saw (non-admin agent callers only). */
  ownerId?: string;
}

/**
 * flair#2307: resolve a write's `supersedes` reference to its canonical id ONCE
 * (resolveMemoryReferenceId), before anything reads it, and store that id back
 * on the body. Every later use — the skill body's predecessor read, the
 * reserved-id check, the authorization read, the stored reference and the
 * close — then names the same row. A non-string is left for the shape check.
 */
function canonicalizeSupersedes(content: any): void {
  if (content && typeof content === "object" && typeof content.supersedes === "string") {
    content.supersedes = resolveMemoryReferenceId(content.supersedes);
  }
}

/**
 * Close the superseded record — called AFTER the new record has already been
 * written (write-new-BEFORE-close-old). Safe failure state is
 * two active records (recoverable), never a tombstoned-old-with-lost-new.
 * Failure is logged (observable), never silently swallowed. No-op when
 * validateAndAuthorizeSupersedes authorized no close.
 */
async function closeSupersededIfNeeded(ctx: any, content: any, close: SupersedeClose | null, methodLabel: "post" | "put"): Promise<void> {
  if (!close) return;
  try {
    await closeSupersededRecord(ctx, close.id, {
      validTo: content.validFrom ?? content.createdAt,
      updatedAt: content.createdAt ?? content.updatedAt,
    }, close.ownerId);
  } catch (err) {
    // Constant format string + structured data: memory ids are agent-controlled,
    // so interpolating them into console.error's format position (with a trailing
    // `err` arg) would let an id containing %s/%o consume/hide the real error
    // (semgrep unsafe-formatstring). Keep all dynamic values in the data object.
    console.error(
      "Memory.closeSuperseded: failed to close superseded record after writing new record " +
      "(observable, not silent; new record is safely written, old record remains active until retried)",
      { method: methodLabel, supersededId: close.id, newRecordId: content.id, err },
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
 * = the SERVER write instant (flair#1960), optional unverified
 * claimed.createdAt / claimed.model / claimed.client passthroughs — the last
 * two added by flair#718 authorship-provenance). Deliberately NOT implemented
 * in this slice: a
 * context-fingerprint field — bootstrap doesn't return the IDs a fingerprint
 * would need, so it requires client cooperation that's out of scope here.
 */

/**
 * ─── Write-time originatorInstanceId (federation-edge-hardening slice 1) ─────
 *
 * The server-stamped `originatorInstanceId` contract and the create/update rule
 * live in resources/originator-instance.ts — the single delegate Memory, Soul,
 * Agent and Relationship share, so the four writers cannot drift. In short:
 * a CREATE stamps this instance's own id (any body value is ignored); an UPDATE
 * keeps the stored value (a body value neither replaces nor clears it); and a
 * federation merge — resources/Federation.ts's FederationSync.post(), which
 * applies inbound rows through the RAW table handle, never a resource method —
 * preserves the originating instance's value. See that module for the full
 * rationale. `content.originatorInstanceId == null` is no longer read here: a
 * body value is not trusted at any point.
 */

/**
 * flair#2139 S2 — write a skill create/update atomically through the
 * transactional writer.
 */
async function writeSkillCreateOrUpdate(
  args: {
    ctx: any;
    auth: AgentAuthVerdict;
    content: any;
    storedRow: Record<string, any> | null;
    explicitPredecessor: Record<string, any> | null;
    method: "post" | "put";
    pointer: { row: any } | null;
    /** A reserved seed id: version the write IN PLACE (same physical id). */
    inPlaceId?: string | null;
    reembedding?: boolean;
    requestedPayload?: Record<string, any>;
  },
): Promise<any> {
  const { ctx, auth, content, storedRow, explicitPredecessor, method, pointer, inPlaceId, reembedding, requestedPayload } = args;
  const now = new Date().toISOString();
  const explicitSuccessor = !!explicitPredecessor && (!storedRow || content.supersedes !== storedRow.supersedes);
  let successorId = inPlaceId
    ? inPlaceId
    : explicitSuccessor || !storedRow
      ? String(content.id ?? `${content.agentId}-${randomUUID()}`)
      : `${content.agentId}-${randomUUID()}`;
  const subjectId = deriveSkillSubjectId({ newPhysicalId: successorId, storedHead: storedRow, predecessor: explicitPredecessor });
  // flair#2139 S2 — the reservation covers the whole logical lineage: a write
  // whose subject is the seed's requires the operator source, not only one that
  // names the seed's physical id.
  const seedLineageDenial = reservedSeedSubjectDenial("Memory", [subjectId], ctx, auth);
  if (seedLineageDenial) return seedLineageDenial;
  const addressedId = storedRow ? String(storedRow.id) : explicitPredecessor ? String(explicitPredecessor.id) : null;
  const captured: { row: Record<string, any> | null; closed: Record<string, any> | null } = { row: null, closed: null };
  let unchangedHead: Record<string, any> | null = null;
  const outcome = await runSkillVersionWrite({
    ctx,
    subjectId,
    agentId: String(content.agentId),
    head: (shared) => resolveSkillHead(subjectId, addressedId, shared),
    plan: async (head, shared) => {
      const stale = await validateSkillSnapshots(storedRow, explicitPredecessor, content.id ?? null, shared);
      const denied = await authorizeSkillOwners(ctx, auth, [storedRow, explicitPredecessor, head ?? content], shared);
      if (denied) return denied;
      if (inPlaceId && method === "put" && !reembedding && !explicitPredecessor && !pointer?.row &&
        head?.id === inPlaceId && requestedPayload && skillPayloadUnchanged(requestedPayload, head)) {
        unchangedHead = head;
        return null;
      }
      if (stale) return stale;
      if ((storedRow || explicitPredecessor) && !head) return skillWriteConflict("skill_head_missing");
      if (explicitSuccessor && head?.id !== explicitPredecessor?.id) return skillWriteConflict("skill_predecessor_stale");
      if (storedRow && head?.id !== storedRow.id) return skillWriteConflict("skill_target_stale");
      const reembedInPlace = method === "put" && reembedding && head &&
        head.id === storedRow?.id && skillPayloadUnchanged(content, head);
      if (reembedInPlace) successorId = String(head.id);
      const liveHead = head;
      const successor = buildSkillSuccessorRow({
        base: { ...content, agentId: liveHead?.agentId ?? content.agentId }, predecessorRow: liveHead, successorId, subjectId,
        // An in-place (reserved seed) write keeps the same physical id, so it
        // sets no `supersedes` and closes no row.
        supersedes: reembedInPlace ? head.supersedes ?? null : inPlaceId || !liveHead ? null : String(liveHead.id), now,
      });
      if (reembedInPlace) {
        successor.instanceToken = typeof head.instanceToken === "string" && head.instanceToken.length > 0
          ? head.instanceToken : content.instanceToken;
      }
      await applyOriginatorInstanceId(successor, liveHead);
      applyFederationBookkeeping(successor, liveHead);
      captured.row = successor;
      const value = typeof successor.content === "string" ? successor.content : null;
      const visibility = skillVersionVisibility(successor);
      if (inPlaceId || reembedInPlace) {
        return liveHead
          ? { kind: "update", predecessor: null, successor, closePatch: {}, value, visibility }
          : { kind: "create", predecessor: null, successor, closePatch: {}, value, visibility };
      }
      if (!liveHead) return { kind: "create", predecessor: null, successor, closePatch: {}, value, visibility };
      captured.closed = liveHead;
      return { kind: "update", predecessor: liveHead, successor, closePatch: { skillSubjectId: subjectId, validTo: now, updatedAt: now }, value, visibility };
    },
    hooks: {
      ...defaultSkillHooks,
      pointer: async (shared) => {
        if (captured.closed) {
          const denial = await deletePointerRow(String(captured.closed.id), shared);
          if (denial) return denial;
        }
        return pointer?.row
          ? persistPointerRow({ ...pointer.row, memoryId: successorId, memoryInstanceToken: captured.row?.instanceToken }, shared)
          : null;
      },
    },
  });
  if (!outcome.ok) return outcome.response;
  if (captured.closed) noteMemoryDelete(String(captured.closed.id));
  if (captured.row) {
    noteMemoryUpsert(captured.row);
    noteWriteStamp(captured.row.embeddingModel);
  }
  return { id: successorId, written: captured.row !== null, visibility: skillVersionVisibility(captured.row ?? unchangedHead) };
}

/** Close the live head and delete its pointer in the version transaction. */
async function writeSkillDelete(args: { ctx: any; auth: AgentAuthVerdict; record: Record<string, any> }): Promise<any> {
  const { ctx, auth, record } = args;
  let closedId = "";
  const now = new Date().toISOString();
  const subjectId = String(record.skillSubjectId ?? record.id);
  const seedLineageDenial = reservedSeedSubjectDenial("Memory", [subjectId], ctx, auth);
  if (seedLineageDenial) return seedLineageDenial;
  const outcome = await runSkillVersionWrite({
    ctx,
    subjectId,
    agentId: String(record.agentId),
    head: (shared) => resolveSkillHead(subjectId, String(record.id), shared),
    plan: async (head, shared) => {
      // flair#2355: for a non-admin caller, re-read the COMMITTED rows before
      // the close. The delete is refused, and nothing is closed, when the
      // addressed row is present with an owner other than the caller (409
      // `owner_changed`), when the head this delete closes (a stale id resolves
      // a different row as the head) is absent (409 `skill_head_missing`), or
      // when the head's owner differs from the owner this transaction read and
      // authorizeSkillOwners checks below (409 `owner_changed`).
      if (auth.kind === "agent" && !auth.isAdmin) {
        const pause = txnPausePoint("memory-skill-delete");
        if (pause) await pause;
        const confirmed = await (databases as any).flair.Memory.get(String(record.id), {});
        if (confirmed && isForbiddenOwnerMutation(confirmed, RECORD_TYPES.Memory.ownerField, auth.agentId)) {
          return ownerChangedRefusal("Memory");
        }
        if (head) {
          const confirmedHead = await (databases as any).flair.Memory.get(String(head.id), {});
          if (!confirmedHead) return skillWriteConflict("skill_head_missing");
          if (confirmedHead[RECORD_TYPES.Memory.ownerField] !== head[RECORD_TYPES.Memory.ownerField]) {
            return ownerChangedRefusal("Memory");
          }
        }
      }
      const stale = await validateSkillSnapshots(record, null, String(record.id), shared);
      if (stale) return stale;
      const denied = await authorizeSkillOwners(ctx, auth, [record, head], shared);
      if (denied) return denied;
      if (!head) return skillWriteConflict("skill_head_missing");
      const liveHead = head;
      closedId = String(liveHead.id);
      return { kind: "delete", predecessor: liveHead, closePatch: { skillSubjectId: subjectId, validTo: now, updatedAt: now }, value: null, visibility: skillVersionVisibility(liveHead) };
    },
    hooks: { ...defaultSkillHooks, pointer: async (shared) => deletePointerRow(closedId, shared) },
  });
  if (!outcome.ok) return outcome.response;
  noteMemoryDelete(closedId);
  return new Response(JSON.stringify({ id: closedId, deleted: true }), {
    status: 200, headers: { "Content-Type": "application/json" },
  });
}

/** flair#2296: a PATCH body that sets both embedding fields to null and nothing else (an `id` aside). */
function isReembedPatch(content: any): boolean {
  if (!content || typeof content !== "object" || Array.isArray(content)) return false;
  if (content.embedding !== null || content.embeddingModel !== null) return false;
  return Object.keys(content).every((key) => key === "id" || key === "embedding" || key === "embeddingModel");
}

/** A vector the re-embed may stamp: a non-empty array of finite numbers. */
function isUsableEmbeddingVector(value: unknown): value is number[] {
  return Array.isArray(value) && value.length > 0 &&
    value.every((n) => typeof n === "number" && Number.isFinite(n));
}

/** Attempts of a re-embed before it gives up on a row whose text keeps changing. */
const REEMBED_WRITE_ATTEMPTS = 3;

/**
 * flair#2390: write the re-embed of Memory row `id`.
 *
 * `preRead` is the row as the caller first read it and `vector` the embedding
 * computed from its text, outside this call. This re-reads the committed row
 * inside the transaction that writes (the static table handle, with the
 * attempt's owned context), so the write is built from the row as stored at
 * that read, not from the pre-await read: a field another writer committed
 * while the vector was computed is kept, and the caller's authorization is
 * re-checked against the row's CURRENT owner.
 *
 * If the stored text is no longer the text the vector was computed from, this
 * recomputes from the stored text rather than stamping a vector for text the row
 * no longer carries (at most REEMBED_WRITE_ATTEMPTS times). If the text keeps
 * changing across the REEMBED_WRITE_ATTEMPTS attempts, it returns
 * reembed_row_changed (409) and writes nothing. A row that vanished, a row with
 * no text, or a caller no longer authorized for the row is refused the same way
 * the first read refused it.
 */
async function reembedStoredRow(
  id: string,
  preRead: Record<string, any>,
  vector: number[],
  auth: AgentAuthVerdict,
  ctx: any,
): Promise<Response> {
  let textToEmbed = skillEmbedText(preRead);
  let embedding = vector;
  for (let attempt = 1; attempt <= REEMBED_WRITE_ATTEMPTS; attempt++) {
    const outcome = await withOwnedTransaction(ctx, async (owned) => {
      const stored = await (databases as any).flair.Memory.get(id, owned);
      if (!stored) return { kind: "not_found" as const };
      if (auth.kind === "agent" && !auth.isAdmin &&
          isForbiddenOwnerMutation(stored, RECORD_TYPES.Memory.ownerField, auth.agentId)) {
        return { kind: "forbidden" as const };
      }
      const storedText = skillEmbedText(stored);
      if (typeof storedText !== "string" || storedText.length === 0) return { kind: "no_text" as const };
      if (storedText !== textToEmbed) return { kind: "recompute" as const, text: storedText };
      const model = getModelId();
      const updatedAt = new Date().toISOString();
      await (databases as any).flair.Memory.put({ ...stored, embedding, embeddingModel: model, updatedAt }, owned);
      return { kind: "written" as const, model, updatedAt };
    });
    if (outcome.kind === "not_found") return NOT_FOUND();
    if (outcome.kind === "forbidden") return FORBIDDEN("forbidden: cannot write memory owned by another agent");
    if (outcome.kind === "no_text") {
      return Response.json({ error: "reembed_no_text", message: "the stored row has no text to embed" }, { status: 422 });
    }
    if (outcome.kind === "recompute") {
      if (attempt === REEMBED_WRITE_ATTEMPTS) {
        return Response.json({ error: "reembed_row_changed", message: "the stored text changed during each re-embed attempt; retry" }, { status: 409 });
      }
      textToEmbed = outcome.text;
      const recomputed = await getEmbedding(textToEmbed, "document");
      if (!isUsableEmbeddingVector(recomputed)) {
        return Response.json({ error: "embedding_unavailable", message: "the embedding engine returned no vector; the stored row is unchanged, retry" }, { status: 503 });
      }
      embedding = recomputed;
      continue;
    }
    noteWriteStamp(outcome.model);
    return Response.json({ id, embeddingModel: outcome.model, updatedAt: outcome.updatedAt });
  }
  return new Response(
    JSON.stringify({ error: "reembed_row_changed", message: "the stored text changed during each re-embed attempt; retry" }),
    { status: 409, headers: { "content-type": "application/json" } },
  );
}

export class Memory extends (databases as any).flair.Memory {
  /**
   * Self-authorize now that the global gate is non-rejecting. Closes the P0
   * leak: Harper routes `GET /Memory/<id>` to get() and the collection
   * describe (`GET /Memory`) to a path outside search() — neither was gated
   * before this fix, so an anonymous caller got a 200 with full record
   * content / schema even though search() (and the write paths) correctly
   * 401/403'd. Per-record read scoping happens in get() below (its own records
   * at any visibility plus every other agent's non-private records — grants are
   * not consulted on reads; resolveReadScope()); the collection scope is still
   * in search().
   *
   * allowCreate/allowUpdate/allowDelete are deliberately NOT added here:
   * post()/put()/delete() already self-enforce per-agent ownership inline
   * (resolveAgentAuth + explicit agentId checks in post()/put(), and the
   * stored-owner check in delete()). Adding allow* on top of that,
   * unverified, risks regressing owner writes/deletes on a P0 security fix
   * that is scoped to the read leak — left as-is on purpose.
   */
  allowRead() { return memoryAuthGate.call(this); }

  /**
   * Override get() to apply Memory's open-within-org scope to by-id reads,
   * as search() does for collection reads. For a verified non-admin agent,
   * a missing record and one outside its read scope both return 404; this
   * does not disclose whether another agent's private record exists.
   * Anonymous HTTP requests are denied by allowRead(), while administrator
   * and trusted internal reads are unfiltered. Wired through
   * record-type-kit.ts's makeByIdReadGate.
   */
  async get(target?: any, opts?: { includeTrust?: boolean }) {
    // Collection / query reads — the `GET /Memory/?<query>` form and the bare
    // collection — arrive as a RequestTarget with `isCollection === true`, and
    // are governed by search() (same open-within-org read scope; grants are not
    // consulted on reads). Only a genuine by-id
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

    const ctx = (this as any).getContext?.();
    const auth = await resolveAgentAuth(ctx);
    // flair#1940 round 18 (design ruling): a non-admin read ignores the caller's
    // `select`/`property` whatever the target shape — the same contract the auth
    // middleware enforces for a REST read, applied here for a direct contextual
    // read. Read the FULL stored row through the shared by-id gate (which builds
    // its own plain id-only target) so the pointer decision below always sees
    // the stored `id`, `agentId`, `instanceToken`, `archived` and `visibility`.
    // A shaped read — a caller target carrying a selection, or a class that
    // installs one — can never hand the join an already-projected value. Trusted
    // internal and admin reads keep their target unchanged.
    const nonAdminAgent = auth.kind === "agent" && !auth.isAdmin;
    let readTarget: any = target;
    if (nonAdminAgent) {
      const targetId = typeof target === "string" ? target : (target as any)?.id;
      readTarget = targetId != null ? { id: targetId } : {};
    }
    const result = await memoryByIdReadGate.call(this, readTarget, (t: any) => super.get(t));
    if (nonAdminAgent && result && typeof result === "object" && !(result instanceof Response)) {
      if (!(await closedSkillPayloadReadable(result as any, auth.agentId))) return NOT_FOUND();
    }
    // flair#1940 A3 (by-ID surface): the pointer is projected for THIS reader
    // BEFORE the trust block is attached. Admin/internal stay unfiltered (they
    // read the unredacted row, like every other field); a non-admin agent is
    // the reader the withheld rule protects. The FULL stored row goes through
    // the helper: the gated join renders a pointer ONLY when the row carries
    // its `id` and `instanceToken`, and an inline pointer field on the Memory
    // row is stripped from the returned object.
    let projected = result;
    if (result && typeof result === "object" && !(result instanceof Response)) {
      if (nonAdminAgent) {
        // A1' item 4 / A1-iv item 2: the gated join, through the ONE reader
        // helper (projectRowsThroughPointers) — pointer | "withheld" | nothing.
        projected = (await projectRowsThroughPointers([result as any], auth.agentId))[0];
      }
    }
    // flair#744 slice 1 — opt-in inline trust-evidence block, attached ONLY to
    // a genuine by-id record (never a NOT_FOUND `Response`, never null), and
    // ONLY after the ownership/read-scope gate above has already resolved. The
    // block informs the reader; it never re-enters an authority decision
    // (#735-spirit zero-authority invariant). Default OFF ⇒ the record is
    // returned untouched (attachTrust returns the same reference) ⇒
    // byte-identical to pre-slice-1.
    if (result && typeof result === "object" && !(result instanceof Response) && typeof (result as any).agentId === "string") {
      const ctx = (this as any).getContext?.();
      const withHits = await applyHitStats(projected, ctx);
      return attachTrust(withHits as any, wantsTrust(target, opts));
    }
    return projected;
  }

  /**
   * Override search() to scope collection GETs by authenticated agent.
   *
   * Security Critical: the agentId condition is wrapped as the outermost
   * `and` block so user-supplied query operators cannot bypass it via
   * boolean injection (e.g. [..., "or", { wildcard }]).
   *
   * Admin agents and unauthenticated internal calls pass through unfiltered.
   * Non-admin calls are scoped to the reader's own records at any visibility
   * plus every other agent's non-private records — the shipped open-within-org
   * read model. MemoryGrant is NOT consulted on reads; the one place the scope
   * is resolved is memory-read-scope.ts's resolveReadScope().
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
    if (gate.kind === "unfiltered") return overlayHitStatsResult(super.search(query), ctx);

    // Non-admin agent: scope to own records at any visibility plus every other
    // agent's non-private records (open-within-org; MemoryGrant is not
    // consulted on reads). Centralized in
    // memoryReadScope (record-type-kit.ts's makeReadScope(), parameterized
    // from RECORD_TYPES.Memory — see this file's header — delegating
    // "open-within-org" to memory-read-scope.ts's resolveReadScope()
    // unchanged) so get() above and search() here cannot drift.
    //
    // The scope condition is nested as the outermost AND block via
    // makeScopedSearch (record-type-kit.ts) — same correct composition
    // MemoryCandidate.search() already applies — so a caller-supplied
    // `operator: "or"` cannot boolean-inject past the owner scope.
    // Fetch pointers once per bounded chunk, then yield its projected rows
    // before consuming the next chunk (never one pointer query per row).
    const readerAgentId = gate.agentId;
    // flair#1940 round 18 (design ruling): a non-admin read ignores the caller's
    // `select`/`property`. For a REST read the auth middleware drops the
    // selection from the request URL before Harper parses it; for a direct
    // contextual read the selection is dropped here, before the scoped search,
    // so the gated pointer join below always sees the stored rows. This is a key
    // deletion, not a selection parser: the read runs on the same conditions,
    // operator, sort, limit and offset, unselected, and the hit-stat overlay
    // still runs on the full row.
    const source = memoryScopedSearch(readerAgentId, withoutCallerSelection(query), (q) =>
      withDetachedTxn(ctx, () => super.search(q)),
    );
    // A1-iv item 2 + round 22: stream in FIXED-SIZE chunks. Each chunk is
    // projected through the ONE reader helper (ONE batched pointer query for
    // that chunk) and yielded BEFORE the next chunk is read, so a non-admin
    // listing no longer buffers the reader's whole readable corpus and every
    // pointer query stays bounded. Result order and the per-row projection are
    // preserved (rows are yielded in source order, each through
    // applyHitStats). Pinned by test/unit/memory-host-source.test.ts
    // (r22-search-chunks) — RED if the chunked flush is reverted to one
    // whole-set buffer.
    const POINTER_JOIN_CHUNK = 200;
    const joined = (async function* joinPointerBatch() {
      let rows: any[] = [];
      const flush = async function* () {
        const batch = rows;
        rows = [];
        const projected = await projectRowsThroughPointers(batch, readerAgentId);
        for (const row of projected) {
          // flair#2139 S2 — close-payload bypass (see get()): filter a retained
          // closed skill payload the reader may not read. Open rows pass.
          if (!(await closedSkillPayloadReadable(row, readerAgentId))) continue;
          yield await applyHitStats(row, ctx);
        }
      };
      // memoryScopedSearch returns a Promise of the iterable (its scopedSearch
      // is async); await it before iterating.
      for await (const row of await (source as any)) {
        rows.push(row);
        if (rows.length >= POINTER_JOIN_CHUNK) yield* flush();
      }
      if (rows.length > 0) yield* flush();
    })();
    return joined;
  }

  async post(content: any, context?: any) {
    // flair#2141 S2: check the seed's fixed id against the operator-source
    // reservation (resources/seed-reservation.ts).
    const seedDenial = await refuseReservedSeedWrite("Memory", writeTargetIds(this, content), (this as any).getContext?.());
    if (seedDenial) return seedDenial;
    const contentSuffixDenial = refuseContentSuffixId(writeTargetIds(this, content), context);
    if (contentSuffixDenial) return contentSuffixDenial;
    const authorityDenial = await guardAuthorityFields(() => super.get(), content, "Memory");
    if (authorityDenial) return authorityDenial;
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
      // flair#1383: an identified pre-0.18.0 flair-client silently drops
      // writes client-side (including against another agent's shared
      // memories). Refuse the write path loudly; missing version is not
      // treated as old (current published clients do not send one yet).
      {
        const stale = refuseStaleClientWrite(ctx?.request, content);
        if (stale) return stale;
      }
      stripClientVersionPassthrough(content);
      // No-forge attribution — mode/field drawn from RECORD_TYPES.Memory
      // (record-types slice 2, flair#520) rather than a hand-typed literal.
      // "validate-truthy" (see record-type-kit.ts's stampAttribution doc):
      // reject a PRESENT, mismatched agentId; never stamp when absent (the
      // caller is expected to have set it).
      const attr = stampAttribution(auth, content, RECORD_TYPES.Memory.ownerField, RECORD_TYPES.Memory.attribution.post, "forbidden: cannot write memory owned by another agent");
      if (attr.denied) return attr.denied;
    }

    const postUrlTargetId = (this as any).getId?.();
    if (content && typeof content === "object" && content.id == null &&
      (typeof postUrlTargetId === "string" || typeof postUrlTargetId === "number")) {
      content.id = postUrlTargetId;
    }
    const postStored = content.id ? await (databases as any).flair.Memory.get(content.id) : null;
    canonicalizeSupersedes(content);
    const preparedSkill = await prepareSkillBody(content, postStored);
    if (preparedSkill instanceof Response) return preparedSkill;
    content = preparedSkill.content;

    // flair#744 slice A: citation-on-write — consume-and-strip, same
    // discipline as `claimedClient` below. Pull the optional
    // `usedMemoryIds` off the write body now, BEFORE anything else touches
    // `content`, so it is NEVER persisted on the Memory record itself.
    // Recording happens POST-COMMIT, only when this was present (see the
    // failure-isolated recordCitations() call near the return below) —
    // omitted ⇒ `undefined` ⇒ zero new calls, byte-identical behavior.
    const usedMemoryIds = content?.usedMemoryIds;
    if (content && typeof content === "object") delete content.usedMemoryIds;

    // ── flair#1238: refuse an unrecognised durability BEFORE defaulting ──
    // defaultVisibilityForDurability treats any non-permanent/persistent string
    // as the private branch, so an unknown durability via raw REST (or a future
    // non-Python adapter) is silently accepted and lands on the narrower private
    // branch by accident — fail-safe, but unvalidated by contract. Refusing at
    // the schema boundary makes it safe by construction (mirrors the visibility
    // guard below). Absent durability is accepted and defaulted to "standard".
    {
      const durabilityError = assertValidDurability(content.durability);
      if (durabilityError) {
        return new Response(
          JSON.stringify({ error: "invalid_durability", message: durabilityError }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }
    }

    content.durability ||= "standard";
    // ── flair#1542: skills are forced durability=persistent ──
    // A skill-tagged write must never be reaped by the 30-day reaper (the
    // "standard" default) nor expire (ephemeral/session). enforceSkillDurability
    // rejects ephemeral/session outright and forces every other value to
    // "persistent" — placed AFTER the default so it sees the effective tier,
    // and BEFORE the visibility default below so a skill lands on the
    // persistent→shared branch, not the standard→private one.
    {
      const skillDurabilityDenial = enforceSkillDurability(content);
      if (skillDurabilityDenial) return skillDurabilityDenial;
    }
    // ── flair#1336: honor a caller-supplied createdAt (parity with put()) ──
    // put() — the other HTTP-reachable create path — has always preserved the
    // caller's createdAt (`content.createdAt ?? now`), and adk-flair's
    // add_memory forwards MemoryEntry.timestamp through it for historical
    // imports. When #1336 moved client creates onto POST, this line's
    // unconditional re-stamp silently discarded those timestamps (caught by
    // the #1334 list-pagination live test: rows written with backdated
    // timestamps came back stamped "now"). Honoring the caller grants no new
    // capability — PUT already accepted arbitrary createdAt from the same
    // principals. validFrom below keys off createdAt and follows it, exactly
    // as on the put() path; updatedAt stays the true write moment; the
    // ephemeral expiresAt stamp keys off Date.now(), so a backdated create
    // cannot stretch the #1257 exposure window.
    const nowIso = new Date().toISOString();
    content.createdAt = content.createdAt ?? nowIso;
    content.updatedAt = nowIso;
    content.archived = content.archived ?? false;

    // ─── Default visibility (durability-keyed) — Layer 1, part A ────────────
    // post() only ever creates a NEW record — patchRecord/supersede-close
    // route through put() instead (see put()'s
    // pre-existing-record guard below), so there is no "don't overwrite an
    // existing record's visibility" concern here. Explicit visibility on the
    // write ALWAYS overrides; only stamp the default when the caller left it
    // unset. permanent|persistent → shared; standard|ephemeral|absent → private.
      // ── flair#1009: refuse an unrecognised visibility BEFORE defaulting ──
      // isPrivateVisibility() is an exact match on "private", so on the READ
      // side every other value (a typo, a wrong case, a retired tier like
      // "office") resolves to non-private and is readable by every agent on the
      // instance. #1006 closed that at the CLI flag and the MCP tool argument;
      // REST and the in-process API reach here without passing either.
      //
      // Refusing, rather than dropping the key: dropping it falls through to the
      // durability-keyed default below, which for a permanent or persistent
      // write is "shared" - the same widening, arrived at silently. A misspelled
      // argument must not decide who can read a memory.
      {
        const visibilityError = assertValidVisibility(content.visibility);
        if (visibilityError) {
          return new Response(
            JSON.stringify({ error: "invalid_visibility", message: visibilityError }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
        }
      }

      // ── flair#1257: ephemeral memories are private-only (hard precondition) ──
      // The durability-keyed default below sends ephemeral to "private", but a
      // default is not a constraint — an explicit visibility:"shared" here would
      // make continuity-journal entries org-readable AND federation-pushed.
      // Refused at the server so the boundary holds for every caller, not just
      // the hooks that promise to send "private". content.durability is already
      // defaulted ("standard" when absent) and enum-validated above, so this
      // sees the row's effective durability.
      {
        const tierError = assertVisibilityAllowedForDurability(content.durability, content.visibility);
        if (tierError) {
          return new Response(
            JSON.stringify({ error: "invalid_visibility_for_durability", message: tierError }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
        }
      }

    if (content.visibility === undefined || content.visibility === null) {
      content.visibility = defaultVisibilityForDurability(content.durability);
    }

    // supersedes: optional reference to the ID of the memory this one
    // replaces. Validates shape + cross-agent-write authorization (shared
    // with put() — see validateAndAuthorizeSupersedes doc).
    const supersede = await validateAndAuthorizeSupersedes(content, auth, ctx, postStored);
    if (supersede.denial) return supersede.denial;

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

    // A new row cannot be its own derivedFrom source (flair#2354).
    if (content.id != null && Array.isArray(content.derivedFrom) &&
        content.derivedFrom.some((sourceId: unknown) => String(sourceId) === String(content.id))) {
      return Response.json({
        error: "derived_from_self",
        message: "derivedFrom may not include the id of the memory being written",
      }, { status: 400 });
    }

    const expiryError = stampEphemeralExpiry(content);
    if (expiryError) return Response.json({ error: "invalid_expiry", message: expiryError }, { status: 400 });

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

    // ── flair#1542: SkillScan gate BEFORE the embed ──
    // Every skill-tagged write is statically scanned (shell/network/fs/env/
    // encoding/unicode) BEFORE any embedding is computed, so a rejected write
    // pays no embed. Fail-closed on high/critical; allow-with-flag on medium.
    // Non-skill writes are a no-op (skillScanGate returns null).
    {
      const skillScanDenial = skillScanGate(content);
      if (skillScanDenial) return skillScanDenial;
    }
    {
      const skillSourceDenial = refuseSkillWriteSource(content);
      if (skillSourceDenial) return skillSourceDenial;
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
    // must move together. flair#1542: skill-tagged rows embed from `trigger`
    // (skillEmbedText), not `content`.
    const embedText = skillEmbedText(content);
    if (embedText && !content.embedding) {
      const vec = await getEmbedding(embedText, "document");
      if (vec) { content.embedding = vec; content.embeddingModel = getModelId(); }
    }

    // ── flair#1940 slice 1 (A1'): the host pointer is NOT a Memory attribute. ──
    // Consume the write-body-only pointer inputs OUT of the row (they must
    // never be persisted on the Memory row), validate them, and build the
    // pointer row written alongside the Memory row below. A client-supplied
    // `hostSourceVisibility` is a FORGERY of the server's write-time stamp and
    // is dropped here (never read). Reject, never truncate/coerce.
    const pointerInputs = extractPointerInputs(content);
    // A1-iv item 3: strip every server-stamped field a client body may not set
    // (instanceToken, provenance). They are re-stamped below.
    stripServerStampedFields(content);
    // A1-iv item 1: a NEW row gets a server-stamped incarnation token.
    content.instanceToken = newInstanceToken();
    const pointer = buildPointerForWrite({ inputs: pointerInputs, memoryId: content.id ?? "", visibility: content.visibility, auth, memoryInstanceToken: content.instanceToken });
    if (pointer.denial) return pointer.denial;

    // Write-time provenance stamp (memory-provenance slice 1) — see
    // buildProvenance's doc above. Stamped last, right before persist, so it
    // reflects the final resolved `content.createdAt`.
    content.provenance = buildProvenance(auth, content.createdAt, content);
    // flair#1940 A4: `receivedAt` is SERVER-stamped inside provenance above; a
    // client-supplied top-level `receivedAt` is IGNORED (stripped here so it is
    // never persisted as a row field).
    delete content.receivedAt;
    // flair#718 authorship-provenance: `claimedClient` is a WRITE-BODY-ONLY
    // passthrough — buildProvenance above already folded it into
    // `provenance.claimed.client` (sanitized/capped). Strip it from the row
    // itself so it is NEVER persisted as a second, undeclared/unsanitized
    // top-level field — authorship lives in the provenance JSON only.
    delete content.claimedClient;

    // Write-time originatorInstanceId (federation-edge-hardening slice 1): a
    // post() is always a CREATE, so this instance's own id is stamped and any
    // request-body value is ignored — see resources/originator-instance.ts.
    await stampOriginatorOnCreate(content);
    // flair#1965 r2: the receiver-side federation bookkeeping (`_originatorInstanceId`
    // et al.) is a client-unsettable stamp; a CREATE must not carry one from the
    // body. See resources/originator-instance.ts.
    dropClientFederationBookkeeping(content);

    // ── Write the new record FIRST ──────────────────────────────────────────
    // A1' item 1: the guard keeps declared Memory attributes and the explicit
    // `UNDECLARED_ALLOWED` fields, so an undeclared key (including a pointer
    // field a raw writer tried to slip in) is dropped.
    // Pinned by test/unit/memory-host-source.test.ts (r20-post) — RED if this
    // call is removed.
    stripUndeclaredMemoryAttributes(content);
    if (isSkillWrite(content)) {
      const reservedId = [content?.id, (this as any).getId?.()].find((candidate) => isReservedSeedId("Memory", candidate));
      const skillResult = await writeSkillCreateOrUpdate({
        ctx, auth, content, storedRow: postStored, explicitPredecessor: preparedSkill.predecessor, method: "post", pointer,
        inPlaceId: reservedId != null ? String(reservedId) : null,
      });
      if (!(skillResult instanceof Response)) await markDerivedSourcesReflected(content);
      return skillResult;
    }
    // A1' item 2 (adjudication 0a): the Memory row and its pointer row share ONE
    // transaction. With a request context they join its open transaction; with
    // NO context (an internal direct call, e.g. new Memory().post(...))
    // withSharedWriteTransaction creates one, so a failed pointer write rolls
    // the Memory row back too instead of leaving it pointer-less.
    // Pinned by test/unit/memory-host-source.test.ts (r20-atomic) — RED if the
    // owned-transaction branch is bypassed.
    const postResult = await withSharedWriteTransaction(ctx, async (c) => {
      const newId = await writeMemoryRowPost((this as any).constructor, content, c);
      if (pointer.row) {
        pointer.row.memoryId = newId;
        const persistDenial = await persistPointerRow(pointer.row, c);
        if (persistDenial) return persistDenial;
      }
      return null;
    });
    if (postResult instanceof Response) return postResult;
    const result: any = {};
    // flair#1357 — read-your-write for the lexical leg. The table change feed
    // (resources/bm25-index-service.ts) is the CORRECTNESS mechanism; this
    // synchronous hook is what makes a store immediately searchable rather
    // than searchable-after-the-feed-turns.
    noteMemoryUpsert(content);
    // embedding-space-guard slice 1: keep the write-maintained latch current —
    // a persisted FOREIGN stamp (federation / replication / an explicit-stamp
    // write) trips the gate; a normal local write stamps the current id and
    // never does.
    noteWriteStamp(content?.embeddingModel as string | null | undefined);

    // ── THEN close the superseded record ────────────────────────────────────
    // Write-new-BEFORE-close-old: the previous order (close-old via a fire-
    // and-forget `.catch(()=>{})` BEFORE the new write) could tombstone the
    // old record and then lose the new one if the write failed afterward.
    // Now the safe failure state is two active records (recoverable), never
    // a lost write — and the failure is logged, never silently swallowed.
    await closeSupersededIfNeeded(ctx, content, supersede.close, "post");
    await markDerivedSourcesReflected(content);

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

  // PATCH routes past put(), so agentId immutability is enforced on both verbs
  // via the one shared delegate. (Admin/internal — including the _reindex
  // path in put() — pass through the delegate untouched.)
  async patch(content: any, query?: any) {
    // flair#2296: decided on the body as sent; the guards below add fields to it.
    const reembedRequest = isReembedPatch(content);
    // flair#2141 S2: check the seed's fixed id against the operator-source
    // reservation (resources/seed-reservation.ts).
    const seedDenial = await refuseReservedSeedWrite("Memory", writeTargetIds(this, content), (this as any).getContext?.());
    if (seedDenial) return seedDenial;
    const contentSuffixDenial = refuseContentSuffixId(writeTargetIds(this, content), query);
    if (contentSuffixDenial) return contentSuffixDenial;
    const authorityDenial = await guardAuthorityFields(() => super.get(), content, "Memory");
    if (authorityDenial) return authorityDenial;
    // flair#1383 — patch() routes past put(), so it needs its own refuse.
    {
      const stale = refuseStaleClientWrite((this as any).getContext?.()?.request, content);
      if (stale) return stale;
    }
    stripClientVersionPassthrough(content);
    // flair#1960 r2: capture the (undeclared) authorship-claim inputs BEFORE the
    // undeclared-attribute strip removes them, so a semantic PATCH re-stamps
    // provenance with the SAME claims a post()/put() would record from this body
    // (a PATCH body's `model`/`claimedClient` are folded into `claimed` only).
    const claimInputs = { model: (content as any)?.model, claimedClient: (content as any)?.claimedClient };
    // A1' item 1: patch() is a Memory writer too. Drop any pointer inputs and
    // every undeclared attribute here, so a PATCH can never carry a pointer
    // onto the row (the pointer is written ONLY by post()/put() and the table
    // resource). These paths discard the supplied pointer input and create no
    // pointer row; an existing pointer row stays bound to the updated Memory.
    // Pinned by test/unit/memory-host-source.test.ts (r20-patch) — RED if this
    // guard call is removed.
    extractPointerInputs(content);
    stripUndeclaredMemoryAttributes(content);
    // A1-iv item 3: strip server-stamped fields on patch too (a PATCH body may
    // not set instanceToken or provenance; the stored values stand).
    stripServerStampedFields(content);
    const denial = await guardOwnerFieldImmutable(this, () => super.get(), content, "agentId");
    if (denial) return denial;
    // Preserve stored visibility on updates before applying write policy: a
    // null is no change (PATCH merges), and a present value goes through the
    // same validator and ephemeral-tier guard as put().
    if (content && "visibility" in content && content.visibility == null) delete content.visibility;
    if (content && (content.visibility !== undefined || content.durability !== undefined)) {
      const durabilityError = assertValidDurability(content.durability);
      if (durabilityError) {
        return new Response(
          JSON.stringify({ error: "invalid_durability", message: durabilityError }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }
      const visibilityError = assertValidVisibility(content.visibility);
      if (visibilityError) {
        return new Response(
          JSON.stringify({ error: "invalid_visibility", message: visibilityError }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }
      const stored = await super.get();
      const tierError = assertVisibilityAllowedForDurability(
        content.durability ?? stored?.durability,
        content.visibility ?? stored?.visibility,
      );
      if (tierError) {
        return new Response(
          JSON.stringify({ error: "invalid_visibility_for_durability", message: tierError }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }
    }
    // ── flair#1542 + residual (Kern #1543 review 5135715289): reject skill patches ──
    // patch() routes past put() (and thus past the SkillScan gate + forced
    // durability), so a skill write on this verb would land unscanned. There are
    // TWO ways a patch is a skill write, and the mint-time check saw only the first:
    //   1. the PATCH BODY carries the skill tag — rejectSkillWritePath(content).
    //   2. the STORED record is ALREADY a skill, and the body mutates `content`
    //      (or anything else) WITHOUT re-declaring the tag. isSkillWrite(body) is
    //      then false, so the pre-residual check let the edit land — a skill's
    //      procedure could be rewritten with NO SkillScan (the residual). Fold
    //      the existing record into the check: a patch to a row whose STORED tags
    //      include `skill` is rejected the same as a mint-time skill write.
    // Skills are written via skill_store (→ Memory.post) or Memory.put; no
    // memory_patch tool exists and no internal path patches a skill row (hit-
    // tracking goes through table.put, not this override), so rejecting is safe.
    // flair#1965 r3 + flair#1960 r3: resolve the stored row ONCE, by the
    // URL-BOUND target id — refusing a body `id` that disagrees with the
    // address, and refusing a lookup that FAILS (a failed read is never "no
    // stored row"). This ONE resolved row drives BOTH rule sets: the skill-row
    // check and semantic-PATCH provenance decision below, AND the
    // originatorInstanceId create/update rule. The previous `.catch(() => null)`
    // turned a read ERROR into "no stored row"; isSemanticPatch returns false
    // for `null`, so the patch fell through to `super.patch()` as a
    // METADATA-ONLY write and kept a legacy stored blob — including a
    // caller-chosen `verified.timestamp` — in place, and (b) stamped a CREATE
    // over a row that actually exists. See resources/originator-instance.ts's
    // resolveStoredRow.
    const resolvedStored = await resolveStoredRow(this, "Memory", content, () => super.get());
    if (resolvedStored.denial) return resolvedStored.denial;
    const existingForSkill = resolvedStored.row;
    // flair#2296: re-embed intentionally changes only embedding, embeddingModel
    // and updatedAt; the whole re-read row is submitted to put.
    // flair#2390: the vector is computed OUTSIDE the write. The write itself
    // re-reads the committed row inside its own transaction (reembedStoredRow),
    // builds the record from that row, and re-checks the owner and the text, so
    // an edit committed while the vector was computed is kept, and the vector
    // written is the one for the text of the re-read row.
    if (reembedRequest) {
      if (!existingForSkill) return NOT_FOUND();
      const auth = await resolveAgentAuth((this as any).getContext?.());
      if (auth.kind === "agent" && !auth.isAdmin &&
          isForbiddenOwnerMutation(existingForSkill, RECORD_TYPES.Memory.ownerField, auth.agentId)) {
        return FORBIDDEN("forbidden: cannot write memory owned by another agent");
      }
      const embedText = skillEmbedText(existingForSkill);
      if (typeof embedText !== "string" || embedText.length === 0) {
        return Response.json({ error: "reembed_no_text", message: "the stored row has no text to embed" }, { status: 422 });
      }
      // Test-only: inert unless the fault-injection env opt-in is set and armed.
      const pause = txnPausePoint("memory-reembed");
      if (pause) await pause;
      const embedding = await getEmbedding(embedText, "document");
      if (!isUsableEmbeddingVector(embedding)) {
        return Response.json({ error: "embedding_unavailable", message: "the embedding engine returned no vector; the stored row is unchanged, retry" }, { status: 503 });
      }
      return reembedStoredRow(String(existingForSkill.id), existingForSkill, embedding, auth, (this as any).getContext?.());
    }
    const skillDenial = rejectSkillWritePath(content) ?? rejectSkillWritePath(existingForSkill);
    if (skillDenial) return skillDenial;
    // ── flair#1960 r2: a SEMANTIC patch re-stamps provenance ────────────────
    // patch() strips a caller-supplied `provenance` (above) so a body can never
    // SET a `verified.*` field, but stripping alone would leave the STORED blob
    // in place — including a legacy row whose `verified.timestamp` came from a
    // client `createdAt` before this release. A patch that changes the record's
    // content is a fresh authored write, so it re-stamps from the resolved auth
    // and ONE server clock read (never the caller's `createdAt`, never a carried-
    // forward stored value). A metadata-only patch (no semantic field changes)
    // keeps the stored, previously-stamped blob: no new content was authored, so
    // there is no new write to attribute. See resources/provenance.ts
    // (isSemanticPatch / MEMORY_SEMANTIC_FIELDS) for the field set.
    if (isSemanticPatch(content, existingForSkill, MEMORY_SEMANTIC_FIELDS)) {
      const ctx = (this as any).getContext?.();
      const auth = await resolveAgentAuth(ctx);
      content.provenance = buildProvenance(
        auth,
        content.createdAt ?? existingForSkill?.createdAt,
        claimInputs,
      );
    }
    // flair#1965 r2: a PATCH over an EXISTING row keeps the stored
    // originatorInstanceId (a body value is dropped); a PATCH whose URL target
    // has NO stored row is a CREATE when it reaches the table — Harper's patch
    // path has no existing-row requirement — so it must stamp the local id
    // rather than leave the new row un-stamped. Only an administrator's or a
    // trusted internal PATCH gets that far; the table guard
    // (resources/table-patch-policy.ts) refuses the rest. See
    // resources/originator-instance.ts.
    await applyOriginatorInstanceId(content, existingForSkill);
    // The receiver-side federation bookkeeping keeps its stored value (a patch
    // merges); a client body value is dropped.
    dropClientFederationBookkeeping(content);
    const expiryError = stampEphemeralExpiry(content, existingForSkill);
    if (expiryError) return Response.json({ error: "invalid_expiry", message: expiryError }, { status: 400 });
    return super.patch(content, query);
  }

  async put(content: any, query?: any) {
    const reembedding = content?.embedding === null && content?.embeddingModel === null;
    // flair#2141 S2: check the seed's fixed id against the operator-source
    // reservation (resources/seed-reservation.ts).
    const seedDenial = await refuseReservedSeedWrite("Memory", writeTargetIds(this, content), (this as any).getContext?.());
    if (seedDenial) return seedDenial;
    const contentSuffixDenial = refuseContentSuffixId(writeTargetIds(this, content), query);
    if (contentSuffixDenial) return contentSuffixDenial;
    const __ownerDenial = await guardOwnerFieldImmutable(this, () => super.get(), content, "agentId");
    if (__ownerDenial) return __ownerDenial;
    // Reindex bypass: an admin-only escape hatch that re-PUTs declared and named
    // retained fields (no updatedAt bump, no embedding regen, no safety rescan)
    // so Harper repopulates secondary indices. The row is built by
    // buildReindexRow, the path this branch shares with the MemoryReindex admin
    // endpoint's write-back. Other undeclared fields are stripped and
    // an absent incarnation token is generated. Because this skips safety and
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
      // flair#1965 r3: resolve the stored row by the URL-BOUND target id (never a
      // body id alone); a body id that disagrees with the address, or a lookup
      // that FAILS, refuses the reindex. A reindex is a re-PUT of an EXISTING
      // row, so an absent stored row is refused too — a failed read must never
      // be read as "no row" and re-created/re-stamped. See
      // resources/originator-instance.ts's resolveStoredRow.
      const resolvedReindex = await resolveStoredRow(this, "Memory", content, () => super.get());
      if (resolvedReindex.denial) return resolvedReindex.denial;
      const built = buildReindexRow(content, resolvedReindex.row);
      if (!("row" in built)) {
        return new Response(
          JSON.stringify({ error: built.error, message: built.message }),
          { status: built.status, headers: { "content-type": "application/json" } },
        );
      }
      const reindexed = await super.put(content);
      noteMemoryUpsert(content);
      noteWriteStamp(content?.embeddingModel as string | null | undefined); // embedding-space-guard slice 1 (see post())
      return reindexed;
    }

    const authorityDenial = await guardAuthorityFields(() => super.get(), content, "Memory");
    if (authorityDenial) return authorityDenial;
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
      // flair#1383 — same write-path refuse as post().
      {
        const stale = refuseStaleClientWrite(ctx?.request, content);
        if (stale) return stale;
      }
      stripClientVersionPassthrough(content);
      // No-forge attribution — mode/field drawn from RECORD_TYPES.Memory,
      // same rule as post(). "validate-truthy" (see record-type-kit.ts's
      // stampAttribution doc).
      const attr = stampAttribution(auth, content, RECORD_TYPES.Memory.ownerField, RECORD_TYPES.Memory.attribution.put, "forbidden: cannot write memory owned by another agent");
      if (attr.denied) return attr.denied;
    }

    const resolvedExisting = await resolveStoredRow(this, "Memory", content, () => super.get());
    if (resolvedExisting.denial) return resolvedExisting.denial;
    const preExisting = resolvedExisting.row;
    canonicalizeSupersedes(content);
    const requestedPayload = { ...content };
    const urlTargetId = (this as any).getId?.();
    if (content && typeof content === "object" && content.id == null &&
      (typeof urlTargetId === "string" || typeof urlTargetId === "number")) {
      content.id = urlTargetId;
    }
    const preparedSkill = await prepareSkillBody(content, preExisting);
    if (preparedSkill instanceof Response) return preparedSkill;
    content = preparedSkill.content;

    // flair#744 slice A: citation-on-write — same consume-and-strip
    // discipline as post() above. Strip BEFORE anything else touches
    // `content` so it is never persisted on the row; recorded post-commit
    // below only when present.
    const usedMemoryIds = content?.usedMemoryIds;
    if (content && typeof content === "object") delete content.usedMemoryIds;

    // ── flair#1238: refuse an unrecognised durability (mirrors post()) ──
    // put() is the other HTTP-reachable write path (fresh create via CLI, and
    // the update/patch path). Same guard as post(): a present-but-unknown
    // durability is refused with 400; absent is accepted.
    {
      const durabilityError = assertValidDurability(content.durability);
      if (durabilityError) {
        return new Response(
          JSON.stringify({ error: "invalid_durability", message: durabilityError }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }
    }

    // ── flair#1542: skills are forced durability=persistent (mirrors post()) ──
    // put() stamps no durability default (updates carry the pre-existing tier),
    // so this runs on the raw write value: a skill-tagged write with an explicit
    // ephemeral/session tier is rejected, and every other value (including an
    // absent one) is forced to "persistent" so the reaper never archives a skill.
    {
      const skillDurabilityDenial = enforceSkillDurability(content);
      if (skillDurabilityDenial) return skillDurabilityDenial;
    }

    const now = new Date().toISOString();
    content.updatedAt = now;
    // Set defaults that post() sets — put() is also used for new records via CLI
    content.archived = content.archived ?? false;
    content.createdAt = content.createdAt ?? now;


    // Preserve stored visibility on updates before applying write policy
    // (only the two writable values; the guards below see the result).
    if (
      preExisting &&
      (content.visibility === undefined || content.visibility === null) &&
      (preExisting.visibility === PRIVATE_VISIBILITY || preExisting.visibility === SHARED_VISIBILITY)
    ) {
      content.visibility = preExisting.visibility;
    }

    // ─── Default visibility (durability-keyed) — Layer 1, part A ────────────
    // Explicit visibility on the write ALWAYS overrides; only stamp the
    // default when the caller left it unset AND this is a fresh record.
    // permanent|persistent → shared; standard|ephemeral|absent → private.
      // ── flair#1009: refuse an unrecognised visibility BEFORE defaulting ──
      // isPrivateVisibility() is an exact match on "private", so on the READ
      // side every other value (a typo, a wrong case, a retired tier like
      // "office") resolves to non-private and is readable by every agent on the
      // instance. #1006 closed that at the CLI flag and the MCP tool argument;
      // REST and the in-process API reach here without passing either.
      //
      // Refusing, rather than dropping the key: dropping it falls through to the
      // durability-keyed default below, which for a permanent or persistent
      // write is "shared" - the same widening, arrived at silently. A misspelled
      // argument must not decide who can read a memory.
      {
        const visibilityError = assertValidVisibility(content.visibility);
        if (visibilityError) {
          return new Response(
            JSON.stringify({ error: "invalid_visibility", message: visibilityError }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
        }
      }

      // ── flair#1257: ephemeral memories are private-only (hard precondition) ──
      // Same rule as post(), with one PUT-specific wrinkle: an update payload
      // may omit durability entirely (put() stamps no durability default), so
      // `PUT /Memory/<id> {"visibility":"shared"}` against a stored ephemeral
      // row names no durability of its own — the EFFECTIVE durability is the
      // pre-existing row's, and the flip must refuse just like a fresh
      // ephemeral+shared create. An explicit durability on the write wins: a
      // write that promotes the row OUT of ephemeral (e.g. distillation lifting
      // it to persistent, #1205) while sharing it is a legitimate promotion,
      // not an ephemeral share. preExisting was fetched above.
      {
        const effectiveDurability = content.durability ?? preExisting?.durability;
        const tierError = assertVisibilityAllowedForDurability(effectiveDurability, content.visibility);
        if (tierError) {
          return new Response(
            JSON.stringify({ error: "invalid_visibility_for_durability", message: tierError }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
        }
      }

    if (!preExisting && (content.visibility === undefined || content.visibility === null)) {
      content.visibility = defaultVisibilityForDurability(content.durability);
    }

    const expiryError = stampEphemeralExpiry(content, preExisting);
    if (expiryError) return Response.json({ error: "invalid_expiry", message: expiryError }, { status: 400 });

    // supersedes: optional reference to the ID of the memory this one
    // replaces. Validates shape + cross-agent-write authorization (shared
    // with post() — see validateAndAuthorizeSupersedes doc for why PUT needs
    // this too: it's the only HTTP-reachable create path).
    const supersede = await validateAndAuthorizeSupersedes(content, auth, ctx, preExisting);
    if (supersede.denial) return supersede.denial;
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

    // ── flair#1542: SkillScan gate BEFORE the embed (mirrors post()) ──
    // Every skill-tagged write is statically scanned before any embedding is
    // computed, so a rejected write pays no embed. Fail-closed on high/critical;
    // allow-with-flag on medium. Non-skill writes are a no-op.
    {
      const skillScanDenial = skillScanGate(content);
      if (skillScanDenial) return skillScanDenial;
    }
    {
      const skillSourceDenial = refuseSkillWriteSource(content);
      if (skillSourceDenial) return skillSourceDenial;
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
    const embedText = skillEmbedText(content);
    if (embedText && !content.embedding) {
      const vec = await getEmbedding(embedText, "document");
      if (vec) { content.embedding = vec; content.embeddingModel = getModelId(); }
    }

    // If archiving, record who + when
    if (content.archived === true && !content.archivedAt) {
      content.archivedAt = now;
      // archivedBy should be set by the caller (CLI stamps req.tpsAgent via query param)
    }

    // ── flair#1940 slice 1 (A1'): the host pointer is NOT a Memory attribute. ──
    // Identical rule to post(): consume the write-body-only pointer inputs OUT
    // of the row, validate them, and build the pointer row written alongside
    // the Memory row below. A client-supplied `hostSourceVisibility` is dropped
    // (never read). Reject, never truncate/coerce.
    const pointerInputs = extractPointerInputs(content);
    // A1-iv item 3: strip server-stamped fields (a client may not set them).
    stripServerStampedFields(content);
    // A1-iv item 1: PRESERVE the existing row's incarnation token on an update,
    // else generate one (a fresh create via put).
    stampInstanceToken(content, preExisting);
    // A1'' item 5: a partial PUT (one that omits `visibility`, e.g. a
    // memory_update full put) must stamp scopeAtWrite from the record's
    // EFFECTIVE visibility — the existing row's when the body omits it — not
    // from an undefined body value that would wrongly yield author-only.
    const effectiveVisibility = content.visibility ?? preExisting?.visibility;
    // A partial PUT carries the stored visibility it read at the start of the
    // request (one carry, above, before the write-policy guards).
    // Adjudication B (round 4): load the stored pointer row so an echo of it is
    // recognised and not replaced (see buildPointerForWrite).
    let storedPointer: PointerRow | null = null;
    if (
      content.id &&
      pointerInputs.hostSource !== undefined &&
      pointerInputs.hostSource !== null &&
      pointerInputs.hostSourceScope === undefined
    ) {
      storedPointer = await loadStoredPointer(content.id);
    }
    const pointer = buildPointerForWrite({ inputs: pointerInputs, memoryId: content.id ?? "", visibility: effectiveVisibility, auth, memoryInstanceToken: content.instanceToken, storedPointer });
    if (pointer.denial) return pointer.denial;

    // Write-time provenance stamp (memory-provenance slice 1) — see
    // buildProvenance's doc above post(). Applies to every put() (fresh
    // create AND update/patch) — never gated on preExisting, so an update
    // always gets a freshly-stamped provenance reflecting the CURRENT
    // authenticated actor performing this write.
    content.provenance = buildProvenance(auth, content.createdAt, content);
    // flair#1940 A4: a client-supplied `receivedAt` is IGNORED (stripped; the
    // server's receipt time lives inside provenance, stamped above).
    delete content.receivedAt;
    // flair#718 authorship-provenance — see post()'s identical comment above:
    // strip the write-body-only `claimedClient` passthrough now that it's
    // folded into `provenance.claimed.client`. Never persisted as a row field.
    delete content.claimedClient;

    // Write-time originatorInstanceId (federation-edge-hardening slice 1):
    // a CREATE (no pre-existing row) stamps this instance's own id, ignoring
    // any body value; an UPDATE keeps the STORED value — a body value neither
    // replaces nor clears it. A federation-synced record never reaches this
    // method at all (the merge path writes via the raw table handle). See
    // resources/originator-instance.ts.
    await applyOriginatorInstanceId(content, preExisting);
    // The receiver-side federation bookkeeping stands as stored on an update,
    // and a client body may not set it on a create. See
    // resources/originator-instance.ts.
    applyFederationBookkeeping(content, preExisting);

    // ── Write the new/updated record FIRST ──────────────────────────────────
    // A1' item 1: persist ONLY declared Memory attributes (see post()).
    // Pinned by test/unit/memory-host-source.test.ts (r20-put) — RED if this
    // call is removed.
    stripUndeclaredMemoryAttributes(content);
    if (isSkillWrite(content)) {
      const reservedId = [content?.id, (this as any).getId?.()].find((candidate) => isReservedSeedId("Memory", candidate));
      return await writeSkillCreateOrUpdate({
        ctx, auth, content, storedRow: preExisting, explicitPredecessor: preparedSkill.predecessor, method: "put", pointer,
        reembedding, requestedPayload,
        inPlaceId: reservedId != null ? String(reservedId) : null,
      });
    }
    // A1' item 2 (adjudication 0a): share ONE transaction with the pointer row
    // (see post()). The shared helper's owned-transaction branch is pinned by
    // test/unit/memory-host-source.test.ts (r20-atomic, which drives POST);
    // request-context PUT rollback is pinned by
    // test/integration/host-source-atomicity-1940.test.ts (t2).
    const putResult = await withSharedWriteTransaction(ctx, async (c) => {
      const r: any = await (databases as any).flair.Memory.put(content, c);
      if (pointer.row) {
        pointer.row.memoryId = r?.id ?? content.id ?? "";
        const persistDenial = await persistPointerRow(pointer.row, c);
        if (persistDenial) return persistDenial;
      }
      return r;
    });
    if (putResult instanceof Response) return putResult;
    const result: any = putResult;
    // flair#1357 — read-your-write for the lexical leg (see post()).
    noteMemoryUpsert(content);
    noteWriteStamp(content?.embeddingModel as string | null | undefined); // embedding-space-guard slice 1 (see post())

    // ── THEN close the superseded record (see post()) ───────────────────────
    await closeSupersededIfNeeded(ctx, content, supersede.close, "put");

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
    const ctx = (this as any).getContext?.();
    const auth = await resolveAgentAuth(ctx);
    if (auth.kind === "anonymous") return UNAUTH();
    // flair#2141 S2: check the seed's fixed id against the operator-source
    // reservation (resources/seed-reservation.ts).
    const seedDenial = reservedSeedWriteDenial(
      "Memory", [id, ...writeTargetIds(this, id && typeof id === "object" ? id : undefined)], ctx, auth,
    );
    if (seedDenial) return seedDenial;
    const contentSuffixDenial = refuseContentSuffixId(
      [id, ...writeTargetIds(this, id && typeof id === "object" ? id : undefined)], id,
    );
    if (contentSuffixDenial) return contentSuffixDenial;
    // Read stored ownership, not the read-scoped get() response. Enforce here
    // as well as middleware so MCP/in-process callers have the same policy.
    const record = await super.get(id);
    if (auth.kind === "agent" && !auth.isAdmin &&
        isForbiddenOwnerMutation(record, RECORD_TYPES.Memory.ownerField, auth.agentId)) {
      return FORBIDDEN("forbidden: cannot delete memory owned by another agent");
    }

    const reservedSeed = [id, (this as any).getId?.(), ...writeTargetIds(this, id && typeof id === "object" ? id : undefined)]
      .some((candidate) => isReservedSeedId("Memory", candidate));
    if (!reservedSeed && rowIsSkill(record)) {
      // flair#2355: hold the row still before the version writer's transaction
      // opens, so a competing owner change can commit first and be seen by the
      // confirmation read inside.
      const beforeSkillDelete = txnPausePoint("memory-skill-delete-pre");
      if (beforeSkillDelete) await beforeSkillDelete;
      return await writeSkillDelete({ ctx, auth, record });
    }
    // Durability controls retention, not the owner's authority to delete.
    // A1' item 2 (adjudication 0a/0c): the Memory delete and its pointer
    // delete share ONE transaction; with no request context
    // withSharedWriteTransaction creates one. A failing pointer delete aborts
    // it, so nothing is deleted; failures are NOT swallowed.
    // A request-owned transaction may still abort after this method returns.
    // Its committed change feed updates BM25 after commit; only a transaction
    // owned here can use the synchronous hook after the shared write returns.
    // Capture ownership before the helper changes the context's transaction.
    const requestOwnsTransaction = isJoinableTransaction(ctx);
    const deletionActor = auth.kind === "agent" ? auth.agentId : null;
    const deletionSourceClass: "agent" | "admin" | "internal" =
      auth.kind === "internal" ? "internal" : auth.isAdmin ? "admin" : "agent";
    // flair#2355: hold the row still before the delete stages, so a competing
    // owner change can commit first and be seen by the re-read inside. This
    // ordinary delete runs through withSharedWriteTransaction, which JOINS a
    // request-owned transaction when one exists and creates one otherwise.
    const beforeDelete = txnPausePoint("memory-delete-pre");
    if (beforeDelete) await beforeDelete;
    const deleteResult = await withSharedWriteTransaction(ctx, async (c) => {
      const deletedId = typeof id === "string" ? id : record?.id;
      if (typeof deletedId !== "string" || !deletedId) return false;
      const stored = await (databases as any).flair.Memory.get(deletedId, c);
      if (!stored) return false;
      const nonAdmin = auth.kind === "agent" && !auth.isAdmin;
      if (nonAdmin && isForbiddenOwnerMutation(stored, RECORD_TYPES.Memory.ownerField, auth.agentId)) {
        // The caller passed the owner check at the pre-read above, so a
        // mismatch here is a change committed since — refuse it, do not delete.
        return ownerChangedRefusal("Memory");
      }
      if (nonAdmin) {
        // Test-only: the transaction pauses between its ownership read and its
        // delete.
        const pause = txnPausePoint("memory-delete");
        if (pause) await pause;
        // Confirmation read of the COMMITTED row in an explicit fresh context
        // (never contextless — see resources/owner-delete-recheck.ts's header).
        const confirmed = await (databases as any).flair.Memory.get(deletedId, {});
        if (confirmed && isForbiddenOwnerMutation(confirmed, RECORD_TYPES.Memory.ownerField, auth.agentId)) {
          return ownerChangedRefusal("Memory");
        }
      }
      const d = await (databases as any).flair.Memory.delete(deletedId, c);
      if (d !== true) throw new Error("Memory row delete was not confirmed");
      const pointerDenial = await deletePointerRow(deletedId, c);
      if (pointerDenial) return pointerDenial;
      await recordMemoryDeletion({
        memoryId: deletedId,
        memoryInstanceToken: stored.instanceToken ?? null,
        durability: stored.durability ?? null,
        actor: deletionActor,
        sourceClass: deletionSourceClass,
      }, c);
      return d;
    });
    if (deleteResult instanceof Response) return deleteResult;
    if (deleteResult === false) return false;
    // Use the RESOLVED deleted id (a by-record delete carries only `id`, so the
    // stored row's id is the fallback). An owned transaction has committed;
    // a request-owned write waits for the committed change feed instead.
    const resolvedDeletedId = typeof id === "string" ? id : record?.id;
    if (!requestOwnsTransaction && typeof resolvedDeletedId === "string" && resolvedDeletedId.length > 0) {
      noteMemoryDelete(resolvedDeletedId);
    }
    if (typeof id === "string") await clearHitStats(id, ctx).catch(() => {});
    return deleteResult;
  }
}
