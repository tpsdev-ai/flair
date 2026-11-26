/**
 * reembed-command-paging-3086.test.ts — `flair reembed --stale-only` through the
 * real CLI and a real ephemeral Harper, on both administrator paths
 * (flair#3086).
 *
 * Memory is seeded with 2,004 rows in one operations insert: 2,000 already
 * current rows for the tested agent, 3 stale rows for it whose ids sort last
 * (page 3 of 3), and 1 stale row for a second agent. The CLI runs against the
 * instance's real HTTP and ops ports and loads a preload that records every
 * fetch, so the test can assert each operations read body (conditions, sort,
 * projection, page limit, cursor), the printed read and skipped counts, that
 * the stale rows are re-embedded, that the second agent's stale row is
 * re-embedded on the all-agent run and untouched on the single-agent run, and
 * that all three operations page reads arrive before the first Memory PATCH.
 *
 * Throwaway HOME + data dir, ephemeral ports; the administrator password is
 * never printed. Each request target is asserted to be this test's instance.
 * The instance runs without the boot migration trigger, so the embedding-stamp
 * migration cannot re-embed the seeded stale rows during the test.
 */
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nacl from "tweetnacl";
import { startHarper, stopHarper, type HarperInstance, HARPER_STOP_BUDGET_MS } from "../helpers/harper-lifecycle";
import { componentWithoutMigrationBoot, type ComposedComponent } from "../helpers/component-without-migration-boot";
import { ensureCliBuild, spawnCli } from "../helpers/build-cli-once";
import { getModelId } from "../../resources/embeddings-provider.ts";

const CURRENT_MODEL_ID = getModelId();
const AGENT_ID = "p6-agent-a";
const OTHER_AGENT_ID = "p6-agent-b";
const TOTAL_ROWS = 2_003;
const ALL_ROWS = TOTAL_ROWS + 1;
const STALE_IDS = ["p6-z-0001", "p6-z-0002", "p6-z-0003"];
const OTHER_STALE_ID = "p6-b-0001";
const PAGE_SIZE = 1_000;
const PAGES = 3;
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

function memoryRow(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    agentId: AGENT_ID,
    content: `Release checklist ${id}: verify the tarball checksum before tagging.`,
    createdAt: "2021-03-01T00:00:00.000Z",
    updatedAt: "2021-03-02T00:00:00.000Z",
    embeddingModel: CURRENT_MODEL_ID,
    ...overrides,
  };
}
const staleRow = (id: string) => memoryRow(id, {
  embeddingModel: "old-model",
  // The all-agent read must not filter on createdAt: this row predates 1970.
  createdAt: id === STALE_IDS[STALE_IDS.length - 1] ? "1960-01-01T00:00:00Z" : "2021-03-01T00:00:00.000Z",
});

const otherStaleRow = () => memoryRow(OTHER_STALE_ID, {
  agentId: OTHER_AGENT_ID,
  embeddingModel: "old-model",
});

async function storedStamp(id: string): Promise<unknown> {
  const rows = await op({ operation: "search_by_id", database: "flair", table: "Memory", ids: [id], get_attributes: ["id", "embeddingModel"] });
  return rows[0]?.embeddingModel;
}

async function resetStaleRows(): Promise<void> {
  await op({
    operation: "upsert",
    database: "flair",
    table: "Memory",
    records: [...STALE_IDS.map(staleRow), otherStaleRow()],
  });
}

type Recorded = {
  seq: number;
  kind: "read" | "write" | "other";
  method: string;
  url: string;
  request: unknown;
  response: unknown;
};
const events: Recorded[] = [];
const PRELOAD = join(import.meta.dirname, "..", "helpers", "reembed-fault-preload.ts");

beforeAll(async () => {
  if (process.env.HARPER_HTTP_URL) throw new Error("requires an isolated Harper; unset HARPER_HTTP_URL");
  ensureCliBuild();
  home = mkdtempSync(join(tmpdir(), "flair-3086-cli-home-"));
  const keysDir = join(home, ".flair", "keys");
  mkdirSync(keysDir, { recursive: true });
  writeFileSync(join(keysDir, `${AGENT_ID}.key`), agent.secretKey.slice(0, 32), { mode: 0o600 });
  component = componentWithoutMigrationBoot();
  harper = await startHarper({ cwd: component.dir, harperBinDir: component.sourceRoot });
  for (const url of [new URL(harper.httpURL), new URL(harper.opsURL)]) {
    expect(url.hostname).toBe("127.0.0.1");
    expect(["9925", "9926"]).not.toContain(url.port);
  }
  // This fixture records the instance's port pair in config so the all-agent
  // run addresses this instance.
  writeFileSync(
    join(home, ".flair", "config.yaml"),
    `port: ${new URL(harper.httpURL).port}\nopsPort: ${new URL(harper.opsURL).port}\n`,
  );
  await op({
    operation: "upsert",
    database: "flair",
    table: "Agent",
    records: [{ id: AGENT_ID, name: AGENT_ID, role: "agent", publicKey: Buffer.from(agent.publicKey).toString("base64"), createdAt: new Date().toISOString() }],
  });
  const rows = [
    ...Array.from({ length: TOTAL_ROWS - STALE_IDS.length }, (_, i) => memoryRow(`p6-a-${String(i + 1).padStart(4, "0")}`)),
    ...STALE_IDS.map(staleRow),
    otherStaleRow(),
  ];
  expect(rows).toHaveLength(ALL_ROWS);
  await op({ operation: "insert", database: "flair", table: "Memory", records: rows });
}, 240_000);

