/**
 * AttentionQuery.ts — entity-scoped attention query (flair#677).
 *
 * POST /AttentionQuery — "what touches entity E in the last N days?", grouped
 * by source across the five surfaces the attention plane spans: Memory,
 * Relationship, WorkspaceState, Presence, OrgEvent. Spec:
 * FLAIR-ATTENTION-PLANE.md ("Phase 1 — the query" + the K&S verdict's
 * refinements). Builds on the entity vocabulary + `entities[]` fields shipped
 * in flair#675/#676 (resources/entity-vocab.ts, schemas/*.graphql).
 *
 * Deliberately NOT built here (separate follow-up, FLAIR-ATTENTION-PLANE.md
 * Phase 2): collision surfacing (joining a CALLER's own current task/
 * WorkspaceState against teammates' for overlap), semantic/embedding
 * matching, or a Relationship write path. This is read-only, exact-match,
 * index-pushdown across the five sources — nothing more.
 *
 * ─── Per-source read-scoping (binding, per the K&S verdict) ──────────────────
 *
 * - Memory: through resolveReadScope() (resources/memory-read-scope.ts) — the
 *   SAME centralized open-within-org-minus-private rule Memory.search()/
 *   SemanticSearch.ts/MemoryBootstrap.ts use. No new scoping logic.
 * - Relationship: mirrors Relationship.ts's OWN search() scoping (own agentId
 *   for non-admin, unfiltered for admin/internal) — the entity condition is
 *   ANDed with that same rule, never replacing it. Relationship carries no
 *   visibility field yet (unlike Memory's open-within-org reframe), so the
 *   conservative, least-surprising choice is "the same rows a direct
 *   `POST /Relationship` search from this caller would already return."
 * - WorkspaceState: Sherlock's Option 1 (K&S verdict, binding). WorkspaceState
 *   is normally strictly per-agent-scoped (403 cross-agent via the exported
 *   `WorkspaceState` resource class — see resources/WorkspaceState.ts). This
 *   query needs teammates' WorkspaceState, so it reads the RAW generated table
 *   object directly (`(databases as any).flair.WorkspaceState`), the same
 *   "internal path" idiom already used elsewhere in this codebase (e.g.
 *   OrgEvent.post()/put() call `(databases as any).flair.OrgEvent.put(...)`
 *   directly rather than through the exported subclass) — NEVER through the
 *   exported `WorkspaceState` class, which would just re-apply the per-agent
 *   403 for the caller's own identity. This does NOT broaden WorkspaceState's
 *   general read model (a plain `GET /WorkspaceState` from a non-admin agent
 *   still 403s cross-agent, unchanged) — it is a narrow, server-computed join
 *   scoped to one caller-supplied, validated entity string + a bounded day
 *   window, returning only rows that matched. The exposed field set mirrors
 *   exactly what FLAIR-ATTENTION-PLANE.md's Phase 2 write-up already names as
 *   the intended surfaced shape (`summary`, `taskId`, `filesChanged`,
 *   `entities`) plus bare identifiers (`id`, `agentId`, `ref`, `phase`,
 *   `timestamp`) — never `metadata` (an undocumented free-form JSON blob with
 *   no spec-blessed exposure here).
 * - Presence: via the exported `Presence` resource's get() (preserves its
 *   verified-agent currentTask content gate, #592) — never the raw table.
 *   Presence.get()'s gate keys off a fresh TPS-Ed25519 SIGNATURE
 *   (verifyAgentRequest), not an annotation, specifically to close the
 *   authorizeLocal-forged-identity vector (flair#610) — so this resource
 *   cannot just re-run resolveAgentAuth's verdict through it. Instead it
 *   pre-seeds verifyAgentRequest's OWN per-request memoization cache
 *   (`request._flairAgentAuth` — see resources/agent-auth.ts's
 *   verifyAgentRequest doc: "memoized... including null... we verify once and
 *   cache the result on the request") with the verdict THIS request already
 *   established via resolveAgentAuth. This is not a forgery: by the time this
 *   helper runs, `auth.kind` is already constrained to "agent" (a real
 *   Ed25519 signature verified upstream by auth-middleware.ts/agent-auth.ts)
 *   or "internal" (a trusted in-process call, unauthenticated-HTTP calls
 *   never reach this point — see the top-level anonymous gate below) — it
 *   relays an already-established fact instead of re-running a doomed second
 *   signature check (the original request's nonce was already consumed by
 *   auth-middleware.ts, so re-verifying the SAME raw request would collide
 *   with the shared nonce store and spuriously read as a replay).
 * - OrgEvent: OrgEvent's own read model has no per-agent scoping override at
 *   all (resources/OrgEvent.ts only gates allowRead() to allowVerified() —
 *   any verified agent/admin already reads every OrgEvent org-wide). The raw
 *   table is queried directly purely to avoid instantiating an unneeded
 *   Resource subclass; the effective access is identical either way.
 *
 * No source here EVER receives a global/unscoped entity scan: every query
 * carries EITHER the source's own read-scope condition (Memory,
 * Relationship, OrgEvent's already-org-open model) OR a narrowly-targeted,
 * validated single-entity + bounded-window condition (WorkspaceState), OR
 * goes through the source's own content-gated resource (Presence).
 */

