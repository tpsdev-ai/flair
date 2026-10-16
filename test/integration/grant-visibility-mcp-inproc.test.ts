/**
 * grant-visibility-mcp-inproc.test.ts — real Harper, in-process MCP tools and
 * an in-process Memory write.
 *
 * The MCP write tools reach Memory.post()/put() through the inproc-app fixture
 * (the shipped TOOLS[...] wrappers, as resources/mcp-handler.ts dispatches
 * them). A "write" MemoryGrant does not include changing a record's
 * visibility, and the MCP tools offer a grantee no successor write with a
 * visibility of its own: memory_update writes the owner's row (default) or a
 * successor attributed to the owner (preserveHistory). On an owner's SHARED
 * row, which the grantee can read, both modes are refused by Memory's
 * attribution check. On an owner's PRIVATE row both are refused earlier:
 * memory_update's own read of the row (resources/mcp-tools.ts memoryUpdate)
 * finds nothing the grantee can read and answers not found. skill_store and
 * memory_store write only the caller's own rows. These cases pin that the
 * owner's rows and their visibility are unchanged by a grantee's MCP calls.
 *
 * The next cases drive Memory.post() in-process through the fixture's
 * `remember` op (collectionResource + agentContext), which carries no caller
 * transaction, so the write runs in a transaction withSharedWriteTransaction
 * owns. For a grant-authorized successor, the close's final committed-state
 * re-read compares the predecessor's visibility with the successor's: with
 * the close held by the test-only "granted-close" pause
 * (resources/txn-pause-point.ts, enabled for this file's Harper by
 * FLAIR_ENABLE_TEST_FAULT_INJECTION and FLAIR_TEST_PAUSE_DIR), a visibility
 * change committed to the predecessor before that re-read refuses the write
 * with the named 409 and leaves no successor; with no change the successor
 * lands and the close lands.
 *
 * The last cases write the grantee's supersede inside a transaction the
 * caller owns (the fixture's `supersedeInCallerTransaction` op). The successor
 * and its close are staged in that transaction, so they commit or abort with
 * it: when the caller aborts after the write, no successor is written and the
 * predecessor stays open.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HARPER_STOP_BUDGET_MS, startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";

const REPO_ROOT = process.cwd();
const FIXTURE = join(REPO_ROOT, "test", "fixtures", "inproc-app");
const sfx = Date.now().toString(36);
const OWNER = `gvm-owner-${sfx}`;
const GRANTEE = `gvm-grantee-${sfx}`;

let harper: HarperInstance;
let appDir = "";
let pauseDir = "";
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
  pauseDir = await mkdtemp(join(tmpdir(), "flair-gvm-pause-"));
  const saved = {
    FLAIR_ENABLE_TEST_FAULT_INJECTION: process.env.FLAIR_ENABLE_TEST_FAULT_INJECTION,
    FLAIR_TEST_PAUSE_DIR: process.env.FLAIR_TEST_PAUSE_DIR,
  };
  process.env.FLAIR_ENABLE_TEST_FAULT_INJECTION = "1";
  process.env.FLAIR_TEST_PAUSE_DIR = pauseDir;
  try {
    harper = await startHarper({ cwd: appDir, harperBinDir: REPO_ROOT });
  } finally {
    // The spawned Harper has its copy; no later Harper in this process inherits it.
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
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
  if (pauseDir) await rm(pauseDir, { recursive: true, force: true });
}, HARPER_STOP_BUDGET_MS);

describe("MCP tools: a grantee's calls leave the owner's rows and their visibility unchanged", () => {
  test("memory_update (default and preserveHistory) on the owner's shared memory and skill is refused for the grantee by the attribution check", async () => {
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

  test("memory_update (default and preserveHistory) on the owner's private memory is refused for the grantee at its read: not found", async () => {
    const mem = await tool(OWNER, "memory_store", { content: "gvm owner private memory", durability: "persistent", visibility: "private" });
    expect(mem.ok, JSON.stringify(mem).slice(0, 300)).toBe(true);
    const before = (await rowsFor(OWNER)).find((r) => r.id === mem.value.id);
    expect(before?.visibility).toBe("private");
    for (const preserveHistory of [false, true]) {
      const res = await tool(GRANTEE, "memory_update", { id: mem.value.id, content: "gvm grantee rewrite", preserveHistory });
      expect(res.ok, JSON.stringify(res).slice(0, 300)).toBe(true);
      expect(res.value, `memory_update(${preserveHistory}): ${JSON.stringify(res).slice(0, 300)}`).toEqual({ error: "memory not found", status: 404 });
    }
    const after = (await rowsFor(OWNER)).find((r) => r.id === mem.value.id);
    expect([after?.visibility, after?.validTo ?? null]).toEqual(["private", null]);
    expect(await rowsFor(GRANTEE)).toEqual([]);
  }, 120_000);
});

const POINT = "granted-close";
async function waitFor(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}
/** Arm the close pause, start `write`, run `compete` once it is paused, then release. */
async function withPausedClose<T>(write: () => Promise<any>, compete: () => Promise<T>) {
  for (const marker of ["claimed", "paused", "go", "released"]) rmSync(join(pauseDir, `${marker}.${POINT}`), { force: true });
  writeFileSync(join(pauseDir, `arm.${POINT}`), "");
  const pending = write();
  const paused = await waitFor(join(pauseDir, `paused.${POINT}`), 15_000);
  let competed: T | undefined;
  try {
    if (paused) competed = await compete();
  } finally {
    writeFileSync(join(pauseDir, `go.${POINT}`), "");
  }
  const result = await pending;
  const released = paused ? readFileSync(join(pauseDir, `released.${POINT}`), "utf8") : "never paused";
  return { result, competed, released };
}
async function successorsOf(predecessorId: string): Promise<any[]> {
  return (await rowsFor(GRANTEE)).filter((r) => r.supersedes === predecessorId);
}

