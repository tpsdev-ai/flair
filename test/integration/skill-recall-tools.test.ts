// ─── skill_search / skill_get — the RECALL slice, driven end-to-end (flair#1546) ─
//
// The write half (#1543) lands skill-tagged Memories that embed from `trigger`.
// This suite proves the recall half against a HOME-isolated ephemeral Harper,
// driving the SHIPPED `TOOLS.skill_search.impl` / `TOOLS.skill_get.impl` through
// the inproc-app fixture's generic `mcpTool` op (test/fixtures/inproc-app) — the
// same seam a real /mcp connector hits, so the REAL resolveReadScope runs.
//
// The security acceptance is cross-agent scope, which cannot be faked at the
// wrapper layer: two agents, and a skill authored PRIVATE by one must never be
// returned to the other by skill_search, nor readable via skill_get. The
// dogfood signal is the inverse: a skill authored SHARED (a normal agent-signed
// write via skill_store) IS recalled by a different agent.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, mkdir, cp, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startHarper, stopHarper, HarperInstance } from "../helpers/harper-lifecycle";
import { TOOLS } from "../../resources/mcp-tools";
import { conform } from "../helpers/mcp-conformance";

const REPO_ROOT = process.cwd();
const FIXTURE = join(REPO_ROOT, "test", "fixtures", "inproc-app");

let harper: HarperInstance;
let appDir: string;

const sfx = Date.now().toString(36);
const AUTHOR = `skillrec-author-${sfx}`;   // authors the shared + private skills
const READER = `skillrec-reader-${sfx}`;   // a DIFFERENT agent — the dogfood/scope subject

// A rare token in every trigger + the task, so recall surfaces the skills even
// on the keyword-only (BM25) fallback path — no dependence on the embedding
// engine. Scope (not relevance) is what must exclude the private skill.
const TOK = `zqxwskilltok${sfx}`;
const TASK = `${TOK} resize an uploaded image`;

// Captured skill ids (from the skill_store write echoes).
let sharedId = "";
let privateId = "";
let readerOwnId = "";
let plainMemId = "";

async function fleet(op: string, body: Record<string, unknown> = {}): Promise<any> {
  const res = await fetch(`${harper.httpURL}/AgentFleet/`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`) },
    body: JSON.stringify({ op, ...body }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`AgentFleet ${op} → HTTP ${res.status}: ${text.slice(0, 400)}`);
  return JSON.parse(text);
}

/** Drive a /mcp tool wrapper (`TOOLS[tool].impl`) AS a specific agent. */
async function tool(name: string, args: Record<string, unknown>, agentId: string): Promise<any> {
  const res = await fleet("mcpTool", { agentId, tool: name, args, isAdmin: false });
  expect(res.ok, `mcpTool ${name} failed: ${JSON.stringify(res).slice(0, 500)}`).toBe(true);
  return res.value;
}

async function ops(operation: Record<string, unknown>): Promise<any> {
  const res = await fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`) },
    body: JSON.stringify(operation),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

beforeAll(async () => {
  appDir = await mkdtemp(join(tmpdir(), "flair-inproc-skillrec-"));
  await cp(FIXTURE, appDir, { recursive: true });
  await mkdir(join(appDir, "node_modules", "@tpsdev-ai"), { recursive: true });
  await symlink(REPO_ROOT, join(appDir, "node_modules", "@tpsdev-ai", "flair"), "dir");
  harper = await startHarper({ cwd: appDir, harperBinDir: REPO_ROOT });

  await fleet("register", { id: AUTHOR });
  await fleet("register", { id: READER });

  // AUTHOR writes a SHARED skill via the real skill_store (persistent → shared
  // by default). This is the dogfood target — a normal agent-signed write.
  const shared = await tool("skill_store", {
    content: "1. Read the image. 2. Compute the target size. 3. Resample. 4. Write it back.",
    trigger: `when you need to ${TOK} resize or thumbnail an uploaded image`,
    name: "resize-image",
    description: "Resize an uploaded image to a bounded dimension",
    tags: ["images"],
  }, AUTHOR);
  sharedId = shared?.id;
  expect(sharedId, `skill_store (shared) must echo an id: ${JSON.stringify(shared).slice(0, 300)}`).toBeTruthy();

  // AUTHOR writes a second skill with a NEAR-IDENTICAL trigger (so it is an
  // equally strong recall candidate), then it is flipped to visibility=private.
  // Only SCOPE, not relevance, may keep it out of READER's results.
  const priv = await tool("skill_store", {
    content: "A private variant of the resize procedure.",
    trigger: `when you need to ${TOK} resize or thumbnail an uploaded image privately`,
    name: "resize-image-private",
    description: "Private resize procedure",
    tags: ["images"],
  }, AUTHOR);
  privateId = priv?.id;
  expect(privateId).toBeTruthy();
  // Flip to private via an ops-API MERGE update (sets only `visibility`; the
  // trigger embedding written by skill_store stays intact, so it remains a
  // strong candidate that scope alone excludes).
  const upd = await ops({ operation: "update", database: "flair", table: "Memory", records: [{ id: privateId, visibility: "private" }] });
  expect(upd.status, `flip-to-private update → ${upd.status}`).toBe(200);
  const check = await ops({ operation: "search_by_id", database: "flair", table: "Memory", ids: [privateId], get_attributes: ["visibility", "tags", "trigger"] });
  expect(check.body?.[0]?.visibility, "the private skill must actually be private").toBe("private");

  // READER owns a skill of its own (own records are always in scope).
  const own = await tool("skill_store", {
    content: "1. Load the clip. 2. Rotate. 3. Re-encode.",
    trigger: `when you need to ${TOK} rotate a video clip`,
    name: "rotate-video",
    description: "Rotate a video clip",
  }, READER);
  readerOwnId = own?.id;
  expect(readerOwnId).toBeTruthy();

  // A plain (non-skill) memory owned by READER — skill_get must reject it.
  const mem = await tool("memory_store", { content: `${TOK} an ordinary note, not a skill`, durability: "standard" }, READER);
  plainMemId = mem?.id;
  expect(plainMemId).toBeTruthy();
}, 300_000);