import { Resource, databases } from "@harperfast/harper";
import { resolveAgentAuth, allowVerified, type AgentAuthVerdict } from "./agent-auth.js";
import { isValidEntity } from "./entity-vocab.js";
import { resolveReadScope } from "./memory-read-scope.js";
import { withDetachedTxn } from "./table-helpers.js";
import { checkRateLimit, rateLimitResponse } from "./rate-limiter.js";
import { wrapUntrusted } from "./content-safety.js";
import { getPresenceRoster } from "./presence-internal.js";

// ─── Tunables ─────────────────────────────────────────────────────────────────

export const DEFAULT_WINDOW_DAYS = 7;
const MAX_WINDOW_DAYS = 365;
// Per-source result cap. The attention view is meant to surface "what's
// touching this entity right now", not paginate a full history — a hot
// entity (e.g. a widely-referenced repo) is capped rather than returning an
// unbounded payload. Each source is independently capped (not a shared total).
const MAX_RESULTS_PER_SOURCE = 25;

const JSON_HEADERS = { "Content-Type": "application/json" } as const;

function badRequest(error: string, detail?: string): Response {
  return new Response(JSON.stringify({ error, ...(detail ? { detail } : {}) }), {
    status: 400,
    headers: JSON_HEADERS,
  });
}
const UNAUTH = () =>
  new Response(JSON.stringify({ error: "authentication required" }), { status: 401, headers: JSON_HEADERS });

// ─── Input validation ─────────────────────────────────────────────────────────

/** Validated query input, or a Response to short-circuit with. */
interface ParsedQuery {
  entity: string;
  days: number;
  sinceIso: string;
}

function parseQueryInput(data: any): ParsedQuery | Response {
  const entity = data?.entity;
  if (typeof entity !== "string" || entity.length === 0) {
    return badRequest("invalid_entity", "entity is required (a vocabulary string, e.g. 'repo:owner/name')");
  }
  // Exact match on the full type:value string — the SAME validator every
  // write path (Memory/WorkspaceState/OrgEvent) gates `entities` writes
  // through (resources/entity-vocab.ts). Rejects anything not drawn from the
  // closed, documented type set / grammar — never a prefix/regex match, so
  // this stays a plain indexed equality lookup, never a scan.
  if (!isValidEntity(entity)) {
    return badRequest("invalid_entity", `'${entity}' is not a well-formed vocabulary string (type:value, closed type set)`);
  }

  let days = DEFAULT_WINDOW_DAYS;
  if (data?.days !== undefined && data?.days !== null) {
    const n = Number(data.days);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
      return badRequest("invalid_days", "days must be a positive integer");
    }
    days = Math.min(n, MAX_WINDOW_DAYS);
  }

  const sinceIso = new Date(Date.now() - days * 24 * 3600_000).toISOString();
  return { entity, days, sinceIso };
}

