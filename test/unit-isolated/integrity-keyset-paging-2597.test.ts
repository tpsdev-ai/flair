/**
 * integrity-keyset-paging-2597.test.ts — the integrity scan's Memory read (and its
 * bounded deletion-history read) walk the table by keyset on `id` (flair#2597).
 *
 * The fake operations API models a real keyset page server: it answers
 * `SELECT <cols> FROM flair.<table> [WHERE (filter) AND] id > 'cursor' ORDER BY id LIMIT n`
 * from a live store, so a write between two page requests is visible to the next page
 * exactly as Harper would present it. A page size of MEMORY_PAGE_SIZE (10000) forces the
 * boundary with a store of one page plus one row.
 */
import { expect, test } from "bun:test";
import { Command } from "commander";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bindIntegrityCli, register } from "../../src/commands/integrity";
import { emptyCheckpoint } from "../../src/lib/memory-integrity";
import { MEMORY_PAGE_SIZE } from "../../src/memory-id-checkpoint";
import { opsTable } from "../helpers/ops-table";
import { tempDir } from "../helpers/temp-dir";

const PAGE = MEMORY_PAGE_SIZE;

function memRow(i: number): Record<string, unknown> {
  return { id: `m${String(i).padStart(5, "0")}`, durability: "permanent", instanceToken: `t${i}` };
}

/** One keyset page, as the operations API would assemble it. */
function pageOf(store: Record<string, unknown>[], sql: string): Record<string, unknown>[] {
  const limit = Number(/LIMIT (\d+)/.exec(sql)?.[1] ?? "0");
  const cursor = /id > '((?:[^']|'')*)'/.exec(sql)?.[1]?.replace(/''/g, "'");
  const at = /\(at >= '([^']*)'\)/.exec(sql)?.[1];
  let rows = [...store].sort((a, b) => (a.id as string) < (b.id as string) ? -1 : (a.id as string) > (b.id as string) ? 1 : 0);
  if (at !== undefined) rows = rows.filter((r) => String(r.at ?? "") >= at);
  if (cursor !== undefined) rows = rows.filter((r) => (r.id as string) > cursor);
  return rows.slice(0, limit);
}

interface Harness {
  checkpointPath: string;
  memory: Record<string, unknown>[];
  deletions: Record<string, unknown>[];
  pageSqls: string[];
  memoryPages: number;
}

async function scan(opts: {
  memory: Record<string, unknown>[];
  deletions?: Record<string, unknown>[];
  baseline?: boolean;
  /** Fires after Memory page `i` is assembled and before the next page is requested. */
  onMemoryPage?: (h: Harness, page: number) => void;
  /** The second Memory page repeats the previous page's last id once. */
  duplicateSecondPage?: boolean;
}): Promise<{ code: number | undefined; verdict: any; saved?: string; h: Harness }> {
  const path = join(tempDir("flair-2597-paging-"), "checkpoint.json");
  if (opts.baseline) writeFileSync(path, JSON.stringify(emptyCheckpoint("2026-10-02T00:00:00.000Z", [])));
  const h: Harness = { checkpointPath: path, memory: opts.memory, deletions: opts.deletions ?? [], pageSqls: [], memoryPages: 0 };
  const originalFetch = globalThis.fetch;
  const originalExit = process.exit;
  const originalWrite = process.stdout.write;
  let output = "";
  let code: number | undefined;
  let prevLastId: string | undefined;
  let duplicated = false;
  try {
    bindIntegrityCli({ resolveOpsPort: () => 19925, resolveAdminUser: () => "agent-a" });
    globalThis.fetch = (async (_url: any, init: any) => {
      const body = JSON.parse(init.body);
      const { operation } = body;
      if (operation === "delete") return new Response(JSON.stringify({ deleted_hashes: body.hash_values }));
      const table = opsTable(body);
      const store = table === "Memory" ? h.memory : h.deletions;
      if (operation === "describe_table") return new Response(JSON.stringify({ record_count: store.length }));
      if (operation === "sql") {
        const sql = String(body.sql);
        if (/COUNT\(\*\)/i.test(sql)) return new Response(JSON.stringify([{ n: store.length }]));
        if (table === "Memory") {
          h.pageSqls.push(sql);
          let rows = pageOf(store, sql);
          if (opts.duplicateSecondPage && !duplicated && h.memoryPages === 1 && prevLastId !== undefined) {
            rows = [{ id: prevLastId, durability: "permanent", instanceToken: "dup" }, ...rows];
            duplicated = true;
          }
          if (rows.length > 0) prevLastId = rows[rows.length - 1].id as string;
          const page = h.memoryPages++;
          opts.onMemoryPage?.(h, page);
          return new Response(JSON.stringify(rows));
        }
        return new Response(JSON.stringify(pageOf(store, sql)));
      }
      return new Response(JSON.stringify([]));
    }) as typeof fetch;
    process.exit = ((value: number) => { code = value; throw new Error(`exit:${value}`); }) as typeof process.exit;
    process.stdout.write = ((value: any) => { output += String(value); return true; }) as typeof process.stdout.write;
    const program = new Command();
    register(program);
    await expect(program.parseAsync(["integrity", "check", "--json", "--checkpoint", path, "--admin-pass", "secret"], { from: "user" })).rejects.toThrow("exit:");
  } finally {
    globalThis.fetch = originalFetch;
    process.exit = originalExit;
    process.stdout.write = originalWrite;
  }
  return { code, verdict: JSON.parse(output), saved: existsSync(path) ? readFileSync(path, "utf8") : undefined, h };
}

