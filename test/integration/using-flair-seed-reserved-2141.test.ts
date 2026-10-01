// ─── flair#2141 S2 — the seed's fixed ids belong to the operator ─────────────
//
// Real Harper. The seed writes a skill row and an org assignment at fixed ids,
// and eligible agent bootstraps may list it when it wins same-name resolution
// and fits the budget, so:
//
//   - an agent cannot create, replace, patch, delete or supersede the seed row,
//     through POST/PUT/PATCH/DELETE /Memory or POST /FeedMemories, and a
//     federation peer's row never lands on it;
//   - an agent whose id equals the operator's username is refused the same way
//     (operator authority is the request's auth class, not the stored owner);
//   - `flair init` refuses an existing seed row written by anyone but the
//     operator, and refuses when an Agent record holds the operator's id;
//   - the operator's own rows still upgrade.
//
// HOME is a scratch directory; target URLs are checked for loopback and
// nondefault ports before the CLI runs.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import nacl from "tweetnacl";
import { ensureCliBuild } from "../helpers/build-cli-once.js";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";
import { signBodyFresh } from "../../resources/federation-crypto.js";
import {
  currentSeed,
  runSkillSeed,
  SEED_ASSIGNMENT_ID,
  SEED_SKILL_ID,
  skillSeedRestIo,
  type SeedCurrent,
} from "../../src/lib/skill-seed.js";
import { USING_FLAIR_SKILL_CONTENT, usingFlairSkillHash } from "../../src/lib/using-flair-skill.js";

interface TestAgent { id: string; publicKey: string; secretKey: Uint8Array }
const mkAgent = (id: string): TestAgent => {
  const kp = nacl.sign.keyPair();
  return { id, publicKey: Buffer.from(kp.publicKey).toString("base64"), secretKey: kp.secretKey };
};

const sfx = Date.now().toString(36);
const AGENT = mkAgent(`seedres-agent-${sfx}`);
const ROOT = resolve(import.meta.dirname, "..", "..");
const CLI = join(ROOT, "dist", "cli.js");
const ROW_PATH = `/Memory/${encodeURIComponent(SEED_SKILL_ID)}`;
const ASSIGNMENT_PATH = `/OrgSkillAssignment/${encodeURIComponent(SEED_ASSIGNMENT_ID)}`;
const now = () => new Date().toISOString();

let harper: HarperInstance;
let scratchHome: string;
/** An agent whose id is the operator's username. Registered by the test that uses it. */
let shadow: TestAgent;

function assertOwnInstance(h: HarperInstance): void {
  for (const url of [h.httpURL, h.opsURL]) {
    const u = new URL(url);
    expect(["127.0.0.1", "localhost"], url).toContain(u.hostname);
    expect(["9925", "9926"], `${url} must be this test's own Harper`).not.toContain(u.port);
  }
}

const basicAuth = () => "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`);

function ed25519(who: TestAgent, method: string, path: string): string {
  const ts = String(Date.now());
  const nonce = randomUUID();
  const sig = nacl.sign.detached(new TextEncoder().encode(`${who.id}:${ts}:${nonce}:${method}:${path}`), who.secretKey);
  return `TPS-Ed25519 ${who.id}:${ts}:${nonce}:${Buffer.from(sig).toString("base64")}`;
}

/** A request signed by `who`; returns the status and the parsed body (or text). */
async function asAgent(who: TestAgent, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${harper.httpURL}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: ed25519(who, method, path) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let parsed: any = text;
  try { parsed = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body: parsed };
}

