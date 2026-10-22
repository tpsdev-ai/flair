/**
 * skill-update-caller-transaction-2686.test.ts — real Harper, a caller-owned
 * transaction, and a superseding skill POST (flair#2686, part 1).
 *
 * The write journal captures the writes a skill update stages, including those
 * its caller hooks stage, and intercepts Harper's `transaction.next` so a write
 * on a chained transaction is journaled too. The unit cases for #2650 pin both
 * shapes against a fake transaction:
 * `test/unit-isolated/skill-update-confirmation-2645.test.ts` — "journal
 * captures a caller write on a chained transaction" and "a refused outer
 * transaction compensates a caller hook's committed inner write". No current
 * caller hook creates a chained write, so these cases install one on the
 * exported `defaultSkillHooks` in a composed copy of the built component and
 * run it through the in-process caller fixture
 * (test/fixtures/inproc-app, which opens and aborts a caller-owned transaction).
 * A second database in that copy makes Harper create a real `transaction.next`
 * link for the hook's write.
 *
 * Case 1: the hook writes a row to the second database while a superseding POST
 * closes its predecessor. Exhausted close retries refuse the update and
 * compensation undoes the chained write along with the successor and version.
 * Case 2: a caller abort after a superseding POST returns. The POST plans in the
 * caller's transaction without staging, then commits in a transaction it owns,
 * so the abort does not undo the successor or the close (flair#2650).
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHarper, stopHarper, type HarperInstance, HARPER_STOP_BUDGET_MS } from "../helpers/harper-lifecycle";
import { assertOwnInstance } from "../helpers/own-harper-instance";

const REPO_ROOT = process.cwd();
const APP_FIXTURE = join(REPO_ROOT, "test", "fixtures", "inproc-app");
const PROBE_SOURCE = join(REPO_ROOT, "test", "fixtures", "chain-write-probe-2686", "probe.js");
const PROBE_TARGET_REL = join("dist", "resources", "zz-chain-write-2686.js");

const sfx = Date.now().toString(36);
const AGENT = `caller-txn-${sfx}`;

let harper: HarperInstance;
let appDir = "";
let pauseDir = "";
let seq = 0;
const nextId = (label: string) => `${AGENT}-${label}-${++seq}`;
const now = () => new Date().toISOString();
const basicAuth = () => "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`);

async function fleet(op: string, body: Record<string, unknown> = {}): Promise<any> {
  const res = await fetch(`${harper.httpURL}/AgentFleet/`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: basicAuth() },
    body: JSON.stringify({ op, ...body }),
    signal: AbortSignal.timeout(180_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`AgentFleet ${op} -> HTTP ${res.status}: ${text.slice(0, 400)}`);
  return JSON.parse(text);
}

async function probe(op: string, body: Record<string, unknown> = {}): Promise<any> {
  const res = await fetch(`${harper.httpURL}/ChainWriteProbe/`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: basicAuth() },
    body: JSON.stringify({ op, ...body }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  expect(res.status, `ChainWriteProbe ${op}: ${text.slice(0, 300)}`).toBe(200);
  return JSON.parse(text);
}

async function ops(operation: Record<string, unknown>): Promise<any> {
  const res = await fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: basicAuth() },
    body: JSON.stringify(operation),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  expect(res.status, `${operation.operation}: ${text.slice(0, 300)}`).toBe(200);
  return text.length > 0 ? JSON.parse(text) : undefined;
}

async function memoryRow(id: string): Promise<any | null> {
  const rows = await ops({ operation: "search_by_id", database: "flair", table: "Memory", ids: [id], get_attributes: ["*"] });
  return rows[0] ?? null;
}

async function liveHeads(subjectId: string): Promise<string[]> {
  const rows = await ops({
    operation: "search_by_value", database: "flair", table: "Memory",
    search_attribute: "skillSubjectId", search_value: subjectId, get_attributes: ["id", "validTo", "archived"],
  });
  return (rows as any[])
    .filter((row) => row.archived !== true && !(typeof row.validTo === "string" && row.validTo.length > 0))
    .map((row) => String(row.id));
}

async function versionsOf(subjectId: string): Promise<any[]> {
  const rows = await ops({
    operation: "search_by_value", database: "flair", table: "InstructionVersion",
    search_attribute: "subjectId", search_value: subjectId, get_attributes: ["*"],
  });
  return (rows as any[]).sort((a, b) => Number(a.version) - Number(b.version));
}

async function createSkill(id: string, content: string): Promise<void> {
  const created = await fleet("postMemory", {
    agentId: AGENT,
    record: { id, agentId: AGENT, content, tags: ["skill"], durability: "persistent", trigger: `when to ${content}` },
  });
  expect(created.ok, JSON.stringify(created).slice(0, 400)).toBe(true);
  expect(created.value.id).toBe(id);
}

function skillBody(id: string, content: string): Record<string, unknown> {
  return { id, agentId: AGENT, content, tags: ["skill"], durability: "persistent", trigger: `when to ${content}` };
}

async function waitFor(path: string, timeoutMs: number, content?: string): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path) && (content === undefined || readFileSync(path, "utf8") === content)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

/** Commit a newer full record to the skill row, outside the version write lock. */
async function commitNewerSkillWrite(id: string, content: string): Promise<void> {
  const current = await memoryRow(id);
  expect(current, "the skill row is missing before the competing write").not.toBeNull();
  await ops({
    operation: "put", database: "flair", table: "Memory",
    records: [{ ...current, content, updatedAt: now() }],
  });
  expect((await memoryRow(id))?.content, "the competing write is not visible while the update is paused").toBe(content);
}

