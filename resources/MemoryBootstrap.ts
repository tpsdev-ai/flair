import { Resource, databases } from "@harperfast/harper";
import { getEmbedding } from "./embeddings-provider.js";
import { wrapUntrusted } from "./content-safety.js";

/**
 * POST /MemoryBootstrap
 *
 * Predictive context builder for agent session starts.
 * Returns prioritized, token-budgeted context with:
 *   1. Soul records (identity, role, preferences)
 *   2. Permanent memories (safety rules, core principles)
 *   3. Recent memories (adaptive window)
 *   4. Task-relevant memories (semantic search if currentTask provided)
 *   5. Relationship context (active relationships for mentioned entities)
 *   6. Predicted context (based on channel/surface/subject hints)
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

function formatMemory(m: any, supersedes?: boolean): string {
  const tag = m.durability === "permanent" ? "🔒" : m.durability === "persistent" ? "📌" : "📝";
  const date = m.createdAt ? ` (${m.createdAt.slice(0, 10)})` : "";
  const chain = m.supersedes ? " [supersedes earlier decision]" : "";
  const base = `${tag} ${m.content}${date}${chain}`;

  // Wrap flagged memories in safety delimiters
  if (m._safetyFlags && Array.isArray(m._safetyFlags) && m._safetyFlags.length > 0) {
    return wrapUntrusted(base, m._source);
  }
  return base;
}

export class BootstrapMemories extends Resource {
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
      permanent: [],
      recent: [],
      predicted: [],
      relationships: [],
      relevant: [],
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

    // --- 2. Permanent memories (always included, highest priority) ---
    const allMemories: any[] = [];
    for await (const record of (databases as any).flair.Memory.search()) {
      if (record.agentId !== agentId) continue;
      if (record.expiresAt && Date.parse(record.expiresAt) < Date.now()) continue;
      allMemories.push(record);
    }
    memoriesAvailable = allMemories.length;

    // Build superseded set: exclude memories that have been replaced by newer ones
    const supersededIds = new Set<string>();
    for (const m of allMemories) {
      if (m.supersedes) supersededIds.add(m.supersedes);
    }
    const activeMemories = allMemories.filter((m) => !supersededIds.has(m.id));

    const permanent = activeMemories.filter((m) => m.durability === "permanent");
    for (const m of permanent) {
      const line = formatMemory(m);
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
    const nonPermanent = activeMemories
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
    const recentTotal = recent.length;
    for (const m of recent) {
      const line = formatMemory(m);
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

      const subjectMemories = activeMemories
        .filter((m: any) =>
          !includedIds.has(m.id) &&
          m.subject &&
          predictedSubjects.includes(m.subject.toLowerCase()) &&
          m.durability !== "permanent" // already loaded
        )
        .sort((a: any, b: any) => (b.createdAt || "").localeCompare(a.createdAt || ""));

      const predictedBudget = Math.floor(tokenBudget * 0.3);
      let predictedSpent = 0;
      const predictedTotal = subjectMemories.length;
      for (const m of subjectMemories) {
        const line = formatMemory(m);
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

        for (const { memory: m } of scored) {
          const line = formatMemory(m);
          const cost = estimateTokens(line);
          if (cost > tokenBudget) continue;
          sections.relevant.push(line);
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
        permanent: sections.permanent.length,
        recent: sections.recent.length,
        predicted: sections.predicted.length,
        relationships: sections.relationships.length,
        relevant: sections.relevant.length,
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
