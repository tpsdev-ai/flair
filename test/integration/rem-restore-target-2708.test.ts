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
 * Soul's value. Restore must find that candidate through A's operations API and
 * delete it, since the learned-content guard refuses the Soul write while the
 * candidate exists, and must end with exactly the snapshot's rows. A candidate
 * search that returned nothing would leave the candidate in place and fail the
 * Soul write. That restore uses only --admin-pass-file; a second one, from a
 * newly drifted state, uses only --admin-pass.
 *
 * The refusal test starts instance B, a second real Harper, and runs with NO
 * configured pair (no config file in HOME): FLAIR_URL names B and
 * FLAIR_OPS_PORT names A's operations port. Restore must refuse before any
 * listing, delete or write, and both instances keep every row. That run loads
 * test/helpers/fetch-request-log-preload.ts through `node --import`, and its
 * request log must hold one request: a POST to A's operations port, the pair
 * check's configuration read.
 *
 * The last test runs the non-loopback branch of the preflight pair check
 * (`establishRestorePair` with a target marked non-loopback) against the two real
 * Harpers: it passes only when the HTTP endpoint and the operations endpoint
 * each report exactly one flair.Instance row with the same id, and refuses
 * with no row on a side or with A's HTTP endpoint and B's operations endpoint
 * once each has its own row.
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
import { establishRestorePair, type RestoreTarget } from "../../src/commands/rem.ts";

const CLI = join(process.cwd(), "dist", "cli.js");
const FETCH_LOG_PRELOAD = join(import.meta.dirname, "..", "helpers", "fetch-request-log-preload.ts");
const AGENT_ID = "agent-a";
const MEMORY_ID = "m-restored";
const EXTRA_MEMORY_ID = "m-extra";
const SOUL_ID = `soul-${AGENT_ID}`;
const CANDIDATE_ID = "c-leftover";
const SNAPSHOT_SOUL_VALUE = "restored soul";

let a: HarperInstance;
let b: HarperInstance | undefined;
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
    { env: childEnv as Record<string, string>, timeout: 60_000, stdout: "pipe", stderr: "pipe" },
  );
  return (async () => {
    const stdout = await new Response(child.stdout).text();
    const stderr = await new Response(child.stderr).text();
    const code = await child.exited;
    return { code, stdout, stderr };
  })();
}

beforeAll(async () => {
  a = await startHarper();
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
    await stopHarpers([a, b]);
  } finally {
    if (home) rmSync(home, { recursive: true, force: true });
    if (passDir) rmSync(passDir, { recursive: true, force: true });
    for (const h of [a, b]) {
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

    expect(result.code, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
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

    expect(result.code, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("Status:       completed");
    expect(result.stdout).toMatch(/Deleted: +\d+ memories, 1 souls, \d+ candidates/);
    expect(await agentRows(a, "Memory", ["id", "content"])).toEqual([{ id: MEMORY_ID, content: "restored memory" }]);
    expect(await agentRows(a, "Soul", ["id", "key", "value"])).toEqual([{ id: SOUL_ID, key: "identity", value: SNAPSHOT_SOUL_VALUE }]);
  }, 120_000);

  test("with no configured pair, refuses FLAIR_URL at one instance and FLAIR_OPS_PORT at another before any listing or write", async () => {
    b = await startHarper();
    assertOwnInstance(b);
    expect(existsSync(join(home, ".flair", "config.yaml"))).toBe(false);

    await ops(a, { operation: "insert", table: "MemoryCandidate", records: [candidateRow("c-on-a", "a candidate on instance A")] });
    await ops(b, {
      operation: "insert",
      table: "Memory",
      records: [{ id: "m-on-b", agentId: AGENT_ID, content: "instance B memory", durability: "persistent", createdAt }],
    });
    await ops(b, { operation: "insert", table: "Soul", records: [{ id: SOUL_ID, agentId: AGENT_ID, key: "identity", value: "instance B soul", createdAt }] });

    const tables: Array<[string, string[]]> = [
      ["Memory", ["id", "content"]],
      ["Soul", ["id", "value"]],
      ["MemoryCandidate", ["id", "claim"]],
    ];
    const snapshotRows = async () => {
      const out: Record<string, unknown> = {};
      for (const h of [a, b!]) for (const [table, attrs] of tables) out[`${h.httpURL} ${table}`] = await agentRows(h, table, attrs);
      return out;
    };
    const before = await snapshotRows();
    expect(before[`${a.httpURL} MemoryCandidate`]).toContainEqual({ id: "c-on-a", claim: "a candidate on instance A" });

    const aOps = new URL(a.opsURL).port;
    const fetchLog = join(home, "refusal-fetch-log.jsonl");
    const result = await runRestore({ FLAIR_URL: b.httpURL, FLAIR_OPS_PORT: aOps }, ["--admin-pass", b.admin.password], snapshotStem, fetchLog);

    expect(result.code, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).not.toBe(0);
    expect(result.stderr).toContain(
      `operations port ${aOps} belongs to the instance serving HTTP port ${new URL(a.httpURL).port}, not restore target ${b.httpURL}`,
    );
    expect(result.stderr).toContain("nothing was listed, deleted or written");
    // The request log holds one request, a POST to A's operations port: the
    // configuration read whose answer names A's HTTP port in the refusal above.
    const requests = readFileSync(fetchLog, "utf-8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
    expect(requests).toEqual([{ method: "POST", host: `127.0.0.1:${aOps}`, path: "/" }]);
    expect(result.stdout).not.toContain("Deleted:");
    expect(await snapshotRows()).toEqual(before);
  }, 300_000);

  test("the non-loopback pair check passes only when both endpoints of real instances report the same single identity", async () => {
    if (!b) {
      b = await startHarper();
      assertOwnInstance(b);
    }
    const second = b;
    const remote = (http: HarperInstance, opsSide: HarperInstance): RestoreTarget => ({
      baseUrl: http.httpURL.replace(/\/+$/, ""),
      opsUrl: opsSide.opsURL.replace(/\/+$/, ""),
      httpPort: Number(new URL(http.httpURL).port),
      opsPort: Number(new URL(opsSide.opsURL).port),
      loopback: false,
    });
    const admin = { user: a.admin.username, pass: a.admin.password };
    const instanceRow = (id: string) => ({ id, publicKey: `seed-pub-${id}`, role: "hub", status: "active", createdAt: new Date().toISOString() });

    // A fresh instance has no Instance row, so nothing proves the pair.
    await expect(establishRestorePair(remote(a, a), admin)).rejects.toThrow(/reports no flair\.Instance row/);

    await ops(a, { operation: "insert", table: "Instance", records: [instanceRow("instance-a-2708")] });
    await establishRestorePair(remote(a, a), admin);

    // A's HTTP endpoint with B's operations endpoint, B still without a row.
    await expect(establishRestorePair(remote(a, second), admin)).rejects.toThrow(
      /the operations endpoint's Instance read reports no flair\.Instance row/,
    );

    await ops(second, { operation: "insert", table: "Instance", records: [instanceRow("instance-b-2708")] });
    await expect(establishRestorePair(remote(a, second), admin)).rejects.toThrow(/report different flair\.Instance ids/);
    await expect(establishRestorePair(remote(second, a), admin)).rejects.toThrow(/report different flair\.Instance ids/);
    await establishRestorePair(remote(second, second), admin);
  }, 300_000);
});
