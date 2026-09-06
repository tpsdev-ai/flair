import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";

const root = process.cwd();
// Keep startup/migration events outside the measured fixture window.
const since = "2100-08-01T00:00:00.000Z";
const time = (seconds: number) => new Date(Date.parse(since) + seconds * 1000).toISOString();
let harper: HarperInstance;
let appDir: string;

type Event = { id: string; kind: string; summary: string; createdAt: string; [key: string]: unknown };
const event = (id: string, seconds: number, extra: Record<string, unknown> = {}): Event => ({
  id, authorId: "event-writer", kind: "status", summary: id, createdAt: time(seconds), ...extra,
});
const active = [
  event("boundary", 0, { entities: ["project:" + "x".repeat(5000)] }),
  event("targeted", 1, { targetIds: ["event-reader"] }),
  event("empty-targets", 2, { targetIds: [] }),
  event("null-targets", 3, { targetIds: null }),
  event("dedup-old", 4, { summary: "same event", detail: "same detail", targetIds: ["event-reader", "other"] }),
  event("dedup-new", 5, { summary: "same event", detail: "same detail", targetIds: ["other", "event-reader"] }),
  event("different-detail", 6, { summary: "same event", detail: "different detail" }),
  event("tie-z", 7), event("tie-a", 7),
  event("filtered-target", 8, { targetIds: ["other"] }),
  event("filtered-expired", 9, { expiresAt: "2000-01-01T00:00:00.000Z" }),
  event("filtered-no-op", 10, { kind: "migration", detail: JSON.stringify({ outcome: "success", rowsProcessed: 0 }) }),
  event("oversized", 11, { summary: "large ".repeat(4000) }),
];

async function insert(records: Event[]) {
  const res = await fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Basic ${btoa(`${harper.admin.username}:${harper.admin.password}`)}` },
    body: JSON.stringify({ operation: "insert", database: "flair", table: "OrgEvent", records }),
  });
  expect(res.status, await res.text()).toBe(200);
}

interface Probe {
  result: { events: { id: string; detail?: string }[]; [key: string]: unknown };
  queries: { rows: number; bytes: number; query: { conditions?: unknown[]; select?: string[] }; plan: unknown }[];
  elapsedMs: number;
}
async function probe(legacy: boolean, options: Record<string, unknown> = {}): Promise<Probe> {
  const response = await fetch(`${harper.httpURL}/BootstrapEventProbe`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Basic ${btoa(`${harper.admin.username}:${harper.admin.password}`)}` },
    body: JSON.stringify({ legacy, options: { lastBootAt: since, maxTokens: 4000, maxEvents: 30, ...options } }),
  });
  expect(response.status).toBe(200);
  return response.json() as Promise<Probe>;
}

beforeAll(async () => {
  // This test installs a probe app and seeds its own table; external instances
  // cannot supply that app and must never receive the fixture writes.
  if (process.env.HARPER_HTTP_URL) throw new Error("bootstrap-event-query requires an isolated Harper instance; unset HARPER_HTTP_URL");
  appDir = await mkdtemp(join(tmpdir(), "flair-event-query-app-"));
  await cp(join(root, "test/fixtures/bootstrap-events-app"), appDir, { recursive: true });
  await mkdir(join(appDir, "node_modules/@tpsdev-ai"), { recursive: true });
  await symlink(root, join(appDir, "node_modules/@tpsdev-ai/flair"), "dir");
  harper = await startHarper({ cwd: appDir, harperBinDir: root });
  await insert(active);
}, 120_000);

afterAll(async () => {
  if (harper) await stopHarper(harper);
  if (appDir) await rm(appDir, { recursive: true, force: true });
});

describe("bootstrap event window pushdown", () => {
  test("matches the legacy arm through boundary, targeting, expiry, dedup and budget filtering", async () => {
    for (const options of [{}, { maxEvents: 3 }, { maxTokens: 300 }, { includeEventDetail: true }, { maxEvents: 0 }]) {
      const legacy = await probe(true, options);
      const indexed = await probe(false, options);
      expect(indexed.result.events).toEqual(legacy.result.events);
      expect(indexed.result.eventsHint).toEqual(legacy.result.eventsHint);
      expect(indexed.result.tokenEstimate).toEqual(legacy.result.tokenEstimate);
      expect(indexed.queries[0].bytes).toBeLessThan(legacy.queries[0].bytes);
    }
    const { result } = await probe(false);
    const ids = result.events.map(row => row.id);
    expect(ids).toContain("boundary");
    expect(ids).toContain("targeted");
    expect(ids).toContain("dedup-new");
    expect(ids).toContain("different-detail");
    for (const id of ["dedup-old", "filtered-target", "filtered-expired", "filtered-no-op", "oversized"]) expect(ids).not.toContain(id);
    expect(result.events.every(row => row.detail === undefined)).toBe(true);
    const detailed = await probe(false, { includeEventDetail: true });
    expect(detailed.result.events.find(row => row.id === "dedup-new")?.detail).toBe("same detail");
  });

  test("old history grows the legacy scan but not the indexed window", async () => {
    const observations: unknown[] = [];
    for (const size of [1000, 4000]) {
      const start = size === 1000 ? 0 : 1000;
      for (let i = start; i < size; i += 500) {
        await insert(Array.from({ length: Math.min(500, size - i) }, (_, offset) =>
          event(`old-${i + offset}`, -10 - i - offset, { entities: ["project:" + "x".repeat(1000)] })));
      }
      const legacy = await probe(true);
      const indexed = await probe(false);
      expect(indexed.result.events).toEqual(legacy.result.events);
      expect(indexed.queries).toHaveLength(1);
      expect(indexed.queries[0].rows).toBe(active.length);
      expect(legacy.queries[0].rows).toBeGreaterThanOrEqual(size + active.length);
      expect(indexed.queries[0].bytes).toBeLessThan(legacy.queries[0].bytes / 10);
      observations.push({ history: size, indexed: indexed.queries[0], legacyRows: legacy.queries[0].rows, indexedMs: indexed.elapsedMs, legacyMs: legacy.elapsedMs });
    }
    console.log("Bootstrap event-query measurements (elapsed diagnostic only):", JSON.stringify(observations));
  }, 120_000);
});
