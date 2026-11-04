/**
 * rem-restore-target-2708.test.ts — `flair rem restore` against real Harpers
 * (flair#2708).
 *
 * The candidate listing and the writes must reach the same instance.
 *
 * The test HOME holds NO local admin-password file, so every restore here runs
 * on the credential its flags give it (`--admin-pass-file` or `--admin-pass`)
 * and nothing else: a call that omitted it would be denied by Harper.
 *
 * Instance A is the restore target in the first test. Its rows start different
 * from the snapshot (a changed Memory, an extra Memory, a changed Soul), and it
 * holds a leftover MemoryCandidate for the agent whose claim is the snapshot
 * Soul's value. Restore lists that candidate through
 * GET /AdminMemoryCandidates/{agentId} on A's HTTP endpoint and deletes it,
 * since the learned-content guard refuses the Soul write while the candidate
 * exists, and must end with exactly the snapshot's rows. A candidate search
 * that returned nothing would leave the candidate in place and fail the Soul
 * write. That restore uses only --admin-pass-file; a second one, from a newly
 * drifted state, uses only --admin-pass. A third holds one candidate more than
 * restore's page size (CANDIDATE_LIST_LIMIT, the route's maximum `limit`), so
 * the listing takes two pages; the candidate on the second page carries the
 * snapshot Soul's value as its claim.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { startHarper, stopHarpers, type HarperInstance, HARPER_STOP_BUDGET_MS } from "../helpers/harper-lifecycle";
import { nodeBin } from "../helpers/node-runtime";
import { createSnapshot } from "../../src/rem/snapshot.ts";
import { CANDIDATE_LIST_LIMIT } from "../../src/rem/restore.ts";

const CLI = join(process.cwd(), "dist", "cli.js");
/**
 * This suite tests restore targeting, not how long an embedding call takes.
 * The write path bounds an embedding call made under the memory write lock at
 * MEMORY_LOCKED_PROVIDER_TIMEOUT_MS (20 s), and on a shared test host a slow
 * provider can outlast that bound and report `memory_provider_timeout`, which
 * reads like a targeting failure. This instance declares a wider bound; the
 * override is read only under the fault-injection gate.
 */
const PROVIDER_BOUND_ENV = {
  FLAIR_ENABLE_TEST_FAULT_INJECTION: "1",
  FLAIR_MEMORY_LOCK_PROVIDER_TIMEOUT_MS: "60000",
};
/** The restore child's budget, above the provider bound: it gives a provider refusal additional headroom to reach the assertion; the whole restore can still exceed it. */
const RESTORE_CHILD_TIMEOUT_MS = 90_000;
const FETCH_LOG_PRELOAD = join(import.meta.dirname, "..", "helpers", "fetch-request-log-preload.ts");
const AGENT_ID = "agent-a";
const MEMORY_ID = "m-restored";
const EXTRA_MEMORY_ID = "m-extra";
const SOUL_ID = `soul-${AGENT_ID}`;
const CANDIDATE_ID = "c-leftover";
const SNAPSHOT_SOUL_VALUE = "restored soul";

let a: HarperInstance;
let home: string;
let passDir: string;
let passFile: string;
/** The snapshot's file name without `.tar.gz`: a prefix only it matches, unlike the pre-restore snapshots restores add. */
let snapshotStem: string;

const createdAt = new Date().toISOString();
const snapshotMemory = { id: MEMORY_ID, agentId: AGENT_ID, content: "restored memory", durability: "persistent", createdAt };
const snapshotSoul = { id: SOUL_ID, agentId: AGENT_ID, key: "identity", value: SNAPSHOT_SOUL_VALUE, createdAt };

function assertOwnInstance(h: HarperInstance): void {
  for (const raw of [h.httpURL, h.opsURL]) {
    const u = new URL(raw);
    const port = Number(u.port);
    if (u.hostname !== "127.0.0.1" || !(port > 0) || port === 9925 || port === 9926) {
      throw new Error(`refusing to run against ${u.href}: not this test's ephemeral instance`);
    }
  }
  if (!h.process?.pid || !h.installDir.startsWith(tmpdir())) {
    throw new Error(`refusing to run: ${h.httpURL} is not an instance this test started`);
  }
}

async function ops(h: HarperInstance, body: Record<string, unknown>): Promise<any> {
  const res = await fetch(h.opsURL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Basic " + btoa(`${h.admin.username}:${h.admin.password}`),
    },
    body: JSON.stringify({ ...body, database: "flair" }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`ops ${String(body.operation)} returned ${res.status}: ${await res.text()}`);
  return res.json();
}

