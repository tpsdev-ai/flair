/**
 * record-type-kit.ts — shared, parameterized building blocks for a flair
 * table's agent-identity / read-scope / no-forge-attribution machinery
 * (record-types slice 1: kit extraction, flair#520).
 *
 * ─── What this is ────────────────────────────────────────────────────────
 * Five flair-owned tables — Memory, Relationship, WorkspaceState, OrgEvent,
 * Soul — each independently hand-copied ~150-250 lines of near-identical
 * auth/scoping code: call resolveAgentAuth(getContext()), branch on the
 * three-way verdict (internal / agent / anonymous), 404 a non-owner by-id
 * read (never 403, so ids can't be enumerated), stamp agentId/authorId from
 * the verified identity rather than the request body ("no-forge
 * attribution"). Every allowRead() docstring in those five files literally
 * says "same pattern as X.ts" — this module makes that pattern real code
 * instead of a comment convention that can drift.
 *
 * ─── What this is NOT (scope discipline for slice 1) ─────────────────────
 * This is a PURE REFACTOR extracting what is IDENTICAL across the five
 * existing tables today. It is deliberately conservative, not the full
 * `applyRecordTypeKit(policy)` composition sketched in the record-types
 * design doc's §5 (that shape is for slice 2/3's registry, generating a
 * COMPLETE {allowRead, get, search, post, put, delete} bundle for a
 * brand-new consumer type with no bespoke logic). The five EXISTING tables
 * genuinely diverge in real, load-bearing ways that must be preserved
 * byte-for-byte, not papered over by a one-size bundle:
 *   - search()'s query-merge shape differs per table (Memory detaches the
 *     transaction and falls through differently on a bare query object than
 *     WorkspaceState's in-place mutation than Relationship's nested-wrap);
 *   - the no-forge attribution idiom differs not just per table but per
 *     METHOD within a table (WorkspaceState.post() unconditionally stamps
 *     with no mismatch check at all, while WorkspaceState.put() rejects a
 *     mismatch and never stamps — see stampAttribution's mode doc below);
 *   - delete() diverges the most: Memory.delete() doesn't even use
 *     resolveAgentAuth (raw tpsAgent + isAdmin(), gated on the `permanent`
 *     durability flag, no ownership check at all for non-permanent rows);
 *     Soul has no delete() override; the other three each fetch the
 *     pre-existing record with a different super.get() call signature.
 *   - OrgEvent and Soul have NO get()/search() overrides at all (org events
 *     and souls are readable by any verified agent, unscoped by owner) —
 *     this module does not force them into a scope they never had.
 * Each of those divergences stays inline in its resource file as visible,
 * type-specific business logic. What THIS module extracts is only the
 * genuinely-identical primitives underneath: the auth-gate three-way
 * dispatch, the two read-scope condition/predicate shapes, the no-forge
 * attribution idioms (named and parameterized, not merged into one), and
 * the canonical error-response builders.  `buildProvenance` itself
 * (./provenance.ts) is already table-agnostic and is reused as-is — this
 * module does not wrap it, it re-exports it for a single import surface.
 *
 * Design lineage: flair#520 design draft (issue comment, 2026-07-13),
 * Kern's DESIGN REVIEW ("the makeAuthGate/makeReadScope/buildProvenance
 * as-is extraction is the right factoring... each class keeps its
 * type-specific business logic visibly, loses only the copied
 * boilerplate"). `stampEmbedding` (the design's 4th cut-line) is OUT of
 * scope here — no table this module composes writes an embedding today
 * (only Memory does, and Memory's embedding logic is dedup-gate-entangled,
 * not part of the five-table auth/scope/provenance duplication this slice
 * targets); it belongs to the registry/new-capability slice.
 */
import { resolveAgentAuth, allowVerified, type AgentAuthVerdict } from "./agent-auth.js";
import { resolveReadScope } from "./memory-read-scope.js";
import { buildProvenance } from "./provenance.js";

export { buildProvenance };

// ─── Canonical error responses ─────────────────────────────────────────────
// Byte-for-byte the same bodies every one of the five files hand-rolled
// (Memory/Relationship/WorkspaceState/OrgEvent each defined their own
// FORBIDDEN/UNAUTH/NOT_FOUND consts identically; Soul only needed
// FORBIDDEN/UNAUTH). Header-key casing is normalized here to "Content-Type"
// — HTTP header names are case-insensitive (and Harper/undici's Headers
// object normalizes on read), so this is not an observable behavior change
// from the two files (Memory.ts, Relationship.ts) whose inline copies used
// a lowercase "content-type" key.
export const FORBIDDEN = (msg: string): Response =>
  new Response(JSON.stringify({ error: msg }), { status: 403, headers: { "Content-Type": "application/json" } });
