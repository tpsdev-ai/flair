/**
 * WorkspaceState.ts — Harper table resource for workspace state records (OPS-47 Phase 2)
 *
 * Auth: Ed25519 middleware sets request.tpsAgent. Agent can only read/write own records.
 * Pattern follows Memory.ts — extends Harper auto-generated table class.
 *
 * Note: Harper's static methods call instance methods with positional args only.
 * Use this.getContext() to access request context (tpsAgent, tpsAgentIsAdmin).
 */

import { databases } from "@harperfast/harper";
import { resolveAgentAuth, allowVerified } from "./agent-auth.js";

const FORBIDDEN = (msg: string) =>
  new Response(JSON.stringify({ error: msg }), { status: 403, headers: { "Content-Type": "application/json" } });
const UNAUTH = () =>
  new Response(JSON.stringify({ error: "authentication required" }), { status: 401, headers: { "Content-Type": "application/json" } });
const NOT_FOUND = () =>
  new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: { "Content-Type": "application/json" } });

export class WorkspaceState extends (databases as any).flair.WorkspaceState {
  /** Auth verdict from the request context. internal = trusted in-process call;
   *  agent = verified Ed25519; anonymous = HTTP with no valid agent → deny. */
  private _auth() {
    return resolveAgentAuth((this as any).getContext?.());
  }

  /**
   * Self-authorize now that the global gate is non-rejecting (memory-soul-
   * read-gate family fix, ops-oox7 — applying the Memory.ts/Soul.ts pattern
   * to WorkspaceState/Relationship/Integration/MemoryGrant). Closes the same
   * P0 leak: Harper routes `GET /WorkspaceState/<id>` to get() and the
   * collection describe (`GET /WorkspaceState`) to a path outside search(),
   * so neither was gated before this fix — an anonymous caller got a 200 with
   * full record content. Per-record ownership scoping happens in get() below;
   * the collection scope is still in search().
   */
  allowRead() { return allowVerified((this as any).getContext?.()); }

  /**
   * Override get() to scope by-id reads the same way search() scopes
   * collection reads (memory-soul-read-gate family fix). Never distinguishes
   * "doesn't exist" from "exists but not yours" — both return 404, never
   * 403, so a denied caller can't use get() to enumerate other agents'
   * workspace-state ids.
   */
  async get(target?: any) {
    // Collection / query reads — the `GET /WorkspaceState/?<query>` form and
    // the bare collection — arrive as a RequestTarget with `isCollection ===
    // true`, and are governed by search() (same owner scoping). Only a
    // genuine by-id get is ownership-checked below. Without this guard,
    // get() would receive the query's RequestTarget, super.get() would
    // return the (truthy) result set, and the single-record ownership check
    // would find no `.agentId` on it (see Memory.ts's get() for the full
    // rationale — same bug class).
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

    // Non-admin agent: only its own workspace-state records.
    const record = await super.get(target);
    if (!record) return NOT_FOUND();
    if (record.agentId !== auth.agentId) return NOT_FOUND();
    return record;
  }

  /**
   * Override search() to scope collection GETs to the authenticated agent's own
   * records. Internal calls + admin agents see all; anonymous is denied
   * (previously `!authAgent` was treated as unfiltered — the anonymous-read leak).
   */
  async search(query?: any) {
    const auth = await this._auth();
    if (auth.kind === "anonymous") return UNAUTH();
    if (auth.kind === "internal" || (auth.kind === "agent" && auth.isAdmin)) {
      return super.search(query);
    }

    const agentIdCondition = { attribute: "agentId", comparator: "equals", value: auth.agentId };

    // Harper passes `query` as a request target object (pathname, id, isCollection…).
    // Inject the scope condition into its `.conditions` array.
    if (query && typeof query === "object" && !Array.isArray(query)) {
      const existing = query.conditions ?? [];
      query.conditions = Array.isArray(existing)
        ? [agentIdCondition, ...existing]
        : [agentIdCondition, existing];
      return super.search(query);
    }

    const conditions = Array.isArray(query) && query.length > 0
      ? [agentIdCondition, ...query]
      : [agentIdCondition];
    return super.search(conditions);
  }

  async post(content: any) {
    const auth = await this._auth();
    // Anonymous must NOT write (previously the agentId check was skipped when
    // there was no authenticated agent, so anonymous could write any record).
    if (auth.kind === "anonymous") return UNAUTH();

    // No-forge: a non-admin agent's workspace record is ALWAYS attributed to the
    // authenticated identity (from the Ed25519 signature), never the body. We do
    // NOT trust `content.agentId` — overwriting it (rather than 403'ing a
    // mismatch) mirrors Presence.post(): "agentId from signature, NOT from body".
    // An admin may write on behalf of another agent (content.agentId honored if
    // present, else defaults to the admin's own id). Internal in-process callers
    // keep whatever agentId they pass.
    if (auth.kind === "agent" && !auth.isAdmin) {
      content.agentId = auth.agentId;
    } else if (auth.kind === "agent" && auth.isAdmin) {
      content.agentId ||= auth.agentId;
    }

    content.createdAt = new Date().toISOString();
    content.timestamp ||= content.createdAt;

    return super.post(content);
  }

  async put(content: any) {
    const auth = await this._auth();
    if (auth.kind === "anonymous") return UNAUTH();
    if (auth.kind === "agent" && !auth.isAdmin && content.agentId !== auth.agentId) {
      return FORBIDDEN("forbidden: cannot write workspace state for another agent");
    }

    return super.put(content);
  }

  async delete(id: any) {
    const auth = await this._auth();
    // Anonymous must NOT delete (previously `!agentId → super.delete` let anonymous
    // delete any record).
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
      return FORBIDDEN("forbidden: cannot delete workspace state for another agent");
    }
    return super.delete(id);
  }
}
