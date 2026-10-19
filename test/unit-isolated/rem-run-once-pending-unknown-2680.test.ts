import { expect, mock, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Command } from "commander";
import { bindCli, register } from "../../src/commands/rem.ts";

// flair#2680: a failed ops-API pending-candidate query prints as unknown with
// its reason and fails the run; it never prints as `Pending: 0`.
const OPS_PORT = 1;
const OPS_URL = `http://127.0.0.1:${OPS_PORT}/`;

type Scenario = { name: string; ops: () => Promise<Response>; pending: string; error?: string; sentinel?: string };

const scenarios: Scenario[] = [
  { name: "count", ops: async () => new Response(JSON.stringify([{ id: "c1" }, { id: "c2" }])), pending: "2" },
  { name: "empty", ops: async () => new Response("[]"), pending: "0" },
  {
    name: "non-ok",
    ops: async () => new Response("unauthorized", { status: 401 }),
    pending: "unknown (ops API failed (401))",
    error: "pending-count: ops API failed (401)",
  },
  {
    name: "unexpected body",
    ops: async () => new Response(JSON.stringify({ error: "fixture" })),
    pending: "unknown (ops API returned an unexpected response shape)",
    error: "pending-count: ops API returned an unexpected response shape",
  },
  {
    name: "invalid JSON",
    ops: async () => {
      const response = new Response("sentinel2683");
      response.json = async () => JSON.parse(await response.text());
      return response;
    },
    pending: "unknown (ops API returned invalid JSON)",
    error: "pending-count: ops API returned invalid JSON",
    sentinel: "sentinel2683",
  },
  {
    name: "rejected",
    ops: async () => { throw new Error("connect ECONNREFUSED fixture"); },
    pending: "unknown (connect ECONNREFUSED fixture)",
    error: "pending-count: connect ECONNREFUSED fixture",
  },
];

test("flair rem nightly run-once prints a failed pending-candidate count as unknown and fails the run", async () => {
  const output: string[] = [];
  const log = spyOn(console, "log").mockImplementation((...args: unknown[]) => { output.push(args.map(String).join(" ")); });
  const exit = spyOn(process, "exit").mockImplementation((() => {}) as never);
  let scenario = scenarios[0];
  const opsTargets: string[] = [];
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (url: unknown) => {
    const target = String(url);
    if (target.endsWith("/Health")) return new Response("{}");
    opsTargets.push(target);
    if (target !== OPS_URL) throw new Error(`unexpected fetch target ${target}`);
    return scenario.ops();
  }) as typeof fetch);
  const saved = { pause: process.env.FLAIR_REM_PAUSE, admin: process.env.FLAIR_ADMIN_PASS, hdb: process.env.HDB_ADMIN_PASSWORD };
  delete process.env.FLAIR_REM_PAUSE;
  delete process.env.HDB_ADMIN_PASSWORD;
  process.env.FLAIR_ADMIN_PASS = "fixture-admin-pass";
  bindCli({
    api: async (method: string, path: string) => {
      if (method === "GET") return [];
      if (path === "/MemoryMaintenance") return { archived: 0, expired: 0 };
      if (path === "/ReflectMemories") return { candidates: [], count: 0, gathered: 1, unreflected: 1 };
      if (path === "/MemoryDedupStats") return { clusterCount: 0, largestClusterSize: 0, totalMemoriesInClusters: 0, computedAt: "fixture" };
      throw new Error("unexpected route " + path);
    },
    resolveOpsPort: () => OPS_PORT, applyAdminPassFile: () => {}, addSharedCredentialOptions: (command) => command,
    readPortFromConfig: () => null, resolveHttpPort: () => 1, resolveEffectiveOpsUrl: () => undefined, resolveAgentHomeTarget: () => ({ httpPort: 1, opsPort: 1 }), humanBytes: String, relativeTime: String,
    DEFAULT_PORT: 1, pkgVersion: "fixture",
  });
  try {
    const { REM_NIGHTLY_LOG } = await import("../../src/rem/runner.ts");
    for (scenario of scenarios) {
      exit.mockClear();
      output.length = 0;
      opsTargets.length = 0;
      const program = new Command();
      register(program);
      await program.parseAsync(["rem", "nightly", "run-once", "--agent", "fixture", "--dry-run"], { from: "user" });
      const text = output.join("\n");
      if (scenario.sentinel) {
        const auditLine = readFileSync(REM_NIGHTLY_LOG, "utf8").trimEnd().split("\n").at(-1)!;
        expect(text, scenario.name).not.toContain(scenario.sentinel);
        expect(auditLine, scenario.name).not.toContain(scenario.sentinel);
        expect(JSON.parse(auditLine).errors, scenario.name).toEqual([scenario.error]);
      }
      expect(opsTargets, scenario.name).toEqual([OPS_URL]);
      expect(text, scenario.name).toContain(`\nPending:    ${scenario.pending}\n`);
      if (scenario.error) {
        expect(text, scenario.name).not.toMatch(/Pending:\s+0\b/);
        expect(text, scenario.name).toContain("Status:     failed");
        expect(text, scenario.name).toContain(`Errors:\n  - ${scenario.error}`);
        expect(exit.mock.calls, scenario.name).toEqual([[1]]);
      } else {
        expect(text, scenario.name).toContain("Status:     dry-run");
        expect(text, scenario.name).not.toContain("Errors:");
        expect(exit, scenario.name).not.toHaveBeenCalled();
      }
    }
    expect(fetchSpy).toHaveBeenCalledTimes(scenarios.length * 2);
  } finally {
    for (const [key, value] of [["FLAIR_REM_PAUSE", saved.pause], ["FLAIR_ADMIN_PASS", saved.admin], ["HDB_ADMIN_PASSWORD", saved.hdb]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    log.mockRestore();
    mock.restore();
  }
});

