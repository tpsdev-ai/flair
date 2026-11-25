/**
 * #3051: `flair status` and `flair status deep` report an agent total, names
 * and table from one Agent-id map, and show memory authors without an Agent
 * record — the operator's `skill:using-flair` seed when the operator id was
 * never registered — on a labelled line. With no
 * Agent registered, an admin still gets that line; an incomplete Memory scan
 * reports the list unavailable rather than empty or partial.
 *
 * These cases drive the REAL HealthDetail aggregation and the REAL status
 * action. Runtime I/O is mocked: no Harper, HOME files, network or service
 * manager. Run in its own process because module mocks are process-global.
 */
import { afterEach, beforeEach, expect, mock, setSystemTime, spyOn, test } from "bun:test";
import { join } from "node:path";
import { tempDir } from "../helpers/temp-dir.ts";

const NOW = Date.parse("2026-11-22T12:00:00Z");
const HOME = "/fixture/flair-3051";
let agentRows: Array<Record<string, unknown>> = [];
let memoryRows: Array<Record<string, unknown>> = [];
let memoryScanFailure: "before" | "after" | null = null;
let authVerdict: Record<string, unknown> = { kind: "internal" };
let realBridgeBase: string | null = null;
let realHome: string | null = null;
let realRemLog: string | null = null;
let bm25Status: Record<string, unknown> = {};
const originalTransaction = (globalThis as any).transaction;

function absent(): never { throw Object.assign(new Error("fixture path absent"), { code: "ENOENT" }); }

