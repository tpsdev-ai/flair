import { isEmptyEmbedding, normalizeEmptyEmbedding } from "./memory-embedding-value.js";
import { discardSuppliedVector, suppliedVectorFlags } from "./memory-supplied-vector.js";
import { databases } from "harper";
import { randomUUID } from "node:crypto";
import { isOperatorSeedPut, redactMemoryWrite, redactSkillWrite, storedMemoryText, suppliedMemoryTextFields, suppliedStoredTextFields, type StoredMemoryText, type StoredTextField } from "./memory-redaction.js";
import { REDACTION_RULES, buildFromAllowlist, storageResult, withheldWriteResult, writeResultResponse, type FieldRules } from "./memory-write-response.js";
import { isDeepStrictEqual } from "node:util";
import { patchRecord, withDetachedTxn } from "./table-helpers.js";
import { annotatedCallerIsAdmin, resolveAgentAuth, type AgentAuthVerdict } from "./agent-auth.js";
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
import { putPointerRow, deletePointerRowViaTable, restorePointerRowIfAbsent, PointerAlreadyStoredError } from "./host-pointer-adapter.js";
import { DECLARED_MEMORY_ATTRIBUTES, stripUndeclaredMemoryAttributes, stripServerStampedFields } from "./memory-declared-attributes.js";
import { composesCallerWrite, isJoinableTransaction, withOwnedTransaction, withSharedWriteTransaction } from "./request-transaction.js";
import { PredecessorVisibilityChanged, applyGrantedVisibility, committedVisibilityDiffers, predecessorVisibilityChangedRefusal } from "./grant-visibility.js";
import { CommittedRowChanged, GrantedCloseRevoked, confirmCommittedRow, grantedCloseRevokedRefusal, sameStoredRow, storedRowChangedRefusal, verifyCommittedFields, writeGrantHeld } from "./write-back.js";
import { PAUSE_LIMIT_MS, txnPausePoint } from "./txn-pause-point.js";
import {
  markMemoryWriteOutcomeUnknown,
  memoryWriteOutcomeUnknown,
  memoryBusyResponse,
  memoryLockUnavailableResponse,
  boundLockedProviderCall,
  memoryLockedProviderTimeoutMs,
  MemoryProviderTimeout,
  memoryProviderTimeoutResponse,
  withMemoryWriteLock,
  writeOutcomeUnknownResponse,
  type MemoryLockOutcome,
} from "./memory-write-lock.js";
import { assertValidDurability, stampEphemeralExpiry } from "./memory-durability.js";
import { embedTextField, enforceSkillDurability, isSkillWrite, type MemoryEmbeddingInputField, rejectSkillWritePath, refuseSkillWriteSource, skillEmbedText, skillScanGate, skillMetadataHasDuplicateKey } from "./skill-write.js";
import { embeddedTextHash, hashEmbeddedText } from "./memory-embed-hash.js";
import { afterCloseStaged, buildSkillSuccessorRow, closedSkillPayloadReadable, defaultSkillHooks, grantedSkillClose, resolveSkillHead, rowIsSkill, runSkillVersionWrite, skillVersionVisibility, skillPayloadUnchanged, prepareSkillBody, validateSkillSnapshots, authorizeSkillOwners, skillWriteConflict } from "./skill-version-write.js";
import { SKILL_SUBJECT_TYPE, removeAppendedVersion } from "./instruction-version-record.js";
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
import { recordMemoryDeletion, removeMemoryDeletionRecords } from "./memory-deletion-history.js";
import { applyHitStats, clearHitStats, overlayHitStatsResult } from "./hit-tracking.js";
import { applyPromotionBinding } from "./promotion-binding.js";
import type { PointerRow } from "./host-source-visibility.js";
import { refuseStaleClientWrite, stripClientVersionPassthrough } from "./client-version-gate.js";
import { refuseReservedSeedWrite, reservedSeedWriteDenial, reservedSeedSubjectDenial, isReservedSeedId, writeTargetIds } from "./seed-reservation.js";
import { refuseContentSuffixId, resolveMemoryReferenceId, supersedesTargetMissing, supersedesTargetUnreadable } from "./memory-id-guard.js";
import { guardObjectBody } from "./object-body-guard.js";

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

function projectMemoryRead(table: any, row: any, target: any, ctx: any, byId = false): any {
  if (row == null || row instanceof Response || typeof row !== "object") return row;
  const select = byId && table.loadAsInstance !== false && target?.property
    ? target.property : target?.select || target?.property;
  if (!select) return row;
  const selected = table.transformEntryForSelect(select, ctx, table._readTxnForContext(ctx))({ key: row.id, value: row });
  return byId && selected === null ? Response.json(null) : selected;
}

/**
 * Write the Memory row joining transaction `c` (0a). Resource.prototype.post
 * uses the instance's OWN `#context`, which an internal caller (a direct
 * `new Memory().post(...)`) does not have, and the base table has no `post` —
 * so the base collection `create(id, record, context)` is used, which honours
 * an explicit context and joins `c.transaction`. Returns the new id. Falls
 * back to the static post for the unit mock (which models post, not create).
 * flair#2561: a Response from the storage layer is returned as the
 * `write_response_withheld` refusal (storageResult), never as an id.
 */
async function writeMemoryRowPost(cls: any, content: any, c: any): Promise<string | Response> {
  if (typeof cls?.create === "function") {
    const created: any = storageResult(await cls.create(content.id ?? null, content, c));
    if (created instanceof Response) return created;
    if (typeof created === "string") return created;
    const id = created?.getId?.() ?? created?.id;
    return typeof id === "string" ? id : withheldWriteResult();
  }
  const r: any = storageResult(await (databases as any).flair.Memory.post(content, c));
  if (r instanceof Response) return r;
  const id = typeof r === "string" ? r : r?.id;
  return typeof id === "string" ? id : withheldWriteResult();
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
 * flair#2478 slice 1 — the `Memory.primaryStore` write-lock handle. Production
 * is a real Harper table (a `primaryStore` with `tryLock`/`unlock`). A store
 * without a lock reports `unavailable`, and PUT/PATCH refuse with 503
 * `memory_lock_unavailable`; they never run unserialized. A unit-test double
 * supplies a lock on its mock table's `primaryStore`.
 */
function memoryWriteLockStore(): unknown {
  return (databases as any)?.flair?.Memory?.primaryStore;
}

/** The lock ids a Memory verb names: the URL-bound id and body id(s), dropping
 *  non-id values so the sorted, deduplicated key set is real. */
function putLockIds(resource: unknown, content?: unknown): string[] {
  return writeTargetIds(resource, content)
    .filter((id) => typeof id === "string" || typeof id === "number")
    .map((id) => String(id));
}

/** The lock ids a POST names: the addressed/body ids plus its `supersedes`
 *  reference, which post() has already resolved to its canonical id
 *  (canonicalizeSupersedes), the id the predecessor read and the close name.
 *  A pure create under a fresh server-allocated id names no id and takes no
 *  lock (the design's create case). */
function postLockIds(resource: unknown, content?: unknown): string[] {
  const ids = putLockIds(resource, content);
  const supersedes = (content as { supersedes?: unknown } | null | undefined)?.supersedes;
  if (typeof supersedes === "string" || typeof supersedes === "number") ids.push(String(supersedes));
  return [...new Set(ids)];
}

/** The lock ids a DELETE names: the addressed id and any body id(s), dropping
 *  non-id values. delete() adds the live head a skill DELETE closes. */
function deleteLockIds(resource: unknown, id: unknown): string[] {
  const ids = putLockIds(resource, id && typeof id === "object" ? id : undefined);
  if (typeof id === "string" || typeof id === "number") ids.push(String(id));
  return ids;
}

/** Attempts of a DELETE to lock the live head its skill writer closes, when
 *  the head changes between its discovery and the writer's read. */
const SKILL_DELETE_HEAD_ATTEMPTS = 3;

/** The ids a DELETE holds, and whether the skill writer found the head it
 *  closes outside them (flair#2478). */
interface SkillDeleteHeadLock {
  ids: readonly string[];
  outside: boolean;
}

/** Discovery only, with no lock held: when the addressed row is a skill row,
 *  the live head a DELETE of it closes (resolveSkillHead), if that head is
 *  another row (an older version's DELETE closes its subject's head). `read`
 *  reads the addressed row as deleteLocked's first read does. The skill writer
 *  checks the head again under the locks. A discovery read that fails, or
 *  finds more than one live head, adds no head: the skill writer's own read
 *  under the locks then refuses as it does on that failure, or, when it finds
 *  a head the DELETE does not hold, writes nothing. */
async function skillDeleteHeadId(read: () => Promise<any>): Promise<string | null> {
  try {
    const record = await read();
    if (!record || !rowIsSkill(record)) return null;
    const head = await resolveSkillHead(String(record.skillSubjectId ?? record.id), String(record.id), {});
    return head && String(head.id) !== String(record.id) ? String(head.id) : null;
  } catch {
    return null;
  }
}

/** The caller id a lock-miss refusal carries — the request's agent annotation,
 *  else `anonymous`/`internal`. Never stored-row state (Sherlock S7). */
function memoryLockCallerId(resource: any): string {
  const ctx = resource?.getContext?.();
  const request = ctx?.request ?? ctx;
  if (typeof request?.tpsAgent === "string" && request.tpsAgent.length > 0) return request.tpsAgent;
  if (request?.tpsAnonymous === true) return "anonymous";
  return "internal";
}

/** Map a lock outcome to its refusal `Response`, or `null` when the verb ran. */
function memoryLockRefusal(outcome: MemoryLockOutcome<unknown>, callerId: string): Response | null {
  if (outcome.kind === "busy") return memoryBusyResponse(callerId);
  if (outcome.kind === "unknown") return writeOutcomeUnknownResponse();
  if (outcome.kind === "unavailable") return memoryLockUnavailableResponse();
  return null;
}

/** PUT and PATCH require a target id before entering the lock helper. */
function memoryIdRequiredResponse(): Response {
  return new Response(
    JSON.stringify({
      error: "memory_id_required",
      message: "a Memory PUT or PATCH names the memory id in the URL or the body; to create a memory without choosing an id, use POST",
    }),
    { status: 400, headers: { "content-type": "application/json" } },
  );
}

/**
 * The durable fields a PUT's post-commit read must still find at the value the
 * write declared (flair#2478). A field the write did not declare is not compared
 * — the stored value stands for it. `archived` is not compared: the maintenance
 * sweep flips it as a newer field-only write, which folds around this older full
 * update instead of replacing it (flair#2470), so a differing `archived` is not
 * evidence that this write did not land.
 */
const POSTCOMMIT_VERIFY_FIELDS = ["agentId", "content", "visibility", "durability"] as const;

/** Fields a PATCH body may carry but the server owns (it strips, restores or
 *  stamps them, so the request does not declare their application). */
const PATCH_SERVER_OWNED_FIELDS = new Set<string>([
  "id",
  "instanceToken",
  "provenance",
  "skillSubjectId",
  "originatorInstanceId",
  "embeddedContentHash",
  "promotionStatus",
  "promotedAt",
  "promotedBy",
]);

/** Request field names retained before server additions; values come from the staged write. */
function patchDeclaredFields(content: any): string[] {
  if (!content || typeof content !== "object" || Array.isArray(content)) return [];
  return Object.keys(content).filter((field) => !PATCH_SERVER_OWNED_FIELDS.has(field));
}

function sameDeclaredField(stored: unknown, declared: unknown): boolean {
  return isDeepStrictEqual(stored, declared);
}

async function pausePostVerification(skill: boolean): Promise<void> {
  const pause = skill ? txnPausePoint("memory-post-skill-verify") : txnPausePoint("memory-post-verify");
  if (pause) await pause;
}

async function verifyWrittenRow(
  table: { get(id: any, ctx?: any): Promise<any> },
  declared: any,
  fallbackId: any,
  identity: { expectedToken: unknown },
  fields: readonly string[] = POSTCOMMIT_VERIFY_FIELDS,
): Promise<{ mismatch?: boolean; unknown?: boolean }> {
  const id = declared?.id ?? fallbackId;
  if (id === undefined || id === null) return { unknown: true };
  let row: any;
  try {
    row = await table.get(id, {});
  } catch {
    return { unknown: true };
  }
  if (!row) return { mismatch: true };
  if ((row.instanceToken ?? null) !== (identity.expectedToken ?? null)) return { mismatch: true };
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(declared, field)) continue;
    if (!sameDeclaredField(row[field], declared[field])) return { mismatch: true };
  }
  return {};
}

/** Attempts of an ordinary, non-skill Memory DELETE whose removal did not land. */
const DELETE_APPLY_ATTEMPTS = 3;

/**
 * flair#2632 — 409 when an ordinary, non-skill Memory DELETE exhausts its
 * removal attempts. The skill path closes the live head instead of removing it.
 */
function deleteNotAppliedRefusal(tableName: string, attempts: number): Response {
  return new Response(
    JSON.stringify({
      error: "delete_not_applied",
      message: `${tableName} row removal was not applied after ${attempts} attempts; not deleted`,
    }),
    { status: 409, headers: { "content-type": "application/json" } },
  );
}

/** 500 when ordinary DELETE compensation cannot confirm history removal or
 *  the restored/preserved pointer's identity. */
function deleteCompensationFailure(message: string): Response {
  return new Response(
    JSON.stringify({ error: "delete_compensation_failed", message }),
    { status: 500, headers: { "content-type": "application/json" } },
  );
}

function sameDeleteTarget(
  row: any,
  target: { id: string; owner: unknown; token: unknown },
  ownerField: string,
): boolean {
  return row != null && String(row.id) === target.id &&
    (row[ownerField] ?? null) === target.owner &&
    (row.instanceToken ?? null) === target.token;
}

/**
 * flair#2632 — remove failed history; for a captured pointer, preserve an
 * existing pointer or restore it if absent, then verify identity.
 */