function store(n: number): Record<string, unknown>[] {
  return Array.from({ length: n }, (_, i) => memRow(i));
}

test("keyset pages walk the Memory table once, in id order, across a page boundary", async () => {
  const rows = store(PAGE + 1);
  const r = await scan({ memory: rows });
  expect(r.verdict.status).toBe("baseline");
  expect(r.verdict.total).toBe(PAGE + 1);
  expect(r.h.pageSqls).toHaveLength(2);
  expect(r.h.pageSqls[0]).toContain("SELECT id, durability, instanceToken FROM flair.Memory ORDER BY id LIMIT");
  expect(r.h.pageSqls[0]).not.toContain("id >");
  expect(r.h.pageSqls[1]).toContain(`id > '${memRow(PAGE - 1).id}'`);
  const savedIds = Object.keys(JSON.parse(r.saved!).ids);
  expect(savedIds).toEqual(rows.map((row) => row.id as string));
});

test("a duplicate id across pages is refused and the scan is retried", async () => {
  const r = await scan({ memory: store(PAGE + 1), duplicateSecondPage: true });
  // Attempt 1 refuses the repeated id; attempt 2 reads clean and establishes the baseline.
  expect(r.verdict.status).toBe("baseline");
  expect(r.verdict.total).toBe(PAGE + 1);
  expect(r.h.memoryPages).toBe(4);
});

test("a duplicate inside one page is refused and retried", async () => {
  let first = true;
  const originalFetch = globalThis.fetch;
  const originalExit = process.exit;
  const originalWrite = process.stdout.write;
  const path = join(tempDir("flair-2597-dup-"), "checkpoint.json");
  const memory = [{ id: "m1", durability: "permanent", instanceToken: "t1" }];
  let output = "";
  let code: number | undefined;
  try {
    bindIntegrityCli({ resolveOpsPort: () => 19925, resolveAdminUser: () => "agent-a" });
    globalThis.fetch = (async (_url: any, init: any) => {
      const body = JSON.parse(init.body);
      if (body.operation === "delete") return new Response(JSON.stringify({ deleted_hashes: body.hash_values }));
      const table = opsTable(body);
      if (body.operation === "describe_table") return new Response(JSON.stringify({ record_count: table === "Memory" ? 1 : 0 }));
      if (body.operation === "sql") {
        if (/COUNT\(\*\)/i.test(String(body.sql))) return new Response(JSON.stringify([{ n: 0 }]));
        if (table !== "Memory") return new Response(JSON.stringify([]));
        const rows = first ? [memory[0], memory[0]] : memory;
        first = false;
        return new Response(JSON.stringify(rows));
      }
      return new Response(JSON.stringify([]));
    }) as typeof fetch;
    process.exit = ((value: number) => { code = value; throw new Error(`exit:${value}`); }) as typeof process.exit;
    process.stdout.write = ((value: any) => { output += String(value); return true; }) as typeof process.stdout.write;
    const program = new Command();
    register(program);
    await expect(program.parseAsync(["integrity", "check", "--json", "--checkpoint", path, "--admin-pass", "secret"], { from: "user" })).rejects.toThrow("exit:");
  } finally {
    globalThis.fetch = originalFetch;
    process.exit = originalExit;
    process.stdout.write = originalWrite;
  }
  expect(code).toBe(0);
  expect(JSON.parse(output).status).toBe("baseline");
});

