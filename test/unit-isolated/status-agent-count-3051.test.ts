/**
 * #3051: `flair status` reports an agent total, names and table from the SAME
 * Agent records, and shows memories whose author has no Agent record (the
 * operator's `skill:using-flair` seed) on its own labelled line.
 *
 * These cases drive the REAL HealthDetail aggregation and the REAL status
 * action. Runtime I/O is mocked: no Harper, HOME files, network or service
 * manager. Run in its own process because module mocks are process-global.
 */
import { afterEach, beforeEach, expect, mock, setSystemTime, spyOn, test } from "bun:test";

const NOW = Date.parse("2026-11-22T12:00:00Z");
const HOME = "/fixture/flair-3051";
let agentRows: Array<Record<string, unknown>> = [];
let memoryRows: Array<Record<string, unknown>> = [];
let authVerdict: Record<string, unknown> = { kind: "internal" };
const originalTransaction = (globalThis as any).transaction;

function absent(): never { throw Object.assign(new Error("fixture path absent"), { code: "ENOENT" }); }

mock.module("node:os", () => ({
  homedir: () => HOME,
  hostname: () => "fixture",
  platform: () => "linux",
}));
mock.module("node:fs", () => ({
  existsSync: () => false,
  readFileSync: absent,
  promises: {
    stat: async () => absent(),
    open: async () => absent(),
    readFile: async () => absent(),
    readdir: async () => absent(),
  },
}));
mock.module("harper", () => ({
  Resource: class {},
  databases: { flair: {
    Memory: {
      search: async function* () { yield* memoryRows; },
    },
    Agent: {
      search: async function* () { yield* agentRows; },
    },
    MemoryCandidate: { search: async function* () {} },
  } },
  server: {},
  logger: { warn: () => {} },
}));
mock.module("../../resources/agent-auth.js", () => ({
  allowVerified: async () => true,
  annotatedCallerIsAdmin: async () => false,
  resolveAgentAuth: async () => authVerdict,
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
mock.module("../../resources/embedding-space-guard.js", () => ({ normalizeStamp: (s: string) => s, spaceGuardState: () => ({ state: "uniform", reason: null }) }));
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
mock.module("../../src/rem/scheduler.js", () => ({ queryActiveStateAsync: async () => false }));
mock.module("../../src/lib/auth-resolve.js", () => ({ resolveAdminUser: () => "fixture" }));
mock.module("../../src/version-check.js", () => ({
  checkVersion: async () => ({}), formatVersionNudge: () => null, FLAIR_PKG_NAME: "fixture",
}));
mock.module("../../src/lib/npm-registry.js", () => ({
  resolveRegistryNotice: async () => ({}),
}));

const { HealthDetail } = await import("../../resources/health.ts");
const { Command } = await import("commander");
const { bindCli, register } = await import("../../src/commands/status.ts");

beforeEach(() => {
  (globalThis as any).transaction = originalTransaction;
  agentRows = [{ id: "agent-a" }];
  memoryRows = [
    { id: "skill:using-flair", agentId: "operator-seed", createdAt: new Date(NOW - 1000).toISOString(), embeddingModel: "fixture-model" },
  ];
  authVerdict = { kind: "internal" };
  setSystemTime(NOW);
  spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected network access"));
});
afterEach(() => {
  try { expect(globalThis.fetch).not.toHaveBeenCalled(); }
  finally {
    (globalThis as any).transaction = originalTransaction;
    mock.restore();
    setSystemTime();
  }
});

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

async function statusOutput(detail: Record<string, any>, args: string[]): Promise<string> {
  bindCli({
    fetchHealthDetail: async () => ({ healthy: true, baseUrl: "https://fixture.invalid", healthData: detail }),
    humanBytes: (n: number) => String(n), relativeTime: () => "fixture-time",
    resolveSigningAgentId: () => ({ agentId: "agent-a", source: "flag" }),
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
  return stripAnsi(output.join("\n"));
}

test("one agent plus the operator seed: total, names and table name that agent; the seed gets a labelled line", async () => {
  const detail: any = await new HealthDetail().get();

  expect(detail.memories.total).toBe(1);
  expect(detail.agents.count).toBe(1);
  expect(detail.agents.names).toEqual(["agent-a"]);
  expect(detail.agents.perAgent.map((r: any) => r.id)).toEqual(["agent-a"]);
  expect(detail.agents.perAgent[0].memoryCount).toBe(0);
  expect(detail.agents.unregisteredMemoryAuthors).toEqual([{ id: "operator-seed", memoryCount: 1 }]);

  const output = await statusOutput(detail, []);
  expect(output).toContain("agent-a");
  // The one-row table is printed, so the header total is visibly its row count.
  expect(output).toContain("hash_fb");
  expect(output).toContain("Unregistered memory owners");
  expect(output).toContain("operator-seed (1 memory)");
  expect(output).not.toMatch(/operator-seed\s+1\b/);
});

test("two agents plus the operator seed: count and table are the same two agents", async () => {
  agentRows = [{ id: "agent-a" }, { id: "agent-b" }];
  const detail: any = await new HealthDetail().get();

  expect(detail.agents.count).toBe(2);
  expect(detail.agents.count).toBe(detail.agents.perAgent.length);
  expect(detail.agents.names).toEqual(["agent-a", "agent-b"]);
  expect(detail.agents.perAgent.map((r: any) => r.id).sort()).toEqual(["agent-a", "agent-b"]);
  expect(detail.agents.unregisteredMemoryAuthors).toEqual([{ id: "operator-seed", memoryCount: 1 }]);

  const output = await statusOutput(detail, []);
  expect(output).toContain("agent-a");
  expect(output).toContain("agent-b");
  expect(output).toContain("Unregistered memory owners");
  expect(output).toContain("operator-seed (1 memory)");
  expect(output).not.toMatch(/operator-seed\s+1\b/);
});

test("a non-admin caller sees only its own agent row and no seed line", async () => {
  agentRows = [{ id: "agent-a" }, { id: "agent-b" }];
  authVerdict = { kind: "agent", agentId: "agent-a", isAdmin: false };
  const detail: any = await new HealthDetail().get();

  // The total is what a non-admin saw before this change; names stay hidden.
  expect(detail.agents.count).toBe(2);
  expect(detail.agents.names).toBeUndefined();
  expect(detail.agents.perAgent.map((r: any) => r.id)).toEqual(["agent-a"]);
  expect("unregisteredMemoryAuthors" in detail.agents).toBe(true);
  expect(detail.agents.unregisteredMemoryAuthors).toBeUndefined();

  const output = await statusOutput(detail, []);
  expect(output).toContain("agent-a");
  expect(output).not.toContain("agent-b");
  expect(output).not.toContain("operator-seed");
  expect(output).not.toContain("Unregistered memory owners");
});
