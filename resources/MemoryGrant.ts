import { databases } from "harper";
import { resolveAgentAuth, allowVerified } from "./agent-auth.js";
import { guardOwnerFieldImmutable } from "./owner-field-guard.js";
import { deleteOwnedRow } from "./owner-delete-recheck.js";
import { txnPausePoint } from "./txn-pause-point.js";
import { makeByIdReadGate, makeScopedSearch, type RecordTypeReadScope } from "./record-type-kit.js";

// A grant is readable by either party: owner OR grantee. One scope object feeds
// both the shared by-id gate and the scoped search, so the collection scope is
// always the outermost AND and the by-id check reads the stored record.
const grantReadScope = Object.assign(
  async (agentId: string): Promise<RecordTypeReadScope> => ({
    condition: {
      operator: "or",
      conditions: [
        { attribute: "ownerId", comparator: "equals", value: agentId },
        { attribute: "granteeId", comparator: "equals", value: agentId },
      ],
    },
    isAllowed: (record: any) => !!record && (record.ownerId === agentId || record.granteeId === agentId),
  }),
  { mode: "owner-only" as const, ownerField: "ownerId" },
);
const grantByIdReadGate = makeByIdReadGate(grantReadScope);
const grantScopedSearch = makeScopedSearch(grantReadScope);

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
   * read-gate family fix — same pattern as Memory.ts/Soul.ts/
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
    return grantByIdReadGate.call(this, target, (t: any) => super.get(t));
  }

  async search(query?: any) {
    const auth = await this._auth();
    if (auth.kind === "anonymous") return UNAUTH();
    if (auth.kind === "internal" || (auth.kind === "agent" && auth.isAdmin)) {
      return super.search(query);
    }
    // owner OR grantee, as the outermost AND (makeScopedSearch).
    return grantScopedSearch(auth.agentId, query, (q: any) => super.search(q));
  }

  async post(content: any, context?: any) {
    const denied = await this._enforceOwnerWrite(content);
    if (denied) return denied;
    content.createdAt ||= new Date().toISOString();
    return super.post(content, context);
  }

  // PATCH routes past put(), so ownerId immutability is enforced on both verbs
  // via the one shared delegate. Only the owner may modify a grant, and not even
  // the owner may re-point ownerId at another principal (a grantee never could —
  // the middleware ownership guard refuses a non-owner mutation first).
  async patch(content: any, query?: any) {
    const denial = await guardOwnerFieldImmutable(this, () => super.get(), content, "ownerId");
    if (denial) return denial;
    return super.patch(content, query);
  }

  async put(content: any, context?: any) {
    const denial = await guardOwnerFieldImmutable(this, () => super.get(), content, "ownerId");
    if (denial) return denial;
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
    // flair#2355: a row that is no longer the caller's at the delete's re-read
    // or confirmation read is refused, not deleted
    // (resources/owner-delete-recheck.ts).
    const beforeDelete = txnPausePoint("grant-delete-pre");
    if (beforeDelete) await beforeDelete;
    const outcome = await deleteOwnedRow((this as any).getContext?.(), {
      table: (databases as any).flair.MemoryGrant,
      tableName: "MemoryGrant",
      id: typeof id === "string" ? id : record.id,
      ownerField: "ownerId",
      callerId: auth.agentId,
      point: "grant-delete",
    });
    if (outcome.kind === "refused") return outcome.response;
    if (outcome.kind === "absent") return super.delete(id, context);
    return outcome.result;
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