// ─── Memory (resolveReadScope) ────────────────────────────────────────────────

interface MemoryHit {
  id: string;
  agentId: string;
  content: string;
  summary: string | null;
  subject: string | null;
  tags: string[] | null;
  durability: string | null;
  visibility: string | null;
  createdAt: string;
  updatedAt: string | null;
  entities: string[] | null;
}

async function queryMemory(ctx: any, entity: string, auth: AgentAuthVerdict): Promise<MemoryHit[]> {
  const conditions: any[] = [
    { attribute: "entities", comparator: "equals", value: entity },
    { attribute: "archived", comparator: "not_equal", value: true },
  ];
  // Same centralized scope every other cross-agent Memory read path uses
  // (Memory.search()/SemanticSearch.ts/MemoryBootstrap.ts) — own records (any
  // visibility) + any other agent's non-private record, org-open. Admin/
  // internal callers are unfiltered, matching those same call sites.
  if (auth.kind === "agent" && !auth.isAdmin) {
    const scope = await resolveReadScope(auth.agentId);
    conditions.unshift(scope.condition);
  }

  const query = {
    conditions,
    select: [
      "id", "agentId", "content", "summary", "subject", "tags", "durability",
      "visibility", "createdAt", "updatedAt", "entities", "_safetyFlags",
    ],
  };
  const rows = withDetachedTxn(ctx, () => (databases as any).flair.Memory.search(query));

  const callerAgent = auth.kind === "agent" ? auth.agentId : undefined;
  const hits: MemoryHit[] = [];
  for await (const r of rows as AsyncIterable<any>) {
    const isFlagged = Array.isArray(r._safetyFlags) && r._safetyFlags.length > 0;
    const fromOther = callerAgent !== undefined && r.agentId !== callerAgent;
    hits.push({
      id: r.id,
      agentId: r.agentId,
      content: isFlagged ? wrapUntrusted(r.content, fromOther ? r.agentId : undefined) : r.content,
      summary: r.summary ?? null,
      subject: r.subject ?? null,
      tags: Array.isArray(r.tags) ? r.tags : null,
      durability: r.durability ?? null,
      visibility: r.visibility ?? null,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt ?? null,
      entities: Array.isArray(r.entities) ? r.entities : null,
    });
  }
  hits.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  return hits.slice(0, MAX_RESULTS_PER_SOURCE);
}

// ─── Relationship (mirrors Relationship.ts's own search() scoping) ───────────

interface RelationshipHit {
  id: string;
  agentId: string;
  subject: string;
  predicate: string;
  object: string;
  confidence: number | null;
  validFrom: string | null;
  validTo: string | null;
  createdAt: string;
  updatedAt: string | null;
}

async function queryRelationship(ctx: any, entity: string, auth: AgentAuthVerdict): Promise<RelationshipHit[]> {
  const entityCondition = {
    operator: "or",
    conditions: [
      { attribute: "subject", comparator: "equals", value: entity },
      { attribute: "object", comparator: "equals", value: entity },
    ],
  };
  const conditions: any[] = [entityCondition];
  // Mirror Relationship.ts's search(): non-admin agents are scoped to their
  // own agentId; admin/internal calls are unfiltered. Never broader than what
  // a direct POST /Relationship search from this same caller would return.
  if (auth.kind === "agent" && !auth.isAdmin) {
    conditions.unshift({ attribute: "agentId", comparator: "equals", value: auth.agentId });
  }

  const rows = withDetachedTxn(ctx, () => (databases as any).flair.Relationship.search({ conditions }));
  const hits: RelationshipHit[] = [];
  for await (const r of rows as AsyncIterable<any>) {
    hits.push({
      id: r.id,
      agentId: r.agentId,
      subject: r.subject,
      predicate: r.predicate,
      object: r.object,
      confidence: typeof r.confidence === "number" ? r.confidence : null,
      validFrom: r.validFrom ?? null,
      validTo: r.validTo ?? null,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt ?? null,
    });
  }
  hits.sort((a, b) => (b.updatedAt || b.createdAt || "").localeCompare(a.updatedAt || a.createdAt || ""));
  return hits.slice(0, MAX_RESULTS_PER_SOURCE);
}

