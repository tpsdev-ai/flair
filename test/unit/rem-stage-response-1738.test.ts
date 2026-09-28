import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../helpers/temp-dir.ts";
import { runNightlyCycle } from "../../src/rem/runner.ts";

const stages = ["maintenance", "all", "adk", "continuity", "auto-promote", "dedup"];
for (const stage of stages) {
  for (const [label, body] of [["null", null], ["string", ""], ["number", 1], ["boolean", false], ["array", []], ["undefined", undefined], ["object", { candidates: [], count: 0, expired: 0, archived: 0, clusterCount: 0, largestClusterSize: 0, totalMemoriesInClusters: 0, computedAt: "fixture" }]] as const) {
    test("stage response " + stage + ": " + label, async () => {
      const root = tempDir("flair-rem-1738-");
      const logPath = join(root, "run.jsonl");
      const now = new Date("2026-01-02T12:00:00Z");
      let reached = 0;
      const result = await runNightlyCycle({
        agentId: "fixture", flairVersion: "test", nowOverride: now,
        snapshotRoot: join(root, "snapshots"), logPath,
        pauseFlagPath: join(root, "pause"), envPaused: false,
        healthProbe: async () => ({ ok: true, elapsedMs: 0 }),
        apiCall: async (method, path, request: any) => {
          if (method === "GET" && path.startsWith("/Memory?")) return stage === "all" ? [] : [{
            id: "m", agentId: "fixture", durability: "ephemeral",
            createdAt: "2026-01-02T08:00:00Z",
            tags: ["adk:app:user", "adk:continuity:session"],
          }];
          if (method === "GET" && path.startsWith("/Soul?")) return [];
          const selected = path === "/MemoryMaintenance" ? "maintenance"
            : path === "/MemoryDedupStats" ? "dedup"
            : path === "/AutoPromoteCandidates" ? "auto-promote"
            : request.focus === "continuity" ? "continuity"
            : request.scope === "all" ? "all" : "adk";
          if (selected === stage) { reached++; return body; }
          if (path === "/MemoryMaintenance") return { expired: 0, archived: 0 };
          if (path === "/ReflectMemories") return { candidates: [] };
          if (path === "/AutoPromoteCandidates") return { count: 0, skipped: [] };
          if (path === "/MemoryDedupStats") return { clusterCount: 0, largestClusterSize: 0, totalMemoriesInClusters: 0, computedAt: "fixture" };
          throw new Error("unexpected API call");
        },
      });
      expect(reached).toBe(1);
      expect(result.status).toBe(label === "object" ? "completed" : "failed");
      expect(result.logRow.errors.some(e => e.includes("response shape"))).toBe(label !== "object");
      const logged = JSON.parse(readFileSync(logPath, "utf8"));
      expect(logged.status).toBe(result.status);
      expect(logged.errors).toEqual(result.logRow.errors);
    });
  }
}
