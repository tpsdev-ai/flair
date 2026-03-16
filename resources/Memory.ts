import { databases } from "@harperfast/harper";
import { patchRecord } from "./table-helpers.js";
import { isAdmin } from "./auth-middleware.js";

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
  async search(query?: any, context?: any) {
    const authAgent: string | undefined = context?.request?.tpsAgent;
    const isAdminAgent: boolean = context?.request?.tpsAgentIsAdmin ?? false;

    // No auth context (internal admin call) or admin agent — unfiltered
    if (!authAgent || isAdminAgent) {
      return super.search(query, context);
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

    // Build an agentId condition: own memories OR granted owners
    // If more than one allowed owner, use "or" across equals conditions
    let agentIdCondition: any;
    if (allowedOwners.length === 1) {
      agentIdCondition = { attribute: "agentId", comparator: "equals", value: allowedOwners[0] };
    } else {
      agentIdCondition = allowedOwners.map((id, i) => {
        const cond = { attribute: "agentId", comparator: "equals", value: id };
        return i === 0 ? cond : ["or", cond];
      });
    }

    // Firmly wrap user query in outer `and` so they cannot escape the scope check
    let scopedQuery: any;
    if (!query || (Array.isArray(query) && query.length === 0)) {
      // No user query — just the agentId filter
      scopedQuery = Array.isArray(agentIdCondition)
        ? agentIdCondition
        : [agentIdCondition];
    } else {
      // Wrap: { and: [agentIdCondition, userQuery] } expressed as Harper conditions
      scopedQuery = { conditions: [agentIdCondition], and: query };
    }

    return super.search(scopedQuery, context);
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

    return super.post(content, context);
  }

  async put(content: any, context?: any) {
    const now = new Date().toISOString();
    content.updatedAt = now;

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

    return super.put(content, context);
  }

  async delete(id: any, context?: any) {
    const record = await this.get(id);
    if (!record) return super.delete(id, context);

    if (record.durability === "permanent") {
      // Middleware already guards this for non-admins, but belt-and-suspenders
      const actorId = context?.request?.tpsAgent;
      if (actorId && !(await isAdmin(actorId))) {
        return new Response(JSON.stringify({ error: "permanent_memory_cannot_be_deleted_by_non_admin" }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    return super.delete(id, context);
  }
}
