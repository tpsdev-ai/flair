/**
 * integrity-prune-history-2229.test.ts — the watermark-bounded history read's
 * pure helpers and the `flair integrity prune-history` command, Harper-free.
 *
 * The live behaviour (a real ephemeral Harper, the read window, the retention
 * cutoff against the OLDEST checkpoint) is in
 * test/integration/integrity-retention-2229.test.ts.
 */
import { afterEach, expect, test } from "bun:test";
import { Command } from "commander";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindIntegrityCli, register } from "../../src/commands/integrity";
import {
  DELETION_HISTORY_MARGIN_MS,
  deletionReadSince,
  emptyCheckpoint,
  historyRowsToPrune,
  retentionCutoff,
  type DeletionRecordLite,
  type IntegrityCheckpoint,
  type MemoryRowLite,
} from "../../src/lib/memory-integrity";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "flair-2229-unit-"));
  dirs.push(d);
  return d;
}
afterEach(() => { for (const d of dirs.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } } });

const row = (id: string, durability: string, instanceToken: string): MemoryRowLite => ({ id, durability, instanceToken });
const del = (id: string, memoryId: string, memoryInstanceToken: string | null, at: string): DeletionRecordLite =>
  ({ id, memoryId, memoryInstanceToken, durability: "permanent", at });

test("deletionReadSince: only a parseable watermark bounds the read", () => {
  expect(deletionReadSince(null)).toBeNull();
  expect(deletionReadSince({ watermark: undefined } as IntegrityCheckpoint)).toBeNull();
  expect(deletionReadSince({ watermark: "" } as IntegrityCheckpoint)).toBeNull();
  expect(deletionReadSince({ watermark: "not-a-date" } as IntegrityCheckpoint)).toBeNull();
  const since = deletionReadSince({ watermark: "2026-10-02T00:00:00.000Z" } as IntegrityCheckpoint);
  expect(since).toBe(new Date(Date.parse("2026-10-02T00:00:00.000Z") - DELETION_HISTORY_MARGIN_MS).toISOString());
});

test("retentionCutoff: the OLDEST watermark, minus the margin; a missing one refuses", () => {
  expect(retentionCutoff([])).toBeNull();
  expect(retentionCutoff(["2026-10-01T00:00:00.000Z", null])).toBeNull();
  expect(retentionCutoff(["2026-10-01T00:00:00.000Z", "nope"])).toBeNull();
  const cutoff = retentionCutoff(["2026-10-02T00:00:00.000Z", "2026-10-01T00:00:00.000Z"]);
  expect(cutoff).toBe(new Date(Date.parse("2026-10-01T00:00:00.000Z") - DELETION_HISTORY_MARGIN_MS).toISOString());
});

test("historyRowsToPrune: only rows strictly older than the cutoff, oldest first, capped", () => {
  const cutoff = "2026-10-01T00:00:00.000Z";
  const rows = [
    del("b", "m", "t", "2026-09-20T00:00:00.000Z"),
    del("a", "m", "t", "2026-09-10T00:00:00.000Z"),
    del("at-cutoff", "m", "t", cutoff),                 // exactly the cutoff: kept (not strictly older)
    del("new", "m", "t", "2026-10-05T00:00:00.000Z"),   // newer: kept
    del("bad", "m", "t", "garbage"),                    // unreadable age: kept
  ];
  expect(historyRowsToPrune(rows, cutoff, 10).map(r => r.id)).toEqual(["a", "b"]);
  expect(historyRowsToPrune(rows, cutoff, 1).map(r => r.id)).toEqual(["a"]);
  expect(historyRowsToPrune(rows, cutoff, 0)).toEqual([]);
});

test("emptyCheckpoint: the watermark is scannedAt, pulled back to a still-needed history row's at", () => {
  const rows = [row("m", "permanent", "t1")];
  // No deletions: watermark is the scan time.
  const bare = emptyCheckpoint("2026-10-02T00:00:00.000Z", rows);
  expect(bare.watermark).toBe("2026-10-02T00:00:00.000Z");
  // An old deletion row for a present durable row (same token) is still needed:
  // the watermark may not pass it.
  const needed = emptyCheckpoint("2026-10-02T00:00:00.000Z", rows, [del("d1", "m", "t1", "2026-09-01T00:00:00.000Z")]);
  expect(needed.historyIds).toEqual([]);
  expect(needed.watermark).toBe("2026-09-01T00:00:00.000Z");
  // A row whose token no longer matches is not needed: the scan time stands.
  const stray = emptyCheckpoint("2026-10-02T00:00:00.000Z", rows, [del("d2", "m", "gone", "2026-09-01T00:00:00.000Z")]);
  expect(stray.watermark).toBe("2026-10-02T00:00:00.000Z");
});

