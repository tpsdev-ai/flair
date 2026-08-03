import { Resource, databases } from "harper";
import { allowVerified, resolveAgentAuth } from "./agent-auth.js";
import { computeContentHash, findExistingMemoryByContentHash } from "./memory-feed-lib.js";
import { FORBIDDEN, UNAUTH, stampAttribution } from "./record-type-kit.js";

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

    // No-forge attribution: use the kit's stampAttribution to stamp agentId
    // from the authenticated principal, never from the body.
    //
    // Mode choice: stamp-strict (reject 403 on mismatch) over stamp-default
    // (silent overwrite). This endpoint is the ingestion path — callers are MCP
    // clients and agent-side tool calls. The defect this fix addresses was
    // trusting a body-supplied identity; the correction is to always stamp from
    // the authenticated principal.
    //
    // Deciding point (adjudicated on PR #1071): a silent overwrite means a
    // buggy client never learns it is buggy — it keeps sending the wrong
    // agentId and keeps getting 200. A strict rejection surfaces the mismatch
    // so the caller can fix it. The concern about breaking callers that
    // harmlessly echo agentId back was checked: a full search of the repo and
    // workspace for FeedMemories and /FeedMemories returns only the resource
    // definition and its own tests — no SDK wrappers, no CLI commands, no
    // internal callers construct requests with a body-supplied agentId. A
    // caller echoing the correct agentId (matching the principal) passes
    // through stamp-strict unchanged; a caller echoing a wrong one is exactly
    // the bug this slice exists to prevent.
    const attr = stampAttribution(auth, content, 'agentId', 'stamp-strict', 'forbidden: cannot attribute a feed memory to another agent');
    if (attr.denied) return attr.denied;

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
