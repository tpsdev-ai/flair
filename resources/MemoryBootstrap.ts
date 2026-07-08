import { Resource, databases } from "@harperfast/harper";
import { allowVerified } from "./agent-auth.js";
import { getEmbedding } from "./embeddings-provider.js";
import { wrapUntrusted } from "./content-safety.js";
import { isTeammate, formatTeamLine } from "./memory-bootstrap-lib.js";
import { resolveReadScope } from "./memory-read-scope.js";

/**
 * POST /MemoryBootstrap
 *
 * Predictive context builder for agent session starts.
 * Returns prioritized, token-budgeted context with:
 *   1. Soul records (identity, role, preferences)
 *   2. Permanent memories (safety rules, core principles)
 *   3. Recent memories (adaptive window)
 *   4. Task-relevant memories (semantic search if currentTask provided)
 *   4b. Teammate findings relevant to your task (flair#550 — the SAME scored
 *      task-relevant set as #4, split by origin: any other in-org agent's
 *      NON-PRIVATE memory that scores against currentTask lands here instead
 *      of #4, attributed via "[via <agentId>]" — no MemoryGrant required
 *      (open-within-org read, per #578). Presentation only — what's readable
 *      is entirely resolveReadScope()'s job; this only changes how an
 *      already-read cross-agent record is formatted/sectioned)
 *   5. Relationship context (active relationships for mentioned entities)
 *   6. Predicted context (based on channel/surface/subject hints)
 *   7. Team roster (other active agents in this office + a search-first nudge —
 *      bootstrap loads the caller's own memories plus every other in-org
 *      agent's non-private memories (open-within-org read, never anyone's
 *      private ones), so this section nudges toward memory_search for
 *      anything beyond that window)
 *
 * Prediction: when context signals (channel, surface, subjects) are provided,
 * the bootstrap loads more aggressively — Flair is fast enough that the
 * bottleneck is prediction quality, not load time.
 *
 * Request:
 *   { agentId, currentTask?, maxTokens?, includeSoul?, since?,
 *     channel?, surface?, subjects? }
 *
 * Response:
 *   { context, sections, tokenEstimate, memoriesIncluded, memoriesAvailable }
 */

// Rough token estimate: ~4 chars per token for English text
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// `agentId` is the BOOTSTRAPPING agent (the caller) — used only to decide
// whether to annotate attribution, never to change what's read (that
// boundary is resolveReadScope()'s job, upstream of this function). A
// cross-agent record always carries `_source` (set once, above, when the
// record's own agentId differs from the bootstrapping agent — see the
// allMemories loop), so `m._source !== agentId` is the "is this a
// teammate's finding" check; own memories never carry `_source` at all.
function formatMemory(m: any, agentId?: string): string {
  const tag = m.durability === "permanent" ? "🔒" : m.durability === "persistent" ? "📌" : "📝";
  const date = m.createdAt ? ` (${m.createdAt.slice(0, 10)})` : "";
  const chain = m.supersedes ? " [supersedes earlier decision]" : "";
  const attribution = m._source && m._source !== agentId ? `[via ${m._source}] ` : "";
  const base = `${tag} ${attribution}${m.content}${date}${chain}`;

  // Wrap flagged memories in safety delimiters — composes with attribution
  // above (attribution is baked into `base` before wrapping, so a flagged
  // teammate memory renders with BOTH the "[via <agent>]" tag and the
  // untrusted-content wrapper).
  if (m._safetyFlags && Array.isArray(m._safetyFlags) && m._safetyFlags.length > 0) {
    return wrapUntrusted(base, m._source);
  }
  return base;
}

export class BootstrapMemories extends Resource {
  // Self-authorize via the Ed25519 agent verify (the auth reshape removes the
  // gate's admin super_user elevation, so custom resources must self-gate or
  // Harper denies them for the least-privilege flair_agent role). Any verified
  // agent may bootstrap; per-agent scoping is enforced in post() below.
  async allowCreate(): Promise<boolean> {
    return allowVerified((this as any).getContext?.());
  }

