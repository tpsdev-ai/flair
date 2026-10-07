import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { assertTpsRouteOutcome, TPS_GET_ROUTE_STATUS, tpsRouteBody } from "../helpers/tps-ed25519-outcomes.ts";
import { TPS_ED25519_ROUTES } from "../helpers/tps-ed25519-routes.ts";

const source = readFileSync(new URL("../integration/auth-middleware-e2e.test.ts", import.meta.url), "utf8");
const start = source.indexOf("      const valid = await send(false);");
const end = source.indexOf("    }, 30_000);", start);
const check = new Function("expect", "send", "method", "path", "agent", "assertTpsRouteOutcome",
  `return (async () => { ${source.slice(start, end)} })();`);

const getOutcomes: Array<[string, number | readonly number[], string]> = [
  ["A2AAdapter", 200, "resources/A2AAdapter.ts:310: allowRead true; get:313 discovery; no search"],
  ["Admin", 403, "resources/Admin.ts:20: allowRead allowAdmin refuses before get:24; no search"],
  ["AdminConnectors", 403, "resources/AdminConnectors.ts:11: allowRead allowAdmin refuses before get:15; no search"],
  ["AdminDashboard", 403, "resources/AdminDashboard.ts:14: allowRead allowAdmin refuses before get:18; no search"],
  ["AdminIdp", 403, "resources/AdminIdp.ts:11: allowRead allowAdmin refuses before get:15; no search"],
  ["AdminInstance", 403, "resources/AdminInstance.ts:101: allowRead allowAdmin refuses before get:105; no search"],
  ["AdminMemory", 403, "resources/AdminMemory.ts:31: allowRead allowAdmin refuses before get:35; no search"],
  ["AdminPrincipals", 403, "resources/AdminPrincipals.ts:12: allowRead allowAdmin refuses before get:16; no search"],
  ["Agent", 200, "resources/Agent.ts:28: allowRead allowVerified; inherited table get/search serve collection"],
  ["AgentCard", 400, "resources/AgentCard.ts:8: allowRead true; get:12 requires path agentId; no search"],
  ["AgentReadPosition", 400, "resources/AgentReadPosition.ts:48: allowRead allowVerified; get:56 requires path agentId; no search"],
  ["AgentSeed", 404, "resources/AgentSeed.ts:48: no get/search/allowRead override"],
  ["Asset", 200, "resources/Asset.ts:59: verified read gate; get:61 delegates collection to scoped search:68"],
  ["AttentionQuery", 404, "resources/AttentionQuery.ts:403: no get/search/allowRead override"],
  ["AutoPromoteCandidates", 404, "resources/AutoPromoteCandidates.ts:59: no get/search/allowRead override"],
  ["BootstrapMemories", 404, "resources/MemoryBootstrap.ts:316: no get/search/allowRead override"],
  ["ConsolidateMemories", 404, "resources/MemoryConsolidate.ts:24: no get/search/allowRead override"],
  ["Credential", 404, "resources/Credential.ts:31: allowRead allowVerified; get:103 drops target in super.get(); search:82 unused"],
  ["FederationInstance", 403, "resources/Federation.ts:262: allowRead allowAdmin refuses before get:266; no search"],
  ["FederationPair", 404, "resources/Federation.ts:459: no get/search/allowRead override"],
  ["FederationPeers", 403, "resources/Federation.ts:1024: allowRead allowAdmin refuses before get:1028; no search"],
  ["FederationSync", 404, "resources/Federation.ts:666: no get/search/allowRead override"],
  ["FeedMemories", 404, "resources/MemoryFeed.ts:304: allowRead allowVerified; no get/search"],
  ["FeedSouls", 404, "resources/SoulFeed.ts:8: allowRead allowVerified; no get/search"],
  ["Health", [200, 503], "resources/health.ts:101: allowRead true; get:104 selects readiness status (multi-worker:129); no search"],
  ["HealthDetail", 200, "resources/health.ts:188: allowRead allowVerified; get:192 returns ok true; no search"],
  ["IdpConfig", 403, "resources/XAA.ts:352: allowRead allowAdmin refuses; inherited table get/search"],
  ["Instance", 200, "resources/Instance.ts:10: allowRead allowVerified; inherited table get/search serve collection"],
  ["InstructionVersion", 200, "resources/InstructionVersion.ts:102: verified read gate; get:112 delegates collection to filtered search:121"],
  ["Integration", 200, "resources/Integration.ts:40: allowRead allowVerified; get:49 by-id gate delegates collection to scoped search:53"],
  ["MCPClientMetadata", 400, "resources/MCPClientMetadata.ts:43: allowRead true; get:47 requires path agentId; no search"],
  ["Memory", 200, "resources/Memory.ts:935: verified read gate; get:946 delegates collection to scoped search:1030"],
  ["MemoryArchive", 404, "resources/MemoryArchive.ts:50: no get/search/allowRead override"],
  ["MemoryCandidate", 200, "resources/MemoryCandidate.ts:78: verified read gate; get:89 delegates collection to scoped search:106"],
  ["MemoryDedupStats", 404, "resources/MemoryDedupStats.ts:183: no get/search/allowRead override"],
  ["MemoryGrant", 200, "resources/MemoryGrant.ts:57: allowRead allowVerified; get:67 by-id gate delegates collection to scoped search:71"],
  ["MemoryHostSource", 403, "resources/MemoryHostSource.ts:42: admin read gate refuses before get:48/scoped search:60"],
  ["MemoryMaintenance", 404, "resources/MemoryMaintenance.ts:41: no get/search/allowRead override"],
  ["MemoryReindex", 404, "resources/MemoryReindex.ts:46: no get/search/allowRead override"],
  ["MemoryUsage", 200, "resources/MemoryUsage.ts:91: allowRead allowVerified; get:93 delegates collection to filtered search:114"],
  ["Message", 200, "resources/Message.ts:74: verified read gate; get:105 delegates collection to scoped search:95"],
  ["MessageAck", 404, "resources/Message.ts:170: allowRead permits verified agents; no get/search"],
  ["MessageDeadLetter", 200, "resources/Message.ts:191: allowRead permits verified agents; get:195 returns caller dead letters; no search"],
  ["MessageInbox", 200, "resources/Message.ts:157: allowRead permits verified agents; get:161 returns caller inbox; no search"],
  ["MessageSweep", 403, "resources/Message.ts:204: allowRead refuses non-admin; no get/search"],
  ["OAuthAuthorize", 400, "resources/OAuth.ts:245: allowRead true; get:248 rejects missing response_type; no search"],
  ["OAuthClient", 403, "resources/OAuthClient.ts:12: allowRead allowAdmin refuses; inherited table get/search"],
  ["OAuthMetadata", 200, "resources/OAuth.ts:156: allowRead true; get:158 returns discovery metadata; no search"],
  ["OAuthRegister", 404, "resources/OAuth.ts:165: no get/search/allowRead override"],
  ["OAuthRevoke", 404, "resources/OAuth.ts:665: no get/search/allowRead override"],
  ["OAuthToken", 404, "resources/OAuth.ts:459: no get/search/allowRead override"],
  ["OrgEvent", 200, "resources/OrgEvent.ts:33: verified read gate; inherited table get/search serve collection"],
  ["OrgEventCatchup", 400, "resources/OrgEventCatchup.ts:120: allowRead allowVerified; get:129 requires path participantId; no search"],
  ["OrgEventMaintenance", 404, "resources/OrgEventMaintenance.ts:11: no get/search/allowRead override"],
  ["OrgSkillAssignment", 200, "resources/OrgSkillAssignment.ts:139: verified read gate; inherited table get/search serve collection"],
  ["PairingToken", 403, "resources/PairingToken.ts:11: allowRead allowAdmin refuses; inherited table get/search"],
  ["Peer", 403, "resources/Peer.ts:12: allowRead allowAdmin refuses; inherited table get/search"],
  ["Presence", 200, "resources/Presence.ts:354: allowRead true; get:401 verifies reader and returns roster; inherited search unused"],
  ["PromoteMemoryCandidate", 404, "resources/PromoteMemoryCandidate.ts:15: no get/search/allowRead override"],
  ["RecordUsage", 404, "resources/RecordUsage.ts:151: no get/search/allowRead override"],
  ["ReflectMemories", 404, "resources/MemoryReflect.ts:88: no get/search/allowRead override"],
  ["Relationship", 200, "resources/Relationship.ts:58: verified read gate; get:68 delegates collection to scoped search:82"],
  ["SemanticSearch", 404, "resources/SemanticSearch.ts:32: no get/search/allowRead override"],
  ["SkillScan", 404, "resources/SkillScan.ts:37: no get/search/allowRead override"],
  ["Soul", 200, "resources/Soul.ts:69: verified read gate; inherited table get/search serve collection"],
  ["TeamDirectory", 200, "resources/TeamDirectory.ts:17: verified read gate; get:21 calls resolver; resources/team-directory.ts:141: verified active reader; :99: absent kind/status retain agent/active; :276: returns page"],
  ["WorkspaceLatest", 400, "resources/WorkspaceLatest.ts:15: allowRead allowVerified; get:19 requires path agentId; no search"],
  ["WorkspaceState", 200, "resources/WorkspaceState.ts:59: verified read gate; get:70 delegates collection to scoped search:90"],
  ["a2a", 200, "resources/A2AAdapter.ts:581: inherits A2AAdapter get:313/allowRead:310; no search"],
  ["health", 404, "resources/health.ts:99: exported route is Health; lowercase has no resource handler"],
];

