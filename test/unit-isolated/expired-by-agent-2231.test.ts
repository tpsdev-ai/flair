/**
 * flair#2231: the `flair status` expired-validTo warning groups the count by
 * agent and matches local scheduler files to agents.
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
const SERVICE = HOME + "/.config/systemd/user/flair-rem-nightly.service";
let installed = true;
let statError: string | null = null;
let statErrorPath = TIMER;
let activeState: boolean | null = true;
let activeError: string | null = null;
let readError: string | null = null;
let serviceText: string | null = null;
let unitText: string | null = null;
let auth: Record<string, unknown> = { kind: "internal" };
let rows: Array<Record<string, unknown>> = [];

function absent(code = "ENOENT"): never { throw Object.assign(new Error(code), { code }); }

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
      if (path === statErrorPath && statError) return absent(statError);
      if (path === TIMER && installed) return { size: unitText ? Buffer.byteLength(unitText) : 0 };
      if (path === SERVICE && serviceText !== null) return { size: Buffer.byteLength(serviceText) };
      if (path === LOG) return { size: 0 };
      return absent();
    },
    open: async () => absent(),
    readFile: async (path: string) => {
      if ((path === TIMER || path === SERVICE) && readError) return absent(readError);
      if (path === TIMER && unitText !== null) return unitText;
      if (path === SERVICE && serviceText !== null) return serviceText;
      return absent();
    },
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
  resolveAgentAuth: async () => auth,
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
mock.module("../../src/rem/scheduler.js", () => ({ queryActiveStateAsync: async () => { if (activeError) return absent(activeError); return activeState; } }));
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
  auth = { kind: "internal" };
  installed = true;
  statError = null;
  statErrorPath = TIMER;
  activeState = true;
  activeError = null;
  readError = null;
  serviceText = "[Service]\nEnvironment=FLAIR_AGENT_ID=agent-a\n";
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
    unownedCount: 0,
  });
  const warning = expiryWarning(detail);
  expect(warning).toStartWith("5 memories have expired validTo but aren't archived\n");
  expect(warning).toContain("grouped by agent:");
  expect(warning).toContain("agent-b: 3 — NO matching installed nightly scheduler");
  expect(warning).toContain("agent-a: 2 — installed nightly scheduler names this agent");

  for (const args of [[], ["--agent", "agent-a"], ["deep"]]) {
    expect(await statusOutput(detail, args)).toContain("agent-b: 3 — NO matching installed nightly scheduler");
  }
  const parsed = JSON.parse(await statusOutput(detail, ["--json"])) as Record<string, any>;
  expect(parsed.memories.expiredByAgent).toEqual(detail.memories.expiredByAgent);
  expect(expiryWarning(parsed)).toBe(warning);
});

test("no driver installed: every listed agent is flagged", async () => {
  installed = false;
  serviceText = null;
  rows.push(mem("b1", "agent-b", "2000-01-01T00:00:00Z"));
  const detail = await new HealthDetail().get();
  expect(detail.memories.expiredByAgent.agents).toEqual([
    { agentId: "agent-a", count: 2, nightlyDriverInstalled: false },
    { agentId: "agent-b", count: 1, nightlyDriverInstalled: false },
  ]);
  expect(expiryWarning(detail)).toContain("agent-a: 2 — NO matching installed nightly scheduler");
});

test("installed but unreadable unit: UNKNOWN, never 'no driver'", async () => {
  installed = true;
  statError = null;
  statErrorPath = TIMER;
  activeState = true;
  activeError = null;
  readError = null;
  serviceText = "[Service]\nEnvironment=FLAIR_AGENT_ID=agent-a\n";
  readError = "EACCES";
  const detail = await new HealthDetail().get();
  expect(detail.memories.expiredByAgent.agents).toEqual([
    { agentId: "agent-a", count: 2, nightlyDriverInstalled: null },
  ]);
  const warning = expiryWarning(detail);
  expect(warning).toContain("agent-a: 2 — nightly driver state unknown");
  expect(warning).not.toContain("NO nightly driver installed");
  expect(expiryWarning(detail)).not.toContain("NO matching installed nightly scheduler");
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

for (const code of ["EACCES", "EPERM", "ENOTDIR", "ELOOP"]) {
  test(`scheduler stat ${code}: UNKNOWN with path and code`, async () => {
    statError = code;
    const detail = await new HealthDetail().get();
    expect(detail.memories.expiredByAgent.agents[0].nightlyDriverInstalled).toBeNull();
    expect(expiryWarning(detail)).toContain("nightly driver state unknown");
    expect(expiryWarning(detail)).not.toContain("NO nightly driver installed");
    expect(expiryWarning(detail)).not.toContain("NO matching installed nightly scheduler");
    expect(detail.rem.nightlyEnabled).toBeNull();
    expect(JSON.stringify(detail.warnings)).toContain(TIMER);
    expect(JSON.stringify(detail.warnings)).toContain(code);
  });
  test(`scheduler read ${code}: UNKNOWN with path and code`, async () => {
    readError = code;
    const detail = await new HealthDetail().get();
    expect(detail.memories.expiredByAgent.agents[0].nightlyDriverInstalled).toBeNull();
    expect(expiryWarning(detail)).not.toContain("NO nightly driver installed");
    expect(expiryWarning(detail)).not.toContain("NO matching installed nightly scheduler");
    expect(JSON.stringify(detail.warnings)).toContain(SERVICE);
    expect(JSON.stringify(detail.warnings)).toContain(code);
  });
}

test("divergent timer and service use the service agent", async () => {
  serviceText = "[Service]\nEnvironment=FLAIR_AGENT_ID=agent-b\n";
  rows.push(mem("b1", "agent-b", "2000-01-01T00:00:00Z"));
  const detail = await new HealthDetail().get();
  expect(detail.memories.expiredByAgent.agents).toEqual([
    { agentId: "agent-a", count: 2, nightlyDriverInstalled: false },
    { agentId: "agent-b", count: 1, nightlyDriverInstalled: true },
  ]);
});

for (const orphan of ["service", "timer"]) {
  test(`orphan ${orphan} file: not installed, reports its path`, async () => {
    if (orphan === "service") installed = false;
    else serviceText = null;
    const detail = await new HealthDetail().get();
    expect(detail.memories.expiredByAgent.agents[0].nightlyDriverInstalled).toBe(false);
    expect(detail.rem.nightlyEnabled).toBe(false);
    expect(JSON.stringify(detail.warnings)).toContain(`orphan ${orphan} file: ${orphan === "service" ? SERVICE : TIMER}`);
    expect(expiryWarning(detail)).not.toContain("NO matching nightly scheduler file");
    expect(JSON.stringify(detail.warnings)).not.toContain("scheduler files are written");
  });
}

for (const code of ["EACCES", "EPERM", "ENOTDIR", "ELOOP"]) {
  test(`service stat ${code}: UNKNOWN even with an absent timer`, async () => {
    installed = false;
    statErrorPath = SERVICE;
    statError = code;
    const detail = await new HealthDetail().get();
    expect(detail.memories.expiredByAgent.agents[0].nightlyDriverInstalled).toBeNull();
    expect(detail.rem.nightlyEnabled).toBeNull();
    expect(JSON.stringify(detail.warnings)).toContain(`${SERVICE} (${code})`);
  });
}

for (const code of ["EACCES", null]) {
  test(`active-state failure ${code ?? "without code"}: UNKNOWN with scheduler path`, async () => {
    activeError = code;
    activeState = null;
    const detail = await new HealthDetail().get();
    expect(detail.rem.nightlyEnabled).toBeNull();
    expect(JSON.stringify(detail.warnings)).toContain(`${TIMER} (${code ?? "error code unavailable"})`);
  });
}


for (const [who, caller, redacted] of [
  ["verified non-admin", { kind: "agent", agentId: "agent-x", isAdmin: false }, true],
  ["admin", { kind: "agent", agentId: "admin-agent", isAdmin: true }, false],
] as const) {
  test(`scheduler paths in warnings for a ${who} caller`, async () => {
    auth = caller;
    statError = "EACCES";
    const probe = JSON.stringify((await new HealthDetail().get()).warnings);
    statError = null;
    serviceText = null;
    const orphan = JSON.stringify((await new HealthDetail().get()).warnings);
    const shown = redacted ? "~/.config/systemd/user/flair-rem-nightly.timer" : TIMER;
    expect(probe).toContain(`state unknown: ${shown} (EACCES)`);
    expect(orphan).toContain(`orphan timer file: ${shown}`);
    if (redacted) {
      expect(probe).not.toContain(HOME);
      expect(orphan).not.toContain(HOME);
    }
  });
}

test("five named agents and an unowned row do not add a remainder agent", async () => {
  rows = Array.from({ length: 5 }, (_, i) => mem(`m${i}`, `agent-${i}`, "2000-01-01T00:00:00Z"));
  rows.push({ id: "unowned", validTo: "2000-01-01T00:00:00Z" });
  const detail = await new HealthDetail().get();
  expect(detail.memories.expiredByAgent.agentCount).toBe(5);
  expect(detail.memories.expiredByAgent.unownedCount).toBe(1);
  const warning = expiryWarning(detail);
  expect(warning).toContain("1 expired row(s) with no agent id");
  expect(warning).not.toContain("more agent(s)");
});

for (const text of [
  "[Service]\n# Environment=FLAIR_AGENT_ID=agent-b\nEnvironment=FLAIR_AGENT_ID=agent-a\n",
  "[Service]\nEnvironment=FLAIR_AGENT_ID=agent-b\nEnvironment=FLAIR_AGENT_ID=agent-a\n",
]) {
  test(`service assignments ignore comments and use the last value: ${JSON.stringify(text)}`, async () => {
    serviceText = text;
    expect((await new HealthDetail().get()).memories.expiredByAgent.agents[0].nightlyDriverInstalled).toBe(true);
  });
}

for (const text of [
  "Environment=FLAIR_AGENT_ID=agent-a\n",
  "[Service]\n# Environment=FLAIR_AGENT_ID=agent-a\n",
  "[Service]\nDescription=FLAIR_AGENT_ID=agent-a\n",
  "[Service]\nEnvironment=FLAIR_AGENT_ID=agent-a%I\n",
  '[Service]\nEnvironment="FLAIR_AGENT_ID=agent-a\n',
]) {
  test(`ambiguous service identity reports UNKNOWN: ${JSON.stringify(text)}`, async () => {
    serviceText = text;
    expect((await new HealthDetail().get()).memories.expiredByAgent.agents[0].nightlyDriverInstalled).toBeNull();
  });
}