/** Pause at each close attempt in order, committing a newer predecessor row at each. */
async function withPausedCloses(points: string[], trigger: () => Promise<any>, compete: (index: number) => Promise<void>) {
  for (const point of points) {
    for (const marker of ["claimed", "paused", "go", "released"]) rmSync(join(pauseDir, `${marker}.${point}`), { force: true });
    writeFileSync(join(pauseDir, `arm.${point}`), "");
  }
  const pending = trigger();
  try {
    for (const [index, point] of points.entries()) {
      expect(await waitFor(join(pauseDir, `paused.${point}`), 20_000), point).toBe(true);
      await compete(index);
      writeFileSync(join(pauseDir, `go.${point}`), "");
      expect(await waitFor(join(pauseDir, `released.${point}`), 5_000, "go"), point).toBe(true);
      expect(readFileSync(join(pauseDir, `released.${point}`), "utf8"), point).toBe("go");
    }
    return await pending;
  } finally {
    for (const point of points) {
      writeFileSync(join(pauseDir, `go.${point}`), "");
      rmSync(join(pauseDir, `arm.${point}`), { force: true });
    }
    await pending;
  }
}

const closePoints = ["skill-close-staged", "skill-update-retry-first", "skill-update-retry-second", "skill-update-retry-third"];

/** A private application: the in-process caller fixture plus a private copy of the built component with the probe. */
async function composeApp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "flair-caller-txn-2686-"));
  await cp(APP_FIXTURE, dir, { recursive: true });
  const flairDir = join(dir, "node_modules", "@tpsdev-ai", "flair");
  await mkdir(flairDir, { recursive: true });
  for (const entry of ["config.yaml", "package.json", "dist", "schemas"]) {
    const source = join(REPO_ROOT, entry);
    if (existsSync(source)) await cp(source, join(flairDir, entry), { recursive: true });
  }
  const nodeModules = join(REPO_ROOT, "node_modules");
  if (existsSync(nodeModules)) await symlink(nodeModules, join(flairDir, "node_modules"), "dir");
  await cp(PROBE_SOURCE, join(flairDir, PROBE_TARGET_REL));
  // A second database for the caller hook's chained write. Its table is
  // declared by this schema file, which the composed copy's config loads.
  await writeFile(join(flairDir, "schemas", "zz-chain-2686.graphql"),
    "type ChainRow @table(database: \"chain2686\") {\n  id: ID @primaryKey\n  value: String\n}\n");
  return dir;
}

