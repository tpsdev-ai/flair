import { expect, test } from "bun:test";
import { Command } from "commander";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bindIntegrityCli, register } from "../../src/commands/integrity";
import { emptyCheckpoint } from "../../src/lib/memory-integrity";
import { tempDir } from "../helpers/temp-dir";

const memory = { id: "m", durability: "permanent", instanceToken: "token" };

async function scan(opts: { rows: any[]; counts: number[]; baseline?: boolean; reads?: any[][]; table?: string }) {
  const path = join(tempDir("flair-integrity-dup-"), "checkpoint.json");
  const checkpoint = opts.baseline
    ? JSON.stringify(emptyCheckpoint("2026-10-02T00:00:00.000Z", [memory], []))
    : undefined;
  if (checkpoint) writeFileSync(path, checkpoint);
  const originalFetch = globalThis.fetch;
  const originalExit = process.exit;
  const originalWrite = process.stdout.write;
  const countCalls: Record<string, number> = {};
  let searches = 0;
  let output = "";
  let code: number | undefined;
  try {
    bindIntegrityCli({ resolveOpsPort: () => 19925, resolveAdminUser: () => "agent-a" });
    globalThis.fetch = (async (_url: any, init: any) => {
      const body = JSON.parse(init.body);
      const table = body.table;
      if (body.operation === "delete") return new Response(JSON.stringify({ deleted_hashes: body.hash_values }));
      if (body.operation === "describe_table") {
        const index = countCalls[table] ?? 0;
        countCalls[table] = index + 1;
        const count = table === (opts.table ?? "Memory") ? opts.counts[Math.min(index, opts.counts.length - 1)] : table === "Memory" ? 1 : 0;
        return new Response(JSON.stringify({ record_count: count }));
      }
      if (body.operation === "sql") return new Response(JSON.stringify([{ n: opts.table === "MemoryDeletionHistory" ? opts.counts[0] : 0 }]));
      if (body.operation === "search_by_value" || body.operation === "search_by_conditions") {
        if (table === (opts.table ?? "Memory")) {
          const rows = opts.reads?.[Math.min(searches, opts.reads.length - 1)] ?? opts.rows;
          searches++;
          return new Response(JSON.stringify(rows));
        }
        return new Response(JSON.stringify(table === "Memory" ? [memory] : []));
      }
      return new Response(JSON.stringify([]));
    }) as typeof fetch;
    process.exit = ((value: number) => { code = value; throw new Error(`exit:${value}`); }) as typeof process.exit;
    process.stdout.write = ((value: any) => { output += String(value); return true; }) as typeof process.stdout.write;
    const program = new Command();
    register(program);
    await expect(
      program.parseAsync(["integrity", "check", "--json", "--checkpoint", path, "--admin-pass", "secret"], { from: "user" }),
    ).rejects.toThrow("exit:");
  } finally {
    globalThis.fetch = originalFetch;
    process.exit = originalExit;
    process.stdout.write = originalWrite;
  }
  return { code, searches, checkpoint, verdict: JSON.parse(output), saved: existsSync(path) ? readFileSync(path, "utf8") : undefined };
}

test("byte-identical projected duplicates can establish a baseline", async () => {
  // The Memory search returns the same row twice; the table's exact count is 1.
  const r = await scan({ rows: [memory, memory], counts: [1] });
  expect(r.code).toBe(0);
  expect(r.verdict.status).toBe("baseline");
  expect(r.verdict.checkpointWritten).toBe(true);
  expect(r.saved).toBeDefined();
});

test("a persistent distinct-id count mismatch exhausts retries", async () => {
  // Two distinct rows expected (count 2), but the read returns one id twice.
  const r = await scan({ rows: [memory, memory], counts: [2] });
  expect(r.code).toBe(3);
  expect(r.verdict.status).toBe("unknown");
  expect(r.verdict.reason).toContain("server reports 2 rows, integrity read 1");
  expect(r.searches).toBe(3);
  expect(r.saved).toBeUndefined();
});

