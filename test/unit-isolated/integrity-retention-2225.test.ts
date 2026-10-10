import { expect, test, spyOn } from "bun:test";
import { Command } from "commander";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bindIntegrityCli, register } from "../../src/commands/integrity";
import { emptyCheckpoint, type MemoryRowLite, type DeletionRecordLite } from "../../src/lib/memory-integrity";
import { tempDir } from "../helpers/temp-dir";

function fixture() {
  const path = join(tempDir("flair-integrity-retention-"), "checkpoint.json");
  let rows: MemoryRowLite[] = [{ id: "m", durability: "permanent", instanceToken: "m-token" }, { id: "n", durability: "persistent", instanceToken: "n-token" }];
  const deletions = new Map<string, DeletionRecordLite>();
  let race: (() => void) | undefined;
  let pruneResponse: unknown;
  const batches: string[][] = [];
  const fetchMock = spyOn(globalThis, "fetch").mockImplementation((async (_url: any, init: any) => {
    const { operation, table, hash_values } = JSON.parse(init.body);
    if (operation === "delete") {
      expect(table).toBe("MemoryDeletionHistory");
      expect(JSON.parse(readFileSync(path, "utf8")).historyIds.length).toBeLessThanOrEqual(rows.length);
      batches.push(hash_values);
      if (pruneResponse !== undefined) return new Response(JSON.stringify(pruneResponse));
      for (const id of hash_values) expect(deletions.delete(id)).toBe(true);
      return new Response(JSON.stringify({ deleted_hashes: hash_values }));
    }
    if (table === "MemoryDeletionHistory" && race) { const run = race; race = undefined; run(); }
    const selected = table === "Memory" ? rows : [...deletions.values()];
    if (operation === "describe_table") return new Response(JSON.stringify({ record_count: selected.length }));
    if (operation === "sql") return new Response(JSON.stringify([{ n: selected.length }]));
    const response = new Response(JSON.stringify(selected));
    return response;
  }) as typeof fetch);
  const exitMock = spyOn(process, "exit").mockImplementation(((code: number) => { throw new Error(`exit:${code}`); }) as typeof process.exit);
  let output = "";
  const outputMock = spyOn(process.stdout, "write").mockImplementation(((value: any) => { output += String(value); return true; }) as typeof process.stdout.write);
  bindIntegrityCli({ resolveOpsPort: () => 19925, resolveAdminUser: () => "admin" });
  return {
    path, deletions, batches,
    setRows: (value: MemoryRowLite[]) => { rows = value; },
    setRace: (value: () => void) => { race = value; },
    setPruneResponse: (value: unknown) => { pruneResponse = value; },
    scan: async (code: number, accept = false) => {
      output = "";
      const program = new Command();
      register(program);
      await expect(program.parseAsync(["integrity", "check", "--json", "--checkpoint", path, "--admin-pass", "secret", ...(accept ? ["--accept"] : [])], { from: "user" })).rejects.toThrow(`exit:${code}`);
      return JSON.parse(output);
    },
    close: () => { fetchMock.mockRestore(); exitMock.mockRestore(); outputMock.mockRestore(); },
  };
}

test("checkpoint prunes absorbed and untracked history, retains a raced durable delete, then still detects raw loss", async () => {
  const f = fixture();
  try {
    for (let i = 0; i < 600; i++) f.deletions.set(`old-${i}`, { id: `old-${i}`, memoryId: "untracked", memoryInstanceToken: `${i}`, at: "old" });
    f.deletions.set("stale", { id: "stale", memoryId: "n", memoryInstanceToken: "old-n-token", at: "old" });
    f.setRace(() => {
      f.deletions.set("raced", { id: "raced", memoryId: "m", memoryInstanceToken: "m-token", at: "raced" });
      f.setRows([{ id: "n", durability: "persistent", instanceToken: "n-token" }]);
    });
    expect((await f.scan(0)).status).toBe("baseline");
    expect([...f.deletions.keys()]).toEqual(["raced"]);
    expect(f.batches.map(batch => batch.length)).toEqual([256, 256, 89]);
    expect(JSON.parse(readFileSync(f.path, "utf8")).historyIds).toEqual([]);
    const next = await f.scan(0);
    expect(next.attributedDeletes).toEqual([{ id: "m", tier: "permanent", at: "raced" }]);
    expect(f.deletions.size).toBe(0);
    f.setRows([]);
    f.deletions.set("recorded-n", { id: "recorded-n", memoryId: "n", memoryInstanceToken: "n-token", at: "later" });
    expect((await f.scan(0)).attributedDeletes).toEqual([{ id: "n", tier: "persistent", at: "later" }]);
    expect(f.deletions.size).toBe(0);
    f.setRows([{ id: "raw", durability: "permanent", instanceToken: "raw-token" }]);
    await f.scan(0);
    const before = readFileSync(f.path, "utf8");
    f.setRows([]);
    expect((await f.scan(2)).losses).toEqual([{ id: "raw", tier: "permanent" }]);
    expect(readFileSync(f.path, "utf8")).toBe(before);
  } finally { f.close(); }
});

test("seen matching history stays suppressed if pruning fails after the checkpoint lands", async () => {
  const f = fixture();
  try {
    const row = { id: "m", durability: "permanent", instanceToken: "m-token" };
    f.setRows([row]);
    f.deletions.set("seen", { id: "seen", memoryId: "m", memoryInstanceToken: "m-token", at: "old" });
    writeFileSync(f.path, JSON.stringify({ ...emptyCheckpoint("before", [row]), historyIds: ["seen"] }));
    f.setPruneResponse({ deleted_hashes: [] });
    const failed = await f.scan(3);
    expect(failed.checkpointWritten).toBe(true);
    expect(failed.reason).toContain("retention was not confirmed");
    expect(JSON.parse(readFileSync(f.path, "utf8")).historyIds).toEqual(["seen"]);
    f.setRows([]);
    expect((await f.scan(2)).losses).toEqual([{ id: "m", tier: "permanent" }]);
    expect(f.batches.length).toBe(1);
  } finally { f.close(); }
});

test("checkpoint write failure never prunes history", async () => {
  const f = fixture();
  const fs = await import("node:fs");
  const rename = spyOn(fs, "renameSync").mockImplementation(() => { throw new Error("checkpoint rename failed"); });
  try {
    f.deletions.set("old", { id: "old", memoryId: "untracked", at: "old" });
    writeFileSync(f.path, JSON.stringify(emptyCheckpoint("before", [])));
    const before = readFileSync(f.path, "utf8");
    const verdict = await f.scan(3);
    expect(verdict.reason).toContain("checkpoint rename failed");
    expect(verdict.checkpointWritten).toBe(false);
    expect(readFileSync(f.path, "utf8")).toBe(before);
    expect(f.batches).toEqual([]);
    expect(f.deletions.size).toBe(1);
  } finally { rename.mockRestore(); f.close(); }
});
