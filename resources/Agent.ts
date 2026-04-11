import { databases } from "@harperfast/harper";
import { isAdmin } from "./auth-middleware.js";

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
    const ctx = (this as any).getContext?.();
    const request = ctx?.request ?? ctx;
    const authAgent: string | undefined = request?.tpsAgent;
    const isAdminAgent: boolean = request?.tpsAgentIsAdmin ?? false;

    // Only admin principals can modify other principals
    if (authAgent && !isAdminAgent) {
      const existing = await super.get();
      if (existing && existing.id !== authAgent) {
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