export const UNAUTH = (): Response =>
  new Response(JSON.stringify({ error: "authentication required" }), { status: 401, headers: { "Content-Type": "application/json" } });
export const NOT_FOUND = (): Response =>
  new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: { "Content-Type": "application/json" } });

// ─── (a) Identity gating — makeAuthGate ────────────────────────────────────

/**
 * Produces the `allowRead()` override every one of the five tables hand-
 * wrote identically:
 *   `allowRead() { return allowVerified((this as any).getContext?.()); }`
 * Self-authorizes now that the global gate is non-rejecting (the
 * memory-soul-read-gate family fix): Harper routes `GET /<Table>/<id>` to
 * get() and the collection describe (`GET /<Table>`) to a path outside
 * search(), so neither was gated before that fix landed — closes the same
 * P0 leak (an anonymous caller getting a 200 with full record content) for
 * every table that composes this. Per-record/collection scoping is still
 * each table's own get()/search() responsibility below this gate.
 *
 * `allowVerified()` itself (permit verified agents, admins/super_user, and
 * trusted internal calls; deny anonymous HTTP) already lives in
 * ./agent-auth.ts and is reused unmodified — this factory exists only to
 * remove the identical one-line method body duplicated five times, not to
 * change what it does.
 *
 * MUST be composed as a genuine prototype method, never a class-field
 * assignment (`allowRead = makeAuthGate();`). Harper's Table.js has a code
 * path (`relatedTable.prototype.allowRead.call(null, user, property,
 * context)`, used when a query's `select` traverses a GraphQL relationship
 * into one of these tables under Harper's native attribute-level RBAC) that
 * reads `allowRead` off the CLASS PROTOTYPE directly, not off a resource
 * instance. A class field is an own-instance property — invisible to that
 * lookup — so a class-field assignment would silently fall back to Harper's
 * default RBAC-based `allowRead` for that one relationship-traversal path
 * while every direct/primary call (`this.allowRead(...)`, always
 * instance-invoked) kept working, making the gap easy to miss. Every
 * caller of this factory MUST wire it as `allowRead() { return
 * gate.call(this); }` (see Memory.ts/Relationship.ts/WorkspaceState.ts/
 * OrgEvent.ts/Soul.ts for the exact pattern), not `allowRead =
 * makeAuthGate();`.
 */
export function makeAuthGate(): (this: any) => Promise<boolean> {
  return function allowRead(this: any): Promise<boolean> {
    return allowVerified(this.getContext?.());
  };
}

/**
 * The three-way auth dispatch every one of get()/search()/delete() in
 * Memory.ts, Relationship.ts, WorkspaceState.ts, and OrgEvent.ts hand-wrote
 * identically (Memory.delete() is the one deliberate exception — see this
 * module's file header):
 *   - anonymous          → denied, caller-supplied response (401 for
 *                           search/delete, 404 for a by-id get — never the
 *                           same body twice, so the denial reason can't be
 *                           inferred from a shared shape).
 *   - internal or admin  → unfiltered, caller runs `super.X()` unchanged.
 *   - non-admin agent    → scoped; caller gets the resolved agentId back to
 *                           build its own (per-table) condition/ownership
 *                           check.
 * Deliberately returns a discriminated result rather than calling
 * `super.X()` itself: `super` is only valid syntax inside a class method
 * body (its [[HomeObject]] binding is fixed at class-parse time), so this
 * factored-out function cannot invoke the caller's `super` on its behalf —
 * the caller passes its own `() => super.X()` closure back in.
 */
export type AuthGateOutcome =
  | { kind: "denied"; response: Response }
  | { kind: "unfiltered" }
  | { kind: "scoped"; agentId: string };

export async function resolveAuthGate(ctx: any, denyResponse: Response): Promise<AuthGateOutcome> {
  const auth = await resolveAgentAuth(ctx);
  if (auth.kind === "anonymous") return { kind: "denied", response: denyResponse };
  if (auth.kind === "internal" || (auth.kind === "agent" && auth.isAdmin)) return { kind: "unfiltered" };
  return { kind: "scoped", agentId: auth.agentId };
}

