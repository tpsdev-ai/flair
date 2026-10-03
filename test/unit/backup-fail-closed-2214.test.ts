import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../helpers/temp-dir.ts";

const modulePath = join(import.meta.dirname, "../../src/commands/backup.ts");
const commanderPath = import.meta.resolve("commander");
const agents = [{ id: "flint", name: "Flint" }, { id: "kern", name: "Kern" }, { id: "ember", name: "Ember" }];
const memories = agents.flatMap(a => [
  { id: `${a.id}-m1`, agentId: a.id, content: "first", embedding: [1, 2] },
  { id: `${a.id}-m2`, agentId: a.id, content: "second", metadata: '{"keep":true}' },
]);
const souls = agents.map(a => ({ id: `${a.id}:identity`, agentId: a.id, key: "identity", value: a.name }));

type Reply = { body?: unknown; status?: number; raw?: string; error?: string };
type Fault = "write" | "read" | "count" | "id" | "content" | "rename";

async function runBackup(overrides: Record<string, Reply> = {}, options: {
  fault?: Fault; filter?: string; existing?: boolean; defaultOutput?: boolean; empty?: boolean;
} = {}) {
  const home = tempDir("flair-backup-2214-");
  const output = join(home, "archive.json");
  if (options.existing) writeFileSync(output, "previous archive\n");
  const fixtureAgents = options.empty ? [] : agents;
  const fixture: Record<string, Reply> = { "/Agent/": { body: fixtureAgents }, ...overrides };
  for (const agent of fixtureAgents) {
    for (const table of ["Memory", "Soul"] as const) {
      const path = `/${table}/?agentId=${agent.id}`;
      fixture[path] ??= { body: (table === "Memory" ? memories : souls).filter(r => r.agentId === agent.id) };
    }
  }
  const script = join(home, "run.ts");
  const opsAgentCount = (options.empty ? [] : agents).length;
  const memByAgent = Object.fromEntries(agents.map(a => [a.id, memories.filter(m => m.agentId === a.id).map(m => ({ id: m.id, agentId: m.agentId }))]));
  const soulByAgent = Object.fromEntries(agents.map(a => [a.id, souls.filter(s => s.agentId === a.id).map(s => ({ id: s.id, agentId: s.agentId }))]));
  writeFileSync(script, `
import { mock } from "bun:test";
import * as fs from "node:fs";
const fault = ${JSON.stringify(options.fault ?? null)};
const realRead = fs.readFileSync;
const realWrite = fs.writeFileSync;
const realRename = fs.renameSync;
mock.module("node:fs", () => ({ ...fs,
  writeFileSync(path, ...args) {
    if (fault === "write" && String(path).endsWith("archive.json")) throw new Error("injected write failure");
    return realWrite(path, ...args);
  },
  readFileSync(path, ...args) {
    if (String(path).endsWith("archive.json")) {
      if (fault === "read") throw new Error("injected read failure");
      const text = realRead(path, ...args);
      if (["count", "id", "content"].includes(fault)) {
        const archive = JSON.parse(text);
        if (fault === "count") archive.memories.pop();
        if (fault === "id") archive.memories[0].id = "wrong-row";
        if (fault === "content") archive.memories[0].content = "changed";
        return JSON.stringify(archive);
      }
      return text;
    }
    return realRead(path, ...args);
  },
  renameSync(...args) {
    if (fault === "rename") throw new Error("injected rename failure");
    return realRename(...args);
  },
}));
const fixture = ${JSON.stringify(fixture)};
const opsAgents = ${JSON.stringify(fixtureAgents)};
const requests = [];
const opsAgentCount = ${JSON.stringify(opsAgentCount)};
const memByAgent = ${JSON.stringify(memByAgent)};
const soulByAgent = ${JSON.stringify(soulByAgent)};
globalThis.fetch = async (url, init) => {
  if (init.headers.Authorization !== "Basic YWRtaW46dGVzdC1wYXNz") throw new Error("incorrect auth");
  if (!init.signal) throw new Error("missing timeout signal");
  const u = new URL(url);
  if (u.origin === "http://ops.invalid") {
    const body = JSON.parse(String(init.body));
    if (body.operation === "describe_table") {
      const count = body.table === "Agent" ? opsAgentCount : opsAgents.length ? Object.values(body.table === "Memory" ? memByAgent : soulByAgent).flat().length : 0;
      return Response.json({ record_count: count });
    }
    if (body.operation === "search_by_value") {
      return Response.json(body.table === "Agent" ? opsAgents : opsAgents.length ? Object.values(body.table === "Memory" ? memByAgent : soulByAgent).flat() : []);
    }
    throw new Error("unexpected ops operation " + JSON.stringify(body));
  }
  if (u.origin !== "http://backup.invalid") throw new Error("unexpected target");
  const path = u.pathname + u.search;
  requests.push(path);
  const reply = fixture[path];
  if (!reply) throw new Error("unexpected request " + path);
  if (reply.error) throw new Error(reply.error);
  return reply.raw !== undefined ? new Response(reply.raw, { status: reply.status ?? 200 })
    : Response.json(reply.body, { status: reply.status ?? 200 });
};
const { Command } = await import(${JSON.stringify(commanderPath)});
const { bindCli, register } = await import(${JSON.stringify(modulePath)});
const { resolveOpsTarget } = await import(${JSON.stringify(join(import.meta.dirname, "../../src/cli.ts"))});
bindCli({
  addSharedCredentialOptions(command) { return command.option("--admin-pass <pass>").option("--admin-user <user>"); },
  applyAdminPassFile() {},
  resolveHttpPort() { throw new Error("unexpected local port resolution"); },
  resolveOpsPort() { throw new Error("unexpected local ops port resolution"); },
  resolveOpsTarget,
  resolveOpsUrlFromTarget() { return "http://ops.invalid"; },
});
const program = new Command();
register(program);
try { await program.parseAsync(process.argv); }
catch (error) { console.error(error.message); process.exitCode = 1; }
finally { realWrite(${JSON.stringify(join(home, "requests.json"))}, JSON.stringify(requests)); }
`);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(FLAIR_|HARPER_|HDB_|FABRIC_)/.test(key)));
  const proc = Bun.spawn([process.execPath, script, "backup", "--url", "http://backup.invalid", "--admin-pass", "test-pass",
    ...(options.defaultOutput ? [] : ["--output", output]), ...(options.filter ? ["--agents", options.filter] : [])], {
    env: { ...env, HOME: home, USERPROFILE: home }, stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  return { home, output, stdout, stderr, exitCode,
    requests: JSON.parse(readFileSync(join(home, "requests.json"), "utf-8")) as string[],
  };
}

function expectFailure(result: Awaited<ReturnType<typeof runBackup>>, context: string) {
  expect(result.exitCode).not.toBe(0);
  expect(result.stdout + result.stderr).not.toContain("Backup complete");
  expect(result.stderr).toContain(context);
  expect(existsSync(result.output)).toBe(false);
  expect(readdirSync(result.home).filter(n => n.startsWith(".flair-backup-")).length).toBe(0);
  expect(existsSync(join(result.home, ".flair", "backups"))).toBe(false);
}

describe("backup fails closed (flair#2214)", () => {
  test("failed Memory read after another agent's rows publishes no archive", async () => {
    const result = await runBackup({ "/Memory/?agentId=kern": { status: 503, body: { error: "unavailable" } } });
    expectFailure(result, "Memory");
    expect(result.stderr).toContain("kern");
    expect(result.stderr).toContain("503");
    expect(result.requests).toContain("/Memory/?agentId=flint");
  });

  for (const table of ["Agent", "Memory", "Soul"] as const) {
    const path = table === "Agent" ? "/Agent/" : `/${table}/?agentId=ember`;
    for (const [label, reply] of Object.entries({
      http: { status: 500, body: { error: "injected HTTP failure" } },
      network: { error: "injected network failure" },
      json: { raw: "not JSON" },
    })) {
      test(`${table} ${label} failure is fatal`, async () => {
        const result = await runBackup({ [path]: reply });
        expectFailure(result, table);
        if (table !== "Agent") expect(result.stderr).toContain("ember");
      });
    }
    for (const body of [null, {}, "not rows", 1]) {
      test(`${table} rejects non-array ${JSON.stringify(body)}`, async () => {
        const result = await runBackup({ [path]: { body } });
        expectFailure(result, table);
        expect(result.stderr).toContain("array");
        if (table !== "Agent") expect(result.stderr).toContain("ember");
      });
    }
    for (const row of [null, "row", {}, { id: "" }, { id: " " }, { id: 7 }]) {
      test(`${table} rejects row with invalid id ${JSON.stringify(row)}`, async () => {
        const good = table === "Agent" ? agents[0] : (table === "Memory" ? memories[4] : souls[2]);
        const result = await runBackup({ [path]: { body: [good, row] } });
        expectFailure(result, table);
        expect(result.stderr).toContain("row 1");
        expect(result.stderr).toContain("id");
      });
    }
    test(`${table} rejects duplicate IDs`, async () => {
      const row = table === "Agent" ? agents[0] : (table === "Memory" ? memories[4] : souls[2]);
      const result = await runBackup({ [path]: { body: [row, row] } });
      expectFailure(result, table);
      expect(result.stderr).toContain("row 1: duplicate id");
      expect(result.stderr).toContain("duplicate");
    });
  }

  for (const table of ["Memory", "Soul"] as const) {
    for (const agentId of [undefined, "flint"]) {
      test(`${table} rejects missing or mismatched owner ${agentId}`, async () => {
        const result = await runBackup({ [`/${table}/?agentId=kern`]: { body: [{ id: "bad-owner", agentId }] } });
        expectFailure(result, "kern");
        expect(result.stderr).not.toContain("bad-owner");
        expect(result.stderr).toContain("row 0: agentId");
        expect(result.stderr).toContain("agentId");
      });
    }
    test(`${table} rejects duplicate IDs across agents`, async () => {
      const firstId = table === "Memory" ? memories[0].id : souls[0].id;
      const result = await runBackup({ [`/${table}/?agentId=kern`]: { body: [{ id: firstId, agentId: "kern" }] } });
      expectFailure(result, "kern");
      expect(result.stderr).not.toContain(firstId);
      expect(result.stderr).toContain("row 0: duplicate id");
      expect(result.stderr).toContain("duplicate");
    });
  }

  test("a failed read preserves an existing output archive", async () => {
    const result = await runBackup({ "/Soul/?agentId=ember": { status: 500, body: "failed" } }, { existing: true });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("ember");
    expect(result.stderr).not.toContain("Backup complete");
    expect(readFileSync(result.output, "utf-8")).toBe("previous archive\n");
  });

  test("a requested agent absent from the response is fatal", async () => {
    const result = await runBackup({}, { filter: "kern,missing" });
    expectFailure(result, "missing");
  });

  for (const fault of ["write", "read", "count", "id", "content", "rename"] as const) {
    test(`archive ${fault} failure prevents publication`, async () => {
      const result = await runBackup({}, { fault });
      expectFailure(result, result.output);
      const detail = { write: "write failure", read: "read failure", count: "count", id: memories[0].id,
        content: "contents", rename: "rename failure" }[fault];
      expect(result.stderr).toContain(detail);
    });
  }

  test("all agents and rows are preserved with confirmed counts", async () => {
    const result = await runBackup();
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Backup complete");
    const archive = JSON.parse(readFileSync(result.output, "utf-8"));
    expect(archive).toMatchObject({ version: 1, source: "http://backup.invalid", agents, memories, souls });
    expect(result.requests).toEqual(["/Agent/", ...agents.map(a => `/Memory/?agentId=${a.id}`), ...agents.map(a => `/Soul/?agentId=${a.id}`)]);
    for (const [name, count] of [["Agents", 3], ["Memories", 6], ["Souls", 3]]) {
      expect(result.stderr).toMatch(new RegExp(`${name}\\s+${count}`));
    }
    expect(readdirSync(result.home).some(n => n.startsWith(".flair-backup-"))).toBe(false);
  });

  test("an empty instance is a valid backup", async () => {
    const result = await runBackup({}, { empty: true });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(result.output, "utf-8"))).toMatchObject({ agents: [], memories: [], souls: [] });
  });

  test("filtering exports only the requested agent", async () => {
    const result = await runBackup({}, { filter: "kern" });
    expect(result.exitCode).toBe(0);
    const archive = JSON.parse(readFileSync(result.output, "utf-8"));
    expect(archive.agents).toEqual([agents[1]]);
    expect(archive.memories).toEqual(memories.filter(r => r.agentId === "kern"));
    expect(archive.souls).toEqual(souls.filter(r => r.agentId === "kern"));
    expect(result.requests).toEqual(["/Agent/", "/Memory/?agentId=kern", "/Soul/?agentId=kern"]);
  });

  test("default output stays within the throwaway HOME", async () => {
    const result = await runBackup({}, { defaultOutput: true });
    expect(result.exitCode).toBe(0);
    const dir = join(result.home, ".flair", "backups");
    const files = readdirSync(dir);
    expect(files.length).toBe(1);
    expect(JSON.parse(readFileSync(join(dir, files[0]), "utf-8"))).toMatchObject({ agents, memories, souls });
  });
});