async function asOperator(method: string, path: string, body?: unknown): Promise<number> {
  const res = await fetch(`${harper.httpURL}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: basicAuth() },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  await res.text();
  return res.status;
}

async function ops(operation: Record<string, unknown>): Promise<any> {
  const res = await fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: basicAuth() },
    body: JSON.stringify(operation),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  expect(res.status, `${operation.operation}: ${text.slice(0, 300)}`).toBe(200);
  return text.length > 0 ? JSON.parse(text) : undefined;
}

async function memoryRow(): Promise<any> {
  const rows = await ops({
    operation: "search_by_id", database: "flair", table: "Memory", ids: [SEED_SKILL_ID],
    get_attributes: ["id", "agentId", "content", "tags", "visibility", "archived", "validTo"],
  });
  return Array.isArray(rows) ? rows[0] ?? null : null;
}

async function assignmentRows(): Promise<any[]> {
  const rows = await ops({
    operation: "search_by_id", database: "flair", table: "OrgSkillAssignment", ids: [SEED_ASSIGNMENT_ID],
    get_attributes: ["id", "skillName", "skillRef", "priority"],
  });
  return Array.isArray(rows) ? rows : [];
}

async function registerAgent(who: TestAgent): Promise<void> {
  await ops({
    operation: "upsert", database: "flair", table: "Agent",
    records: [{ id: who.id, name: who.id, kind: "agent", status: "active", role: "agent", publicKey: who.publicKey, createdAt: now() }],
  });
}

function restOpts() {
  return { baseUrl: harper.httpURL, user: harper.admin.username, pass: harper.admin.password };
}

/** Run the built CLI's `flair init` against this test's instance, HOME-isolated. */
function runInit() {
  const res = spawnSync(
    process.execPath,
    [CLI, "init", "--target", harper.httpURL, "--ops-target", harper.opsURL,
      "--admin-user", harper.admin.username, "--admin-pass", harper.admin.password, "--force"],
    {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 90_000,
      killSignal: "SIGKILL",
      env: { ...process.env, HOME: scratchHome, FLAIR_TARGET: "", FLAIR_OPS_TARGET: "" },
    },
  );
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

const skillBody = (who: TestAgent, content = "an agent's text") => ({
  id: SEED_SKILL_ID, agentId: who.id, content, trigger: "when to use", tags: ["skill"],
  durability: "persistent", visibility: "shared",
});

function expectReserved(res: { status: number; body: any }, what: string): void {
  expect(res.status, `${what}: ${JSON.stringify(res.body).slice(0, 300)}`).toBe(403);
  expect(String(res.body?.error ?? ""), what).toStartWith("seed_id_reserved");
}

describe("flair#2141 S2 — the seed's fixed ids belong to the operator", () => {
  beforeAll(async () => {
    ensureCliBuild();
    scratchHome = mkdtempSync(join(tmpdir(), "flair-2141-res-"));
    harper = await startHarper();
    assertOwnInstance(harper);
    shadow = mkAgent(harper.admin.username);
    await registerAgent(AGENT);
  }, 240_000);

  afterAll(async () => {
    if (harper) await stopHarper(harper);
    if (scratchHome) { try { rmSync(scratchHome, { recursive: true, force: true }); } catch {} }
  });

  test("an agent cannot create the seed row through PUT, POST or PATCH /Memory, or POST /FeedMemories", async () => {
    expectReserved(await asAgent(AGENT, "PUT", ROW_PATH, skillBody(AGENT)), "PUT /Memory/<seed>");
    expectReserved(await asAgent(AGENT, "POST", "/Memory", skillBody(AGENT)), "POST /Memory {id: seed}");
    expectReserved(await asAgent(AGENT, "PATCH", ROW_PATH, { content: "x" }), "PATCH /Memory/<seed>");
    expectReserved(
      await asAgent(AGENT, "POST", "/FeedMemories", { id: SEED_SKILL_ID, agentId: AGENT.id, content: "fed text" }),
      "POST /FeedMemories {id: seed}",
    );
    expect(await memoryRow()).toBeNull();
  }, 60_000);

  test("a federation peer's row never lands on the seed id", async () => {
    const kp = nacl.sign.keyPair();
    const instanceId = `seedres-peer-${sfx}`;
    await ops({
      operation: "upsert", database: "flair", table: "Peer",
      records: [{ id: instanceId, publicKey: Buffer.from(kp.publicKey).toString("base64url"), role: "spoke", status: "paired", createdAt: now() }],
    });
    const signed = signBodyFresh({
      instanceId,
      records: [{
        table: "Memory",
        id: SEED_SKILL_ID,
        data: { id: SEED_SKILL_ID, agentId: AGENT.id, content: "a peer's text", visibility: "shared", createdAt: now() },
        updatedAt: now(),
      }],
      lamportClock: Date.now(),
    }, kp.secretKey);
    const res = await fetch(`${harper.httpURL}/FederationSync`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(signed),
      signal: AbortSignal.timeout(30_000),
    });
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.merged).toBe(0);
    expect(body.skippedReasons?.seed_id_not_federated).toBe(1);
    expect(await memoryRow()).toBeNull();
  }, 60_000);

  test("the operator seeds both rows (seed helper through real Harper)", async () => {
    expect(await runSkillSeed(skillSeedRestIo(restOpts()), currentSeed())).toMatchObject({ kind: "ok", action: "create" });
    expect((await memoryRow())?.agentId).toBe(harper.admin.username);
    expect((await assignmentRows()).length).toBe(1);
  }, 60_000);

  test("an agent whose id equals the operator's username cannot change the seeded row or its assignment", async () => {
    await registerAgent(shadow);
    try {
      expectReserved(await asAgent(shadow, "PUT", ROW_PATH, skillBody(shadow)), "PUT as the same-name agent");
      expectReserved(await asAgent(shadow, "PATCH", ROW_PATH, { content: "patched" }), "PATCH as the same-name agent");
      expectReserved(await asAgent(shadow, "DELETE", ROW_PATH), "DELETE as the same-name agent");
      expectReserved(
        await asAgent(shadow, "POST", "/Memory", { id: `seedres-new-${sfx}`, agentId: shadow.id, content: "replacement", supersedes: SEED_SKILL_ID }),
        "POST /Memory {supersedes: seed} as the same-name agent",
      );
      expectReserved(
        await asAgent(shadow, "POST", "/FeedMemories", { id: SEED_SKILL_ID, agentId: shadow.id, content: "fed text" }),
        "POST /FeedMemories {id: seed} as the same-name agent",
      );
      const assignmentWrite = await asAgent(shadow, "PUT", ASSIGNMENT_PATH, { skillName: "using-flair", skillRef: "elsewhere", priority: "standard" });
      expect(assignmentWrite.status, JSON.stringify(assignmentWrite.body)).toBe(403);

      const row = await memoryRow();
      expect(row).toMatchObject({ agentId: harper.admin.username, content: USING_FLAIR_SKILL_CONTENT });
      expect(row.validTo ?? null).toBeNull();
      expect(await assignmentRows()).toEqual([
        { id: SEED_ASSIGNMENT_ID, skillName: "using-flair", skillRef: SEED_SKILL_ID, priority: "standard" },
      ]);

      // While that agent exists, a row owned by the operator's id is ambiguous.
      const run = runInit();
      expect(run.status, run.stdout + run.stderr).not.toBe(0);
      expect(run.stderr).toContain(`an Agent record has the operator's id "${harper.admin.username}"`);
      expect(run.stderr).toContain("the seed wrote neither seed row");
    } finally {
      await ops({ operation: "delete", database: "flair", table: "Agent", ids: [shadow.id] });
    }
  }, 150_000);

  test("`flair init` refuses a pre-existing agent-written seed row before either seed row is written, and the remedy works", async () => {
    expect(await asOperator("DELETE", ROW_PATH)).toBeLessThan(300);
    await ops({ operation: "delete", database: "flair", table: "OrgSkillAssignment", ids: [SEED_ASSIGNMENT_ID] });
    // A row an agent wrote before the server reserved the id: the current text,
    // a live skill, owned by the agent.
    await ops({
      operation: "insert", database: "flair", table: "Memory",
      records: [{ ...skillBody(AGENT, USING_FLAIR_SKILL_CONTENT), archived: false, createdAt: now(), updatedAt: now() }],
    });

    const refused = runInit();
    expect(refused.status, refused.stdout + refused.stderr).not.toBe(0);
    expect(refused.stderr).toContain(`the "${SEED_SKILL_ID}" Memory row is owned by "${AGENT.id}"`);
    expect(refused.stderr).toContain("the seed wrote neither seed row");
    expect(refused.stderr).toContain(`DELETE ${ROW_PATH}`);
    expect(await assignmentRows()).toEqual([]);
    expect((await memoryRow())?.agentId).toBe(AGENT.id);

    // The remedy: the operator deletes the row, and init seeds its own.
    expect(await asOperator("DELETE", ROW_PATH)).toBeLessThan(300);
    const seeded = runInit();
    expect(seeded.status, seeded.stdout + seeded.stderr).toBe(0);
    expect((await memoryRow())?.agentId).toBe(harper.admin.username);
    expect((await assignmentRows()).length).toBe(1);
  }, 240_000);

  test("the operator's own rows still upgrade (seed helper through real Harper, then the built CLI)", async () => {
    expect(await asOperator("DELETE", ROW_PATH)).toBeLessThan(300);
    const oldText = "an older shipped text";
    const old: SeedCurrent = { name: "using-flair", content: oldText, trigger: "old trigger", hashes: [], priority: "standard" };
    expect(await runSkillSeed(skillSeedRestIo(restOpts(), old), old)).toMatchObject({ kind: "ok", action: "create" });
    expect((await memoryRow())?.content).toBe(oldText);

    const upgraded: SeedCurrent = { ...currentSeed(), hashes: [usingFlairSkillHash(oldText)] };
    expect(await runSkillSeed(skillSeedRestIo(restOpts(), upgraded), upgraded)).toMatchObject({ kind: "ok", action: "replace" });
    expect(await memoryRow()).toMatchObject({ agentId: harper.admin.username, content: USING_FLAIR_SKILL_CONTENT });

    const run = runInit();
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(run.stdout).toContain("already current");
  }, 150_000);
});