/** Every row of `table` for AGENT_ID on `h`, with the named attributes, sorted by id. */
async function agentRows(h: HarperInstance, table: string, attributes: string[]): Promise<any[]> {
  const rows = await ops(h, {
    operation: "search_by_conditions",
    table,
    operator: "and",
    conditions: [{ search_attribute: "agentId", search_type: "equals", search_value: AGENT_ID }],
    get_attributes: attributes,
  });
  return [...rows].sort((x: any, y: any) => String(x.id).localeCompare(String(y.id)));
}

function candidateRow(id: string, claim: string) {
  return { id, agentId: AGENT_ID, claim, generatedAt: new Date().toISOString(), status: "pending" };
}

/** With `fetchLog`, the CLI loads the request-log preload, which appends each `fetch` the CLI sends to that file. */
function runRestore(env: Record<string, string | undefined>, credential: string[], date: string, fetchLog?: string) {
  const childEnv: Record<string, string | undefined> = {
    ...process.env,
    HOME: home,
    FLAIR_URL: undefined,
    FLAIR_OPS_PORT: undefined,
    FLAIR_OPS_TARGET: undefined,
    FLAIR_TARGET: undefined,
    FLAIR_TOKEN: undefined,
    FLAIR_ADMIN_PASS: undefined,
    FLAIR_ADMIN_USER: undefined,
    HDB_ADMIN_PASSWORD: undefined,
    FLAIR_AGENT_ID: undefined,
    FLAIR_TEST_FETCH_LOG: fetchLog,
    NO_COLOR: "1",
    ...env,
  };
  for (const [key, value] of Object.entries(childEnv)) if (value === undefined) delete childEnv[key];
  const preload = fetchLog ? ["--import", pathToFileURL(FETCH_LOG_PRELOAD).href] : [];
  const child = Bun.spawn(
    [nodeBin({ env: childEnv as Record<string, string> }), ...preload, CLI, "rem", "restore", date, "--agent", AGENT_ID, "--apply", ...credential],
    // The deadline below is RESTORE_CHILD_TIMEOUT_MS, written as a number so the CLI spawn-budget gate can read it.
    { env: childEnv as Record<string, string>, timeout: 90_000, stdout: "pipe", stderr: "pipe" },
  );
  return (async () => {
    const stdout = await new Response(child.stdout).text();
    const stderr = await new Response(child.stderr).text();
    const code = await child.exited;
    return { code, stdout, stderr };
  })();
}

