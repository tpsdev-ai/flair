/**
 * flair#2231: the `flair status` expired-validTo warning groups the count by
 * agent and flags agents the local nightly driver will not archive.
 *
 * Real HealthDetail aggregation -> real Commander status actions; all runtime
 * I/O is mocked (no Harper, HOME files, network or service manager). Run in its
 * own process because module mocks are process-global.
 */
import { afterEach, beforeEach, expect, mock, setSystemTime, spyOn, test } from "bun:test";

const NOW = Date.parse("2026-10-03T12:00:00Z");
const HOME = "/fixture/flair-2231";
const LOG = HOME + "/.flair/logs/rem-nightly.jsonl";
const TIMER = HOME + "/.config/systemd/user/flair-rem-nightly.timer";
let installed = true;
/** Unit-file text the driver-agent read sees for TIMER; null = unreadable. */
let unitText: string | null = null;
let rows: Array<Record<string, unknown>> = [];

function absent(): never { throw new Error("fixture path absent"); }

mock.module("node:os", () => ({
  homedir: () => HOME,
  hostname: () => "fixture",
  platform: () => "linux",
}));
mock.module("node:fs", () => ({
  existsSync: () => false,
  readFileSync: absent,
  promises: {
    stat: async (path: string) => {
      if (path === TIMER && installed) return { size: unitText ? Buffer.byteLength(unitText) : 0 };
      if (path === LOG) return { size: 0 };
      return absent();
    },
    open: async () => absent(),
    readFile: async (path: string) => (path === TIMER && unitText !== null ? unitText : absent()),
    readdir: async () => absent(),
  },
}));
mock.module("harper", () => ({
  Resource: class {},
  databases: { flair: {
    Memory: { search: async function* () { yield* rows; } },
    MemoryHostSource: { search: async function* () {} },
    Agent: { search: async function* () { yield { id: "fixture-agent" }; } },
    MemoryCandidate: { search: async function* () {} },
  } },
  server: {},
  logger: { warn: () => {} },
}));
mock.module("../../resources/agent-auth.js", () => ({
  allowVerified: async () => true,
  isAdmin: async () => false,
  resolveAgentAuth: async () => ({ kind: "internal" }),
}));
mock.module("../../resources/build-info.js", () => ({ resolveBuildInfo: () => null }));
mock.module("../../resources/migrations/status.js", () => ({
  getMigrationStatusSnapshot: () => { throw new Error("no migration fixture"); },
}));
mock.module("../../resources/migrations/data-dir.js", () => ({
  resolveMigrationDataDirForRead: () => HOME + "/data",
}));
mock.module("../../resources/dedup-cluster.js", () => ({ REM_DEDUP_STATS_PATH: HOME + "/dedup" }));
mock.module("../../resources/bm25.js", () => ({
  hybridEnabled: () => false, retrievalMode: () => "vector",
}));
mock.module("../../resources/bm25-index-service.js", () => ({
  bm25IndexEnabled: () => false,
  bm25IndexInRetrievalPath: () => false,
  bm25IndexStatus: () => ({}),
  noteMemoryUpsert: () => {}, noteMemoryDelete: () => {},
}));
mock.module("../../resources/embedding-space-guard.js", () => ({ normalizeStamp: (s: string) => s }));
mock.module("../../resources/embeddings-provider.js", () => ({ getModelId: () => "fixture-model" }));
mock.module("../../resources/migrations/stamp-outstanding.js", () => ({
  describeStampOutstanding: () => ({ outstanding: false }), EMBEDDING_STAMP_ID: "fixture",
}));
mock.module("../../resources/search-readiness.js", () => ({
  buildPublicHealthBody: () => ({ ok: true }),
  resolveSearchReadiness: () => ({ searchReady: true, status: 200 }),
}));
mock.module("../../resources/embed-gpu.js", () => ({
  withEmbedGpuHealth: (body: object) => ({ ...body, embedding: {} }),
  embedGpuStatusNotice: () => null,
}));
mock.module("../../resources/federation-peer-liveness.js", () => ({
  classifyPeerLiveness: () => "disconnected",
  federationPeersAllDisconnectedWarning: () => null,
  PEER_LIVENESS_MEASURED_BY: "fixture",
  summarizePeerLiveness: () => ({}),
}));
mock.module("../../src/lib/instance-identity-row.js", () => ({
  decideInstanceAnswer: () => ({ kind: "absent" }), INSTANCE_ROW_PRUNE_REMEDY: "fixture",
}));
mock.module("../../resources/Federation.js", () => ({ readAllInstanceRows: async () => [] }));
mock.module("../../src/rem/scheduler.js", () => ({ queryActiveStateAsync: async () => true }));
mock.module("../../src/lib/auth-resolve.js", () => ({ resolveAdminUser: () => "fixture" }));
mock.module("../../src/version-check.js", () => ({
  checkVersion: async () => ({}), formatVersionNudge: () => null, FLAIR_PKG_NAME: "fixture",
}));
mock.module("../../src/lib/npm-registry.js", () => ({ resolveRegistryNotice: async () => ({}) }));

const { HealthDetail } = await import("../../resources/health.ts");
const { Command } = await import("commander");
const { bindCli, register } = await import("../../src/commands/status.ts");

function mem(id: string, agentId: string | undefined, validTo: string): Record<string, unknown> {
  return { id, agentId, validTo, embeddingModel: "fixture-model" };
}