beforeAll(async () => {
  if (process.env.HARPER_HTTP_URL) throw new Error("requires an isolated Harper; unset HARPER_HTTP_URL");
  pauseDir = mkdtempSync(join(tmpdir(), "flair-2686-pause-"));
  appDir = await composeApp();
  harper = await startHarper({
    cwd: appDir,
    harperBinDir: REPO_ROOT,
    serverEnv: { FLAIR_ENABLE_TEST_FAULT_INJECTION: "1", FLAIR_TEST_PAUSE_DIR: pauseDir },
  });
  assertOwnInstance(harper);
  await fleet("register", { id: AGENT });
}, 300_000);

afterAll(async () => {
  if (harper) await stopHarper(harper);
  if (appDir) await rm(appDir, { recursive: true, force: true, maxRetries: 4 });
  if (pauseDir) rmSync(pauseDir, { recursive: true, force: true });
}, HARPER_STOP_BUDGET_MS);

describe("flair#2686 — a superseding POST in a caller-owned transaction", () => {
  it("compensates a caller hook's chained transaction.next write when the close retries are exhausted", async () => {
    const predecessorId = nextId("chained-predecessor");
    const successorId = nextId("chained-successor");
    const chainId = nextId("chained-row");
    await createSkill(predecessorId, "v1");
    await probe("arm", { predecessorId, rowId: chainId });

    const response = await withPausedCloses(closePoints,
      () => fleet("supersedeInCallerTransaction", {
        ...skillBody(successorId, "v2"), supersedes: predecessorId, abort: false,
      }),
      async (index) => { await commitNewerSkillWrite(predecessorId, `competitor-${index}`); });

    expect(response.ok, JSON.stringify(response).slice(0, 400)).toBe(false);
    expect(response.status, JSON.stringify(response).slice(0, 400)).toBe(409);
    expect(JSON.parse(response.body).error).toBe("skill_update_not_closed");

    const hook = await probe("state");
    expect(hook.writes, "the caller hook did not stage its chained write").toBe(1);
    expect(await probe("read", { id: chainId }).then((result) => result.row), "compensation left the chained transaction row").toBeNull();
    expect(await memoryRow(successorId), "the successor was not rolled back").toBeNull();
    const predecessor = await memoryRow(predecessorId);
    expect(predecessor?.validTo ?? null, "the predecessor is not open").toBeNull();
    expect(predecessor?.content).toBe("competitor-3");
    expect((await versionsOf(predecessorId)).map((row) => row.kind), "the refused update left a version row").toEqual(["create"]);
    expect(await liveHeads(predecessorId)).toEqual([predecessorId]);
  }, 180_000);

  it("a caller abort after the POST returns does not undo the successor or the close", async () => {
    const predecessorId = nextId("abort-predecessor");
    const successorId = nextId("abort-successor");
    await createSkill(predecessorId, "v1");

    const result = await fleet("supersedeInCallerTransaction", {
      ...skillBody(successorId, "v2"), supersedes: predecessorId, abort: true,
    });
    expect(result.ok, JSON.stringify(result).slice(0, 400)).toBe(true);
    expect(result.value, "the write did not return before the caller aborted").toEqual({ aborted: true, written: true });

    const successor = await memoryRow(successorId);
    expect(successor, "the caller abort undid the POST's successor").not.toBeNull();
    expect(successor?.supersedes).toBe(predecessorId);
    expect(typeof (await memoryRow(predecessorId))?.validTo === "string", "the caller abort undid the close").toBe(true);
    expect((await versionsOf(predecessorId)).map((row) => row.kind), JSON.stringify(await versionsOf(predecessorId))).toEqual(["create", "update"]);
    expect(await liveHeads(predecessorId)).toEqual([successorId]);
  }, 120_000);
});
