import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runRoundTrip } from "../../src/bridges/runtime/roundtrip";
import type { YamlBridgeDescriptor } from "../../src/bridges/types";
import { BridgeRuntimeError } from "../../src/bridges/types";

function sandbox(): string {
  const d = join(tmpdir(), `flair-roundtrip-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(d, { recursive: true });
  return d;
}

// Agentic-stack-like descriptor with matching import/export, for round-trip.
const descriptor: YamlBridgeDescriptor = {
  name: "test-bridge",
  version: 1,
  kind: "file",
  import: {
    sources: [{
      path: "fixture.jsonl",
      format: "jsonl",
      map: {
        content: "$.claim",
        subject: "$.topic",
        tags: "$.tags[*]",
        foreignId: "$.id",
        durability: "persistent",
        source: "test-bridge/lessons",
      },
    }],
  },
  export: {
    targets: [{
      path: "out.jsonl",
      format: "jsonl",
      when: "durability in ['persistent', 'permanent']",
      map: {
        id: "$.foreignId",
        claim: "$.content",
        topic: "$.subject",
        tags: "$.tags[*]",
      },
    }],
  },
};

describe("runRoundTrip: passing paths", () => {
  let dir: string;
  beforeEach(() => { dir = sandbox(); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("symmetric import/export passes", async () => {
    writeFileSync(join(dir, "fixture.jsonl"), [
      JSON.stringify({ id: "l1", claim: "Always test before merging.", topic: "ci", tags: ["ci"] }),
      JSON.stringify({ id: "l2", claim: "Stack PRs carefully.", topic: "git", tags: ["git", "ops"] }),
    ].join("\n") + "\n");
    const result = await runRoundTrip({ descriptor, cwd: dir });
    expect(result.passed).toBe(true);
    expect(result.expectedCount).toBe(2);
    expect(result.actualCount).toBe(2);
    expect(result.mismatches).toEqual([]);
    expect(result.missingInPass2).toEqual([]);
    expect(result.unexpectedInPass2).toEqual([]);
  });

  test("empty fixture round-trips trivially", async () => {
    writeFileSync(join(dir, "fixture.jsonl"), "");
    const result = await runRoundTrip({ descriptor, cwd: dir });
    expect(result.passed).toBe(true);
    expect(result.expectedCount).toBe(0);
    expect(result.actualCount).toBe(0);
  });
});

describe("runRoundTrip: failing paths", () => {
  let dir: string;
  beforeEach(() => { dir = sandbox(); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("descriptor without an import block throws", async () => {
    const d: YamlBridgeDescriptor = {
      name: "no-import",
      version: 1,
      kind: "file",
      export: { targets: [{ path: "out.jsonl", format: "jsonl", map: { content: "$.c" } }] },
    };
    let thrown: any = null;
    try { await runRoundTrip({ descriptor: d, cwd: dir }); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(BridgeRuntimeError);
    expect(thrown.detail.field).toBe("import");
  });

  test("descriptor without an export block throws", async () => {
    const d: YamlBridgeDescriptor = {
      name: "no-export",
      version: 1,
      kind: "file",
      import: { sources: [{ path: "x.jsonl", format: "jsonl", map: { content: "$.c" } }] },
    };
    let thrown: any = null;
    try { await runRoundTrip({ descriptor: d, cwd: dir }); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(BridgeRuntimeError);
    expect(thrown.detail.field).toBe("export");
  });

  test("catches a mapping bug where the export loses a field", async () => {
    writeFileSync(join(dir, "fixture.jsonl"),
      JSON.stringify({ id: "l1", claim: "test", topic: "eng", tags: ["ci", "dev"] }) + "\n");
    const buggy: YamlBridgeDescriptor = {
      ...descriptor,
      export: {
        targets: [{
          ...descriptor.export!.targets[0],
          map: {
            id: "$.foreignId",
            claim: "$.content",
            topic: "$.subject",
            // ← intentionally drop tags from export
          },
        }],
      },
    };
    const result = await runRoundTrip({ descriptor: buggy, cwd: dir });
    expect(result.passed).toBe(false);
    expect(result.mismatches.length).toBeGreaterThan(0);
    // The dropped field shows up in mismatches
    expect(result.mismatches[0].field).toBe("tags");
  });

  test("catches when filter dropping records that wouldn't re-import", async () => {
    writeFileSync(join(dir, "fixture.jsonl"), [
      JSON.stringify({ id: "l1", claim: "ephemeral one", topic: "x", tags: [] }),
    ].join("\n") + "\n");
    const ephDesc: YamlBridgeDescriptor = {
      ...descriptor,
      import: {
        sources: [{
          ...descriptor.import!.sources[0],
          map: { ...descriptor.import!.sources[0].map, durability: "ephemeral" },
        }],
      },
    };
    const result = await runRoundTrip({ descriptor: ephDesc, cwd: dir });
    expect(result.passed).toBe(true);
    expect(result.expectedCount).toBe(0);
    expect(result.actualCount).toBe(0);
  });

  test("honors --fixture override for the import source", async () => {
    const altPath = join(dir, "alt.jsonl");
    writeFileSync(altPath,
      JSON.stringify({ id: "alt-1", claim: "from alt fixture", topic: "misc" }) + "\n");
    const result = await runRoundTrip({ descriptor, cwd: dir, fixturePath: altPath });
    expect(result.passed).toBe(true);
    expect(result.expectedCount).toBe(1);
  });

  test("tmpExportPath is a readable jsonl of the exported records", async () => {
    writeFileSync(join(dir, "fixture.jsonl"),
      JSON.stringify({ id: "l1", claim: "hi", topic: "t", tags: ["a"] }) + "\n");
    const result = await runRoundTrip({ descriptor, cwd: dir });
    const written = readFileSync(result.tmpExportPath, "utf-8");
    expect(written.trim().split("\n").length).toBe(1);
    const parsed = JSON.parse(written.trim());
    expect(parsed).toEqual({ id: "l1", claim: "hi", topic: "t", tags: ["a"] });
  });
});
