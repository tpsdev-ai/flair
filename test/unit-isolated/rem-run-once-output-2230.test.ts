import { expect, mock, spyOn, test } from "bun:test";
import { Command } from "commander";
import { bindCli, register } from "../../src/commands/rem.ts";
import { ApiHttpError } from "../../src/lib/auth-resolve.ts";

test("run-once prints skips with mixed dedup errors and exits only for errors", async () => {
  const output: string[] = [];
  const log = spyOn(console, "log").mockImplementation((...args: unknown[]) => { output.push(args.map(String).join(" ")); });
  const exit = spyOn(process, "exit").mockImplementation((() => {}) as never);
  const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
  const savedPause = process.env.FLAIR_REM_PAUSE;
  const savedAdmin = process.env.FLAIR_ADMIN_PASS;
  delete process.env.FLAIR_REM_PAUSE;
  delete process.env.FLAIR_ADMIN_PASS;
  let mixed = false;
  bindCli({
    api: async (method: string, path: string) => {
      if (method === "GET") return [];
      if (path === "/MemoryMaintenance") return { archived: 0, expired: 0 };
      if (path === "/ReflectMemories") throw new ApiHttpError(503, JSON.stringify({
        error: "No generative backend configured. See the models configuration docs.",
      }));
      if (path === "/MemoryDedupStats") {
        if (mixed) throw new ApiHttpError(403, "agent-identity dedup #809");
        return { clusterCount: 0, largestClusterSize: 0, totalMemoriesInClusters: 0, computedAt: "fixture" };
      }
      throw new Error("unexpected route " + path);
    },
    resolveOpsPort: () => 1, applyAdminPassFile: () => {}, addSharedCredentialOptions: (command) => command,
    readPortFromConfig: () => null, resolveHttpPort: () => 1, humanBytes: String, relativeTime: String,
    DEFAULT_PORT: 1, pkgVersion: "fixture",
  });
  try {
    for (mixed of [false, true]) {
      output.length = 0;
      const program = new Command();
      register(program);
      await program.parseAsync(["rem", "nightly", "run-once", "--agent", "fixture"], { from: "user" });
      const text = output.join("\n");
      expect(text).toContain("Skips:\n  - distillation skipped: no generative backend configured");
      expect(text).toContain("Archived:   0 (validTo-expired + old sessions)");
      expect(text).toContain("Expired:    0 (ephemeral rows past expiresAt)");
      if (mixed) {
        expect(text).toContain("Status:     failed");
        expect(text).toContain("Errors:\n  - dedup: agent-identity dedup #809");
        expect(exit.mock.calls).toEqual([[1]]);
      } else {
        expect(text).toContain("Status:     completed");
        expect(exit).not.toHaveBeenCalled();
      }
    }
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  } finally {
    if (savedPause === undefined) delete process.env.FLAIR_REM_PAUSE; else process.env.FLAIR_REM_PAUSE = savedPause;
    if (savedAdmin === undefined) delete process.env.FLAIR_ADMIN_PASS; else process.env.FLAIR_ADMIN_PASS = savedAdmin;
    log.mockRestore();
    mock.restore();
  }
});