afterAll(async () => {
  const dataDir = harper?.installDir;
  if (harper) await stopHarper(harper);
  if (dataDir) await rm(dataDir, { recursive: true, force: true, maxRetries: 4 });
  if (appDir) await rm(appDir, { recursive: true, force: true });
});

describe("skill_search — recall, scope, and lightweight cards", () => {
  test("returns skill cards ranked for the task; honors the declared contract", async () => {
    const res = await tool("skill_search", { task: TASK, limit: 10 }, READER);
    conform("skill_search", res, TOOLS.skill_search.contract);
    expect(Array.isArray(res.results)).toBe(true);
    expect(res.results.length, "at least the shared + reader-own skills must surface").toBeGreaterThan(0);
  }, 120_000);

  test("DOGFOOD: a skill authored (shared) by AUTHOR is recalled by a DIFFERENT agent (READER)", async () => {
    const res = await tool("skill_search", { task: TASK, limit: 10 }, READER);
    const shared = res.results.find((r: any) => r.id === sharedId);
    expect(shared, "the cross-agent shared skill must be recalled by READER").toBeDefined();
    // Lightweight card: name/description from metadata, trigger present, NO procedure.
    expect(shared.name).toBe("resize-image");
    expect(shared.description).toBe("Resize an uploaded image to a bounded dimension");
    expect(typeof shared.trigger).toBe("string");
    expect(shared.agentId).toBe(AUTHOR);
    expect("content" in shared, "the full procedure must NOT be on the catalog card").toBe(false);
    expect("embedding" in shared).toBe(false);
  }, 120_000);

  test("SCOPE: another agent's PRIVATE skill is NEVER returned by skill_search", async () => {
    const res = await tool("skill_search", { task: TASK, limit: 10 }, READER);
    const ids = res.results.map((r: any) => r.id);
    expect(ids, `READER must not see AUTHOR's private skill (got ${JSON.stringify(ids)})`).not.toContain(privateId);
  }, 120_000);

  test("the owner CAN recall its own skill", async () => {
    const res = await tool("skill_search", { task: `${TOK} rotate a video`, limit: 10 }, READER);
    expect(res.results.map((r: any) => r.id)).toContain(readerOwnId);
  }, 120_000);
});

describe("skill_get — full disclosure under read-scope", () => {
  test("returns the full skill (procedure + trigger) for a readable id; honors the contract", async () => {
    const res = await tool("skill_get", { id: sharedId }, READER);
    conform("skill_get", res, TOOLS.skill_get.contract);
    expect(res.id).toBe(sharedId);
    expect(res.content, "the full procedure is disclosed by skill_get").toContain("Resample");
    expect(res.trigger).toContain(TOK);
    expect("embedding" in res, "skill_get strips the embedding by default").toBe(false);
  }, 120_000);

  test("SCOPE: a non-owner cannot skill_get another agent's PRIVATE skill (404)", async () => {
    const res = await tool("skill_get", { id: privateId }, READER);
    expect(res?.status, `READER must be denied AUTHOR's private skill: ${JSON.stringify(res).slice(0, 200)}`).toBe(404);
    expect("content" in (res ?? {}), "no procedure may leak on the denial").toBe(false);
  }, 120_000);

  test("the owner CAN skill_get its own private skill", async () => {
    const res = await tool("skill_get", { id: privateId }, AUTHOR);
    expect(res.id).toBe(privateId);
    expect(res.content).toContain("private variant");
  }, 120_000);

  test("a readable NON-skill memory is reported not found (skill_get returns only skills)", async () => {
    const res = await tool("skill_get", { id: plainMemId }, READER);
    expect(res?.status).toBe(404);
    expect(res?.error).toBe("skill not found");
  }, 120_000);
});
