import { expect } from "bun:test";

const collections = new Set([
  "Agent", "Asset", "Credential", "Instance", "InstructionVersion", "Integration", "Memory",
  "MemoryCandidate", "MemoryGrant", "MemoryUsage", "Message", "OrgEvent",
  "OrgSkillAssignment", "Relationship", "Soul", "WorkspaceState",
]);

export function tpsRoutePath(method: string, path: string): string {
  return method === "GET" && collections.has(path.slice(1)) ? `${path}/` : path;
}

export function assertTpsRouteOutcome(method: string, path: string, status: number, text: string, agentId: string): void {
  const name = path.slice(1);
  const json = () => JSON.parse(text);
  if (method === "POST") {
    switch (name) {
      case "FederationPair":
      case "FederationSync":
        expect(status).toBe(400);
        expect(json()).toEqual({ error: name === "FederationPair" ? "instanceId and publicKey required" : "instanceId and records[] required" });
        return;
      case "OAuthAuthorize":
        expect(status).toBe(302);
        expect(text).toBe("");
        return;
      case "Presence":
        expect(status).toBe(200);
        expect(json()).toMatchObject({ ok: true, agentId, presenceStatus: "active" });
        return;
      case "A2AAdapter":
      case "a2a":
        expect(status).toBe(200);
        expect(json()).toEqual({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } });
        return;
      default: throw new Error(`Unspecified POST outcome: ${path}`);
    }
  }
  if (collections.has(name) || ["Presence", "MessageInbox", "MessageDeadLetter"].includes(name)) {
    expect(status).toBe(200);
    expect(Array.isArray(json())).toBe(true);
    return;
  }
  if (["AgentCard", "AgentReadPosition", "MCPClientMetadata", "WorkspaceLatest", "OrgEventCatchup"].includes(name)) {
    const field = name === "OrgEventCatchup" ? "participantId" : "agentId";
    expect(status).toBe(400);
    expect(json()).toEqual({ error: `${field} required in path: GET ${path}/{${field}}` });
    return;
  }
  switch (name) {
    case "Health":
      expect([200, 503]).toContain(status);
      expect(json()).toMatchObject({ ok: status === 200 });
      return;
    case "HealthDetail":
      expect(status).toBe(200);
      expect(json()).toMatchObject({ ok: true });
      return;
    case "A2AAdapter":
    case "a2a":
      expect(status).toBe(200);
      expect(json()).toMatchObject({ capabilities: { streaming: true, pushNotifications: false } });
      return;
    case "OAuthAuthorize":
      expect(status).toBe(400);
      expect(json()).toEqual({ error: "unsupported_response_type" });
      return;
    case "OAuthMetadata":
      expect(status).toBe(200);
      expect(typeof json().issuer).toBe("string");
      expect(json().response_types_supported).toContain("code");
      return;
    case "health":
      expect(status).toBe(404);
      expect(text).toBe("Not found\n");
      return;
    case "MessageAck":
    case "FeedMemories":
    case "FeedSouls":
      expect(status).toBe(404);
      expect(text).toBe("");
      return;
    default:
      expect(status).toBe(403);
      expect(json()).toMatchObject({ code: "AccessViolation", title: "Unauthorized access to resource", status: 403 });
  }
}
