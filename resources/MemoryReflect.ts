/**
 * POST /MemoryReflect
 *
 * Gathers recent memories for an agent and returns a structured reflection
 * prompt. The agent feeds the prompt + memories to its LLM and writes
 * insights back as persistent memories (with derivedFrom linking).
 *
 * Request:
 *   agentId      string   — which agent to reflect on
 *   scope        string   — "recent" | "tagged" | "all" (default: "recent")
 *   since        string?  — ISO timestamp lower bound (default: 24h ago)
 *   maxMemories  number?  — cap (default: 50)
 *   focus        string?  — "lessons_learned" | "patterns" | "decisions" | "errors" (default: "lessons_learned")
 *   tag          string?  — required when scope="tagged"
 *
 * Response:
 *   memories       Memory[]   — source memories included in the prompt
 *   prompt         string     — structured LLM prompt
 *   suggestedTags  string[]   — tags Flair detected in the source set
 *   count          number     — number of memories included
 */

import { Resource, databases } from "@harperfast/harper";
import { isAdmin } from "./auth-middleware.js";
import { patchRecordSilent } from "./table-helpers.js";

const FOCUS_PROMPTS: Record<string, string> = {
  lessons_learned:
    "Review these memories and identify concrete lessons learned. For each lesson: what happened, what you learned, and how it should change future behavior. Write atomic memories with durability=persistent.",
  patterns:
    "Identify recurring patterns across these memories. What themes, approaches, or outcomes appear multiple times? Extract each pattern as a persistent memory.",
  decisions:
    "Catalog the key decisions made and their outcomes. For each: what was decided, why, and what resulted. Promote important decisions to persistent.",
  errors:
    "Extract errors, bugs, and failures. For each: what failed, root cause, and fix applied. These are high-value persistent memories.",
};

export class ReflectMemories extends Resource {
  async post(data: any) {
    const {
      agentId: bodyAgentId,
      scope = "recent",
      since,
      maxMemories = 50,
      focus = "lessons_learned",
      tag,
    } = data || {};

    // Authenticated identity comes from getContext().request, not this.request
    // (see SemanticSearch / MemoryBootstrap for the same bug class). The prior
    // check was silently bypassed — bob could reflect on alice's memories and
    // mutate alice's records via the lastReflected patchRecordSilent below.
    const ctx = (this as any).getContext?.();
    const request = ctx?.request ?? ctx;
    const actorId: string | undefined = request?.tpsAgent;
    const callerIsAdmin: boolean = request?.tpsAgentIsAdmin === true
      || (actorId ? await isAdmin(actorId) : false);

    if (!bodyAgentId && !actorId) {
      return new Response(JSON.stringify({ error: "agentId required" }), { status: 400 });
    }
    if (actorId && !callerIsAdmin && bodyAgentId && bodyAgentId !== actorId) {
      return new Response(JSON.stringify({ error: "forbidden: can only reflect on own memories" }), { status: 403 });
    }
    const agentId: string = (actorId && !callerIsAdmin) ? actorId : bodyAgentId;

    const sinceDate = since ? new Date(since) : new Date(Date.now() - 24 * 3600_000);
    const memories: any[] = [];

    for await (const record of (databases as any).flair.Memory.search()) {
      if (record.agentId !== agentId) continue;
      if (record.archived) continue;
      if (record.durability === "permanent") continue; // permanent memories don't need reflection

      if (scope === "tagged") {
        if (!tag || !(record.tags ?? []).includes(tag)) continue;
      } else if (scope === "recent") {
        if (!record.createdAt || new Date(record.createdAt) < sinceDate) continue;
      }
      // scope="all" passes everything

      const { embedding, ...rest } = record;
      memories.push(rest);
      if (memories.length >= maxMemories) break;
    }

    memories.sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));

    // Collect tags present in source memories
    const tagSet = new Set<string>();
    for (const m of memories) {
      for (const t of m.tags ?? []) tagSet.add(t);
    }

    // Build prompt
    const focusText = FOCUS_PROMPTS[focus] ?? FOCUS_PROMPTS.lessons_learned;
    const memorySummary = memories
      .map((m, i) => `[${i + 1}] (${m.id}) ${m.createdAt?.slice(0, 10) ?? "?"}: ${m.content.slice(0, 300)}`)
      .join("\n");

    const prompt = `# Memory Reflection — ${agentId}
Focus: ${focus}
Scope: ${scope} (since ${sinceDate.toISOString()})
Memories: ${memories.length}

## Task
${focusText}

## Source Memories
${memorySummary || "(none)"}

## Instructions
For each insight:
1. Write a new memory with durability=persistent
2. Set derivedFrom=[<source memory ids>]
3. Set tags from the source memories where relevant
4. Keep each memory atomic — one insight per record`;

    // Update lastReflected on source memories (read-modify-write to preserve embeddings)
    const now = new Date().toISOString();
    for (const m of memories) {
      patchRecordSilent((databases as any).flair.Memory, m.id, { lastReflected: now });
    }

    return {
      memories,
      prompt,
      suggestedTags: [...tagSet].slice(0, 20),
      count: memories.length,
    };
  }
}
