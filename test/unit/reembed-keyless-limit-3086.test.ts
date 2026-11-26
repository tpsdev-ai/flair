/**
 * reembed-keyless-limit-3086.test.ts — the keyless single-agent listing
 * (flair#3086).
 *
 * `POST /SemanticSearch` has no paging parameter (resources/SemanticSearch.ts),
 * so a response of exactly `KEYLESS_SEARCH_LIMIT` rows may be a truncated read.
 * The command prints one notice naming the count and the remedy, then exits 1;
 * a shorter response prints no notice and returns normally.
 *
 * Runs the real command in-process with a stubbed fetch and a captured exit.
 */
import { afterEach, expect, test } from "bun:test";
import { Command } from "commander";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import nacl from "tweetnacl";
import { tempDir } from "../helpers/temp-dir";
import { KEYLESS_SEARCH_LIMIT, bindCli, register } from "../../src/commands/reembed.ts";
import { getModelId } from "../../resources/embeddings-provider.ts";

const patched: string[] = [];

const realFetch = globalThis.fetch;
const realExit = process.exit;
const realLog = console.log;
const realError = console.error;

afterEach(() => {
  globalThis.fetch = realFetch;
  process.exit = realExit;
  console.log = realLog;
  console.error = realError;
});

function rows(count: number): Record<string, unknown>[] {
  // A `POST /SemanticSearch` listing carries each row's agentId; flair#3129
  // reads it to keep only this agent's rows.
  return Array.from({ length: count }, (_, i) => ({ id: `m-${i}`, agentId: "agent-a", content: "a memory", embeddingModel: "model-1" }));
}

async function run(seed: Record<string, unknown>[], dryRun = true): Promise<{ exitCode: number | null; logs: string[] }> {
  patched.length = 0;
  globalThis.fetch = (async (url: unknown, init: unknown) => {
    const href = String(url);
    if (href.endsWith("/Health")) {
      return Response.json({ version: "test", capabilities: ["memory-reembed-patch"] });
    }
    const method = String((init as { method?: unknown } | null)?.method ?? "GET").toUpperCase();
    if (method === "PATCH") {
      const id = decodeURIComponent(href.split("/").pop() ?? "");
      patched.push(id);
      return Response.json({ id });
    }
    if (method === "GET" && href.includes("/Memory/")) {
      const id = decodeURIComponent(href.split("/").pop() ?? "");
      return Response.json({ id, embeddingModel: getModelId() });
    }
    return Response.json({ results: seed });
  }) as typeof fetch;

  const key = join(tempDir("reembed-keyless-3086-"), "agent-a.key");
  writeFileSync(key, nacl.sign.keyPair().secretKey.slice(0, 32), { mode: 0o600 });
  bindCli({
    privKeyPath: () => key,
    resolveHttpPort: (opts: any) => Number(opts.port),
    resolveOpsPort: () => 1,
    resolveAgentHomeTarget: (opts: any) => ({ httpPort: Number(opts.port), opsPort: 1, pairBound: false }),
    ambiguousInstanceTargetError: "ambiguous_instance_target",
  });

  const logs: string[] = [];
  let exitCode: number | null = null;
  process.exit = ((code?: number) => {
    exitCode = code ?? 0;
    throw new Error(`EXIT:${exitCode}`);
  }) as typeof process.exit;
  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
  console.error = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };

  const saved = { pass: process.env.FLAIR_ADMIN_PASS, hdb: process.env.HDB_ADMIN_PASSWORD };
  delete process.env.FLAIR_ADMIN_PASS;
  delete process.env.HDB_ADMIN_PASSWORD;
  try {
    const program = new Command().exitOverride();
    register(program);
    const args = ["reembed", "--agent", "agent-a", "--port", "1", "--stale-only"];
    if (dryRun) args.push("--dry-run");
    await program.parseAsync(args, { from: "user" });
  } catch (err) {
    if (!(err instanceof Error) || !err.message.startsWith("EXIT:")) throw err;
  } finally {
    if (saved.pass === undefined) delete process.env.FLAIR_ADMIN_PASS; else process.env.FLAIR_ADMIN_PASS = saved.pass;
    if (saved.hdb === undefined) delete process.env.HDB_ADMIN_PASSWORD; else process.env.HDB_ADMIN_PASSWORD = saved.hdb;
  }
  return { exitCode, logs };
}

test("exactly the limit prints one notice naming the count and the remedy, and exits 1", async () => {
  const { exitCode, logs } = await run(rows(KEYLESS_SEARCH_LIMIT));
  expect(exitCode).toBe(1);
  const notices = logs.filter((line) => line.includes("more rows may exist"));
  expect(notices).toHaveLength(1);
  expect(notices[0]).toContain(String(KEYLESS_SEARCH_LIMIT));
  expect(notices[0]).toContain("FLAIR_ADMIN_PASS");
}, 10_000);

test("one row below the limit prints no notice and returns normally", async () => {
  const { exitCode, logs } = await run(rows(KEYLESS_SEARCH_LIMIT - 1));
  expect(exitCode).toBeNull();
  expect(logs.some((line) => line.includes("more rows may exist"))).toBe(false);
}, 10_000);

test("without --dry-run the limit still processes its candidate, prints the notice once and exits 1", async () => {
  const current = getModelId();
  const seed = rows(KEYLESS_SEARCH_LIMIT).map((row) => ({ ...row, embeddingModel: current }));
  seed[seed.length - 1] = { ...seed[seed.length - 1], embeddingModel: "model-1" };
  const { exitCode, logs } = await run(seed, false);
  expect(patched).toEqual([`m-${KEYLESS_SEARCH_LIMIT - 1}`]);
  const notices = logs.filter((line) => line.includes("more rows may exist"));
  expect(notices).toHaveLength(1);
  expect(notices[0]).toContain(String(KEYLESS_SEARCH_LIMIT));
  expect(notices[0]).toContain("FLAIR_ADMIN_PASS");
  expect(exitCode).toBe(1);
}, 30_000);
