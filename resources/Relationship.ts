import { databases } from "@harperfast/harper";
import { resolveAgentAuth, allowVerified } from "./agent-auth.js";
import { checkRateLimit, rateLimitResponse } from "./rate-limiter.js";

const NOT_FOUND = () =>
  new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: { "Content-Type": "application/json" } });

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
  /**
   * Self-authorize now that the global gate is non-rejecting (memory-soul-
   * read-gate family fix, ops-oox7 — same pattern as Memory.ts/Soul.ts/
   * WorkspaceState.ts). Closes the same P0 leak: Harper routes
   * `GET /Relationship/<id>` to get() and the collection describe
   * (`GET /Relationship`) outside search(), so neither was gated before this
   * fix — an anonymous caller got a 200 with full record content. Per-record
   * ownership scoping happens in get() below; the collection scope is still
   * in search().
   */
  allowRead() { return allowVerified((this as any).getContext?.()); }

  /**
   * Override get() to scope by-id reads the same way search() scopes
   * collection reads (memory-soul-read-gate family fix). Never distinguishes
   * "doesn't exist" from "exists but not yours" — both return 404, never
   * 403, so a denied caller can't use get() to enumerate other agents'
   * relationship ids.
   */
  async get(target?: any) {
    // Collection / query reads arrive as a RequestTarget with
    // `isCollection === true`, and are governed by search() (same owner
    // scoping). Only a genuine by-id get is ownership-checked below — see
    // Memory.ts's get() for the full rationale (same bug class: without this
    // guard, a query's RequestTarget would flow into super.get(), return the
    // whole result set, and the single-record ownership check below would
    // find no `.agentId` on it).
    if (!target || (typeof target === "object" && target.isCollection)) {
      return this.search(target);
    }

    const auth = await resolveAgentAuth((this as any).getContext?.());

    // Anonymous by-id read is already blocked at the allowRead() gate (403);
    // this is defense-in-depth if get() is ever reached directly.
    if (auth.kind === "anonymous") {
      return NOT_FOUND();
    }

    // Trusted internal call or admin agent — unfiltered, unchanged behavior.
    if (auth.kind === "internal" || (auth.kind === "agent" && auth.isAdmin)) {
      return super.get(target);
    }

    // Non-admin agent: only its own relationships.
    const record = await super.get(target);
    if (!record) return NOT_FOUND();
    if (record.agentId !== auth.agentId) return NOT_FOUND();
    return record;
  }

  async search(query?: any) {
    const auth = await resolveAgentAuth((this as any).getContext?.());

    // Anonymous HTTP must NOT read relationships (previously `!authAgent` was
    // treated as unfiltered — the anonymous-read leak).
    if (auth.kind === "anonymous") {
      return new Response(JSON.stringify({ error: "authentication required" }), {
        status: 401, headers: { "content-type": "application/json" },
      });
    }
    // Trusted internal call or admin agent → unfiltered.
    if (auth.kind === "internal" || (auth.kind === "agent" && auth.isAdmin)) {
      return super.search(query);
    }

    // Non-admin agent: scope to own relationships.
    const agentCondition = { attribute: "agentId", comparator: "equals", value: auth.agentId };
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

    const rl = checkRateLimit(authAgent);
    if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs!, "relationship");

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
