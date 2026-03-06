import { Resource, tables } from "harperdb";
import { computeContentHash, findExistingMemoryByContentHash } from "./memory-feed-lib.js";

export class FeedMemories extends Resource {
  async post(content: any) {
    const agentId = String(content?.agentId ?? "");
    const body = String(content?.content ?? "");
    if (!agentId || !body) {
      return new Response(JSON.stringify({ error: "agentId and content are required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const now = new Date().toISOString();
    const contentHash = computeContentHash(agentId, body);

    const existing = await findExistingMemoryByContentHash((tables as any).Memory.search(), agentId, contentHash);
    if (existing) return existing;

    const record = {
      ...content,
      id: content.id ?? `${agentId}-${Date.now()}`,
      agentId,
      content: body,
      contentHash,
      durability: content.durability ?? "standard",
      createdAt: content.createdAt ?? now,
      updatedAt: content.updatedAt ?? now,
      archived: content.archived ?? false,
    };

    await (tables as any).Memory.put(record);
    return record;
  }

  async *connect(target: any, incomingMessages: any) {
    const subscription = await (tables as any).Memory.subscribe(target);

    if (!incomingMessages) {
      return subscription;
    }

    for await (const event of subscription) {
      yield event;
    }
  }
}