test("a row dropped between pages while another is added ahead is read exactly", async () => {
  const first = store(PAGE + 1);
  const r = await scan({
    memory: first,
    onMemoryPage: (h, page) => {
      if (page !== 0) return;
      // Drop the unread tail row, add a new row ahead of the cursor: counts balance.
      h.memory.splice(h.memory.findIndex((row) => row.id === memRow(PAGE).id), 1);
      h.memory.push({ id: "m99999", durability: "permanent", instanceToken: "new" });
    },
  });
  expect(r.verdict.status).toBe("baseline");
  expect(Object.keys(JSON.parse(r.saved!).ids)).toEqual(r.h.memory.map((row) => String(row.id)).sort());
});

test("a row dropped between pages while another is added behind the cursor yields the exact id set or a refusal", async () => {
  const r = await scan({
    memory: store(PAGE + 1),
    onMemoryPage: (h, page) => {
      if (page !== 0) return;
      h.memory.splice(h.memory.findIndex((row) => row.id === memRow(PAGE).id), 1);
      h.memory.push({ id: "m00000a", durability: "permanent", instanceToken: "behind" });
    },
  });
  if (r.verdict.status === "unknown") {
    expect(r.code).toBe(3);
    expect(r.saved).toBeUndefined();
  } else {
    expect(Object.keys(JSON.parse(r.saved!).ids)).toEqual(r.h.memory.map((row) => String(row.id)).sort());
  }
});

test("a writer that drops a row after every page leaves the count unmatched and the scan refuses", async () => {
  const r = await scan({ memory: store(PAGE + 1), onMemoryPage: (h) => { h.memory.pop(); } });
  expect(r.code).toBe(3);
  expect(r.verdict.status).toBe("unknown");
  expect(r.verdict.reason).toContain("inconsistent after 3 attempts");
  expect(r.saved).toBeUndefined();
});

test("the bounded deletion-history read pages by keyset over its watermark range", async () => {
  const memory: { id: string; durability: string; instanceToken?: string | null }[] = [{ id: "m00000", durability: "permanent", instanceToken: "t0" }];
  const deletions = Array.from({ length: PAGE + 1 }, (_, i) => ({ id: `d${String(i).padStart(5, "0")}`, memoryId: "gone", memoryInstanceToken: "old", durability: "permanent", at: "2026-10-02T00:00:00.000Z" }));
  const path = join(tempDir("flair-2597-del-"), "checkpoint.json");
  writeFileSync(path, JSON.stringify(emptyCheckpoint("2026-10-02T00:00:00.000Z", memory, [])));
  const originalFetch = globalThis.fetch;
  const originalExit = process.exit;
  const originalWrite = process.stdout.write;
  const pageSqls: string[] = [];
  let output = "";
  let code: number | undefined;
  try {
    bindIntegrityCli({ resolveOpsPort: () => 19925, resolveAdminUser: () => "agent-a" });
    globalThis.fetch = (async (_url: any, init: any) => {
      const body = JSON.parse(init.body);
      if (body.operation === "delete") return new Response(JSON.stringify({ deleted_hashes: body.hash_values }));
      const table = opsTable(body);
      const store = table === "Memory" ? memory : deletions;
      if (body.operation === "describe_table") return new Response(JSON.stringify({ record_count: store.length }));
      if (body.operation === "sql") {
        const sql = String(body.sql);
        if (/COUNT\(\*\)/i.test(sql)) return new Response(JSON.stringify([{ n: store.length }]));
        if (table === "MemoryDeletionHistory") pageSqls.push(sql);
        return new Response(JSON.stringify(pageOf(store, sql)));
      }
      return new Response(JSON.stringify([]));
    }) as typeof fetch;
    process.exit = ((value: number) => { code = value; throw new Error(`exit:${value}`); }) as typeof process.exit;
    process.stdout.write = ((value: any) => { output += String(value); return true; }) as typeof process.stdout.write;
    const program = new Command();
    register(program);
    await expect(program.parseAsync(["integrity", "check", "--json", "--checkpoint", path, "--admin-pass", "secret"], { from: "user" })).rejects.toThrow("exit:");
  } finally {
    globalThis.fetch = originalFetch;
    process.exit = originalExit;
    process.stdout.write = originalWrite;
  }
  expect(code).toBe(0);
  expect(pageSqls).toHaveLength(2);
  expect(pageSqls[0]).toContain("FROM flair.MemoryDeletionHistory WHERE (at >= '");
  expect(pageSqls[0]).toContain("ORDER BY id LIMIT");
  expect(pageSqls[1]).toContain(`id > '${deletions[PAGE - 1].id}'`);
});
