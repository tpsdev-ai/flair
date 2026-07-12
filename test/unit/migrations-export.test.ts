/**
 * migrations-export.test.ts — resources/migrations/export.ts's content-only
 * logical export fallback (ladder step 4): SOURCE_FIELDS ONLY (+id), never
 * derived fields — proves the export is genuinely far smaller than a full
 * row dump would be, and never leaks embedding vectors.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createContentOnlyExport } from "../../resources/migrations/export.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "flair-migration-export-test-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("createContentOnlyExport", () => {
  it("exports only SOURCE_FIELDS (+id) — never embedding/embeddingModel/other derived fields", () => {
    const rows = [
      {
        id: "m1",
        content: "hello world",
        agentId: "a1",
        durability: "persistent",
        visibility: "private",
        tags: ["x"],
        createdAt: "2026-01-01T00:00:00.000Z",
        supersedes: null,
        // Derived fields that must NOT appear in the export:
        embedding: new Array(768).fill(0.123456),
        embeddingModel: "nomic-embed-text-v1.5-Q4_K_M",
        retrievalCount: 5,
        usageCount: 2,
        lastRetrieved: "2026-01-02T00:00:00.000Z",
        provenance: '{"v":1}',
        originatorInstanceId: "inst-abc",
      },
    ];

    const result = createContentOnlyExport(
      { migrationId: "m", table: "Memory", rows, fromVersion: "0.1.0" },
      { exportRoot: root, now: () => new Date() },
    );

    const body = readFileSync(result.path, "utf-8");
    const parsed = JSON.parse(body.trim());
    expect(parsed).toEqual({
      id: "m1",
      content: "hello world",
      agentId: "a1",
      durability: "persistent",
      visibility: "private",
      tags: ["x"],
      createdAt: "2026-01-01T00:00:00.000Z",
      supersedes: null,
    });
    expect(body).not.toContain("embedding");
    expect(body).not.toContain("retrievalCount");
    expect(body).not.toContain("provenance");
  });

  it("is meaningfully smaller than a naive full-row dump would be (the reason this fallback exists)", () => {
    const bigEmbedding = new Array(768).fill(0.987654321);
    const rows = Array.from({ length: 20 }, (_, i) => ({
      id: `m${i}`,
      content: `row ${i}`,
      agentId: "a1",
      embedding: bigEmbedding,
      embeddingModel: "nomic-embed-text-v1.5-Q4_K_M",
    }));

    const result = createContentOnlyExport(
      { migrationId: "m", table: "Memory", rows, fromVersion: "0.1.0" },
      { exportRoot: root, now: () => new Date() },
    );

    const naiveFullDumpBytes = Buffer.byteLength(rows.map((r) => JSON.stringify(r)).join("\n"));
    expect(result.bytes).toBeLessThan(naiveFullDumpBytes / 5);
  });

  it("writes 0700 dir + a manifest with the row count", () => {
    const rows = [{ id: "m1", content: "x", agentId: "a1" }];
    const result = createContentOnlyExport(
      { migrationId: "m", table: "Memory", rows, fromVersion: "0.1.0" },
      { exportRoot: root, now: () => new Date() },
    );
    expect(statSync(result.dir).mode & 0o777).toBe(0o700);
    expect(result.rowCount).toBe(1);
    const manifest = JSON.parse(readFileSync(join(result.dir, "manifest.json"), "utf-8"));
    expect(manifest.rowCount).toBe(1);
    expect(manifest.table).toBe("Memory");
  });

  it("handles zero rows without crashing (empty export)", () => {
    const result = createContentOnlyExport(
      { migrationId: "m", table: "Memory", rows: [], fromVersion: "0.1.0" },
      { exportRoot: root, now: () => new Date() },
    );
    expect(existsSync(result.path)).toBe(true);
    expect(result.rowCount).toBe(0);
  });

  it("Relationship table export uses Relationship SOURCE_FIELDS, not Memory's", () => {
    const rows = [
      {
        id: "r1",
        subject: "nathan",
        predicate: "manages",
        object: "project-x",
        agentId: "a1",
        validFrom: "2026-01-01",
        validTo: null,
        // Memory-only fields that must not leak through:
        content: "should not appear",
        embedding: [1, 2, 3],
      },
    ];
    const result = createContentOnlyExport(
      { migrationId: "m", table: "Relationship", rows, fromVersion: "0.1.0" },
      { exportRoot: root, now: () => new Date() },
    );
    const parsed = JSON.parse(readFileSync(result.path, "utf-8").trim());
    expect(parsed).toEqual({
      id: "r1",
      subject: "nathan",
      predicate: "manages",
      object: "project-x",
      agentId: "a1",
      validFrom: "2026-01-01",
      validTo: null,
    });
  });
});
