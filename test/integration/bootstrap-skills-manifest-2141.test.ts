// ─── flair#2141 S1b — the skills manifest, live through the /mcp wrapper ──────
//
// Drives the SHIPPED `TOOLS.bootstrap.impl` and `TOOLS.skill_get.impl` through
// the inproc-app fixture's `mcpTool` op against a HOME-isolated ephemeral
// Harper (same driver as skill-recall-tools.test.ts), so the real
// resolveReadScope and the real Memory.get by-id gate run.
//
//   - The /mcp default (includeContext false) ships `skills` and
//     `skillDiagnostics`, and the payload passes the bootstrap contract.
//   - A name-only assignment with no own skill row resolves to a teammate's
//     shared skill, not to an older private one it cannot read; the assigned
//     agent (not the skill's owner) can skill_get that `skillId` (Sherlock
//     R4(b) on #2141).
//   - An unresolved name and an equal-priority tie appear only in
//     `skillDiagnostics`.
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
const ASSIGNEE = `s1b-assignee-${sfx}`; // holds the assignments; owns no skill rows
const AUTHOR = `s1b-author-${sfx}`;     // writes the shared skill
const HIDER = `s1b-hider-${sfx}`;       // writes an older PRIVATE skill with the same name
const SKILL_NAME = `s1b-shared-skill-${sfx}`;
const PROCEDURE = `s1b procedure body ${sfx}: step one, step two`;
let sharedId = "";
let privateId = "";

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

async function ops(operation: Record<string, unknown>): Promise<{ status: number; text: string }> {
  const res = await fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`) },
    body: JSON.stringify(operation),
  });
  return { status: res.status, text: await res.text() };
}

/** Operator-side Soul seeding through the instance's own operations API. */
async function seedAssignment(id: string, value: string, priority: string, source?: string): Promise<void> {
  const res = await ops({
    operation: "insert",
    database: "flair",
    table: "Soul",
    records: [{
      id,
      agentId: ASSIGNEE,
      key: "skill-assignment",
      value,
      priority,
      ...(source ? { metadata: JSON.stringify({ source }) } : {}),
      createdAt: new Date().toISOString(),
    }],
  });
  expect(res.status, `seed Soul ${id}: ${res.text.slice(0, 300)}`).toBe(200);
}

beforeAll(async () => {
  appDir = await mkdtemp(join(tmpdir(), "flair-inproc-s1b-"));
  await cp(FIXTURE, appDir, { recursive: true });
  await mkdir(join(appDir, "node_modules", "@tpsdev-ai"), { recursive: true });
  await symlink(REPO_ROOT, join(appDir, "node_modules", "@tpsdev-ai", "flair"), "dir");
  harper = await startHarper({ cwd: appDir, harperBinDir: REPO_ROOT });

  await fleet("register", { id: ASSIGNEE });
  await fleet("register", { id: AUTHOR });
  await fleet("register", { id: HIDER });

  // An older PRIVATE skill with the same name: the oldest row overall, but
  // outside the assignee's read scope, so it must never be the one resolved.
  const priv = await tool("skill_store", {
    content: `private variant ${sfx}`,
    trigger: `when you need the ${SKILL_NAME} procedure privately`,
    name: SKILL_NAME,
  }, HIDER);
  privateId = priv?.id;
  expect(privateId).toBeTruthy();
  const upd = await ops({
    operation: "update", database: "flair", table: "Memory",
    records: [{ id: privateId, visibility: "private", createdAt: "2020-01-01T00:00:00.000Z" }],
  });
  expect(upd.status, `make the HIDER skill private and older: ${upd.text.slice(0, 300)}`).toBe(200);

  const shared = await tool("skill_store", {
    content: PROCEDURE,
    trigger: `when you need the ${SKILL_NAME} procedure`,
    name: SKILL_NAME,
  }, AUTHOR);
  sharedId = shared?.id;
  expect(sharedId, `skill_store must echo an id: ${JSON.stringify(shared).slice(0, 300)}`).toBeTruthy();

  await seedAssignment(`s1b-a-${sfx}`, SKILL_NAME, "standard", "npm:@example/shared@1.0.0");
  await seedAssignment(`s1b-b-${sfx}`, `s1b-missing-${sfx}`, "standard");
  await seedAssignment(`s1b-c-${sfx}`, `s1b-tied-${sfx}`, "high", "npm:@example/tied@1.0.0");
  await seedAssignment(`s1b-d-${sfx}`, `s1b-tied-${sfx}`, "high", "npm:@example/tied@2.0.0");
}, 300_000);

afterAll(async () => {
  const dataDir = harper?.installDir;
  if (harper) await stopHarper(harper);
  if (dataDir) await rm(dataDir, { recursive: true, force: true, maxRetries: 4 });
  if (appDir) await rm(appDir, { recursive: true, force: true });
});

describe("flair#2141 S1b — bootstrap skills manifest over /mcp", () => {
  test("the /mcp default ships skills and skillDiagnostics and passes the bootstrap contract", async () => {
    const args = {};
    const res = await tool("bootstrap", args, ASSIGNEE);
    conform("bootstrap", res, TOOLS.bootstrap.contract, { args });
    expect(res.skills).toEqual([
      { name: SKILL_NAME, skillId: sharedId, scope: "own", priority: "standard", source: "npm:@example/shared@1.0.0" },
    ]);
    const decisions = res.skillDiagnostics.map((d: any) => `${d.name}:${d.decision}`).sort();
    expect(decisions).toEqual([`s1b-missing-${sfx}:unresolved`, `s1b-tied-${sfx}:refused`, `s1b-tied-${sfx}:refused`]);
    expect(JSON.stringify(res.skills), "the manifest never carries the procedure").not.toContain(PROCEDURE);
  }, 120_000);

  test("the assigned agent, which does not own the skill, can skill_get the manifest skillId", async () => {
    const res = await tool("bootstrap", {}, ASSIGNEE);
    const skillId = res.skills[0]?.skillId;
    expect(skillId).toBe(sharedId);
    const got = await tool("skill_get", { id: skillId }, ASSIGNEE);
    expect(got.agentId, "the row belongs to another agent").toBe(AUTHOR);
    expect(got.content).toBe(PROCEDURE);
  }, 120_000);
});
