import { expect, mock, spyOn, test } from "bun:test";
import { Command } from "commander";
import { bindCli, register } from "../../src/commands/rem.ts";

// flair#2714: the registered `flair rem nightly run-once` command prints the
// auto-promote step's incomplete and unconfirmed promotions on its
// `Auto-promoted:` line, from the server's response, apart from the promoted
// and skipped counts. The API is a supplied double; the real-Harper response is
// covered by test/integration/auto-promote-incomplete-2714.test.ts.

const AUTO_PROMOTE_RESPONSE = {
  agentId: "fixture",
  promoted: ["fixture-promoted-1"],
  skipped: [{ id: "cand-skip", reason: "no_adk_scope_tag" }],
  incomplete: [
    { memoryId: "fixture-promoted-2", candidateId: "cand-2", error: "fixture update threw" },
    { memoryId: "fixture-promoted-3", candidateId: "cand-3", error: "fixture update threw" },
  ],
  unconfirmed: [{
    memoryId: "fixture-promoted-4", candidateId: "cand-4", error: "fixture update threw",
    readBack: "status rejected, promotedRowId fixture-promoted-4, reviewerId machine:adk-auto-promote",
  }],
  count: 1,
  considered: 5,
};

test("flair rem nightly run-once prints incomplete and unconfirmed auto-promotions on the Auto-promoted line", async () => {
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
  const calls: { method: string; path: string; body: any }[] = [];
  const createdAt = new Date().toISOString();
  bindCli({
    api: async (method: string, path: string, body?: unknown) => {
      calls.push({ method, path, body });
      // One active ADK tag in the snapshot, so the cycle distills it and then
      // runs the auto-promote step.
      if (method === "GET" && path.startsWith("/Memory?")) {
        return [{ id: "m-1", agentId: "fixture", content: "session", tags: ["adk:app:alice"], durability: "standard", createdAt }];
      }
      if (method === "GET") return [];
      if (path === "/MemoryMaintenance") return { archived: 0, expired: 0 };
      if (path === "/ReflectMemories") return { candidates: [{ id: "cand-1" }], count: 1, model: "fixture", gathered: 1, unreflected: 1 };
      if (path === "/AutoPromoteCandidates") return AUTO_PROMOTE_RESPONSE;
      if (path === "/MemoryDedupStats") return { clusterCount: 0, largestClusterSize: 0, totalMemoriesInClusters: 0, computedAt: "fixture" };
      throw new Error("unexpected route " + path);
    },
    resolveOpsPort: () => 1, applyAdminPassFile: () => {}, addSharedCredentialOptions: (command) => command,
    readPortFromConfig: () => null, resolveHttpPort: () => 1, resolveOpsUrlFromTarget: () => { throw new Error("unused"); }, resolveAgentHomeTarget: () => ({ httpPort: 1, opsPort: 1 }), INSTANCE_TARGET_REMEDY: "",
    humanBytes: String, relativeTime: String,
    DEFAULT_PORT: 1, pkgVersion: "fixture",
  });
  try {
    const program = new Command();
    register(program);
    await program.parseAsync(["rem", "nightly", "run-once", "--agent", "fixture"], { from: "user" });
    const text = output.join("\n");
    const sweeps = calls.filter((c) => c.method === "POST" && c.path === "/AutoPromoteCandidates");
    expect(sweeps.length, "the cycle ran the auto-promote step once").toBe(1);
    expect(sweeps[0].body.agentId).toBe("fixture");
    expect(text).toContain(
      "\nAuto-promoted: 1 to own memory (1 skipped); 2 incomplete (memory written, candidate update threw, candidate read back pending); 1 unconfirmed (memory written, candidate update threw, promotion on this row not confirmed)\n",
    );
    expect(text).not.toContain("left pending");
    expect(text).toContain("Status:     completed");
    expect(exit).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  } finally {
    for (const [key, value] of [["FLAIR_REM_PAUSE", saved.pause], ["FLAIR_ADMIN_PASS", saved.admin], ["HDB_ADMIN_PASSWORD", saved.hdb]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    log.mockRestore();
    mock.restore();
  }
});
