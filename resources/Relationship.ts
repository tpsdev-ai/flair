import { databases } from "@harperfast/harper";
import { isAdmin } from "./auth-middleware.js";
import { checkRateLimit, rateLimitResponse } from "./rate-limiter.js";

/**
 * Relationship resource — entity-to-entity relationships with temporal validity.
 *
 * Enables knowledge graph queries like:
 *   - "Who manages project X?" (active relationships)
 *   - "Who was team lead in Q1?" (historical, validFrom/validTo bounded)
 *   - "What changed about Nathan's role?" (all relationships for a subject, ordered by time)
 *
 * Relationships are scoped by agentId for multi-agent isolation.
 * Admin agents can query across all agents.
 */
export class Relationship extends (databases as any).flair.Relationship {

  async search(query?: any) {
    const ctx = (this as any).getContext?.();
    const request = ctx?.request ?? ctx;
    const authAgent: string | undefined = request?.tpsAgent;
    const isAdminAgent: boolean = request?.tpsAgentIsAdmin ?? false;

    if (!authAgent || isAdminAgent) {
      return super.search(query);
    }

    // Non-admin: scope to own relationships
    const agentCondition = { attribute: "agentId", comparator: "equals", value: authAgent };
    if (!query?.conditions) {
      return super.search({ conditions: [agentCondition], ...(query || {}) });
    }
    return super.search({
      ...query,
      conditions: [agentCondition, { conditions: query.conditions, operator: query.operator || "and" }],
      operator: "and",
    });
  }

  async put(content: any) {
    const ctx = (this as any).getContext?.();
    const request = ctx?.request ?? ctx;
    const authAgent: string | undefined = request?.tpsAgent;

    if (!authAgent) {
      return new Response(JSON.stringify({ error: "authentication required" }), {
        status: 401, headers: { "content-type": "application/json" },
      });
    }

    const rateLimitResult = checkRateLimit(authAgent);
    if (rateLimitResult) return rateLimitResponse(rateLimitResult);

    // Validate required fields
    if (!content.subject || typeof content.subject !== "string") {
      return new Response(JSON.stringify({ error: "subject is required (string)" }), {
        status: 400, headers: { "content-type": "application/json" },
      });
    }
    if (!content.predicate || typeof content.predicate !== "string") {
      return new Response(JSON.stringify({ error: "predicate is required (string)" }), {
        status: 400, headers: { "content-type": "application/json" },
      });
    }
    if (!content.object || typeof content.object !== "string") {
      return new Response(JSON.stringify({ error: "object is required (string)" }), {
        status: 400, headers: { "content-type": "application/json" },
      });
    }

    // Normalize
    const now = new Date().toISOString();
    content.agentId = authAgent;
    content.subject = content.subject.toLowerCase();
    content.predicate = content.predicate.toLowerCase();
    content.object = content.object.toLowerCase();
    content.createdAt = content.createdAt || now;
    content.updatedAt = now;
    content.validFrom = content.validFrom || now;
    // validTo left as null/undefined for active relationships
    content.confidence = content.confidence ?? 1.0;

    return super.put(content);
  }

  async delete(_: any) {
    const ctx = (this as any).getContext?.();
    const request = ctx?.request ?? ctx;
    const authAgent: string | undefined = request?.tpsAgent;
    const isAdminAgent: boolean = request?.tpsAgentIsAdmin ?? false;

    if (!authAgent) {
      return new Response(JSON.stringify({ error: "authentication required" }), {
        status: 401, headers: { "content-type": "application/json" },
      });
    }

    // Non-admin: verify ownership before delete
    if (!isAdminAgent) {
      const existing = await super.get();
      if (existing?.agentId && existing.agentId !== authAgent) {
        return new Response(JSON.stringify({ error: "cannot delete another agent's relationship" }), {
          status: 403, headers: { "content-type": "application/json" },
        });
      }
    }

    return super.delete(_);
  }
}
