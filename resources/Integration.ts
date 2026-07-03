import { databases } from "@harperfast/harper";
import { resolveAgentAuth, allowVerified } from "./agent-auth.js";

const FORBIDDEN = (msg: string) =>
  new Response(JSON.stringify({ error: msg }), { status: 403, headers: { "Content-Type": "application/json" } });
const UNAUTH = () =>
  new Response(JSON.stringify({ error: "authentication required" }), { status: 401, headers: { "Content-Type": "application/json" } });
const NOT_FOUND = () =>
  new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: { "Content-Type": "application/json" } });

/**
 * Integration records are agent-owned. Auth: the non-rejecting gate annotates the
 * request; this resource self-enforces (resolveAgentAuth → internal/agent/anonymous).
 * Anonymous HTTP is denied on every path; non-admin agents are scoped to their own
 * agentId. Mirrors the WorkspaceState pattern.
 */
export class Integration extends (databases as any).flair.Integration {
  private _auth() {
    return resolveAgentAuth((this as any).getContext?.());
  }

  /**
   * Self-authorize now that the global gate is non-rejecting (memory-soul-
   * read-gate family fix, ops-oox7 — same pattern as Memory.ts/Soul.ts/
   * WorkspaceState.ts/Relationship.ts). Closes the same P0 leak: Harper
   * routes `GET /Integration/<id>` to get() and the collection describe
   * (`GET /Integration`) outside search(), so neither was gated before this
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
   * integration ids.
   */
  async get(target?: any) {
    // Collection / query reads arrive as a RequestTarget with
    // `isCollection === true`, and are governed by search() (same owner
    // scoping). Only a genuine by-id get is ownership-checked below — see
    // Memory.ts's get() for the full rationale (same bug class).
    if (!target || (typeof target === "object" && target.isCollection)) {
      return this.search(target);
    }

    const auth = await this._auth();

    // Anonymous by-id read is already blocked at the allowRead() gate (403);
    // this is defense-in-depth if get() is ever reached directly.
    if (auth.kind === "anonymous") {
      return NOT_FOUND();
    }

    // Trusted internal call or admin agent — unfiltered, unchanged behavior.
    if (auth.kind === "internal" || (auth.kind === "agent" && auth.isAdmin)) {
      return super.get(target);
    }

    // Non-admin agent: only its own integrations.
    const record = await super.get(target);
    if (!record) return NOT_FOUND();
    if (record.agentId !== auth.agentId) return NOT_FOUND();
    return record;
  }

  async search(query?: any) {
    const auth = await this._auth();
    if (auth.kind === "anonymous") return UNAUTH();
    if (auth.kind === "internal" || (auth.kind === "agent" && auth.isAdmin)) {
      return super.search(query);
    }
    const agentIdCondition = { attribute: "agentId", comparator: "equals", value: auth.agentId };
    if (query && typeof query === "object" && !Array.isArray(query)) {
      const existing = query.conditions ?? [];
      query.conditions = Array.isArray(existing) ? [agentIdCondition, ...existing] : [agentIdCondition, existing];
      return super.search(query);
    }
    const conditions = Array.isArray(query) && query.length > 0 ? [agentIdCondition, ...query] : [agentIdCondition];
    return super.search(conditions);
  }

  async post(content: any, context?: any) {
    const auth = await this._auth();
    if (auth.kind === "anonymous") return UNAUTH();
    if (auth.kind === "agent" && !auth.isAdmin && content?.agentId && content.agentId !== auth.agentId) {
      return FORBIDDEN("forbidden: cannot write integration for another agent");
    }
    // S31-A: API never accepts plaintext credentials.
    if (typeof content?.credential === "string" || typeof content?.token === "string") {
      return new Response(JSON.stringify({ error: "plaintext_credentials_forbidden" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    return super.post(content, context);
  }

  async put(content: any, context?: any) {
    const auth = await this._auth();
    if (auth.kind === "anonymous") return UNAUTH();
    if (auth.kind === "agent" && !auth.isAdmin && content?.agentId && content.agentId !== auth.agentId) {
      return FORBIDDEN("forbidden: cannot write integration for another agent");
    }
    if (typeof content?.credential === "string" || typeof content?.token === "string") {
      return new Response(JSON.stringify({ error: "plaintext_credentials_forbidden" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    return super.put(content, context);
  }

  async delete(id: any) {
    const auth = await this._auth();
    if (auth.kind === "anonymous") return UNAUTH();
    if (auth.kind === "internal" || (auth.kind === "agent" && auth.isAdmin)) {
      return super.delete(id);
    }
    // Use super.get(id), NOT this.get(id): the new get() override above 404s
    // (a truthy Response) for a non-owner id, which would otherwise defeat
    // the `if (!record)` check below and mis-route a genuinely-missing
    // record into the FORBIDDEN branch instead of a clean super.delete(id)
    // no-op. Mirrors Memory.ts's delete() — same rationale, same fix.
    const record = await super.get(id);
    if (!record) return super.delete(id);
    if (record.agentId !== auth.agentId) {
      return FORBIDDEN("forbidden: cannot delete integration for another agent");
    }
    return super.delete(id);
  }
}
