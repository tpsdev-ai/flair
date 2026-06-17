import { databases } from "@harperfast/harper";
import { patchRecord, withDetachedTxn } from "./table-helpers.js";
import { isAdmin, resolveAgentAuth } from "./agent-auth.js";
import { getEmbedding, getModelId } from "./embeddings-provider.js";
import { scanFields, isStrictMode } from "./content-safety.js";
import { checkRateLimit, rateLimitResponse } from "./rate-limiter.js";

export class Memory extends (databases as any).flair.Memory {
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
    const allowedOwners: string[] = [authAgent];
    try {
      for await (const grant of (databases as any).flair.MemoryGrant.search({
        conditions: [{ attribute: "granteeId", comparator: "equals", value: authAgent }],
      })) {
        if (grant.ownerId && (grant.scope === "read" || grant.scope === "search")) {
          allowedOwners.push(grant.ownerId);
        }
      }
    } catch { /* MemoryGrant table not yet populated — ignore */ }

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
    {
      const auth = await resolveAgentAuth(ctx);
      // Anonymous HTTP must NOT write. Pre-flip the global gate rejected no-auth
      // upstream; with the non-rejecting gate, each write path self-enforces (same
      // rule search() applies to reads).
      if (auth.kind === "anonymous") {
        return new Response(JSON.stringify({ error: "authentication required" }), {
          status: 401, headers: { "Content-Type": "application/json" },
        });
      }
      if (auth.kind === "agent" && !auth.isAdmin && content?.agentId && content.agentId !== auth.agentId) {
        return new Response(JSON.stringify({ error: "forbidden: cannot write memory owned by another agent" }), {
          status: 403, headers: { "Content-Type": "application/json" },
        });
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

    // supersedes: optional reference to the ID of the memory this one replaces
    if (content.supersedes !== undefined && typeof content.supersedes !== "string") {
      return new Response(JSON.stringify({ error: "supersedes must be a string (memory ID)" }), {
        status: 400, headers: { "Content-Type": "application/json" },
      });
    }

    // Temporal validity: validFrom defaults to now, validTo left null for active facts.
    // When a memory supersedes another, close the superseded memory's validity window.
    if (!content.validFrom) {
      content.validFrom = content.createdAt;
    }
    if (content.supersedes) {
      patchRecord((databases as any).flair.Memory, content.supersedes, {
        validTo: content.validFrom,
        updatedAt: content.createdAt,
      }).catch(() => {});
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

    // Generate embedding from content text
    if (content.content && !content.embedding) {
      const vec = await getEmbedding(content.content);
      if (vec) { content.embedding = vec; content.embeddingModel = getModelId(); }
    }

    return super.post(content);
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
    {
      const octx = (this as any).getContext?.();
      const auth = await resolveAgentAuth(octx);
      // Anonymous HTTP must NOT write (non-rejecting gate → self-enforce here).
      if (auth.kind === "anonymous") {
        return new Response(JSON.stringify({ error: "authentication required" }), {
          status: 401, headers: { "Content-Type": "application/json" },
        });
      }
      if (auth.kind === "agent" && !auth.isAdmin && content?.agentId && content.agentId !== auth.agentId) {
        return new Response(JSON.stringify({ error: "forbidden: cannot write memory owned by another agent" }), {
          status: 403, headers: { "Content-Type": "application/json" },
        });
      }
    }

    const now = new Date().toISOString();
    content.updatedAt = now;
    // Set defaults that post() sets — put() is also used for new records via CLI
    content.archived = content.archived ?? false;
    content.createdAt = content.createdAt ?? now;

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

    // Re-generate embedding if content changed
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

    return super.put(content);
  }

  async delete(id: any) {
    const record = await this.get(id);
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
