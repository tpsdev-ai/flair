import { Resource, databases } from "harper";
import { allowVerified, resolveAgentAuth } from "./agent-auth.js";
import { computeContentHash, findExistingMemoryByContentHash } from "./memory-feed-lib.js";
import { FORBIDDEN, UNAUTH } from "./record-type-kit.js";

export class FeedMemories extends Resource {
  // Self-authorize via the Ed25519 agent verify (the auth reshape removes the
  // gate's admin elevation).
  async allowCreate(): Promise<boolean> {
    return allowVerified((this as any).getContext?.());
  }

  async post(content: any) {
    const ctx = (this as any).getContext?.();
    const auth = await resolveAgentAuth(ctx);

    // Anonymous HTTP must NOT write.
    if (auth.kind === "anonymous") {
      return UNAUTH();
    }

    // No-forge attribution: stamp agentId from the authenticated principal,
    // never from the body. "stamp-default" — unconditional overwrite for
    // non-admin agents; admin defaults-if-absent.
    if (auth.kind === "agent" && !auth.isAdmin) {
      content.agentId = auth.agentId;
    } else if (auth.kind === "agent" && auth.isAdmin) {
      content.agentId ||= auth.agentId;
    }

    // Guard against body-supplied id targeting another agent's record.
    if (content?.id) {
      const existingRecord = await (databases as any).flair.Memory.get(content.id);
      if (existingRecord && existingRecord.agentId !== content.agentId) {
        return FORBIDDEN("forbidden: cannot write a feed memory owned by another agent");
      }
    }

    const agentId = content.agentId;
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