interface PruneResult { code: number | undefined; plan: any; output: string; errors: string; deletes: string[][]; paths: string[] }

async function prune(args: { checkpoints: string[]; deletions: DeletionRecordLite[]; extra?: string[]; failDeleteCall?: number; human?: boolean }): Promise<PruneResult> {
  const originalFetch = globalThis.fetch;
  const originalExit = process.exit;
  const originalWrite = process.stdout.write;
  const deletes: string[][] = [];
  const originalError = console.error;
  const originalLog = console.log;
  let output = "";
  let errors = "";
  let code: number | undefined;
  try {
    bindIntegrityCli({ resolveOpsPort: () => 19925, resolveAdminUser: () => "admin" });
    globalThis.fetch = (async (_url: any, init: any) => {
      const body = JSON.parse(init.body);
      const { operation, table, hash_values } = body;
      if (operation === "delete") {
        expect(table).toBe("MemoryDeletionHistory");
        if (args.failDeleteCall === deletes.length) return new Response("boom", { status: 500 });
        deletes.push(hash_values);
        return new Response(JSON.stringify({ deleted_hashes: hash_values }));
      }
      if (operation === "describe_table") {
        return new Response(JSON.stringify({ record_count: table === "Memory" ? 0 : args.deletions.length }));
      }
      expect(operation).toBe("search_by_value");
      return new Response(JSON.stringify(table === "Memory" ? [] : args.deletions));
    }) as typeof fetch;
    process.exit = ((value: number) => { code = value; throw new Error(`exit:${value}`); }) as typeof process.exit;
    process.stdout.write = ((value: any) => { output += String(value); return true; }) as typeof process.stdout.write;
    console.error = ((...a: unknown[]) => { errors += a.join(" "); }) as typeof console.error;
    console.log = ((...a: unknown[]) => { output += `${a.join(" ")}\n`; }) as typeof console.log;
    const program = new Command();
    register(program);
    const argv = ["integrity", "prune-history", ...(args.human ? [] : ["--json"]), "--checkpoint", ...args.checkpoints, "--admin-pass", "secret", ...(args.extra ?? [])];
    await expect(program.parseAsync(argv, { from: "user" })).rejects.toThrow("exit:");
  } finally {
    globalThis.fetch = originalFetch;
    process.exit = originalExit;
    process.stdout.write = originalWrite;
    console.error = originalError;
    console.log = originalLog;
  }
  return { code, output, errors, plan: args.human || !output ? null : JSON.parse(output), deletes, paths: args.checkpoints };
}

function writeCheckpointFile(watermark: string, ids: Record<string, string> = {}, instanceTokens: Record<string, string | null> = {}): string {
  const path = join(tmp(), "checkpoint.json");
  writeFileSync(path, JSON.stringify({ ...emptyCheckpoint(watermark, []), watermark, ids, instanceTokens }));
  return path;
}

test("prune-history: dry run by default, the cutoff is the OLDEST checkpoint, and a row the oldest still needs is kept", async () => {
  const newest = writeCheckpointFile("2026-10-02T00:00:00.000Z");
  const oldest = writeCheckpointFile("2026-10-01T00:00:00.000Z", { "needed-row": "permanent" }, { "needed-row": "tok" });
  const deletions = [
    // Older than the NEWEST watermark minus the margin, but the OLDEST checkpoint
    // still needs it (a present durable id with a matching token): it must be kept.
    del("needed", "needed-row", "tok", "2026-10-01T12:00:00.000Z"),
    del("old", "gone", "t", "2026-09-01T00:00:00.000Z"),
  ];
  const r = await prune({ checkpoints: [newest, oldest], deletions });
  expect(r.code).toBe(0);
  expect(r.plan.status).toBe("planned");
  expect(r.plan.ids).toEqual(["old"]);
  expect(r.plan.planned).toBe(1);
  expect(r.plan.pruned).toBe(0);
  expect(r.deletes).toEqual([]);
  expect(r.plan.cutoff).toBe(new Date(Date.parse("2026-10-01T00:00:00.000Z") - DELETION_HISTORY_MARGIN_MS).toISOString());

  const applied = await prune({ checkpoints: [newest, oldest], deletions, extra: ["--apply"] });
  expect(applied.plan.ids).toEqual(["old"]);
  expect(applied.deletes).toEqual([["old"]]);
});