// ─── (b) Read-scope — makeReadScope ────────────────────────────────────────

/** A record shape narrow enough for the in-process isAllowed re-check. */
export interface ScopableRecord {
  agentId?: string | null;
  visibility?: string | null;
}

export interface RecordTypeReadScope {
  /** Harper condition object encoding the full read-scope. Always meant to
   *  be the OUTERMOST element a caller ANDs with the rest of its query
   *  (injection-safe — matches the discipline every existing caller of
   *  resolveReadScope()/the hand-rolled agentId condition already applies). */
  condition: any;
  /** In-process re-check of the identical rule (defense-in-depth / for
   *  paths that already have the record in hand, e.g. get()'s by-id check). */
  isAllowed: (record: ScopableRecord | null | undefined) => boolean;
}

export type ReadScopeMode = "owner-only" | "open-within-org";

/** owner-only: `agentId === authAgentId`, full stop — the model
 *  Relationship.ts and WorkspaceState.ts hand-rolled identically for their
 *  get()/search() overrides (`{attribute: ownerField, comparator: "equals",
 *  value: authAgentId}` / `record[ownerField] !== authAgentId`). No
 *  visibility field, no org-open exception — a real, legitimate read-scope
 *  shape in its own right (per Kern/Sherlock's review), not a lesser
 *  version of Memory's model. */
function ownerOnlyReadScope(ownerField: string): (authAgentId: string) => Promise<RecordTypeReadScope> {
  return async (authAgentId: string): Promise<RecordTypeReadScope> => ({
    condition: { attribute: ownerField, comparator: "equals", value: authAgentId },
    isAllowed: (record) => !!record && (record as any)[ownerField] === authAgentId,
  });
}

/**
 * Resolve the read-scope resolver for a table, by mode:
 *   - "owner-only": own records only, scoped on `ownerField` (defaults to
 *     "agentId" — every current owner-only caller uses that field; the
 *     parameter exists so a future owner-only type using a different field,
 *     the way OrgEvent's WRITE path uses "authorId", isn't hardcoded out).
 *   - "open-within-org": delegates to the EXACT existing
 *     resolveReadScope()/PRIVATE_VISIBILITY semantics in
 *     ./memory-read-scope.ts — Memory's own module, untouched, not
 *     reimplemented here. `ownerField` is ignored for this mode:
 *     resolveReadScope() is hardcoded to "agentId" (the only table that
 *     uses this mode today), matching the task's instruction to delegate to
 *     that module "as the exact existing" implementation rather than
 *     generalizing it in this slice.
 */
export function makeReadScope(
  mode: ReadScopeMode,
  ownerField: string = "agentId",
): (authAgentId: string) => Promise<RecordTypeReadScope> {
  return mode === "open-within-org" ? resolveReadScope : ownerOnlyReadScope(ownerField);
}

/**
 * By-id read-gate factory for get() overrides that scope a single-record
 * read the same way search() scopes a collection read (Memory.ts,
 * Relationship.ts, WorkspaceState.ts — NOT OrgEvent/Soul, which have no
 * get() override at all and are intentionally left alone, see file header).
 * Never distinguishes "doesn't exist" from "exists but not yours" — both
 * return 404, never 403, so a denied caller can't use get() to enumerate
 * other agents' record ids.
 *
 * `superGet` is a caller-supplied closure so the class's own `super.get()`
 * (which cannot be referenced from outside the class body) stays exactly
 * where it was.
 */
export function makeByIdReadGate(
  readScope: (authAgentId: string) => Promise<RecordTypeReadScope>,
): (this: any, target: any, superGet: (t: any) => Promise<any>) => Promise<any> {
  return async function byIdReadGate(this: any, target: any, superGet: (t: any) => Promise<any>): Promise<any> {
    // Collection / query reads arrive as a RequestTarget with
    // `isCollection === true`, and are governed by search() (same owner
    // scoping). Only a genuine by-id get is ownership-checked below.
    if (!target || (typeof target === "object" && target.isCollection)) {
      return this.search(target);
    }

    const ctx = this.getContext?.();
    const auth = await resolveAgentAuth(ctx);

    // Anonymous by-id read is already blocked at the allowRead() gate (403);
    // this is defense-in-depth if get() is ever reached directly.
    if (auth.kind === "anonymous") return NOT_FOUND();

    // Trusted internal call or admin agent — unfiltered, unchanged behavior.
    if (auth.kind === "internal" || (auth.kind === "agent" && auth.isAdmin)) {
      return superGet(target);
    }

    // Non-admin agent: scoped per the table's own read-scope model.
    const record = await superGet(target);
    if (!record) return NOT_FOUND();

    const scope = await readScope(auth.agentId);
    if (!scope.isAllowed(record)) return NOT_FOUND();

    return record;
  };
}

