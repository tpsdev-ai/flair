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
import { resolveAgentAuth } from "./agent-auth.js";
import { invalidEntitiesResponse } from "./entity-vocab.js";
import {
  makeAuthGate,
  makeReadScope,
  makeByIdReadGate,
  resolveAuthGate,
  stampAttribution,
  FORBIDDEN,
  UNAUTH,
} from "./record-type-kit.js";
import { RECORD_TYPES } from "./record-types.js";

// Parameterized from RECORD_TYPES.WorkspaceState (record-types slice 2,
// flair#520) rather than a hand-typed "owner-only" literal — the registry is
// now the single source of truth this class draws its read-scope mode from.
// Exported solely so test/unit/record-types-registry.test.ts's drift
// tripwire can introspect the composed resolver's tagged `.mode`/
// `.ownerField` against RECORD_TYPES.WorkspaceState — not for any other
// runtime consumer.
export const workspaceReadScope = makeReadScope(RECORD_TYPES.WorkspaceState.readScope, RECORD_TYPES.WorkspaceState.ownerField);
const workspaceByIdReadGate = makeByIdReadGate(workspaceReadScope);
// See makeAuthGate's doc (record-type-kit.ts): must be wired as a genuine
// prototype method below, never a class-field assignment — Harper's
// relationship-traversal RBAC path reads allowRead off the prototype.
const workspaceAuthGate = makeAuthGate();

export class WorkspaceState extends (databases as any).flair.WorkspaceState {
  /** Auth verdict from the request context. internal = trusted in-process call;
   *  agent = verified Ed25519; anonymous = HTTP with no valid agent → deny. */
  private _auth() {
    return resolveAgentAuth((this as any).getContext?.());
  }

  /**
   * Self-authorize now that the global gate is non-rejecting (memory-soul-
   * read-gate family fix — applying the Memory.ts/Soul.ts pattern
   * to WorkspaceState/Relationship/Integration/MemoryGrant). Closes the same
   * P0 leak: Harper routes `GET /WorkspaceState/<id>` to get() and the
   * collection describe (`GET /WorkspaceState`) to a path outside search(),
   * so neither was gated before this fix — an anonymous caller got a 200 with
   * full record content. Per-record ownership scoping happens in get() below;
   * the collection scope is still in search().
   */
  allowRead() { return workspaceAuthGate.call(this); }

  /**
   * Override get() to scope by-id reads the same way search() scopes
   * collection reads (memory-soul-read-gate family fix). Never distinguishes
   * "doesn't exist" from "exists but not yours" — both return 404, never
   * 403, so a denied caller can't use get() to enumerate other agents'
   * workspace-state ids. Wired through record-type-kit.ts's
   * makeByIdReadGate, scoped "owner-only" — same dispatch shape
   * Memory.ts/Relationship.ts's get() use.
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
    return workspaceByIdReadGate.call(this, target, (t: any) => super.get(t));
  }

  /**
   * Override search() to scope collection GETs to the authenticated agent's own
   * records. Internal calls + admin agents see all; anonymous is denied
   * (previously `!authAgent` was treated as unfiltered — the anonymous-read leak).
   */
  async search(query?: any) {
    // Dispatch shape shared via record-type-kit.ts's resolveAuthGate — same
    // three-way branch Memory.ts/Relationship.ts's search() use.
    const gate = await resolveAuthGate((this as any).getContext?.(), UNAUTH());
    if (gate.kind === "denied") return gate.response;
    if (gate.kind === "unfiltered") return super.search(query);

    const scope = await workspaceReadScope(gate.agentId);
    const agentIdCondition = scope.condition;

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

    // No-forge attribution — mode/field drawn from RECORD_TYPES.WorkspaceState
    // (record-types slice 2, flair#520) rather than hand-typed literals.
    // "stamp-default" (see record-type-kit.ts's stampAttribution doc): a
    // non-admin agent's workspace record is ALWAYS attributed to the
    // authenticated identity (from the Ed25519 signature), never the body.
    // We do NOT trust `content.agentId` — overwriting it (rather than
    // 403'ing a mismatch) mirrors Presence.post(): "agentId from signature,
    // NOT from body". An admin may write on behalf of another agent
    // (content.agentId honored if present, else defaults to the admin's own
    // id). Internal in-process callers keep whatever agentId they pass.
    // "stamp-default" never denies (no rejection branch for non-admin) —
    // the forbiddenMessage arg is dead for this mode, passed for signature
    // completeness only.
    stampAttribution(auth, content, RECORD_TYPES.WorkspaceState.ownerField, RECORD_TYPES.WorkspaceState.attribution.post, "forbidden: unreachable for stamp-default");

    content.createdAt = new Date().toISOString();
    content.timestamp ||= content.createdAt;

    // attention-plane vocabulary gate (flair#675): `entities`, if present,
    // must be well-formed vocabulary strings — see resources/entity-vocab.ts.
    // Field is additive/optional; absent entities is not an error.
    const entitiesError = invalidEntitiesResponse(content.entities);
    if (entitiesError) return entitiesError;

    return super.post(content);
  }

  async put(content: any) {
    const auth = await this._auth();
    if (auth.kind === "anonymous") return UNAUTH();
    // No-forge attribution — mode/field drawn from RECORD_TYPES.WorkspaceState.
    // "validate-strict" (see record-type-kit.ts's stampAttribution doc):
    // rejects a mismatch INCLUDING when agentId is absent (a bare `!==`
    // compare, no truthy guard).
    const attr = stampAttribution(auth, content, RECORD_TYPES.WorkspaceState.ownerField, RECORD_TYPES.WorkspaceState.attribution.put, "forbidden: cannot write workspace state for another agent");
    if (attr.denied) return attr.denied;

    // attention-plane vocabulary gate (flair#675) — same as post() above.
    const entitiesError = invalidEntitiesResponse(content.entities);
    if (entitiesError) return entitiesError;

    return super.put(content);
  }

  async delete(id: any) {
    // Dispatch shape shared via record-type-kit.ts's resolveAuthGate — same
    // three-way branch get()/search() above use.
    const gate = await resolveAuthGate((this as any).getContext?.(), UNAUTH());
    if (gate.kind === "denied") return gate.response;
    if (gate.kind === "unfiltered") return super.delete(id);

    // Use super.get(id), NOT this.get(id): the get() override above 404s
    // (a truthy Response) for a non-owner id, which would otherwise defeat
    // the `if (!record)` check below and mis-route a genuinely-missing
    // record into the FORBIDDEN branch instead of a clean super.delete(id)
    // no-op. Mirrors Memory.ts's delete() — same rationale, same fix.
    const record = await super.get(id);
    if (!record) return super.delete(id);
    if (record.agentId !== gate.agentId) {
      return FORBIDDEN("forbidden: cannot delete workspace state for another agent");
    }
    return super.delete(id);
  }
}