test("prune-history: --apply deletes exactly the eligible rows, and --max caps the run", async () => {
  const cp = writeCheckpointFile("2026-10-02T00:00:00.000Z");
  const deletions = [
    del("a", "m", "t", "2026-09-01T00:00:00.000Z"),
    del("b", "m", "t", "2026-09-02T00:00:00.000Z"),
    del("c", "m", "t", "2026-09-03T00:00:00.000Z"),
    del("fresh", "m", "t", "2026-10-02T12:00:00.000Z"),
  ];
  const capped = await prune({ checkpoints: [cp], deletions, extra: ["--apply", "--max", "2"] });
  expect(capped.code).toBe(0);
  expect(capped.plan.status).toBe("pruned");
  expect(capped.plan.pruned).toBe(2);
  expect(capped.plan.more).toBe(true);
  expect(capped.deletes).toEqual([["a", "b"]]);

  const all = await prune({ checkpoints: [cp], deletions, extra: ["--apply"] });
  expect(all.plan.pruned).toBe(3);
  expect(all.plan.more).toBe(false);
  expect(all.deletes).toEqual([["a", "b", "c"]]);
});

test("prune-history: no checkpoint or an unreadable watermark prunes nothing and says why", async () => {
  const missing = join(tmp(), "absent.json");
  const refused = await prune({ checkpoints: [missing], deletions: [del("a", "m", "t", "2026-09-01T00:00:00.000Z")], extra: ["--apply"] });
  expect(refused.code).toBe(3);
  expect(refused.plan.status).toBe("refused");
  expect(refused.plan.reason).toContain("no checkpoint");
  expect(refused.deletes).toEqual([]);

  const noWatermark = join(tmp(), "nowatermark.json");
  writeFileSync(noWatermark, JSON.stringify({ ...emptyCheckpoint("2026-10-02T00:00:00.000Z", []), watermark: undefined }));
  const refused2 = await prune({ checkpoints: [noWatermark], deletions: [del("a", "m", "t", "2026-09-01T00:00:00.000Z")], extra: ["--apply"] });
  expect(refused2.code).toBe(3);
  expect(refused2.plan.reason).toContain("watermark");
  expect(refused2.deletes).toEqual([]);

  const corrupt = join(tmp(), "corrupt.json");
  writeFileSync(corrupt, "{ not json");
  const refused3 = await prune({ checkpoints: [corrupt], deletions: [], extra: ["--apply"] });
  expect(refused3.code).toBe(3);
  expect(refused3.plan.reason).toContain("checkpoint unreadable");
  expect(refused3.deletes).toEqual([]);
});

