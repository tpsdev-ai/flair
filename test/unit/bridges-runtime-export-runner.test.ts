import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runExport } from "../../src/bridges/runtime/export-runner";
import type { YamlBridgeDescriptor, BridgeMemory } from "../../src/bridges/types";
import { BridgeRuntimeError } from "../../src/bridges/types";

function tmp(): string {
  const d = join(tmpdir(), `flair-export-runner-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(d, { recursive: true });
  return d;
}

const agenticDescriptor: YamlBridgeDescriptor = {
  name: "agentic-stack",
  version: 1,
  kind: "file",
  export: {
    targets: [{
      path: ".agent/memory/semantic/lessons.jsonl",
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

async function* fromArray<T>(items: T[]): AsyncIterable<T> {
  for (const i of items) yield i;
}

describe("runExport: end-to-end against an injected fetcher", () => {
  let dir: string;
  beforeEach(() => { dir = tmp(); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("filters by `when:` and applies `map:` to write the target", async () => {
    const memories: BridgeMemory[] = [
      { content: "permanent lesson", subject: "eng", tags: ["a"], durability: "permanent", foreignId: "f1" },
      { content: "persistent lesson", subject: "eng", tags: ["b"], durability: "persistent", foreignId: "f2" },
      { content: "scratch", subject: "eng", tags: [], durability: "ephemeral", foreignId: "f3" },
    ];

    const result = await runExport({
      descriptor: agenticDescriptor,
      cwd: dir,
      fetchMemories: () => fromArray(memories),
    });

    expect(result.total).toBe(3);
    expect(result.exported).toBe(2); // ephemeral filtered out by when:
    const out = readFileSync(join(dir, ".agent/memory/semantic/lessons.jsonl"), "utf-8")
      .split("\n").filter(Boolean).map((l) => JSON.parse(l));
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ id: "f1", claim: "permanent lesson", topic: "eng", tags: ["a"] });
    expect(out[1]).toEqual({ id: "f2", claim: "persistent lesson", topic: "eng", tags: ["b"] });
  });

  test("absent when: exports everything", async () => {
    const desc: YamlBridgeDescriptor = {
      ...agenticDescriptor,
      export: {
        targets: [{
          ...agenticDescriptor.export!.targets[0],
          when: undefined,
        }],
      },
    };
    const memories: BridgeMemory[] = [
      { content: "a", durability: "ephemeral", foreignId: "1" },
      { content: "b", durability: "persistent", foreignId: "2" },
    ];
    const result = await runExport({ descriptor: desc, cwd: dir, fetchMemories: () => fromArray(memories) });
    expect(result.exported).toBe(2);
  });

  test("dry-run validates + counts but does not write the target", async () => {
    const memories: BridgeMemory[] = [
      { content: "x", durability: "permanent", foreignId: "f1" },
    ];
    const result = await runExport({
      descriptor: agenticDescriptor,
      cwd: dir,
      fetchMemories: () => fromArray(memories),
      dryRun: true,
    });
    expect(result.exported).toBe(0); // nothing written
    expect(result.perTarget[0].written).toBe(0);
    expect(existsSync(join(dir, ".agent/memory/semantic/lessons.jsonl"))).toBe(false);
  });

  test("missing export block throws a clear error", async () => {
    const desc: YamlBridgeDescriptor = {
      name: "import-only",
      version: 1,
      kind: "file",
      import: { sources: [{ path: "x", format: "jsonl", map: { content: "$.c" } }] },
    };
    let thrown: any = null;
    try {
      await runExport({ descriptor: desc, cwd: dir, fetchMemories: async function*() {} });
    } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(BridgeRuntimeError);
    expect(thrown.detail.field).toBe("export");
  });

  test("memories whose mapping produces zero fields are skipped", async () => {
    const desc: YamlBridgeDescriptor = {
      name: "weird",
      version: 1,
      kind: "file",
      export: {
        targets: [{
          path: "out.jsonl",
          format: "jsonl",
          map: { content: "$.missingField" },
        }],
      },
    };
    const memories: BridgeMemory[] = [
      { content: "real" },
    ];
    const result = await runExport({ descriptor: desc, cwd: dir, fetchMemories: () => fromArray(memories) });
    // map.content resolved to undefined → applyMap dropped it → empty record → skipped
    expect(result.exported).toBe(0);
    expect(result.total).toBe(1);
  });

  test("absolute target path is honored (doesn't re-root to cwd)", async () => {
    const absPath = join(dir, "absolute-out.jsonl");
    const desc: YamlBridgeDescriptor = {
      name: "abs",
      version: 1,
      kind: "file",
      export: {
        targets: [{
          path: absPath,
          format: "jsonl",
          map: { content: "$.content" },
        }],
      },
    };
    const memories: BridgeMemory[] = [{ content: "absolute test" }];
    await runExport({ descriptor: desc, cwd: "/somewhere/else", fetchMemories: () => fromArray(memories) });
    expect(existsSync(absPath)).toBe(true);
  });
});
