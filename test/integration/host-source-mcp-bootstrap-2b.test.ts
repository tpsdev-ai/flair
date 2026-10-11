/**
 * host-source-mcp-bootstrap-2b.test.ts — flair#1940 slice 2b.
 *
 * Real-Harper coverage for the two surfaces that still dropped the host
 * pointer after slice 1: the MCP `memory_store` envelope / `memory_search`
 * rendering (A3 + A6) and the bootstrap prose citation (A6).
 *
 * Every call goes through the SHIPPED code: the fixture's `mcpTool` op invokes
 * `TOOLS[tool].impl(...)` from the built `dist/resources/mcp-tools.js` — the
 * same wrappers the /mcp handler dispatches through — against the real
 * Memory / SemanticSearch / MemoryBootstrap resources and a real store. So the
 * pointer crosses the real validator, the real gated join, and the real prose
 * builder; a fake on any of those seams would not see this defect.
 *
 * Names are neutral (`agent-a`, `agent-b`); no fleet host or agent is named.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, mkdir, cp, symlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHarper, stopHarper, HarperInstance } from "../helpers/harper-lifecycle";

const REPO_ROOT = process.cwd();
const FIXTURE = join(REPO_ROOT, "test", "fixtures", "inproc-app");

let harper: HarperInstance;
let appDir: string;

const sfx = Date.now().toString(36);
const AUTHOR = `hs2b-a-${sfx}`;
const READER = `hs2b-b-${sfx}`;

const MARKER_AUTHOR_ONLY = `zqhs2bauthoronly${sfx}`;
const MARKER_SCOPED = `zqhs2bscoped${sfx}`;
const MARKER_PLAIN = `zqhs2bplain${sfx}`;

const POINTER = { v: 1, host: "openclaw", kind: "run", id: "run-2baaaaaaaa" };
const ID8 = POINTER.id.slice(0, 8);

/** Drive one in-process operation inside the fixture app. */
async function fleet(op: string, body: Record<string, unknown> = {}): Promise<any> {
  const res = await fetch(`${harper.httpURL}/AgentFleet/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`),
    },
    body: JSON.stringify({ op, ...body }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`AgentFleet ${op} → HTTP ${res.status}: ${text.slice(0, 400)}`);
  return JSON.parse(text);
}

/** Call a /mcp tool wrapper (`TOOLS[tool].impl`) as `agentId` and unwrap the run() envelope. */
async function tool(agentId: string, name: string, args: Record<string, unknown> = {}, isAdmin = false): Promise<any> {
  const res = await fleet("mcpTool", { agentId, tool: name, args, isAdmin });
  expect(res.ok, `mcpTool ${name} failed: ${JSON.stringify(res).slice(0, 500)}`).toBe(true);
  return res.value;
}