describe("ordinary granted close refusal rolls back the successor and preserves the predecessor", () => {
  for (const method of ["POST", "PUT"]) {
    for (const joined of [false, true]) {
      test(`${method}, ${joined ? "caller" : "write"}-owned transaction: fixed refusal and unchanged rows`, async () => {
        const pred = await fleet("remember", {
          agentId: OWNER, content: `gvm refusal predecessor ${method} ${joined}`, durability: "persistent", visibility: "shared",
        });
        expect(pred.ok, JSON.stringify(pred)).toBe(true);
        const predId = pred.value.id;
        const readRow = (id: string) => ops({
          operation: "search_by_hash", database: "flair", table: "Memory", hash_values: [id], get_attributes: ["*"],
        });
        const before = await readRow(predId);
        expect(before).toHaveLength(1);
        expect(before[0].validTo ?? null).toBeNull();
        const id = `${GRANTEE}-refusal-${method}-${joined}`;
        const res = await fleet("supersedeWithCloseStorageRefusal", {
          id, agentId: GRANTEE, content: `gvm refusal successor ${method} ${joined}`, supersedes: predId, method, joined,
        });
        expect(res.ok, JSON.stringify(res)).toBe(true);
        expect(res.value.refusedCloses).toBe(1);
        expect(await readRow(id), "the successor did not commit").toEqual([]);
        expect(await successorsOf(predId)).toEqual([]);
        expect(await readRow(predId), "the predecessor is unchanged").toEqual(before);
        expect(res.value.reply.ok).toBe(false);
        expect(res.value.reply.status).toBe(500);
        expect(JSON.parse(res.value.reply.body)).toEqual({
          error: "write_response_withheld",
          message: "the server does not report this write's result; read the row to see what is stored",
        });
      }, 120_000);
    }
  }
});

