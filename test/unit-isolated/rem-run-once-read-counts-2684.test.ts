import { expect, mock, spyOn, test } from "bun:test";
import { Command } from "commander";
import { bindCli, register } from "../../src/commands/rem.ts";

// flair#2684: a failed Memory or Soul read prints as `unknown (<reason>)` and
// is named under Errors; it never prints as an empty-store `0`.
type Scenario = { name: string; memory?: () => any; soul?: () => any; line: "Memories:" | "Souls:"; reason: string };

const scenarios: Scenario[] = [
  {
    name: "GET /Memory fails",
    memory: () => { throw new Error("memory read refused 503"); },
    line: "Memories:",
    reason: "memory read refused 503",
  },
  {
    name: "the Soul read fails",
    memory: () => [{ id: "m1" }, { id: "m2" }],
    soul: () => { throw new Error("soul read refused 503"); },
    line: "Souls:",
    reason: "soul read refused 503",
  },
  {
    name: "GET /Memory returns an unrecognised body",
    memory: () => ({ error: "fixture" }),
    line: "Memories:",
    reason: "GET /Memory returned an unexpected response shape",
  },
];

test("flair rem nightly run-once prints a failed read count as unknown, names it under Errors, and fails", async () => {
  const output: string[] = [];
  const log = spyOn(console, "log").mockImplementation((...args: unknown[]) => { output.push(args.map(String).join(" ")); });
  const exit = spyOn(process, "exit").mockImplementation((() => {}) as never);
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => new Response("{}")) as unknown as typeof fetch);
  const saved = { pause: process.env.FLAIR_REM_PAUSE, admin: process.env.FLAIR_ADMIN_PASS, hdb: process.env.HDB_ADMIN_PASSWORD };
  delete process.env.FLAIR_REM_PAUSE;
  delete process.env.FLAIR_ADMIN_PASS;
  delete process.env.HDB_ADMIN_PASSWORD;
  let scenario = scenarios[0];
  bindCli({
    api: async (method: string, path: string) => {
      if (method === "GET" && path.startsWith("/Memory?")) return scenario.memory ? scenario.memory() : [];
      if (method === "GET" && path.startsWith("/Soul?")) return scenario.soul ? scenario.soul() : [];
      if (method === "GET") return [];
      if (path === "/MemoryMaintenance") return { archived: 0, expired: 0 };
      if (path === "/ReflectMemories") return { candidates: [], count: 0, gathered: 1, unreflected: 1 };
      if (path === "/MemoryDedupStats") return { clusterCount: 0, largestClusterSize: 0, totalMemoriesInClusters: 0, computedAt: "fixture" };
      throw new Error("unexpected route " + path);
    },
    resolveOpsPort: () => 1, applyAdminPassFile: () => {}, addSharedCredentialOptions: (command) => command,
    readPortFromConfig: () => null, resolveHttpPort: () => 1, resolveOpsUrlFromTarget: () => { throw new Error("unused"); }, resolveAgentHomeTarget: () => ({ httpPort: 1, opsPort: 1 }), INSTANCE_TARGET_REMEDY: "", humanBytes: String, relativeTime: String,
    DEFAULT_PORT: 1, pkgVersion: "fixture",
  });
  try {
    for (scenario of scenarios) {
      exit.mockClear();
      output.length = 0;
      const program = new Command();
      register(program);
      await program.parseAsync(["rem", "nightly", "run-once", "--agent", "fixture", "--dry-run"], { from: "user" });
      const text = output.join("\n");
      const pad = scenario.line === "Memories:" ? "   " : "      ";
      expect(text, scenario.name).toContain(`\n${scenario.line}${pad}unknown (${scenario.reason})\n`);
      expect(text, scenario.name).not.toMatch(new RegExp(`${scenario.line}\\s+0\\b`));
      expect(text, scenario.name).toContain("Status:     failed");
      expect(text, scenario.name).toContain("Errors:\n  - ");
      expect(text, scenario.name).toContain(scenario.reason);
      expect(exit.mock.calls, scenario.name).toEqual([[1]]);
    }
    expect(fetchSpy).toHaveBeenCalledTimes(scenarios.length);
  } finally {
    for (const [key, value] of [["FLAIR_REM_PAUSE", saved.pause], ["FLAIR_ADMIN_PASS", saved.admin], ["HDB_ADMIN_PASSWORD", saved.hdb]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    log.mockRestore();
    mock.restore();
  }
});
