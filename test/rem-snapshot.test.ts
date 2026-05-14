/**
 * rem-snapshot.test.ts — Unit tests for src/rem/snapshot.ts.
 *
 * Pure filesystem coverage. No Harper required. Tests:
 *   - Round-trip: create → extract → byte-identical memory rows
 *   - listSnapshots: ordering + agent filter + missing root
 *   - Validation: invalid agent ids rejected
 *   - Dry-run extract: lists without writing
 *   - Refuse-overwrite: existing target dir rejected
 *   - Empty memories: single newline-free archive
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, readFileSync, writeFileSync, statSync, existsSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createSnapshot, listSnapshots, extractSnapshot, remSnapshotDir, type CreateOpts } from "../src/rem/snapshot.ts";

let testRoot: string;

beforeEach(() => {
  testRoot = mkdtempSync(join(tmpdir(), "flair-rem-snapshot-test-"));
});

afterEach(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

const sampleMemories = [
  { id: "m1", agentId: "test-agent", content: "first memory", durability: "persistent" },
  { id: "m2", agentId: "test-agent", content: "second memory", tags: ["a", "b"] },
];
const sampleSoul = { id: "soul-test-agent", agentId: "test-agent", instructions: "be helpful" };

function baseOpts(overrides: Partial<CreateOpts> = {}): CreateOpts {
  return {
    agentId: "test-agent",
    flairVersion: "0.0.0-test",
    memories: sampleMemories,
    soul: sampleSoul,
    pendingCandidateCount: 3,
    rootOverride: testRoot,
    ...overrides,
  };
}

describe("createSnapshot", () => {
  it("produces a tar.gz at the agent-rooted path with 600 perms", async () => {
    const r = await createSnapshot(baseOpts());
    expect(existsSync(r.path)).toBe(true);
    expect(r.path).toContain(join(testRoot, "test-agent"));
    expect(r.path.endsWith(".tar.gz")).toBe(true);
    // 0o600 = owner rw only (octal 100600 with file-type bits)
    expect(statSync(r.path).mode & 0o777).toBe(0o600);
    expect(r.size).toBeGreaterThan(0);
  });

  it("embeds metadata reflecting inputs", async () => {
    const r = await createSnapshot(baseOpts({
      runId: "explicit-run",
      flairVersion: "1.2.3",
    }));
    expect(r.meta.agentId).toBe("test-agent");
    expect(r.meta.runId).toBe("explicit-run");
    expect(r.meta.flairVersion).toBe("1.2.3");
    expect(r.meta.memoryCount).toBe(2);
    expect(r.meta.pendingCandidateCount).toBe(3);
    expect(r.meta.soulPresent).toBe(true);
  });

  it("records soulPresent=false when soul is null", async () => {
    const r = await createSnapshot(baseOpts({ soul: null }));
    expect(r.meta.soulPresent).toBe(false);
  });

  it("handles empty memories without crashing", async () => {
    const r = await createSnapshot(baseOpts({ memories: [] }));
    expect(r.meta.memoryCount).toBe(0);
    expect(existsSync(r.path)).toBe(true);
  });

  it("rejects invalid agent ids", async () => {
    await expect(createSnapshot(baseOpts({ agentId: "../etc/passwd" }))).rejects.toThrow(/invalid agent id/);
    await expect(createSnapshot(baseOpts({ agentId: "with space" }))).rejects.toThrow(/invalid agent id/);
    await expect(createSnapshot(baseOpts({ agentId: "" }))).rejects.toThrow(/invalid agent id/);
  });

  it("derives default runId from the timestamp", async () => {
    const now = new Date("2026-05-14T03:00:00.000Z");
    const r = await createSnapshot(baseOpts({ nowOverride: now }));
    expect(r.meta.runId).toMatch(/^rem-nightly-2026-05-14T03-00-00-000Z$/);
  });
});

describe("round-trip create → extract", () => {
  it("preserves byte-identical memory rows", async () => {
    const created = await createSnapshot(baseOpts());

    const restoreDir = join(testRoot, "restored");
    const ex = await extractSnapshot({ snapshotPath: created.path, targetDir: restoreDir });
    expect(ex.targetDir).toBe(restoreDir);
    expect(ex.entries.map((e) => e.path).sort()).toEqual(["memories.jsonl", "metadata.json", "soul.json"]);

    const memoriesText = readFileSync(join(restoreDir, "memories.jsonl"), "utf-8");
    const parsedLines = memoriesText.trim().split("\n").map((l) => JSON.parse(l));
    expect(parsedLines).toEqual(sampleMemories);

    const soulText = readFileSync(join(restoreDir, "soul.json"), "utf-8");
    expect(JSON.parse(soulText)).toEqual(sampleSoul);

    const metaText = readFileSync(join(restoreDir, "metadata.json"), "utf-8");
    expect(JSON.parse(metaText)).toEqual(created.meta);
  });

  it("dry-run lists entries without writing", async () => {
    const created = await createSnapshot(baseOpts());
    const ex = await extractSnapshot({ snapshotPath: created.path, dryRun: true });
    expect(ex.targetDir).toBeUndefined();
    expect(ex.entries.length).toBe(3);

    const sidecar = `${created.path}.restored`;
    expect(existsSync(sidecar)).toBe(false);
  });

  it("refuses to overwrite an existing target directory", async () => {
    const created = await createSnapshot(baseOpts());
    const target = join(testRoot, "preexisting");
    mkdirSync(target, { recursive: true });
    await expect(extractSnapshot({ snapshotPath: created.path, targetDir: target })).rejects.toThrow(/already exists/);
  });

  it("rejects extraction when the tarball doesn't exist", async () => {
    await expect(extractSnapshot({ snapshotPath: join(testRoot, "ghost.tar.gz") })).rejects.toThrow(/does not exist/);
  });
});

describe("listSnapshots", () => {
  it("returns an empty array when the root is missing", () => {
    const ghostRoot = join(testRoot, "ghost");
    expect(listSnapshots(undefined, ghostRoot)).toEqual([]);
  });

  it("returns snapshots sorted by mtime descending", async () => {
    const fsMod = require("node:fs") as typeof import("node:fs");
    const first = await createSnapshot(baseOpts({ nowOverride: new Date(Date.now() - 60_000) }));
    const second = await createSnapshot(baseOpts({ nowOverride: new Date() }));

    // Force deterministic mtimes — fs writes both files within the same
    // millisecond on fast machines, which would make the sort flaky.
    const nowSec = Math.floor(Date.now() / 1000);
    fsMod.utimesSync(first.path, nowSec - 60, nowSec - 60);
    fsMod.utimesSync(second.path, nowSec, nowSec);

    const rows = listSnapshots(undefined, testRoot);
    expect(rows.length).toBe(2);
    expect(rows[0].path).toBe(second.path);
    expect(rows[1].path).toBe(first.path);
    expect(rows[0].size).toBeGreaterThan(0);
  });

  it("respects the agent filter", async () => {
    await createSnapshot(baseOpts({ agentId: "agent-a" }));
    await createSnapshot(baseOpts({ agentId: "agent-b" }));
    const rows = listSnapshots("agent-a", testRoot);
    expect(rows.length).toBe(1);
    expect(rows[0].agent).toBe("agent-a");
  });

  it("rejects an invalid agent filter", () => {
    expect(() => listSnapshots("../escape", testRoot)).toThrow(/invalid agent id/);
  });

  it("ignores non-tar.gz files in the agent directory", async () => {
    await createSnapshot(baseOpts());
    const dir = join(testRoot, "test-agent");
    writeFileSync(join(dir, "stray-note.txt"), "ignore me");
    const rows = listSnapshots("test-agent", testRoot);
    expect(rows.length).toBe(1);
    expect(rows[0].file.endsWith(".tar.gz")).toBe(true);
  });
});

describe("remSnapshotDir", () => {
  it("rejects invalid agent ids", () => {
    expect(() => remSnapshotDir("../etc")).toThrow(/invalid agent id/);
    expect(() => remSnapshotDir("a/b")).toThrow(/invalid agent id/);
    expect(() => remSnapshotDir("")).toThrow(/invalid agent id/);
  });
});
