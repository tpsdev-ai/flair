/**
 * MemoryArchive.ts — user-facing archive action (flair#1472, Deliverable A).
 *
 * POST /MemoryArchive — sets or clears the `archived` visibility flag on a
 * memory by id:
 *   - `action: "basement"` sets `archived: true` and `archivedBy` to the
 *     caller; Memory's shared locked PUT body (putLocked) supplies `archivedAt`
 *     when it is absent or falsy.
 *   - `action: "restore"`  → archived=false + clears archivedAt/archivedBy
 *
 * `archived` is a VISIBILITY flag, not a deletion. Basementing retains the row
 * and excludes it from bootstrap and default semantic search; the write still
 * applies Memory.put()'s validation, redaction and provenance stamping.
 * By-id retrieval remains subject to Memory's read checks; `includeArchived:
 * true` removes the semantic-search archive filter while retaining the other
 * retrieval filters. Restore is the deliberate inverse: it clears the archive
 * state globally, not in a session-local view (per-session reuse is drawers,
 * Deliverable B, which does not exist yet); other read and retrieval
 * conditions still apply. The CLI help text must make that global scope
 * explicit.
 *
 * Scope: reads use Memory.get()'s read policy; non-admin callers may archive
 * or restore only their own memories (Memory.put()'s ownership gate,
 * stampAttribution), while administrators may act on another agent's memory.
 * Anonymous HTTP is refused by allowCreate() before post() runs, with the
 * status Harper returns for a denied allowCreate() (403 for SkillScan's same
 * allowVerified() gate in test/integration/gate4-authgate.test.ts).
 *
 * The write of a non-skill row (flair#2478 part 3a): after the read above,
 * the archive takes the per-id Memory write lock for the id (and for the row
 * its `supersedes` names, which the PUT body may close: for its owner or an
 * admin after the commit, best effort, a failed close logged; under a write
 * grant staged in the write's transaction, so a failed close aborts the
 * write; a non-admin write whose stored predecessor is missing closes
 * nothing) under phase `archive-basement` /
 * `archive-restore`, opens a locked transaction scope
 * (resources/memory-write-transaction.ts), re-reads the row inside it, and
 * writes through `putMemoryWithLock`. The scope commits, then
 * confirms the row's identity, the PUT's verified fields and the archive fields
 * (`archived`, `archivedAt`, `archivedBy`), and only then answers; the lock is
 * held throughout. An owner PUT or PATCH of a held id waits within its budget
 * and, if the hold outlasts it, answers `503 memory_busy` (an id with an
 * unresolved write outcome answers `503 write_outcome_unknown` first); when
 * the archive cannot take the lock, it answers the lock's refusal itself. A skill row keeps the existing
 * Memory.put() path and its skill-state refusals (`skill_state_requires_delete`
 * for `archived: true`); the skill version writer is converted later.
 *
 * Registered automatically at /MemoryArchive via config.yaml's
 * `jsResource: files: dist/resources/*.js` (named export → export name).
 */

import { Resource, databases } from "harper";
import { isDeepStrictEqual } from "node:util";
import { Memory, memoryLockCallerIdFor, putMemoryWithLock } from "./Memory.js";
import { resolveAgentAuth, allowVerified } from "./agent-auth.js";
import { withOwnedTransaction } from "./request-transaction.js";
import { txnPausePoint } from "./txn-pause-point.js";
import { memoryBusyResponse, memoryLockUnavailableResponse, withMemoryWriteLock, writeOutcomeUnknownResponse } from "./memory-write-lock.js";
import { lockedTransactionContext, withLockedMemoryTransaction } from "./memory-write-transaction.js";
import { resolveMemoryReferenceId } from "./memory-id-guard.js";
import { rowIsSkill } from "./skill-version-write.js";
import { memoryPrimaryStore } from "./promotion-stamp.js";

/** The archive fields the post-commit confirmation compares exactly. */
const ARCHIVE_FIELDS = Object.freeze(["archived", "archivedAt", "archivedBy"]);

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * A refusal or failure from Memory.get()/Memory.put() is a Harper `Response`
 * (it carries `.status` + `.json`). A successful read returns the readable
 * memory, and a successful ordinary write returns a write receipt; returned
 * refusal Responses retain their HTTP status and body. Return the Response
 * as-is so the endpoint answers with THAT HTTP status and its named error, and
 * pass a successful result through unchanged.
 * Returning an unwrapped write refusal would serialize it as HTTP 200;
 * unwrapping a read refusal would replace it with the generic 404 below.
 */
function asResponse(value: any): Response | null {
  if (value && typeof value === "object" && typeof value.json === "function" && "status" in value) {
    return value as Response;
  }
  return null;
}

/**
 * The archive's authoritative read and its write body: re-read the row with
 * `c` (in the transaction `c` carries), return a read refusal with its own
 * status, refuse a missing row (404) or one whose persisted row differs from
 * the basis (409 `memory_changed`), and merge
 * the archive fields into the re-read row. The re-read row's embedding is kept;
 * pointer fields are omitted so the stored pointer row stands.
 */
