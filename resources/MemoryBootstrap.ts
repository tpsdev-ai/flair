import { Resource, tables } from "harperdb";
import { getEmbedding } from "./embeddings-provider.js";

/**
 * POST /MemoryBootstrap
 *
 * One-call context builder for agent cold starts.
 * Returns prioritized, token-budgeted context with:
 *   1. Soul records (identity, role, preferences)
 *   2. Permanent memories (safety rules, core principles)
 *   3. Recent memories (last 24-48h standard/persistent)
 *   4. Task-relevant memories (semantic search if currentTask provided)
 *
 * Request:
 *   { agentId, currentTask?, maxTokens?, includeSoul?, since? }
 *
 * Response:
 *   { context, sections, tokenEstimate, memoriesIncluded, memoriesAvailable }
 */

// Rough token estimate: ~4 chars per token for English text
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function formatMemory(m: any): string {
  const tag = m.durability === "permanent" ? "🔒" : m.durability === "persistent" ? "📌" : "📝";
  const date = m.createdAt ? ` (${m.createdAt.slice(0, 10)})` : "";
  return `${tag} ${m.content}${date}`;
}

export class BootstrapMemories extends Resource {
  async post(data: any, _context?: any) {
    const {
      agentId,
      currentTask,
      maxTokens = 4000,
      includeSoul = true,
      since,
    } = data || {};

    if (!agentId) {
      return new Response(JSON.stringify({ error: "agentId required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const sections: Record<string, string[]> = {
      soul: [],
      permanent: [],
      recent: [],
      relevant: [],
      events: [],
    };
    let tokenBudget = maxTokens;
    let memoriesIncluded = 0;
    let memoriesAvailable = 0;

    // --- 1. Soul records (unconditional — not subject to token budget) ---
    // Soul is who you are. It's not optional context to be trimmed.
    if (includeSoul) {
      let soulTokens = 0;
      for await (const record of (tables as any).Soul.search()) {
        if (record.agentId !== agentId) continue;
        const line = `**${record.key}:** ${record.value}`;
        sections.soul.push(line);
        soulTokens += estimateTokens(line);
      }
      // Soul tokens are tracked but don't reduce memory budget
      tokenBudget = maxTokens; // memory budget is separate from soul
    }

    // --- 2. Permanent memories (always included, highest priority) ---
    const allMemories: any[] = [];
    for await (const record of (tables as any).Memory.search()) {
      if (record.agentId !== agentId) continue;
      if (record.expiresAt && Date.parse(record.expiresAt) < Date.now()) continue;
      allMemories.push(record);
    }
    memoriesAvailable = allMemories.length;

    const permanent = allMemories.filter((m) => m.durability === "permanent");
    for (const m of permanent) {
      const line = formatMemory(m);
      const cost = estimateTokens(line);
      if (cost <= tokenBudget) {
        sections.permanent.push(line);
        tokenBudget -= cost;
        memoriesIncluded++;
      }
    }

    // --- 3. Recent memories (last 24-48h, standard + persistent) ---
    const sinceDate = since
      ? new Date(since)
      : new Date(Date.now() - 48 * 3600_000);
    const recent = allMemories
      .filter(
        (m) =>
          m.durability !== "permanent" &&
          m.createdAt &&
          new Date(m.createdAt) >= sinceDate
      )
      .sort((a: any, b: any) => (b.createdAt || "").localeCompare(a.createdAt || ""));

    // Budget: up to 40% of remaining for recent
    const recentBudget = Math.floor(tokenBudget * 0.4);
    let recentSpent = 0;
    for (const m of recent) {
      const line = formatMemory(m);
      const cost = estimateTokens(line);
      if (recentSpent + cost > recentBudget) continue;
      sections.recent.push(line);
      recentSpent += cost;
      tokenBudget -= cost;
      memoriesIncluded++;
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
          .filter((m) => !includedIds.has(m.id) && m.embedding?.length > 100)
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

      for await (const event of (tables as any).OrgEvent.search()) {
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
    if (sections.permanent.length > 0) {
      parts.push("## Core Principles\n" + sections.permanent.join("\n"));
    }
    if (sections.recent.length > 0) {
      parts.push("## Recent Context\n" + sections.recent.join("\n"));
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
        permanent: sections.permanent.length,
        recent: sections.recent.length,
        relevant: sections.relevant.length,
        events: sections.events.length,
      },
      tokenEstimate: soulTokens + memoryTokens,
      soulTokens,
      memoryTokens,
      memoriesIncluded,
      memoriesAvailable,
    };
  }
}
