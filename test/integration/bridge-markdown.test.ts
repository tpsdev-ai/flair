/**
 * Integration test for markdown bridge.
 *
 * Tests:
 *   - Import with front-matter parses correctly
 *   - Import without front-matter uses defaults
 *   - Scalar tags string is converted to array
 *   - Array tags parsed correctly
 *   - Idempotent import (same memory IDs preserved on re-import)
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync, mkdirSync, writeFileSync, cpSync } from "node:fs";
import { runImport } from "../../src/bridges/runtime/import-runner.js";
import { BUILTIN_BY_NAME } from "../../src/bridges/builtins/index.js";
import { loadBridge } from "../../src/bridges/runtime/load-bridge.js";
import { makeContext } from "../../src/bridges/runtime/context.js";
import type { PutMemoryBody } from "../../src/bridges/runtime/import-runner.js";

// Test fixture directory
const FIXTURES_DIR = join(import.meta.dirname ?? ".", "fixtures", "markdown-bridge");

// In-memory sink for imported memories
interface ImportedMemory {
  body: PutMemoryBody;
  index: number;
}

describe("markdown bridge integration", () => {
  const importedMemories: ImportedMemory[] = [];
  let putCallIndex = 0;

  const putMemory = async (body: PutMemoryBody): Promise<void> => {
    importedMemories.push({ body, index: putCallIndex++ });
  };

  const ctx = makeContext({ bridge: "markdown" });

  // Clear imported memories before each test
  beforeEach(() => {
    importedMemories.length = 0;
    putCallIndex = 0;
  });

  test("imports markdown files with front-matter", async () => {
    const discovered = BUILTIN_BY_NAME.get("markdown")?.discovered;
    expect(discovered).toBeDefined();

    const loaded = await loadBridge(discovered!);
    expect(loaded.kind).toBe("code");

    const source = loaded.plugin.import!({ source: FIXTURES_DIR }, ctx);

    await runImport({
      bridgeName: "markdown",
      source,
      cwd: FIXTURES_DIR,
      agentId: "test-agent",
      putMemory,
      ctx,
    });

    expect(importedMemories.length).toBeGreaterThan(0);

    // Find the file with front-matter
    const withFm = importedMemories.find((m) =>
      m.body.content.includes("This is a markdown file with front-matter")
    );
    expect(withFm).toBeDefined();
    expect(withFm?.body.subject).toBe("Test Note With Frontmatter");
    expect(withFm?.body.type).toBe("memory"); // HTTP API type is always "memory"
    expect(withFm?.body.tags).toEqual(["test", "notes"]);
    expect(withFm?.body.createdAt).toBe("2025-01-15T10:00:00.000Z");
    expect(withFm?.body.content).toContain("This is a markdown file with front-matter");
    expect(withFm?.body.foreignId).toContain("with-frontmatter.md");
  });

  test("imports markdown files without front-matter using defaults", async () => {
    const discovered = BUILTIN_BY_NAME.get("markdown")?.discovered;
    expect(discovered).toBeDefined();

    const loaded = await loadBridge(discovered!);
    expect(loaded.kind).toBe("code");

    const source = loaded.plugin.import!({ source: FIXTURES_DIR }, ctx);

    await runImport({
      bridgeName: "markdown",
      source,
      cwd: FIXTURES_DIR,
      agentId: "test-agent",
      putMemory,
      ctx,
    });

    const withoutFm = importedMemories.find((m) =>
      m.body.content.includes("This is a markdown file WITHOUT front-matter")
    );
    expect(withoutFm).toBeDefined();
    expect(withoutFm?.body.subject).toBe("without-frontmatter");
    expect(withoutFm?.body.type).toBe("memory"); // HTTP API type is always "memory"
    expect(withoutFm?.body.tags).toBeUndefined();
    expect(withoutFm?.body.createdAt).toBeDefined();
    expect(withoutFm?.body.content).toContain("This is a markdown file WITHOUT front-matter");
  });

  test("imports scalar tags as single-element array", async () => {
    const discovered = BUILTIN_BY_NAME.get("markdown")?.discovered;
    expect(discovered).toBeDefined();

    const loaded = await loadBridge(discovered!);
    expect(loaded.kind).toBe("code");

    const source = loaded.plugin.import!({ source: FIXTURES_DIR }, ctx);

    await runImport({
      bridgeName: "markdown",
      source,
      cwd: FIXTURES_DIR,
      agentId: "test-agent",
      putMemory,
      ctx,
    });

    const scalarTags = importedMemories.find((m) =>
      m.body.content.includes("This file has scalar tags")
    );
    expect(scalarTags).toBeDefined();
    expect(scalarTags?.body.tags).toEqual(["single-tag"]);
  });

  test("imports array tags correctly", async () => {
    const discovered = BUILTIN_BY_NAME.get("markdown")?.discovered;
    expect(discovered).toBeDefined();

    const loaded = await loadBridge(discovered!);
    expect(loaded.kind).toBe("code");

    const source = loaded.plugin.import!({ source: FIXTURES_DIR }, ctx);

    await runImport({
      bridgeName: "markdown",
      source,
      cwd: FIXTURES_DIR,
      agentId: "test-agent",
      putMemory,
      ctx,
    });

    const arrayTags = importedMemories.find((m) =>
      m.body.content.includes("This file has array tags")
    );
    expect(arrayTags).toBeDefined();
    expect(arrayTags?.body.tags).toEqual(["tag1", "tag2", "tag3"]);
  });

  test("import is idempotent (same file produces same foreignId)", async () => {
    const discovered = BUILTIN_BY_NAME.get("markdown")?.discovered;
    expect(discovered).toBeDefined();

    const loaded = await loadBridge(discovered!);
    expect(loaded.kind).toBe("code");

    // First import
    const source1 = loaded.plugin.import!({ source: FIXTURES_DIR }, ctx);
    await runImport({
      bridgeName: "markdown",
      source: source1,
      cwd: FIXTURES_DIR,
      agentId: "test-agent",
      putMemory,
      ctx,
    });

    const firstImportForeignIds = importedMemories.map((m) => m.body.foreignId);

    // Clear and re-import
    importedMemories.length = 0;
    putCallIndex = 0;

    // Second import - same files should produce same foreignIds
    const source2 = loaded.plugin.import!({ source: FIXTURES_DIR }, ctx);
    await runImport({
      bridgeName: "markdown",
      source: source2,
      cwd: FIXTURES_DIR,
      agentId: "test-agent",
      putMemory,
      ctx,
    });

    const secondImportForeignIds = importedMemories.map((m) => m.body.foreignId);

    // Same files should produce same foreign IDs (for idempotent imports)
    expect(secondImportForeignIds).toEqual(firstImportForeignIds);
  });
});
