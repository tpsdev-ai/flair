/**
 * collision-lib.ts — pure join/rank/format logic for MemoryBootstrap's
 * "Others in the room" collision-surfacing block (flair#681, the attention-
 * plane flagship — spec: flair#681 "Phase 2 — collision
 * surfacing in bootstrap").
 *
 * This module does NO Harper reads of its own. resources/MemoryBootstrap.ts's
 * post() does the (already-scoped, already-gated) reads —
 *   - entity-overlap candidates from WorkspaceState (internal server-side
 *     path, Sherlock Option 1 — the #678 AttentionQuery pattern) and OrgEvent
 *     (org-open read model, no per-agent scoping to respect),
 *   - semantic-match candidates from the SAME scored candidate pool #550's
 *     existing code already computes during bootstrap (HNSW cosine
 *     similarity against the caller's embedded currentTask, via the bounded
 *     retrieveCandidates() core — flair-bootstrap-scale-fix replaced the
 *     original full-corpus JS dot-product scan with this bounded pushdown;
 *     same `score > 0.3` relevance floor, same "no new embedding code"
 *     property — see resources/MemoryBootstrap.ts and resources/
 *     semantic-retrieval-core.ts),
 *   - the freshness gate from the Presence roster (resources/
 *     presence-internal.ts's getPresenceRoster(), the SAME internal path
 *     #678 established — never the raw table),
 * and hands the resulting plain-object candidates to this module to join,
 * freshness-gate, rank, and format. Kept Harper-free so it can be unit-tested
 * directly (test/unit/collision-lib.test.ts) — the same reason
 * resources/memory-bootstrap-lib.ts exists for the Team-roster helpers.
 *
 * Per the K&S verdict's correction: Memory is the SEMANTIC surface (reused,
 * via #550); WorkspaceState/OrgEvent are the ENTITY surface (exact index
 * overlap). This module joins the two, never conflating them — an
 * entity-overlap match is always high-precision (exact vocabulary-string
 * equality) and never needs its own relevance score; a semantic-only match
 * always carries the score #550 already floor-gated.
 */

export interface EntityMatchInput {
  agentId: string;
  /** The OVERLAPPING entities only (intersection with the caller's set) — never the teammate's full entity list. */
  entities: string[];
  summary: string | null;
  taskId: string | null;
  /** ISO timestamp (WorkspaceState.timestamp or OrgEvent.createdAt) — recency ranking key. */
  timestamp: string;
  source: "workspace" | "event";
}

export interface SemanticMatchInput {
  agentId: string;
  /** #550's existing candidate score (HNSW cosine similarity, flair-bootstrap-scale-fix) — already > 0.3 (the relevance floor) by construction. */
  score: number;
  /** Short display text for the matching memory (summary, falling back to content). */
  content: string;
}

export interface PresenceRosterRow {
  id?: unknown;
  displayName?: unknown;
  presenceStatus?: unknown;
  lastHeartbeatAt?: unknown;
}

export interface CollisionEntry {
  agentId: string;
  displayName: string;
  kind: "entity" | "semantic";
  line: string;
  lastHeartbeatAt: number;
}

/**
 * Build a Harper query condition matching ANY of `entities` against an
 * indexed `entities` array attribute. Harper's real query engine THROWS
 * ("An 'or' operator requires at least two conditions") for an `operator:
 * "or"` condition with fewer than two sub-conditions — a single-entity
 * caller (the common case) would otherwise silently break the whole
 * collision block (caught only by a real-Harper e2e test, never the mocked
 * unit suite — see test/integration/bootstrap-collision-e2e.test.ts).
 * Callers must always call this instead of hand-rolling the OR wrapper.
 */
export function buildEntityMatchCondition(entities: string[], attribute = "entities"): any {
  if (entities.length === 1) {
    return { attribute, comparator: "equals", value: entities[0] };
  }
  return {
    operator: "or",
    conditions: entities.map((e) => ({ attribute, comparator: "equals", value: e })),
  };
}

const MS_MIN = 60_000;
const MS_HOUR = 3600_000;
const MS_DAY = 24 * MS_HOUR;

/** "4m ago" / "2h ago" / "3d ago" — mirrors the issue's own example phrasing. */
export function formatRelativeTime(fromMs: number, nowMs: number = Date.now()): string {
  const elapsed = Math.max(0, nowMs - fromMs);
  if (elapsed < MS_MIN) return "just now";
  if (elapsed < MS_HOUR) return `${Math.floor(elapsed / MS_MIN)}m ago`;
  if (elapsed < MS_DAY) return `${Math.floor(elapsed / MS_HOUR)}h ago`;
  return `${Math.floor(elapsed / MS_DAY)}d ago`;
}