test("check: a known watermark reads deletion history by condition; an unknown one reads the whole table", async () => {
  const originalFetch = globalThis.fetch;
  const originalExit = process.exit;
  const originalWrite = process.stdout.write;
  const calls: string[] = [];
  try {
    bindIntegrityCli({ resolveOpsPort: () => 19925, resolveAdminUser: () => "admin" });
    globalThis.fetch = (async (_url: any, init: any) => {
      const body = JSON.parse(init.body);
      calls.push(body.operation === "search_by_conditions"
        ? `${body.operation}:${body.table}:${body.conditions?.[0]?.search_attribute}`
        : `${body.operation}:${body.table}`);
      if (body.operation === "describe_table") return new Response(JSON.stringify({ record_count: 0 }));
      if (body.operation === "delete") return new Response(JSON.stringify({ deleted_hashes: body.hash_values ?? [] }));
      return new Response(JSON.stringify([]));
    }) as typeof fetch;
    process.exit = ((value: number) => { throw new Error(`exit:${value}`); }) as typeof process.exit;
    process.stdout.write = (() => true) as typeof process.stdout.write;

    const known = join(tmp(), "known.json");
    writeFileSync(known, JSON.stringify(emptyCheckpoint("2026-10-02T00:00:00.000Z", [])));
    calls.length = 0;
    let program = new Command();
    register(program);
    await expect(program.parseAsync(["integrity", "check", "--json", "--checkpoint", known, "--admin-pass", "secret"], { from: "user" })).rejects.toThrow("exit:");
    expect(calls).toContain("search_by_conditions:MemoryDeletionHistory:at");
    expect(calls).not.toContain("search_by_value:MemoryDeletionHistory");

    const unknown = join(tmp(), "unknown.json");
    writeFileSync(unknown, JSON.stringify({ ...emptyCheckpoint("2026-10-02T00:00:00.000Z", []), watermark: "not-a-date" }));
    calls.length = 0;
    program = new Command();
    register(program);
    await expect(program.parseAsync(["integrity", "check", "--json", "--checkpoint", unknown, "--admin-pass", "secret"], { from: "user" })).rejects.toThrow("exit:");
    expect(calls).toContain("search_by_value:MemoryDeletionHistory");
    expect(calls).not.toContain("search_by_conditions:MemoryDeletionHistory:at");
  } finally {
    globalThis.fetch = originalFetch;
    process.exit = originalExit;
    process.stdout.write = originalWrite;
  }
});

const manyDeletions = (n: number): DeletionRecordLite[] =>
  Array.from({ length: n }, (_, i) => del(`h${String(i).padStart(4, "0")}`, "m", "t", new Date(Date.parse("2026-01-01T00:00:00.000Z") + i * 1000).toISOString()));

test("prune-history: a failure after batch 1 reports the 256 confirmed rows as FAILED, exit 3", async () => {
  const cp = writeCheckpointFile("2026-10-02T00:00:00.000Z");
  const deletions = manyDeletions(300);
  const json = await prune({ checkpoints: [cp], deletions, extra: ["--apply", "--max", "300"], failDeleteCall: 1 });
  expect(json.code).toBe(3);
  expect(json.plan.status).toBe("failed");
  expect(json.plan.pruned).toBe(256);
  expect(json.plan.prunedIsLowerBound).toBe(true);
  expect(json.plan.reason).toContain("500");
  expect(json.deletes).toHaveLength(1);
  expect(json.deletes[0]).toHaveLength(256);

  const human = await prune({ checkpoints: [cp], deletions, extra: ["--apply", "--max", "300"], failDeleteCall: 1, human: true });
  expect(human.code).toBe(3);
  expect(human.output).toContain("FAILED — at least 256 rows pruned before the failure");
  expect(human.output).not.toContain("nothing pruned");
});

test("prune-history: a watermark in the future prunes nothing newer than now minus the margin", async () => {
  const cp = writeCheckpointFile(new Date(Date.now() + 86_400_000).toISOString());
  const now = Date.now();
  const deletions = [
    del("old", "m", "t", new Date(now - DELETION_HISTORY_MARGIN_MS - 60_000).toISOString()),
    del("recent", "m", "t", new Date(now - 60_000).toISOString()),
  ];
  const r = await prune({ checkpoints: [cp], deletions, extra: ["--apply"] });
  expect(r.plan.ids).toEqual(["old"]);
  expect(r.deletes).toEqual([["old"]]);
  expect(Date.parse(r.plan.cutoff)).toBeLessThanOrEqual(Date.now() - DELETION_HISTORY_MARGIN_MS);
});

test("prune-history: --max must be digits only", async () => {
  const cp = writeCheckpointFile("2026-10-02T00:00:00.000Z");
  for (const bad of ["5x", "-1", "1.5"]) {
    const r = await prune({ checkpoints: [cp], deletions: [], extra: ["--max", bad] });
    expect(r.code).toBe(1);
    expect(r.errors).toContain("--max must be a non-negative integer");
  }
});

test("prune-history: the checkpoint file is never rewritten by a prune", async () => {
  const cp = writeCheckpointFile("2026-10-02T00:00:00.000Z");
  const before = readFileSync(cp, "utf8");
  await prune({ checkpoints: [cp], deletions: [del("a", "m", "t", "2026-09-01T00:00:00.000Z")], extra: ["--apply"] });
  expect(readFileSync(cp, "utf8")).toBe(before);
});