const harperDispatch = {
  noGet: "harper/resources/Resource.ts:113: static get calls optional instance get; harper/server/REST.ts:352: undefined GET becomes empty 404",
  defaultRead: "harper/resources/Resource.ts:528: default allowRead requires super_user; resources/auth-middleware.ts:499: absent flair-agent user falls back to admin; test/helpers/harper-lifecycle.ts:929: fixture uses Harper install",
  collection: "harper/resources/Table.ts:3181: collection target invokes static search; harper/resources/Resource.ts:943: allowRead refusal throws AccessViolation",
  no405: "harper/server/REST.ts:311: inherited static Resource.get exists, so missingMethod is not called",
};

function getBody(name: string, status: number): string {
  if (name === "TeamDirectory" && status === 200) return JSON.stringify({ entries: [], nextCursor: null, hasMore: false, limit: 50, generatedAt: new Date().toISOString() });
  if (status === 404) return name === "health" ? "Not found\n" : "";
  if (status === 403) return JSON.stringify({ code: "AccessViolation", title: "Unauthorized access to resource", status });
  if (status === 503 || name === "Health" || name === "HealthDetail") return JSON.stringify({ ok: status === 200 });
  if (status === 400) return JSON.stringify({ error: name === "OAuthAuthorize" ? "unsupported_response_type" : `${name === "OrgEventCatchup" ? "participantId" : "agentId"} required in path: GET /${name}/{${name === "OrgEventCatchup" ? "participantId" : "agentId"}}` });
  if (name === "OAuthMetadata") return JSON.stringify({ issuer: "https://example.test", response_types_supported: ["code"] });
  if (name === "A2AAdapter" || name === "a2a") return JSON.stringify({ capabilities: { streaming: true, pushNotifications: false } });
  return "[]";
}