// ─── WorkspaceState (Sherlock Option 1 — internal server-side path) ──────────

interface WorkspaceStateHit {
  id: string;
  agentId: string;
  ref: string;
  phase: string | null;
  taskId: string | null;
  summary: string | null;
  filesChanged: string[] | null;
  timestamp: string;
  entities: string[] | null;
}

async function queryWorkspaceState(ctx: any, entity: string, sinceIso: string): Promise<WorkspaceStateHit[]> {
  const conditions = [
    { attribute: "entities", comparator: "equals", value: entity },
    { attribute: "timestamp", comparator: "greater_than_equal", value: sinceIso },
  ];
  // INTERNAL server-side path (Sherlock Option 1, binding): the RAW generated
  // table object, never the exported `WorkspaceState` resource class — that
  // class's search() re-applies strict per-agent scoping keyed off THIS
  // caller's own identity, which would just filter every teammate's row back
  // out. See this file's module doc for the full rationale + why this is not
  // a broadening of WorkspaceState's general (still per-agent, still 403)
  // read model.
  const query = {
    conditions,
    select: ["id", "agentId", "ref", "phase", "taskId", "summary", "filesChanged", "timestamp", "entities"],
  };
  const rows = withDetachedTxn(ctx, () => (databases as any).flair.WorkspaceState.search(query));
  const hits: WorkspaceStateHit[] = [];
  for await (const r of rows as AsyncIterable<any>) {
    hits.push({
      id: r.id,
      agentId: r.agentId,
      ref: r.ref,
      phase: r.phase ?? null,
      taskId: r.taskId ?? null,
      summary: r.summary ?? null,
      filesChanged: Array.isArray(r.filesChanged) ? r.filesChanged : null,
      timestamp: r.timestamp,
      entities: Array.isArray(r.entities) ? r.entities : null,
    });
  }
  hits.sort((a, b) => (b.timestamp || "").localeCompare(a.timestamp || ""));
  return hits.slice(0, MAX_RESULTS_PER_SOURCE);
}

// ─── Presence (via the Presence resource — content gate preserved) ──────────

interface PresenceHit {
  agentId: string;
  displayName: unknown;
  activity: unknown;
  currentTask: string;
  presenceStatus: unknown;
  lastHeartbeatAt: unknown;
}

// Presence roster fetch (the synthetic delegation-context trick) now lives in
// resources/presence-internal.ts, shared with MemoryBootstrap.ts's collision
// surfacing (flair#681) — see that file's module doc for the full security
// rationale (why this isn't a forgery, why a fresh signature re-verify isn't
// possible). This file's own "Presence" doc section above still applies; it
// just no longer duplicates the code.

async function queryPresence(auth: AgentAuthVerdict, entity: string): Promise<PresenceHit[]> {
  const roster = await getPresenceRoster(auth); // fail-open (empty) — never fail the whole attention query

  // Bounded scan: Presence carries exactly one row per agent (org-wide agent
  // count is small), so a free-text substring match here is the pushdown-free
  // exception the K&S verdict explicitly blesses ("Presence is a bounded
  // scan, one row/agent, tiny") — unlike the other four sources, currentTask
  // is unstructured prose with no indexed entities field to push down on.
  const hits: PresenceHit[] = [];
  for (const row of roster) {
    if (typeof row?.currentTask !== "string" || row.currentTask.length === 0) continue;
    if (!row.currentTask.includes(entity)) continue;
    hits.push({
      agentId: row.id,
      displayName: row.displayName,
      activity: row.activity,
      currentTask: row.currentTask,
      presenceStatus: row.presenceStatus,
      lastHeartbeatAt: row.lastHeartbeatAt,
    });
  }
  hits.sort((a, b) => {
    const av = typeof a.lastHeartbeatAt === "number" ? a.lastHeartbeatAt : 0;
    const bv = typeof b.lastHeartbeatAt === "number" ? b.lastHeartbeatAt : 0;
    return bv - av;
  });
  return hits.slice(0, MAX_RESULTS_PER_SOURCE);
}

