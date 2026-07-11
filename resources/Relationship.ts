import { databases } from "@harperfast/harper";
import { resolveAgentAuth, allowVerified } from "./agent-auth.js";
import { checkRateLimit, rateLimitResponse } from "./rate-limiter.js";
import { localInstanceId } from "./instance-identity.js";
import { buildProvenance } from "./provenance.js";

const NOT_FOUND = () =>
  new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
const UNAUTH = () =>
  new Response(JSON.stringify({ error: "authentication required" }), { status: 401, headers: { "Content-Type": "application/json" } });
const FORBIDDEN = (msg: string) =>
  new Response(JSON.stringify({ error: msg }), { status: 403, headers: { "Content-Type": "application/json" } });

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
  async put(content: any) {
    const ctx = (this as any).getContext?.();
    const auth = await resolveAgentAuth(ctx);

    if (auth.kind === "anonymous") {
      return UNAUTH();
    }

    if (auth.kind === "agent") {
      if (!auth.isAdmin) {
        if (content?.agentId && content.agentId !== auth.agentId) {
          return FORBIDDEN("cannot write a relationship owned by another agent");
        }
        content.agentId = auth.agentId;
      }
      // admin: content.agentId left as provided (unfiltered) — see doc above.
    }
    // internal: content.agentId left as provided (unfiltered) — see doc above.

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

    // Write-time originatorInstanceId stamp (federation-edge-hardening slice
    // 1) — see resources/Memory.ts's stampOriginatorInstanceId doc for the
    // full contract. No-op if already set (never fires for a genuine local
    // write; a federation-synced record never reaches this method — the
    // merge path writes via the raw table object, bypassing this class).
    if (content.originatorInstanceId == null) {
      content.originatorInstanceId = await localInstanceId();
    }

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
    const auth = await resolveAgentAuth(ctx);

    if (auth.kind === "anonymous") {
      return UNAUTH();
    }

    // Trusted internal call or admin agent — unfiltered, unchanged behavior.
    if (auth.kind === "internal" || (auth.kind === "agent" && auth.isAdmin)) {
      return super.delete(_);
    }

    // Non-admin agent: verify ownership before delete.
    const existing = await super.get();
    if (existing?.agentId && existing.agentId !== auth.agentId) {
      return FORBIDDEN("cannot delete another agent's relationship");
    }

    return super.delete(_);
  }
}