test("GET outcome table covers the route inventory", () => {
  const names = TPS_ED25519_ROUTES.filter(route => route.method === "GET").map(route => route.path.slice(1)).sort();
  expect(getOutcomes.map(([name]) => name).sort()).toEqual(names);
  expect(Object.keys(TPS_GET_ROUTE_STATUS).sort()).toEqual(names);
});

for (const [name, statuses, evidence] of getOutcomes) {
  const allowed = typeof statuses === "number" ? [statuses] : statuses;
  for (const status of allowed) {
    test(`GET /${name}: accepts ${status}`, () => {
      expect(TPS_GET_ROUTE_STATUS[name], [evidence, ...Object.values(harperDispatch)].join("; ")).toEqual(statuses);
      assertTpsRouteOutcome("GET", `/${name}`, status, getBody(name, status), "test-agent");
    });
  }
  for (const status of [200, 400, 403, 404, 405, 503].filter(value => !allowed.includes(value))) {
    test(`GET /${name}: rejects ${status}`, () => {
      expect(() => assertTpsRouteOutcome("GET", `/${name}`, status, getBody(name, status), "test-agent")).toThrow();
    });
  }
}

const postOutcomes: Array<[string, number, string]> = [
  ["FederationPair", 400, '{"error":"instanceId and publicKey required"}'],
  ["FederationSync", 400, '{"error":"instanceId and records[] required"}'],
  ["OAuthAuthorize", 302, ""],
  ["Presence", 200, '{"ok":true,"agentId":"test-agent","presenceStatus":"active"}'],
  ...["A2AAdapter", "a2a"].map(name => [name, 200, '{"jsonrpc":"2.0","id":"tps-route","result":{"type":"tasks","tasks":[]}}'] as [string, number, string]),
];

