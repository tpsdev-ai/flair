import { databases } from "harper";
import { resolveAgentAuth } from "./agent-auth.js";
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

// Parameterized from RECORD_TYPES.MemoryCandidate (record-types slice 2,
// flair#520) rather than a hand-typed "owner-only" literal — the registry is
// the single source of truth this class draws its read-scope mode from.
// Exported solely so test/unit/record-types-registry.test.ts's drift
// tripwire can introspect the composed resolver's tagged `.mode`/
// `.ownerField` against RECORD_TYPES.MemoryCandidate — not for any other
// runtime consumer.
export const memoryCandidateReadScope = makeReadScope(RECORD_TYPES.MemoryCandidate.readScope, RECORD_TYPES.MemoryCandidate.ownerField);
const memoryCandidateByIdReadGate = makeByIdReadGate(memoryCandidateReadScope);
// See makeAuthGate's doc (record-type-kit.ts): must be wired as a genuine
// prototype method below, never a class-field assignment.
const memoryCandidateAuthGate = makeAuthGate();

/**
 * MemoryCandidate resource — closes flair#849.
 *
 * The schema (schemas/memory.graphql) declared `@table` for this type with
 * no `@export` and no resource file at all, so it had NO REST surface —
 * `flair rem candidates`/`promote`/`reject` (src/cli.ts) all 404'd on every
 * call, a clean-room dogfood blocker. Adding bare `@export` would have
 * reopened the exact P0 leak the memory-soul-read-gate family fix closed for
 * every other agent-facing table: Harper's `Resource` default is
 * `allowRead/allowCreate/allowUpdate/allowDelete(user) { return
 * user?.role.permission.super_user }` (test/unit/resource-allow-decision.test.ts
 * enforces every exported resource makes an explicit allow-decision instead
 * of falling through to that default), so an unguarded `@export` is reachable
 * by `authorizeLocal`'s forged loopback super_user and, once the global gate
 * stops rejecting a genuinely anonymous remote caller, by that caller too.
 *
 * Read: identity-gated (allowRead — verified agents, admins, and trusted
 * internal calls pass; anonymous HTTP denied) AND per-agent scoped
 * ("owner-only" — see RECORD_TYPES.MemoryCandidate's doc comment for why: a
 * candidate is an unreviewed draft distillation, not yet promoted, and must
 * not be org-readable). Same "owner-only" composition Relationship.ts uses,
 * parameterized from the registry — this is NOT MemoryGrant.ts's bespoke
 * owner-OR-grantee model (MemoryCandidate has no second-party field).
 *
 * Write: post()/put()/delete() all self-enforce inline (no allowCreate/
 * allowUpdate/allowDelete wrapper — same deliberate omission Memory.ts's
 * allowRead() doc explains: adding an unverified allow* gate on top of
 * self-enforcing methods risks regressing owner writes). Non-admin agents
 * may create/modify only their OWN candidates (`agentId` no-forge
 * attribution, "validate-truthy" — present+mismatched agentId is rejected,
 * absent passes through, matching Memory.post()/put()'s exact idiom for the
 * same single-owner-field shape) and may delete only their own candidates
 * (mirrors MemoryGrant.ts's delete() ownership check). Internal calls (the
 * FLAIR-NIGHTLY-REM staging writer — resources/MemoryReflect.ts's
 * `databases.flair.MemoryCandidate.put(row)` — and resources/health.ts's
 * pending-count read) and admin agents pass every method unfiltered, exactly
 * like every other table this pattern covers.
 */
export class MemoryCandidate extends (databases as any).flair.MemoryCandidate {
  /**
   * Self-authorize now that the global gate is non-rejecting (memory-soul-
   * read-gate family fix — same pattern as Memory.ts/Relationship.ts/
   * WorkspaceState.ts/OrgEvent.ts/Soul.ts/MemoryGrant.ts). Harper routes
   * `GET /MemoryCandidate/<id>` to get() and the collection describe
   * (`GET /MemoryCandidate`) outside search(), so both must be gated here,
   * not just search(). Per-record owner scoping happens in get() below; the
   * collection scope is still in search().
   */
  allowRead() { return memoryCandidateAuthGate.call(this); }

