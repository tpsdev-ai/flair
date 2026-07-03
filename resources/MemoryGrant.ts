import { databases } from "@harperfast/harper";
import { resolveAgentAuth, allowVerified } from "./agent-auth.js";

const FORBIDDEN = (msg: string) =>
  new Response(JSON.stringify({ error: msg }), { status: 403, headers: { "Content-Type": "application/json" } });
const UNAUTH = () =>
  new Response(JSON.stringify({ error: "authentication required" }), { status: 401, headers: { "Content-Type": "application/json" } });
const NOT_FOUND = () =>
  new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: { "Content-Type": "application/json" } });

/**
 * MemoryGrant — an agent (ownerId) grants another (granteeId) scoped access to its
 * memories. Self-authorizes now that the global gate is non-rejecting (previously a
 * pure @table protected only by the gate → anonymous could read/write any grant).
 *
 * Write: non-admin agents may only create/modify/delete grants they OWN
 *        (ownerId === self) — you can only share your own memories.
 * Read:  non-admin agents see grants where they are owner OR grantee.
 * Internal calls (e.g. Memory.search's grant lookup) and admins pass unfiltered.
 */
export class MemoryGrant extends (databases as any).flair.MemoryGrant {
  private _auth() {
    return resolveAgentAuth((this as any).getContext?.());
  }

  /**
   * Self-authorize now that the global gate is non-rejecting (memory-soul-
   * read-gate family fix, ops-oox7 — same pattern as Memory.ts/Soul.ts/
   * WorkspaceState.ts/Relationship.ts/Integration.ts). Closes the same P0
   * leak: Harper routes `GET /MemoryGrant/<id>` to get() and the collection
   * describe (`GET /MemoryGrant`) outside search(), so neither was gated
   * before this fix — an anonymous caller got a 200 with full grant content.
   * Per-record owner/grantee scoping happens in get() below; the collection
   * scope is still in search().
   */
  allowRead() { return allowVerified((this as any).getContext?.()); }

  /**
   * Override get() to scope by-id reads the same way search() scopes
   * collection reads (memory-soul-read-gate family fix). A grant is visible
   * to either party (ownerId OR granteeId), mirroring search()'s owner-OR-
   * grantee scope. Never distinguishes "doesn't exist" from "exists but not
   * yours" — both return 404, never 403, so a denied caller can't use get()
   * to enumerate other agents' grant ids.
   */
  async get(target?: any) {
    // Collection / query reads arrive as a RequestTarget with
    // `isCollection === true`, and are governed by search() (same owner/
    // grantee scoping). Only a genuine by-id get is ownership-checked below
    // — see Memory.ts's get() for the full rationale (same bug class).
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

    // Non-admin agent: visible if it's the owner OR the grantee (parity with
    // search()'s owner-OR-grantee scope).
    const record = await super.get(target);
    if (!record) return NOT_FOUND();
    if (record.ownerId !== auth.agentId && record.granteeId !== auth.agentId) return NOT_FOUND();
    return record;
  }

  async search(query?: any) {
    const auth = await this._auth();
    if (auth.kind === "anonymous") return UNAUTH();
    if (auth.kind === "internal" || (auth.kind === "agent" && auth.isAdmin)) {
      return super.search(query);
    }
    // owner OR grantee
    const scope = {
      operator: "or",
      conditions: [
        { attribute: "ownerId", comparator: "equals", value: auth.agentId },
        { attribute: "granteeId", comparator: "equals", value: auth.agentId },
      ],
    };
    if (query && typeof query === "object" && !Array.isArray(query)) {
      const existing = query.conditions ?? [];
      query.conditions = Array.isArray(existing) ? [scope, ...existing] : [scope, existing];
      return super.search(query);
    }
    const conditions = Array.isArray(query) && query.length > 0 ? [scope, ...query] : [scope];
    return super.search(conditions);
  }

  async post(content: any, context?: any) {
    const denied = await this._enforceOwnerWrite(content);
    if (denied) return denied;
    content.createdAt ||= new Date().toISOString();
    return super.post(content, context);
  }

  async put(content: any, context?: any) {
    const denied = await this._enforceOwnerWrite(content);
    if (denied) return denied;
    return super.put(content, context);
  }

  async delete(id: any, context?: any) {
    const auth = await this._auth();
    if (auth.kind === "anonymous") return UNAUTH();
    if (auth.kind === "internal" || (auth.kind === "agent" && auth.isAdmin)) {
      return super.delete(id, context);
    }
    // Use super.get(id), NOT this.get(id): the new get() override above 404s
    // (a truthy Response) for a non-owner/non-grantee id, which would
    // otherwise defeat the `if (!record)` check below and mis-route a
    // genuinely-missing record into the FORBIDDEN branch instead of a clean
    // super.delete(id, context) no-op. Mirrors Memory.ts's delete() — same
    // rationale, same fix.
    const record = await super.get(id);
    if (!record) return super.delete(id, context);
    if (record.ownerId !== auth.agentId) {
      return FORBIDDEN("forbidden: cannot delete a grant owned by another agent");
    }
    return super.delete(id, context);
  }

  private async _enforceOwnerWrite(content: any): Promise<Response | null> {
    const auth = await this._auth();
    if (auth.kind === "anonymous") return UNAUTH();
    if (auth.kind === "agent" && !auth.isAdmin && content?.ownerId && content.ownerId !== auth.agentId) {
      return FORBIDDEN("forbidden: cannot grant access to another agent's memories");
    }
    return null;
  }
}
