import { afterAll, beforeAll, expect, test } from "bun:test";
import { cp, mkdtemp, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";

let harper: HarperInstance;
let appDir: string;
const root = process.cwd();
const auth = () => `Basic ${btoa(`${harper.admin.username}:${harper.admin.password}`)}`;
beforeAll(async () => {
  if (process.env.HARPER_HTTP_URL) throw new Error("bm25-metadata-updates requires an isolated Harper instance");
  appDir = await mkdtemp(join(tmpdir(), "flair-bm25-metadata-"));
  // Put the probe in Flair's own component scope: Harper isolates imported
  // module instances between components, including Bm25Index's prototype.
  for (const name of ["dist", "schemas", "config.yaml"]) {
    await cp(join(root, name), join(appDir, name), { recursive: true });
  }
  await cp(join(root, "test/fixtures/bm25-metadata-app/resources/Bm25MetadataProbe.js"),
    join(appDir, "dist/resources/Bm25MetadataProbe.js"));
  await symlink(join(root, "node_modules"), join(appDir, "node_modules"), "dir");
  harper = await startHarper({ cwd: appDir, harperBinDir: root });
  const records = Array.from({ length: 1000 }, (_, i) => ({
    id: `metadata-${String(i).padStart(4, "0")}`, agentId: "metadata-reader",
    content: `${i < 5 ? "quokka" : "wombat"} checklist ${i} ` + "release rollback procedure deployment verification ".repeat(20),
    embedding: [1, ...Array(767).fill(0)], embeddingModel: "nomic-embed-text-v1.5-Q4_K_M+searchprefix",
    durability: "standard", visibility: "private", createdAt: "2026-01-01T00:00:00Z",
  }));
  const res = await fetch(harper.opsURL, { method: "POST", headers: { "Content-Type": "application/json", Authorization: auth() },
    body: JSON.stringify({ operation: "insert", database: "flair", table: "Memory", records }) });
  expect(res.status, await res.text()).toBe(200);
}, 120_000);
afterAll(async () => {
  if (harper) await stopHarper(harper);
  if (appDir) await rm(appDir, { recursive: true, force: true });
});

async function post(endpoint: string, body: unknown): Promise<any> {
  const response = await fetch(`${harper.httpURL}/${endpoint}`, { method: "POST",
    headers: { "Content-Type": "application/json", Authorization: auth() }, body: JSON.stringify(body) });
  expect(response.status, `${endpoint}: ${await response.clone().text()}`).toBe(200);
  return response.json();
}
const search = () => post("SemanticSearch", { agentId: "metadata-reader", q: "quokka",
  queryEmbedding: [1, ...Array(767).fill(0)], limit: 5 });
const percentile = (values: number[], p: number) => values.slice().sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];

test("real search hit tracking preserves results while avoiding lexical replacements", async () => {
  const observations = [];
  await search();
  await Bun.sleep(100);
  for (const concurrency of [1, 8]) {
    for (const order of [[true, false], [false, true]]) {
      const arms = [];
      for (const legacy of order) {
        const started = await post("Bm25MetadataProbe", { action: "start", legacy });
        expect(started.index.state).toBe("ready");
        const latencies: number[] = [], selections: string[][] = [];
        try {
          for (let n = 0; n < 64; n += concurrency) {
            await Promise.all(Array.from({ length: concurrency }, async () => {
              const begin = performance.now();
              const result = await search();
              latencies.push(performance.now() - begin);
              selections.push(result.results.map((row: any) => row.id).sort());
            }));
          }
          const deadline = Date.now() + 5000;
          let metrics = await post("Bm25MetadataProbe", {});
          let stable = 0;
          while (stable < 5 && Date.now() < deadline) {
            await Bun.sleep(10);
            const next = await post("Bm25MetadataProbe", {});
            stable = next.updates === metrics.updates && next.successfulPuts + next.failedPuts === 320 ? stable + 1 : 0;
            metrics = next;
          }
          expect(stable).toBe(5);
          console.log("probe metrics", JSON.stringify(metrics));
          expect(metrics.writes).toBe(320);
          expect(metrics.successfulPuts + metrics.failedPuts).toBe(320);
          expect(metrics.updates).toBeGreaterThan(0);
          expect(metrics.updates).toBeLessThanOrEqual(320);
          if (concurrency === 1) expect(metrics.updates).toBe(320);
          expect(metrics.replacements).toBe(legacy ? metrics.updates : 0);
          expect(selections.every(ids => ids.length === 5)).toBe(true);
          arms.push(selections);
          observations.push({ legacy, concurrency, queries: 64, ...metrics, counterIncrease: metrics.counterTotal - started.counterTotal,
            p95Ms: percentile(latencies, .95), p99Ms: percentile(latencies, .99) });
        } finally { await post("Bm25MetadataProbe", { action: "stop" }); }
      }
      expect(arms[0]).toEqual(arms[1]);
    }
  }
  console.log("BM25 metadata measurements (1000 synthetic rows, warm hybrid search, supplied vectors):", JSON.stringify(observations));
}, 120_000);