/** stdio for a failed restore, calling out a provider timeout when the output carries one. */
function restoreFailure(result: { stdout: string; stderr: string }): string {
  const output = `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
  return /memory_provider_timeout/.test(output)
    ? `${output}\nprovider timeout: output contains memory_provider_timeout; inspect the errors above for any additional failures`
    : output;
}

beforeAll(async () => {
  a = await startHarper({ serverEnv: { ...PROVIDER_BOUND_ENV } });
  assertOwnInstance(a);
  home = mkdtempSync(join(tmpdir(), "flair-2708-real-"));
  mkdirSync(join(home, ".flair"), { recursive: true });
  // The admin password lives OUTSIDE the test HOME, read only through --admin-pass-file.
  passDir = mkdtempSync(join(tmpdir(), "flair-2708-pass-"));
  passFile = join(passDir, "restore-admin-pass");
  writeFileSync(passFile, a.admin.password, { mode: 0o600 });
  const now = new Date();
  const created = await createSnapshot({
    agentId: AGENT_ID,
    flairVersion: "0.0.0-test",
    memories: [snapshotMemory],
    soul: snapshotSoul,
    pendingCandidateCount: null,
    rootOverride: join(home, ".flair", "snapshots"),
    nowOverride: now,
  });
  snapshotStem = basename(created.path).replace(/\.tar\.gz$/, "");
}, 300_000);

afterAll(async () => {
  try {
    await stopHarpers([a]);
  } finally {
    if (home) rmSync(home, { recursive: true, force: true });
    if (passDir) rmSync(passDir, { recursive: true, force: true });
    for (const h of [a]) {
      if (h?.installDir?.startsWith(tmpdir())) rmSync(h.installDir, { recursive: true, force: true });
    }
  }
}, HARPER_STOP_BUDGET_MS * 2);

describe("flair#2708 — rem restore on a real instance", () => {
  test("finds and deletes the target's leftover candidate and rewinds its drifted rows to the snapshot", async () => {
    // The live state differs from the snapshot in every table restore touches.
    await ops(a, {
      operation: "insert",
      table: "Memory",
      records: [
        { ...snapshotMemory, content: "drifted memory" },
        { id: EXTRA_MEMORY_ID, agentId: AGENT_ID, content: "not in the snapshot", durability: "persistent", createdAt },
      ],
    });
    await ops(a, { operation: "insert", table: "Soul", records: [{ ...snapshotSoul, value: "drifted soul" }] });
    await ops(a, { operation: "insert", table: "MemoryCandidate", records: [candidateRow(CANDIDATE_ID, SNAPSHOT_SOUL_VALUE)] });
    expect(await agentRows(a, "MemoryCandidate", ["id"])).toEqual([{ id: CANDIDATE_ID }]);
    expect(existsSync(join(home, ".flair", "admin-pass"))).toBe(false);

    const result = await runRestore(
      { FLAIR_URL: a.httpURL, FLAIR_OPS_PORT: new URL(a.opsURL).port },
      ["--admin-pass-file", passFile],
      snapshotStem,
    );

    expect(result.code, restoreFailure(result)).toBe(0);
    expect(result.stdout).toContain("Status:       completed");
    expect(result.stdout).toContain("Deleted:      2 memories, 1 souls, 1 candidates");
    expect(result.stdout).toContain("Restored:     1 memories, 1 souls");

    expect(await agentRows(a, "MemoryCandidate", ["id"])).toEqual([]);
    expect(await agentRows(a, "Memory", ["id", "content"])).toEqual([{ id: MEMORY_ID, content: "restored memory" }]);
    expect(await agentRows(a, "Soul", ["id", "key", "value"])).toEqual([{ id: SOUL_ID, key: "identity", value: SNAPSHOT_SOUL_VALUE }]);
  }, 120_000);

  test("with only --admin-pass and no local admin-password file, rewinds a newly drifted state to the snapshot", async () => {
    await ops(a, {
      operation: "upsert",
      table: "Memory",
      records: [
        { ...snapshotMemory, content: "drifted again" },
        { id: "m-extra-2", agentId: AGENT_ID, content: "also not in the snapshot", durability: "persistent", createdAt },
      ],
    });
    await ops(a, { operation: "upsert", table: "Soul", records: [{ ...snapshotSoul, value: "drifted again" }] });
    // Whatever an earlier test left, the state now differs from the snapshot.
    const drifted = await agentRows(a, "Memory", ["id", "content"]);
    expect(drifted).toContainEqual({ id: "m-extra-2", content: "also not in the snapshot" });
    expect(drifted).toContainEqual({ id: MEMORY_ID, content: "drifted again" });
    expect(existsSync(join(home, ".flair", "admin-pass"))).toBe(false);

    const result = await runRestore(
      { FLAIR_URL: a.httpURL, FLAIR_OPS_PORT: new URL(a.opsURL).port },
      ["--admin-pass", a.admin.password],
      snapshotStem,
    );

    expect(result.code, restoreFailure(result)).toBe(0);
    expect(result.stdout).toContain("Status:       completed");
    expect(result.stdout).toMatch(/Deleted: +\d+ memories, 1 souls, \d+ candidates/);
    expect(await agentRows(a, "Memory", ["id", "content"])).toEqual([{ id: MEMORY_ID, content: "restored memory" }]);
    expect(await agentRows(a, "Soul", ["id", "key", "value"])).toEqual([{ id: SOUL_ID, key: "identity", value: SNAPSHOT_SOUL_VALUE }]);
  }, 120_000);

  test("lists every candidate of an agent holding more than one page and restores completely", async () => {
    const ids = Array.from({ length: CANDIDATE_LIST_LIMIT + 1 }, (_, i) => `c-page-${String(i).padStart(4, "0")}`);
    const last = ids[ids.length - 1];
    await ops(a, {
      operation: "insert",
      table: "MemoryCandidate",
      records: ids.map((id) => candidateRow(id, id === last ? SNAPSHOT_SOUL_VALUE : `filler candidate ${id}`)),
    });
    await ops(a, { operation: "upsert", table: "Soul", records: [{ ...snapshotSoul, value: "drifted for paging" }] });
    expect(await agentRows(a, "MemoryCandidate", ["id"])).toEqual(ids.map((id) => ({ id })));
    const fetchLog = join(home, "paged-fetch-log.jsonl");

    const result = await runRestore(
      { FLAIR_URL: a.httpURL, FLAIR_OPS_PORT: new URL(a.opsURL).port },
      ["--admin-pass", a.admin.password],
      snapshotStem,
      fetchLog,
    );

    expect(result.code, restoreFailure(result)).toBe(0);
    expect(result.stdout).toContain("Status:       completed");
    expect(result.stdout).toMatch(new RegExp(`Deleted: +\\d+ memories, 1 souls, ${ids.length} candidates`));
    const requests = readFileSync(fetchLog, "utf-8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
    expect(requests.filter((r) => r.method === "GET" && r.path === `/AdminMemoryCandidates/${AGENT_ID}`)).toHaveLength(2);
    expect(await agentRows(a, "MemoryCandidate", ["id"])).toEqual([]);
    expect(await agentRows(a, "Memory", ["id", "content"])).toEqual([{ id: MEMORY_ID, content: "restored memory" }]);
    expect(await agentRows(a, "Soul", ["id", "key", "value"])).toEqual([{ id: SOUL_ID, key: "identity", value: SNAPSHOT_SOUL_VALUE }]);
  }, 120_000);
});
