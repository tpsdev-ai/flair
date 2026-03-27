import { databases } from "@harperfast/harper";
import { patchRecord } from "./table-helpers.js";
import { isAdmin } from "./auth-middleware.js";
import { getEmbedding } from "./embeddings-provider.js";
import { scanContent, isStrictMode } from "./content-safety.js";

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
    // Access request context via Harper's Resource instance context
    const ctx = (this as any).getContext?.();
    const request = ctx?.request ?? ctx;
    const authAgent: string | undefined = request?.tpsAgent;
    const isAdminAgent: boolean = request?.tpsAgentIsAdmin ?? false;

    // No auth context (internal admin call) or admin agent — unfiltered
    if (!authAgent || isAdminAgent) {
      return super.search(query);
    }

    // Collect agentIds this agent may read: own + any granted owners
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

    // Harper passes `query` as a RequestTarget (extends URLSearchParams) with pathname, id, etc.
    // Table.search() reads `target.conditions` from it. We inject our scope condition there.
    if (query && typeof query === "object" && !Array.isArray(query)) {
      const existing = query.conditions ?? [];
      query.conditions = Array.isArray(existing)
        ? [agentIdCondition, ...existing]
        : [agentIdCondition, existing];
      return super.search(query);
    }

    // Fallback: plain array or no query (internal calls)
    const conditions = Array.isArray(query) && query.length > 0
      ? [agentIdCondition, ...query]
      : [agentIdCondition];
    return super.search(conditions);
  }

  async post(content: any, context?: any) {
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

    if (content.durability === "ephemeral" && !content.expiresAt) {
      const ttlHours = Number(process.env.FLAIR_EPHEMERAL_TTL_HOURS || 24);
      content.expiresAt = new Date(Date.now() + ttlHours * 3600_000).toISOString();
    }

    // Content safety scan
    if (content.content) {
      const safety = scanContent(content.content);
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
      if (vec) content.embedding = vec;
    }

    return super.post(content);
  }

  async put(content: any) {
    const now = new Date().toISOString();
    content.updatedAt = now;

    // Content safety scan on updated content
    if (content.content) {
      const safety = scanContent(content.content);
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
        // Clear previous flags if content is now clean
        content._safetyFlags = null;
      }
    }

    // Re-generate embedding if content changed
    if (content.content && !content.embedding) {
      const vec = await getEmbedding(content.content);
      if (vec) content.embedding = vec;
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