// ─── (c) No-forge attribution — stampAttribution ───────────────────────────

/**
 * Four idioms observed verbatim across the five tables' write paths (post()/
 * put()), named rather than merged into one because they are genuinely
 * different security postures, not accidental drift:
 *
 *  - "validate-truthy": non-admin + field PRESENT and mismatched →
 *    FORBIDDEN. Field absent → passes through untouched (no stamp, no
 *    rejection — the caller is trusted to have set it, or a later required-
 *    field check catches the omission). Admin/internal: always passthrough.
 *    (Memory.post/put, Soul.post/put via the old enforceWriteAuth helper.)
 *
 *  - "validate-strict": non-admin + field mismatched, INCLUDING when the
 *    field is absent (a bare `!==` compare, no truthy guard — `undefined
 *    !== auth.agentId` is true, so an unset field is rejected, unlike
 *    "validate-truthy"). Never stamps (passing implies already-equal).
 *    Admin/internal: always passthrough. (WorkspaceState.put, OrgEvent.put.)
 *
 *  - "stamp-default": non-admin → unconditional overwrite with
 *    auth.agentId, NEVER rejects a mismatch (there is no rejection branch
 *    at all for non-admin). Admin → default-if-absent only (`||=`) — an
 *    admin-supplied value passes through. Internal → passthrough.
 *    (WorkspaceState.post, OrgEvent.post.)
 *
 *  - "stamp-strict": non-admin + field PRESENT and mismatched → FORBIDDEN,
 *    else unconditional stamp with auth.agentId (even when it already
 *    matched — this is the "K&S refinement" idiom from the
 *    relationship-write-path spec: a clearer signal than silent
 *    overwrite-on-mismatch). Admin/internal: passthrough, no default-if-
 *    absent (an admin/internal write with no field set stays unset here —
 *    a later required-field check is expected to catch it).
 *    (Relationship.put.)
 *
 * `auth.kind === "anonymous"` is NOT handled here — every call site already
 * 401s anonymous before reaching attribution stamping; this function is
 * only ever called with an already-resolved non-anonymous verdict.
 */
export type AttributionMode = "validate-truthy" | "validate-strict" | "stamp-default" | "stamp-strict";

export interface AttributionResult {
  /** Set when the write must be rejected; caller returns this directly. */
  denied?: Response;
}

export function stampAttribution(
  auth: AgentAuthVerdict,
  content: any,
  field: string,
  mode: AttributionMode,
  forbiddenMessage: string,
): AttributionResult {
  if (auth.kind !== "agent") return {}; // internal → always passthrough

  if (auth.isAdmin) {
    if (mode === "stamp-default") content[field] ||= auth.agentId;
    // every other mode: admin passthrough, untouched
    return {};
  }

  // non-admin agent
  switch (mode) {
    case "validate-truthy":
      if (content?.[field] && content[field] !== auth.agentId) {
        return { denied: FORBIDDEN(forbiddenMessage) };
      }
      return {};
    case "validate-strict":
      if (content[field] !== auth.agentId) {
        return { denied: FORBIDDEN(forbiddenMessage) };
      }
      return {};
    case "stamp-default":
      content[field] = auth.agentId;
      return {};
    case "stamp-strict":
      if (content?.[field] && content[field] !== auth.agentId) {
        return { denied: FORBIDDEN(forbiddenMessage) };
      }
      content[field] = auth.agentId;
      return {};
  }
}

// ─── (d) Provenance wiring ──────────────────────────────────────────────────
// buildProvenance itself is already table-agnostic (./provenance.ts) and is
// re-exported above, unmodified, for a single kit import surface. Per
// Kern/Sherlock's DESIGN REVIEW verdict (Q4): stamp the identical shape
// everywhere it's wired, never a table-specific format — and per this
// slice's explicit behavior-preservation bar, do NOT wire it onto
// WorkspaceState/OrgEvent, which don't stamp it today (only Memory and
// Relationship do). See Memory.ts/Relationship.ts for the call sites.
