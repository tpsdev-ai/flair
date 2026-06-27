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

import { Resource, databases } from "@harperfast/harper";
import { isAdmin, allowVerified } from "./agent-auth.js";
import { evaluate, parseDuration, type Suggestion, type Candidate } from "./memory-consolidate-lib.js";
import { MCP_HIDDEN } from "./mcp-curation.js";

export class ConsolidateMemories extends Resource {
  // Suppress from the native MCP application profile (only FlairMcp is exposed). See mcp-curation.ts.
  static hidden = MCP_HIDDEN;
  // Self-authorize via the Ed25519 agent verify (auth reshape removes the gate's
  // admin elevation). Any verified agent may consolidate; the isAdmin checks in
  // post() handle finer-grained authorization.
  async allowCreate(): Promise<boolean> {
    return allowVerified((this as any).getContext?.());
  }

  async post(data: any) {
    const { agentId: bodyAgentId, scope = "persistent", olderThan = "30d", limit = 20 } = data || {};

    // See SemanticSearch / MemoryBootstrap — `this.request` isn't populated on
    // Harper v5 Resources, so the prior actorId check was silently bypassed
    // and bob could enumerate alice's consolidation candidates (her memory records).
    const ctx = (this as any).getContext?.();
    const request = ctx?.request ?? ctx;
    const actorId: string | undefined = request?.tpsAgent;
    const callerIsAdmin: boolean = request?.tpsAgentIsAdmin === true
      || (actorId ? await isAdmin(actorId) : false);

    if (!bodyAgentId && !actorId) {
      return new Response(JSON.stringify({ error: "agentId required" }), { status: 400 });
    }
    if (actorId && !callerIsAdmin && bodyAgentId && bodyAgentId !== actorId) {
      return new Response(JSON.stringify({ error: "forbidden: can only consolidate own memories" }), { status: 403 });
    }
    const agentId: string = (actorId && !callerIsAdmin) ? actorId : bodyAgentId;

    const olderThanMs = parseDuration(olderThan);
    const now = Date.now();
    const candidates: Candidate[] = [];

    for await (const record of (databases as any).flair.Memory.search()) {
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
