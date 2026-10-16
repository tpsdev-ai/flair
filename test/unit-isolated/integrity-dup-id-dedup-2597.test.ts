/**
 * integrity-dup-id-dedup-2597.test.ts — a duplicate id in the operations-API
 * search response is not, by itself, a scan failure (flair#2597).
 *
 * The operations API can return the same id twice: a row carries its version
 * history, and a write that lands during the read can surface a row's second
 * version. When the read's DISTINCT ids still match the table's exact count, the
 * scan must not report UNKNOWN — the exact-count recheck is the integrity gate.
 * A read whose distinct ids miss the count is still a named refusal.
 *
 * The duplicate is injected here at the operations-API boundary; the live path
 * on a real ephemeral Harper is test/integration/integrity-retention-2229.test.ts.
 */
import { expect, test } from "bun:test";
import { Command } from "commander";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bindIntegrityCli, register } from "../../src/commands/integrity";
import { emptyCheckpoint } from "../../src/lib/memory-integrity";
import { tempDir } from "../helpers/temp-dir";

const memory = { id: "m", durability: "permanent", instanceToken: "token" };

async function scan(opts: { rows: any[]; counts: number[]; baseline?: boolean }) {
  const path = join(tempDir("flair-integrity-dup-"), "checkpoint.json");
  const checkpoint = opts.baseline
    ? JSON.stringify(emptyCheckpoint("2026-10-02T00:00:00.000Z", [memory], []))
    : undefined;
  if (checkpoint) writeFileSync(path, checkpoint);
  const originalFetch = globalThis.fetch;
  const originalExit = process.exit;
  const originalWrite = process.stdout.write;
  const countCalls: Record<string, number> = {};
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
        const count = table === "Memory" ? opts.counts[Math.min(index, opts.counts.length - 1)] : 0;
        return new Response(JSON.stringify({ record_count: count }));
      }
      if (body.operation === "search_by_value") {
        return new Response(JSON.stringify(table === "Memory" ? opts.rows : []));
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
  return { code, verdict: JSON.parse(output), saved: existsSync(path) ? readFileSync(path, "utf8") : undefined };
}

test("a duplicate id whose distinct ids still match the exact count is not a scan failure", async () => {
  // The Memory search returns the same row twice; the table's exact count is 1.
  const r = await scan({ rows: [memory, memory], counts: [1] });
  expect(r.code).toBe(0);
  expect(r.verdict.status).toBe("baseline");
  expect(r.verdict.checkpointWritten).toBe(true);
  expect(r.saved).toBeDefined();
});

test("a duplicate that also drops an id is still a named refusal", async () => {
  // Two distinct rows expected (count 2), but the read returns one id twice.
  const r = await scan({ rows: [memory, memory], counts: [2] });
  expect(r.code).toBe(3);
  expect(r.verdict.status).toBe("unknown");
  expect(r.verdict.reason).toContain("server reports 2 rows, integrity read 1");
});
