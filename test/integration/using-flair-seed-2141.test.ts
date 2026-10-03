// ─── flair#2141 S2 — the using-flair seed, end to end ────────────────────────
//
// `flair init` is the install path. This runs the BUILT CLI against a fresh
// instance, exactly as an operator would, and then reads the instance: the
// skill row and its org assignment exist and are operator-attributed, and a new
// agent's bootstrap lists `using-flair` with no per-agent setup. The seeding
// call is init's, so removing it fails this file.
//
// HOME is a scratch directory; target URLs are checked for loopback and
// nondefault ports before the CLI runs.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import nacl from "tweetnacl";
import { randomUUID } from "node:crypto";
import { ensureCliBuild } from "../helpers/build-cli-once.js";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";
import {
  currentSeed,
  runSkillSeed,
  SEED_ASSIGNMENT_ID,
  SEED_SKILL_ID,
  skillSeedRestIo,
  type SeedCurrent,
} from "../../src/lib/skill-seed.js";
import {
  USING_FLAIR_SKILL_CONTENT,
  usingFlairSkillHash,
} from "../../src/lib/using-flair-skill.js";

interface TestAgent { id: string; publicKey: string; secretKey: Uint8Array }
const mkAgent = (id: string): TestAgent => {
  const kp = nacl.sign.keyPair();
  return { id, publicKey: Buffer.from(kp.publicKey).toString("base64"), secretKey: kp.secretKey };
};

const sfx = Date.now().toString(36);
const AGENT = mkAgent(`ufs-agent-${sfx}`);
const now = () => new Date().toISOString();

const ROOT = resolve(import.meta.dirname, "..", "..");
const CLI = join(ROOT, "dist", "cli.js");

let harper: HarperInstance;
let scratchHome: string;

function assertOwnInstance(h: HarperInstance): void {
  for (const url of [h.httpURL, h.opsURL]) {
    const u = new URL(url);
    expect(["127.0.0.1", "localhost"], url).toContain(u.hostname);
    expect(["9925", "9926"], `${url} must be this test's own Harper`).not.toContain(u.port);
  }
}

/** The seed's REST options, using the instance started by this test. */
function restOpts() {
  const u = new URL(harper.httpURL);
  expect(["127.0.0.1", "localhost"]).toContain(u.hostname);
  expect(u.port).not.toBe("9925");
  return { baseUrl: harper.httpURL, user: harper.admin.username, pass: harper.admin.password };
}

const basicAuth = () => "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`);

/** Run the built CLI's `flair init` against this test's instance, HOME-isolated. */
function runInit(extraArgs: string[] = []) {
  const res = spawnSync(
    process.execPath,
    [CLI, "init", "--target", harper.httpURL, "--ops-target", harper.opsURL,
      "--admin-user", harper.admin.username, "--admin-pass", harper.admin.password, "--force", ...extraArgs],
    {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 90_000,
      killSignal: "SIGKILL",
      env: { ...process.env, HOME: scratchHome, FLAIR_TARGET: "", FLAIR_OPS_TARGET: "" },
    },
  );
  return { status: res.status, signal: res.signal, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function ed25519(who: TestAgent, method: string, path: string): string {
  const ts = String(Date.now());
  const nonce = randomUUID();
  const sig = nacl.sign.detached(new TextEncoder().encode(`${who.id}:${ts}:${nonce}:${method}:${path}`), who.secretKey);
  return `TPS-Ed25519 ${who.id}:${ts}:${nonce}:${Buffer.from(sig).toString("base64")}`;
}

async function bootstrap(who: TestAgent): Promise<any> {
  const res = await fetch(`${harper.httpURL}/BootstrapMemories`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: ed25519(who, "POST", "/BootstrapMemories") },
    body: JSON.stringify({ agentId: who.id, maxTokens: 4000 }),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  expect(res.status, `bootstrap: ${text.slice(0, 300)}`).toBe(200);
  return JSON.parse(text);
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
    get_attributes: ["id", "agentId", "content", "tags", "durability", "visibility", "metadata", "provenance"],
  });
  return Array.isArray(rows) ? rows[0] : null;
}

