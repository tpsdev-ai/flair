import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../helpers/temp-dir.ts";

const cliPath = join(import.meta.dirname, "../../src/cli.ts");

const restOrigin = "http://backup.invalid";
const opsOrigin = "http://backup.invalid:19925";

const agents = [{ id: "flint", name: "Flint" }, { id: "kern", name: "Kern" }];
const memories = agents.flatMap(a => [
  { id: `${a.id}-m1`, agentId: a.id, content: "first" },
  { id: `${a.id}-m2`, agentId: a.id, content: "second" },
]);
const souls = agents.map(a => ({ id: `${a.id}:identity`, agentId: a.id, key: "identity", value: a.name }));

type Reply = { body?: unknown; status?: number; raw?: string; error?: string; delayMs?: number; bodyDelayMs?: number };

function fullCounts() {
  return {
    ops: {
      "describe_table:Agent": { body: { record_count: agents.length } },
      "describe_table:Memory": { body: { record_count: memories.length } },
      "describe_table:Soul": { body: { record_count: souls.length } },
      "search_by_value:Agent:*": { body: agents.map(a => ({ id: a.id })) },
      "search_by_value:Memory:*": { body: memories.map(({ id, agentId }) => ({ id, agentId })) },
      "search_by_value:Soul:*": { body: souls.map(({ id, agentId }) => ({ id, agentId })) },
    } as Record<string, Reply>,
  };
}

/** Data API replies, by default the full store. */
function fullRows() {
  const rest: Record<string, Reply> = {
    "/Agent/": { body: agents },
  };
  for (const agent of agents) {
    rest[`/Memory/?agentId=${agent.id}`] = { body: memories.filter(m => m.agentId === agent.id) };
    rest[`/Soul/?agentId=${agent.id}`] = { body: souls.filter(s => s.agentId === agent.id) };
  }
  return rest;
}

