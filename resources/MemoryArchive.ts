/**
 * MemoryArchive.ts — user-facing archive action (flair#1472, Deliverable A).
 *
 * POST /MemoryArchive — sets or clears the `archived` visibility flag on a
 * memory by id:
 *   - `action: "basement"` → archived=true + stamps archivedAt (and archivedBy)
 *   - `action: "restore"`  → archived=false + clears archivedAt/archivedBy
 *
 * `archived` is a VISIBILITY flag, not a deletion: basementing removes a
 * memory from bootstrap + default search but leaves the row, its provenance,
 * and its history fully intact (still retrievable via memory_get and
 * memory_search(includeArchived:true)). Restore is the deliberate, GLOBAL
 * inverse — it un-retires the memory for EVERY session, not a session-local
 * view (per-session reuse is drawers, Deliverable B, which does not exist
 * yet). The CLI help text must make that global scope explicit.
 *
 * Own-lane scope: the read uses Memory.get()'s read-scope gate and the write
 * uses Memory.put()'s ownership gate (stampAttribution), so a caller can
 * neither read nor write another agent's memory here. Anonymous HTTP is
 * denied (401).
 *
 * Registered automatically at /MemoryArchive via config.yaml's
 * `jsResource: files: dist/resources/*.js` (named export → export name).
 */

import { Resource, databases } from "harper";
import { isDeepStrictEqual } from "node:util";
import { Memory } from "./Memory.js";
import { resolveAgentAuth, allowVerified } from "./agent-auth.js";
import { withOwnedTransaction } from "./request-transaction.js";
import { txnPausePoint } from "./txn-pause-point.js";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * A refusal or failure from Memory.get()/Memory.put() is a Harper `Response`
 * (it carries `.status` + `.json`); a successful read/write is a plain record.
 * Return the Response as-is so the endpoint answers with THAT HTTP status and
 * its named error, and pass a record through unchanged.
 * Returning an unwrapped write refusal would serialize it as HTTP 200;
 * unwrapping a read refusal would replace it with the generic 404 below.
 */
function asResponse(value: any): Response | null {
  if (value && typeof value === "object" && typeof value.json === "function" && "status" in value) {
    return value as Response;
  }
  return null;
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

    // flair#2275: re-read the row INSIDE a transaction this call OWNS and build
    // the write from THAT read — never from the basis above, which another
    // writer may have changed before the write. Unequal persisted rows are
    // refused (409); a non-readable row returns 404. Changes after the re-read
    // are not checked.
    return await withOwnedTransaction(ctx, async (c) => {
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
        // archivedBy is set by the caller (Memory.put() stamps archivedAt when
        // archived===true). The content is unchanged, so the existing embedding
        // stays valid — do NOT clear it (clearing would force a needless re-embed
        // and, if the embedding engine is unavailable, silently drop the vector).
        merged.archivedBy = auth.agentId;
      } else {
        delete merged.archivedAt;
        delete merged.archivedBy;
      }

      // flair#1940 A3 (item 9): omit every pointer field from the write-back so
      // the stored pointer row, its full URL and its scope stand.
      delete merged.hostSource;
      delete merged.hostSourceScope;
      delete merged.hostSourceVisibility;

      // Write back — Memory.put()'s ownership gate applies (stampAttribution), so
      // a non-admin caller cannot flip another agent's memory (403).
      const result = await Memory.put(merged, c);
      const writeRefusal = asResponse(result);
      if (writeRefusal) return writeRefusal;
      return result;
    });
  }
}
