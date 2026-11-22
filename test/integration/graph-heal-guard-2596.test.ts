import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  startHarper, stopHarper, type HarperInstance,
  HARPER_START_BUDGET_MS, HARPER_STOP_BUDGET_MS,
} from "../helpers/harper-lifecycle";
import { defaultStatePath, readMigrationState } from "../../resources/migrations/state.ts";
import { componentWithoutMigrationBoot } from "../helpers/component-without-migration-boot.ts";

let harper: HarperInstance | undefined;
let appDir: string | undefined;
let dataDir: string;
const root = process.cwd();
const ROWS = ["guard-current", "guard-foreign"];
const FOREIGN = "other-engine:not-the-current-space";

async function post(endpoint: string, body: unknown, operations = false): Promise<any> {
  const h = harper!;
  const response = await fetch(operations ? h.opsURL : `${h.httpURL}/${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${btoa(`${h.admin.username}:${h.admin.password}`)}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  expect(response.status, text).toBe(200);
  return JSON.parse(text);
}

beforeAll(async () => {
  if (process.env.HARPER_HTTP_URL) throw new Error("graph-heal guard requires an isolated Harper instance");
  appDir = componentWithoutMigrationBoot({ sourceRoot: root }).dir;
  dataDir = join(appDir, "runner-data");
  await mkdir(dataDir);
  const source = await readFile(join(root, "test/fixtures/graph-heal-guard-probe.ts"), "utf8");
  const probe = new Bun.Transpiler({ loader: "ts", target: "node" }).transformSync(source);
  await writeFile(join(appDir, "dist/resources/GraphHealGuardProbe.js"),
    probe.replaceAll('"../../resources/', '"./'));
  harper = await startHarper({
    cwd: appDir, harperBinDir: root,
    serverEnv: { FLAIR_GRAPH_HEAL_TEST_DATA_DIR: dataDir },
  });
  expect(harper.external).toBe(false);
  expect(harper.ownsInstallDir).toBe(true);
}, HARPER_START_BUDGET_MS);

afterAll(async () => {
  try {
    if (harper) await stopHarper(harper);
  } finally {
    if (appDir) await rm(appDir, { recursive: true, force: true });
  }
}, HARPER_STOP_BUDGET_MS);

test("mixed stamps refuse graph-heal without a success marker; repaired stamps allow the same runner state to complete", async () => {
  const { modelId } = await post("GraphHealGuardProbe", { action: "verify" });
  expect(typeof modelId).toBe("string");
  const records = ROWS.map((id, i) => ({
    id, agentId: "graph-heal-guard-agent", content: `graph-heal guard ${id}`,
    createdAt: new Date().toISOString(),
    embedding: i === 0 ? [1, 0, 0, 0] : [0, 1, 0, 0],
    embeddingModel: i === 0 ? modelId : FOREIGN,
  }));
  await post("", {
    operation: "insert", database: "flair", table: "Memory", records,
  }, true);
  expect((await post("GraphHealGuardProbe", { action: "verify" })).guard.state).toBe("mixed");

  const statePath = defaultStatePath(dataDir);
  for (let attempt = 0; attempt < 2; attempt++) {
    expect(await post("GraphHealGuardProbe", { action: "cycle" }))
      .toEqual({ ran: false, reason: "nothing pending" });
    expect(readMigrationState(statePath)["graph-heal"]).toBeUndefined();
    expect(existsSync(statePath)).toBe(false);
  }

  await post("", {
    operation: "update", database: "flair", table: "Memory",
    records: [{ ...records[1], embeddingModel: modelId }],
  }, true);
  expect((await post("GraphHealGuardProbe", { action: "verify" })).guard.state).toBe("uniform");
  const deadline = Date.now() + 30_000;
  let result;
  do {
    result = await post("GraphHealGuardProbe", { action: "cycle" });
    if (result.ran) break;
    await Bun.sleep(100);
  } while (Date.now() < deadline);
  expect(result).toEqual({ ran: true });
  expect(readMigrationState(statePath)["graph-heal"]).toMatchObject({
    lastOutcome: "success", completedAtVersion: "graph-heal-guard-test",
  });
  expect(existsSync(statePath)).toBe(true);
}, 120_000);