for (const rows of [
  [memory, { ...memory, instanceToken: "replacement" }],
  [{ ...memory, instanceToken: "replacement" }, memory],
  [memory, { ...memory, durability: "persistent" }],
]) {
  test(`differing Memory projections refuse the scan: ${JSON.stringify(rows)}`, async () => {
    const r = await scan({ rows, counts: [1], baseline: true });
    expect(r.code).toBe(3);
    expect(r.verdict.status).toBe("unknown");
    expect(r.verdict.reason).toContain("differing duplicate projection");
    expect(r.verdict.checkpointWritten).toBe(false);
    expect(r.searches).toBe(3);
    expect(r.saved).toBe(r.checkpoint);
  });
}

test("a stale-token duplicate is discarded before a replacement read reports alert", async () => {
  const replacement = { ...memory, instanceToken: "replacement" };
  const r = await scan({ rows: [], reads: [[memory, replacement], [replacement]], counts: [1], baseline: true });
  expect(r.searches).toBe(2);
  expect(r.code).toBe(2);
  expect(r.verdict.status).toBe("alert");
  expect(r.verdict.losses).toEqual([{ id: "m", tier: "permanent", reason: "replaced" }]);
  expect(r.saved).toBe(r.checkpoint);
});

test("a transient row-count mismatch is retried before establishing a baseline", async () => {
  const r = await scan({ rows: [], reads: [[], [memory]], counts: [1] });
  expect(r.searches).toBe(2);
  expect(r.verdict.status).toBe("baseline");
});

test("a transient after-count mismatch is retried with fresh counts", async () => {
  const r = await scan({ rows: [memory], counts: [1, 2, 1, 1] });
  expect(r.searches).toBe(2);
  expect(r.verdict.status).toBe("baseline");
});

const deletion = { id: "d", memoryId: "gone", memoryInstanceToken: "old", durability: "permanent", at: "2026-10-02T00:00:00.000Z" };
for (const bounded of [false, true]) {
  for (const field of ["memoryId", "memoryInstanceToken", "durability", "at"] as const) {
    test(`${bounded ? "bounded" : "full"} deletion read rejects duplicates differing in ${field}`, async () => {
      const r = await scan({
        rows: [deletion, { ...deletion, [field]: "different" }], counts: [1],
        table: "MemoryDeletionHistory", baseline: bounded,
      });
      expect(r.verdict.status).toBe("unknown");
      expect(r.verdict.reason).toContain("differing duplicate projection");
      expect(r.verdict.checkpointWritten).toBe(false);
      expect(r.saved).toBe(r.checkpoint);
      expect(r.searches).toBe(3);
    });
  }
}

test("projected equality ignores response property order and unrequested fields", async () => {
  const r = await scan({ rows: [memory, { instanceToken: "token", durability: "permanent", id: "m", content: "unrequested" }], counts: [1] });
  expect(r.verdict.status).toBe("baseline");
  expect(r.searches).toBe(1);
});

test("a missing projected field differs from an explicit null", async () => {
  const r = await scan({ rows: [{ id: "m", durability: "permanent" }, { id: "m", durability: "permanent", instanceToken: null }], counts: [1], baseline: true });
  expect(r.verdict.status).toBe("unknown");
  expect(r.verdict.checkpointWritten).toBe(false);
  expect(r.saved).toBe(r.checkpoint);
});

for (const bounded of [false, true]) {
  test(`${bounded ? "bounded" : "full"} deletion read retries a differing duplicate then collapses identical projections`, async () => {
    const r = await scan({
      rows: [], reads: [[deletion, { ...deletion, at: "different" }], [deletion, { ...deletion }]],
      counts: [1], table: "MemoryDeletionHistory", baseline: bounded,
    });
    expect(r.searches).toBe(2);
    expect(r.verdict.status).toBe(bounded ? "healthy" : "baseline");
  });
}
