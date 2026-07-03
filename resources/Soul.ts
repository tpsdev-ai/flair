import { databases } from "@harperfast/harper";
import { resolveAgentAuth, allowVerified } from "./agent-auth.js";

const FORBIDDEN = (msg: string) =>
  new Response(JSON.stringify({ error: msg }), { status: 403, headers: { "Content-Type": "application/json" } });
const UNAUTH = () =>
  new Response(JSON.stringify({ error: "authentication required" }), { status: 401, headers: { "Content-Type": "application/json" } });

/**
 * Deny anonymous; enforce per-agent write ownership for non-admin agents.
 * The previous header-based check only fired when an agent WAS present (it read
 * x-tps-agent), so an anonymous request — which carries no x-tps-agent — slipped
 * through. With the non-rejecting gate, each write path self-enforces (resolveAgentAuth
 * distinguishes internal/agent/anonymous). Mirrors the WorkspaceState pattern.
 */
async function enforceWriteAuth(self: any, data: any): Promise<Response | null> {
  const auth = await resolveAgentAuth((self as any).getContext?.());
  if (auth.kind === "anonymous") return UNAUTH();
  if (auth.kind === "agent" && !auth.isAdmin && data?.agentId && data.agentId !== auth.agentId) {
    return FORBIDDEN("forbidden: agentId must match authenticated agent");
  }
  return null;
}

export class Soul extends (databases as any).flair.Soul {
  /**
   * Self-authorize now that the global gate is non-rejecting. Closes the P0
   * leak: Harper routes `GET /Soul/<id>` to get() and the collection
   * describe (`GET /Soul`) to a path outside search()/allow* — neither was
   * gated before this fix, so an anonymous caller got a 200 with full soul
   * content. Deliberately NO get() override / per-agent scoping on top of
   * this: souls are identity/discovery data, intentionally readable by any
   * verified agent — same posture as Agent.ts's allowRead. Write ownership
   * is unaffected — enforceWriteAuth() below already gates post()/put().
   */
  allowRead() { return allowVerified((this as any).getContext?.()); }

  async post(content: any, context?: any) {
    const denied = await enforceWriteAuth(this, content);
    if (denied) return denied;
    content.durability ||= "permanent";
    content.createdAt = new Date().toISOString();
    content.updatedAt = content.createdAt;
    return super.post(content, context);
  }

  async put(content: any, context?: any) {
    const denied = await enforceWriteAuth(this, content);
    if (denied) return denied;
    content.updatedAt = new Date().toISOString();
    return super.put(content, context);
  }
}
