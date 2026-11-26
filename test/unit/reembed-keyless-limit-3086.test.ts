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
import { afterEach, describe, expect, test } from "bun:test";
import { Command } from "commander";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import nacl from "tweetnacl";
import { tempDir } from "../helpers/temp-dir";
import { KEYLESS_SEARCH_LIMIT, bindCli, register, reembedTargetRefusalRemedy } from "../../src/commands/reembed.ts";
import { resolveAgentHomeTarget } from "../../src/cli.js";
import { setInstancePairOsReadsForTests } from "../../src/lib/local-instance-pair.ts";
import { SIMULATED_LISTENER_TABLE } from "../helpers/simulated-instance-pair";
import { getModelId } from "../../resources/embeddings-provider.ts";

const patched: string[] = [];

const realFetch = globalThis.fetch;
const realExit = process.exit;
const realLog = console.log;
const realError = console.error;

afterEach(() => {
  setInstancePairOsReadsForTests(null);
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

for (const scenario of ["missing HTTP", "missing ops", "missing both", "unavailable listener table", "different proven pair", "override-named different proven pair", "derived target with no configured pair"] as const) {
  test(`the ${scenario} refusal prints its corresponding remedy`, async () => {
    const requests: string[] = [];
    setInstancePairOsReadsForTests(scenario === "unavailable listener table" ? {
      ...SIMULATED_LISTENER_TABLE,
      listeners: () => ({ kind: "unavailable", reason: "simulated unreadable table", remedy: "listener visibility remedy" }),
    } : SIMULATED_LISTENER_TABLE);
    globalThis.fetch = (async (url: unknown) => {
      requests.push(String(url));
      return Response.json({ http: { port: 7926 }, operationsApi: { network: { port: 7925 } } });
    }) as typeof fetch;
    const home = tempDir("reembed-target-3135-");
    const dataDir = join(home, ".flair", "data");
    mkdirSync(dataDir, { recursive: true });
    const configuredHttp = scenario === "missing HTTP" || scenario === "missing both" || scenario === "derived target with no configured pair" ? null
      : scenario === "different proven pair" ? 8926 : scenario === "override-named different proven pair" ? 6926 : 7926;
    const configuredOps = scenario === "missing ops" || scenario === "missing both" || scenario === "derived target with no configured pair" ? null
      : scenario === "override-named different proven pair" ? 6925 : 7925;
    writeFileSync(join(dataDir, "harper-config.yaml"), [
      configuredHttp === null ? "" : `http:\n  port: ${configuredHttp}\n`,
      configuredOps === null ? "" : `operationsApi:\n  network:\n    port: ${configuredOps}\n`,
    ].join(""));
    bindCli({
      privKeyPath: () => { throw new Error("unexpected key read"); },
      resolveHttpPort: () => 8926,
      resolveOpsPort: () => 7925,
      resolveAgentHomeTarget: () => scenario === "derived target with no configured pair"
        ? { httpPort: 8926, opsPort: 7925, pairBound: false }
        : resolveAgentHomeTarget({
          dataDir,
          ...(scenario === "missing HTTP" ? {} : { port: scenario === "unavailable listener table" ? 7926 : 8926 }),
          ...(scenario === "missing ops" || scenario === "missing both" ? {} : { opsPort: 7925 }),
        }),
      ambiguousInstanceTargetError: "ambiguous_instance_target",
    });
    const logs: string[] = [];
    process.exit = ((code?: number) => { throw new Error(`EXIT:${code}`); }) as typeof process.exit;
    console.log = console.error = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
    const saved = {
      pass: process.env.FLAIR_ADMIN_PASS, hdb: process.env.HDB_ADMIN_PASSWORD,
      url: process.env.FLAIR_URL, ops: process.env.FLAIR_OPS_PORT, home: process.env.HOME,
    };
    const namedHttp = scenario !== "missing HTTP" && scenario !== "derived target with no configured pair";
    const namedOps = scenario !== "missing ops" && scenario !== "missing both" && scenario !== "derived target with no configured pair";
    process.env.HOME = home;
    delete process.env.FLAIR_URL;
    if (namedOps) process.env.FLAIR_OPS_PORT = "7925"; else delete process.env.FLAIR_OPS_PORT;
    process.env.FLAIR_ADMIN_PASS = "stub-admin-pass";
    delete process.env.HDB_ADMIN_PASSWORD;
    try {
      const program = new Command().exitOverride();
      register(program);
      const args = ["reembed", ...(namedHttp ? ["--port", "8926"] : [])];
      await expect(program.parseAsync(args, { from: "user" })).rejects.toThrow("EXIT:1");
    } finally {
      if (saved.pass === undefined) delete process.env.FLAIR_ADMIN_PASS; else process.env.FLAIR_ADMIN_PASS = saved.pass;
      if (saved.hdb === undefined) delete process.env.HDB_ADMIN_PASSWORD; else process.env.HDB_ADMIN_PASSWORD = saved.hdb;
      if (saved.url === undefined) delete process.env.FLAIR_URL; else process.env.FLAIR_URL = saved.url;
      if (saved.ops === undefined) delete process.env.FLAIR_OPS_PORT; else process.env.FLAIR_OPS_PORT = saved.ops;
      if (saved.home === undefined) delete process.env.HOME; else process.env.HOME = saved.home;
    }
    const output = logs.join("\n");
    expect(output).toContain("ambiguous_instance_target");
    // One remedy per condition: each case asserts its own and none of the others'.
    const remedies = [
      `Only the ${scenario === "missing HTTP" ? "ops" : "HTTP"} port was supplied; the ${scenario === "missing HTTP" ? "HTTP" : "ops"} port is missing.`,
      "run flair reembed where it can read Harper's listeners",
      "The configured pair does not match the running instance",
      "The named ports do not match the running instance",
      "No port was named and the configuration names no complete pair",
    ];
    const expected = scenario.startsWith("missing") ? 0 : scenario === "unavailable listener table" ? 1
      : scenario === "different proven pair" ? 2 : scenario === "override-named different proven pair" ? 3 : 4;
    for (const [index, remedy] of remedies.entries()) {
      if (index === expected) expect(output).toContain(remedy);
      else expect(output).not.toContain(remedy);
    }
    if (expected === 0) {
      expect(output).not.toContain("different instance ids");
      expect(requests).toEqual([]);
    } else {
      expect(requests).toEqual(["http://127.0.0.1:7925/"]);
    }
    if (expected === 1) {
      expect(output).toContain("could not read the OS listener table");
      expect(output).not.toContain("does not match");
    }
    if (expected === 2) expect(output).toContain("check ~/.flair/config.yaml");
  }, 10_000);
}

describe("reembedTargetRefusalRemedy — one remedy per condition (flair#3128)", () => {
  test("(a) a derived target with no complete configured pair never names an override the operator did not pass", () => {
    const remedy = reembedTargetRefusalRemedy({ kind: "pair-mismatch", source: "derived" });
    expect(remedy).toContain("No port was named and the configuration names no complete pair");
    expect(remedy).toContain("complete ~/.flair/config.yaml");
    expect(remedy).not.toContain("Only the");
    expect(remedy).not.toContain("different instance ids");
  });

  test("(b) a one-sided target names the supplied side and the missing side", () => {
    const remedy = reembedTargetRefusalRemedy({ kind: "one-sided", supplied: "ops", missing: "HTTP" });
    expect(remedy).toContain("Only the ops port was supplied; the HTTP port is missing");
    expect(remedy).not.toContain("No port was named");
    expect(remedy).not.toContain("different instance ids");
  });

  test("(c) an instance-id disagreement points both ports at one instance", () => {
    const remedy = reembedTargetRefusalRemedy({ kind: "identity-mismatch" });
    expect(remedy).toContain("report different instance ids; point both at one instance");
    expect(remedy).not.toContain("No port was named");
    expect(remedy).not.toContain("Only the");
    expect(remedy).not.toContain("configured pair");
  });
});
