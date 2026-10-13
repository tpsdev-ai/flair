/**
 * grant-visibility-mcp-inproc.test.ts — real Harper, in-process MCP tools.
 *
 * The MCP write tools reach Memory.post()/put() through the inproc-app fixture
 * (the shipped TOOLS[...] wrappers, as resources/mcp-handler.ts dispatches
 * them). A "write" MemoryGrant does not include changing a record's
 * visibility, and the MCP tools offer a grantee no successor write with a
 * visibility of its own: memory_update writes the owner's row (default) or a
 * successor attributed to the owner (preserveHistory), and both are refused for
 * a grantee by Memory's attribution check; skill_store and memory_store write
 * only the caller's own rows. These cases pin that the owner's rows and their
 * visibility are unchanged by a grantee's MCP calls.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";

const REPO_ROOT = process.cwd();
const FIXTURE = join(REPO_ROOT, "test", "fixtures", "inproc-app");
const sfx = Date.now().toString(36);
const OWNER = `gvm-owner-${sfx}`;
const GRANTEE = `gvm-grantee-${sfx}`;

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
async function tool(agentId: string, name: string, args: Record<string, unknown>): Promise<any> {
  return fleet("mcpTool", { agentId, tool: name, args, isAdmin: false });
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
async function rowsFor(agentId: string): Promise<any[]> {
  return ops({
    operation: "search_by_value", database: "flair", table: "Memory",
    search_attribute: "agentId", search_value: agentId, get_attributes: ["id", "visibility", "validTo", "supersedes"],
  });
}
/** A refusal surfaces as a non-ok fixture result or as a tool-level error object. */
function refused(res: any): boolean {
  if (res?.ok === false) return true;
  const v = res?.value;
  return !!v && typeof v === "object" && (v.error != null || (typeof v.status === "number" && v.status >= 400));
}

beforeAll(async () => {
  if (process.env.HARPER_HTTP_URL) throw new Error("requires an isolated Harper; unset HARPER_HTTP_URL");
  appDir = await mkdtemp(join(tmpdir(), "flair-inproc-gvm-"));
  await cp(FIXTURE, appDir, { recursive: true });
  await mkdir(join(appDir, "node_modules", "@tpsdev-ai"), { recursive: true });
  await symlink(REPO_ROOT, join(appDir, "node_modules", "@tpsdev-ai", "flair"), "dir");
  harper = await startHarper({ cwd: appDir, harperBinDir: REPO_ROOT });
  await fleet("register", { id: OWNER });
  await fleet("register", { id: GRANTEE });
  await ops({
    operation: "insert", database: "flair", table: "MemoryGrant",
    records: [{ id: `${OWNER}:${GRANTEE}:write`, ownerId: OWNER, granteeId: GRANTEE, scope: "write", createdAt: new Date().toISOString() }],
  });
}, 300_000);

afterAll(async () => {
  if (harper) await stopHarper(harper);
  if (appDir) await rm(appDir, { recursive: true, force: true, maxRetries: 4 });
});

describe("MCP tools: a grantee's calls leave the owner's rows and their visibility unchanged", () => {
  test("memory_update (default and preserveHistory) on the owner's shared memory and skill is refused for the grantee", async () => {
    const mem = await tool(OWNER, "memory_store", { content: "gvm owner memory", durability: "persistent", visibility: "shared" });
    expect(mem.ok, JSON.stringify(mem).slice(0, 300)).toBe(true);
    const sk = await tool(OWNER, "skill_store", { content: "gvm owner procedure", trigger: "when gvm" });
    expect(sk.ok, JSON.stringify(sk).slice(0, 300)).toBe(true);
    const before = await rowsFor(OWNER);
    expect(before.length).toBe(2);

    for (const id of [mem.value.id, sk.value.id]) {
      for (const preserveHistory of [false, true]) {
        const res = await tool(GRANTEE, "memory_update", { id, content: "gvm grantee rewrite", preserveHistory });
        expect(refused(res), `memory_update(${preserveHistory}) on ${id}: ${JSON.stringify(res).slice(0, 300)}`).toBe(true);
      }
    }
    const after = await rowsFor(OWNER);
    expect(after.map((r) => [r.id, r.visibility, r.validTo ?? null]).sort()).toEqual(
      before.map((r) => [r.id, r.visibility, r.validTo ?? null]).sort(),
    );
    expect(await rowsFor(GRANTEE)).toEqual([]);
  }, 120_000);
});
