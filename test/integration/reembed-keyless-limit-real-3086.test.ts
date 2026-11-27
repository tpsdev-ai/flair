/**
 * reembed-keyless-limit-real-3086.test.ts — the keyless single-agent listing of
 * `flair reembed`, through the real CLI and a real ephemeral Harper
 * (flair#3086).
 *
 * Without FLAIR_ADMIN_PASS and HDB_ADMIN_PASSWORD, `reembed --agent <id>` lists
 * memories with one signed `POST /SemanticSearch` that carries
 * `limit: KEYLESS_SEARCH_LIMIT` and no query. This file seeds 9,999, 10,000 and
 * 10,001 stale rows for one agent and runs `reembed --stale-only --dry-run`
 * against the real resource: 9,999 rows print no notice and exit 0; 10,000 and
 * 10,001 rows list 10,000 candidates, print one notice naming 10000 and
 * FLAIR_ADMIN_PASS, and exit 1.
 *
 * Throwaway HOME holding only the agent key, ephemeral ports asserted to be this
 * test's instance. The instance runs without the boot migration trigger.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nacl from "tweetnacl";
import { startHarper, stopHarper, type HarperInstance, HARPER_STOP_BUDGET_MS } from "../helpers/harper-lifecycle";
import { componentWithoutMigrationBoot, type ComposedComponent } from "../helpers/component-without-migration-boot";
import { ensureCliBuild, spawnCli } from "../helpers/build-cli-once";
import { KEYLESS_SEARCH_LIMIT } from "../../src/commands/reembed.ts";

const AGENT_ID = "p6k-agent-a";
const BASE_ROWS = KEYLESS_SEARCH_LIMIT - 1;
const SEED_BATCH = 2_000;
const NOTICE = "more rows may exist";
let component: ComposedComponent;
let harper: HarperInstance;
let home: string;

const agent = { id: AGENT_ID, ...nacl.sign.keyPair() };
const opsAuth = () => "Basic " + Buffer.from(`${harper.admin.username}:${harper.admin.password}`).toString("base64");

async function op(body: Record<string, unknown>): Promise<any> {
  const res = await fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: opsAuth() },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  expect(res.status, text.slice(0, 300)).toBe(200);
  return JSON.parse(text);
}

function memoryRow(n: number): Record<string, unknown> {
  return {
    id: `p6k-${String(n).padStart(5, "0")}`,
    agentId: AGENT_ID,
    content: `Release checklist ${n}: verify the tarball checksum before tagging.`,
    createdAt: "2021-03-01T00:00:00.000Z",
    updatedAt: "2021-03-02T00:00:00.000Z",
    embeddingModel: "old-model",
  };
}

/** Sets the agent's row count (BASE_ROWS to BASE_ROWS + 2): upserts the extra rows up to `count`, deletes the others, checks the count. */
async function setRowCount(count: number): Promise<void> {
  const extra = [BASE_ROWS + 1, BASE_ROWS + 2];
  const keep = extra.filter((n) => n <= count);
  const drop = extra.filter((n) => n > count);
  if (keep.length > 0) await op({ operation: "upsert", database: "flair", table: "Memory", records: keep.map(memoryRow) });
  if (drop.length > 0) await op({ operation: "delete", database: "flair", table: "Memory", ids: drop.map((n) => memoryRow(n).id) });
  const counted = await op({ operation: "sql", sql: `SELECT COUNT(*) AS c FROM flair.Memory WHERE agentId = '${AGENT_ID}'` });
  expect(counted[0]?.c).toBe(count);
}