afterAll(async () => {
  if (harper) await stopHarper(harper);
  component?.cleanup();
  if (home) rmSync(home, { recursive: true, force: true });
}, HARPER_STOP_BUDGET_MS);

afterEach(() => {
  events.length = 0;
});

const eventsFile = () => join(home, "fetch-events.jsonl");

async function runReembed(agentId?: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  events.length = 0;
  await resetStaleRows();
  writeFileSync(eventsFile(), "");
  const args = ["reembed", "--stale-only", "--port", new URL(harper.httpURL).port];
  if (agentId) args.push("--agent", agentId);
  const env = {
    ...process.env,
    HOME: home,
    FLAIR_OPS_PORT: new URL(harper.opsURL).port,
    FLAIR_ADMIN_USER: harper.admin.username,
    FLAIR_ADMIN_PASS: harper.admin.password,
    FLAIR_TEST_FETCH_EVENTS: eventsFile(),
    NO_COLOR: "1",
  };
  const child = spawnCli(args, { env, timeout: 180_000, preload: PRELOAD });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (exitCode) => resolve(exitCode));
  });
  const recorded = readFileSync(eventsFile(), "utf-8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { seq: number; method: string; path: string; request: unknown; response: unknown });
  events.push(...recorded.map((entry): Recorded => ({
    seq: entry.seq,
    kind: (entry.request as { operation?: unknown } | null)?.operation === "search_by_conditions"
      ? "read"
      : entry.method === "PATCH" && entry.path.startsWith("/Memory/")
        ? "write"
        : "other",
    method: entry.method,
    url: entry.path,
    request: entry.request,
    response: entry.response,
  })));
  return { code, stdout, stderr };
}

function assertReadsBeforeFirstPatch(reads: number): void {
  const readEvents = events.filter((event) => event.kind === "read");
  const writeEvents = events.filter((event) => event.kind === "write");
  expect(readEvents).toHaveLength(reads);
  expect(writeEvents.length).toBeGreaterThan(0);
  const firstWrite = Math.min(...writeEvents.map((event) => event.seq));
  expect(Math.max(...readEvents.map((event) => event.seq))).toBeLessThan(firstWrite);
}

function pageIds(response: unknown): string[] {
  const rows = Array.isArray(response) ? response : (response as { results?: unknown } | null)?.results;
  expect(Array.isArray(rows)).toBe(true);
  return (rows as Record<string, unknown>[]).map((row) => String(row.id));
}

/** Every page read carries the projection, sort and limit, and its conditions. */
function assertReadBodies(agentId: string | undefined): void {
  const reads = events.filter((event) => event.kind === "read");
  expect(reads).toHaveLength(PAGES);
  for (const [index, event] of reads.entries()) {
    const request = event.request as {
      conditions: { search_attribute: string; search_type: string; search_value: unknown }[];
      sort?: unknown;
      get_attributes?: unknown;
      limit?: unknown;
    };
    expect(request.sort).toEqual({ attribute: "id" });
    expect(request.get_attributes).toEqual(["id", "agentId", "content", "embeddingModel"]);
    expect(request.limit).toBe(PAGE_SIZE);
    const idConditions = request.conditions.filter((condition) => condition.search_attribute === "id");
    const agentConditions = request.conditions.filter((condition) => condition.search_attribute === "agentId");
    expect(request.conditions).toHaveLength(idConditions.length + agentConditions.length);
    if (agentId) {
      expect(agentConditions).toEqual([{ search_attribute: "agentId", search_type: "equals", search_value: agentId }]);
    } else {
      expect(agentConditions).toEqual([]);
    }
    const base = { search_attribute: "id", search_type: "greater_than", search_value: 0 };
    if (index === 0) {
      expect(idConditions).toEqual(agentId ? [] : [base]);
    } else {
      const previousIds = pageIds(reads[index - 1].response);
      const cursor = {
        search_attribute: "id",
        search_type: "greater_than",
        search_value: previousIds[previousIds.length - 1],
      };
      expect(idConditions).toEqual(agentId ? [cursor] : [base, cursor]);
    }
  }
}

for (const path of [{ name: "all-agent", agentId: undefined }, { name: "single-agent with an admin password", agentId: AGENT_ID }]) {
  test(`the ${path.name} path reads its rows in 3 pages and re-embeds its stale rows`, async () => {
    const { code, stdout, stderr } = await runReembed(path.agentId);
    // The all-agent run sends each PATCH with the administrator credential it
    // listed rows with, so this HOME's single key does not matter.
    expect(code, stderr.slice(0, 800)).toBe(0);
    assertReadsBeforeFirstPatch(PAGES);
    assertReadBodies(path.agentId);
    const readRows = path.agentId ? TOTAL_ROWS : ALL_ROWS;
    expect(stdout).toContain(`Read ${readRows} memories in ${PAGES} page(s)`);
    if (path.agentId) {
      expect(stdout).toContain(`Candidates for re-embedding: ${STALE_IDS.length}`);
      expect(stdout).toContain(`Skipped (up-to-date): ${TOTAL_ROWS - STALE_IDS.length}`);
    } else {
      expect(stdout).toContain(`Memories to re-embed: ${STALE_IDS.length}`);
      expect(stdout).not.toContain("Candidates for re-embedding");
    }
    for (const id of STALE_IDS) expect(await storedStamp(id)).toBe(CURRENT_MODEL_ID);
    expect(await storedStamp(OTHER_STALE_ID)).toBe(path.agentId ? "old-model" : CURRENT_MODEL_ID);
  }, 300_000);
}
