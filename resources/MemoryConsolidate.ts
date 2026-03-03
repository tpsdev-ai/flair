/**
 * POST /MemoryConsolidate
 *
 * Reviews an agent's persistent memories and returns candidates for
 * promotion (standard→persistent or persistent→permanent proposal) or
 * archival, based on retrieval count and age.
 *
 * Request:
 *   agentId   string   — which agent
 *   scope     string   — "persistent" | "standard" | "all" (default: "persistent")
 *   olderThan string?  — duration like "30d", "7d" (default: "30d")
 *   limit     number?  — max candidates (default: 20)
 *
 * Response:
 *   candidates  Array<{ memory, suggestion, reason }>
 *   prompt      string
 */

import { Resource, tables } from "harperdb";
import { isAdmin } from "./auth-middleware.js";

function parseDuration(s: string): number {
  const m = s.match(/^(\d+)([dhm])$/);
  if (!m) return 30 * 86400_000;
  const n = Number(m[1]);
  if (m[2] === "d") return n * 86400_000;
  if (m[2] === "h") return n * 3600_000;
  if (m[2] === "m") return n * 60_000;
  return 30 * 86400_000;
}

type Suggestion = "promote" | "archive" | "keep";

interface Candidate {
  memory: Record<string, unknown>;
  suggestion: Suggestion;
  reason: string;
}

function evaluate(record: any, now: number, olderThanMs: number): Candidate {
  const ageMs = record.createdAt ? now - new Date(record.createdAt).getTime() : 0;
  const count = record.retrievalCount ?? 0;
  const daysSinceRetrieved = record.lastRetrieved
    ? (now - new Date(record.lastRetrieved).getTime()) / 86400_000
    : Infinity;
  const { embedding, ...memory } = record;

  // Promote: high retrieval + persistent durability
  if (record.durability === "persistent" && count >= 5) {
    return { memory, suggestion: "promote", reason: `Retrieved ${count} times — strong promotion candidate for permanent` };
  }

  // Promote: standard → persistent if retrieved frequently
  if (record.durability === "standard" && count >= 3 && ageMs > 7 * 86400_000) {
    return { memory, suggestion: "promote", reason: `Retrieved ${count} times over ${Math.round(ageMs / 86400_000)} days — worth persisting` };
  }

  // Archive: old + never retrieved
  if (daysSinceRetrieved > 30 && count === 0 && ageMs > olderThanMs) {
    return { memory, suggestion: "archive", reason: `Never retrieved, ${Math.round(ageMs / 86400_000)} days old` };
  }

  // Archive: last retrieved > 60 days
  if (daysSinceRetrieved > 60 && count < 2) {
    return { memory, suggestion: "archive", reason: `Not retrieved in ${Math.round(daysSinceRetrieved)} days (only ${count} total retrievals)` };
  }

  return { memory, suggestion: "keep", reason: `Retrieved ${count} times, ${Math.round(daysSinceRetrieved)} days since last retrieval` };
}

export class ConsolidateMemories extends Resource {
  async post(data: any) {
    const { agentId, scope = "persistent", olderThan = "30d", limit = 20 } = data || {};

    if (!agentId) return new Response(JSON.stringify({ error: "agentId required" }), { status: 400 });

    const actorId = (this as any).request?.tpsAgent;
    if (actorId && actorId !== agentId && !(await isAdmin(actorId))) {
      return new Response(JSON.stringify({ error: "forbidden: can only consolidate own memories" }), { status: 403 });
    }

    const olderThanMs = parseDuration(olderThan);
    const now = Date.now();
    const candidates: Candidate[] = [];

    for await (const record of (tables as any).Memory.search()) {
      if (record.agentId !== agentId) continue;
      if (record.archived) continue;
      if (record.durability === "permanent") continue; // permanent can't be demoted

      if (scope === "persistent" && record.durability !== "persistent") continue;
      if (scope === "standard" && record.durability !== "standard") continue;

      const candidate = evaluate(record, now, olderThanMs);
      candidates.push(candidate);
      if (candidates.length >= limit * 3) break; // over-fetch to sort
    }

    // Sort: promote first, then archive, then keep
    const order: Record<Suggestion, number> = { promote: 0, archive: 1, keep: 2 };
    candidates.sort((a, b) => order[a.suggestion] - order[b.suggestion]);
    const top = candidates.slice(0, limit);

    const promoteCount = top.filter(c => c.suggestion === "promote").length;
    const archiveCount = top.filter(c => c.suggestion === "archive").length;

    const prompt = `# Memory Consolidation Review — ${agentId}
Scope: ${scope} | OlderThan: ${olderThan} | Candidates: ${top.length}

Summary: ${promoteCount} promote candidates, ${archiveCount} archive candidates.

For each candidate below:
- PROMOTE: Upgrade standard→persistent (self-approve) or propose persistent→permanent (needs human)
- ARCHIVE: Soft-delete (hidden from search, recoverable)
- KEEP: No action

Use: tps memory approve <id> | tps memory archive <id> | skip`;

    return { candidates: top, prompt };
  }
}
