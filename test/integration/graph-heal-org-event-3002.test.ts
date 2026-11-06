// ─── flair#3002 — the graph-heal OrgEvent writer on its real table ──────────
//
// The graph-heal migration's ledger event is validated with the OrgEvent
// table's own validator before staging. This test runs the migration's own
// `run()` inside a real Harper (test/fixtures/org-event-write-fault-3002's
// probe resource) against the real OrgEvent table: a valid observation stores
// an event, and an injected invalid row is refused before the staging call.
// The migration catches a ledger-write failure by design, so the invalid case
// resolves with no processed rows and leaves no event.
//
// The staging call is observed through a wrapper on the OrgEvent table's put;
// it appends every row handed to staging to a file under ROOTPATH.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { startHarper, stopHarper, type HarperInstance, HARPER_STOP_BUDGET_MS } from "../helpers/harper-lifecycle";
import { componentWithReplayProbe, type ProbeComponent, type ProbeFiles } from "../helpers/component-with-replay-probe";
import { getModelId } from "../../resources/embeddings-provider.ts";

const FAULT_PROBE: ProbeFiles = {
  source: join("test", "fixtures", "org-event-write-fault-3002", "probe.js"),
  target: join("dist", "resources", "zz-org-event-write-fault-3002.js"),
  out: "org-event-write-fault-3002", // unused by the composer; the probe writes staged.jsonl under ROOTPATH
};

const sfx = Date.now().toString(36);
const ROW_ID = `graph-heal-event-${sfx}`;
const AGENT_ID = "graph-heal-event-agent";
const VECTOR = Array.from({ length: 48 }, (_, i) => (i === 0 ? 1 : 0));

let harper: HarperInstance;
let installDir = "";
let composed: ProbeComponent | undefined;

const basicAuth = () => "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`);

async function ops(operation: Record<string, unknown>): Promise<any> {
  const res = await fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: basicAuth() },
    body: JSON.stringify(operation),
  });
  const text = await res.text();
  expect(res.status, `${operation.operation}: ${text.slice(0, 300)}`).toBe(200);
  return JSON.parse(text);
}

async function graphHeal(corrupt: boolean): Promise<{ status: number; body: any; text: string }> {
  const res = await fetch(`${harper.httpURL}/OrgEventWriteProbe`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: basicAuth() },
    body: JSON.stringify({ action: "graph-heal", corrupt }),
  });
  const text = await res.text();
  return { status: res.status, body: res.status === 200 ? JSON.parse(text) : null, text };
}

async function resetStaged(): Promise<void> {
  const res = await fetch(`${harper.httpURL}/OrgEventWriteProbe`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: basicAuth() },
    body: JSON.stringify({ action: "reset" }),
  });
  expect(res.status, await res.text()).toBe(200);
}

async function staged(): Promise<any[]> {
  const res = await fetch(`${harper.httpURL}/OrgEventWriteProbe`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: basicAuth() },
    body: JSON.stringify({ action: "staged" }),
  });
  const text = await res.text();
  expect(res.status, text).toBe(200);
  return JSON.parse(text).staged;
}

async function eventsByRef(): Promise<any[]> {
  return ops({
    operation: "search_by_value", database: "flair", table: "OrgEvent",
    search_attribute: "refId", search_value: "graph-heal",
    get_attributes: ["id", "refId", "kind", "summary", "detail"],
  });
}

beforeAll(async () => {
  if (process.env.HARPER_HTTP_URL) throw new Error("requires an isolated Harper; unset HARPER_HTTP_URL");
  composed = componentWithReplayProbe({ probe: FAULT_PROBE });
  harper = await startHarper({ cwd: composed.dir, harperBinDir: composed.sourceRoot });
  installDir = harper.installDir;
  for (const url of [harper.httpURL, harper.opsURL]) {
    const u = new URL(url);
    expect(["127.0.0.1", "localhost"], url).toContain(u.hostname);
    expect(["9925", "9926"], `${url} must be this test's own Harper`).not.toContain(u.port);
  }
  await ops({
    operation: "insert", database: "flair", table: "Memory",
    records: [{
      id: ROW_ID,
      agentId: AGENT_ID,
      content: "graph-heal event test row",
      embedding: VECTOR,
      embeddingModel: getModelId(),
      createdAt: new Date().toISOString(),
    }],
  });
}, 240_000);

afterAll(async () => {
  if (harper) await stopHarper(harper);
  if (installDir) await rm(installDir, { recursive: true, force: true, maxRetries: 4 });
  composed?.cleanup();
}, HARPER_STOP_BUDGET_MS);

describe("flair#3002 — the graph-heal event writer against the real OrgEvent table", () => {
  test("a valid heal observation stores an accepted event", async () => {
    await resetStaged();
    const deadline = Date.now() + 90_000;
    let valid: { status: number; body: any; text: string } | undefined;
    while (Date.now() < deadline) {
      valid = await graphHeal(false);
      if (valid.status === 200) break;
      await Bun.sleep(1000);
    }
    expect(valid?.status, valid?.text).toBe(200);
    expect(valid!.body.result).toMatchObject({ processed: 0, touchedIds: [] });

    const stagedRows = valid!.body.staged as Array<{ id: string | null; refId: string | null; summaryType: string }>;
    expect(stagedRows, "the accepted row must reach staging").toHaveLength(1);
    expect(stagedRows[0].refId).toBe("graph-heal");
    expect(stagedRows[0].summaryType).toBe("string");

    const events = await eventsByRef();
    const accepted = events.find((row) => row.id === stagedRows[0].id);
    expect(accepted, "the staged row must be stored").toBeDefined();
    expect(accepted.kind).toBe("migration");
    expect(JSON.parse(accepted.detail).verified).toBe(true);
  }, 150_000);

  test("an invalid heal row is refused before staging; the heal swallows the failure", async () => {
    await resetStaged();
    const before = (await eventsByRef()).length;
    const bad = await graphHeal(true);
    expect(await staged(), "the invalid row must not reach staging").toHaveLength(0);
    expect(bad.status, bad.text).toBe(200);
    // The writer's catch swallows a ledger failure: run() still resolves.
    expect(bad.body.result).toMatchObject({ processed: 0, touchedIds: [] });
    expect(await eventsByRef(), "no event may be stored").toHaveLength(before);
  }, 150_000);
});
