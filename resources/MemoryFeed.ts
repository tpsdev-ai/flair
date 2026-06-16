import { Resource, databases } from "@harperfast/harper";
import { allowVerified } from "./agent-auth.js";
import { computeContentHash, findExistingMemoryByContentHash } from "./memory-feed-lib.js";

export class FeedMemories extends Resource {
  // Self-authorize via the Ed25519 agent verify (the auth reshape removes the
  // gate's admin elevation). NOTE: post() trusts content.agentId from the body —
  // closing that create-spoofing gap is tracked with the table-resource
  // create-ownership work (Memory.allowCreate), not in this auth-coverage pass.
  async allowCreate(): Promise<boolean> {
    return allowVerified((this as any).getContext?.());
  }

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

    const existing = await findExistingMemoryByContentHash((databases as any).flair.Memory.search(), agentId, contentHash);
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

    await (databases as any).flair.Memory.put(record);
    return record;
  }

  async *connect(target: any, incomingMessages: any) {
    const subscription = await (databases as any).flair.Memory.subscribe(target);

    if (!incomingMessages) {
      return subscription;
    }

    for await (const event of subscription) {
      yield event;
    }
  }
}