mock.module("node:os", () => ({
  homedir: () => realHome ?? HOME,
  hostname: () => "fixture",
  platform: () => "linux",
}));
mock.module("node:fs", () => ({
  existsSync: () => false,
  readFileSync: absent,
  promises: {
    stat: async (p: string) => {
      if (realBridgeBase !== null && String(p) === realBridgeBase) return nativeFsp.stat(p);
      if (realRemLog !== null && String(p) === realRemLog) return nativeFsp.stat(p);
      return absent();
    },
    open: async (p: string, flags?: string | number) => (realRemLog !== null && String(p) === realRemLog ? nativeFsp.open(p, flags) : absent()),
    readFile: async () => absent(),
    readdir: async (p: string) => (realBridgeBase !== null && String(p) === realBridgeBase ? nativeFsp.readdir(p) : absent()),
  },
}));
mock.module("harper", () => ({
  Resource: class {},
  databases: { flair: {
    Memory: {
      search: async function* () {
        if (memoryScanFailure === "before") throw new Error("fixture memory scan failed");
        yield* memoryRows;
        if (memoryScanFailure === "after") throw new Error("fixture memory scan failed");
      },
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
  bm25IndexStatus: () => bm25Status,
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
mock.module("../../src/lib/auth-resolve.js", () => ({ resolveAdminUser: () => "fixture", envAdminPass: () => process.env.FLAIR_ADMIN_PASS || process.env.HDB_ADMIN_PASSWORD || undefined }));
mock.module("../../src/version-check.js", () => ({
  checkVersion: async () => ({}), formatVersionNudge: () => null, FLAIR_PKG_NAME: "fixture",
}));
mock.module("../../src/lib/npm-registry.js", () => ({
  resolveRegistryNotice: async () => ({}),
}));

const nativeFsp = await import("node:fs/promises");
const { HealthDetail } = await import("../../resources/health.ts");
const { Command } = await import("commander");
const { bindCli, register } = await import("../../src/commands/status.ts");

beforeEach(() => {
  (globalThis as any).transaction = originalTransaction;
  agentRows = [{ id: "agent-a" }];
  memoryRows = [
    { id: "skill:using-flair", agentId: "operator-seed", createdAt: new Date(NOW - 1000).toISOString(), embeddingModel: "fixture-model" },
  ];
  memoryScanFailure = null;
  bm25Status = {};
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
    sortSoulKeyEntries: (byKey: Record<string, number>) => Object.entries(byKey ?? {}), defaultDataDir: () => HOME + "/data",
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

test("a non-admin caller sees no seed line and no other zero-memory agent", async () => {
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

  const deepOutput = await statusOutput(detail, ["deep"]);
  expect(deepOutput).toContain("agent-a");
  expect(deepOutput).not.toContain("agent-b");
  expect(deepOutput).not.toContain("operator-seed");
  expect(deepOutput).not.toContain("Unregistered memory owners");
});

test("no Agent registered: plain status still renders the seed author line", async () => {
  agentRows = [];
  const detail: any = await new HealthDetail().get();

  expect(detail.agents.count).toBe(0);
  expect(detail.agents.names).toEqual([]);
  expect(detail.agents.perAgent).toEqual([]);
  expect(detail.agents.unregisteredMemoryAuthors).toEqual([{ id: "operator-seed", memoryCount: 1 }]);

  const output = await statusOutput(detail, []);
  expect(output).not.toMatch(/^Agents$/m);
  expect(output).toContain("Unregistered memory owners");
  expect(output).toContain("operator-seed (1 memory)");
  expect(output).not.toMatch(/operator-seed\s+1\b/);
});

test("no Agent registered: deep status still renders the seed author line", async () => {
  agentRows = [];
  const detail: any = await new HealthDetail().get();

  expect(detail.agents.count).toBe(0);

  const output = await statusOutput(detail, ["deep"]);
  expect(output).not.toContain("═══ Agents");
  expect(output).toContain("Unregistered memory owners");
  expect(output).toContain("operator-seed (1 memory)");
  expect(output).not.toMatch(/operator-seed\s+1\b/);
});

test("deep status prints the labelled seed line and no seed agent row", async () => {
  const detail: any = await new HealthDetail().get();

  expect(detail.agents.unregisteredMemoryAuthors).toEqual([{ id: "operator-seed", memoryCount: 1 }]);

  const output = await statusOutput(detail, ["deep"]);
  expect(output).toContain("Names:        agent-a");
  expect(output).toContain("Unregistered memory owners");
  expect(output).toContain("operator-seed (1 memory)");
  expect(output).not.toMatch(/operator-seed\s+1\b/);
});

test("an incomplete Memory scan reports the author list unavailable, never empty or partial", async () => {
  agentRows = [{ id: "agent-a" }];

  memoryScanFailure = "before";
  const failedEarly: any = await new HealthDetail().get();
  expect(failedEarly.memories).toBeNull();
  expect(failedEarly.agents.unregisteredMemoryAuthors).toBeNull();
  const earlyOutput = await statusOutput(failedEarly, []);
  expect(earlyOutput).toMatch(/Unregistered memory owners\s+unavailable — memory scan did not complete/);
  expect(earlyOutput).not.toContain("operator-seed");

  memoryScanFailure = "after";
  const failedLate: any = await new HealthDetail().get();
  expect(failedLate.memories).toBeNull();
  expect(failedLate.agents.unregisteredMemoryAuthors).toBeNull();
  const lateOutput = await statusOutput(failedLate, []);
  expect(lateOutput).toMatch(/Unregistered memory owners\s+unavailable — memory scan did not complete/);
  expect(lateOutput).not.toContain("operator-seed");
});

test("deep status reports the author list unavailable after a failed scan", async () => {
  memoryScanFailure = "before";
  const detail: any = await new HealthDetail().get();

  expect(detail.agents.unregisteredMemoryAuthors).toBeNull();
  const output = await statusOutput(detail, ["deep"]);
  expect(output).toContain("Unregistered memory owners: unavailable — memory scan did not complete");
  expect(output).not.toContain("operator-seed");
});

test("deep status reports the author list unavailable after a scan that yielded a row, and shows no partial author", async () => {
  memoryScanFailure = "after";
  const detail: any = await new HealthDetail().get();

  expect(detail.agents.unregisteredMemoryAuthors).toBeNull();
  const output = await statusOutput(detail, ["deep"]);
  expect(output).toContain("Unregistered memory owners: unavailable — memory scan did not complete");
  expect(output).not.toContain("operator-seed");
});

test("no Agent registered and an incomplete scan: plain status says unavailable and shows no partial author", async () => {
  agentRows = [];
  memoryScanFailure = "after";
  const detail: any = await new HealthDetail().get();

  expect(detail.agents.count).toBe(0);
  expect(detail.agents.perAgent).toEqual([]);
  expect(detail.agents.unregisteredMemoryAuthors).toBeNull();

  const output = await statusOutput(detail, []);
  expect(output).not.toMatch(/^Agents$/m);
  expect(output).toMatch(/Unregistered memory owners\s+unavailable — memory scan did not complete/);
  expect(output).not.toContain("operator-seed");
});

test("no Agent registered and an incomplete scan: deep status says unavailable and shows no partial author", async () => {
  agentRows = [];
  memoryScanFailure = "after";
  const detail: any = await new HealthDetail().get();

  expect(detail.agents.count).toBe(0);
  expect(detail.agents.perAgent).toEqual([]);
  expect(detail.agents.unregisteredMemoryAuthors).toBeNull();

  const output = await statusOutput(detail, ["deep"]);
  expect(output).not.toContain("═══ Agents");
  expect(output).toContain("Unregistered memory owners: unavailable — memory scan did not complete");
  expect(output).not.toContain("operator-seed");
});

test("a completed scan with every author registered: the list is empty and neither renderer prints the line", async () => {
  memoryRows = [
    { id: "m-1", agentId: "agent-a", createdAt: new Date(NOW - 1000).toISOString(), embeddingModel: "fixture-model" },
  ];
  const detail: any = await new HealthDetail().get();

  expect(detail.agents.unregisteredMemoryAuthors).toEqual([]);
  expect(await statusOutput(detail, [])).not.toContain("Unregistered memory owners");
  expect(await statusOutput(detail, ["deep"])).not.toContain("Unregistered memory owners");
});

test("duplicate-id and missing-id Agent rows: count, names and perAgent are one set", async () => {
  agentRows = [{ id: "agent-a" }, { id: "agent-a" }, {}];
  memoryRows = [];
  const detail: any = await new HealthDetail().get();

  expect(detail.agents.count).toBe(1);
  expect(detail.agents.names).toEqual(["agent-a"]);
  expect(detail.agents.perAgent.map((r: any) => r.id)).toEqual(["agent-a"]);
  expect(detail.agents.count).toBe(detail.agents.names.length);
  expect(detail.agents.count).toBe(detail.agents.perAgent.length);
});

// ── Stored text reaches the terminal escaped (flair#3082 item 1) ──────────────
// ESC, newline, DEL, a C1 control, a bidi override, U+2028, a lone surrogate,
// an unassigned code point and U+2029 in a stored id are shown as \u{...}
// escapes; ordinary non-ASCII text prints unchanged.
const HOSTILE_ID = "\x1b[31mred\n\x7f\u0085\u202e\u2028\ud800\u0378\u2029";
const HOSTILE_ESCAPED = "\\u{1b}[31mred\\u{0a}\\u{7f}\\u{85}\\u{202e}\\u{2028}\\u{d800}\\u{378}\\u{2029}";
const HOSTILE_UNREGISTERED_ID = "\u009bseed\n\x1b\u202e\u2028\x7f";
const HOSTILE_UNREGISTERED_ESCAPED = "\\u{9b}seed\\u{0a}\\u{1b}\\u{202e}\\u{2028}\\u{7f}";
const NORMAL_ID = "ágætis-vík";

function memoryRow(id: string, agentId: string, model = "fixture-model") {
  return { id, agentId, createdAt: new Date(NOW - 1000).toISOString(), embeddingModel: model };
}

function lineWith(output: string, marker: string): string {
  return output.split("\n").find((line) => line.includes(marker)) ?? "";
}

test("plain status escapes a stored id in the names line, the table row and the unregistered line; a normal name is unchanged", async () => {
  agentRows = [{ id: HOSTILE_ID }, { id: NORMAL_ID }];
  memoryRows = [memoryRow("m-1", HOSTILE_ID), memoryRow("m-2", HOSTILE_UNREGISTERED_ID)];
  const detail: any = await new HealthDetail().get();

  const output = await statusOutput(detail, []);
  const namesLine = output.split("\n").find((line) => line.includes("Total") && line.includes(HOSTILE_ESCAPED)) ?? "";
  expect(namesLine).toContain(`2 — ${HOSTILE_ESCAPED}, ${NORMAL_ID}`);
  const tableLine = output.split("\n").find((line) => line.trimStart().startsWith(HOSTILE_ESCAPED)) ?? "";
  expect(tableLine).not.toContain("Total");
  expect(tableLine).toContain(HOSTILE_ESCAPED);
  expect(lineWith(output, "Unregistered memory owners")).toContain(HOSTILE_UNREGISTERED_ESCAPED);
  expect(output).toContain(HOSTILE_ESCAPED);
  expect(output).toContain(HOSTILE_UNREGISTERED_ESCAPED);
  expect(output).toContain(NORMAL_ID);
  for (const raw of ["\x1b", "\x7f", "\u0085", "\u202e", "\u2028", "\u009b", "\ud800", "\u0378", "\u2029"]) {
    expect(output.includes(raw)).toBe(false);
  }
});

test("deep status escapes a stored id in the names line, the table row and the unregistered line; a normal name is unchanged", async () => {
  agentRows = [{ id: HOSTILE_ID }, { id: NORMAL_ID }];
  memoryRows = [memoryRow("m-1", HOSTILE_ID), memoryRow("m-2", HOSTILE_UNREGISTERED_ID)];
  const detail: any = await new HealthDetail().get();

  const output = await statusOutput(detail, ["deep"]);
  expect(lineWith(output, "Names:")).toContain(`${HOSTILE_ESCAPED}, ${NORMAL_ID}`);
  expect(lineWith(output, "Names:").includes(NORMAL_ID)).toBe(true);
  const tableRows = output.split("\n").filter((line) => line.startsWith("  ") && line.includes(HOSTILE_ESCAPED));
  expect(tableRows.length).toBeGreaterThan(0);
  expect(lineWith(output, "Unregistered memory owners")).toContain(HOSTILE_UNREGISTERED_ESCAPED);
  expect(output).toContain(HOSTILE_ESCAPED);
  expect(output).toContain(HOSTILE_UNREGISTERED_ESCAPED);
  expect(output).toContain(NORMAL_ID);
  for (const raw of ["\x1b", "\x7f", "\u0085", "\u202e", "\u2028", "\u009b", "\ud800", "\u0378", "\u2029"]) {
    expect(output.includes(raw)).toBe(false);
  }
});

test("each escaped category escapes; other non-ASCII text does not", async () => {
  const { escapeTerminalText } = await import("../../src/lib/terminal-text.ts");
  const cases: Array<[string, string]> = [
    ["\x1b", "\\u{1b}"],
    ["\u202e", "\\u{202e}"],
    ["\ud800", "\\u{d800}"],
    ["\u0378", "\\u{378}"],
    ["\u2028", "\\u{2028}"],
    ["\u2029", "\\u{2029}"],
  ];
  for (const [raw, escaped] of cases) expect(escapeTerminalText(raw)).toBe(escaped);
  expect(escapeTerminalText(NORMAL_ID)).toBe(NORMAL_ID);
});

test("the bootstrap table escapes the agent id it measured", async () => {
  agentRows = [{ id: HOSTILE_ID }];
  memoryRows = [];
  process.env.HDB_ADMIN_PASSWORD = "fixture-pass";
  const fetchSpy = globalThis.fetch as any;
  fetchSpy.mockResolvedValue(new Response("{}", { status: 200 }));
  try {
    const detail: any = await new HealthDetail().get();
    const output = await statusOutput(detail, ["deep", "--bootstrap"]);
    expect(output).toContain("Bootstrap context");
    const bootstrapRow = output.split("\n").find((line) => line.trimStart().startsWith(HOSTILE_ESCAPED) && line.trimEnd().endsWith("ok")) ?? "";
    expect(bootstrapRow).toContain(HOSTILE_ESCAPED);
    expect(output.includes("\x1b")).toBe(false);
  } finally {
    delete process.env.HDB_ADMIN_PASSWORD;
    fetchSpy.mockClear();
  }
});

// ── An incomplete Memory scan reports unknown, never partial (flair#3082 item 2) ──
test("a Memory scan that yields a row then throws: every displayed per-agent value reads unknown, plain and deep", async () => {
  agentRows = [{ id: "agent-a" }];
  memoryRows = [memoryRow("m-1", "agent-a")];
  memoryScanFailure = "after";
  const detail: any = await new HealthDetail().get();

  // The Agent roster still comes from the completed Agent scan …
  expect(detail.agents.count).toBe(1);
  expect(detail.agents.names).toEqual(["agent-a"]);
  // … but no Memory-derived value survives the failed scan, not even the one
  // row it yielded before throwing.
  expect(detail.agents.perAgent).toEqual([
    { id: "agent-a", memoryCount: null, hashFallback: null, writes24h: null, lastWriteAt: null, usageCount: null },
  ]);

  const plain = await statusOutput(detail, []);
  expect(plain).toMatch(/agent-a\s+unknown\s+unknown/);
  expect(plain).not.toMatch(/agent-a\s+1\b/);

  const deep = await statusOutput(detail, ["deep"]);
  expect(deep).toMatch(/agent-a\s+unknown\s+unknown\s+unknown\s+unknown/);
  expect(deep).not.toMatch(/agent-a\s+1\b/);
});

test("a Memory scan that throws before any row: every displayed per-agent value reads unknown, plain and deep", async () => {
  agentRows = [{ id: "agent-a" }];
  memoryScanFailure = "before";
  const detail: any = await new HealthDetail().get();

  expect(detail.agents.perAgent).toEqual([
    { id: "agent-a", memoryCount: null, hashFallback: null, writes24h: null, lastWriteAt: null, usageCount: null },
  ]);
  expect(await statusOutput(detail, [])).toMatch(/agent-a\s+unknown\s+unknown/);
  expect(await statusOutput(detail, ["deep"])).toMatch(/agent-a\s+unknown\s+unknown\s+unknown\s+unknown/);
});

// ── The other stored text on the same human paths is escaped too ─────────────
// Bridge-installed names, disk paths, the REM nightly timestamp, bootstrap
// error text, embedding-model names, Soul keys, federation instance and peer
// fields, OAuth client and IdP fields, warning messages and raw timestamps.
const H = HOSTILE_ID;

function hostileDetail() {
  return {
    ok: true,
    memories: {
      total: 1, withEmbeddings: 1, hashFallback: 0, archived: 0, expired: 0,
      modelCounts: { [H]: 1 },
      byDurability: { permanent: 0, persistent: 0, standard: 1, ephemeral: 0 },
    },
    lastWrite: "2026-11-22T11:59:59.000Z" + H,
    warnings: [{ level: "warn", message: H }],
    soul: { total: 1, byKey: { [H]: 1 } },
    federation: {
      instance: { id: H, role: H, status: H },
      peers: { total: 1, connected: 1, disconnected: 0, revoked: 0, unknown: 0 },
      peerList: [{ id: H, role: H, status: H, liveness: H, lastSyncAt: "2026-11-21T10:00:00.000Z" + H }],
      pendingTokens: 0,
    },
    oauth: { clients: 1, idpConfigs: 0, activeTokens: 0, clientList: [{ id: H, name: H, registeredBy: H, createdAt: H }] },
  };
}

test("plain status escapes model names, Soul keys, federation instance fields and warning text", async () => {
  const output = await statusOutput(hostileDetail(), []);

  expect(lineWith(output, "Embeddings")).toContain(`${HOSTILE_ESCAPED}:1`);
  expect(lineWith(output, "Entries")).toContain(`${HOSTILE_ESCAPED}:1`);
  expect(lineWith(output, "Instance")).toContain(`${HOSTILE_ESCAPED}  (${HOSTILE_ESCAPED}, ${HOSTILE_ESCAPED})`);
  expect(output.split("\n").find((line) => line.trimStart().startsWith("⚠"))).toContain(HOSTILE_ESCAPED);
  expect(output.includes("\x1b")).toBe(false);
  expect(output.includes("\u202e")).toBe(false);
});

test("deep status escapes model names, raw times, Soul keys, federation and peer fields, OAuth fields and warnings", async () => {
  const output = await statusOutput(hostileDetail(), ["deep"]);

  expect(lineWith(output, "(100.0%)")).toContain(HOSTILE_ESCAPED);
  expect(lineWith(output, "Last write:")).toContain(`(${"2026-11-22T11:59:59.000Z"}${HOSTILE_ESCAPED})`);
  expect(lineWith(output, "Keys:")).toContain(`1 ${HOSTILE_ESCAPED}`);
  expect(lineWith(output, "Instance:")).toContain(`${HOSTILE_ESCAPED} (${HOSTILE_ESCAPED}, ${HOSTILE_ESCAPED})`);
  expect(lineWith(output, "2026-11-21T10:00:00.000Z" + HOSTILE_ESCAPED)).toContain(HOSTILE_ESCAPED);
  expect(output).toContain(`    ${HOSTILE_ESCAPED}  ${HOSTILE_ESCAPED}  ${HOSTILE_ESCAPED}  ${HOSTILE_ESCAPED}`);
  expect(output.split("\n").find((line) => line.trimStart().startsWith("⚠"))).toContain(HOSTILE_ESCAPED);
  expect(output.includes("\x1b")).toBe(false);
  expect(output.includes("\u202e")).toBe(false);
});

function hostileRemainingDetail() {
  return {
    ok: true,
    agents: { count: 1, names: ["agent-a"], perAgent: [{ id: "agent-a", memoryCount: 0, hashFallback: 0, writes24h: 0, lastWriteAt: null }] },
    bridges: { installed: [H], lastImport: null, lastExport: null },
    disk: { dataDir: H, snapshotDir: H, dataBytes: 0, snapshotBytes: 0 },
    rem: { lastNightlyAt: "2026-11-21T09:00:00.000Z" + H },
  };
}

test("plain and deep status escape bridge names and disk paths; deep escapes the REM nightly timestamp", async () => {
  for (const args of [[], ["deep"]]) {
    const output = await statusOutput(hostileRemainingDetail(), args);
    expect(lineWith(output, "Installed"), JSON.stringify(args)).toContain(HOSTILE_ESCAPED);
    expect(lineWith(output, "Data"), JSON.stringify(args)).toContain(HOSTILE_ESCAPED);
    expect(lineWith(output, "Snapshots"), JSON.stringify(args)).toContain(HOSTILE_ESCAPED);
    for (const raw of ["\x1b", "\u202e", "\u2028", "\ud800", "\u0378", "\u2029"]) {
      expect(output.includes(raw), JSON.stringify(args)).toBe(false);
    }
  }
  const deep = await statusOutput(hostileRemainingDetail(), ["deep"]);
  expect(lineWith(deep, "Last nightly")).toContain(`(${"2026-11-21T09:00:00.000Z"}${HOSTILE_ESCAPED})`);
});

test("status federation escapes each stored instance and peer field; JSON keeps the same fixture byte-identical", async () => {
  process.env.FLAIR_OUTPUT = "human";
  let human: string;
  try {
    human = await statusOutput(hostileDetail(), ["federation"]);
  } finally {
    delete process.env.FLAIR_OUTPUT;
  }

  expect(lineWith(human, "Instance")).toContain(`${HOSTILE_ESCAPED}  (${HOSTILE_ESCAPED}, ${HOSTILE_ESCAPED})`);
  const peerRow = human.split("\n").find((line) => line.includes("2026-11-21T10:00:00.000Z")) ?? "";
  // peer id, role, status, liveness and the raw last-sync timestamp each carry the fixture.
  expect(peerRow.split(HOSTILE_ESCAPED).length - 1).toBe(5);
  expect(peerRow).toContain(`(2026-11-21T10:00:00.000Z${HOSTILE_ESCAPED})`);
  for (const raw of ["\x1b", "\u202e", "\u2028", "\ud800", "\u0378", "\u2029"]) {
    expect(human.includes(raw)).toBe(false);
  }

  const json = await statusOutput(hostileDetail(), ["--json", "federation"]);
  expect(json).toBe(JSON.stringify({ healthy: true, federation: hostileDetail().federation }, null, 2));
  const parsed = JSON.parse(json);
  expect(parsed).toEqual({ healthy: true, federation: hostileDetail().federation });
  expect(parsed.federation.instance.id).toBe(H);
  expect(parsed.federation.peerList[0]).toEqual(hostileDetail().federation.peerList[0]);
});

test("status rem escapes the stored nightly timestamp; JSON keeps the same fixture byte-identical", async () => {
  const detail = { ok: true, rem: { lastNightlyAt: "2026-11-21T09:00:00.000Z" + H, nightlyEnabled: true, pendingCandidates: 0 } };
  process.env.FLAIR_OUTPUT = "human";
  let human: string;
  try {
    human = await statusOutput(detail, ["rem"]);
  } finally {
    delete process.env.FLAIR_OUTPUT;
  }

  expect(lineWith(human, "Last nightly")).toContain(`(2026-11-21T09:00:00.000Z${HOSTILE_ESCAPED})`);
  for (const raw of ["\x1b", "\u202e", "\u2028", "\ud800", "\u0378", "\u2029"]) {
    expect(human.includes(raw)).toBe(false);
  }

  const json = await statusOutput(detail, ["--json", "rem"]);
  expect(json).toBe(JSON.stringify({ healthy: true, rem: detail.rem }, null, 2));
  const parsed = JSON.parse(json);
  expect(parsed).toEqual({ healthy: true, rem: detail.rem });
  expect(parsed.rem.lastNightlyAt).toBe(detail.rem.lastNightlyAt);
});

test("deep status escapes bootstrap error text", async () => {
  process.env.HDB_ADMIN_PASSWORD = "fixture-pass";
  const fetchSpy = globalThis.fetch as any;
  fetchSpy.mockRejectedValue(new Error("boom" + H));
  try {
    const output = await statusOutput(hostileRemainingDetail(), ["deep", "--bootstrap"]);
    const row = output.split("\n").find((line) => line.startsWith("  agent-a") && line.includes("error")) ?? "";
    expect(row).toContain(`boom${HOSTILE_ESCAPED}`);
    expect(output.includes("\x1b")).toBe(false);
  } finally {
    delete process.env.HDB_ADMIN_PASSWORD;
    fetchSpy.mockClear();
  }
});

test("status auth escapes client and IdP fields", async () => {
  process.env.FLAIR_OUTPUT = "human";
  let output: string;
  try {
    output = await statusOutput({
      oauth: {
        clients: 1, idpConfigs: 1, activeTokens: 0,
        clientList: [{ id: H, name: H, registeredBy: H, createdAt: H }],
        idpList: [{ id: H, name: H, issuer: H }],
      },
    }, ["auth"]);
  } finally {
    delete process.env.FLAIR_OUTPUT;
  }

  const idpAt = output.indexOf("IdPs");
  expect(idpAt).toBeGreaterThan(0);
  const clientsSection = output.slice(output.indexOf("Clients"), idpAt);
  const idpSection = output.slice(idpAt);
  expect(clientsSection).toContain(`${HOSTILE_ESCAPED}  ${HOSTILE_ESCAPED}  ${HOSTILE_ESCAPED}  ${HOSTILE_ESCAPED}`);
  expect(idpSection).toContain(`${HOSTILE_ESCAPED}  ${HOSTILE_ESCAPED}  ${HOSTILE_ESCAPED}`);
  for (const raw of ["\x1b", "\u202e", "\u2028", "\ud800", "\u0378", "\u2029"]) {
    expect(output.includes(raw)).toBe(false);
  }
});

test("a real temporary bridge filename reaches the human line escaped", async () => {
  const home = tempDir("bridge-3082-");
  const base = join(home, "node_modules");
  await nativeFsp.mkdir(base, { recursive: true });
  const rawName = "flair-bridge-\u202e\u2028\u2029";
  await nativeFsp.writeFile(join(base, rawName), "");
  const previousCwd = process.cwd();
  realBridgeBase = base;
  process.chdir(home);
  try {
    const detail: any = await new HealthDetail().get();
    expect(detail.bridges.installed).toContain(rawName);

    const output = await statusOutput(detail, ["deep"]);
    expect(lineWith(output, "Installed")).toContain("flair-bridge-\\u{202e}\\u{2028}\\u{2029}");
    for (const raw of ["\u202e", "\u2028", "\u2029"]) expect(output.includes(raw)).toBe(false);
  } finally {
    realBridgeBase = null;
    process.chdir(previousCwd);
  }
});

test("deep status escapes a REM last-distilled timestamp read from a real nightly JSONL file", async () => {
  const home = tempDir("rem-3082-");
  const logs = join(home, ".flair", "logs");
  await nativeFsp.mkdir(logs, { recursive: true });
  const distilledAt = "Nov\x1b 21 2026";
  expect(Number.isFinite(Date.parse(distilledAt))).toBe(true);
  await nativeFsp.writeFile(join(logs, "rem-nightly.jsonl"), JSON.stringify({
    status: "completed",
    distilledAt,
    distill: { gathered: 3 },
  }) + "\n");
  realHome = home;
  realRemLog = join(logs, "rem-nightly.jsonl");
  try {
    const detail: any = await new HealthDetail().get();
    expect(detail.rem.lastDistilledAt).toBe(distilledAt);
    const deep = await statusOutput(detail, ["deep"]);
    expect(deep).toContain("Nov\\u{1b} 21 2026");
    expect(deep.includes("\x1b")).toBe(false);
  } finally {
    realHome = null;
    realRemLog = null;
  }
});

test("plain and deep status escape a BM25 summary from the real HealthDetail", async () => {
  bm25Status = { state: "ready", summary: "ready · 817 docs" + H };
  const detail: any = await new HealthDetail().get();
  expect(detail.bm25.summary).toContain("\x1b");
  for (const args of [[], ["deep"]]) {
    const output = await statusOutput(detail, args);
    expect(output, JSON.stringify(args)).toContain("ready · 817 docs\\u{1b}[31mred");
    expect(output.includes("\x1b"), JSON.stringify(args)).toBe(false);
  }
});
