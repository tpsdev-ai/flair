// ─── flair#2139 S2 COMPLETION (slice 2c) item 6 — in-process POST and MCP ────
//
// The in-process POST / MCP acceptance for skill history, driven through the
// REAL resource boundary: the inproc-app fixture loads Flair as a sub-component
// and invokes the shipped `TOOLS[...]` wrappers in-process (resources/
// mcp-tools.ts), exactly as the /mcp handler does. `skill_store` is
// Memory.post(); `memory_update` default and `preserveHistory:true` are the two
// update paths. Each must return the ACTUAL successor id, and the stable
// subject must carry the chain across the changed physical ids.
//
// RED on #2246's head: the update paths overwrite in place / return the old id
// and append no version.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, mkdir, cp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";

const REPO_ROOT = process.cwd();
const FIXTURE = join(REPO_ROOT, "test", "fixtures", "inproc-app");

const sfx = Date.now().toString(36);
const AGENT = `skc-inproc-${sfx}`;

let harper: HarperInstance;
let appDir = "";

const basicAuth = () => "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`);

async function fleet(op: string, body: Record<string, unknown> = {}): Promise<any> {
  const res = await fetch(`${harper.httpURL}/AgentFleet/`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: basicAuth() },
    body: JSON.stringify({ op, ...body }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`AgentFleet ${op} → HTTP ${res.status}: ${text.slice(0, 400)}`);
  return JSON.parse(text);
}

async function tool(name: string, args: Record<string, unknown> = {}): Promise<any> {
  const res = await fleet("mcpTool", { agentId: AGENT, tool: name, args, isAdmin: false });
  expect(res.ok, `mcpTool ${name} failed: ${JSON.stringify(res).slice(0, 400)}`).toBe(true);
  return res.value;
}

async function ops(operation: Record<string, unknown>): Promise<any> {
  const res = await fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: basicAuth() },
    body: JSON.stringify(operation),
  });
  const text = await res.text();
  expect(res.status, `${operation.operation}: ${text.slice(0, 200)}`).toBe(200);
  return JSON.parse(text);
}

async function versionsOf(subjectId: string): Promise<any[]> {
  const rows = await ops({
    operation: "search_by_value", database: "flair", table: "InstructionVersion",
    search_attribute: "subjectId", search_value: subjectId, get_attributes: ["*"],
  });
  return (rows as any[]).sort((a, b) => Number(a.version) - Number(b.version));
}

beforeAll(async () => {
  if (process.env.HARPER_HTTP_URL) throw new Error("requires an isolated Harper; unset HARPER_HTTP_URL");
  appDir = await mkdtemp(join(tmpdir(), "flair-inproc-skc-"));
  await cp(FIXTURE, appDir, { recursive: true });
  await mkdir(join(appDir, "node_modules", "@tpsdev-ai"), { recursive: true });
  await symlink(REPO_ROOT, join(appDir, "node_modules", "@tpsdev-ai", "flair"), "dir");
  harper = await startHarper({ cwd: appDir, harperBinDir: REPO_ROOT });
  await fleet("register", { id: AGENT });
}, 240_000);

afterAll(async () => {
  if (harper) await stopHarper(harper);
  if (appDir) await rm(appDir, { recursive: true, force: true, maxRetries: 4 });
});

describe("flair#2139 S2c (6) — in-process POST / MCP skill update returns the successor id", () => {
  test("skill_store (in-process Memory.post) appends a create version at the returned id", async () => {
    const res = await tool("skill_store", { content: "procedure v1", trigger: "when v1", name: "proc" });
    expect(res.id, res.error ?? "").toBeTruthy();
    const versions = await versionsOf(res.id);
    expect(versions.map((v) => v.kind)).toEqual(["create"]);
    expect(versions[0].memoryId).toBe(res.id);
  }, 120_000);

  test("memory_update (default) returns the ACTUAL successor id and chains the version", async () => {
    const created = await tool("skill_store", { content: "v1", trigger: "when v1" });
    const id = created.id;
    expect(id, created.error ?? "").toBeTruthy();

    const updated = await tool("memory_update", { id, content: "v2" });
    expect(updated.id, "the default update must return the successor id").not.toBe(id);
    expect(updated.id, updated.error ?? "").toBeTruthy();

    const versions = await versionsOf(id);
    expect(versions.map((v) => v.kind)).toEqual(["create", "update"]);
    expect(versions[1].memoryId).toBe(updated.id);
  }, 120_000);

  test("memory_update with preserveHistory:true returns the successor id and closes the predecessor", async () => {
    const created = await tool("skill_store", { content: "v1", trigger: "when v1" });
    const id = created.id;
    expect(id, created.error ?? "").toBeTruthy();
    const updated = await tool("memory_update", { id, content: "v2", preserveHistory: true });
    expect(updated.id, "an explicit-history update must return a fresh successor id").not.toBe(id);

    const versions = await versionsOf(id);
    expect(versions.map((v) => v.kind)).toEqual(["create", "update"]);
    expect(versions[1].memoryId).toBe(updated.id);
  }, 120_000);
});
