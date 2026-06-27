import { databases } from "@harperfast/harper";
import { resolveAgentAuth } from "./agent-auth.js";
import { MCP_HIDDEN } from "./mcp-curation.js";

const FORBIDDEN = (msg: string) =>
  new Response(JSON.stringify({ error: msg }), { status: 403, headers: { "Content-Type": "application/json" } });
const UNAUTH = () =>
  new Response(JSON.stringify({ error: "authentication required" }), { status: 401, headers: { "Content-Type": "application/json" } });

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
  // Suppress from the native MCP application profile (only FlairMcp is exposed). See mcp-curation.ts.
  static hidden = MCP_HIDDEN;
  private _auth() {
    return resolveAgentAuth((this as any).getContext?.());
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
    const record = await this.get(id);
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