/** Insert a record straight into storage via the ops API (seed path). */
async function seedInsert(table: string, record: Record<string, unknown>): Promise<void> {
  const res = await fetch(harper.opsURL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`),
    },
    body: JSON.stringify({ operation: "insert", database: "flair", table, records: [record] }),
  });
  expect(res.status, `${table} insert → ${res.status}`).toBe(200);
}

beforeAll(async () => {
  appDir = await mkdtemp(join(tmpdir(), "flair-hs2b-"));
  await cp(FIXTURE, appDir, { recursive: true });
  await mkdir(join(appDir, "node_modules", "@tpsdev-ai"), { recursive: true });
  await symlink(REPO_ROOT, join(appDir, "node_modules", "@tpsdev-ai", "flair"), "dir");
  harper = await startHarper({ cwd: appDir, harperBinDir: REPO_ROOT });

  await fleet("register", { id: AUTHOR });
  await fleet("register", { id: READER });
}, 300_000);

afterAll(async () => {
  const dataDir = harper?.installDir;
  if (harper) await stopHarper(harper);
  if (dataDir) await rm(dataDir, { recursive: true, force: true, maxRetries: 4 });
  if (appDir) await rm(appDir, { recursive: true, force: true });
});

function findHit(res: any, marker: string): any {
  const list = Array.isArray(res?.results) ? res.results : [];
  return list.find((r: any) => typeof r?.content === "string" && r.content.includes(marker));
}

function lineFor(context: string, marker: string): string {
  return context.split("\n").find((l) => l.includes(marker)) ?? "";
}

describe("flair#1940 slice 2b — MCP memory_store envelope + memory_search rendering (real Harper)", () => {
  test("memory_store accepts hostSource and memory_search renders it to the author", async () => {
    const stored = await tool(AUTHOR, "memory_store", {
      content: `${MARKER_AUTHOR_ONLY} a sourced note`,
      type: "fact",
      durability: "standard",
      visibility: "shared",
      hostSource: POINTER,
    });
    expect(stored?.id, "the store must land an id").toBeTruthy();

    const res = await tool(AUTHOR, "memory_search", { query: MARKER_AUTHOR_ONLY, limit: 10 });
    const hit = findHit(res, MARKER_AUTHOR_ONLY);
    expect(hit, "the sourced memory must be among the results").toBeDefined();
    expect(hit.hostSource).toEqual(POINTER); // assertion: the author sees the validated pointer object
  }, 120_000);

  test("memory_search renders 'withheld' for a reader who may read the record but not the author-only pointer", async () => {
    const res = await tool(READER, "memory_search", { query: MARKER_AUTHOR_ONLY, limit: 10 });
    const hit = findHit(res, MARKER_AUTHOR_ONLY);
    expect(hit, "the shared record is readable by the other agent").toBeDefined();
    expect(hit.hostSource).toBe("withheld"); // assertion: withheld as withheld — never a value the reader cannot see
  }, 120_000);

  test("memory_search renders a scoped pointer to a reader the write opted in", async () => {
    const stored = await tool(AUTHOR, "memory_store", {
      content: `${MARKER_SCOPED} a scoped note`,
      type: "fact",
      durability: "standard",
      visibility: "shared",
      hostSource: { v: 1, host: "cursor", kind: "launch", id: "launch-2bbbbbbb" },
      hostSourceScope: "record",
    });
    expect(stored?.id, "the scoped store must land an id").toBeTruthy();

    const res = await tool(READER, "memory_search", { query: MARKER_SCOPED, limit: 10 });
    const hit = findHit(res, MARKER_SCOPED);
    expect(hit, "the scoped record is readable").toBeDefined();
    expect(hit.hostSource).toEqual({ v: 1, host: "cursor", kind: "launch", id: "launch-2bbbbbbb" }); // assertion: opted-in → reader sees it
  }, 120_000);

  test("memory_search carries provenance on results (like get/list)", async () => {
    const res = await tool(AUTHOR, "memory_search", { query: MARKER_AUTHOR_ONLY, limit: 10 });
    const hit = findHit(res, MARKER_AUTHOR_ONLY);
    expect(hit, "the sourced memory must be among the results").toBeDefined();
    expect(typeof hit.provenance).toBe("string"); // assertion: provenance is projected
    const parsed = JSON.parse(hit.provenance);
    expect(parsed?.verified?.agentId).toBe(AUTHOR); // assertion: the server-stamped author is present
  }, 120_000);

  test("a store WITHOUT hostSource is unchanged: it lands and the result carries no hostSource key", async () => {
    const stored = await tool(AUTHOR, "memory_store", {
      content: `${MARKER_PLAIN} a plain note`,
      type: "fact",
      durability: "standard",
      visibility: "shared",
    });
    expect(stored?.id, "the plain store must land an id").toBeTruthy();

    const res = await tool(AUTHOR, "memory_search", { query: MARKER_PLAIN, limit: 10 });
    const hit = findHit(res, MARKER_PLAIN);
    expect(hit, "the plain memory must be among the results").toBeDefined();
    expect("hostSource" in hit).toBe(false); // assertion: no pointer → no hostSource key
  }, 120_000);

  test("memory_store forwards sessionId onto the record", async () => {
    const sid = `sess-${sfx}`;
    const stored = await tool(AUTHOR, "memory_store", {
      content: `${MARKER_PLAIN} with a session`,
      type: "fact",
      durability: "standard",
      visibility: "shared",
      sessionId: sid,
    });
    const got = await tool(AUTHOR, "memory_get", { id: stored.id });
    expect(got?.sessionId).toBe(sid); // assertion: the declared sessionId attribute is persisted
  }, 120_000);

  test("memory_store refuses an invalid hostSource with the server validator's 400 (no coercion)", async () => {
    const res = await tool(AUTHOR, "memory_store", {
      content: `zqhs2bbad${sfx} must not land`,
      type: "fact",
      hostSource: { v: 1, host: "not-a-host", kind: "run", id: "x" },
    });
    expect(res?.status).toBe(400); // assertion: the shape the REST write returns on an invalid pointer
    expect(String(res?.error ?? "")).toContain("host_source");
    const after = await tool(AUTHOR, "memory_search", { query: `zqhs2bbad${sfx}`, limit: 10 });
    expect(findHit(after, `zqhs2bbad${sfx}`)).toBeUndefined(); // assertion: nothing was written
  }, 120_000);
});

describe("flair#1940 slice 2b — bootstrap prose cites the host source (real Harper)", () => {
  test("a recalled sourced item carries the citation; an unsourced item renders exactly as today", async () => {
    const nowDate = new Date().toISOString();
    const plainContent = `zqhs2bbplain${sfx} plain recall`;
    const srcContent = `zqhs2bbsrc${sfx} cited recall`;
    const tokSourced = randomUUID();
    const tokPlain = randomUUID();
    await seedInsert("Memory", {
      id: `hs2b-cite-${sfx}`, agentId: AUTHOR, content: srcContent, durability: "standard",
      visibility: "shared", archived: false, instanceToken: tokSourced, createdAt: nowDate,
    });
    await seedInsert("MemoryHostSource", {
      memoryId: `hs2b-cite-${sfx}`, hostSource: JSON.stringify(POINTER), scopeAtWrite: null,
      authorId: AUTHOR, memoryInstanceToken: tokSourced, receivedAt: nowDate,
    });
    await seedInsert("Memory", {
      id: `hs2b-plain-${sfx}`, agentId: AUTHOR, content: plainContent, durability: "standard",
      visibility: "shared", archived: false, instanceToken: tokPlain, createdAt: nowDate,
    });

    const body = await tool(AUTHOR, "bootstrap", { includeContext: true, maxTokens: 8000 });
    const context: string = body?.context ?? "";
    expect(typeof context).toBe("string");

    const plainLine = lineFor(context, plainContent);
    expect(plainLine, "the unsourced item is recalled").not.toBe(""); // assertion: recalled
    // Byte-for-byte the today shape: "📝 <content> (<date>)" — no citation added.
    expect(plainLine).toBe(`📝 ${plainContent} (${nowDate.slice(0, 10)})`); // assertion: no change for an unsourced item

    const srcLine = lineFor(context, srcContent);
    expect(srcLine, "the sourced item is recalled").not.toBe(""); // assertion: recalled
    expect(srcLine).toBe(`📝 ${srcContent} (${nowDate.slice(0, 10)}) [via openclaw/run ${ID8} (unverified)]`); // assertion: its citation is rendered
  }, 180_000);

  test("a teammate's author-only pointer renders the withheld marker, never the host object", async () => {
    const marker = `zqhs2bwithheld${sfx}`;
    const content = `${marker} teammate note`;
    const tok = randomUUID();
    await seedInsert("Memory", {
      id: `hs2b-withheld-${sfx}`, agentId: AUTHOR, content, durability: "standard",
      visibility: "shared", archived: false, instanceToken: tok, createdAt: new Date().toISOString(),
    });
    await seedInsert("MemoryHostSource", {
      memoryId: `hs2b-withheld-${sfx}`, hostSource: JSON.stringify(POINTER), scopeAtWrite: null,
      authorId: AUTHOR, memoryInstanceToken: tok, receivedAt: new Date().toISOString(),
    });

    // The teammate record only reaches the reader through task-relevant retrieval.
    const body = await tool(READER, "bootstrap", { includeContext: true, maxTokens: 8000, currentTask: marker });
    const context: string = body?.context ?? "";
    const line = lineFor(context, content);
    expect(line, "the teammate record is recalled for the reader").not.toBe(""); // assertion: recalled
    expect(line).toContain("[via withheld]"); // assertion: withheld as withheld
    expect(line).not.toContain("openclaw/run"); // assertion: the host object is never rendered
  }, 180_000);
});