async function rereadAndMerge(
  id: unknown,
  c: any,
  persistedBasis: unknown,
  archived: boolean,
  callerId: string,
): Promise<Record<string, unknown> | Response> {
  const reread = await Memory.get(id, c);
  const rereadRefusal = asResponse(reread);
  if (rereadRefusal) return rereadRefusal;
  if (!reread || typeof reread !== "object" || !reread.id) {
    return json(404, { error: "memory not found" });
  }
  const persistedReread = await (databases as any).flair.Memory.get(id, c);
  if (!persistedReread) return json(404, { error: "memory not found" });
  if (!isDeepStrictEqual(persistedReread, persistedBasis)) {
    return json(409, { error: "memory_changed" });
  }
  const merged: Record<string, unknown> = {
    ...reread,
    archived,
    updatedAt: new Date().toISOString(),
  };
  if (archived) {
    // archivedBy is set by the caller. Memory's shared locked PUT body
    // (putLocked, which putMemoryWithLock enters for this non-skill row)
    // handles text redaction and embedding, and the archivedAt stamp the file
    // header describes. The archive request retains the existing embedding — do NOT
    // clear it (clearing would force a needless re-embed and, if the
    // embedding engine is unavailable, silently drop the vector).
    merged.archivedBy = callerId;
  } else {
    delete merged.archivedAt;
    delete merged.archivedBy;
  }

  // flair#1940 A3 (item 9): omit every pointer field from the write-back so
  // the stored pointer row, its full URL and its scope stand.
  delete merged.hostSource;
  delete merged.hostSourceScope;
  delete merged.hostSourceVisibility;
  return merged;
}

export class MemoryArchive extends Resource {
  /** POST requires auth — an agent acting on its own memories (or admin). */
  async allowCreate(): Promise<boolean> {
    return allowVerified((this as any).getContext?.());
  }

  async post(data: any) {
    const { id, action } = data || {};
    if (!id) return json(400, { error: "id required" });
    if (action !== "basement" && action !== "restore") {
      return json(400, { error: "action must be 'basement' or 'restore'" });
    }

    const ctx = (this as any).getContext?.();
    const auth = await resolveAgentAuth(ctx);
    if (auth.kind === "anonymous") return json(401, { error: "authentication required" });
    if (auth.kind !== "agent") return json(403, { error: "forbidden" });

    // Read the existing record — Memory.get()'s read-scope gate applies (own +
    // org-non-private only). A non-readable id returns a 404 Response.
    // Non-admin reads of retained closed skill payloads also apply
    // `closedSkillPayloadReadable`; a failed check returns 404 by id or omits
    // the collection row.
    const existing = await Memory.get(id, ctx);
    const readRefusal = asResponse(existing);
    if (readRefusal) return readRefusal;
    const basis = existing;
    if (!basis || typeof basis !== "object" || !basis.id) {
      return json(404, { error: "memory not found" });
    }
    const persistedBasis = await (databases as any).flair.Memory.get(id, ctx);
    if (!persistedBasis) return json(404, { error: "memory not found" });

    const archived = action === "basement";

    // Test-only: inert unless the fault-injection env opt-in is set and armed.
    const beforeReread = txnPausePoint("memory-archive-pre");
    if (beforeReread) await beforeReread;

    // A skill row keeps the existing Memory.put() path, and its skill-state
    // refusals, in a transaction this call owns (not converted to the checked
    // write yet).
    if (rowIsSkill(persistedBasis)) {
      return await withOwnedTransaction(ctx, async (c) => {
        const merged = await rereadAndMerge(id, c, persistedBasis, archived, auth.agentId);
        if (merged instanceof Response) return merged;
        const result = await Memory.put(merged, c);
        return asResponse(result) ?? result;
      });
    }

    // flair#2478 part 3a: the lock set is the id and the row its `supersedes`
    // names (the PUT body's possible close target), read from the basis. A
    // row whose stored reference differs at the re-read is refused 409 below,
    // before any write.
    const targetId = String(persistedBasis.id);
    const lockIds = [targetId];
    if (typeof persistedBasis.supersedes === "string") {
      lockIds.push(persistedBasis.supersedes);
      const canonical = resolveMemoryReferenceId(persistedBasis.supersedes);
      if (canonical !== undefined) lockIds.push(canonical);
    }
    const outcome = await withMemoryWriteLock(memoryPrimaryStore(), lockIds, (held) =>
      withLockedMemoryTransaction(held, ctx, async (tx) => {
        // flair#2275: re-read the row INSIDE the locked transaction and build the
        // write from THAT read — never from the basis above, which another writer
        // may have changed before the lock was taken. Unequal persisted rows are
        // refused (409); a read refusal keeps its own status, and a missing row
        // returns 404.
        const merged = await rereadAndMerge(id, lockedTransactionContext(tx), persistedBasis, archived, auth.agentId);
        if (merged instanceof Response) return merged;
        // Memory.put()'s write body, joined to this transaction: its ownership
        // gate (stampAttribution) applies, so a non-admin caller cannot flip
        // another agent's memory (403).
        return putMemoryWithLock(held, tx, { id: targetId, content: merged, confirmFields: ARCHIVE_FIELDS });
      }), { phase: `archive-${action}` });
    if (outcome.kind === "busy") return memoryBusyResponse(memoryLockCallerIdFor(ctx));
    if (outcome.kind === "unknown") return writeOutcomeUnknownResponse();
    if (outcome.kind === "unavailable") return memoryLockUnavailableResponse();
    const written = outcome.value;
    if (written.kind === "refused") return written.response;
    return written.confirmed[0];
  }
}
