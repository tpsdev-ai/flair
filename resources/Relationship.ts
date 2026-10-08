import { databases } from "harper";
import { resolveAgentAuth } from "./agent-auth.js";
import { guardOwnerFieldImmutable } from "./owner-field-guard.js";
import { deleteOwnedRow } from "./owner-delete-recheck.js";
import { txnPausePoint } from "./txn-pause-point.js";
import { checkRateLimit, rateLimitResponse } from "./rate-limiter.js";
import { applyOriginatorInstanceId, resolveStoredRow } from "./originator-instance.js";
import {
  buildProvenance,
  makeAuthGate,
  makeReadScope,
  makeScopedSearch,
  makeByIdReadGate,
  resolveAuthGate,
  stampAttribution,
  FORBIDDEN,
  UNAUTH,
} from "./record-type-kit.js";
import { stripServerStampedFields } from "./memory-declared-attributes.js";
import { isSemanticPatch, RELATIONSHIP_SEMANTIC_FIELDS } from "./provenance.js";
import { RECORD_TYPES } from "./record-types.js";

// Parameterized from RECORD_TYPES.Relationship (record-types slice 2,
// flair#520) rather than a hand-typed "owner-only" literal — the registry is
// now the single source of truth this class draws its read-scope mode from.
// Exported solely so test/unit/record-types-registry.test.ts's drift
// tripwire can introspect the composed resolver's tagged `.mode`/
// `.ownerField` against RECORD_TYPES.Relationship — not for any other
// runtime consumer.
export const relationshipReadScope = makeReadScope(RECORD_TYPES.Relationship.readScope, RECORD_TYPES.Relationship.ownerField);
const relationshipScopedSearch = makeScopedSearch(relationshipReadScope);
const relationshipByIdReadGate = makeByIdReadGate(relationshipReadScope);
// See makeAuthGate's doc (record-type-kit.ts): must be wired as a genuine
// prototype method below, never a class-field assignment — Harper's
// relationship-traversal RBAC path reads allowRead off the prototype.
const relationshipAuthGate = makeAuthGate();

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
   * read-gate family fix — same pattern as Memory.ts/Soul.ts/
   * WorkspaceState.ts). Closes the same P0 leak: Harper routes
   * `GET /Relationship/<id>` to get() and the collection describe
   * (`GET /Relationship`) outside search(), so neither was gated before this
   * fix — an anonymous caller got a 200 with full record content. Per-record
   * ownership scoping happens in get() below; the collection scope is still
   * in search().
   */
  allowRead() { return relationshipAuthGate.call(this); }

  /**
   * Override get() to scope by-id reads the same way search() scopes
   * collection reads (memory-soul-read-gate family fix). Never distinguishes
   * "doesn't exist" from "exists but not yours" — both return 404, never
   * 403, so a denied caller can't use get() to enumerate other agents'
   * relationship ids. Wired through record-type-kit.ts's makeByIdReadGate,
   * scoped "owner-only" — same dispatch shape Memory.ts's get() uses.
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
    return relationshipByIdReadGate.call(this, target, (t: any) => super.get(t));
  }

  async search(query?: any) {
    const ctx = (this as any).getContext?.();

    // Anonymous HTTP must NOT read relationships (previously `!authAgent` was
    // treated as unfiltered — the anonymous-read leak). Trusted internal call
    // or admin agent → unfiltered. Dispatch shape shared via
    // record-type-kit.ts's resolveAuthGate — same three-way branch Memory.ts/
    // WorkspaceState.ts's search() use.
    const gate = await resolveAuthGate(ctx, UNAUTH());
    if (gate.kind === "denied") return gate.response;
    if (gate.kind === "unfiltered") return super.search(query);

    // Non-admin agent: scope to own relationships.
    return relationshipScopedSearch(gate.agentId, query, (q: any) => super.search(q));
  }

  /**
   * ─── Auth reconcile (relationship-write-path, folded K&S refinement) ──────
   *
   * Upgraded from the older `request.tpsAgent`-direct pattern to
   * `resolveAgentAuth` — matching Memory.post()/put() — so this write path
   * gets the SAME three-way verdict handling (anonymous denied, verified
   * agent stamped from the SIGNATURE never the body, internal/admin
   * unfiltered) instead of a parallel, easy-to-drift auth mechanism. K&S both
   * flagged this as a real divergence (the previous code had no
   * internal/admin verdict paths at all — see the doc below for why that
   * never actually bit anyone in practice, but was still the wrong shape to
   * build the new ergonomic write surfaces on top of).
   *
   * - `anonymous` → 401, same as before.
   * - `agent` + non-admin: a body-supplied `agentId` that MISMATCHES the
   *   verified identity is rejected outright (403) rather than silently
   *   overwritten — a clearer signal than Memory.post()'s "validate, don't
   *   stamp" idiom. `content.agentId` is then ALWAYS set from `auth.agentId`
   *   (never left as whatever the body claimed, even when it already
   *   matched) — the non-negotiable "agentId comes from the verdict, never
   *   the body" rule, applied unconditionally rather than only on mismatch.
   * - `agent` + admin: `content.agentId` passes through UNFILTERED, matching
   *   the existing admin-bypass idiom already used by get()/search()/
   *   delete() below (an admin/migration tool may legitimately write on
   *   another agent's behalf).
   * - `internal` (no HTTP request at all — a trusted in-process call):
   *   `content.agentId` also passes through unchanged. No in-process
   *   Relationship writer exists today (openclaw's integration writes via a
   *   real signed HTTP PUT, landing on the `agent` branch above), so this is
   *   forward-looking parity with Memory.post()/put() rather than a path
   *   this PR's callers actually exercise — but it closes the SAME latent gap
   *   the old code had: `request?.tpsAgent` was falsy for BOTH an anonymous
   *   HTTP caller and a true internal call, so an internal caller would have
   *   been wrongly 401'd too. resolveAgentAuth distinguishes the two.
   */
  // PATCH routes past put(), so agentId immutability is enforced on both verbs
  // via the one shared delegate.
  async patch(content: any, query?: any) {
    const denial = await guardOwnerFieldImmutable(this, () => super.get(), content, "agentId");
    if (denial) return denial;
    // flair#1960 r2: PATCH was the one Relationship writer that never touched
    // `provenance`. The schema declares the field writable, so a caller could
    // PATCH a forged `verified.agentId`/`verified.timestamp` straight onto the
    // row, and stripping alone would let a stored value ride through. Mirror the
    // Memory/put() contract: strip any body-supplied server-stamped field (so a
    // body can never SET a `verified.*` field) and, when the patch changes the
    // relationship's semantic identity (subject/predicate/object), re-stamp
    // provenance from the resolved auth and ONE server clock read. A
    // metadata-only patch (confidence/source/validTo) keeps the stored,
    // previously-stamped blob. Claim inputs are captured before the guard so a
    // `claimed.model`/`claimed.client` on the body is folded in like put().
    const claimInputs = { model: (content as any)?.model, claimedClient: (content as any)?.claimedClient };
    // flair#718 authorship-provenance — `claimedClient` is a WRITE-BODY-ONLY
    // passthrough, already folded into `provenance.claimed.client` by
    // buildProvenance (below, on a semantic PATCH). Delete it before delegating
    // so it is NEVER persisted as a top-level row field — the SAME contract as
    // put(), which deletes it before the table write. Without this the PATCH
    // body's `claimedClient` rode through `super.patch()` onto the row.
    delete content.claimedClient;
    stripServerStampedFields(content);
    // flair#1960 r3 + flair#1965 r2/r3: resolve the stored row ONCE (the shared
    // resolveStoredRow), by the URL-BOUND target id — refusing a body `id` that
    // disagrees with the address and refusing a lookup that FAILS (never read as
    // "no stored row"). This ONE resolved row drives BOTH rule sets: the
    // semantic-PATCH provenance decision below AND the originatorInstanceId
    // create/update rule. The previous `.catch(() => null)` turned a read ERROR
    // into "no stored row"; isSemanticPatch returns false for `null`, so the
    // patch fell through to `super.patch()` as a METADATA-ONLY write and kept a
    // legacy stored blob — including a caller-chosen `verified.timestamp` — in
    // place. A read error is not a missing row: without the stored record we
    // cannot tell a semantic PATCH from a metadata-only one, so fail closed and
    // refuse rather than degrade to a blob-preserving decision.
    const resolvedStored = await resolveStoredRow(this, "Relationship", content, () => super.get());
    if (resolvedStored.denial) return resolvedStored.denial;
    const existing = resolvedStored.row;
    if (isSemanticPatch(content, existing, RELATIONSHIP_SEMANTIC_FIELDS)) {
      const auth = await resolveAgentAuth((this as any).getContext?.());
      content.provenance = buildProvenance(auth, content.createdAt ?? existing?.createdAt, claimInputs);
    }
    // flair#1965 r2: an EXISTING row keeps its stored originatorInstanceId (a
    // body value is dropped); a PATCH whose URL target has no stored row is a
    // CREATE when it reaches the table and must stamp the local id (Harper's
    // patch path does not require an existing row; only an administrator's or
    // a trusted internal PATCH gets that far — resources/table-patch-policy.ts
    // refuses the rest). The row is resolved by the URL-BOUND target id, never a
    // body `id`. See resources/originator-instance.ts.
    await applyOriginatorInstanceId(content, existing);
    return super.patch(content, query);
  }

  /**
   * POST (a collection create). Prepares the body with the same rules as put()
   * before the row is created. For a verified non-admin agent, the owner is that
   * agent (a body that names another agent is refused); an administrator or a
   * trusted internal caller keeps the owner it supplies, and must supply one, as
   * in put(). The preparation can refuse the write (401, 403, 429 or 400); a
   * body that passes it is normalized, gets provenance built server-side, and
   * has `originatorInstanceId` stamped as a create. A create that is otherwise
   * admitted, valid and within the rate limit is refused with 409 when its id
   * already exists, so a POST never updates a row.
   */
  async post(content: any, query?: any) {
    const denial = await prepareRelationshipWrite(this, content, RECORD_TYPES.Relationship.attribution.post);
    if (denial) return denial;
    await applyOriginatorInstanceId(content, null);
    return super.post(content, query);
  }

  async put(content: any) {
    const __ownerDenial = await guardOwnerFieldImmutable(this, () => super.get(), content, "agentId");
    if (__ownerDenial) return __ownerDenial;
    const denial = await prepareRelationshipWrite(this, content, RECORD_TYPES.Relationship.attribution.put);
    if (denial) return denial;

    // Write-time originatorInstanceId (federation-edge-hardening slice 1): a
    // CREATE (no stored row) stamps this instance's own id, ignoring any body
    // value; an UPDATE keeps the STORED value — a body value neither replaces
    // nor clears it. post() stamps its create itself; put() carries both. See
    // resources/originator-instance.ts for the full contract (the federation
    // merge is the raw table writer and never takes a request-body field).
    // The row is resolved by the URL-BOUND target id, never a body `id` (Harper
    // writes to the URL target); a mismatch or a failed read refuses the write.
    const resolvedOriginRow = await resolveStoredRow(this, "Relationship", content, () => super.get());
    if (resolvedOriginRow.denial) return resolvedOriginRow.denial;
    await applyOriginatorInstanceId(content, resolvedOriginRow.row);

    return super.put(content);
  }

  /**
   * Same auth reconcile as put() above — resolveAgentAuth replaces the
   * `request.tpsAgent`-direct pattern. K&S both independently caught that
   * delete() had the identical divergence the spec text only named on
   * put(): anonymous and true-internal calls were indistinguishable (both
   * read as a falsy `authAgent`), and there was no admin/internal verdict
   * handling. Ownership-check logic (own-agent-or-admin) is otherwise
   * unchanged — see test/integration/relationship-delete-authz.test.ts's doc
   * comment for why calling `super.get()` with no target argument still
   * resolves the URL-bound target record (a Harper Table-resource
   * invariant), not an empty/collection result.
   */
  async delete(_: any) {
    const ctx = (this as any).getContext?.();

    // Dispatch shape shared via record-type-kit.ts's resolveAuthGate — same
    // three-way branch put()/get()/search() above use.
    const gate = await resolveAuthGate(ctx, UNAUTH());
    if (gate.kind === "denied") return gate.response;
    if (gate.kind === "unfiltered") return super.delete(_);

    // Non-admin agent: verify ownership before delete.
    const existing = await super.get();
    if (existing?.agentId && existing.agentId !== gate.agentId) {
      return FORBIDDEN("cannot delete another agent's relationship");
    }

    // flair#2355: a row that is no longer the caller's at the delete's re-read
    // or confirmation read is refused, not deleted
    // (resources/owner-delete-recheck.ts).
    if (existing) {
      const beforeDelete = txnPausePoint("relationship-delete-pre");
      if (beforeDelete) await beforeDelete;
      const outcome = await deleteOwnedRow(ctx, {
        table: (databases as any).flair.Relationship,
        tableName: "Relationship",
        id: typeof _ === "string" ? _ : existing.id,
        ownerField: "agentId",
        callerId: gate.agentId,
        point: "relationship-delete",
      });
      if (outcome.kind === "refused") return outcome.response;
      if (outcome.kind === "absent") return super.delete(_);
      return outcome.result;
    }

    return super.delete(_);
  }
}

