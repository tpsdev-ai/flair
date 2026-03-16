import { Resource, databases } from "@harperfast/harper";

type SoulLike = {
  key?: string;
  value?: string;
  kind?: string;
  content?: string;
};

function readSoulKind(entry: SoulLike): string {
  return String(entry.kind ?? entry.key ?? "").trim().toLowerCase();
}

function readSoulContent(entry: SoulLike): string {
  return String(entry.content ?? entry.value ?? "").trim();
}

export class AgentCard extends Resource {
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

    const descriptionEntry =
      souls.find((s) => readSoulKind(s) === "description" && readSoulContent(s)) ??
      souls.find((s) => readSoulContent(s));

    const skills = souls
      .filter((s) => readSoulKind(s) === "capability")
      .map((s) => readSoulContent(s))
      .filter(Boolean);

    return {
      name: String(agent.name ?? agent.id ?? agentId),
      description: descriptionEntry ? readSoulContent(descriptionEntry) : "",
      url: String(agent.url ?? ""),
      version: String(agent.version ?? "1.0.0"),
      capabilities: agent.capabilities && typeof agent.capabilities === "object" ? agent.capabilities : {},
      skills,
      defaultInputModes: ["text"],
      defaultOutputModes: ["text"],
    };
  }
}