beforeAll(async () => {
  if (process.env.HARPER_HTTP_URL) throw new Error("requires an isolated Harper; unset HARPER_HTTP_URL");
  ensureCliBuild();
  home = mkdtempSync(join(tmpdir(), "flair-3086-keyless-home-"));
  const keysDir = join(home, ".flair", "keys");
  mkdirSync(keysDir, { recursive: true });
  writeFileSync(join(keysDir, `${AGENT_ID}.key`), agent.secretKey.slice(0, 32), { mode: 0o600 });
  component = componentWithoutMigrationBoot();
  harper = await startHarper({ cwd: component.dir, harperBinDir: component.sourceRoot });
  for (const url of [new URL(harper.httpURL), new URL(harper.opsURL)]) {
    expect(url.hostname).toBe("127.0.0.1");
    expect(["9925", "9926"]).not.toContain(url.port);
  }
  await op({
    operation: "upsert",
    database: "flair",
    table: "Agent",
    records: [{ id: AGENT_ID, name: AGENT_ID, role: "agent", publicKey: Buffer.from(agent.publicKey).toString("base64"), createdAt: new Date().toISOString() }],
  });
  for (let start = 1; start <= BASE_ROWS; start += SEED_BATCH) {
    const end = Math.min(BASE_ROWS, start + SEED_BATCH - 1);
    const records = Array.from({ length: end - start + 1 }, (_, i) => memoryRow(start + i));
    await op({ operation: "insert", database: "flair", table: "Memory", records });
  }
}, 240_000);

afterAll(async () => {
  if (harper) await stopHarper(harper);
  component?.cleanup();
  if (home) rmSync(home, { recursive: true, force: true });
}, HARPER_STOP_BUDGET_MS);

async function runKeylessReembed(dryRun = true): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: home,
    FLAIR_OPS_PORT: new URL(harper.opsURL).port,
    NO_COLOR: "1",
  };
  delete env.FLAIR_ADMIN_PASS;
  delete env.HDB_ADMIN_PASSWORD;
  const args = ["reembed", "--agent", AGENT_ID, "--stale-only", ...(dryRun ? ["--dry-run"] : []), "--port", new URL(harper.httpURL).port];
  const child = spawnCli(args, { env, timeout: 180_000 });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (exitCode) => resolve(exitCode));
  });
  // The keyless path lists with /SemanticSearch; the operations path prints its page count.
  expect(stdout).not.toContain("page(s)");
  return { code, stdout, stderr };
}

test(`${BASE_ROWS} rows: no notice, exit 0`, async () => {
  await setRowCount(BASE_ROWS);
  const { code, stdout, stderr } = await runKeylessReembed();
  expect(code, stderr.slice(0, 800)).toBe(0);
  expect(stdout).toContain(`Candidates for re-embedding: ${BASE_ROWS}`);
  expect(stdout).not.toContain(NOTICE);
}, 240_000);

for (const count of [KEYLESS_SEARCH_LIMIT, KEYLESS_SEARCH_LIMIT + 1]) {
  test(`${count} rows: ${KEYLESS_SEARCH_LIMIT} candidates, one notice, exit 1`, async () => {
    await setRowCount(count);
    const { code, stdout, stderr } = await runKeylessReembed();
    expect(code, stderr.slice(0, 800)).toBe(1);
    expect(stdout).toContain(`Candidates for re-embedding: ${KEYLESS_SEARCH_LIMIT}`);
    const notices = stdout.split("\n").filter((line) => line.includes(NOTICE));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain(String(KEYLESS_SEARCH_LIMIT));
    expect(notices[0]).toContain("FLAIR_ADMIN_PASS");
  }, 240_000);
}


for (const owned of [false, true]) {
  test(`ckM2 capped ${owned ? "partly-owned" : "foreign"} listing omits success markers`, async () => {
    await op({ operation: "delete", database: "flair", table: "Memory", ids: [memoryRow(KEYLESS_SEARCH_LIMIT + 1).id] });
    for (let start = 1; start <= KEYLESS_SEARCH_LIMIT; start += SEED_BATCH) {
      const end = Math.min(KEYLESS_SEARCH_LIMIT, start + SEED_BATCH - 1);
      const records = Array.from({ length: end - start + 1 }, (_, i) => ({
        ...memoryRow(start + i),
        agentId: owned && start + i === 1 ? AGENT_ID : "p6k-other-owner",
        visibility: "public",
      }));
      await op({ operation: "upsert", database: "flair", table: "Memory", records });
    }
    const { code, stdout, stderr } = await runKeylessReembed(false);
    expect(code, stderr.slice(0, 800)).toBe(1);
    expect(stdout).toContain(`Candidates for re-embedding: ${owned ? 1 : 0}`);
    expect(stdout).toContain(`Read ${KEYLESS_SEARCH_LIMIT} memories`);
    expect(stdout).not.toContain("✅");
    if (owned) expect(stdout).toContain("1 updated, 0 errors");
  }, 240_000);
}