/**
 * The write preparation Relationship's post() and put() share, in order:
 * resolve the caller (an anonymous verdict is refused with 401); apply the
 * owner attribution for `mode` (a verified non-admin agent's own id is stamped;
 * a body naming another agent is refused with 403); require an owner (400);
 * rate-limit an agent caller (429); validate the triple (400); then normalize
 * it and build provenance server-side. Returns the first refusal, or null when
 * the body is ready to write.
 * `originatorInstanceId` is the caller's to apply: a create stamp for post(),
 * the stored-row rule for put().
 */
async function prepareRelationshipWrite(
  resource: any,
  content: any,
  mode: Parameters<typeof stampAttribution>[3],
): Promise<Response | null> {
  const ctx = resource.getContext?.();
  const auth = await resolveAgentAuth(ctx);

  if (auth.kind === "anonymous") {
    return UNAUTH();
  }

  // No-forge attribution — mode/field drawn from RECORD_TYPES.Relationship
  // (record-types slice 2, flair#520) rather than a hand-typed literal.
  // "stamp-strict" (see record-type-kit.ts's stampAttribution doc): reject
  // a PRESENT, mismatched agentId, else unconditionally stamp with the
  // verified identity. Admin/internal: content.agentId left as provided
  // (unfiltered) — see the auth-reconcile doc on the Relationship class.
  const attr = stampAttribution(auth, content, RECORD_TYPES.Relationship.ownerField, mode, "cannot write a relationship owned by another agent");
  if (attr.denied) return attr.denied;

  if (!content.agentId || typeof content.agentId !== "string") {
    return new Response(JSON.stringify({ error: "agentId is required" }), {
      status: 400, headers: { "content-type": "application/json" },
    });
  }

  // Rate limit keyed on the RESOLVED agentId (never a client-supplied one)
  // — matches Memory.post()'s intent, extended to cover every
  // resolveAgentAuth path (credentialed super_user, verifyAgentRequest
  // fallback), not just the gate's own `tpsAgent` annotation. Internal
  // calls have no per-agent identity to key on and are trusted, so they're
  // exempt — same as Memory.post()'s `if (authenticatedAgent)` guard.
  if (auth.kind === "agent") {
    const rl = checkRateLimit(auth.agentId);
    if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs!, "relationship");
  }

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

  // Normalize — lowercasing is load-bearing: MemoryBootstrap.ts's attention
  // read matches lowercased predicted subjects against subject/object.
  const now = new Date().toISOString();
  content.subject = content.subject.toLowerCase();
  content.predicate = content.predicate.toLowerCase();
  content.object = content.object.toLowerCase();
  content.createdAt = content.createdAt || now;
  content.updatedAt = now;
  content.validFrom = content.validFrom || now;
  // validTo left as null/undefined for active relationships
  content.confidence = content.confidence ?? 1.0;

  // Write-time provenance stamp (relationship-write-path, folded K&S
  // refinement) — reuses Memory's buildProvenance EXACTLY (./provenance.ts),
  // same `{v, verified, claimed?}` shape, no Relationship-specific format.
  // Additive/nullable on the schema side (schemas/memory.graphql) — a
  // pre-existing row with no provenance field reads back `undefined`,
  // unchanged behavior (migration-equivalence gate).
  content.provenance = buildProvenance(auth, content.createdAt, content);
  // flair#718 authorship-provenance — same contract as resources/Memory.ts's
  // post()/put(): `claimedClient` is a write-body-only passthrough, already
  // folded into `provenance.claimed.client` above. Strip it so it is NEVER
  // persisted as a row field.
  delete content.claimedClient;
  return null;
}