beforeEach(() => {
  installed = true;
  unitText = "Description=Flair REM nightly timer (agent-a)\n";
  rows = [mem("a1", "agent-a", "2000-01-01T00:00:00Z"), mem("a2", "agent-a", "2000-01-01T00:00:00Z")];
  setSystemTime(NOW);
  spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected network access"));
});
afterEach(() => {
  try { expect(globalThis.fetch).not.toHaveBeenCalled(); } finally { mock.restore(); setSystemTime(); }
});

async function statusOutput(detail: Record<string, any>, args: string[]): Promise<string> {
  bindCli({
    fetchHealthDetail: async () => ({ healthy: true, baseUrl: "https://fixture.invalid", healthData: detail }),
    humanBytes: (n: number) => String(n), relativeTime: () => "fixture-time",
    resolveSigningAgentId: () => ({ agentId: "fixture-agent", source: "flag" }),
    sortSoulKeyEntries: () => [], defaultDataDir: () => HOME + "/data",
    readHarperConfig: () => null, readPortFromConfig: () => null, __pkgVersion: "fixture",
    resolveHttpPort: () => 0, assessInstallTree: () => null,
  });
  const program = new Command();
  register(program);
  const output: string[] = [];
  const capture = spyOn(console, "log").mockImplementation((...items: unknown[]) => {
    output.push(items.map(String).join(" "));
  });
  try {
    await program.parseAsync(["status", ...args], { from: "user" });
  } finally {
    capture.mockRestore();
  }
  return output.join("\n");
}

function expiryWarning(detail: Record<string, any>): string {
  const warnings = detail.warnings as Array<{ level: string; message: string }>;
  const found = warnings.filter((w) => w.message.includes("expired validTo"));
  expect(found).toHaveLength(1);
  expect(found[0].level).toBe("warn");
  return found[0].message;
}

test("two agents: status names both counts and flags the one with no nightly driver", async () => {
  rows.push(mem("b1", "agent-b", "2000-01-01T00:00:00Z"), mem("b2", "agent-b", "2000-01-01T00:00:00Z"), mem("b3", "agent-b", "2000-01-01T00:00:00Z"));
  const detail = await new HealthDetail().get();
  expect(detail.memories.expired).toBe(5);
  expect(detail.memories.expiredByAgent).toEqual({
    agents: [
      { agentId: "agent-b", count: 3, nightlyDriverInstalled: false },
      { agentId: "agent-a", count: 2, nightlyDriverInstalled: true },
    ],
    agentCount: 2,
    total: 5,
    remainderCount: 0,
  });
  const warning = expiryWarning(detail);
  expect(warning).toStartWith("5 memories have expired validTo but aren't archived\n");
  expect(warning).toContain("each agent's own nightly run archives its rows");
  expect(warning).toContain("agent-b: 3 — NO nightly driver installed");
  expect(warning).toContain("agent-a: 2 — nightly driver installed");

  for (const args of [[], ["--agent", "agent-a"], ["deep"]]) {
    expect(await statusOutput(detail, args)).toContain("agent-b: 3 — NO nightly driver installed");
  }
  const parsed = JSON.parse(await statusOutput(detail, ["--json"])) as Record<string, any>;
  expect(parsed.memories.expiredByAgent).toEqual(detail.memories.expiredByAgent);
  expect(expiryWarning(parsed)).toBe(warning);
});

test("no driver installed: every listed agent is flagged", async () => {
  installed = false;
  rows.push(mem("b1", "agent-b", "2000-01-01T00:00:00Z"));
  const detail = await new HealthDetail().get();
  expect(detail.memories.expiredByAgent.agents).toEqual([
    { agentId: "agent-a", count: 2, nightlyDriverInstalled: false },
    { agentId: "agent-b", count: 1, nightlyDriverInstalled: false },
  ]);
  expect(expiryWarning(detail)).toContain("agent-a: 2 — NO nightly driver installed");
});

test("installed but unreadable unit: UNKNOWN, never 'no driver'", async () => {
  installed = true;
  unitText = null; // read fails
  const detail = await new HealthDetail().get();
  expect(detail.memories.expiredByAgent.agents).toEqual([
    { agentId: "agent-a", count: 2, nightlyDriverInstalled: null },
  ]);
  const warning = expiryWarning(detail);
  expect(warning).toContain("agent-a: 2 — nightly driver state unknown");
  expect(warning).not.toContain("NO nightly driver installed");
});

test("large fleet: output names a bounded set plus a remainder count", async () => {
  rows = Array.from({ length: 7 }, (_, i) => mem(`m${i}`, `agent-${i}`, "2000-01-01T00:00:00Z"));
  const detail = await new HealthDetail().get();
  const b = detail.memories.expiredByAgent;
  expect(b.agents).toHaveLength(5);
  expect(b.agentCount).toBe(7);
  expect(b.remainderCount).toBe(2);
  const warning = expiryWarning(detail);
  expect(warning).toContain("and 2 more agent(s) (2 expired rows)");
  expect(warning).not.toContain("agent-6");
});

test("zero expired rows: no breakdown and no expiry warning", async () => {
  rows = [mem("future", "agent-a", "2999-01-01T00:00:00Z")];
  const detail = await new HealthDetail().get();
  expect(detail.memories.expired).toBe(0);
  expect(detail.memories.expiredByAgent).toBeUndefined();
  expect(JSON.stringify(detail.warnings)).not.toContain("expired validTo");
});