async function compensateDroppedRemoval(
  memoryId: string,
  historyId: string | null,
  pointerBefore: any,
  ctx: any,
): Promise<Response | null> {
  try {
    if (historyId !== null) {
      const left = await removeMemoryDeletionRecords([historyId], ctx);
      if (left.length > 0) {
        return deleteCompensationFailure("the deletion-history record of a row that was not deleted is still stored");
      }
    }
    if (pointerBefore) {
      let expected = await loadStoredPointer(memoryId, {});
      if (!expected) {
        const pause = txnPausePoint("memory-delete-pointer-restore");
        if (pause) await pause;
        try {
          await withOwnedTransaction(ctx, async (c) => {
            expected = await loadStoredPointer(memoryId, c);
            if (!expected) {
              await restorePointerRowIfAbsent(pointerBefore, c);
              const staged = txnPausePoint("memory-delete-pointer-restore-staged");
              if (staged) await staged;
              expected = pointerBefore;
            }
          });
        } catch (err) {
          if (!(err instanceof PointerAlreadyStoredError)) throw err;
          expected = err.pointer;
        }
      }
      const resulting = await loadStoredPointer(memoryId, {});
      const fields = ["memoryId", "hostSource", "scopeAtWrite", "authorId", "memoryInstanceToken", "receivedAt"] as const;
      if (!resulting || fields.some((field) => resulting[field] !== expected?.[field])) {
        return deleteCompensationFailure("the restored or preserved host-pointer identity could not be confirmed");
      }
    }
    return null;
  } catch (err) {
    console.error("Memory.delete: undoing a removal that did not land failed", err);
    return deleteCompensationFailure("the partial writes of a delete that did not land could not be undone");
  }
}

/** Mark the id after a failed post-commit verification read (flair#2478). */
function writeOutcomeUnknownFor(id: any): Response {
  if (typeof id === "string" || typeof id === "number") markMemoryWriteOutcomeUnknown(id);
  return writeOutcomeUnknownResponse();
}

/** Refuse a provider call still pending when the timeout callback runs, or settling after the bound.
 *  `pausePoint` (test-only, inert unless the fault-injection opt-in is set and
 *  armed) holds the provider call inside its bound; the pause's own limit
 *  outlasts the bound, so an armed pause ends in the bound's refusal. */
