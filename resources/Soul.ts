import { databases } from "@harperfast/harper";

function enforceAgentScope(self: any, data: any): Response | null {
  const authenticatedAgent: string | undefined = self.request?.headers?.get?.("x-tps-agent");
  const callerIsAdmin: boolean = self.request?.tpsAgentIsAdmin === true;
  if (authenticatedAgent && !callerIsAdmin && data?.agentId && data.agentId !== authenticatedAgent) {
    return new Response(JSON.stringify({
      error: "forbidden: agentId must match authenticated agent",
    }), { status: 403, headers: { "Content-Type": "application/json" } });
  }
  return null;
}

export class Soul extends (databases as any).flair.Soul {
  async post(content: any, context?: any) {
    const denied = enforceAgentScope(this, content);
    if (denied) return denied;
    content.durability ||= "permanent";
    content.createdAt = new Date().toISOString();
    content.updatedAt = content.createdAt;
    return super.post(content, context);
  }

  async put(content: any, context?: any) {
    const denied = enforceAgentScope(this, content);
    if (denied) return denied;
    content.updatedAt = new Date().toISOString();
    return super.put(content, context);
  }
}
