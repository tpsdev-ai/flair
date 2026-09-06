import { Resource, databases } from "harper";
import { randomUUID } from "node:crypto";
import { resolveAgentAuth } from "./agent-auth.js";
import { Memory } from "./Memory.js";
import { MemoryCandidate } from "./MemoryCandidate.js";
import { stampMemoryPromotionIsolated } from "./promotion-stamp.js";
import { derivePromotedTags, derivePromotedVisibility, validateHumanReviewerId, type SourceMemoryFetch } from "../src/rem/promote-policy.js";

const error = (status: number, message: string) => new Response(JSON.stringify({ error: message }), {
  status, headers: { "content-type": "application/json" },
});

/** Human/agent review of a pending candidate. The request names the decision;
 * content, owner, lineage and the resulting verdict come from stored state. */
export class PromoteMemoryCandidate extends Resource {
  async allowCreate() {
    return (await resolveAgentAuth((this as any).getContext?.())).kind !== "anonymous";
  }

  async post(data: any) {
    const ctx = (this as any).getContext?.();
    const auth = await resolveAgentAuth(ctx);
    if (auth.kind === "anonymous") return error(401, "authentication required");
    if (typeof data?.candidateId !== "string" || !data.candidateId) return error(400, "candidateId required");
    if (typeof data.rationale !== "string" || !data.rationale.trim()) return error(400, "rationale required");
    const candidate = await (MemoryCandidate as any).get(data.candidateId, ctx);
    if (!candidate || candidate instanceof Response) return error(404, "candidate not found");
    if (auth.kind === "agent" && !auth.isAdmin && candidate.agentId !== auth.agentId) return error(403, "cannot promote another agent's candidate");
    if (candidate.status !== "pending") return error(409, "candidate is not pending");
    const actorId = auth.kind === "agent" ? auth.agentId : "admin";
    const reviewerId = data.reviewerId ?? actorId;
    if (typeof reviewerId !== "string" || !reviewerId.trim()) return error(400, "reviewerId required");
    if (auth.kind === "agent" && !auth.isAdmin && reviewerId !== actorId) return error(403, "cannot impersonate another reviewer");
    const reviewerError = validateHumanReviewerId(reviewerId);
    if (reviewerError) return error(400, reviewerError);

    const sourceFetches: SourceMemoryFetch[] = [];
    const scopeTag = typeof candidate.scopeTag === "string" && candidate.scopeTag ? candidate.scopeTag : undefined;
    if (!scopeTag) {
      for (const id of Array.isArray(candidate.sourceMemoryIds) ? candidate.sourceMemoryIds : []) {
        try {
          const memory = await (Memory as any).get(String(id), ctx);
          sourceFetches.push(memory && !(memory instanceof Response)
            ? { ok: true, tags: Array.isArray(memory.tags) ? memory.tags : [] } : { ok: false });
        } catch { sourceFetches.push({ ok: false }); }
      }
    }
    const tags = derivePromotedTags(candidate.id, sourceFetches, scopeTag);
    if (!tags.ok) return error(400, tags.reason);
    const visibility = derivePromotedVisibility(candidate);
    const decidedAt = new Date().toISOString();
    const memoryId = `${candidate.agentId}-promoted-${randomUUID()}`;
    const written = await (Memory as any).put({
      id: memoryId, agentId: candidate.agentId, content: candidate.claim, durability: "persistent",
      ...(visibility ? { visibility } : {}), tags: tags.tags,
      derivedFrom: candidate.sourceMemoryIds ?? [], createdAt: decidedAt,
    }, ctx);
    if (written instanceof Response && !written.ok) return written;
    await stampMemoryPromotionIsolated(memoryId, reviewerId, decidedAt);
    await (databases as any).flair.MemoryCandidate.put({
      ...candidate, status: "promoted", target: "memory", reviewerId,
      reviewRationale: data.rationale, decidedAt,
    });
    return { memoryId, candidateId: candidate.id, reviewerId, decidedAt };
  }
}
