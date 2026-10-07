import { expect } from "bun:test";

const collections = new Set([
  "Agent", "Asset", "Credential", "Instance", "InstructionVersion", "Integration", "Memory",
  "MemoryCandidate", "MemoryGrant", "MemoryUsage", "Message", "OrgEvent",
  "OrgSkillAssignment", "Relationship", "Soul", "WorkspaceState",
]);

const healthReadinessStatuses = [200, 503] as const;

export const TPS_GET_ROUTE_STATUS: Record<string, number | readonly number[]> = {
  A2AAdapter: 200,
  Admin: 403,
  AdminConnectors: 403,
  AdminDashboard: 403,
  AdminIdp: 403,
  AdminInstance: 403,
  AdminMemory: 403,
  AdminPrincipals: 403,
  Agent: 200,
  AgentCard: 400,
  AgentReadPosition: 400,
  AgentSeed: 404,
  Asset: 200,
  AttentionQuery: 404,
  AutoPromoteCandidates: 404,
  BootstrapMemories: 404,
  ConsolidateMemories: 404,
  Credential: 404,
  FederationInstance: 403,
  FederationPair: 404,
  FederationPeers: 403,
  FederationSync: 404,
  FeedMemories: 404,
  FeedSouls: 404,
  Health: healthReadinessStatuses,
  HealthDetail: 200,
  IdpConfig: 403,
  Instance: 200,
  InstructionVersion: 200,
  Integration: 200,
  MCPClientMetadata: 400,
  Memory: 200,
  MemoryArchive: 404,
  MemoryCandidate: 200,
  MemoryDedupStats: 404,
  MemoryGrant: 200,
  MemoryHostSource: 403,
  MemoryMaintenance: 404,
  MemoryReindex: 404,
  MemoryUsage: 200,
  Message: 200,
  MessageAck: 404,
  MessageDeadLetter: 200,
  MessageInbox: 200,
  MessageSweep: 403,
  OAuthAuthorize: 400,
  OAuthClient: 403,
  OAuthMetadata: 200,
  OAuthRegister: 404,
  OAuthRevoke: 404,
  OAuthToken: 404,
  OrgEvent: 200,
  OrgEventCatchup: 400,
  OrgEventMaintenance: 404,
  OrgSkillAssignment: 200,
  PairingToken: 403,
  Peer: 403,
  Presence: 200,
  PromoteMemoryCandidate: 404,
  RecordUsage: 404,
  ReflectMemories: 404,
  Relationship: 200,
  SemanticSearch: 404,
  SkillScan: 404,
  Soul: 200,
  TeamDirectory: 200,
  WorkspaceLatest: 400,
  WorkspaceState: 200,
  a2a: 200,
  health: 404,
};

export function tpsRoutePath(method: string, path: string): string {
  return method === "GET" && collections.has(path.slice(1)) ? `${path}/` : path;
}

export function tpsRouteBody(path: string): string {
  return ["/A2AAdapter", "/a2a"].includes(path)
    ? JSON.stringify({ jsonrpc: "2.0", id: "tps-route", method: "tasks/list" })
    : "{}";
}

export function assertTpsRouteOutcome(method: string, path: string, status: number, text: string, agentId: string): void {
  const name = path.slice(1);
  const json = () => JSON.parse(text);
  if (status === 200) {
    const body = json();
    expect(body).not.toHaveProperty("error");
    if (Array.isArray(body)) for (const row of body) expect(row).not.toHaveProperty("error");
  }
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
        expect(json()).toMatchObject({ jsonrpc: "2.0", id: "tps-route", result: { type: "tasks" } });
        expect(Array.isArray(json().result.tasks)).toBe(true);
        return;
      default: throw new Error(`Unspecified POST outcome: ${path}`);
    }
  }
  if (method !== "GET" || !Object.hasOwn(TPS_GET_ROUTE_STATUS, name)) {
    throw new Error(`Unspecified outcome: ${method} ${path}`);
  }
  const expected = TPS_GET_ROUTE_STATUS[name];
  if (typeof expected === "number") expect(status).toBe(expected);
  else expect(expected).toContain(status);
  if (status === 404) {
    expect(text).toBe(name === "health" ? "Not found\n" : "");
    return;
  }
  if (status === 403) {
    expect(json()).toMatchObject({ code: "AccessViolation", title: "Unauthorized access to resource", status: 403 });
    return;
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
    case "TeamDirectory":
      expect(json()).toMatchObject({
        entries: expect.any(Array),
        nextCursor: null,
        hasMore: false,
        limit: 50,
        generatedAt: expect.any(String),
      });
      return;
    case "Health":
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
    default:
      throw new Error(`Unspecified GET body: ${path}`);
  }
}
