import { Resource, databases } from "@harperfast/harper";
import { type SoulLike, selectPublicDescription, selectPublicSkills } from "./agentcard-fields.js";

export class AgentCard extends Resource {
  // Public discovery metadata (per A2A spec, agent cards are intentionally
  // public). Self-gates as public so it survives the global gate's removal — and
  // its get() already returns only field-allowlisted public-safe data.
  allowRead(): boolean {
    return true;
  }

  async get(pathInfo?: any) {
    const agentId =
      (typeof pathInfo === "string" ? pathInfo : null) ??
      (this as any).getId?.() ??
      null;

    if (!agentId) {
      return new Response(
        JSON.stringify({ error: "agentId required in path: GET /AgentCard/{agentId}" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    const agent = await (databases as any).flair.Agent.get(agentId).catch(() => null);
    if (!agent) {
      return new Response(JSON.stringify({ error: "agent_not_found", agentId }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    const souls: SoulLike[] = [];
    for await (const row of (databases as any).flair.Soul.search()) {
      if (row?.agentId === agentId) souls.push(row);
    }

    return {
      name: String(agent.name ?? agent.id ?? agentId),
      // Only an explicit kind="description" soul publishes — no private-soul
      // fallback. See agentcard-fields.ts for the security rationale.
      description: selectPublicDescription(souls),
      url: String(agent.url ?? ""),
      version: String(agent.version ?? "1.0.0"),
      capabilities: agent.capabilities && typeof agent.capabilities === "object" ? agent.capabilities : {},
      skills: selectPublicSkills(souls),
      defaultInputModes: ["text"],
      defaultOutputModes: ["text"],
    };
  }
}