function clip(s: string, max = 80): string {
  const t = s.trim().replace(/\s+/g, " ");
  if (t.length === 0) return t;
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * The freshness gate: only agents with a Presence roster row whose
 * `presenceStatus` is NOT "offline" are candidates at all — reuses
 * Presence.ts's OWN derivePresenceStatus()-driven verdict (a heartbeat
 * within the offline threshold), never a re-implemented threshold. An agent
 * absent from the roster entirely (never heartbeated) is excluded outright —
 * no heartbeat is the strictest possible "not fresh."
 */
export function freshPresenceByAgent(roster: PresenceRosterRow[]): Map<string, PresenceRosterRow> {
  const out = new Map<string, PresenceRosterRow>();
  for (const row of roster) {
    const id = row?.id;
    if (typeof id !== "string" || id.length === 0) continue;
    if (row.presenceStatus === "offline") continue;
    const hb = row.lastHeartbeatAt;
    if (hb === null || hb === undefined) continue; // no heartbeat at all → not fresh
    const hbNum = typeof hb === "number" ? hb : Number(hb);
    if (!Number.isFinite(hbNum)) continue;
    out.set(id, row);
  }
  return out;
}

/**
 * Join entity-overlap + semantic-match candidates against the freshness-
 * gated presence map, rank (entity overlap first — high precision, exact
 * match — then semantic by score desc), and format each into a single
 * "others in the room" line. Never returns more than one entry per agent
 * (entity detail wins over semantic when a teammate has both — the
 * higher-precision signal leads). Never surfaces an agent absent from
 * `freshByAgent` (the freshness gate) or the caller itself.
 */
export function buildCollisionEntries(
  entityMatches: EntityMatchInput[],
  semanticMatches: SemanticMatchInput[],
  freshByAgent: Map<string, PresenceRosterRow>,
  callerAgentId: string,
  nowMs: number = Date.now(),
): CollisionEntry[] {
  const byAgent = new Map<string, CollisionEntry>();

  const sortedEntity = entityMatches
    .filter((m) => m.agentId !== callerAgentId && m.entities.length > 0)
    .slice()
    .sort((a, b) => (b.timestamp || "").localeCompare(a.timestamp || ""));

  for (const m of sortedEntity) {
    if (byAgent.has(m.agentId)) continue; // best (most recent) row per agent wins
    const presence = freshByAgent.get(m.agentId);
    if (!presence) continue; // freshness gate
    const displayName = typeof presence.displayName === "string" && presence.displayName
      ? presence.displayName
      : m.agentId;
    const hbRaw = presence.lastHeartbeatAt;
    const hb = typeof hbRaw === "number" ? hbRaw : Number(hbRaw);
    const entityList = m.entities.join(", ");
    const detail = m.summary ? ` (${clip(m.summary)})` : "";
    const line = `${displayName} is touching ${entityList}${detail} — last active ${formatRelativeTime(hb, nowMs)}`;
    byAgent.set(m.agentId, { agentId: m.agentId, displayName, kind: "entity", line, lastHeartbeatAt: hb });
  }

  const sortedSemantic = semanticMatches
    .filter((m) => m.agentId !== callerAgentId)
    .slice()
    .sort((a, b) => b.score - a.score);

  for (const m of sortedSemantic) {
    if (byAgent.has(m.agentId)) continue; // entity-overlap already covers this agent — higher precision wins
    const presence = freshByAgent.get(m.agentId);
    if (!presence) continue; // freshness gate
    const displayName = typeof presence.displayName === "string" && presence.displayName
      ? presence.displayName
      : m.agentId;
    const hbRaw = presence.lastHeartbeatAt;
    const hb = typeof hbRaw === "number" ? hbRaw : Number(hbRaw);
    const line = `${displayName} has related work in progress (${clip(m.content)}) — last active ${formatRelativeTime(hb, nowMs)}`;
    byAgent.set(m.agentId, { agentId: m.agentId, displayName, kind: "semantic", line, lastHeartbeatAt: hb });
  }

  // Entity-kind entries first (rank order preserved by insertion above is not
  // guaranteed across the two passes' Map writes), then semantic — within
  // each kind, most-recently-active first.
  return [...byAgent.values()].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "entity" ? -1 : 1;
    return b.lastHeartbeatAt - a.lastHeartbeatAt;
  });
}
