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
  // CI saw counterTotal=3 after one search + 2s: hybrid recall is not yet
  // the five quokka rows while BM25 is still building, so the probe's
  // metadata-0000..0004 ledger only records a partial hit set. Wait until
  // the index is ready, keep searching the tracked ids, and let the
  // fire-and-forget MemoryHitStat puts commit. Do not start measured arms
  // on a partial result set — that is the "preserves results" contract.
  {
    const deadline = Date.now() + 30_000;
    let warmed = 0;
    while (Date.now() < deadline) {
      const status = await post("Bm25MetadataProbe", {});
      warmed = status.counterTotal ?? 0;
      if (status.index?.state === "ready" && warmed >= 5) break;
      await search();
      await Bun.sleep(50);
    }
    expect(warmed, "warmup search must commit hit stats before measured arms").toBeGreaterThanOrEqual(5);
  }
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
          const deadline = Date.now() + 30_000;
          let metrics = await post("Bm25MetadataProbe", {});
          let stable = 0;
          while (stable < 5 && Date.now() < deadline) {
            await Bun.sleep(10);
            const next = await post("Bm25MetadataProbe", {});
            const countersDone = next.counterTotal - started.counterTotal === 320;
            const statsQuiet = next.hitStatSuccessfulPuts === metrics.hitStatSuccessfulPuts;
            stable = countersDone && statsQuiet ? stable + 1 : 0;
            metrics = next;
          }
          expect(stable).toBe(5);
          console.log("probe metrics", JSON.stringify(metrics));
          expect(metrics.writes).toBe(0);
          expect(metrics.successfulPuts + metrics.failedPuts).toBe(0);
          expect(metrics.updates).toBe(0);
          expect(metrics.replacements).toBe(0);
          expect(metrics.hitStatSuccessfulPuts).toBeGreaterThan(0);
          expect(metrics.hitStatSuccessfulPuts).toBeLessThanOrEqual(320);
          expect(selections.every(ids => ids.length === 5)).toBe(true);
          arms.push(selections);
          const counterIncrease = metrics.counterTotal - started.counterTotal;
          expect(counterIncrease).toBe(320);
          observations.push({ legacy, concurrency, queries: 64, ...metrics, counterIncrease,
            p95Ms: percentile(latencies, .95), p99Ms: percentile(latencies, .99) });
        } finally { await post("Bm25MetadataProbe", { action: "stop" }); }
      }
      expect(arms[0]).toEqual(arms[1]);
    }
  }
  console.log("BM25 metadata measurements (1000 synthetic rows, warm hybrid search, supplied vectors):", JSON.stringify(observations));
}, 120_000);
