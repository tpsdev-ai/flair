/**
 * integrity-read-bracket-2435.test.ts — the watermark-bounded deletion-history
 * read brackets its count, Harper-free (flair#2435).
 *
 * On a known watermark `flair integrity check` reads history by condition; the
 * read is bracketed by the exact count of that range (a SQL count), so a result
 * that differs from the count is a named read error — UNKNOWN, never an alert.
 * The live path on a real ephemeral Harper is in
 * test/integration/integrity-retention-2229.test.ts.
 */
import { afterEach, expect, test } from "bun:test";
import { Command } from "commander";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindIntegrityCli, register } from "../../src/commands/integrity";
import { emptyCheckpoint } from "../../src/lib/memory-integrity";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "flair-2435-unit-"));
  dirs.push(d);
  return d;
}
afterEach(() => { for (const d of dirs.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } } });

interface Run { code: number | undefined; verdict: any; calls: string[] }

/**
 * Run `flair integrity check` against a fake operations API. The SQL count of
 * the bounded range says `windowCount` rows; the conditional search returns
 * `windowRows`. A mismatch must be caught.
 */
async function runCheckFake(opts: {
  checkpoint: string;
  memoryRows?: any[];
  windowCount: number;
  windowRows?: any[];
  windowCountAfter?: number;
}): Promise<Run> {
  let sqlCalls = 0;
  const originalFetch = globalThis.fetch;
  const originalExit = process.exit;
  const originalWrite = process.stdout.write;
  const calls: string[] = [];
  let output = "";
  let code: number | undefined;
  try {
    bindIntegrityCli({ resolveOpsPort: () => 19925, resolveAdminUser: () => "admin" });
    globalThis.fetch = (async (_url: any, init: any) => {
      const body = JSON.parse(init.body);
      calls.push(`${body.operation}:${typeof body.table === "string" ? body.table : ""}`);
      if (body.operation === "describe_table") return new Response(JSON.stringify({ record_count: (opts.memoryRows ?? []).length }));
      if (body.operation === "sql") {
        sqlCalls += 1;
        return new Response(JSON.stringify([{ n: sqlCalls > 1 ? (opts.windowCountAfter ?? opts.windowCount) : opts.windowCount }]));
      }
      if (body.operation === "search_by_conditions") return new Response(JSON.stringify(opts.windowRows ?? []));
      if (body.operation === "search_by_value") return new Response(JSON.stringify(body.table === "Memory" ? (opts.memoryRows ?? []) : []));
      if (body.operation === "delete") return new Response(JSON.stringify({ deleted_hashes: body.hash_values ?? [] }));
      return new Response(JSON.stringify([]));
    }) as typeof fetch;
    process.exit = ((value: number) => { code = value; throw new Error(`exit:${value}`); }) as typeof process.exit;
    process.stdout.write = ((value: any) => { output += String(value); return true; }) as typeof process.stdout.write;
    const program = new Command();
    register(program);
    await expect(program.parseAsync(["integrity", "check", "--json", "--checkpoint", opts.checkpoint, "--admin-pass", "secret"], { from: "user" })).rejects.toThrow("exit:");
  } finally {
    globalThis.fetch = originalFetch;
    process.exit = originalExit;
    process.stdout.write = originalWrite;
  }
  let verdict: any = null;
  try { verdict = JSON.parse(output.trim().split("\n").pop() ?? ""); } catch { /* leave null */ }
  return { code, verdict, calls };
}

function checkpointWithMissingDurable(): string {
  const path = join(tmp(), "checkpoint.json");
  writeFileSync(path, JSON.stringify({
    ...emptyCheckpoint("2026-10-02T00:00:00.000Z", []),
    ids: { m1: "permanent" },
    instanceTokens: { m1: "t1" },
  }));
  return path;
}

test("check: a bounded read with fewer rows than its count is a named read error, not an alert", async () => {
  const r = await runCheckFake({
    checkpoint: checkpointWithMissingDurable(),
    memoryRows: [],          // m1 is gone from the corpus
    windowCount: 1,          // the operations API says the window holds one row
    windowRows: [],          // but the search returns none
  });
  expect(r.calls).toContain("search_by_conditions:MemoryDeletionHistory");
  expect(r.code).toBe(3);
  expect(r.verdict?.status).toBe("unknown");
  expect(r.verdict?.reason).toContain("bounded read reports 1 rows, integrity read 0");
});

test("check: a bounded range count that changes during the read is a named read error", async () => {
  const r = await runCheckFake({
    checkpoint: checkpointWithMissingDurable(),
    memoryRows: [],
    windowCount: 1,
    windowCountAfter: 2,
    windowRows: [{ id: "h1", memoryId: "m1", memoryInstanceToken: "t1", durability: "permanent", at: "2026-09-20T00:00:00.000Z" }],
  });
  expect(r.code).toBe(3);
  expect(r.verdict?.status).toBe("unknown");
  expect(r.verdict?.reason).toContain("count changed from 1 to 2");
});

test("check: a bounded read that matches its count reads as it always did", async () => {
  const r = await runCheckFake({
    checkpoint: checkpointWithMissingDurable(),
    memoryRows: [],
    windowCount: 1,
    windowRows: [{ id: "h1", memoryId: "m1", memoryInstanceToken: "t1", durability: "permanent", at: "2026-09-20T00:00:00.000Z" }],
  });
  expect(r.code).toBe(0);
  expect(r.verdict?.status).toBe("healthy");
  expect((r.verdict?.attributedDeletes ?? []).map((d: any) => d.id)).toContain("m1");
});
