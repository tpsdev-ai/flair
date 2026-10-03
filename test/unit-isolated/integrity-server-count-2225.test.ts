import { expect, test } from "bun:test";
import { Command } from "commander";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bindIntegrityCli, register } from "../../src/commands/integrity";
import { emptyCheckpoint } from "../../src/lib/memory-integrity";
import { tempDir } from "../helpers/temp-dir";

const memory = { id: "m", durability: "permanent", instanceToken: "token", validTo: "closed", visibility: "private" };
const deletion = { id: "d", memoryId: "gone", memoryInstanceToken: "old", at: "deleted" };

type Options = {
  comparison?: "clean" | "loss";
  table?: string;
  rows?: unknown[];
  counts?: unknown[];
  countStatus?: number;
};

async function scan(options: Options = {}) {
  const memoryRows = options.comparison === "loss" && options.table === "MemoryDeletionHistory" ? [] : [memory];
  const path = join(tempDir("flair-integrity-count-"), "checkpoint.json");
  const checkpoint = options.comparison
    ? JSON.stringify(emptyCheckpoint("baseline", options.comparison === "loss" ? [memory] : [], [deletion]))
    : undefined;
  if (checkpoint) writeFileSync(path, checkpoint);
  const originalFetch = globalThis.fetch;
  const originalExit = process.exit;
  const originalWrite = process.stdout.write;
  const calls: string[] = [];
  const countCalls: Record<string, number> = {};
  let output = "";
  let code: number | undefined;
  try {
    bindIntegrityCli({ resolveOpsPort: () => 19925, resolveAdminUser: () => "admin" });
    globalThis.fetch = (async (_url: any, init: any) => {
      const body = JSON.parse(init.body);
      const { operation, table } = body;
      calls.push(`${operation}:${table}`);
      if (operation === "describe_table") {
        expect(body.exact_count).toBe(true);
        const index = countCalls[table] ?? 0;
        countCalls[table] = index + 1;
        const count = table === options.table && options.counts
          ? options.counts[Math.min(index, options.counts.length - 1)] : table === "Memory" ? memoryRows.length : 1;
        return new Response(JSON.stringify({ record_count: count }), { status: table === options.table ? options.countStatus ?? 200 : 200 });
      }
      expect(operation).toBe("search_by_value");
      expect(body.search_attribute).toBe("id");
      expect(body.search_value).toBe("*");
      const rows = table === options.table && options.rows ? options.rows : table === "Memory" ? memoryRows : [deletion];
      return new Response(JSON.stringify(rows));
    }) as typeof fetch;
    process.exit = ((value: number) => { code = value; throw new Error(`exit:${value}`); }) as typeof process.exit;
    process.stdout.write = ((value: any) => { output += String(value); return true; }) as typeof process.stdout.write;
    const program = new Command();
    register(program);
    await expect(program.parseAsync(["integrity", "check", "--json", "--accept", "--checkpoint", path, "--admin-pass", "secret"], { from: "user" })).rejects.toThrow("exit:");
  } finally {
    globalThis.fetch = originalFetch;
    process.exit = originalExit;
    process.stdout.write = originalWrite;
  }
  return { code, verdict: JSON.parse(output), checkpoint, saved: existsSync(path) ? readFileSync(path, "utf8") : undefined, calls };
}

function expectRefusal(result: Awaited<ReturnType<typeof scan>>) {
  expect(result.code).toBe(3);
  expect(result.verdict.status).toBe("unknown");
  expect(result.verdict.checkpointWritten).toBe(false);
  expect(result.verdict.losses).toEqual([]);
  expect(result.saved).toBe(result.checkpoint);
}

for (const table of ["Memory", "MemoryDeletionHistory"]) {
  test(`${table}: shortened HTTP-200 first read never becomes a baseline`, async () => {
    const result = await scan({ table, rows: [] });
    expectRefusal(result);
    expect(result.verdict.reason).toContain(`${table}: server reports 1 rows, integrity read 0`);
    expect(result.verdict.reason).toContain("retry integrity check when writes are paused");
  });

  for (const comparison of ["clean", "loss"] as const) {
    test(`${table}: shortened comparison is UNKNOWN instead of ${comparison}`, async () => {
      const result = await scan({ comparison, table, rows: [] });
      expectRefusal(result);
      expect(result.verdict.reason).toContain(`${table}: server reports 1 rows, integrity read 0`);
    });
  }

  test(`${table}: a before/after exact-count difference around the search reports UNKNOWN`, async () => {
    const result = await scan({ table, counts: [1, 2] });
    expectRefusal(result);
    expect(result.verdict.reason).toContain(`${table}: source count changed`);
    expect(result.verdict.reason).toContain("retry");
  });

  test(`${table}: duplicate IDs cannot fill the independent count`, async () => {
    const row = table === "Memory" ? memory : deletion;
    const result = await scan({ table, rows: [row, row], counts: [2] });
    expectRefusal(result);
    expect(result.verdict.reason).toContain("duplicate id");
  });

  test(`${table}: unavailable or invalid exact counts refuse scans`, async () => {
    for (const counts of [[null], [-1], [1.5], ["1"]]) {
      const result = await scan({ table, counts });
      expectRefusal(result);
      expect(result.verdict.reason).toContain("record_count");
    }
    expectRefusal(await scan({ table, countStatus: 503 }));
  });
}

test("exact counts bracket both searches and closed/private rows remain in the baseline", async () => {
  const result = await scan();
  expect(result.code).toBe(0);
  expect(result.verdict.status).toBe("baseline");
  expect(JSON.parse(result.saved!).ids.m).toBe("permanent");
  expect(result.calls).toEqual([
    "describe_table:Memory", "search_by_value:Memory", "describe_table:Memory",
    "describe_table:MemoryDeletionHistory", "search_by_value:MemoryDeletionHistory", "describe_table:MemoryDeletionHistory",
  ]);
});
