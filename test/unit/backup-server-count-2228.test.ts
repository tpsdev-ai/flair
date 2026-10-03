import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../helpers/temp-dir.ts";

/**
 * flair#2228: `flair backup` verified the staged archive against the rows it
 * RECEIVED, so a read that succeeded but returned fewer rows than the store
 * holds still ended in "Backup complete". These tests drive a fake data API
 * that returns a valid but shortened array while the fake operations API
 * reports the full row count, and assert backup refuses to publish.
 */

const modulePath = join(import.meta.dirname, "../../src/commands/backup.ts");
const commanderPath = import.meta.resolve("commander");

const restOrigin = "http://backup.invalid";
const opsOrigin = "http://backup.invalid:19925";

const agents = [{ id: "flint", name: "Flint" }, { id: "kern", name: "Kern" }];
const memories = agents.flatMap(a => [
  { id: `${a.id}-m1`, agentId: a.id, content: "first" },
  { id: `${a.id}-m2`, agentId: a.id, content: "second" },
]);
const souls = agents.map(a => ({ id: `${a.id}:identity`, agentId: a.id, key: "identity", value: a.name }));

type Reply = { body?: unknown; status?: number; raw?: string; error?: string };

/** Independent counts (the ops API's view of the store), by default the full store. */
function fullCounts() {
  return {
    ops: {
      "describe_table:Agent": { body: { record_count: agents.length } },
      ...Object.fromEntries(agents.map(a => [`search_by_value:Memory:${a.id}`, { body: memories.filter(m => m.agentId === a.id).map(m => ({ id: m.id })) }])),
      ...Object.fromEntries(agents.map(a => [`search_by_value:Soul:${a.id}`, { body: souls.filter(s => s.agentId === a.id).map(s => ({ id: s.id })) }])),
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
  ops?: Record<string, Reply>;
} = {}) {
  const home = tempDir("flair-backup-2228-");
  const output = join(home, "archive.json");
  const restFixture: Record<string, Reply> = { ...fullRows(), ...(config.rest ?? {}) };
  const opsFixture: Record<string, Reply> = { ...fullCounts().ops, ...(config.ops ?? {}) };

  const script = join(home, "run.ts");
  writeFileSync(script, `
import * as fs from "node:fs";
const restFixture = ${JSON.stringify(restFixture)};
const opsFixture = ${JSON.stringify(opsFixture)};
const requests = { rest: [], ops: [] };
globalThis.fetch = async (url, init) => {
  if (init.headers.Authorization !== "Basic YWRtaW46dGVzdC1wYXNz") throw new Error("incorrect auth");
  if (!init.signal) throw new Error("missing timeout signal");
  const u = new URL(url);
  if (u.origin === ${JSON.stringify(opsOrigin)}) {
    const body = JSON.parse(String(init.body));
    const key = body.operation === "describe_table"
      ? "describe_table:" + body.table
      : "search_by_value:" + body.table + ":" + body.search_value;
    requests.ops.push(key);
    const reply = opsFixture[key];
    if (!reply) throw new Error("unexpected ops request " + key);
    if (reply.error) throw new Error(reply.error);
    return reply.raw !== undefined ? new Response(reply.raw, { status: reply.status ?? 200 })
      : Response.json(reply.body, { status: reply.status ?? 200 });
  }
  if (u.origin !== ${JSON.stringify(restOrigin)}) throw new Error("unexpected target " + u.origin);
  const path = u.pathname + u.search;
  requests.rest.push(path);
  const reply = restFixture[path];
  if (!reply) throw new Error("unexpected request " + path);
  if (reply.error) throw new Error(reply.error);
  return reply.raw !== undefined ? new Response(reply.raw, { status: reply.status ?? 200 })
    : Response.json(reply.body, { status: reply.status ?? 200 });
};
const { Command } = await import(${JSON.stringify(commanderPath)});
const { bindCli, register } = await import(${JSON.stringify(modulePath)});
bindCli({
  addSharedCredentialOptions(command) { return command.option("--admin-pass <pass>").option("--admin-user <user>"); },
  applyAdminPassFile() {},
  resolveHttpPort() { throw new Error("unexpected local port resolution"); },
  resolveOpsPort() { throw new Error("unexpected local ops port resolution"); },
  resolveOpsUrlFromTarget() { return ${JSON.stringify(opsOrigin)}; },
});
const program = new Command();
register(program);
try { await program.parseAsync(process.argv); }
catch (error) { console.error(error.message); process.exitCode = 1; }
finally { fs.writeFileSync(${JSON.stringify(join(home, "requests.json"))}, JSON.stringify(requests)); }
`);

  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(FLAIR_|HARPER_|HDB_|FABRIC_)/.test(key)));
  const proc = Bun.spawn([process.execPath, script, "backup", "--url", restOrigin, "--admin-pass", "test-pass", "--output", output], {
    env: { ...env, HOME: home, USERPROFILE: home }, stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  return {
    home, output, stdout, stderr, exitCode,
    requests: JSON.parse(readFileSync(join(home, "requests.json"), "utf-8")) as { rest: string[]; ops: string[] },
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
    // Data API returns one of flint's two Memory rows; the ops count still reports two.
    const result = await runBackup({
      rest: { "/Memory/?agentId=flint": { body: memories.filter(m => m.agentId === "flint").slice(0, 1) } },
    });
    expectNoPublication(result);
    expect(result.stderr).toContain("Memory");
    expect(result.stderr).toContain("flint");
    expect(result.stderr).toMatch(/server reports 2 rows, backup read 1/);
    // The independent count was actually fetched, and no row content leaked.
    expect(result.requests.ops).toContain("search_by_value:Memory:flint");
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

  test("a non-array count response refuses publication", async () => {
    const result = await runBackup({ ops: { "search_by_value:Memory:kern": { body: { not: "rows" } } } });
    expectNoPublication(result);
    expect(result.stderr).toContain("Memory for agent kern");
    expect(result.stderr).toContain("array");
  });

  test("equal counts publish the archive unchanged", async () => {
    const result = await runBackup();
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("Backup complete");
    const archive = JSON.parse(readFileSync(result.output, "utf-8"));
    expect(archive).toMatchObject({ version: 1, source: restOrigin, agents, memories, souls });
    // Both an Agent count and per-agent Memory/Soul counts were fetched independently.
    expect(result.requests.ops).toContain("describe_table:Agent");
    expect(result.requests.ops).toContain("search_by_value:Memory:flint");
    expect(result.requests.ops).toContain("search_by_value:Soul:kern");
  });
});
