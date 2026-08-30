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

import { Resource } from "harper";
import { Memory } from "./Memory.js";
import { resolveAgentAuth, allowVerified } from "./agent-auth.js";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Unwrap a Harper Response (has .json() + .status) into a plain object, else pass through. */
async function unwrap(value: any): Promise<any> {
  if (value && typeof value === "object" && typeof value.json === "function" && "status" in value) {
    try {
      const body = await value.json();
      return { ...body, status: value.status };
    } catch {
      return { error: "request failed", status: value.status };
    }
  }
  return value;
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
    const record = await unwrap(existing);
    if (!record || typeof record !== "object" || !record.id) {
      return json(404, { error: "memory not found" });
    }

    const archived = action === "basement";
    const merged: Record<string, unknown> = {
      ...record,
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

    // Write back — Memory.put()'s ownership gate applies (stampAttribution), so
    // a non-admin caller cannot flip another agent's memory (403).
    const result = await Memory.put(merged, ctx);
    return unwrap(result);
  }
}