for (const [name, status, body] of postOutcomes) {
  test(`POST /${name}: accepts ${status}`, () => {
    assertTpsRouteOutcome("POST", `/${name}`, status, body, "test-agent");
  });
}

for (const [method, name, body] of [
  ...getOutcomes.filter(([, statuses]) => statuses === 200 || Array.isArray(statuses) && statuses.includes(200)).map(([name]) => ["GET", name, getBody(name, 200)]),
  ...postOutcomes.filter(([, status]) => status === 200).map(([name, , body]) => ["POST", name, body]),
]) {
  test(`${method} /${name}: rejects an error body with status 200`, () => {
    const parsed = JSON.parse(body);
    const poisoned = JSON.stringify(Array.isArray(parsed) ? [{ error: "unexpected" }] : { ...parsed, error: "unexpected" });
    expect(() => assertTpsRouteOutcome(method, `/${name}`, 200, poisoned, "test-agent")).toThrow();
  });
}

test("A2A POST probes request tasks/list", () => {
  for (const path of ["/A2AAdapter", "/a2a"]) {
    expect(JSON.parse(tpsRouteBody(path))).toEqual({ jsonrpc: "2.0", id: "tps-route", method: "tasks/list" });
  }
  expect(tpsRouteBody("/Presence")).toBe("{}");
  expect(source).toContain('body: tpsRouteBody(path)');
});

test("unspecified routes and verbs are rejected", () => {
  for (const [method, path] of [["GET", "/Unspecified"], ["POST", "/Unspecified"], ["DELETE", "/Agent"]]) {
    expect(() => assertTpsRouteOutcome(method, path, 403, '{}', "test-agent")).toThrow();
  }
});

for (const { method, path } of TPS_ED25519_ROUTES) {
  for (const status of [401, 500]) {
    test(`${method} ${path}: matrix rejects status ${status}`, async () => {
      const send = async () => new Response('{"error":"unexpected"}', { status });
      await expect(check(expect, send, method, path, { id: "test-agent" }, assertTpsRouteOutcome)).rejects.toThrow();
    });
  }
}

test("GET /Presence: matrix rejects an error body with status 200", async () => {
  const send = async () => new Response('{"error":"unexpected"}', { status: 200 });
  await expect(check(expect, send, "GET", "/Presence", { id: "test-agent" }, assertTpsRouteOutcome)).rejects.toThrow();
});
