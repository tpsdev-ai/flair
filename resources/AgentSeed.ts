/**
 * POST /AgentSeed
 *
 * Auto-seeds a new agent with soul entries and starter memories.
 * Called by `tps agent create` after local key generation.
 *
 * Request:
 *   agentId          string   — agent identifier
 *   displayName      string?  — human-readable name (defaults to agentId)
 *   role             string?  — "admin" | "agent" (default: "agent")
 *   soulTemplate     object?  — key:value pairs for Soul table (merged with defaults)
 *   starterMemories  array?   — [{content, tags?, durability?}] (defaults if omitted)
 *
 * Response:
 *   { agent, soulEntries, memories }
 *
 * Auth: admin only.
 */

import { Resource, tables } from "harperdb";
import { isAdmin } from "./auth-middleware.js";

const DEFAULT_SOUL_KEYS = (agentId: string, displayName: string, role: string, now: string) => ({
  name: displayName,
  role,
  created: now,
  status: "active",
});

const DEFAULT_MEMORIES = (agentId: string, now: string) => [
  {
    content: `Agent ${agentId} initialized. No prior context.`,
    tags: ["onboarding", "system"],
    durability: "persistent",
  },
];

export class AgentSeed extends Resource {
  async post(data: any) {
    const actorId = (this as any).request?.tpsAgent;
    if (!actorId || !(await isAdmin(actorId))) {
      return new Response(JSON.stringify({ error: "forbidden: admin only" }), { status: 403 });
    }

    const { agentId, displayName, role = "agent", soulTemplate, starterMemories } = data || {};
    if (!agentId) return new Response(JSON.stringify({ error: "agentId required" }), { status: 400 });
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(agentId)) {
      return new Response(JSON.stringify({ error: "invalid agentId" }), { status: 400 });
    }

    const now = new Date().toISOString();
    const name = displayName || agentId;

    // ── Agent record ──────────────────────────────────────────────────────────
    const existingAgent = await (tables as any).Agent.get(agentId).catch(() => null);
    let agent = existingAgent;
    if (!existingAgent) {
      agent = { id: agentId, name, role, publicKey: "pending", createdAt: now, updatedAt: now };
      await (tables as any).Agent.put(agent);
    }

    // ── Soul entries ──────────────────────────────────────────────────────────
    const defaults = DEFAULT_SOUL_KEYS(agentId, name, role, now);
    const merged = { ...defaults, ...(soulTemplate || {}) };
    const soulEntries: any[] = [];

    for (const [key, value] of Object.entries(merged)) {
      const id = `${agentId}:${key}`;
      const existing = await (tables as any).Soul.get(id);
      if (existing) {
        soulEntries.push(existing); // skip — don't overwrite existing soul entries
        continue;
      }
      const entry = { id, agentId, key, value: String(value), durability: "permanent", createdAt: now, updatedAt: now };
      await (tables as any).Soul.put(entry);
      soulEntries.push(entry);
    }

    // ── Starter memories ──────────────────────────────────────────────────────
    const memDefs = starterMemories && starterMemories.length > 0
      ? starterMemories
      : DEFAULT_MEMORIES(agentId, now);

    const memories: any[] = [];
    for (let i = 0; i < memDefs.length; i++) {
      const def = memDefs[i];
      const id = `seed-${agentId}-${i}-${Date.now()}`;
      const record = {
        id,
        agentId,
        content: def.content,
        durability: def.durability ?? "persistent",
        tags: def.tags ?? ["onboarding"],
        source: "seed",
        createdAt: now,
        updatedAt: now,
        archived: false,
      };
      await (tables as any).Memory.put(record);
      memories.push(record);
    }

    return { agent, soulEntries, memories };
  }
}