async function runBackup(config: {
  rest?: Record<string, Reply>;
  ops?: Record<string, Reply | Reply[]>;
  port?: string;
  opsTarget?: string;
  opsTargetFlag?: string;
  opsTimeoutMs?: string;
  envOpsTimeoutMs?: string;
  url?: string;
  passFile?: boolean;
  filter?: string;
  local?: boolean;
} = {}) {
  const home = tempDir("flair-backup-2228-");
  const output = join(home, "archive.json");
  const restFixture: Record<string, Reply> = { ...fullRows(), ...(config.rest ?? {}) };
  const opsFixture: Record<string, Reply | Reply[]> = { ...fullCounts().ops, ...(config.ops ?? {}) };

  const passFile = join(home, "admin-pass");
  writeFileSync(passFile, "test-pass", { mode: 0o600 });
  const script = join(home, "run.ts");
  writeFileSync(script, `
import * as fs from "node:fs";
const restFixture = ${JSON.stringify(restFixture)};
const opsFixture = ${JSON.stringify(opsFixture)};
const requests = { rest: [], ops: [], targets: [], timeouts: [], error: null };
const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
AbortSignal.timeout = (ms) => { requests.timeouts.push(ms); return nativeTimeout(ms); };
let abortCause;
const opsCalls = {};
globalThis.fetch = async (url, init) => {
  if (init.headers.Authorization !== "Basic YWRtaW46dGVzdC1wYXNz") throw new Error("incorrect auth");
  if (!init.signal) throw new Error("missing timeout signal");
  const u = new URL(url);
  requests.targets.push(u.origin);
  if (u.origin === ${JSON.stringify((config.opsTargetFlag ?? config.opsTarget)?.replace(/\/$/, "") ?? (config.port ? `http://127.0.0.1:${Number(config.port)-1}` : config.local ? "http://127.0.0.1:19925" : opsOrigin))}) {
    const body = JSON.parse(String(init.body));
    if (body.operation === "describe_table" && body.exact_count !== true) throw new Error("exact_count must be true");
    const key = body.operation === "describe_table"
      ? "describe_table:" + body.table
      : "search_by_value:" + body.table + ":" + body.search_value;
    requests.ops.push(key);
    const replies = opsFixture[key];
    const call = opsCalls[key] ?? 0;
    opsCalls[key] = call + 1;
    const reply = Array.isArray(replies) ? replies[Math.min(call, replies.length - 1)] : replies;
    if (!reply) throw new Error("unexpected ops request " + key);
    if (reply.error) throw new Error(reply.error);
    if (reply.delayMs) await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, reply.delayMs);
      const abort = () => { clearTimeout(timer); abortCause = init.signal.reason; reject(abortCause); };
      if (init.signal.aborted) abort();
      else init.signal.addEventListener("abort", abort, { once: true });
    });
    if (reply.bodyDelayMs) return new Response(new ReadableStream({
      start(controller) {
        const timer = setTimeout(() => { controller.enqueue(new TextEncoder().encode(JSON.stringify(reply.body))); controller.close(); }, reply.bodyDelayMs);
        const abort = () => { clearTimeout(timer); abortCause = new DOMException("The operation was aborted", "AbortError"); controller.error(abortCause); };
        if (init.signal.aborted) abort();
        else init.signal.addEventListener("abort", abort, { once: true });
      },
    }));
    return reply.raw !== undefined ? new Response(reply.raw, { status: reply.status ?? 200 })
      : Response.json(reply.body, { status: reply.status ?? 200 });
  }
  if (u.origin !== ${JSON.stringify(config.url ?? (config.port ? `http://127.0.0.1:${config.port}` : config.local ? "http://127.0.0.1:19926" : restOrigin))}) throw new Error("unexpected target " + u.origin);
  const path = u.pathname + u.search;
  requests.rest.push(path);
  const reply = restFixture[path];
  if (!reply) throw new Error("unexpected request " + path);
  if (reply.error) throw new Error(reply.error);
  return reply.raw !== undefined ? new Response(reply.raw, { status: reply.status ?? 200 })
    : Response.json(reply.body, { status: reply.status ?? 200 });
};
const { program } = await import(${JSON.stringify(cliPath)});
try { await program.parseAsync(process.argv); }
catch (error) {
  requests.error = { name: error.name, causeName: error.cause?.name, causeIsAbortReason: error.cause === abortCause };
  console.error(error.name + ": " + error.message); process.exitCode = 1;
}
finally { fs.writeFileSync(${JSON.stringify(join(home, "requests.json"))}, JSON.stringify(requests)); }
`);

  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(FLAIR_|HARPER_|HDB_|FABRIC_)/.test(key)));
  const proc = Bun.spawn([process.execPath, script, "backup", ...(config.port ? ["--port", config.port] : config.local ? [] : ["--url", config.url ?? restOrigin]), ...(config.url && (config.port || config.local) ? ["--url", config.url] : []), ...(config.filter ? ["--agents", config.filter] : []), ...(config.opsTargetFlag ? ["--ops-target", config.opsTargetFlag] : []), ...(config.opsTimeoutMs !== undefined ? ["--ops-timeout-ms", config.opsTimeoutMs] : []), ...(config.passFile ? ["--admin-pass-file", passFile] : ["--admin-pass", "test-pass"]), "--output", output], {
    env: { ...env, HOME: home, USERPROFILE: home, FLAIR_OPS_PORT: "19925", ...(config.opsTarget ? { FLAIR_OPS_TARGET: config.opsTarget } : {}), ...(config.envOpsTimeoutMs !== undefined ? { FLAIR_BACKUP_OPS_TIMEOUT_MS: config.envOpsTimeoutMs } : {}) }, stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  return {
    home, output, stdout, stderr, exitCode,
    requests: JSON.parse(readFileSync(join(home, "requests.json"), "utf-8")) as { rest: string[]; ops: string[]; targets: string[]; timeouts: number[]; error: { name: string; causeName?: string; causeIsAbortReason: boolean } | null },
  };
}

function expectNoPublication(result: Awaited<ReturnType<typeof runBackup>>) {
  expect(result.exitCode).not.toBe(0);
  expect(result.stdout + result.stderr).not.toContain("Backup complete");
  expect(existsSync(result.output)).toBe(false);
  expect(readdirSync(result.home).filter(n => n.startsWith(".flair-backup-")).length).toBe(0);
}

describe("backup verifies received rows against an independent server count (flair#2228)", () => {
  test("a shortened Memory array is fatal, naming the agent, collection and both counts", async () => {
    // Whole-table count: four Memory rows; flint inventory: two.
    const result = await runBackup({
      rest: { "/Memory/?agentId=flint": { body: memories.filter(m => m.agentId === "flint").slice(0, 1) } },
    });
    expectNoPublication(result);
    expect(result.stderr).toContain("Memory");
    expect(result.stderr).toContain("flint");
    expect(result.stderr).toMatch(/server reports 2 rows, backup read 1/);
    expect(result.requests.ops).toContain("search_by_value:Memory:*");
    expect(result.stderr).not.toContain("first");
    expect(result.stderr).not.toContain("second");
  });

  test("a shortened Soul array is fatal, naming the agent, collection and both counts", async () => {
    const result = await runBackup({ rest: { "/Soul/?agentId=kern": { body: [] } } });
    expectNoPublication(result);
    expect(result.stderr).toContain("Soul");
    expect(result.stderr).toContain("kern");
    expect(result.stderr).toMatch(/server reports 1 rows, backup read 0/);
  });

  test("a shortened Agent array is fatal (whole-table describe_table count)", async () => {
    const result = await runBackup({ rest: { "/Agent/": { body: agents.slice(0, 1) } } });
    expectNoPublication(result);
    expect(result.stderr).toContain("Agent");
    expect(result.stderr).toMatch(/server reports 2 rows, backup read 1/);
    expect(result.requests.ops).toContain("describe_table:Agent");
  });

  test("a failed count read refuses publication (unknown is not a pass)", async () => {
    const result = await runBackup({ ops: { "describe_table:Agent": { status: 503, body: { error: "unavailable" } } } });
    expectNoPublication(result);
    expect(result.stderr).toContain("Agent row count");
    expect(result.stderr).toContain("503");
  });

  test("a count response without record_count refuses publication", async () => {
    const result = await runBackup({ ops: { "describe_table:Agent": { body: { table: "Agent" } } } });
    expectNoPublication(result);
    expect(result.stderr).toContain("record_count");
  });

  test("a non-array inventory response refuses publication", async () => {
    const result = await runBackup({ ops: { "search_by_value:Memory:*": { body: { not: "rows" } } } });
    expectNoPublication(result);
    expect(result.stderr).toContain("Memory inventory");
    expect(result.stderr).toContain("array");
  });

  test("equal counts publish the archive unchanged", async () => {
    const result = await runBackup();
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("Backup complete");
    const archive = JSON.parse(readFileSync(result.output, "utf-8"));
    expect(archive).toMatchObject({ version: 1, source: restOrigin, agents, memories, souls });
    expect(result.requests.ops).toContain("describe_table:Agent");
    expect(result.requests.ops).toContain("search_by_value:Memory:*");
    expect(result.requests.ops).toContain("search_by_value:Soul:*");
  });
  for (const table of ["Agent", "Memory", "Soul"]) {
    test(`${table}: equal-short ops and REST listings fail against storage`, async () => {
      const rows = table === "Agent" ? agents : table === "Memory" ? memories : souls;
      const shortened = rows.slice(1);
      const rest = table === "Agent" ? { "/Agent/": { body: shortened } } : Object.fromEntries(
        agents.map(a => [`/${table}/?agentId=${a.id}`, { body: shortened.filter((r: any) => r.agentId === a.id) }]),
      );
      const result = await runBackup({ ops: { [`search_by_value:${table}:*`]: { body: shortened } }, rest });
      expectNoPublication(result);
      expect(result.stderr).toContain(`${table}: server reports`);
    });
    test(`${table}: an inventory over the storage count fails`, async () => {
      const result = await runBackup({ ops: { [`describe_table:${table}`]: { body: { record_count: 0 } } } });
      expectNoPublication(result);
      expect(result.stderr).toContain(`${table}: server reports 0 rows`);
    });
  }

  for (const table of ["Agent", "Memory", "Soul"]) {
    test(`${table}: REST rows over the expected subset fail`, async () => {
      const path = table === "Agent" ? "/Agent/" : `/${table}/?agentId=flint`;
      const original = fullRows()[path].body as any[];
      const result = await runBackup({ rest: { [path]: { body: [...original, { id: "extra", agentId: "flint" }] } } });
      expectNoPublication(result);
      expect(result.stderr).toContain("backup read");
    });
  }

  test("equal counts with different ids refuse publication", async () => {
    const result = await runBackup({ rest: { "/Memory/?agentId=flint": { body: [
      memories[0], { ...memories[1], id: "substituted" },
    ] } } });
    expectNoPublication(result);
    expect(result.stderr).toContain("ids differ");
  });

  test("selected agents exclude other owners and orphan rows after whole-store validation", async () => {
    const result = await runBackup({ filter: "kern", ops: {
      "describe_table:Memory": { body: { record_count: memories.length + 1 } },
      "search_by_value:Memory:*": { body: [...memories.map(({ id, agentId }) => ({ id, agentId })), { id: "orphan" }] },
    } });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(result.output, "utf-8")).memories).toEqual(memories.filter(m => m.agentId === "kern"));
    expect(result.requests.rest).not.toContain("/Memory/?agentId=flint");
  });

  test("private and closed Memory rows remain in the expected subset", async () => {
    const result = await runBackup({ rest: { "/Memory/?agentId=flint": { body: memories.filter(m => m.agentId === "flint").map(m => ({ ...m, visibility: "private", validTo: "closed" })) } } });
    expect(result.exitCode).toBe(0);
  });

  test("a concurrent delete during the count/listing interval refuses publication", async () => {
    const result = await runBackup({ ops: { "describe_table:Memory": [{ body: { record_count: memories.length } }, { body: { record_count: memories.length - 1 } }] } });
    expectNoPublication(result);
    expect(result.stderr).toContain("source count changed");
    expect((await runBackup()).exitCode).toBe(0);
  });

  test("a same-count owner change at the final recheck refuses publication", async () => {
    const rows = memories.map(({ id, agentId }) => ({ id, agentId }));
    const result = await runBackup({ ops: { "search_by_value:Memory:*": [{ body: rows }, { body: rows.map((m, i) => i ? m : { ...m, agentId: "kern" }) }] } });
    expectNoPublication(result);
    expect(result.stderr).toContain("source ids changed");
  });

  for (const path of ["ops", "REST"]) {
    for (const status of [503, 200]) {
      test(`${path} failure omits response content (${status})`, async () => {
        const reply = { status, raw: "ROW_CONTENT_SENTINEL_2228" };
        const result = await runBackup(path === "ops" ? { ops: { "describe_table:Agent": reply } } : { rest: { "/Agent/": reply } });
        expectNoPublication(result);
        expect(result.stderr).not.toContain(reply.raw);
        expect(result.stderr).toContain(status === 200 ? "invalid JSON response" : String(status));
      });
    }
  }

  test("explicit port pairs with its instance despite another instance's configured ops port", async () => {
    const result = await runBackup({ port: "29926" });
    expect(result.exitCode).toBe(0);
    expect(result.requests.targets).toContain("http://127.0.0.1:29925");
    expect(result.requests.targets).not.toContain("http://127.0.0.1:19925");
  });

  test("explicit ops target overrides the explicit port pair", async () => {
    const result = await runBackup({ port: "29926", opsTarget: "http://explicit.invalid" });
    expect(result.exitCode).toBe(0);
    expect(result.requests.targets).toContain("http://explicit.invalid");
    expect(result.requests.targets).not.toContain("http://127.0.0.1:29925");
  });

  test("portless local backup retains configured ops resolution", async () => {
    expect((await runBackup({ local: true })).exitCode).toBe(0);
  });

  test("backup --url --ops-target --admin-pass-file uses the flag over the environment", async () => {
    const result = await runBackup({
      url: "https://cluster.org.harperfabric.invalid",
      opsTargetFlag: "https://cluster.org.harperfabric.invalid:9925/",
      opsTarget: "https://wrong.invalid:9925",
      passFile: true,
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(result.output, "utf8")).memories).toEqual(memories);
    expect(result.requests.targets).toContain("https://cluster.org.harperfabric.invalid:9925");
    expect(result.requests.targets).not.toContain("https://wrong.invalid:9925");
  });

  test("ops target flag wins over the explicit port pair", async () => {
    const result = await runBackup({ port: "29926", opsTargetFlag: "http://flag.invalid" });
    expect(result.exitCode).toBe(0);
    expect(result.requests.targets).toContain("http://flag.invalid");
    expect(result.requests.targets).not.toContain("http://127.0.0.1:29925");
  });

  test("explicit port pairing precedes URL derivation", async () => {
    const result = await runBackup({ port: "29926", url: restOrigin });
    expect(result.exitCode).toBe(0);
    expect(result.requests.targets).toContain("http://127.0.0.1:29925");
    expect(result.requests.targets).not.toContain(opsOrigin);
  });

  test("default operations timeout stays at 10 seconds", async () => {
    const result = await runBackup();
    expect(result.exitCode).toBe(0);
    expect(result.requests.timeouts).toHaveLength(result.requests.ops.length + result.requests.rest.length);
    expect(result.requests.timeouts.every(ms => ms === 10_000)).toBe(true);
  });

  test("timeout flag overrides the environment for every ops request and recheck", async () => {
    const result = await runBackup({ opsTimeoutMs: "600000", envOpsTimeoutMs: "invalid" });
    expect(result.exitCode).toBe(0);
    expect(result.requests.timeouts.filter(ms => ms === 600_000)).toHaveLength(result.requests.ops.length);
    expect(result.requests.timeouts.filter(ms => ms === 10_000)).toHaveLength(result.requests.rest.length);
  });

  test("timeout environment configures every ops request and recheck", async () => {
    const result = await runBackup({ envOpsTimeoutMs: "120000" });
    expect(result.exitCode).toBe(0);
    expect(result.requests.timeouts.filter(ms => ms === 120_000)).toHaveLength(result.requests.ops.length);
  });

  for (const value of ["0", "-1", "1.5", "600001", "9007199254740992", "NaN", ""]) {
    for (const source of ["flag", "env"]) {
      test(`invalid timeout ${JSON.stringify(value)} from ${source} refuses before requests`, async () => {
        const result = await runBackup(source === "flag" ? { opsTimeoutMs: value } : { envOpsTimeoutMs: value });
        expectNoPublication(result);
        expect(result.stderr).toContain("must be an integer from 1 to 600000");
        expect(result.requests.targets).toEqual([]);
      });
    }
  }

  for (const key of ["describe_table:Agent", "search_by_value:Agent:*"]) {
    for (const final of [false, true]) {
      for (const stage of ["headers", "body"]) {
        test(`${key} ${final ? "final recheck" : "initial read"} ${stage} preserves a named timeout and its cause`, async () => {
          const body = fullCounts().ops[key].body;
          const timeoutReply = stage === "headers" ? { body, delayMs: 50 } : { body, bodyDelayMs: 50 };
          const result = await runBackup({ opsTimeoutMs: "1", ops: {
            [key]: final ? [{ body }, ...(key.startsWith("describe") ? [{ body }] : []), timeoutReply] : timeoutReply,
          } });
          expectNoPublication(result);
          expect(result.stderr).toContain("TimeoutError: Agent " + (key.startsWith("describe") ? "row count" : "inventory") + ": request timed out after 1ms");
          expect(result.stderr).not.toContain("request failed");
          expect(result.stderr).not.toContain("invalid JSON response");
          expect(result.requests.error).toEqual({ name: "TimeoutError", causeName: stage === "headers" ? "TimeoutError" : "AbortError", causeIsAbortReason: true });
        });
      }
    }
  }

  test("a slow operations request succeeds within the configured timeout", async () => {
    const result = await runBackup({ opsTimeoutMs: "1000", ops: {
      "describe_table:Agent": { body: fullCounts().ops["describe_table:Agent"].body, delayMs: 20 },
      "search_by_value:Agent:*": { body: fullCounts().ops["search_by_value:Agent:*"].body, delayMs: 20 },
    } });
    expect(result.exitCode).toBe(0);
    expect(existsSync(result.output)).toBe(true);
  });

  test("ordinary ops fetch failures remain sanitized", async () => {
    const result = await runBackup({ ops: { "describe_table:Agent": { error: "SECRET_NETWORK_SENTINEL" } } });
    expectNoPublication(result);
    expect(result.stderr).toContain("Agent row count: request failed");
    expect(result.stderr).not.toContain("SECRET_NETWORK_SENTINEL");
  });

});
