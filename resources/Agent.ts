import { databases } from "@harperfast/harper";
import { isAdmin, resolveAgentAuth, allowVerified, allowAdmin } from "./agent-auth.js";

/**
 * Agent resource — serves as the Principal table in 1.0.
 *
 * The Agent table is extended (not replaced) to serve as the Principal
 * model. The `kind` field distinguishes humans from agents. Pre-1.0
 * records without `kind` are treated as agents with default trust tier.
 *
 * Principal fields added in 1.0:
 *   - kind: "human" | "agent"
 *   - displayName: human-friendly label
 *   - status: "active" | "deactivated"
 *   - defaultTrustTier: "endorsed" | "corroborated" | "unverified"
 *   - admin: boolean
 *   - runtime: how to reach this principal
 *   - subjects: soul-level subject interests
 */
export class Agent extends (databases as any).flair.Agent {
  // Self-authorize now that the global gate is non-rejecting. Verified agents read
  // the principal table for discovery; an agent updates only its OWN record (put
  // handler enforces ownership). Creating/deleting principals is admin-only
  // (flair_agent grant: insert=false, delete=false). Anonymous denied throughout.
  allowRead()   { return allowVerified((this as any).getContext?.()); }
  allowCreate() { return allowAdmin((this as any).getContext?.()); }
  allowUpdate() { return allowVerified((this as any).getContext?.()); }
  allowDelete() { return allowAdmin((this as any).getContext?.()); }

  async post(content: any, context: any) {
    const now = new Date().toISOString();

    // Backward compat: set type for legacy code
    content.type ||= "agent";

    // 1.0 Principal defaults
    content.kind ||= "agent";
    content.status ||= "active";
    content.displayName ||= content.name;
    content.admin ??= false;

    // Trust tier defaults per kind
    if (!content.defaultTrustTier) {
      content.defaultTrustTier = content.admin ? "endorsed" : "unverified";
    }

    content.createdAt = now;
    content.updatedAt = now;

    return super.post(content, context);
  }

  async put(content: any) {
    const auth = await resolveAgentAuth((this as any).getContext?.());
    // Anonymous denied (defense-in-depth alongside allowUpdate; the old check read
    // tpsAgent and treated a missing agent as trusted, so anonymous slipped through).
    if (auth.kind === "anonymous") {
      return new Response(JSON.stringify({ error: "authentication required" }), {
        status: 401, headers: { "content-type": "application/json" },
      });
    }
    // Only admin principals can modify OTHER principals; an agent updates its own.
    if (auth.kind === "agent" && !auth.isAdmin) {
      const existing = await super.get();
      if (existing && existing.id !== auth.agentId) {
        return new Response(JSON.stringify({ error: "only admin principals can modify other principals" }), {
          status: 403, headers: { "content-type": "application/json" },
        });
      }
    }

    content.updatedAt = new Date().toISOString();

    // Protect immutable fields
    delete content.createdAt;
    delete content.publicKey; // key rotation goes through dedicated endpoint

    return super.put(content);
  }
}