// ─── OrgEvent (org-open read model — no per-agent scoping to respect) ───────

interface OrgEventHit {
  id: string;
  authorId: string;
  kind: string;
  scope: string | null;
  summary: string;
  detail: string | null;
  targetIds: string[] | null;
  createdAt: string;
  entities: string[] | null;
}

async function queryOrgEvent(ctx: any, entity: string, sinceIso: string): Promise<OrgEventHit[]> {
  const conditions = [
    { attribute: "entities", comparator: "equals", value: entity },
    { attribute: "createdAt", comparator: "greater_than_equal", value: sinceIso },
  ];
  const query = {
    conditions,
    select: ["id", "authorId", "kind", "scope", "summary", "detail", "targetIds", "createdAt", "expiresAt", "entities"],
  };
  const rows = withDetachedTxn(ctx, () => (databases as any).flair.OrgEvent.search(query));
  const now = Date.now();
  const hits: OrgEventHit[] = [];
  for await (const r of rows as AsyncIterable<any>) {
    // Skip expired events (mirrors OrgEventCatchup.ts's in-process expiry filter).
    if (r.expiresAt && new Date(r.expiresAt).getTime() < now) continue;
    hits.push({
      id: r.id,
      authorId: r.authorId,
      kind: r.kind,
      scope: r.scope ?? null,
      summary: r.summary,
      detail: r.detail ?? null,
      targetIds: Array.isArray(r.targetIds) ? r.targetIds : null,
      createdAt: r.createdAt,
      entities: Array.isArray(r.entities) ? r.entities : null,
    });
  }
  hits.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  return hits.slice(0, MAX_RESULTS_PER_SOURCE);
}

// ─── Resource ─────────────────────────────────────────────────────────────────

export class AttentionQuery extends Resource {
  // Self-authorize (allowVerified: any verified agent/admin/internal call;
  // anonymous denied). Per-source scoping is applied inside post() — see the
  // module doc above for each source's rule.
  async allowCreate(): Promise<boolean> {
    return allowVerified((this as any).getContext?.());
  }

  async post(data: any) {
    const ctx = (this as any).getContext?.();
    const auth = await resolveAgentAuth(ctx);
    if (auth.kind === "anonymous") return UNAUTH();

    if (auth.kind === "agent") {
      const rl = checkRateLimit(auth.agentId, "general");
      if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs!, "attention");
    }

    const parsed = parseQueryInput(data);
    if (parsed instanceof Response) return parsed;
    const { entity, days, sinceIso } = parsed;

    // Sequential, not Promise.all: each helper wraps its table read in
    // withDetachedTxn (save/clear/call/restore ctx.transaction around a
    // SYNCHRONOUS search() call — see table-helpers.ts's doc). Running five
    // of these concurrently over the SAME shared `ctx` would risk one call's
    // save/restore interleaving with another's in-flight generator iteration
    // in ways Harper's transaction chaining isn't documented to tolerate.
    // Every other multi-table resource in this codebase (Memory.ts,
    // SemanticSearch.ts, MemoryBootstrap.ts) sequences its cross-table reads
    // for the same reason — this query is an internal/coordination read, not
    // a latency-critical hot path, so the small sequential cost is the safe
    // trade.
    const memory = await queryMemory(ctx, entity, auth);
    const relationship = await queryRelationship(ctx, entity, auth);
    const workspaceState = await queryWorkspaceState(ctx, entity, sinceIso);
    const presence = await queryPresence(auth, entity);
    const orgEvent = await queryOrgEvent(ctx, entity, sinceIso);

    return {
      entity,
      windowDays: days,
      since: sinceIso,
      groups: { memory, relationship, workspaceState, presence, orgEvent },
      counts: {
        memory: memory.length,
        relationship: relationship.length,
        workspaceState: workspaceState.length,
        presence: presence.length,
        orgEvent: orgEvent.length,
        total: memory.length + relationship.length + workspaceState.length + presence.length + orgEvent.length,
      },
    };
  }
}
