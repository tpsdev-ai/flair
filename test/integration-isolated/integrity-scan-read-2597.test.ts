import { afterAll, beforeAll, expect, test } from "bun:test";
import { Command } from "commander";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bindIntegrityCli, register } from "../../src/commands/integrity";
import { emptyCheckpoint } from "../../src/lib/memory-integrity";
import { startHarper, stopHarper, HARPER_STOP_BUDGET_MS, type HarperInstance } from "../helpers/harper-lifecycle";
import { tempDir } from "../helpers/temp-dir";

let harper: HarperInstance;
const nativeFetch = globalThis.fetch;
const attributes = ["id", "durability", "instanceToken"];
const memoryQuery = {
  operation: "search_by_value", database: "flair", table: "Memory",
  search_attribute: "id", search_value: "*", get_attributes: attributes,
};
const auth = () => `Basic ${Buffer.from(`${harper.admin.username}:${harper.admin.password}`).toString("base64")}`;

async function ops(body: Record<string, unknown>): Promise<any> {
  const res = await nativeFetch(harper.opsURL, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: auth() },
    body: JSON.stringify(body), signal: AbortSignal.timeout(15_000),
  });
  expect(res.status, JSON.stringify(body)).toBe(200);
  return res.json();
}

async function insert(id: string, instanceToken: string): Promise<void> {
  const result = await ops({
    operation: "insert", database: "flair", table: "Memory",
    records: [{ id, agentId: "integrity-2597", content: "scan seam", createdAt: new Date().toISOString(), durability: "permanent", instanceToken }],
  });
  expect(result.inserted_hashes).toContain(id);
}

async function remove(id: string): Promise<void> {
  const result = await ops({ operation: "delete", database: "flair", table: "Memory", hash_values: [id] });
  expect(result.deleted_hashes).toContain(id);
}

beforeAll(async () => { harper = await startHarper(); }, 180_000);
afterAll(async () => { if (harper) await stopHarper(harper); }, HARPER_STOP_BUDGET_MS);

async function controlledScan(replaceEveryRead: boolean) {
  const id = `integrity-2597-${randomUUID()}`;
  let token = randomUUID();
  const tokens = new Set([token]);
  await insert(id, token);
  const initialRows = await ops(memoryQuery);
  expect(Array.isArray(initialRows)).toBe(true);
  const path = join(tempDir("flair-2597-seam-"), "checkpoint.json");
  const checkpoint = JSON.stringify(emptyCheckpoint(new Date().toISOString(), initialRows, []));
  writeFileSync(path, checkpoint);
  const originalExit = process.exit;
  const originalWrite = process.stdout.write;
  let output = "";
  let code: number | undefined;
  let reads = 0;
  let pendingRecreate = false;
  const observed: any[][] = [];
  try {
    bindIntegrityCli({ resolveOpsPort: () => harper.opsURL, resolveAdminUser: () => harper.admin.username });
    globalThis.fetch = (async (url: any, init: any) => {
      const body = JSON.parse(init.body);
      const res = await nativeFetch(url, init);
      expect(res.status).toBe(200);
      if (body.operation === "search_by_value" && body.table === "Memory") {
        expect(body).toEqual(memoryQuery);
        expect(body).not.toHaveProperty("limit");
        expect(body).not.toHaveProperty("offset");
        const rows = await res.clone().json() as any[];
        expect(Array.isArray(rows)).toBe(true);
        for (const row of rows) {
          expect(Object.keys(row).sort()).toEqual([...attributes].sort());
          expect(typeof row.id).toBe("string");
        }
        const matching = rows.filter(row => row.id === id);
        expect(matching.length).toBeGreaterThan(0);
        for (const row of matching) {
          expect(row.durability).toBe("permanent");
          expect(tokens.has(row.instanceToken)).toBe(true);
        }
        observed.push(rows);
        reads++;
        if (replaceEveryRead || reads === 1) {
          // Hold the real response across a raw delete; re-create after its count.
          await remove(id);
          pendingRecreate = true;
        }
      } else if (body.operation === "describe_table" && body.table === "Memory" && pendingRecreate) {
        expect(body.exact_count).toBe(true);
        const count = await res.clone().json() as { record_count: number };
        expect(count.record_count).toBe(initialRows.length - 1);
        token = randomUUID();
        tokens.add(token);
        await insert(id, token);
        pendingRecreate = false;
      }
      return res;
    }) as typeof fetch;
    process.exit = ((value: number) => { code = value; throw new Error(`exit:${value}`); }) as typeof process.exit;
    process.stdout.write = ((value: any) => { output += String(value); return true; }) as typeof process.stdout.write;
    const program = new Command();
    register(program);
    await expect(program.parseAsync([
      "integrity", "check", "--json", ...(replaceEveryRead ? ["--accept"] : []), "--checkpoint", path, "--admin-pass", harper.admin.password,
    ], { from: "user" })).rejects.toThrow("exit:");
  } finally {
    globalThis.fetch = nativeFetch;
    process.exit = originalExit;
    process.stdout.write = originalWrite;
    await remove(id);
  }
  return { code, verdict: JSON.parse(output), reads, observed, checkpoint, saved: readFileSync(path, "utf8") };
}

test("the exact unpaged scan retries a stale response whose after-count sees a raw delete", async () => {
  const r = await controlledScan(false);
  expect(r.reads).toBeGreaterThanOrEqual(2);
  if (r.verdict.status === "unknown") {
    expect(r.code).toBe(3);
    expect(r.reads).toBe(3);
    expect(r.verdict.reason).toMatch(/differing duplicate projection|server reports|source count changed/);
    expect(r.verdict.reason).toContain("inconsistent after 3 attempts");
  } else {
    expect(r.code).toBe(2);
    expect(r.verdict.status).toBe("alert");
    expect(r.verdict.losses.some((loss: any) => loss.reason === "replaced")).toBe(true);
  }
  expect(r.verdict.checkpointWritten).toBe(false);
  expect(r.saved).toBe(r.checkpoint);
  expect(r.observed[0]).not.toEqual(r.observed[1]);
}, 90_000);

test("repeated raw delete/re-create across exact scan brackets yields UNKNOWN without a checkpoint write", async () => {
  const r = await controlledScan(true);
  expect(r.reads).toBe(3);
  expect(r.code).toBe(3);
  expect(r.verdict.status).toBe("unknown");
  expect(r.verdict.reason).toMatch(/differing duplicate projection|server reports|source count changed/);
  expect(r.verdict.reason).toContain("inconsistent after 3 attempts");
  expect(r.verdict.checkpointWritten).toBe(false);
  expect(r.saved).toBe(r.checkpoint);
}, 90_000);