  /**
   * Override get() to scope by-id reads the same way search() scopes
   * collection reads. Never distinguishes "doesn't exist" from "exists but
   * not yours" — both return 404, never 403, so a denied caller can't use
   * get() to enumerate other agents' candidate ids (same discipline
   * makeByIdReadGate documents, and MemoryGrant.ts's get() hand-rolls
   * identically). `flair rem promote`/`flair rem reject` (src/cli.ts) both
   * fetch a candidate by id before writing back — this is their read path.
   */
  async get(target?: any) {
    // Collection / query reads arrive as a RequestTarget with
    // `isCollection === true`, and are governed by search() (same owner
    // scoping). Only a genuine by-id get is ownership-checked below.
    if (!target || (typeof target === "object" && target.isCollection)) {
      return this.search(target);
    }
    return memoryCandidateByIdReadGate.call(this, target, (t: any) => super.get(t));
  }

  /**
   * Scope collection reads to the caller's own candidates. This is the
   * handler `flair rem candidates` reaches via `POST
   * /MemoryCandidate/search_by_conditions` (src/cli.ts) — the agentId
   * condition is wrapped as the OUTERMOST `and` block (Relationship.ts's
   * same "Security Critical" discipline) so a caller-supplied `operator:
   * "or"` in the request body cannot boolean-inject past the owner scope.
   */
  async search(query?: any) {
    const ctx = (this as any).getContext?.();

    const gate = await resolveAuthGate(ctx, UNAUTH());
    if (gate.kind === "denied") return gate.response;
    if (gate.kind === "unfiltered") return super.search(query);

    // Non-admin agent: scope to own candidates only.
    const scope = await memoryCandidateReadScope(gate.agentId);
    const agentCondition = scope.condition;
    if (!query?.conditions) {
      return super.search({ conditions: [agentCondition], ...(query || {}) });
    }
    return super.search({
      ...query,
      conditions: [agentCondition, { conditions: query.conditions, operator: query.operator || "and" }],
      operator: "and",
    });
  }

  /**
   * No shipped CLI path calls POST today (the FLAIR-NIGHTLY-REM staging
   * writer uses an internal `.put()`, not `.post()` — see MemoryReflect.ts).
   * Guarded anyway, on the same "don't leave any exported verb unguarded"
   * discipline the rest of this file follows: anonymous denied; a non-admin
   * agent may only stage a candidate attributed to itself.
   */
  async post(content: any) {
    const ctx = (this as any).getContext?.();
    const auth = await resolveAgentAuth(ctx);
    if (auth.kind === "anonymous") return UNAUTH();

    const attr = stampAttribution(auth, content, RECORD_TYPES.MemoryCandidate.ownerField, RECORD_TYPES.MemoryCandidate.attribution.post, "forbidden: cannot stage a memory candidate for another agent");
    if (attr.denied) return attr.denied;

    return super.post(content);
  }

  /**
   * `flair rem promote`/`flair rem reject` (src/cli.ts) both PUT the
   * candidate row back with an updated status/reviewerId/reviewRationale/
   * decidedAt, spreading the existing record (agentId included, unchanged).
   * Non-admin: the no-forge attribution check rejects a PRESENT, mismatched
   * agentId (an agent can't repurpose this endpoint to rewrite another
   * agent's candidate) but never stamps one in — the promote/reject flow
   * always carries the original agentId forward untouched.
   */
  async put(content: any) {
    const ctx = (this as any).getContext?.();
    const auth = await resolveAgentAuth(ctx);
    if (auth.kind === "anonymous") return UNAUTH();

    const attr = stampAttribution(auth, content, RECORD_TYPES.MemoryCandidate.ownerField, RECORD_TYPES.MemoryCandidate.attribution.put, "forbidden: cannot modify a memory candidate owned by another agent");
    if (attr.denied) return attr.denied;

    return super.put(content);
  }

  /**
   * No shipped CLI path calls DELETE today. Guarded on the same discipline
   * as post() above — mirrors MemoryGrant.ts's delete(): owner-only,
   * admin/internal unfiltered, a genuinely-missing id is a clean no-op
   * super.delete() rather than a FORBIDDEN (no existence oracle).
   */
  async delete(id: any, context?: any) {
    const ctx = (this as any).getContext?.();
    const gate = await resolveAuthGate(ctx, UNAUTH());
    if (gate.kind === "denied") return gate.response;
    if (gate.kind === "unfiltered") return super.delete(id, context);

    const record = await super.get(id);
    if (!record) return super.delete(id, context);
    if (record[RECORD_TYPES.MemoryCandidate.ownerField] !== gate.agentId) {
      return FORBIDDEN("forbidden: cannot delete a memory candidate owned by another agent");
    }
    return super.delete(id, context);
  }
}
