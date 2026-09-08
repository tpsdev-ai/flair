import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHarper, stopHarper } from "../helpers/harper-lifecycle";
import { runNightlyCycle } from "../../src/rem/runner";

// Run this file with deployment variables cleared, as in the integration lane.
test("nightly dedup includes live rows and serves reads during its vector sweep", async () => {
  if (process.env.HARPER_HTTP_URL) throw new Error("This fixture requires an isolated Harper");
  const scratch = mkdtempSync(join(tmpdir(), "rem-1515-"));
  const modelRequests: string[] = [];
  const ollama = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    modelRequests.push(new URL(request.url).pathname);
    const body = await request.json();
    const sourceId = body.prompt.match(/<memory id="([^"]+)"/)?.[1];
    await Bun.sleep(2000);
    return Response.json({ response: JSON.stringify({ candidates: [{
      claim: "Decided to measure HTTP responsiveness during nightly memory maintenance.",
      sourceMemoryIds: [sourceId],
    }] }), done: true });
  }});
  let harper: Awaited<ReturnType<typeof startHarper>> | undefined;
  try {
    harper = await startHarper({ appendRootConfigYaml: `models:\n  generative:\n    default:\n      backend: ollama\n      host: http://127.0.0.1:${ollama.port}\n      model: fixture\n` });
    const headers = { "Content-Type": "application/json", Authorization: `Basic ${btoa(`${harper.admin.username}:${harper.admin.password}`)}` };
    const op = async (body: unknown) => {
      const res = await fetch(harper!.opsURL, { method: "POST", headers, body: JSON.stringify(body) });
      expect(res.status, await res.clone().text()).toBe(200);
      return res.json();
    };
    // Sweep completion depends on runner CPU; concurrent reads retain their
    // separate two-second responsiveness deadline below.
    const request = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(`${harper!.httpURL}${path}`, { method, headers,
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(180000) });
      const value = await res.json();
      if (!res.ok) throw new Error(`${path}: ${res.status} ${JSON.stringify(value)}`);
      return value;
    };
    const createdAt = new Date().toISOString();
    const vector = [1, ...Array(767).fill(0)];
    const memory = (id: string, extra: Record<string, unknown> = {}) => ({
      id, agentId: "rem-fixture", content: `Fixture architectural decision ${id}`,
      type: "decision", durability: "standard", visibility: "private", createdAt,
      embedding: vector, embeddingModel: "nomic-embed-text-v1.5-Q4_K_M+searchprefix", ...extra,
    });
    await op({ operation: "insert", database: "flair", table: "Agent", records: [{
      id: "rem-fixture", role: "agent", name: "REM fixture",
      publicKey: Buffer.alloc(32, 1).toString("base64"), createdAt,
    }] });
    await op({ operation: "insert", database: "flair", table: "Memory", records: [
      memory("live-missing"), memory("live-false", { archived: false }),
      memory("live-other-agent", { agentId: "other-fixture", archived: false }),
      memory("archived-control", { archived: true }),
    ] });
    const small = await request("POST", "/MemoryDedupStats", {});
    expect(small).toMatchObject({ clusterCount: 1, largestClusterSize: 3, totalMemoriesInClusters: 3 });

    // Precomputed vectors avoid measuring background embedding generation.
    for (let offset = 0; offset < 3062; offset += 100) {
      await op({ operation: "insert", database: "flair", table: "Memory", records:
        Array.from({ length: Math.min(100, 3062 - offset) }, (_, i) => memory(`rem-${offset + i}`, {
          archived: (offset + i) % 2 ? false : undefined,
          embedding: Array.from({ length: 768 }, (_, j) => Math.sin((offset + i + 1) * (j + 1))),
        })) });
    }
    const observations: Array<{ path: string; elapsedMs: number; health: number[]; search: number[]; failures: string[] }> = [];
    const apiCall = async (method: string, path: string, body?: unknown) => {
      if (path !== "/ReflectMemories" && path !== "/MemoryDedupStats") return request(method, path, body);
      const begin = performance.now();
      let done = false;
      const observation = { path, elapsedMs: 0, health: [] as number[], search: [] as number[], failures: [] as string[] };
      const probe = (async () => {
        while (!done) {
          for (const kind of ["health", "search"] as const) {
            const t = performance.now();
            try {
              const res = await fetch(`${harper!.httpURL}/${kind === "health" ? "Health" : "SemanticSearch"}`, {
                method: kind === "health" ? "GET" : "POST", headers, signal: AbortSignal.timeout(2000),
                body: kind === "health" ? undefined : JSON.stringify({ agentId: "rem-fixture", queryEmbedding: vector, limit: 3 }),
              });
              await res.text();
              if (!res.ok) observation.failures.push(`${kind}: HTTP ${res.status}`);
            } catch (error) { observation.failures.push(`${kind}: ${String(error)}`); }
            observation[kind].push(performance.now() - t);
          }
          await Bun.sleep(50);
        }
      })();
      try { return await request(method, path, body); }
      finally {
        observation.elapsedMs = performance.now() - begin;
        done = true;
        await probe;
        observations.push(observation);
        console.log("REM responsiveness", JSON.stringify({ path, elapsedMs: observation.elapsedMs,
          healthMaxMs: Math.max(...observation.health), searchMaxMs: Math.max(...observation.search),
          probes: observation.health.length, failures: observation.failures }));
      }
    };
    const result = await runNightlyCycle({ agentId: "rem-fixture", flairVersion: "0.51.2", apiCall,
      snapshotRoot: join(scratch, "snapshots"), logPath: join(scratch, "nightly.jsonl"),
      pauseFlagPath: join(scratch, "paused"), envPaused: false });
    expect(result.status).toBe("completed");
    expect(result.logRow.errors).toEqual([]);
    expect(result.logRow.candidates).toHaveLength(1);
    expect(result.logRow.dedup!.totalMemoriesInClusters).toBeGreaterThanOrEqual(3);
    expect(modelRequests).toEqual(["/api/generate"]);
    expect(observations).toHaveLength(2);
    for (const observation of observations) {
      expect(observation.failures).toEqual([]);
      expect(observation.health.length).toBeGreaterThan(5);
      expect(Math.max(...observation.health)).toBeLessThan(2000);
      expect(Math.max(...observation.search)).toBeLessThan(2000);
    }
  } finally {
    if (harper) await stopHarper(harper);
    ollama.stop(true);
    rmSync(scratch, { recursive: true, force: true });
  }
}, 240000);