  async post(data: any, _context?: any) {
    const {
      agentId: bodyAgentId,
      currentTask,
      maxTokens = 4000,
      includeSoul = true,
      since,
      channel,     // e.g., "discord", "tps-mail", "claude-code"
      surface,     // e.g., "tps-build", "tps-review", "cli-session"
      subjects,    // e.g., ["flair", "auth"] — entities to preload context for
    } = data || {};

    // Authenticated identity lives on getContext().request — `this.request` is
    // NOT populated on Harper v5 Resources. Reading it returned undefined and
    // the scope check was silently bypassed, letting a non-admin agent read
    // another agent's soul + memories by passing the victim's id in the body.
    const ctx = (this as any).getContext?.();
    const request = ctx?.request ?? ctx;
    const authenticatedAgent: string | undefined =
      request?.tpsAgent ?? request?.headers?.get?.("x-tps-agent");
    const callerIsAdmin: boolean = request?.tpsAgentIsAdmin === true;

    if (!bodyAgentId && !authenticatedAgent) {
      return new Response(JSON.stringify({ error: "agentId required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (authenticatedAgent && !callerIsAdmin && bodyAgentId && bodyAgentId !== authenticatedAgent) {
      return new Response(JSON.stringify({
        error: "forbidden: agentId must match authenticated agent",
      }), { status: 403, headers: { "Content-Type": "application/json" } });
    }

    // Pin scope to the authenticated agent for non-admins; admins can bootstrap
    // any agentId (needed for setup scripts and UI impersonation flows).
    const agentId: string = (authenticatedAgent && !callerIsAdmin)
      ? authenticatedAgent
      : bodyAgentId;

    const sections: Record<string, string[]> = {
      soul: [],
      skills: [],
      team: [],
      permanent: [],
      recent: [],
      predicted: [],
      relationships: [],
      relevant: [],
      teammate: [],
      events: [],
    };
    let tokenBudget = maxTokens;
    let memoriesIncluded = 0;
    let memoriesAvailable = 0;
    let memoriesTruncated = 0;

    // --- 1. Soul records (budgeted — prioritized by key importance) ---
    // Soul is who you are, but we still need to respect token budgets.
    // Workspace files (SOUL.md, AGENTS.md) can be massive — they're already
    // injected by the runtime via workspace context, so we prioritize
    // concise soul entries over full file dumps.
    const SOUL_KEY_PRIORITY: Record<string, number> = {
      role: 0, identity: 1, thinking: 2, communication_style: 3,
      team: 4, ownership: 5, infrastructure: 6, "user-context": 7,
      // Full workspace files — lowest priority (runtime already injects these)
      soul: 90, "workspace-rules": 91,
    };

    const skillAssignments: any[] = [];
    const soulMaxTokens = Math.floor(maxTokens * 0.4); // 40% of budget for soul
    if (includeSoul) {
      let soulTokens = 0;
      const soulEntries: { key: string; line: string; tokens: number; priority: number }[] = [];

      for await (const record of (databases as any).flair.Soul.search()) {
        if (record.agentId !== agentId) continue;
        if (record.key === "skill-assignment") {
          skillAssignments.push(record);
          continue;
        }
        const line = `**${record.key}:** ${record.value}`;
        const tokens = estimateTokens(line);
        const priority = SOUL_KEY_PRIORITY[record.key] ?? 50;
        soulEntries.push({ key: record.key, line, tokens, priority });
      }

      // Sort by priority (lower = more important)
      soulEntries.sort((a, b) => a.priority - b.priority);

      for (const entry of soulEntries) {
        if (soulTokens + entry.tokens > soulMaxTokens) {
          // Skip large entries that exceed budget — truncate or skip
          if (entry.priority >= 90) continue; // skip full workspace files
          // Truncate if it's important but too long
          const maxChars = (soulMaxTokens - soulTokens) * 4;
          if (maxChars > 100) {
            const truncated = `**${entry.key}:** ${entry.line.slice(entry.key.length + 6, entry.key.length + 6 + maxChars)}…(truncated)`;
            sections.soul.push(truncated);
            soulTokens += estimateTokens(truncated);
          }
          continue;
        }
        sections.soul.push(entry.line);
        soulTokens += entry.tokens;
      }
    }

    // --- 1b. Skill assignments (ordered by priority, conflict detection) ---
    if (skillAssignments.length > 0) {
      const priorityOrder: Record<string, number> = { critical: 0, high: 1, standard: 2, low: 3 };
      skillAssignments.sort((a, b) => {
        const pa = priorityOrder[a.priority ?? "standard"] ?? 2;
        const pb = priorityOrder[b.priority ?? "standard"] ?? 2;
        return pa - pb;
      });

      // Detect conflicts at same priority level
      const byPriority = new Map<string, any[]>();
      for (const skill of skillAssignments) {
        const p = skill.priority ?? "standard";
        if (!byPriority.has(p)) byPriority.set(p, []);
        byPriority.get(p)!.push(skill);
      }

      for (const skill of skillAssignments) {
        const p = skill.priority ?? "standard";
        let meta: any = {};
        try { meta = typeof skill.metadata === "string" ? JSON.parse(skill.metadata) : (skill.metadata ?? {}); } catch {}
        const source = meta.source ? `, source: ${meta.source}` : "";
        let line = `- ${skill.value} (${p} priority${source})`;
        // Flag conflicts at same priority level
        const peers = byPriority.get(p) ?? [];
        if (peers.length > 1) {
          line += " [SKILL_CONFLICT]";
        }
        sections.skills.push(line);
      }
    }

    // --- 1c. Team roster + cross-agent search nudge ---
    // Soul is still caller-own-only (unaffected here). Memory loading below
    // (step 2) now also includes every other in-org agent's non-private
    // memories (open-within-org read, no MemoryGrant needed — #578) — but
    // this section stays: memory_search/SemanticSearch remains the
    // deliberate, query-driven way to find a teammate's finding, vs.
    // bootstrap's fixed recent/permanent window. This section is fixed-cost
    // (no query text to format per agent) so it's cheap enough to always
    // include, not budgeted.
    //
    // Permissive kind/status checks are DELIBERATE: Agent.ts registration
    // defaults both (`kind ||= "agent"`, `status ||= "active"`), so pre-1.0
    // records missing either field are legacy agents/active — a strict
    // `!== "agent"` check would silently drop them. Assumes single-tenant
    // (one instance = one office); grant-filtered roster is the multi-tenant follow-up.
    try {
      const teammateIds: string[] = [];
      for await (const record of (databases as any).flair.Agent.search()) {
        if (isTeammate(record, agentId)) teammateIds.push(record.id);
      }
      const line = formatTeamLine(teammateIds);
      if (line) sections.team.push(line);
    } catch {
      // Agent table may not exist in older / standalone deployments
    }

    // --- 2. Permanent memories (always included, highest priority) ---
    // Read-scope: own (any visibility) + every OTHER in-org agent's
    // non-private memory — open-within-org read (#578), no MemoryGrant
    // consulted at all. Centralized in resolveReadScope(): the condition is
    // pushed into the Harper query (so the table itself never returns an
    // out-of-scope row), and `scope.isAllowed` re-checks in-process as
    // defense-in-depth (same belt-and-suspenders discipline as
    // SemanticSearch's BM25 pre-fusion filter) — this is the #550 foundation:
    // bootstrap can now safely expand beyond own-only without a parallel
    // scoping rule, and that rule tracks resolveReadScope()'s model
    // automatically (grant-gated when #568 first built this, open-within-org
    // now that #578 has landed — this file never re-implements the rule, so
    // it never has to change when the rule does).
    const scope = await resolveReadScope(agentId);
    const allMemories: any[] = [];
    for await (const record of (databases as any).flair.Memory.search({ conditions: [scope.condition] })) {
      if (!scope.isAllowed(record)) continue;
      if (record.expiresAt && Date.parse(record.expiresAt) < Date.now()) continue;
      // A past validTo ALWAYS means the record has been closed out
      // (server supersede path — Memory.ts closeSupersededRecord — sets
      // validTo without necessarily setting `archived`), same root cause and
      // fix as SemanticSearch.ts's unconditional past-validTo/bm25-filter
      // exclusion. Unconditional
      // so a server-superseded record can't resurface in bootstrap just
      // because its successor isn't co-present in this result set (the
      // supersededIds filter further down only catches co-presence). A
      // record with no validTo, or a future validTo, is unaffected.
      if (record.validTo && Date.parse(record.validTo) < Date.now()) continue;
      // Attribution for cross-agent (any other in-org agent's) records — same
      // convention SemanticSearch.ts already uses: formatMemory() below only USES this
      // when the record also carries _safetyFlags (labels the untrusted-data
      // wrapper with whose memory it is), it never forces wrapping on its own.
      // Real Harper's search() results are non-extensible objects — mutating
      // `record._source = ...` directly throws ("object is not extensible");
      // shallow-copy instead of mutating in place.
      allMemories.push(record.agentId !== agentId ? { ...record, _source: record.agentId } : record);
    }
    memoriesAvailable = allMemories.length;

    // Build superseded set: exclude memories that have been replaced by newer ones
    const supersededIds = new Set<string>();
    for (const m of allMemories) {
      if (m.supersedes) supersededIds.add(m.supersedes);
    }
    const activeMemories = allMemories.filter((m) => !supersededIds.has(m.id));

    // #550 design boundary: the permanent / recent / predicted sections are the
    // agent's OWN working context — own-only, always. `activeMemories` also
    // carries every other in-org agent's non-private records (`_source` set,
    // open-within-org read — no grant involved), but that cross-agent
    // visibility exists to feed the task-relevant "Teammate findings"
    // surfacing (#550) below, NOT to blend a teammate's memories into the
    // reader's recent/permanent/predicted view. So these three sections
    // filter to own (`!m._source`); team knowledge surfaces only when
    // task-relevant (the teammate section) or via an explicit memory_search.
    const ownMemories = activeMemories.filter((m) => !m._source);

    const permanent = ownMemories.filter((m) => m.durability === "permanent");
    for (const m of permanent) {
      const line = formatMemory(m, agentId);
      const cost = estimateTokens(line);
      if (cost <= tokenBudget) {
        sections.permanent.push(line);
        tokenBudget -= cost;
        memoriesIncluded++;
      } else {
        memoriesTruncated++;
      }
    }

    // --- 3. Recent memories (adaptive window) ---
    // Start with 48h. If nothing found, widen to 7d, then 30d.
    // This prevents empty recent sections for agents that were idle.
    const nonPermanent = ownMemories
      .filter((m) => m.durability !== "permanent" && m.createdAt)
      .sort((a: any, b: any) => (b.createdAt || "").localeCompare(a.createdAt || ""));

    let effectiveSince: Date;
    if (since) {
      effectiveSince = new Date(since);
    } else {
      const windows = [48 * 3600_000, 7 * 24 * 3600_000, 30 * 24 * 3600_000];
      effectiveSince = new Date(Date.now() - windows[0]);
      for (const w of windows) {
        effectiveSince = new Date(Date.now() - w);
        const count = nonPermanent.filter((m) => new Date(m.createdAt!) >= effectiveSince).length;
        if (count >= 3) break; // found enough recent memories
      }
    }

    const recent = nonPermanent.filter((m) => new Date(m.createdAt!) >= effectiveSince);

    // Budget: up to 40% of remaining for recent
    const recentBudget = Math.floor(tokenBudget * 0.4);
    let recentSpent = 0;
    for (const m of recent) {
      const line = formatMemory(m, agentId);
      const cost = estimateTokens(line);
      if (recentSpent + cost > recentBudget) {
        memoriesTruncated++;
        continue;
      }
      sections.recent.push(line);
      recentSpent += cost;
      tokenBudget -= cost;
      memoriesIncluded++;
    }

    // --- 3b. Subject-predicted context ---
    // When subjects are provided (e.g., ["flair", "auth"]), load memories
    // tagged with those subjects that aren't already included. This is the
    // "predictive" part — the caller knows what topics are likely relevant
    // based on channel/surface/recent-activity.
    const predictedSubjects: string[] = Array.isArray(subjects)
      ? subjects.map((s: string) => s.toLowerCase())
      : [];

    if (predictedSubjects.length > 0 && tokenBudget > 200) {
      const includedIds = new Set([
        ...permanent.map((m: any) => m.id),
        ...recent.filter((_: any, i: number) => i < sections.recent.length).map((m: any) => m.id),
      ]);

      const subjectMemories = ownMemories
        .filter((m: any) =>
          !includedIds.has(m.id) &&
          m.subject &&
          predictedSubjects.includes(m.subject.toLowerCase()) &&
          m.durability !== "permanent" // already loaded
        )
        .sort((a: any, b: any) => (b.createdAt || "").localeCompare(a.createdAt || ""));

      const predictedBudget = Math.floor(tokenBudget * 0.3);
      let predictedSpent = 0;
      for (const m of subjectMemories) {
        const line = formatMemory(m, agentId);
        const cost = estimateTokens(line);
        if (predictedSpent + cost > predictedBudget) {
          memoriesTruncated++;
          continue;
        }
        sections.predicted.push(line);
        predictedSpent += cost;
        tokenBudget -= cost;
        memoriesIncluded++;
        includedIds.add(m.id);
      }
    }

    // --- 3c. Active relationships for predicted subjects ---
    if (predictedSubjects.length > 0 && tokenBudget > 100) {
      try {
        for (const subj of predictedSubjects) {
          for await (const rel of (databases as any).flair.Relationship.search({
            conditions: [
              { attribute: "agentId", comparator: "equals", value: agentId },
              {
                operator: "or",
                conditions: [
                  { attribute: "subject", comparator: "equals", value: subj },
                  { attribute: "object", comparator: "equals", value: subj },
                ],
              },
            ],
            operator: "and",
          })) {
            // Only include active relationships (no validTo or validTo in future)
            if (rel.validTo && rel.validTo < new Date().toISOString()) continue;
            const line = `- ${rel.subject} → ${rel.predicate} → ${rel.object}${rel.confidence < 1.0 ? ` (${Math.round(rel.confidence * 100)}%)` : ""}`;
            const cost = estimateTokens(line);
            if (cost > tokenBudget) break;
            sections.relationships.push(line);
            tokenBudget -= cost;
          }
        }
      } catch {
        // Relationship table may not exist yet
      }
    }

    // --- 4. Task-relevant memories (semantic search) ---
    if (currentTask && tokenBudget > 200) {
      let queryEmbedding: number[] | null = null;
      try {
        queryEmbedding = await getEmbedding(currentTask);
      } catch {}

      if (queryEmbedding) {
        // Score all non-included memories by relevance
        const includedIds = new Set([
          ...permanent.map((m) => m.id),
          ...recent.filter((_, i) => i < sections.recent.length).map((m) => m.id),
        ]);

        const scored = allMemories
          .filter((m) => !includedIds.has(m.id) && !supersededIds.has(m.id) && m.embedding?.length > 100)
          .map((m) => {
            let dot = 0;
            const len = Math.min(queryEmbedding!.length, m.embedding.length);
            for (let i = 0; i < len; i++) dot += queryEmbedding![i] * m.embedding[i];
            return { memory: m, score: dot };
          })
          .filter((s) => s.score > 0.3)
          .sort((a, b) => b.score - a.score);

        // #550: split the scored, task-relevant set by origin. Own findings
        // go to `relevant` as before; any other in-org agent's non-private
        // record — already read-scoped by resolveReadScope(), no grant
        // required (`m._source` is only ever set for a cross-agent record,
        // see the allMemories loop above) — goes to the new `teammate`
        // section so the agent can tell it apart at a glance. Both draw from
        // the SAME `tokenBudget` in one score-ordered pass — highest-relevance
        // memories win the remaining budget regardless of which section they
        // land in, so neither section double-spends.
        for (const { memory: m } of scored) {
          const line = formatMemory(m, agentId);
          const cost = estimateTokens(line);
          if (cost > tokenBudget) continue;
          if (m._source) {
            sections.teammate.push(line);
          } else {
            sections.relevant.push(line);
          }
          tokenBudget -= cost;
          memoriesIncluded++;
        }
      }
    }

    // --- 5. Recent OrgEvents for this agent ---
    try {
      const eventSince = data?.lastBootAt
        ? new Date(data.lastBootAt)
        : new Date(Date.now() - 24 * 3600_000);
      const eventSinceStr = eventSince.toISOString();
      const eventResults: any[] = [];

      for await (const event of (databases as any).flair.OrgEvent.search()) {
        if (!event.createdAt || event.createdAt < eventSinceStr) continue;
        if (event.expiresAt && new Date(event.expiresAt) < new Date()) continue;
        const targets = event.targetIds;
        const isRelevant = !targets || targets.length === 0 || targets.includes(agentId);
        if (!isRelevant) continue;
        eventResults.push(event);
      }

      eventResults.sort((a: any, b: any) => (a.createdAt || "").localeCompare(b.createdAt || ""));
      for (const evt of eventResults.slice(0, 10)) {
        const elapsed = Date.now() - new Date(evt.createdAt).getTime();
        const mins = Math.floor(elapsed / 60_000);
        const relTime = mins < 60 ? `${mins}min ago` : `${Math.floor(mins / 60)}h ago`;
        sections.events.push(`- ${evt.kind}: ${evt.summary} (${relTime})`);
      }
    } catch {
      // non-fatal: OrgEvent table may not exist yet
    }

    // --- Build context string ---
    const parts: string[] = [];

    if (sections.soul.length > 0) {
      parts.push("## Identity\n" + sections.soul.join("\n"));
    }
    if (sections.skills.length > 0) {
      parts.push("## Active Skills\n" + sections.skills.join("\n"));
    }
    if (sections.team.length > 0) {
      parts.push("## Team\n" + sections.team.join("\n"));
    }
    if (sections.permanent.length > 0) {
      parts.push("## Core Principles\n" + sections.permanent.join("\n"));
    }
    if (sections.recent.length > 0) {
      parts.push("## Recent Context\n" + sections.recent.join("\n"));
    }
    if (sections.predicted.length > 0) {
      parts.push("## Predicted Context\n" + sections.predicted.join("\n"));
    }
    if (sections.relationships.length > 0) {
      parts.push("## Active Relationships\n" + sections.relationships.join("\n"));
    }
    if (sections.relevant.length > 0) {
      parts.push("## Relevant Knowledge\n" + sections.relevant.join("\n"));
    }
    // #550: teammate findings relevant to the current task — right after the
    // agent's own task-relevant knowledge. Empty section renders nothing
    // (no header) so a bootstrap with no task-relevant teammate findings for
    // this task looks exactly as it did before this feature.
    if (sections.teammate.length > 0) {
      parts.push("## Teammate findings relevant to your task\n" + sections.teammate.join("\n"));
    }
    if (sections.events.length > 0) {
      parts.push("## Recent Org Events\n" + sections.events.join("\n"));
    }

    const context = parts.join("\n\n");
    const soulTokens = sections.soul.reduce((sum, line) => sum + estimateTokens(line), 0);
    const memoryTokens = maxTokens - tokenBudget;

    return {
      context,
      sections: {
        soul: sections.soul.length,
        skills: sections.skills.length,
        team: sections.team.length,
        permanent: sections.permanent.length,
        recent: sections.recent.length,
        predicted: sections.predicted.length,
        relationships: sections.relationships.length,
        relevant: sections.relevant.length,
        teammate: sections.teammate.length,
        events: sections.events.length,
      },
      tokenEstimate: soulTokens + memoryTokens,
      soulTokens,
      memoryTokens,
      memoriesIncluded,
      memoriesAvailable,
      memoriesTruncated,
    };
  }
}