function embedUnderLock(text: string, pausePoint?: (limitMs: number) => Promise<void> | undefined): Promise<number[] | null> {
  return boundLockedProviderCall(async () => {
    if (pausePoint) {
      const pause = pausePoint(memoryLockedProviderTimeoutMs() + PAUSE_LIMIT_MS);
      if (pause) await pause;
    }
    return getEmbedding(text, "document");
  });
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
  // When the stored model stamps are NOT KNOWN uniform in the current embedding
  // space, the cosine compare below could cross vector spaces or produce an
  // invalid score (Harper zero-pads a mismatched-dimension vector). No-op the
  // dedup cosine leg — treat as no-match — through
  // the SAME single chokepoint the recall leg (SemanticSearch) consults. The
  // guard fails CLOSED (flair#2530): it returns false for an UNKNOWN verdict too
  // (before the first scan completes, or after a scan error), so this leg no-ops
  // in exactly those states — the same no-match behavior as the `mixed` state. This
  // leg surfaces no warning (a skipped comparison is invisible by design).
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
async function runDedupGate(ctx: any, content: any, bounded = false): Promise<DedupMatch | null> {
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
      embedding = bounded ? await embedUnderLock(embedText) : await getEmbedding(embedText, "document");
    } catch (err) {
      if (err instanceof MemoryProviderTimeout) throw err;
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

const RESPONSE_ID = Object.freeze({ type: "string", required: true } as const);
const RESPONSE_WRITTEN = Object.freeze({ type: "boolean", required: true } as const);

const MEMORY_WRITE_RESPONSE_RULES: FieldRules = Object.freeze({
  id: RESPONSE_ID,
  written: RESPONSE_WRITTEN,
  deduplicated: Object.freeze({ type: "boolean", required: true } as const),
  visibility: Object.freeze({ type: "string" } as const),
  matchedId: Object.freeze({ type: "string" } as const),
  matchConfidence: Object.freeze({
    type: "object",
    fields: Object.freeze({ cosine: Object.freeze({ type: "number" } as const), lexical: Object.freeze({ type: "number" } as const) }),
  } as const),
  ...REDACTION_RULES,
});

const SKILL_RESULT_RULES: FieldRules = Object.freeze({
  id: RESPONSE_ID,
  written: RESPONSE_WRITTEN,
  visibility: Object.freeze({ type: "string" } as const),
});

const ROW_WRITE_RESPONSE_RULES: FieldRules = Object.freeze({ id: RESPONSE_ID, written: RESPONSE_WRITTEN, ...REDACTION_RULES });

const REEMBED_RESPONSE_RULES: FieldRules = Object.freeze({
  id: RESPONSE_ID,
  updatedAt: Object.freeze({ type: "string", required: true } as const),
});

function redactionValues(redactedValues: number, stored?: StoredMemoryText | null): Record<string, unknown> {
  return redactedValues > 0 ? { redactedValues, stored: stored ?? undefined } : {};
}

function skillWriteResponse(result: any, redactedValues: number, stored?: StoredMemoryText | null): any {
  if (result instanceof Response) return writeResultResponse(result);
  const built = buildFromAllowlist(result, SKILL_RESULT_RULES);
  if (built instanceof Response || redactedValues <= 0) return built;
  const redaction = buildFromAllowlist(redactionValues(redactedValues, stored), REDACTION_RULES);
  return redaction instanceof Response ? redaction : Object.assign(built, redaction);
}

/**
 * The answer of a PATCH and of the admin `_reindex` re-PUT. A Response from
 * storage is refused (writeResultResponse). A write that replaced no value
 * answers with no body (HTTP 204), the answer Harper gives for a PATCH; a write
 * that replaced a value answers `{ id, written, redactedValues, stored }`, built
 * from those named fields. Any other storage result is never read into the answer.
 */
function rowWriteResponse(result: any, id: unknown, redactedValues: number, stored?: StoredMemoryText | null): any {
  if (result instanceof Response) return writeResultResponse(result);
  if (redactedValues <= 0) return undefined;
  return buildFromAllowlist({ id, written: true, ...redactionValues(redactedValues, stored) }, ROW_WRITE_RESPONSE_RULES);
}

function buildWriteResponse(content: any, result: any, dedupMatch: DedupMatch | null, redactedValues: number, stored?: StoredMemoryText, rowId?: unknown): any {
  if (result instanceof Response) return writeResultResponse(result);
  return buildFromAllowlist({
    id: content.id ?? rowId,
    written: true,
    deduplicated: !!dedupMatch,
    visibility: content.visibility,
    matchedId: dedupMatch?.matchedId,
    matchConfidence: dedupMatch ? { cosine: dedupMatch.cosine, lexical: dedupMatch.lexical } : undefined,
    ...redactionValues(redactedValues, stored),
  }, MEMORY_WRITE_RESPONSE_RULES);
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
): { row: Record<string, any> } | { status: 400 | 404 | 409; error: string; message: string } {
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
  const effective = { ...existing, ...content };
  if (rowIsSkill(effective) && skillMetadataHasDuplicateKey(effective.metadata)) {
    return { status: 400, error: "skill_metadata_duplicate_key", message: "skill metadata requires distinct top-level keys" };
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
  normalizeEmptyEmbedding(content);
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
 *
 * A close a "write" grant authorizes does not run here: it is staged in the
 * successor's own transaction (stageGrantedClose).
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
        normalizeEmptyEmbedding(closed);
        await (databases as any).flair.Memory.put(closed, c);
        // Test-only: inert unless armed — here the write is staged, so a
        // competing write and the committed-state re-reads below can be exercised
        // in either order.
        const stagedPause = txnPausePoint("supersede-close-staged");
        if (stagedPause) await stagedPause;
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
async function hasWriteGrant(granteeId: string, ownerId: string, ctx?: unknown): Promise<boolean> {
  return writeGrantHeld((databases as any).flair.MemoryGrant, granteeId, ownerId, ctx);
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
 * a change visible at the close's committed re-read stops it from landing over
 * that change: closeSupersededRecord (the owner's own close) retries from the
 * committed row, and stageGrantedClose (a grant-authorized one) refuses the
 * whole write.
 * Later changes follow Harper's timestamp order (see the PR residual-gap note).
 * An admin or internal write has no authorization read or owner comparison.
 *
 * A write grant does not include changing a record's visibility; visibility is
 * set by the owner or an admin. For the grant-authorized supersede write,
 * `requestedVisibility` (the visibility the caller's body named, read before
 * any merge, carry or default) must read the same as the target's as this
 * authorization read sees it, and the successor is given that visibility. The
 * close, staged in the successor's transaction, then compares it with the
 * target's visibility at its final committed-state re-read (stageGrantedClose;
 * the skill-version writer for a skill); a mismatch writes nothing, and a
 * change committed after that re-read is not seen by it. The rule governs this
 * write: an ordinary successor
 * is the grantee's own row, so the grantee may later change that row's
 * visibility as its owner, and a skill successor keeps its lineage owner
 * (resources/grant-visibility.ts).
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
  requestedVisibility: unknown,
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
  if (target.agentId !== auth.agentId) {
    if (!(await hasWriteGrant(auth.agentId, target.agentId))) {
      return refuse(FORBIDDEN("forbidden: cannot supersede a memory owned by another agent without a write grant"));
    }
    // A write grant does not include changing a record's visibility; visibility
    // is set by the owner or an admin. This grant-authorized write gives the
    // successor the predecessor's visibility as read here, and the ephemeral
    // private-only rule (flair#1257) is applied to that value. The close
    // compares it with the predecessor's visibility at its final
    // committed-state re-read (stageGrantedClose, resources/grant-visibility.ts).
    const visibilityDenial = applyGrantedVisibility(content, target, requestedVisibility);
    if (visibilityDenial) return refuse(visibilityDenial);
    const tierError = assertVisibilityAllowedForDurability(content.durability ?? stored?.durability, content.visibility);
    if (tierError) {
      return refuse(new Response(
        JSON.stringify({ error: "invalid_visibility_for_durability", message: tierError }),
        { status: 400, headers: { "content-type": "application/json" } },
      ));
    }
    // flair#2333 (H10): the close re-checks this grant against committed state
    // before it lands, so the grantee id travels with the close plan.
    return { denial: null, close: { id: content.supersedes, ownerId: target.agentId, granteeId: auth.agentId } };
  }
  return { denial: null, close: { id: content.supersedes, ownerId: target.agentId } };
}

/** The close a write is authorized to perform on its `supersedes` target. */
interface SupersedeClose {
  id: string;
  /** The owner the authorization read saw (non-admin agent callers only). */
  ownerId?: string;
  /**
   * flair#2333 (H10): the grantee whose "write" grant authorized a CROSS-agent
   * close. Set only when the caller is not the owner. Such a close is staged in
   * the successor's own transaction and re-checks the grant against committed
   * state before that transaction commits (stageGrantedClose).
   */
  granteeId?: string;
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

/** The patch a supersede's close applies to its predecessor. */
function supersedeClosePatch(content: any): Record<string, unknown> {
  return {
    validTo: content.validFrom ?? content.createdAt,
    updatedAt: content.createdAt ?? content.updatedAt,
  };
}

/**
 * Close the superseded record — called AFTER the new record has already been
 * written (write-new-BEFORE-close-old). Safe failure state is
 * two active records (recoverable), never a tombstoned-old-with-lost-new.
 * Failure is logged (observable), never silently swallowed. No-op when
 * validateAndAuthorizeSupersedes authorized no close. A grant-authorized close
 * (`close.granteeId`) does not run here (closeGrantedSupersedeStaged).
 */
async function closeSupersededIfNeeded(ctx: any, content: any, close: SupersedeClose | null, methodLabel: "post" | "put"): Promise<void> {
  if (!close) return;
  try {
    await closeSupersededRecord(ctx, close.id, supersedeClosePatch(content), close.ownerId);
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

/** A grant-authorized close found its predecessor gone, owned by another
 *  agent, or changed since the write's transaction read it (stageGrantedClose). */
class GrantedCloseTargetChanged extends Error {}

class GrantedCloseStorageRefused extends Error {}

/**
 * flair#2564: stage a grant-authorized supersede's close (`close.granteeId`)
 * in `shared`, the successor's transaction (request, caller or write-owned).
 *
 * A storage Response aborts the write with write_response_withheld. After
 * staging the close, the committed row (an empty context) is checked:
 *
 *   - the committed visibility must read the same as the successor's
 *     (`successorVisibility`): a write grant does not include changing a
 *     record's visibility (grant-visibility.ts). A mismatch throws
 *     PredecessorVisibilityChanged;
 *   - the committed row must still be the one read: a staged write carries its
 *     transaction's timestamp, and Harper orders it before any later-committed
 *     change, so a close staged over a changed row is not retried here. It
 *     throws GrantedCloseTargetChanged, as does a predecessor that is gone or
 *     owned by another agent at the read;
 *   - flair#2333 (H10): the grant is re-checked on committed state; a revoked
 *     grant throws GrantedCloseRevoked.
 *
 * The caller aborts the transaction on any of these, so nothing is written,
 * and a retry runs in a new transaction. As with the other committed re-reads,
 * a change committed after this final re-read and before the transaction
 * commits is not seen by it; Harper orders the writes by transaction timestamp.
 */
async function stageGrantedClose(
  shared: any,
  close: SupersedeClose & { granteeId: string },
  patch: Record<string, unknown>,
  successorVisibility: unknown,
): Promise<Record<string, any>> {
  const existing = await (databases as any).flair.Memory.get(close.id, shared);
  if (!existing || existing.agentId !== close.ownerId) throw new GrantedCloseTargetChanged();
  // Test-only: inert unless the fault-injection env opt-in is set and armed.
  const pause = txnPausePoint("granted-close");
  if (pause) await pause;
  const closed = { ...existing, ...patch };
  stripUndeclaredMemoryAttributes(closed);
  const result = await (databases as any).flair.Memory.put(closed, shared);
  if (result instanceof Response) throw new GrantedCloseStorageRefused();
  // Test-only: inert unless armed — here the close is staged, so a competing
  // write and the committed-state re-reads below can be exercised in either
  // order.
  const stagedPause = txnPausePoint("granted-close-staged");
  if (stagedPause) await stagedPause;
  const committed = await (databases as any).flair.Memory.get(close.id, {});
  if (committedVisibilityDiffers(committed, successorVisibility)) throw new PredecessorVisibilityChanged();
  if (!isDeepStrictEqual(committed, existing)) throw new GrantedCloseTargetChanged();
  if (!(await writeGrantHeld((databases as any).flair.MemoryGrant, close.granteeId, close.ownerId as string, {}))) {
    throw new GrantedCloseRevoked();
  }
  return closed;
}

/**
 * Run a grant-authorized close (stageGrantedClose) inside the write's
 * transaction callback, after the successor and its pointer row are staged.
 * On any failure the whole write aborts: a joined request or caller
 * transaction is aborted here, and a transaction withSharedWriteTransaction
 * owns aborts when the error leaves its callback. Returns the staged closed row,
 * or null for an owner, admin or internal close (closeSupersededIfNeeded).
 */
async function closeGrantedSupersedeStaged(
  shared: any,
  content: any,
  close: SupersedeClose | null,
  joinsRequestTxn: boolean,
): Promise<Record<string, any> | null> {
  if (!close || close.granteeId === undefined) return null;
  try {
    return await stageGrantedClose(shared, close as SupersedeClose & { granteeId: string }, supersedeClosePatch(content), content.visibility);
  } catch (err) {
    if (joinsRequestTxn) abortRequestTransaction(shared);
    throw err;
  }
}

/** The named refusal for a grant-authorized close that did not land, else null. */
function grantedCloseRefusal(err: unknown): Response | null {
  if (err instanceof GrantedCloseStorageRefused) return withheldWriteResult();
  if (err instanceof PredecessorVisibilityChanged) return predecessorVisibilityChangedRefusal();
  if (err instanceof GrantedCloseRevoked) return grantedCloseRevokedRefusal();
  if (err instanceof GrantedCloseTargetChanged) return storedRowChangedRefusal("Memory");
  return null;
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
    /** The fields a PUT supplied. An in-place (reserved seed) PUT whose supplied
     *  fields equal the live head writes no row. Absent when the PUT's
     *  redaction replaced a value: that PUT always writes its redacted row. */
    requestedPayload?: Record<string, any>;
    /** flair#2467: receives the post-redaction text fields of the successor
     *  row this write staged (none when it wrote no row).
     *  flair#2561: only the `supplied` fields, the string-valued text fields
     *  and (flair#2575) the skill fields the request supplied; the successor
     *  row also holds the fields it carries over from its predecessor, and
     *  those are not reported. */
    staged?: { supplied: readonly StoredTextField[]; text: StoredMemoryText | null; row?: Record<string, any>; joined?: boolean };
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
  let joinsCaller = false;
  let successorBasis: any = null;
  const outcome = await runSkillVersionWrite({
    ctx,
    joinCallerTransaction: method === "post",
    subjectId,
    agentId: String(content.agentId),
    head: (shared) => resolveSkillHead(subjectId, addressedId, shared),
    plan: async (head, shared, attempt) => {
      // A superseding plan from a joined attempt is planned again, owned
      // (flair#2645); no state from the earlier attempt carries over.
      joinsCaller = attempt.joined;
      captured.row = null;
      captured.closed = null;
      unchangedHead = null;
      successorBasis = null;
      if (args.staged) {
        delete args.staged.row;
        delete args.staged.joined;
      }
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
        auth,
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
      normalizeEmptyEmbedding(successor);
      if (joinsCaller) successorBasis = await (databases as any).flair.Memory.get(successorId, shared);
      if (args.staged) {
        args.staged.row = structuredClone(successor);
        args.staged.joined = joinsCaller;
      }
      captured.row = successor;
      const value = typeof successor.content === "string" ? successor.content : null;
      const visibility = skillVersionVisibility(successor);
      if (inPlaceId || reembedInPlace) {
        return liveHead
          ? { kind: "update", predecessor: null, successor, closePatch: {}, value, visibility, grantedClose: null }
          : { kind: "create", predecessor: null, successor, closePatch: {}, value, visibility, grantedClose: null };
      }
      if (!liveHead) return { kind: "create", predecessor: null, successor, closePatch: {}, value, visibility, grantedClose: null };
      captured.closed = liveHead;
      return { kind: "update", predecessor: liveHead, successor, closePatch: { skillSubjectId: subjectId, validTo: now, updatedAt: now }, value, visibility, grantedClose: grantedSkillClose(liveHead, ctx, auth) };
    },
    hooks: {
      ...defaultSkillHooks,
      authorizeClose: (row, shared) => authorizeSkillOwners(ctx, auth, [row], shared),
      pointer: async (shared) => {
        // Test-only: holds a skill POST after its successor (and predecessor
        // close) are staged, before the transaction commits (flair#2656).
        const stagedPause = txnPausePoint("memory-post-skill-staged");
        if (stagedPause) await stagedPause;
        if (captured.closed) {
          const denial = await deletePointerRow(String(captured.closed.id), shared);
          if (denial) return denial;
        }
        const pointerDenial = pointer?.row
          ? await persistPointerRow({ ...pointer.row, memoryId: successorId, memoryInstanceToken: captured.row?.instanceToken }, shared)
          : null;
        if (pointerDenial) return pointerDenial;
        if (joinsCaller) {
          await pausePostVerification(true);
          const committed = await (databases as any).flair.Memory.get(successorId, {});
          // A skill write keeps its own target-changed refusal (flair#2263).
          if (!sameStoredRow(committed, successorBasis)) return skillWriteConflict("skill_target_changed");
        }
        return null;
      },
    },
  });
  if (!outcome.ok) return outcome.response;
  if (captured.closed) noteMemoryDelete(String(captured.closed.id));
  if (captured.row) {
    noteMemoryUpsert(captured.row);
    // An in-place update replaces the live head without recording it in
    // `captured.closed`, so no closed row is passed as unknown (undefined),
    // never as "replaced no row".
    noteWriteStamp(captured.row.embeddingModel, captured.closed ?? undefined);
  }
  if (args.staged) args.staged.text = captured.row ? storedMemoryText(captured.row, args.staged.supplied) : null;
  return {
    id: successorId,
    written: captured.row !== null,
    visibility: skillVersionVisibility(captured.row ?? unchangedHead),
  };
}

/** Attempts at re-applying a skill close whose committed write did not land (flair#2642). */
const SKILL_DELETE_CLOSE_ATTEMPTS = 3;

/** The named 500 for unconfirmed skill-close compensation. */
function skillDeleteCompensationFailure(message: string): Response {
  return Response.json({ error: "skill_delete_compensation_failed", message }, { status: 500 });
}

/** The named 500 for a confirmation read that failed: the close is unverified, never success. */
function skillDeleteUnconfirmedFailure(): Response {
  return Response.json({
    error: "skill_delete_unconfirmed",
    message: "the committed skill row could not be read; the delete is unverified",
  }, { status: 500 });
}

/** The named 409 for a skill DELETE whose version close still is not visible after the bounded re-applies. */
function skillDeleteNotClosedRefusal(attempts: number): Response {
  return Response.json({
    error: "skill_delete_not_closed",
    message: `the skill version close was not applied after ${attempts} attempts; not deleted`,
  }, { status: 409 });
}

/** Compensate an unlanded close. */
async function compensateUnlandedSkillClose(args: {
  ctx: any;
  subjectId: string;
  closedId: string;
  closeVersionId: string;
  pointerBefore: any;
}): Promise<Response | "restored" | "left_in_place" | "not_needed"> {
  const { ctx, subjectId, closedId, closeVersionId, pointerBefore } = args;
  try {
    const removal = await removeAppendedVersion(ctx, SKILL_SUBJECT_TYPE, subjectId, closeVersionId);
    if (removal !== "removed") {
      return skillDeleteCompensationFailure("removal of the close version record could not be confirmed");
    }
    if (pointerBefore) {
      let expected = await loadStoredPointer(closedId, {});
      let pointerOutcome: "restored" | "left_in_place" = "left_in_place";
      if (!expected) {
        const pause = txnPausePoint("skill-delete-pointer-restore");
        if (pause) await pause;
        try {
          await withOwnedTransaction(ctx, async (c) => {
            expected = await loadStoredPointer(closedId, c);
            if (!expected) {
              await restorePointerRowIfAbsent(pointerBefore, c);
              const staged = txnPausePoint("skill-delete-pointer-restore-staged");
              if (staged) await staged;
              expected = pointerBefore;
              pointerOutcome = "restored";
            }
          });
        } catch (err) {
          if (!(err instanceof PointerAlreadyStoredError)) throw err;
          expected = err.pointer;
          pointerOutcome = "left_in_place";
        }
      }
      const resulting = await loadStoredPointer(closedId, {});
      const fields = ["memoryId", "hostSource", "scopeAtWrite", "authorId", "memoryInstanceToken", "receivedAt"] as const;
      if (!resulting || fields.some((field) => resulting[field] !== expected?.[field])) {
        return skillDeleteCompensationFailure("the restored or preserved host-pointer identity could not be confirmed");
      }
      return pointerOutcome;
    }
    return "not_needed";
  } catch (err) {
    console.error("Memory.delete: undoing an unapplied skill close failed", err);
    return skillDeleteCompensationFailure("compensation for the unapplied skill close could not be confirmed");
  }
}

/**
 * flair#2642 — a skill DELETE confirms the close in a fresh committed read
 * before answering success. Harper can resolve the close's commit while skipping
 * the queued full put (it loses to a newer write of the same row) and still
 * commit the tombstone and pointer writes. A close that did not land is
 * re-applied from a fresh read, re-checking the row's identity and the caller's
 * authority. Unconfirmed compensation answers 500.
 * Returns null only when the close is confirmed (or the row is gone).
 */
async function confirmSkillDelete(args: {
  ctx: any;
  auth: AgentAuthVerdict;
  subjectId: string;
  closedId: string;
  closedRow: Record<string, any>;
  closeVersionId: string;
  pointerBefore: any;
  now: string;
}): Promise<Response | null> {
  const { ctx, auth, subjectId, closedId, closedRow, closeVersionId, pointerBefore, now } = args;
  const table = (databases as any).flair.Memory;
  const undo = async (refusal: Response): Promise<Response> => {
    const compensation = await compensateUnlandedSkillClose({ ctx, subjectId, closedId, closeVersionId, pointerBefore });
    if (compensation instanceof Response) return compensation;
    return Response.json({ ...await refusal.json(), pointerCompensation: compensation }, { status: refusal.status });
  };
  for (let attempt = 1; ; attempt++) {
    let committed: any;
    try {
      committed = await table.get(closedId, {});
    } catch {
      return skillDeleteUnconfirmedFailure();
    }
    if (!committed) return null;
    if (!sameStoredRow(committed, closedRow)) {
      // Replaced between the reads: not the row the caller meant.
      return undo(storedRowChangedRefusal("Memory"));
    }
    if (typeof committed.validTo === "string" && committed.validTo.length > 0) return null;
    if (attempt > SKILL_DELETE_CLOSE_ATTEMPTS) break;
    let applied: "staged" | Response;
    try {
      applied = await withOwnedTransaction(ctx, async (c) => {
        const stored = await table.get(closedId, c);
        if (!stored) return "staged";
        if (!sameStoredRow(stored, closedRow)) return storedRowChangedRefusal("Memory");
        const denied = await authorizeSkillOwners(ctx, auth, [stored], c);
        if (denied) return denied;
        const closed = { ...stored, skillSubjectId: subjectId, validTo: now, updatedAt: now };
        normalizeEmptyEmbedding(closed);
        const result = storageResult(await table.put(closed, c));
        if (result instanceof Response) throw result;
        const pause = attempt === 1 ? txnPausePoint("skill-delete-retry-first")
          : attempt === 2 ? txnPausePoint("skill-delete-retry-second")
            : txnPausePoint("skill-delete-retry-third");
        if (pause) await pause;
        const revoked = await afterCloseStaged(grantedSkillClose(stored, ctx, auth));
        if (revoked) throw revoked;
        return "staged";
      });
    } catch (err) {
      if (err instanceof Response) applied = err;
      else return skillDeleteUnconfirmedFailure();
    }
    if (applied instanceof Response) return undo(applied);
  }
  return undo(skillDeleteNotClosedRefusal(SKILL_DELETE_CLOSE_ATTEMPTS));
}

/** Close the live head and delete its pointer in the version transaction. */
async function writeSkillDelete(args: { ctx: any; auth: AgentAuthVerdict; record: Record<string, any>; headLock?: SkillDeleteHeadLock }): Promise<any> {
  const { ctx, auth, record, headLock } = args;
  let closedId = "";
  let closedRow: Record<string, any> | null = null;
  let pointerBefore: any = null;
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
      // flair#2478: the head this delete closes must be an id the DELETE holds.
      // A head that changed after delete() discovered it is not locked: write
      // nothing; delete() discovers and locks again.
      if (headLock) {
        headLock.outside = !!head && !headLock.ids.includes(String(head.id));
        if (headLock.outside) return storedRowChangedRefusal("Memory");
      }
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
      if (memoryWriteOutcomeUnknown(String(head.id))) return writeOutcomeUnknownResponse();
      const liveHead = head;
      closedId = String(liveHead.id);
      closedRow = liveHead;
      // Captured for compensation: this attempt's pointer delete can land even
      // when its close does not.
      pointerBefore = await loadStoredPointer(closedId, shared);
      // flair#2511: a stale id resolves the live head, which can be another
      // agent's row a "write" grant authorizes this caller to close; the writer
      // re-checks that grant after the close is staged.
      return { kind: "delete", predecessor: liveHead, closePatch: { skillSubjectId: subjectId, validTo: now, updatedAt: now }, value: null, visibility: skillVersionVisibility(liveHead), grantedClose: grantedSkillClose(liveHead, ctx, auth) };
    },
    hooks: { ...defaultSkillHooks, authorizeClose: (row, shared) => authorizeSkillOwners(ctx, auth, [row], shared), pointer: async (shared) => deletePointerRow(closedId, shared) },
  });
  if (!outcome.ok) return outcome.response;
  // flair#2642: the owned transaction has committed, but its success is not
  // proof that the queued close was applied. Confirm against the committed
  // store before answering success.
  const confirmation = await confirmSkillDelete({
    ctx, auth, subjectId, closedId, closedRow: closedRow!, closeVersionId: outcome.version, pointerBefore, now,
  });
  if (confirmation) return confirmation;
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

/** What one re-embed attempt's owned transaction decides. */
type ReembedOutcome =
  | { kind: "withheld"; response: Response }
  | { kind: "not_found" }
  | { kind: "forbidden" }
  | { kind: "no_text" }
  | { kind: "recompute"; text: string }
  | { kind: "written"; model: string; updatedAt: string; token: string; identity: Record<string, any>; fields: Record<string, unknown> };

/** A re-embed's answer, with a token only for a written row. */
type ReembedResult = { response: Response; token?: string };

/** A row's incarnation token, or null when it carries none (a legacy row). */
function storedInstanceToken(row: any): string | null {
  return row && typeof row.instanceToken === "string" && row.instanceToken.length > 0 ? row.instanceToken : null;
}

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
 * recomputes from the stored text (at most REEMBED_WRITE_ATTEMPTS times).
 * If the text keeps changing across the REEMBED_WRITE_ATTEMPTS attempts, it returns
 * reembed_row_changed (409) and writes nothing, when no attempt has committed
 * (otherwise 503 write_outcome_unknown, see flair#2478 below). A row absent at the attempt's
 * own re-read, a row with no text, or a caller no longer authorized for the row
 * is refused the same way the first read refused it.
 *
 * flair#2465: the attempt STAGES the field-only incremental update, then
 * confirms the COMMITTED row (an explicit fresh context) is still the row this
 * transaction read and re-authorized — the same identity (id, agentId,
 * instanceToken, contentHash, createdAt) and the same embedding text, compared
 * as text. A row gone or changed in either at confirmation aborts the owned
 * transaction (the staged write is discarded) and the caller answers
 * stored_row_changed (409) when no earlier attempt has committed, otherwise
 * 503 write_outcome_unknown (flair#2478 below). A same-id replacement with the same identity and
 * text passes. Post-commit verification retries surviving differences in
 * compared fields, identity or text from a fresh read within the attempt bound.
 *
 * The staged update also records `embeddedContentHash`, the newly computed hash
 * of the text the vector was computed from (null for an empty owner), so the
 * stored vector and its hash name the same text (flair#2465).
 *
 * flair#2478: a legacy row that carries no incarnation token gets one in the
 * same update, and a success reports the token of the row written, so the
 * calling PATCH can confirm after the commit that the row is still that one.
 * The calling PATCH holds the row's per-id write lock across this write and its
 * commit.
 *
 * flair#2478: once an attempt's commit has resolved and no read-back has shown
 * its write (the read-back mismatched, or a step after the commit, such as the
 * write-stamp notifier, threw before it), the row may hold that write. Every
 * exit of the call from then on, other than a later verified success, answers
 * `503 write_outcome_unknown` and marks the id outcome-unknown: a refusal, a
 * 409 (exhausted text changes or a change seen at a confirmation), a provider
 * timeout, an unusable vector, the final attempt's mismatch, or any thrown
 * error. The one exception is a later attempt whose fresh read finds no row:
 * no write of this call remains on one, so it answers 404 as before and does
 * not fence the id.
 */
async function reembedStoredRow(
  id: string,
  preRead: Record<string, any>,
  vector: number[],
  auth: AgentAuthVerdict,
  ctx: any,
): Promise<ReembedResult> {
  // flair#2478: one guard over every attempt. Once an attempt's commit has
  // resolved and no read-back has shown its write, the call answers either the
  // verified success, the deleted-row 404, or write_outcome_unknown (marking
  // the id): the attempts settle their refusals through `settle`, and any
  // thrown error, the write-stamp notifier after a commit included, lands here.
  const state = { committedUnconfirmed: false };
  try {
    return await reembedAttempts(id, preRead, vector, auth, ctx, state);
  } catch (err) {
    if (!state.committedUnconfirmed) throw err;
    console.warn("[reembed] %s: a committed attempt's write is not confirmed; the call ended with an error (%s); outcome: unconfirmed", id, (err as Error)?.name ?? "unknown");
    return { response: writeOutcomeUnknownFor(id) };
  }
}

/** The attempts of {@link reembedStoredRow}. `state.committedUnconfirmed` is set
 *  when an attempt's commit resolves, before anything else runs, and stays set
 *  unless that attempt's read-back shows the write (which answers success). */
async function reembedAttempts(
  id: string,
  preRead: Record<string, any>,
  vector: number[],
  auth: AgentAuthVerdict,
  ctx: any,
  state: { committedUnconfirmed: boolean },
): Promise<ReembedResult> {
  let textToEmbed = skillEmbedText(preRead);
  let embedding = vector;
  // Every refusal of a later attempt, once a committed write is unconfirmed,
  // answers write_outcome_unknown and marks the id, never a refusal that says
  // nothing was written.
  const settle = (response: Response, ended: string): ReembedResult => {
    if (!state.committedUnconfirmed) return { response };
    console.warn("[reembed] %s: a committed attempt's write is not confirmed; this attempt ended with %s; outcome: unconfirmed", id, ended);
    return { response: writeOutcomeUnknownFor(id) };
  };
  for (let attempt = 1; attempt <= REEMBED_WRITE_ATTEMPTS; attempt++) {
    let outcome: ReembedOutcome;
    try {
      outcome = await withOwnedTransaction<ReembedOutcome>(ctx, async (owned) => {
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
        const token = storedInstanceToken(stored) ?? newInstanceToken();
        // flair#2465: an incremental update, NOT a full-row put. Harper orders a
        // transaction by its first read, so this write can land after an edit the
        // owner committed while the vector was computed; a full-row put would
        // carry the row this transaction read and revert that edit.
        // flair#2465: the update also records the newly computed hash of
        // `textToEmbed`, the text this vector was computed from (null for an
        // empty owner).
        // flair#2478: a legacy row that carries no incarnation token gets one in
        // this same update; a row that has one keeps it.
        const legacyToken: Record<string, unknown> = storedInstanceToken(stored) ? {} : { instanceToken: token };
        // flair#2561: a Response from the storage layer is not reported (storageResult).
        const reembedUpdate = { ...legacyToken, embedding, embeddingModel: model, updatedAt, embeddedContentHash: hashEmbeddedText(stored.agentId, textToEmbed) ?? null };
        const result = storageResult(await (databases as any).flair.Memory.update(id, reembedUpdate, owned));
        if (result instanceof Response) return { kind: "withheld" as const, response: result };
        // Test-only: inert unless the fault-injection env opt-in is set and armed.
        const stagedPause = txnPausePoint("memory-reembed-staged");
        if (stagedPause) await stagedPause;
        // flair#2465: STAGE first, THEN confirm the COMMITTED row (an explicit
        // fresh context — never contextless, which joins this transaction and
        // sees its snapshot or its staged write) is still the row this transaction
        // read and re-authorized: the same identity (id, agentId, instanceToken,
        // contentHash, createdAt) AND, compared as text, the same embedding text
        // the vector was computed from (`textToEmbed`). The text check catches an
        // edit that changed the text but no identity field. A row gone or changed
        // at confirmation aborts this owned transaction, discarding the staged
        // write; the caller answers stored_row_changed (409), or write_outcome_unknown
        // when an earlier attempt committed unconfirmed. Only a text change
        // is logged. Neither the staged vector, its hash, nor a staged legacy
        // token is written. Post-commit verification retries surviving
        // differences in compared fields, identity or text from a fresh read.
        await confirmCommittedRow((databases as any).flair.Memory, id, (committed) => {
          if (!sameStoredRow(committed, stored)) return false;
          if (skillEmbedText(committed) !== textToEmbed) {
            console.warn(`[reembed] ${id}: the embedding text changed after the vector was computed; the write is discarded`);
            return false;
          }
          return true;
        });
        // Test-only: inert unless the fault-injection env opt-in is set and
        // armed. Holds the re-embed after its final pre-commit confirmation and
        // before its owned transaction commits, the window where a newer write
        // can discard this write's effect (flair#2656).
        const commitPause = txnPausePoint("memory-reembed-commit");
        if (commitPause) await commitPause;
        // The identity is the row this update writes: a legacy row gains the
        // token this attempt stages.
        return { kind: "written" as const, model, updatedAt, token, identity: { ...stored, instanceToken: token }, fields: reembedUpdate };
      });
    } catch (err) {
      // The owned transaction was aborted by the throw; this attempt wrote
      // nothing (an earlier unconfirmed attempt may have; settle answers that).
      if (err instanceof CommittedRowChanged) return settle(storedRowChangedRefusal("Memory"), "stored_row_changed");
      throw err;
    }
    if (outcome.kind === "withheld") return settle(outcome.response, "a withheld storage result");
    if (outcome.kind === "not_found") {
      // The fresh read finds no row, so no write of this call remains on one:
      // 404 states that even after an earlier unconfirmed attempt, and the id is
      // not fenced (an outcome-unknown mark lasts until restart).
      if (state.committedUnconfirmed) console.warn("[reembed] %s: a committed attempt's write is not confirmed, but the row is now absent, so no write of this call remains on it; answered not_found", id);
      return { response: NOT_FOUND() };
    }
    if (outcome.kind === "forbidden") return settle(FORBIDDEN("forbidden: cannot write memory owned by another agent"), "forbidden");
    if (outcome.kind === "no_text") {
      return settle(Response.json({ error: "reembed_no_text", message: "the stored row has no text to embed" }, { status: 422 }), "reembed_no_text");
    }
    if (outcome.kind === "recompute") {
      if (attempt === REEMBED_WRITE_ATTEMPTS) {
        return settle(Response.json({ error: "reembed_row_changed", message: "the stored text changed during each re-embed attempt; retry" }, { status: 409 }), "reembed_row_changed");
      }
      textToEmbed = outcome.text;
      let recomputed: number[] | null;
      try {
        // Test-only pause point: inert unless the fault-injection opt-in is set
        // and armed; it holds this provider call inside its bound.
        recomputed = await embedUnderLock(textToEmbed, (limitMs) => txnPausePoint("memory-reembed-recompute", process.env, limitMs));
      } catch (err) {
        if (err instanceof MemoryProviderTimeout) return settle(memoryProviderTimeoutResponse(), "memory_provider_timeout");
        throw err;
      }
      if (!isUsableEmbeddingVector(recomputed)) {
        return settle(Response.json({ error: "embedding_unavailable", message: "the embedding engine returned no vector; the stored row is unchanged, retry" }, { status: 503 }), "embedding_unavailable");
      }
      embedding = recomputed;
      continue;
    }
    // The commit has resolved: until a read-back shows the write, every exit of
    // the call is settled as unknown (the notifier below included).
    state.committedUnconfirmed = true;
    noteWriteStamp(outcome.model, preRead);
    const verifyPause = txnPausePoint("memory-reembed-verify");
    if (verifyPause) await verifyPause;
    // flair#2656: the commit is not proof the re-embed landed. Re-read the
    // committed row in a fresh context and answer success only when it shows
    // the staged values on the same row identity. A mismatch retries from the
    // next attempt's fresh read (which re-checks the text, the owner and the
    // identity); an unreadable read is unknown. Both unconfirmed outcomes mark
    // the id outcome-unknown (writeOutcomeUnknownFor), so a later PUT, PATCH or
    // DELETE of it is refused as after an ordinary PUT or PATCH.
    const verdict = await verifyCommittedFields(
      (databases as any).flair.Memory,
      id,
      outcome.identity,
      outcome.fields,
      (committed) => skillEmbedText(committed) === textToEmbed,
    );
    if (verdict === "unreadable") return { response: writeOutcomeUnknownFor(id) };
    if (verdict !== "shown") {
      // Safe to retry from a fresh read: for unchanged text and owner the next
      // attempt writes the same vector and hash (changed text recomputes them)
      // and restages `updatedAt` (and a new `instanceToken` on a legacy row that
      // still lacks one), so a post-commit mismatch retries from the next
      // attempt's fresh read. A post-commit mismatch on the final attempt is an
      // unconfirmed outcome (the commit resolved, so nothing here proves no
      // write landed). state.committedUnconfirmed stays set, so every later
      // exit of this call is settled as unknown: a later refusal, provider
      // timeout or error answers write_outcome_unknown and marks the id. Text
      // changes that exhaust the attempts through recomputation, and a change
      // seen at a confirmation, answer 409 only when no attempt has committed.
      if (attempt === REEMBED_WRITE_ATTEMPTS) {
        console.warn(`[reembed] ${id}: the committed vector was not confirmed after ${REEMBED_WRITE_ATTEMPTS} attempts; outcome: unconfirmed`);
        return { response: writeOutcomeUnknownFor(id) };
      }
      continue;
    }
    // flair#2561: the response names the row and its new updatedAt, and
    // carries no embedding field; `flair reembed` reads the model stamp from
    // the stored row.
    const body = buildFromAllowlist({ id, updatedAt: outcome.updatedAt }, REEMBED_RESPONSE_RULES);
    return { response: body instanceof Response ? body : Response.json(body), token: outcome.token };
  }
  return settle(
    new Response(
      JSON.stringify({ error: "reembed_row_changed", message: "the stored text changed during each re-embed attempt; retry" }),
      { status: 409, headers: { "content-type": "application/json" } },
    ),
    "reembed_row_changed",
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
   * record-type-kit.ts's makeByIdReadGate. Non-admin reads of retained closed
   * skill payloads also apply `closedSkillPayloadReadable`; a failed check
   * returns 404 by id or omits the collection row.
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
    // installs one — can never hand the join an already-projected value.
    const nonAdminAgent = auth.kind === "agent" && !auth.isAdmin;
    const boundId = (this as any).getId?.();
    const legacyProperty = typeof target === "string" && (this.constructor as any).loadAsInstance !== false && boundId != null;
    const selectionTarget = legacyProperty ? { property: target } : target;
    let readTarget: any = target;
    if (nonAdminAgent || legacyProperty || (typeof target === "object" && (target.select != null || target.property != null))) {
      const targetId = legacyProperty ? boundId : typeof target === "string" ? target : (target as any)?.id;
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
      const bound = applyPromotionBinding(attachTrust(withHits as any, wantsTrust(target, opts)));
      return nonAdminAgent ? bound : projectMemoryRead(this.constructor, bound, selectionTarget, ctx, true);
    }
    const bound = applyPromotionBinding(projected);
    return nonAdminAgent ? bound : projectMemoryRead(this.constructor, bound, selectionTarget, ctx, true);
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
   * is resolved is memory-read-scope.ts's resolveReadScope(). Non-admin reads
   * of retained closed skill payloads also apply `closedSkillPayloadReadable`;
   * a failed check returns 404 by id or omits the collection row.
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
    if (gate.kind === "unfiltered") {
      const source = await overlayHitStatsResult(super.search(withoutCallerSelection(query)), ctx);
      if (!source || source instanceof Response || typeof source[Symbol.asyncIterator] !== "function") return source;
      const table = this.constructor;
      return (async function* promotionBound() {
        for await (const row of source) yield projectMemoryRead(table, applyPromotionBinding(row), query, ctx);
      })();
    }

    // Non-admin agent: scope to own records at any visibility plus every other
    // agent's non-private records (open-within-org; MemoryGrant is not
    // consulted on reads). Centralized in
    // memoryReadScope (record-type-kit.ts's makeReadScope(), parameterized
    // from RECORD_TYPES.Memory — see this file's header — delegating
    // "open-within-org" to memory-read-scope.ts's resolveReadScope()
    // unchanged) so get() above and search() here cannot drift. Non-admin reads
    // of retained closed skill payloads also apply `closedSkillPayloadReadable`;
    // a failed check returns 404 by id or omits the collection row.
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
          yield await applyHitStats(applyPromotionBinding(row), ctx);
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

  /** POST takes the per-id lock for the ids it names (URL and body) and for the
   *  canonical id of its `supersedes` reference, and holds it across the
   *  handler's read, decision and write and the predecessor's close
   *  (flair#2478 slice 1 part 2). The handler joins the request's open
   *  transaction, which commits after the lock is released. A pure create
   *  under a fresh server-allocated id names no id and takes no lock. */
  async post(content: any, context?: any) {
    // flair#2307: resolve the `supersedes` reference to its canonical id once,
    // before the lock ids are taken, so the lock, the predecessor read and the
    // close all name that id (a selector or encoded spelling resolves to it).
    canonicalizeSupersedes(content);
    // A skill POST is a skill version write, which joins the request
    // transaction; it is not converted to the per-id lock here (later slice).
    const ids = isSkillWrite(content) ? [] : postLockIds(this, content);
    if (ids.length === 0) return this.postLocked(content, context);
    const outcome = await withMemoryWriteLock(
      memoryWriteLockStore(), ids, () => this.postLocked(content, context), { phase: "post" });
    if (outcome.kind === "done") return outcome.value;
    return memoryLockRefusal(outcome, memoryLockCallerId(this))!;
  }

  private async postLocked(content: any, context: any) {
    // flair#2612: a POST body that is not a single JSON object — an array, null,
    // a string or a number — is refused here with a named 400 before any write
    // path runs. Without it, an array reaches Harper's collection create, which
    // answers an unnamed 500 ("Can not create a record without an object"); null,
    // a string or a number throws a TypeError inside post() itself, also an
    // unnamed 500.
    const bodyDenial = guardObjectBody(content);
    if (bodyDenial) return bodyDenial;
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
    // flair#2561: the fields this request supplies that `stored` can report —
    // its string-valued text fields and, for a skill, the skill fields it
    // supplies (flair#2575) — read before a skill predecessor is merged into the
    // body; `stored` reports only these. Redaction runs after prepareSkillBody
    // (below) and keeps a string a string, so reading them first names the
    // same fields.
    const suppliedText = suppliedStoredTextFields(content);
    // `content.supersedes` is already canonical: post() resolved it before
    // taking the lock (canonicalizeSupersedes runs once per request).
    // flair#2573: an empty `embedding` in the body is an omitted one. It is
    // removed before the omission check and prepareSkillBody, so every later
    // step, a skill update's carried vector included, sees a body without it.
    if (isEmptyEmbedding(content?.embedding)) delete content.embedding;
    // flair#2573 slice 2: did the CALLER supply a non-null embedding, and/or an
    // `embeddingModel` stamp, that differs from the stored row's? Captured before
    // prepareSkillBody can merge a stored row's vector into the body.
    const { vector: postSuppliedVector, stamp: postSuppliedStamp } = suppliedVectorFlags(content, postStored);
    // The visibility the caller named, before any merge or default fills it.
    const requestedVisibility = content?.visibility;
    // flair#2465: a body that omits `embedding` can have the stored row's vector
    // carried in by prepareSkillBody, with the hash it retained for that vector.
    const postOmitsEmbedding = content?.embedding === undefined;
    const preparedSkill = await prepareSkillBody(content, postStored, auth);
    if (preparedSkill instanceof Response) return preparedSkill;
    content = preparedSkill.content;
    let redactedValues = redactMemoryWrite(content).count;
    // Duplicate top-level metadata keys are refused; otherwise redact name/description and tags.
    redactedValues += redactSkillWrite(content);
    const postCarriedHash = postOmitsEmbedding && Array.isArray(content?.embedding) && content.embedding.length > 0
      ? (content.embeddedContentHash ?? null)
      : null;

    // flair#744 slice A: citation-on-write — consume-and-strip, same
    // discipline as `claimedClient` below. Pull the optional
    // `usedMemoryIds` off the write body now, BEFORE anything else touches
    // `content`, so it is NEVER persisted on the Memory record itself.
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
    const supersede = await validateAndAuthorizeSupersedes(content, auth, ctx, postStored, requestedVisibility);
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
    // Discard the non-admin caller's vector and stamp that differ from the
    // stored row's, after redaction, before dedup and embedding. Compute an
    // embedding when the resulting write needs one.
    if (postSuppliedVector || postSuppliedStamp) {
      discardSuppliedVector(content, auth, { vector: postSuppliedVector, stamp: postSuppliedStamp }, postStored);
    }
    // flair#2573: an empty vector that reaches this point (one carried from a
    // stored skill row; the body's own was removed above) is no vector. It is
    // normalized before the dedup gate and the embed step, which can then
    // compute and stamp one when embedding succeeds.
    normalizeEmptyEmbedding(content);
    // flair#2465: did the caller supply a vector that survived redaction? A
    // vector accepted from the caller gets no newly computed hash.
    const embeddingSupplied = Array.isArray(content.embedding) && content.embedding.length > 0;
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
    // flair#2465: a vector the server computed here gets a newly computed
    // hash of the text it embedded (null for an empty owner). A skill's stored
    // vector that prepareSkillBody carried in keeps the hash prepareSkillBody
    // retained with it (possibly null), so a successor of a row whose hash
    // differs from its text's expected hash still differs. A vector accepted
    // and stored from the caller gets null; the stamp migration then skips only
    // the hash comparison for the row.
    content.embeddedContentHash = !embeddingSupplied && Array.isArray(content.embedding) && content.embedding.length > 0
      ? (embeddedTextHash(content) ?? null)
      : postCarriedHash;
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
    normalizeEmptyEmbedding(content);
    // POST joins an open caller transaction and confirms before its commit;
    // post-commit verification belongs to that owner (#2656 slice B).
    // Without a caller transaction, POST owns the commit and verifies after it.
    const postJoinsRequestTxn = isJoinableTransaction(ctx);
    if (isSkillWrite(content)) {
      const reservedId = [content?.id, (this as any).getId?.()].find((candidate) => isReservedSeedId("Memory", candidate));
      const skillStaged: { supplied: readonly StoredTextField[]; text: StoredMemoryText | null; row?: Record<string, any>; joined?: boolean } = { supplied: suppliedText, text: null };
      const skillResult = await writeSkillCreateOrUpdate({
        ctx, auth, content, storedRow: postStored, explicitPredecessor: preparedSkill.predecessor, method: "post", pointer,
        inPlaceId: reservedId != null ? String(reservedId) : null, staged: skillStaged,
      });
      if (skillResult instanceof Response) return skillWriteResponse(skillResult, redactedValues, skillStaged.text);
      // Verify after the commit when this write owned it, as a skill POST
      // that supersedes a version does (flair#2645).
      if (skillStaged.joined !== true) {
        await pausePostVerification(true);
        const skillVerified = await verifyWrittenRow(
          (databases as any).flair.Memory,
          skillStaged.row,
          skillResult.id,
          { expectedToken: skillStaged.row?.instanceToken },
          [...POSTCOMMIT_VERIFY_FIELDS, "summary", "trigger", "metadata", "tags"],
        );
        if (skillVerified.unknown || skillVerified.mismatch) {
          return skillVerified.unknown ? writeOutcomeUnknownFor(skillResult.id) : skillWriteConflict("skill_target_changed");
        }
      }
      await markDerivedSourcesReflected(content);
      return skillWriteResponse(skillResult, redactedValues, skillStaged.text);
    }
    // flair#2467: the post-redaction text fields this write stages, for the response.
    let postStaged: StoredMemoryText = {};
    let stagedRow: any;
    let postResult: Response | null;
    let postRowId: string | undefined;
    let grantedClosed: Record<string, any> | null = null;
    try {
      postResult = await withSharedWriteTransaction(ctx, async (c) => {
        postStaged = storedMemoryText(content, suppliedText);
        stagedRow = structuredClone(content);
        const newId = await writeMemoryRowPost((this as any).constructor, content, c);
        if (newId instanceof Response) return newId;
        postRowId = newId;
        if (pointer.row) {
          pointer.row.memoryId = newId;
          const persistDenial = await persistPointerRow(pointer.row, c);
          if (persistDenial) return persistDenial;
        }
        // Test-only: holds the POST after its row and any pointer are staged, before
        // the transaction commits (flair#2656).
        const stagedPause = txnPausePoint("memory-post-staged");
        if (stagedPause) await stagedPause;
        // Stage a grant-authorized close in the successor's transaction.
        grantedClosed = await closeGrantedSupersedeStaged(c, content, supersede.close, postJoinsRequestTxn);
        if (postJoinsRequestTxn) {
          await pausePostVerification(false);
          try {
            await confirmCommittedRow((databases as any).flair.Memory, newId, (committed) => sameStoredRow(committed, postStored));
          } catch (err) {
            abortRequestTransaction(c);
            throw err;
          }
        }
        return null;
      });
    } catch (err) {
      if (err instanceof CommittedRowChanged) return storedRowChangedRefusal("Memory");
      const refusal = grantedCloseRefusal(err);
      if (refusal) return refusal;
      throw err;
    }
    if (postResult instanceof Response) return writeResultResponse(postResult);
    if (!postJoinsRequestTxn) {
      await pausePostVerification(false);
      const verified = await verifyWrittenRow(
        (databases as any).flair.Memory, stagedRow, postRowId, { expectedToken: stagedRow.instanceToken },
        POSTCOMMIT_VERIFY_FIELDS,
      );
      if (verified.unknown || verified.mismatch) {
        return verified.unknown ? writeOutcomeUnknownFor(content.id ?? postRowId) : storedRowChangedRefusal("Memory");
      }
    }
    if (grantedClosed) noteMemoryUpsert(grantedClosed);
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
    // `postStored` is the row this write replaces; a read that found none is
    // passed as null (no previous row), not as unknown.
    noteWriteStamp(content?.embeddingModel as string | null | undefined, postStored ?? null);

    // ── THEN close the superseded record ────────────────────────────────────
    // Write-new-BEFORE-close-old: the previous order (close-old via a fire-
    // and-forget `.catch(()=>{})` BEFORE the new write) could tombstone the
    // old record and then lose the new one if the write failed afterward.
    // Now the safe failure state is two active records (recoverable), never
    // a lost write — and the failure is logged, never silently swallowed.
    // A grant-authorized close was staged in the successor's transaction
    // (closeGrantedSupersedeStaged).
    if (supersede.close?.granteeId === undefined) await closeSupersededIfNeeded(ctx, content, supersede.close, "post");
    await markDerivedSourcesReflected(content);

    if (usedMemoryIds !== undefined) {
      try {
        await recordCitations(ctx, auth, usedMemoryIds, new Date().toISOString());
      } catch (err) {
        console.error("Memory.post: citation recording failed", err);
      }
    }

    return buildWriteResponse(content, result, dedupMatch, redactedValues, postStaged, postRowId);
  }

  // PATCH routes past put(), so agentId immutability is enforced on both verbs
  // via the one shared delegate. (Admin/internal — including the _reindex
  // path in put() — pass through the delegate untouched.)
  /** PATCH requires a target id and lock before its body runs. Ordinary and
   *  re-embed owned writes commit before releasing the lock. A re-embed body
   *  (flair#2296) holds the lock under its own phase name, `patch-reembed`, so
   *  a hold warning names the re-embed (flair#2478 slice 3). */
  async patch(content: any, query?: any) {
    const ids = putLockIds(this, content);
    if (ids.length === 0) return memoryIdRequiredResponse();
    const phase = isReembedPatch(content) ? "patch-reembed" : "patch";
    const outcome = await withMemoryWriteLock(memoryWriteLockStore(), ids, async () => {
      const result = await this.patchLocked(content, query);
      // Test-only: the verb body has returned and the lock is still held. A body
      // that owned its transaction has committed it; a composed or `_reindex` put
      // that joined another transaction has not.
      const committed = txnPausePoint("memory-patch-committed");
      if (committed) await committed;
      return result;
    }, { phase });
    if (outcome.kind === "done") return outcome.value;
    return memoryLockRefusal(outcome, memoryLockCallerId(this))!;
  }

  private async patchLocked(content: any, query?: any) {
    const entry = txnPausePoint("memory-patch-entry");
    if (entry) await entry;
    // flair#2296: decided on the body as sent; the guards below add fields to it.
    const reembedRequest = isReembedPatch(content);
    // flair#2141 S2: check the seed's fixed id against the operator-source
    // reservation (resources/seed-reservation.ts).
    const seedDenial = await refuseReservedSeedWrite("Memory", writeTargetIds(this, content), (this as any).getContext?.());
    if (seedDenial) return seedDenial;
    const contentSuffixDenial = refuseContentSuffixId(writeTargetIds(this, content), query);
    if (contentSuffixDenial) return contentSuffixDenial;
    // flair#1383 — patch() routes past put(), so it needs its own refuse.
    {
      const stale = refuseStaleClientWrite((this as any).getContext?.()?.request, content);
      if (stale) return stale;
    }
    stripClientVersionPassthrough(content);
    // flair#2573: an empty embedding becomes `null` here, before redaction.
    if (content != null && typeof content === "object") normalizeEmptyEmbedding(content);
    // flair#2407: redact credential-shaped text on a PATCH too, before the body
    // is merged into the stored row.
    const redaction = redactMemoryWrite(content);
    const redactedValues = redaction.count;
    // flair#2573 slice 2: a non-admin write's caller-supplied vector and stamp
    // (one that differs from the stored row's) are discarded inside the
    // transaction, right after the stored read (see post()/put()). A stamp-only
    // body (no `embedding`) has its stamp discarded too, so a non-admin PATCH
    // cannot relabel a stored vector. The PATCH then behaves exactly as one that
    // sent neither.
    // flair#2561: the string-valued text fields this request supplies;
    // `stored` reports only these.
    const suppliedText = suppliedMemoryTextFields(content);
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
    // not set instanceToken or provenance; the stored values stand, except that
    // a row with no instanceToken is given one by the server below, flair#2478).
    stripServerStampedFields(content);
    // flair#2465: a body `embeddedContentHash` is dropped. A PATCH merges, so
    // the STORED value is retained unless the refresh path below writes a newly
    // computed hash of the text it embeds (null for an empty owner, or when the
    // engine returns no vector), or the re-embed writes one with its vector. A
    // PATCH that supplies its own vector retains the stored hash beside it.
    delete content.embeddedContentHash;
    const declaredFields = patchDeclaredFields(content);
    // flair#2478 slice 1 — the ordinary PATCH runs in ONE owned transaction whose
    // FIRST operation is the authoritative stored read; the read, the decision
    // and the COMMIT all happen before the write lock releases. Harper orders a
    // transaction by its first read, so the read and every decision drawn from
    // it share this commit. (A re-embed PATCH writes in its own inner owned
    // transaction instead, which also commits before the lock releases.)
    const ctx = (this as any).getContext?.();
    const patched = await withOwnedTransaction(ctx, async (c) => {
      // The FIRST operation inside the owned transaction: the authoritative
      // stored read, by the URL-BOUND target id (a body id that disagrees with
      // the address, or a lookup that FAILS, is refused; a failed read is never
      // read as "no stored row").
      const resolvedStored = await resolveStoredRow(this, "Memory", content, () => super.get(), c);
      if (resolvedStored.denial) return resolvedStored.denial;
      const existingForSkill = resolvedStored.row;
      if (!reembedRequest) {
        const { vector, stamp } = suppliedVectorFlags(content, existingForSkill);
        if (vector || stamp) {
          discardSuppliedVector(content as Record<string, any>, await resolveAgentAuth(ctx), { vector, stamp }, existingForSkill);
        }
      }
      // Authorize inside the transaction: the authority then owner guards read
      // the stored row from this transaction's own snapshot.
      const authorityDenial = await guardAuthorityFields(() => super.get(), content, "Memory");
      if (authorityDenial) return authorityDenial;
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
        // The stored row the tier guard compares against: the row this
        // transaction's first read resolved. When the resolver found no
        // URL-bound id to read by (an in-process harness), fall back to the
        // resource's own bound-record read so an update still consults the
        // stored visibility.
        const stored = existingForSkill ?? ((await super.get()) as any);
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
      // flair#1965 r3 + flair#1960 r3: `existingForSkill` is the row resolved by
      // this transaction's FIRST read (the authoritative stored read above), by the
      // URL-BOUND target id. This ONE resolved row drives the skill-row check, the
      // semantic-PATCH provenance decision below, AND the originatorInstanceId
      // create/update rule.
      // flair#2296: re-embed intentionally changes only embedding, embeddingModel
      // and updatedAt, plus the embedded-text hash (flair#2465) (flair#2478: and
      // gives a legacy row with no instanceToken one).
      // flair#2390: the vector is computed OUTSIDE the write. The write itself
      // re-reads the committed row inside its own transaction (reembedStoredRow),
      // re-checks the owner and the text, stages ONLY those fields (flair#2465;
      // plus instanceToken for a legacy row that has none, flair#2478), then
      // confirms the committed row has the identity and embedding text it read
      // (flair#2465). A row gone or changed in either at confirmation aborts with
      // 409 stored_row_changed. Post-commit verification retries surviving
      // differences in compared fields, identity or text from a fresh read
      // within the attempt bound.
      // After a normal storage result and inner commit, PATCH
      // compares the token; a storage Response returns before that read.
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
        let embedding: number[] | null;
        try {
          embedding = await embedUnderLock(embedText);
        } catch (err) {
          if (err instanceof MemoryProviderTimeout) return memoryProviderTimeoutResponse();
          throw err;
        }
        if (!isUsableEmbeddingVector(embedding)) {
          return Response.json({ error: "embedding_unavailable", message: "the embedding engine returned no vector; the stored row is unchanged, retry" }, { status: 503 });
        }
        // The re-embed writes and commits in its own owned transaction. A refusal
        // is answered as is; a success is answered only after the post-commit
        // identity check below (flair#2478).
        const reembedded = await reembedStoredRow(String(existingForSkill.id), existingForSkill, embedding, auth, (this as any).getContext?.());
        if (reembedded.token === undefined) return reembedded.response;
        return { reembed: reembedded.response, identity: { expectedToken: reembedded.token } };
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
      // flair#2466: this non-re-embed branch refreshes the embedding when the
      // body's `content` changes the compared row's text and `embedding` is absent
      // after redaction. Skill writes are refused above. A surviving
      // supplied vector is stored as supplied, without text/vector validation.
      // Without a refresh, the stored vector survives only if the body omits
      // `embedding` after redaction; an explicit `embedding: null` that survives
      // redaction clears it. Redaction that changes `content` or `trigger` removes
      // both embedding fields when either is non-null, so such a null does not survive.
      //
      // The vector is computed the way put() embeds a write that carries no vector
      // (same engine, `getEmbedding(..., "document")`; same stamps, embeddingModel
      // and updatedAt). When the engine returns no vector, embedding and
      // embeddingModel are written as null: the row keeps no vector for text it no
      // longer holds, and the embedding-stamp re-embed selects a null stamp.
      //
      // A fresh committed-row read runs only when the initial comparison selected
      // no embedding, a stored row exists, and the body omits `embedding` and carries the
      // embedding-text field. If that comparison finds changed text, refresh from
      // the body's text. Other paths write without this confirmation. Harper has
      // no compare-and-set: changes after the fresh read are not seen by it.
      //
      // A PATCH whose URL target has no stored row (a create, admin or internal
      // only) refreshes only when redaction removed a supplied embedding field
      // and the body carries `content`.
      const body: Record<string, any> = content != null && typeof content === "object" ? content : {};
      /** The field to embed this body's text from, if writing it over `stored` needs a vector; else null. */
      const vectorFieldOver = (stored: any): MemoryEmbeddingInputField | null => {
        const field = embedTextField({ ...(stored ?? {}), ...body });
        if (!Object.prototype.hasOwnProperty.call(body, field) || Object.prototype.hasOwnProperty.call(body, "embedding")) return null;
        if (stored == null) return redaction.embeddingDiscarded ? field : null;
        return skillEmbedText({ ...stored, ...body }) !== skillEmbedText(stored) ? field : null;
      };
      const storeVectorFor = async (field: MemoryEmbeddingInputField): Promise<Response | null> => {
        const embedText = body[field];
        let vec: number[] | null = null;
        if (typeof embedText === "string" && embedText.length > 0) {
          try {
            vec = await embedUnderLock(embedText);
          } catch (err) {
            if (err instanceof MemoryProviderTimeout) return memoryProviderTimeoutResponse();
            throw err;
          }
        }
        const computed = Array.isArray(vec) && vec.length > 0;
        body.embedding = computed ? vec : null;
        body.embeddingModel = computed ? getModelId() : null;
        // flair#2465: the refreshed vector gets a newly computed hash of the text
        // it embedded (null for an empty owner).
        body.embeddedContentHash = computed ? (embeddedTextHash({ ...(existingForSkill ?? {}), ...body }) ?? null) : null;
        body.updatedAt = new Date().toISOString();
        return null;
      };
      const readField = vectorFieldOver(existingForSkill);
      if (readField) {
        const denied = await storeVectorFor(readField);
        if (denied) return denied;
      }
      // Test-only: inert unless the fault-injection env opt-in is set and armed.
      // Holds the PATCH after its stored-row read and any embed, before the
      // conditional committed-row read and the write.
      const beforePatchWrite = txnPausePoint("memory-patch");
      if (beforePatchWrite) await beforePatchWrite;
      if (!readField && existingForSkill != null && !Object.prototype.hasOwnProperty.call(body, "embedding") &&
        Object.prototype.hasOwnProperty.call(body, embedTextField({ ...existingForSkill, ...body }))) {
        const committed = await (databases as any).flair.Memory.get(String(existingForSkill.id), {});
        const committedField = committed ? vectorFieldOver(committed) : null;
        if (committedField) {
          const denied = await storeVectorFor(committedField);
          if (denied) return denied;
        }
      }
      // flair#2478: a stored row that has a token keeps it (the
      // body's own was stripped above); a legacy row without one, or a row this
      // PATCH creates (an admin or internal caller only), is given a fresh one
      // in this same write.
      const keptToken = storedInstanceToken(existingForSkill);
      if (keptToken === null) content.instanceToken = newInstanceToken();
      const expectedToken = keptToken ?? content.instanceToken;
      // flair#2573: the guard is notified after the commit (below) when the
      // staged vector or stamp differs from the row read in this transaction.
      const embeddingChanged = Object.prototype.hasOwnProperty.call(body, "embedding") &&
        !isDeepStrictEqual(body.embedding, existingForSkill?.embedding);
      const stampChanged = Object.prototype.hasOwnProperty.call(body, "embeddingModel") &&
        !isDeepStrictEqual(body.embeddingModel, existingForSkill?.embeddingModel);
      const stampNote = embeddingChanged || stampChanged
        ? {
          stamp: (Object.prototype.hasOwnProperty.call(body, "embeddingModel")
            ? body.embeddingModel : existingForSkill?.embeddingModel) as string | null | undefined,
          previous: existingForSkill ?? null,
        }
        : null;
      // flair#2478 slice 1: the ordinary PATCH runs in the transaction this call
      // already owns (opened in patchLocked); super.patch joins it, so the row
      // write commits when this callback returns, before the write lock releases.
      // flair#2561: a Response from the storage layer is not reported
      // (storageResult); it is returned from this transaction as the
      // write_response_withheld refusal.
      const staged = structuredClone(content);
      const result = storageResult(await super.patch(staged, query));
      if (result instanceof Response) return result;
      return { result, staged, identity: { expectedToken }, rowId: existingForSkill?.id, stampNote };
    });
    // flair#2561: a refusal this path built is returned as built; a
    // successful Response is replaced by the write_response_withheld refusal
    // (writeResultResponse).
    if (patched instanceof Response) return writeResultResponse(patched);
    // flair#2573: the row write has committed (its transaction returned it), so
    // the embedding-space guard is notified now, before the verification read:
    // a refused or unknown verification still leaves the guard told about the
    // vector or stamp this PATCH stored. The re-embed notifies in
    // reembedStoredRow and stages no note here.
    const stampNote = (patched as any).stampNote as { stamp: string | null | undefined; previous: Record<string, any> | null } | null | undefined;
    if (stampNote) noteWriteStamp(stampNote.stamp, stampNote.previous);
    // Verify the ordinary owned PATCH after a normal storage result; refusals
    // and storage Responses return above before this read. A successful re-embed is also
    // checked after its inner owned commit; refusals return above.
    // Compare ordinary PATCH fields against the staged write, including storage coercion.
    // Test-only: holds the PATCH after its commit, before the verification read.
    const verifyPause = txnPausePoint("memory-patch-verify");
    if (verifyPause) await verifyPause;
    const staged = "staged" in patched ? patched.staged : content;
    const verified = await verifyWrittenRow((databases as any).flair.Memory, staged, (this as any).getId?.(), patched.identity, reembedRequest ? [] : declaredFields);
    if (verified.unknown) return writeOutcomeUnknownFor(content?.id ?? (this as any).getId?.());
    if (verified.mismatch) return storedRowChangedRefusal("Memory");
    // A verified re-embed answers with its own response (it declares no text
    // fields, so its check is the row's identity).
    if ((patched as any).reembed) return (patched as any).reembed;
    // As in put(): the verified row gates the answer; the response is the
    // PATCH's own result, never the stored row (see put()).
    return rowWriteResponse((patched as any).result, content?.id ?? (this as any).getId?.() ?? (patched as any).rowId, redactedValues, storedMemoryText(staged, suppliedText));
  }

  /**
   * flair#2478 slice 1 — the owner PUT runs under the per-id memory write lock
   * and its ordinary row write owns its transaction, so the read, the decision
   * and the COMMIT all happen before the lock releases (the protocol's rule).
   * Two puts can join a transaction they do not own, which then commits after
   * the lock releases: one composed into its caller's transaction (manual
   * promotion; see putLocked), and the admin `_reindex` re-PUT when the request
   * carries an open transaction. A PUT
   * that names no id is refused 400 before the lock; a store with no lock is
   * refused 503 `memory_lock_unavailable`. See resources/memory-write-lock.ts.
   */
  async put(content: any, query?: any) {
    const ids = putLockIds(this, content);
    if (ids.length === 0) return memoryIdRequiredResponse();
    const outcome = await withMemoryWriteLock(memoryWriteLockStore(), ids, async () => {
      const result = await this.putLocked(content, query);
      // Test-only: the verb body has returned and the lock is still held. A body
      // that owned its transaction has committed it; a composed or `_reindex` put
      // that joined another transaction has not.
      const committed = txnPausePoint("memory-put-committed");
      if (committed) await committed;
      return result;
    }, { phase: "put" });
    if (outcome.kind === "done") return outcome.value;
    return memoryLockRefusal(outcome, memoryLockCallerId(this))!;
  }

  private async putLocked(content: any, query?: any) {
    const reembedding = content?.embedding === null && content?.embeddingModel === null;
    // flair#2141 S2: check the seed's fixed id against the operator-source
    // reservation (resources/seed-reservation.ts).
    const seedDenial = await refuseReservedSeedWrite("Memory", writeTargetIds(this, content), (this as any).getContext?.());
    if (seedDenial) return seedDenial;
    const contentSuffixDenial = refuseContentSuffixId(writeTargetIds(this, content), query);
    if (contentSuffixDenial) return contentSuffixDenial;
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
      if (actorId && !(await annotatedCallerIsAdmin(request))) {
        return new Response(JSON.stringify({ error: "reindex_admin_only" }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        });
      }
      // An UNRESOLVED caller (anonymous HTTP, or an identity that did not
      // resolve) may not reindex: it answers the same 401 an unresolved caller
      // gets on the ordinary write path (resources/owner-field-guard.ts). This
      // guard ran before the reindex branch on main; the read-first restructure
      // moved it inside the owned ordinary transaction, which the reindex branch
      // returns before, so re-assert it here. Internal callers (no auth context)
      // pass, as on the ordinary path.
      const reindexOwnerDenial = await guardOwnerFieldImmutable(this, () => super.get(), content, "agentId");
      if (reindexOwnerDenial) return reindexOwnerDenial;
      // flair#1965 r3: resolve the stored row by the URL-BOUND target id (never a
      // body id alone); a body id that disagrees with the address, or a lookup
      // that FAILS, refuses the reindex. A reindex is a re-PUT of an EXISTING
      // row, so an absent stored row is refused too — a failed read must never
      // be read as "no row" and re-created/re-stamped. See
      // resources/originator-instance.ts's resolveStoredRow.
      const resolvedReindex = await resolveStoredRow(this, "Memory", content, () => super.get());
      if (resolvedReindex.denial) return resolvedReindex.denial;
      const reindexExisting = resolvedReindex.row;
      const built = buildReindexRow(content, reindexExisting);
      if (!("row" in built)) {
        return new Response(
          JSON.stringify({ error: built.error, message: built.message }),
          { status: built.status, headers: { "content-type": "application/json" } },
        );
      }
      const reindexRow = built.row;
      // The URL-bound target id is the row this re-PUT lands on; stamp it when
      // the body omits it (the same carry the ordinary put path performs).
      const reindexTargetId = (this as any).getId?.();
      if (reindexRow && typeof reindexRow === "object" && reindexRow.id == null &&
        (typeof reindexTargetId === "string" || typeof reindexTargetId === "number")) {
        reindexRow.id = reindexTargetId;
      }
      // flair#2450: the re-PUT writes over the row read as `reindexExisting`.
      // Inside the write's transaction, confirm the COMMITTED row is still that
      // one — before the row is staged, and again before the commit
      // (confirmCommittedRow: the transaction is aborted and the staged row
      // discarded). A missing row or an identity change seen by either read is
      // refused with the named 409 stored_row_changed; a change committed after
      // the final confirm read is not seen. Both reads use an explicit
      // fresh context, never a contextless one (see resources/write-back.ts).
      const reindexJoinsRequestTxn = isJoinableTransaction(ctx);
      const beforeReindex = txnPausePoint("memory-reindex-pre");
      if (beforeReindex) await beforeReindex;
      let reindexed: any;
      try {
        reindexed = await withSharedWriteTransaction(ctx, async (c) => {
          const confirmPause = txnPausePoint("memory-reindex");
          if (confirmPause) await confirmPause;
          const confirmed = await (databases as any).flair.Memory.get(reindexExisting!.id, {});
          if (!confirmed || !sameStoredRow(confirmed, reindexExisting)) return storedRowChangedRefusal("Memory");
          const r: any = storageResult(await (databases as any).flair.Memory.put(reindexRow, c));
          if (r instanceof Response) return r;
          // Test-only: holds the staged re-PUT before its commit, so a delete, a
          // purge or a same-id replace can commit in that window.
          const stagedPause = txnPausePoint("memory-reindex-staged");
          if (stagedPause) await stagedPause;
          try {
            await confirmCommittedRow((databases as any).flair.Memory, reindexExisting!.id, (committed) => sameStoredRow(committed, reindexExisting));
          } catch (err) {
            if (err instanceof CommittedRowChanged && reindexJoinsRequestTxn) abortRequestTransaction(c);
            throw err;
          }
          return r;
        });
      } catch (err) {
        if (err instanceof CommittedRowChanged) return storedRowChangedRefusal("Memory");
        throw err;
      }
      // flair#2561: a refusal this path built is returned as built; a
      // successful Response is replaced by the write_response_withheld
      // refusal (writeResultResponse).
      if (reindexed instanceof Response) return writeResultResponse(reindexed);
      noteMemoryUpsert(content);
      noteWriteStamp(reindexRow?.embeddingModel as string | null | undefined, reindexExisting); // embedding-space-guard slice 1 (see post())
      return rowWriteResponse(reindexed, reindexRow?.id, 0);
    }
    // flair#2441 + flair#2478 slice 1: a test-only pause of this PUT before its
    // transaction opens (other writers, background ones included, can still
    // change the row meanwhile); then the ordinary write runs in ONE owned
    // transaction whose FIRST operation is the authoritative stored read —
    // Harper orders a transaction by its first read, so the read and every
    // decision drawn from it share this write's commit and commit before the
    // write lock releases. A composed put, below, joins its caller's transaction
    // instead.
    const beforePut = txnPausePoint("memory-put-pre");
    if (beforePut) await beforePut;
    const ctx = (this as any).getContext?.();
    // A caller that composes this put into its OWN open write transaction
    // (withComposedWriteTransaction: manual promotion, whose verdict stamp must
    // commit or abort with this row, flair#2354) is joined, not detached: the
    // caller owns the commit, which lands after this lock is released, and there
    // is no post-commit verification here (manual promotion's stamp reads the
    // row in that transaction and refuses when there is none; it does not
    // compare the written identity). Every other ordinary put owns its
    // transaction; the `_reindex` re-PUT above joins a request transaction when
    // one is open, as it did before the lock.
    const composed = composesCallerWrite(ctx);
    let putResult: any;
    // flair#2467: the post-redaction text fields this write stages, for the response.
    let putStaged: StoredMemoryText = {};
    let putGrantedClosed: Record<string, any> | null = null;
    try {
      putResult = await (composed ? withSharedWriteTransaction : withOwnedTransaction)(ctx, async (c) => {
        // The authoritative stored read: the FIRST operation of an ordinary PUT's
        // owned transaction (a composed put runs it in its caller's transaction,
        // which may already have read). It reads by the URL-BOUND target id (a
        // body id that disagrees with the address, or a lookup that FAILS, is
        // refused; a failed read is never read as "no stored row").
        const resolvedExisting = await resolveStoredRow(this, "Memory", content, () => super.get(), c);
        if (resolvedExisting.denial) return resolvedExisting.denial;
        const preExisting = resolvedExisting.row;
        // Authorize inside the transaction: the owner-field then authority guards
        // read the stored row from this transaction's own snapshot.
        const __ownerDenial = await guardOwnerFieldImmutable(this, () => super.get(), content, "agentId");
        if (__ownerDenial) return __ownerDenial;
        const authorityDenial = await guardAuthorityFields(() => super.get(), content, "Memory");
        if (authorityDenial) return authorityDenial;
        // Create/update ownership (same rule as post): a non-admin agent may only
        // write memories it owns, via resolveAgentAuth (gate annotation), not
        // context.user.username (the dormant-de-elevation fallback is "admin").
        // The _reindex admin path above bypasses this.
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

        // flair#2561: the fields this request supplies that `stored` can report —
        // its string-valued text fields and, for a skill, the skill fields it
        // supplies (flair#2575) — read before the stored row or a skill predecessor
        // is merged into the body; `stored` reports only these. Redaction runs after
        // prepareSkillBody (below) and keeps a string a string, so reading them
        // first names the same fields.
        const suppliedText = suppliedStoredTextFields(content);

        canonicalizeSupersedes(content);
        // flair#2573: an empty `embedding` in the body is an omitted one (see post()).
        if (isEmptyEmbedding(content?.embedding)) delete content.embedding;
        const requestedPayload = { ...content };
        // The visibility the caller named, before any merge, carry or default fills it.
        const requestedVisibility = content?.visibility;
        const urlTargetId = (this as any).getId?.();
        if (content && typeof content === "object" && content.id == null &&
          (typeof urlTargetId === "string" || typeof urlTargetId === "number")) {
          content.id = urlTargetId;
        }
        // flair#2465: as in post(), a body that omits `embedding` can have a stored
        // vector carried in by prepareSkillBody, with the hash it retained for it.
        const putOmitsEmbedding = content?.embedding === undefined;
        // flair#2573 slice 2: did the CALLER supply a non-null embedding, and/or an
        // `embeddingModel` stamp, that differs from the stored row's? Captured
        // before prepareSkillBody can merge a stored row's vector into the body.
        const { vector: putSuppliedVector, stamp: putSuppliedStamp } = suppliedVectorFlags(content, preExisting);
        const preparedSkill = await prepareSkillBody(content, preExisting, auth);
        if (preparedSkill instanceof Response) return preparedSkill;
        content = preparedSkill.content;
        const operatorSeed = isOperatorSeedPut(ctx, auth, writeTargetIds(this, content));
        let redactedValues = operatorSeed ? 0 : redactMemoryWrite(content).count;
        // Duplicate top-level metadata keys are refused; otherwise redact name/description and tags.
        redactedValues += redactSkillWrite(content);
        const putCarriedVector = putOmitsEmbedding && Array.isArray(content?.embedding) && content.embedding.length > 0;
        const putCarriedHash = putCarriedVector ? (content.embeddedContentHash ?? null) : null;

        // flair#744 slice A: citation-on-write — same consume-and-strip
        // discipline as post() above. Stripped before persistence so it is
        // never stored on the row; recorded post-commit
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
        const supersede = await validateAndAuthorizeSupersedes(content, auth, ctx, preExisting, requestedVisibility);
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
        // flair#2573 slice 2: a non-admin write's vector and stamp that differ
        // from the stored row's are discarded here, after redaction and before
        // the dedup gate and the embed step (see post()).
        if (putSuppliedVector || putSuppliedStamp) {
          discardSuppliedVector(content, auth, { vector: putSuppliedVector, stamp: putSuppliedStamp }, preExisting);
        }
        // flair#2573: an empty vector that reaches this point is no vector (see post()).
        normalizeEmptyEmbedding(content);
        // flair#2465: did the caller supply a vector? See post().
        const embeddingSupplied = Array.isArray(content.embedding) && content.embedding.length > 0;
        let dedupMatch: DedupMatch | null = null;
        try {
          if (content.supersedes) {
            delete content.dedup;
            delete content.dedupThreshold;
            delete content.lexicalThreshold;
          } else if (content.id) {
            if (!preExisting) {
              dedupMatch = await runDedupGate(ctx, content, true);
            } else {
              delete content.dedup;
              delete content.dedupThreshold;
              delete content.lexicalThreshold;
            }
          } else {
            dedupMatch = await runDedupGate(ctx, content, true);
          }
        } catch (err) {
          if (err instanceof MemoryProviderTimeout) return memoryProviderTimeoutResponse();
          throw err;
        }

        // Re-generate embedding if content changed (no-op if the dedup gate above
        // already computed one for this content). flair#504 Phase 2: 'document'
        const embedText = skillEmbedText(content);
        if (embedText && !content.embedding) {
          let vec: number[] | null;
          try {
            vec = await embedUnderLock(embedText);
          } catch (err) {
            if (err instanceof MemoryProviderTimeout) return memoryProviderTimeoutResponse();
            throw err;
          }
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
        // flair#2465: a vector the server computed here gets a newly computed hash
        // (see post()). A skill vector prepareSkillBody carried in keeps the hash it
        // retained (possibly null) — including a superseding create at a new id,
        // which has no stored row of its own. Any other put that does not compute a
        // vector (one accepted from the caller, an echoed one, or a failed embed)
        // retains this row's stored hash, if any; `preExisting` is the row this
        // owned transaction read first (flair#2478). A retained hash is a preserved
        // value that may describe an earlier server-computed vector, not
        // necessarily the vector stored now. One that differs from the current
        // text's expected hash re-queues the row in the stamp migration; with no
        // stored hash the comparison is skipped.
        content.embeddedContentHash = !embeddingSupplied && Array.isArray(content.embedding) && content.embedding.length > 0
          ? (embeddedTextHash(content) ?? null)
          : putCarriedVector ? putCarriedHash : (preExisting?.embeddedContentHash ?? null);
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
        normalizeEmptyEmbedding(content);
        if (isSkillWrite(content)) {
          const reservedId = [content?.id, (this as any).getId?.()].find((candidate) => isReservedSeedId("Memory", candidate));
          const skillStaged: { supplied: readonly StoredTextField[]; text: StoredMemoryText | null } = { supplied: suppliedText, text: null };
          // A PUT whose redaction replaced a value commits its redacted effective
          // row, inherited fields included, so each field the reply's `stored`
          // reports (the fields the request supplied, flair#2561) is what the row
          // holds: the in-place unchanged-row check gets no requested fields for it.
          return { skill: skillWriteResponse(await writeSkillCreateOrUpdate({
            ctx, auth, content, storedRow: preExisting, explicitPredecessor: preparedSkill.predecessor, method: "put", pointer,
            reembedding, requestedPayload: redactedValues > 0 ? undefined : requestedPayload,
            inPlaceId: reservedId != null ? String(reservedId) : null, staged: skillStaged,
          }), redactedValues, skillStaged.text) };
        }
        // flair#2441: this put is over the row read as `preExisting` (which
        // `stampInstanceToken` copied its incarnation token from). The write
        // confirms, against the COMMITTED row, that it is still that one
        // (sameStoredRow): once before the row is staged (nothing is staged yet,
        // so the refusal is returned) and once after, before the commit
        // (confirmCommittedRow: the transaction is aborted and the staged rows
        // discarded). Both reads use an explicit fresh context, never contextless
        // (see resources/write-back.ts).
        const confirmPause = txnPausePoint("memory-put");
        if (confirmPause) await confirmPause;
        if (preExisting) {
          const confirmed = await (databases as any).flair.Memory.get(preExisting.id, {});
          if (!confirmed || !sameStoredRow(confirmed, preExisting)) return storedRowChangedRefusal("Memory");
        }
        putStaged = storedMemoryText(content, suppliedText);
        const r: any = storageResult(await (databases as any).flair.Memory.put(content, c));
        if (r instanceof Response) return r;
        if (pointer.row) {
          pointer.row.memoryId = r?.id ?? content.id ?? "";
          const persistDenial = await persistPointerRow(pointer.row, c);
          if (persistDenial) return persistDenial;
        }
        if (preExisting) {
          // Measured over HTTP on Harper 5.3.1: a competitor committed after this
          // write was staged keeps its row even without this re-check (Harper
          // orders the staged write by this transaction's earlier timestamp); the
          // re-check is what refuses the put by name instead of answering success
          // for a write that did not land. Test-only: holds the staged write.
          const stagedPause = txnPausePoint("memory-put-staged");
          if (stagedPause) await stagedPause;
          // The committed row must still be the one read; the throw leaves this
          // callback, so the owned transaction aborts and the staged write is
          // discarded, and the caller answers 409. A composing caller's
          // transaction is not aborted by the throw, so it is aborted here.
          try {
            await confirmCommittedRow((databases as any).flair.Memory, preExisting.id, (committed) => sameStoredRow(committed, preExisting));
          } catch (err) {
            if (err instanceof CommittedRowChanged && composed) abortRequestTransaction(c);
            throw err;
          }
        }
        // Stage a grant-authorized close in the successor's transaction: the
        // transaction this put owns (a throw leaves this callback and aborts it)
        // or, for a composed put, its caller's (aborted explicitly).
        putGrantedClosed = await closeGrantedSupersedeStaged(c, content, supersede.close, composed);
        return { content, result: r, dedupMatch, redactedValues, usedMemoryIds, close: supersede.close, auth, fallbackId: preExisting?.id, previous: preExisting ?? null };
      });
    } catch (err) {
      if (err instanceof CommittedRowChanged) return storedRowChangedRefusal("Memory");
      const refusal = grantedCloseRefusal(err);
      if (refusal) return refusal;
      throw err;
    }
    // A skill PUT answers from its own write (no ordinary-row post-commit step).
    if (putResult && (putResult as any).skill !== undefined) return (putResult as any).skill;
    // flair#2561: a refusal this path built is returned as built; a
    // successful Response is replaced by the write_response_withheld refusal
    // (a storage-layer Response was replaced in the transaction, storageResult).
    if (putResult instanceof Response) return writeResultResponse(putResult);
    // embedding-space-guard slice 1 (see post()): the ordinary row write has
    // returned from its transaction, so the guard is notified now, with the
    // stored stamp and the row this PUT replaced (flair#2573), before the
    // verification read: a refused or unknown verification still leaves the
    // guard told about the stored vector.
    noteWriteStamp(putResult.content?.embeddingModel as string | null | undefined, putResult.previous ?? null);
    // Verify the ordinary owned row PUT after a normal storage result.
    // Refusals, storage Responses and skill PUT return above; composed promotion skips
    // this read and uses its caller's in-transaction existence check.
    // Compare the token and declared agentId/content/visibility/durability;
    // other field changes pass. A failed read marks the id and answers 503.
    if (!composed) {
      // Test-only: holds the PUT after its commit, before the verification read.
      const verifyPause = txnPausePoint("memory-put-verify");
      if (verifyPause) await verifyPause;
      const verified = await verifyWrittenRow(
        (databases as any).flair.Memory, putResult.content, putResult.fallbackId,
        { expectedToken: putResult.content?.instanceToken },
      );
      if (verified.unknown) return writeOutcomeUnknownFor(putResult.content?.id ?? putResult.fallbackId);
      if (verified.mismatch) return storedRowChangedRefusal("Memory");
    }
    // The verification only decides whether the write is answered; the response
    // is built from the write's own result, never from the verified row. The
    // stored row carries per-row values that are not part of the write response
    // (`instanceToken`, `embedding`, `provenance`). Built this way, two otherwise
    // identical writes, one citing a memory the writer cannot read and one citing
    // a nonexistent id, answer identically once writer ids and timestamps are
    // normalized: nothing in the answer depends on the cited id (flair#775).
    const result: any = putResult.result;
    // flair#1357 — read-your-write for the lexical leg (see post()).
    noteMemoryUpsert(putResult.content);

    // ── THEN close the superseded record (see post()) ───────────────────────
    // A grant-authorized close was staged in the successor's transaction
    // (closeGrantedSupersedeStaged).
    if (putGrantedClosed) noteMemoryUpsert(putGrantedClosed);
    if (putResult.close?.granteeId === undefined) await closeSupersededIfNeeded(ctx, putResult.content, putResult.close, "put");

    // flair#744 slice A: citation-on-write — POST-COMMIT, fully
    // failure-isolated (see post()'s identical comment above).
    if (putResult.usedMemoryIds !== undefined) {
      try {
        await recordCitations(ctx, putResult.auth, putResult.usedMemoryIds, new Date().toISOString());
      } catch (err) {
        console.error("Memory.put: citation recording failed (write already committed)", err);
      }
    }

    return buildWriteResponse(putResult.content, result, putResult.dedupMatch, putResult.redactedValues, putStaged);
  }

  /** DELETE holds the addressed id's lock and, for a skill row, the lock of
   *  the live head its skill writer closes (for an older version, another row)
   *  across the reads it decides on, its write and its owned transaction's
   *  commit. The head is found with no lock held and checked again by the skill
   *  writer under the locks; if it changed, nothing is written and the DELETE
   *  finds and locks the head again, at most SKILL_DELETE_HEAD_ATTEMPTS
   *  attempts in all, then answers `503 memory_busy` (flair#2478 slice 1
   *  part 2). */
  async delete(id: any) {
    const ids = deleteLockIds(this, id);
    if (ids.length === 0) return this.deleteLocked(id);
    // The refusals that read no row answer before the head discovery reads it.
    const ctx = (this as any).getContext?.();
    const early = this.deleteRefusalBeforeRead(id, ctx, await resolveAgentAuth(ctx));
    if (early) return early;
    for (let attempt = 1; attempt <= SKILL_DELETE_HEAD_ATTEMPTS; attempt++) {
      const head = await skillDeleteHeadId(() => super.get(id));
      if (head !== null) {
        // Test-only: held after this attempt found the head, before it takes
        // the locks.
        const discovered = attempt === 1 ? txnPausePoint("memory-delete-head-first")
          : attempt === 2 ? txnPausePoint("memory-delete-head-second")
            : txnPausePoint("memory-delete-head-third");
        if (discovered) await discovered;
      }
      const headLock: SkillDeleteHeadLock = { ids: [], outside: false };
      const outcome = await withMemoryWriteLock(memoryWriteLockStore(), head === null ? ids : [...ids, head], (locked) => {
        headLock.ids = locked.ids;
        return this.deleteLocked(id, headLock);
      }, { phase: "delete" });
      if (outcome.kind !== "done") return memoryLockRefusal(outcome, memoryLockCallerId(this))!;
      if (!headLock.outside) return outcome.value;
    }
    return memoryBusyResponse(memoryLockCallerId(this));
  }

  /** The DELETE refusals that read no Memory row: an anonymous caller, an
   *  outcome-unknown id, a reserved seed id and a `.content`-suffixed target.
   *  delete() answers them before its head discovery reads the row;
   *  deleteLocked checks them again under the lock. */
  private deleteRefusalBeforeRead(id: any, ctx: any, auth: AgentAuthVerdict): Response | null {
    if (auth.kind === "anonymous") return UNAUTH();
    // flair#2478: a DELETE of an id whose last owned PUT/PATCH settled with an
    // unknown outcome waits for reconciliation too: refused until restart, as a
    // later PUT or PATCH of that id is.
    if ([id, ...writeTargetIds(this, id && typeof id === "object" ? id : undefined)]
      .some((t) => (typeof t === "string" || typeof t === "number") && memoryWriteOutcomeUnknown(t))) {
      return writeOutcomeUnknownResponse();
    }
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
    return null;
  }

  private async deleteLocked(id: any, headLock?: SkillDeleteHeadLock) {
    const ctx = (this as any).getContext?.();
    const auth = await resolveAgentAuth(ctx);
    const refusal = this.deleteRefusalBeforeRead(id, ctx, auth);
    if (refusal) return refusal;
    if (auth.kind === "anonymous") return UNAUTH();
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
      return await writeSkillDelete({ ctx, auth, record, headLock });
    }
    // Durability controls retention, not the owner's authority to delete.
    // A1' item 2 (adjudication 0a/0c): the Memory delete, its pointer delete
    // and its deletion-history record share ONE owned transaction; a failing
    // pointer delete aborts it, so nothing is deleted; failures are NOT
    // swallowed. The transaction is OWNED here (withOwnedTransaction) so it
    // commits before this method returns, which lets the confirmation below
    // read the committed store (flair#2632).
    const deletionActor = auth.kind === "agent" ? auth.agentId : null;
    const deletionSourceClass: "agent" | "admin" | "internal" =
      auth.kind === "internal" ? "internal" : auth.isAdmin ? "admin" : "agent";
    // flair#2355: hold the row still before the delete stages, so a competing
    // owner change can commit first and be seen by the re-read inside.
    const target = record ? {
      id: String(record.id),
      owner: record[RECORD_TYPES.Memory.ownerField] ?? null,
      token: record.instanceToken ?? null,
    } : null;
    const beforeDelete = txnPausePoint("memory-delete-pre");
    if (beforeDelete) await beforeDelete;
    type DeleteAttempt =
      | { kind: "absent" }
      | { kind: "response"; response: Response }
      | { kind: "staged" };
    // flair#2632: ordinary, non-skill DELETE confirms committed row absence.
    // Retry dropped removals with fresh reads; refuse a changed id/owner/token.
    const targetIdProbe = typeof id === "string" ? id : record?.id;
    let applied = false;
    for (let attempt = 1; attempt <= DELETE_APPLY_ATTEMPTS; attempt++) {
      let historyId: string | null = null;
      let pointerBefore: any = null;
      const outcome = await withOwnedTransaction<DeleteAttempt>(ctx, async (c): Promise<DeleteAttempt> => {
        const deletedId = typeof id === "string" ? id : record?.id;
        if (typeof deletedId !== "string" || !deletedId) return { kind: "absent" };
        const stored = await (databases as any).flair.Memory.get(deletedId, c);
        if (!stored) return { kind: "absent" };
        const nonAdmin = auth.kind === "agent" && !auth.isAdmin;
        if (nonAdmin && isForbiddenOwnerMutation(stored, RECORD_TYPES.Memory.ownerField, auth.agentId)) {
          // The caller passed the owner check at the pre-read above, so a
          // mismatch here is a change committed since — refuse it, do not delete.
          return { kind: "response", response: ownerChangedRefusal("Memory") };
        }
        if (!target || !sameDeleteTarget(stored, target, RECORD_TYPES.Memory.ownerField)) {
          return { kind: "response", response: storedRowChangedRefusal("Memory") };
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
            return { kind: "response", response: ownerChangedRefusal("Memory") };
          }
        }
        // Captured for compensation: this attempt's pointer delete may land even
        // when its row removal is dropped.
        pointerBefore = await loadStoredPointer(deletedId, c);
        const d = await (databases as any).flair.Memory.delete(deletedId, c);
        if (d !== true) throw new Error("Memory row delete was not confirmed");
        const pointerDenial = await deletePointerRow(deletedId, c);
        if (pointerDenial) return { kind: "response", response: pointerDenial };
        historyId = await recordMemoryDeletion({
          memoryId: deletedId,
          memoryInstanceToken: stored.instanceToken ?? null,
          durability: stored.durability ?? null,
          actor: deletionActor,
          sourceClass: deletionSourceClass,
        }, c);
        return { kind: "staged" };
      });
      if (outcome.kind === "response") return outcome.response;
      if (outcome.kind === "absent") return false;
      // The owned transaction has committed. Its success is not proof that the
      // queued delete was applied: confirm against the committed store.
      const targetId = String(targetIdProbe);
      const after = await (databases as any).flair.Memory.get(targetId, {});
      if (!after) {
        applied = true;
        break;
      }
      // Still stored: the removal was dropped while this attempt's history and
      // pointer writes landed. Undo them before the next attempt.
      const compensation = await compensateDroppedRemoval(targetId, historyId, pointerBefore, ctx);
      if (compensation) return compensation;
      if (attempt < DELETE_APPLY_ATTEMPTS) {
        // Test-only: holds a delete whose removal did not land between attempts.
        const retry = txnPausePoint("memory-delete-retry");
        if (retry) await retry;
      }
    }
    if (!applied) return deleteNotAppliedRefusal("Memory", DELETE_APPLY_ATTEMPTS);
    // Test-only: held after the owned transaction committed and the removal was
    // confirmed, while the id's lock is still held (flair#2478).
    const committedPause = txnPausePoint("memory-delete-committed");
    if (committedPause) await committedPause;
    // An owned transaction has committed and its removal is confirmed.
    if (typeof targetIdProbe === "string" && targetIdProbe.length > 0) {
      noteMemoryDelete(targetIdProbe);
    }
    if (typeof id === "string") await clearHitStats(id, ctx).catch(() => {});
    return true;
  }
}
