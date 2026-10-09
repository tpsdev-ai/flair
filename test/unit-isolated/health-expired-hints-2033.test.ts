/**
 * #2033: real HealthDetail aggregation -> real Commander status actions.
 * All runtime I/O is mocked; no Harper, HOME files, network or service manager.
 * Run in its own process because module mocks are process-global.
 */
import { afterEach, beforeEach, expect, mock, setSystemTime, spyOn, test } from "bun:test";

const NOW = Date.parse("2026-09-28T12:00:00Z");
const HOME = "/fixture/flair-2033";
const LOG = HOME + "/.flair/logs/rem-nightly.jsonl";
const TIMER = HOME + "/.config/systemd/user/flair-rem-nightly.timer";
const SERVICE = HOME + "/.config/systemd/user/flair-rem-nightly.service";
let installed = true;
let active: boolean | null = false;
let platformError = false;
let logText = "";
let memoryReadError = false;
let rows: Array<Record<string, unknown>> = [];
const originalTransaction = (globalThis as any).transaction;

function absent(): never { throw Object.assign(new Error("fixture path absent"), { code: "ENOENT" }); }

mock.module("node:os", () => ({
  homedir: () => HOME,
  hostname: () => "fixture",
  platform: () => {
    if (platformError) throw new Error("platform unavailable");
    return "linux";
  },
}));
mock.module("node:fs", () => ({
  existsSync: () => false,
  readFileSync: absent,
  promises: {
    stat: async (path: string) => {
      if ((path === TIMER || path === SERVICE) && installed) return { size: 0 };
      if (path === LOG) return { size: Buffer.byteLength(logText) };
      return absent();
    },
    open: async (path: string) => {
      if (path !== LOG) return absent();
      return {
        read: async (buffer: Buffer, offset: number, length: number, position: number) => {
          const bytesRead = Buffer.from(logText).copy(buffer, offset, position, position + length);
          return { bytesRead, buffer };
        },
        close: async () => {},
      };
    },
    readFile: async () => absent(),
    readdir: async () => absent(),
  },
}));
mock.module("harper", () => ({
  Resource: class {},
  databases: { flair: {
    Memory: {
      search: async function* () {
        if (memoryReadError) throw new Error("memory read failed");
        yield* rows;
      },
      get: async (id: string) => rows.find((r) => r.id === id) ?? null,
      update: async (id: string, row: Record<string, unknown>, ctx: any) => {
        expect(ctx?.transaction?.open).toBe(1);
        const index = rows.findIndex((r) => r.id === id);
        if (index < 0) throw new Error("update requires an existing row");
        rows[index] = structuredClone(row);
      },
      delete: async () => { throw new Error("validTo cleanup must not delete"); },
    },
    MemoryHostSource: {
      search: async function* () {},
      delete: async (_id: string, ctx: any) => { expect(ctx?.transaction?.open).toBe(1); },
    },
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
  embedGpuStatusNotice: (embedding: unknown) => {
    expect(embedding).toEqual({});
    return null;
  },
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
mock.module("../../src/rem/scheduler.js", () => ({ queryActiveStateAsync: async () => active }));
mock.module("../../src/lib/auth-resolve.js", () => ({ resolveAdminUser: () => "fixture" }));
mock.module("../../src/version-check.js", () => ({
  checkVersion: async () => ({}), formatVersionNudge: () => null, FLAIR_PKG_NAME: "fixture",
}));
mock.module("../../src/lib/npm-registry.js", () => ({
  resolveRegistryNotice: async () => ({}),
}));

const { MemoryMaintenance } = await import("../../resources/MemoryMaintenance.ts");
const { HealthDetail } = await import("../../resources/health.ts");
const { Command } = await import("commander");
const { bindCli, register } = await import("../../src/commands/status.ts");

beforeEach(() => {
  // Maintenance owns the archive/pointer transaction; this fixture has no pointers.
  (globalThis as any).transaction = async (ctx: any, cb: (txn: any) => unknown) => {
    const before = structuredClone(rows);
    const txn = { open: 1, saveCommits: false };
    ctx.transaction = txn;
    try { return await cb(txn); }
    catch (error) { rows = before; throw error; }
    finally { txn.open = 0; }
  };
  installed = true;
  active = false;
  platformError = false;
  memoryReadError = false;
  logText = "";
  rows = [
    { id: "expired", agentId: "fixture-agent", validTo: "2000-01-01T00:00:00Z" },
    { id: "archived", archived: true, validTo: "2000-01-01T00:00:00Z" },
    { id: "future", validTo: "2999-01-01T00:00:00Z" },
    { id: "at-boundary", validTo: new Date(NOW).toISOString() },
    { id: "invalid", validTo: "invalid" },
    { id: "open" },
  ].map((r) => ({ embeddingModel: "fixture-model", ...r }));
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

const CLEAR = "clear now: flair rem light (archives expired validTo; preview: --dry-run)";
const ENABLE = "automate: flair rem nightly enable (includes validTo archival)";

function expiryWarning(detail: Record<string, any>): string {
  const warnings = detail.warnings as Array<{ level: string; message: string }>;
  const found = warnings.filter((w) => w.message.includes("expired validTo"));
  expect(found).toHaveLength(1);
  expect(found[0].level).toBe("warn");
  expect(found[0].message).toStartWith("1 memories have expired validTo but aren't archived\n");
  expect(found[0].message).toContain(CLEAR);
  expect(found[0].message).not.toContain("does not yet clean up");
  return found[0].message;
}

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

const cases: Array<{ name: string; enabled: boolean | null; status?: string; hint: string }> = [
  { name: "disabled", enabled: false, hint: ENABLE },
  { name: "enabled without a next-run time", enabled: true, status: "completed", hint: "nightly is enabled" },
  { name: "enabled with failed last run", enabled: true, status: "failed", hint: "nightly is enabled, but its last logged run failed" },
  { name: "unknown active state", enabled: null, hint: "nightly state is unknown — check: flair rem nightly status" },
];
for (const scenario of cases) {
  test(scenario.name + ": HealthDetail and every status warning surface", async () => {
    active = scenario.enabled;
    logText = scenario.status
      ? JSON.stringify({ status: scenario.status, runAt: "2026-09-28T03:00:00Z", errors: scenario.status === "failed" ? ["private diagnostic"] : [] }) + "\n"
      : "";
    const detail = await new HealthDetail().get();
    const warning = expiryWarning(detail);
    expect(detail.memories.expired).toBe(1);
    expect(warning).toContain(scenario.hint);
    expect(warning.includes(ENABLE)).toBe(scenario.enabled === false);
    expect(warning.includes("last logged run failed")).toBe(scenario.status === "failed");
    expect(warning).not.toContain("private diagnostic");
    expect(warning).not.toMatch(/next run|03:00/);
    if (scenario.status === "failed") {
      expect(warning).toContain("~/.flair/logs/rem-nightly.jsonl on the server");
    }
    for (const args of [[], ["--agent", "fixture-agent"], ["deep"], ["--json"], ["--json", "deep"]]) {
      const output = await statusOutput(detail, args);
      if (args.includes("--json")) {
        const parsed = JSON.parse(output) as Record<string, any>;
        expect(expiryWarning(parsed)).toBe(warning);
      } else {
        expect(output).toContain(warning);
        expect(output.split("memories have expired validTo")).toHaveLength(2);
      }
    }
  });
}

test("scheduler absent: give the enable hint", async () => {
  installed = false;
  expect(expiryWarning(await new HealthDetail().get())).toContain(ENABLE);
});
test("REM discovery fails: keep clear-now and report unknown state", async () => {
  platformError = true;
  const detail = await new HealthDetail().get();
  expect(detail.rem).toBeNull();
  expect(expiryWarning(detail)).toContain("nightly state is unknown");
});
test("enabled without a log: do not invent a run or failure", async () => {
  active = true;
  const warning = expiryWarning(await new HealthDetail().get());
  expect(warning).toContain("nightly is enabled");
  expect(warning).not.toContain("failed");
  expect(warning).not.toContain(ENABLE);
});
test("a successful last record supersedes an older failure", async () => {
  active = true;
  logText = '{"status":"failed"}\n{"status":"completed"}\n';
  const warning = expiryWarning(await new HealthDetail().get());
  expect(warning).toContain("nightly is enabled");
  expect(warning).not.toContain("failed");
});
test("disabled with a previous failure: suggest enabling, not enabled", async () => {
  logText = '{"status":"failed"}\n';
  const warning = expiryWarning(await new HealthDetail().get());
  expect(warning).toContain(ENABLE);
  expect(warning).not.toContain("nightly is enabled");
});
test("zero expired rows: no expiry warning or remedy", async () => {
  rows = rows.filter((r) => r.id !== "expired");
  const detail = await new HealthDetail().get();
  expect(detail.memories.expired).toBe(0);
  expect(JSON.stringify(detail.warnings)).not.toContain("expired validTo");
  expect(JSON.stringify(detail.warnings)).not.toContain(CLEAR);
});
test("failed memory scan: no invented count or expiry remedy", async () => {
  memoryReadError = true;
  const detail = await new HealthDetail().get();
  expect(detail.memories).toBeNull();
  expect(JSON.stringify(detail.warnings)).not.toContain("expired validTo");
});

test("maintenance archival clears the health count without removing rows", async () => {
  const resource = new MemoryMaintenance();
  resource.getContext = () => ({ request: { tpsAgentIsAdmin: true } });
  const before = await new HealthDetail().get();
  expect(before.memories.expired).toBe(1);
  expiryWarning(before);
  const originalRows = structuredClone(rows);
  const result = await resource.post({});
  if (result instanceof Response) throw new Error(await result.text());
  const after = await new HealthDetail().get();
  expect(after.memories.expired).toBe(0);
  expect(result.archived).toBe(1);
  expect(after.memories.archived).toBe(before.memories.archived + 1);
  expect(after.memories.total).toBe(before.memories.total);
  expect(rows.find((r) => r.id === "expired")).toEqual({
    ...originalRows.find((r) => r.id === "expired"),
    archived: true, archivedAt: new Date(NOW).toISOString(),
  });
  expect(rows.filter((r) => r.id !== "expired")).toEqual(originalRows.filter((r) => r.id !== "expired"));
  expect(JSON.stringify(after.warnings)).not.toContain("expired validTo");
  expect(JSON.stringify(after.warnings)).not.toContain(CLEAR);
});

test("HealthDetail uses complete timestamps, not empty, legacy or partially failed log rows", async () => {
  active = true;
  const at = new Date(NOW - 1000).toISOString();
  for (const latest of [
    { status: "completed", runAt: at, distilledAt: at, distill: { gathered: 0, unreflected: 0 } },
    { status: "completed", runAt: at, distill: { gathered: 1, unreflected: 1 } },
    { status: "failed", runAt: at, distilledAt: at, errors: ["tag failure"], distill: { gathered: 1 } },
    { status: "completed", runAt: at, distilledAt: at, skips: ["pause"], distill: { aborted: true } },
  ]) {
    logText = JSON.stringify(latest) + "\n";
    const detail = await new HealthDetail().get();
    expect(detail.rem.lastDistilledAt).toBeNull();
    expect(detail.rem.lastDistillationIncomplete).toBe(true);
    const output = await statusOutput(detail, []);
    expect(output).toContain("Pending candidates");
    expect(output).toContain("Last distilled");
    expect(output).toContain("not observed (server-local log tail)");
    expect(output).toContain("no recent complete distillation observed");
  }
});

test("HealthDetail keeps older observed success but an empty latest cycle stays stale", async () => {
  active = true;
  const at = new Date(NOW - 1000).toISOString();
  logText = JSON.stringify({ status: "completed", runAt: at, distilledAt: at, errors: [], skips: [], distill: { gathered: 1 } }) + "\n"
    + JSON.stringify({ status: "completed", runAt: new Date(NOW).toISOString(), distill: { gathered: 0 } }) + "\n";
  const detail = await new HealthDetail().get();
  expect(detail.rem.lastDistilledAt).toBe(at);
  expect(detail.rem.lastDistillationIncomplete).toBe(true);
  const output = await statusOutput(detail, []);
  expect(output).toMatch(/Pending candidates[^\n]*0/);
  expect(output).toContain("server-local log tail");
  expect(output).toContain("no recent complete distillation observed");
});

test("HealthDetail does not recover timestamps outside its bounded local tail", async () => {
  active = true;
  const at = new Date(NOW - 1000).toISOString();
  logText = JSON.stringify({ status: "completed", distilledAt: at, distill: { gathered: 1 } }) + "\n"
    + "x".repeat(256 * 1024) + "\n"
    + JSON.stringify({ status: "completed", runAt: at, distill: { gathered: 1 } }) + "\n";
  const detail = await new HealthDetail().get();
  expect(detail.rem.lastDistilledAt).toBeNull();
  expect((await statusOutput(detail, [])).includes("not observed (server-local log tail)")).toBe(true);
});
