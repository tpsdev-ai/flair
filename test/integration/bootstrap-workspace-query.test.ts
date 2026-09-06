import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import nacl from "tweetnacl";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";

const root = process.cwd();
const now = Date.now();
const daysAgo = (days: number) => new Date(now - days * 86400_000).toISOString();
let harper: HarperInstance;
let appDir: string;
const workspace = (id: string, agentId: string, days: number, entities?: string[] | null) => ({
  id, agentId, timestamp: daysAgo(days), createdAt: daysAgo(days), ref: id, provider: "test", entities,
});
async function insert(table: string, records: Record<string, unknown>[]) {
  const response = await fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Basic ${btoa(`${harper.admin.username}:${harper.admin.password}`)}` },
    body: JSON.stringify({ operation: "insert", database: "flair", table, records }),
  });
  expect(response.status, await response.text()).toBe(200);
}
interface Probe {
  result: { context: string; tokenEstimate: number; sections: { collision: number } };
  queries: { rows: number; bytes: number; query: { conditions: { attribute: string; comparator: string; value: unknown }[] }; plan: unknown }[];
}
async function probe(agentId: string, legacy = false, options: Record<string, unknown> = {}): Promise<Probe> {
  const response = await fetch(`${harper.httpURL}/BootstrapWorkspaceProbe`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Basic ${btoa(`${harper.admin.username}:${harper.admin.password}`)}` },
    body: JSON.stringify({ agentId, legacy, options: { maxTokens: 4000, maxEvents: 0, ...options } }),
  });
  expect(response.status).toBe(200);
  return response.json() as Promise<Probe>;
}
beforeAll(async () => {
  if (process.env.HARPER_HTTP_URL) throw new Error("bootstrap-workspace-query requires an isolated Harper instance; unset HARPER_HTTP_URL");
  appDir = await mkdtemp(join(tmpdir(), "flair-workspace-query-app-"));
  await cp(join(root, "test/fixtures/bootstrap-events-app"), appDir, { recursive: true });
  await mkdir(join(appDir, "node_modules/@tpsdev-ai"), { recursive: true });
  await symlink(root, join(appDir, "node_modules/@tpsdev-ai/flair"), "dir");
  harper = await startHarper({ cwd: appDir, harperBinDir: root });
  await insert("Agent", ["workspace-reader", "older-reader", "empty-reader", "missing-reader", "teammate"].map(id => ({ id, name: id, role: "agent", publicKey: Buffer.from(nacl.sign.keyPair().publicKey).toString("base64"), createdAt: daysAgo(0) })));
  await insert("Presence", [{ agentId: "teammate", lastHeartbeatAt: now, activityUpdatedAt: now, activity: "coding" }]);
  await insert("WorkspaceState", [
    workspace("recent-empty", "workspace-reader", 0, []),
    workspace("recent-null", "workspace-reader", 0.1, null),
    workspace("recent-missing", "workspace-reader", 0.2),
    workspace("recent-tie-z", "workspace-reader", 1, ["subsystem:other"]),
    workspace("recent-tie-a", "workspace-reader", 1, ["subsystem:chosen"]),
    workspace("recent-older", "workspace-reader", 2, ["subsystem:other"]),
    workspace("old-empty", "older-reader", 0, []),
    workspace("old-valid", "older-reader", 10, ["subsystem:chosen"]),
    workspace("old-older", "older-reader", 20, ["subsystem:other"]),
    workspace("empty-recent", "empty-reader", 1, []),
    workspace("empty-old", "empty-reader", 10, null),
    { ...workspace("teammate-ws", "teammate", 0, ["subsystem:chosen"]), summary: "chosen collision marker" },
  ]);
}, 120_000);
afterAll(async () => {
  if (harper) await stopHarper(harper);
  if (appDir) await rm(appDir, { recursive: true, force: true });
});

describe("bootstrap workspace window", () => {
  test("preserves latest nonempty entities, ties, old-only fallback and empty history", async () => {
    for (const agentId of ["workspace-reader", "older-reader", "empty-reader", "missing-reader"]) {
      const legacy = await probe(agentId, true);
      const indexed = await probe(agentId);
      expect(indexed.result).toEqual(legacy.result);
      const hasEntities = agentId === "workspace-reader" || agentId === "older-reader";
      expect(indexed.result.sections.collision).toBe(hasEntities ? 1 : 0);
      if (hasEntities) expect(indexed.result.context).toContain("chosen collision marker");
      expect(indexed.queries).toHaveLength(agentId === "workspace-reader" ? 1 : 2);
      if (agentId === "older-reader") expect(indexed.queries.map(query => query.rows)).toEqual([1, 2]);
    }
  });
  test("explicit entities bypass the fallback; invalid entities still use workspace history", async () => {
    const explicit = await probe("workspace-reader", false, { entities: ["subsystem:chosen"] });
    expect(explicit.queries).toHaveLength(0);
    expect(explicit.result.sections.collision).toBe(1);
    const invalid = await probe("workspace-reader", false, { entities: ["invalid"] });
    expect(invalid.queries).toHaveLength(1);
    expect(invalid.result.sections.collision).toBe(1);
  });
  test("older history does not increase materialized rows for callers with recent entities", async () => {
    const observations = [];
    for (const size of [1000, 4000]) {
      for (let i = size === 1000 ? 0 : 1000; i < size; i += 500) {
        await insert("WorkspaceState", Array.from({ length: 500 }, (_, j) =>
          workspace(`history-${i + j}`, "workspace-reader", 30 + i + j, ["subsystem:other"])));
      }
      const legacy = await probe("workspace-reader", true);
      const indexed = await probe("workspace-reader");
      expect(indexed.result).toEqual(legacy.result);
      expect(indexed.queries).toHaveLength(1);
      expect(indexed.queries[0].rows).toBe(6);
      expect(legacy.queries[0].rows).toBe(size + 6);
      observations.push({ history: size, rows: indexed.queries[0].rows, legacyRows: legacy.queries[0].rows, plan: indexed.queries[0].plan });
    }
    console.log("Bootstrap workspace materialization:", JSON.stringify(observations));
  }, 120_000);
});