test("a healthy flair rem nightly run-once dry run without an admin credential prints the count as unknown, not 0", async () => {
  const output: string[] = [];
  const log = spyOn(console, "log").mockImplementation((...args: unknown[]) => { output.push(args.map(String).join(" ")); });
  const exit = spyOn(process, "exit").mockImplementation((() => {}) as never);
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (url: unknown) => {
    if (String(url).endsWith("/Health")) return new Response("{}");
    throw new Error(`unexpected fetch target ${String(url)}`);
  }) as typeof fetch);
  const saved = { pause: process.env.FLAIR_REM_PAUSE, admin: process.env.FLAIR_ADMIN_PASS, hdb: process.env.HDB_ADMIN_PASSWORD };
  delete process.env.FLAIR_REM_PAUSE;
  delete process.env.FLAIR_ADMIN_PASS;
  delete process.env.HDB_ADMIN_PASSWORD;
  bindCli({
    api: async (method: string) => {
      if (method === "GET") return [];
      return { archived: 0, expired: 0 };
    },
    resolveOpsPort: () => OPS_PORT, applyAdminPassFile: () => {}, addSharedCredentialOptions: (command) => command,
    readPortFromConfig: () => null, resolveHttpPort: () => 1, resolveEffectiveOpsUrl: () => undefined, resolveAgentHomeTarget: () => ({ httpPort: 1, opsPort: 1 }), humanBytes: String, relativeTime: String,
    DEFAULT_PORT: 1, pkgVersion: "fixture",
  });
  try {
    const program = new Command();
    register(program);
    await program.parseAsync(["rem", "nightly", "run-once", "--agent", "fixture", "--dry-run"], { from: "user" });
    const text = output.join("\n");
    expect(text).toContain("\nPending:    unknown (no admin credential for the operations API)\n");
    expect(text).not.toMatch(/Pending:\s+0\b/);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  } finally {
    for (const [key, value] of [["FLAIR_REM_PAUSE", saved.pause], ["FLAIR_ADMIN_PASS", saved.admin], ["HDB_ADMIN_PASSWORD", saved.hdb]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    log.mockRestore();
    mock.restore();
  }
});