describe("in-process Memory.post(): the final committed-visibility check refuses a mismatch", () => {
  test("the predecessor is made private while the close is held: the named 409, no successor, the predecessor open", async () => {
    const pred = await fleet("remember", { agentId: OWNER, content: "gvm in-process shared predecessor", durability: "persistent", visibility: "shared" });
    expect(pred.ok, JSON.stringify(pred).slice(0, 300)).toBe(true);
    const predId = pred.value.id;
    const { result, competed, released } = await withPausedClose(
      () => fleet("remember", { agentId: GRANTEE, content: "gvm in-process grantee successor", durability: "persistent", supersedes: predId }),
      () => ops({ operation: "update", database: "flair", table: "Memory", records: [{ id: predId, visibility: "private" }] }),
    );
    expect(released, "the close was not paused and released by this test").toBe("go");
    expect(competed, "the competing visibility change failed").toBeTruthy();
    expect(result.ok, JSON.stringify(result).slice(0, 300)).toBe(false);
    expect(result.status, JSON.stringify(result).slice(0, 300)).toBe(409);
    expect(JSON.parse(result.body).error).toBe("predecessor_visibility_changed");
    expect(await successorsOf(predId), "a successor row was written").toEqual([]);
    const after = (await rowsFor(OWNER)).find((r) => r.id === predId);
    expect([after?.visibility, after?.validTo ?? null]).toEqual(["private", null]);
  }, 120_000);

  test("control: with no competing change the successor lands with the predecessor's visibility and the close lands", async () => {
    const pred = await fleet("remember", { agentId: OWNER, content: "gvm in-process kept predecessor", durability: "persistent", visibility: "private" });
    expect(pred.ok, JSON.stringify(pred).slice(0, 300)).toBe(true);
    const predId = pred.value.id;
    const res = await fleet("remember", { agentId: GRANTEE, content: "gvm in-process kept successor", durability: "persistent", supersedes: predId });
    expect(res.ok, JSON.stringify(res).slice(0, 300)).toBe(true);
    const successors = await successorsOf(predId);
    expect(successors.map((r) => r.visibility)).toEqual(["private"]);
    expect((await rowsFor(OWNER)).find((r) => r.id === predId)?.validTo, "the close did not land").toBeTruthy();
  }, 120_000);
});

describe("in-process, inside a caller's transaction: a grant-authorized successor and its close commit or abort with that transaction", () => {
  test("the caller aborts its transaction after the write: no successor, the predecessor open", async () => {
    const pred = await fleet("remember", { agentId: OWNER, content: "gvm caller-abort predecessor", durability: "persistent", visibility: "shared" });
    expect(pred.ok, JSON.stringify(pred).slice(0, 300)).toBe(true);
    const predId = pred.value.id;
    const res = await fleet("supersedeInCallerTransaction", {
      id: `${GRANTEE}-caller-abort`, agentId: GRANTEE, content: "gvm caller-abort successor", durability: "persistent", supersedes: predId, abort: true,
    });
    expect(res.ok, JSON.stringify(res).slice(0, 300)).toBe(true);
    expect(res.value, "the write did not return before the caller aborted").toEqual({ aborted: true, written: true });
    expect(await successorsOf(predId), "a successor row was written").toEqual([]);
    const after = (await rowsFor(OWNER)).find((r) => r.id === predId);
    expect([after?.visibility, after?.validTo ?? null], "the predecessor was closed").toEqual(["shared", null]);
  }, 120_000);

  test("control: the caller commits its transaction: the successor lands and the close lands", async () => {
    const pred = await fleet("remember", { agentId: OWNER, content: "gvm caller-commit predecessor", durability: "persistent", visibility: "shared" });
    expect(pred.ok, JSON.stringify(pred).slice(0, 300)).toBe(true);
    const predId = pred.value.id;
    const res = await fleet("supersedeInCallerTransaction", {
      id: `${GRANTEE}-caller-commit`, agentId: GRANTEE, content: "gvm caller-commit successor", durability: "persistent", supersedes: predId, abort: false,
    });
    expect(res.ok, JSON.stringify(res).slice(0, 300)).toBe(true);
    expect(res.value).toEqual({ aborted: false, written: true });
    expect((await successorsOf(predId)).map((r) => [r.id, r.visibility])).toEqual([[`${GRANTEE}-caller-commit`, "shared"]]);
    expect((await rowsFor(OWNER)).find((r) => r.id === predId)?.validTo, "the close did not land").toBeTruthy();
  }, 120_000);
});