async function assignmentRows(): Promise<any[]> {
  const rows = await ops({
    operation: "search_by_id", database: "flair", table: "OrgSkillAssignment", ids: [SEED_ASSIGNMENT_ID],
    get_attributes: ["id", "skillName", "skillRef", "priority", "writer", "sourceClass"],
  });
  return Array.isArray(rows) ? rows : [];
}

describe("flair#2141 S2 — seed a using-flair skill on install", () => {
  beforeAll(async () => {
    ensureCliBuild();
    scratchHome = mkdtempSync(join(tmpdir(), "flair-2141-s2-home-"));
    harper = await startHarper();
    assertOwnInstance(harper);
    // One agent, no skill-assignment — "no per-agent setup".
    await ops({
      operation: "insert", database: "flair", table: "Agent",
      records: [{ id: AGENT.id, name: AGENT.id, kind: "agent", status: "active", role: "agent", publicKey: AGENT.publicKey, createdAt: now() }],
    });
  }, 240_000);

  afterAll(async () => {
    if (harper) await stopHarper(harper);
    if (scratchHome) { try { rmSync(scratchHome, { recursive: true, force: true }); } catch {} }
  });

  test("before the seed, the agent's bootstrap lists no using-flair", async () => {
    const boot = await bootstrap(AGENT);
    expect((boot.skills ?? []).map((s: any) => s.name)).not.toContain("using-flair");
  }, 30_000);

  test("`flair init` seeds the skill row and its org assignment, as the operator", async () => {
    const run = runInit();
    expect(run.status, `init failed: ${run.stderr.slice(-800)}`).toBe(0);
    expect(run.stdout).toContain("using-flair skill:");

    const row = await memoryRow();
    expect(row, "the using-flair Memory row exists").toBeTruthy();
    expect(row.tags).toContain("skill");
    expect(row.durability).toBe("persistent");
    expect(row.visibility).toBe("shared");
    // Operator attribution: the write carries the verified operator principal.
    expect(JSON.parse(row.provenance).verified.agentId).toBe(harper.admin.username);
    expect(row.agentId).toBe(harper.admin.username);

    const assigns = await assignmentRows();
    expect(assigns.length, JSON.stringify(assigns)).toBe(1);
    expect(assigns[0]).toMatchObject({
      id: SEED_ASSIGNMENT_ID, skillName: "using-flair", skillRef: SEED_SKILL_ID, priority: "standard",
      writer: harper.admin.username, sourceClass: "operator",
    });
  }, 150_000);

  test("the agent's bootstrap lists using-flair with no per-agent setup", async () => {
    const boot = await bootstrap(AGENT);
    const entry = (boot.skills ?? []).find((s: any) => s.name === "using-flair");
    expect(entry, JSON.stringify(boot.skills)).toEqual({
      name: "using-flair", skillId: SEED_SKILL_ID, scope: "org", priority: "standard", source: null,
    });
    const souls = await ops({ operation: "search_by_value", database: "flair", table: "Soul", search_attribute: "agentId", search_value: AGENT.id, get_attributes: ["id", "key"] });
    expect((souls ?? []).some((s: any) => s.key === "skill-assignment")).toBe(false);
  }, 30_000);

  test("a second `flair init` preserves the skill text and assignment count", async () => {
    const before = await memoryRow();
    const run = runInit();
    expect(run.status, `init failed: ${run.stderr.slice(-800)}`).toBe(0);
    expect(run.stdout).toContain("already current");
    const after = await memoryRow();
    expect(after.content).toBe(before.content);
    expect((await assignmentRows()).length).toBe(1);
  }, 150_000);

  test("a row whose text matches a listed shipped version is replaced (the seed helper through real Harper, not a built-CLI upgrade)", async () => {
    const oldText = "an older shipped text";
    const oldCurrent: SeedCurrent = { name: "using-flair", content: oldText, trigger: "old trigger", hashes: [], priority: "standard" };
    await ops({ operation: "delete", database: "flair", table: "Memory", ids: [SEED_SKILL_ID] });
    const created = await runSkillSeed(skillSeedRestIo(restOpts(), oldCurrent), oldCurrent);
    expect(created).toMatchObject({ kind: "ok", action: "create" });
    expect((await memoryRow()).content).toBe(oldText);

    const upgraded: SeedCurrent = { ...currentSeed(), hashes: [usingFlairSkillHash(oldText)] };
    const replaced = await runSkillSeed(skillSeedRestIo(restOpts(), upgraded), upgraded);
    expect(replaced).toMatchObject({ kind: "ok", action: "replace" });
    expect((await memoryRow()).content).toBe(USING_FLAIR_SKILL_CONTENT);
  }, 30_000);

  test("an operator row whose text matches no listed shipped version is kept and reported", async () => {
    await ops({ operation: "update", database: "flair", table: "Memory", records: [{ id: SEED_SKILL_ID, content: "an operator's own text", updatedAt: now() }] });
    const run = runInit();
    expect(run.status, `init failed: ${run.stderr.slice(-800)}`).toBe(0);
    expect(run.stdout).toContain("kept it unchanged");
    expect((await memoryRow()).content).toBe("an operator's own text");
  }, 150_000);

  test("a concurrent double run leaves one row and one assignment", async () => {
    await ops({ operation: "delete", database: "flair", table: "Memory", ids: [SEED_SKILL_ID] });
    await ops({ operation: "delete", database: "flair", table: "OrgSkillAssignment", ids: [SEED_ASSIGNMENT_ID] });
    const [a, b] = await Promise.all([
      runSkillSeed(skillSeedRestIo(restOpts()), currentSeed()),
      runSkillSeed(skillSeedRestIo(restOpts()), currentSeed()),
    ]);
    expect(a.kind).toBe("ok");
    expect(b.kind).toBe("ok");
    const row = await memoryRow();
    expect(row?.id).toBe(SEED_SKILL_ID);
    expect(row?.content).toBe(USING_FLAIR_SKILL_CONTENT);
    expect((await assignmentRows()).length).toBe(1);
    const all = await ops({ operation: "search_by_value", database: "flair", table: "Memory", search_attribute: "content", search_value: USING_FLAIR_SKILL_CONTENT, get_attributes: ["id"] });
    expect((all ?? []).filter((r: any) => r.id === SEED_SKILL_ID).length).toBe(1);
  }, 30_000);

  test("an operator-owned row that is archived or private fails `flair init` before either seed row is written", async () => {
    for (const [change, phrase] of [
      [{ archived: true }, "it is archived"],
      [{ visibility: "private" }, 'its visibility is "private"'],
    ] as const) {
      const before = await memoryRow();
      await ops({ operation: "update", database: "flair", table: "Memory", records: [{ id: SEED_SKILL_ID, ...change }] });
      const run = runInit();
      expect(run.status, run.stdout + run.stderr).not.toBe(0);
      expect(run.stderr).toContain(`the "${SEED_SKILL_ID}" Memory row is not a live org skill`);
      expect(run.stderr).toContain(phrase);
      expect(run.stderr).toContain("the seed wrote neither seed row");
      await ops({ operation: "update", database: "flair", table: "Memory", records: [{ id: SEED_SKILL_ID, archived: false, visibility: before.visibility }] });
    }
    const run = runInit();
    expect(run.status, run.stdout + run.stderr).toBe(0);
  }, 300_000);

  test("an assignment pointing at another skill row fails `flair init` with a remedy", async () => {
    await ops({ operation: "update", database: "flair", table: "OrgSkillAssignment", records: [{ id: SEED_ASSIGNMENT_ID, skillRef: "some-other-row" }] });
    const run = runInit();
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("the using-flair skill seed was refused");
    expect(run.stderr).toContain("instead of");
    expect(run.stderr).toContain("flair init");
  }, 150_000);
});
