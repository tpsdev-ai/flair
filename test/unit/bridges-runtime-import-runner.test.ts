import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runImport } from "../../src/bridges/runtime/import-runner";
import type { PutMemoryBody } from "../../src/bridges/runtime/import-runner";
import type { YamlBridgeDescriptor } from "../../src/bridges/types";
import { BridgeRuntimeError } from "../../src/bridges/types";

function tmp(): string {
  const d = join(tmpdir(), `flair-import-runner-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(d, { recursive: true });
  return d;
}

function fixtureLessonsAt(dir: string, count = 3): void {
  mkdirSync(join(dir, ".agent", "memory", "semantic"), { recursive: true });
  const lines: string[] = [];
  for (let i = 1; i <= count; i++) {
    lines.push(JSON.stringify({ id: `l${i}`, claim: `Lesson ${i}.`, topic: "engineering", tags: ["ci", "process"] }));
  }
  writeFileSync(join(dir, ".agent", "memory", "semantic", "lessons.jsonl"), lines.join("\n") + "\n");
}

const agenticDescriptor: YamlBridgeDescriptor = {
  name: "agentic-stack",
  version: 1,
  kind: "file",
  import: {
    sources: [{
      path: ".agent/memory/semantic/lessons.jsonl",
      format: "jsonl",
      map: {
        content: "$.claim",
        subject: "$.topic",
        tags: "$.tags[*]",
        foreignId: "$.id",
        durability: "persistent",
        source: "agentic-stack/lessons",
      },
    }],
  },
};

describe("runImport: end-to-end against an injected putMemory", () => {
  let dir: string;
  beforeEach(() => { dir = tmp(); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("imports each record and calls putMemory once per record", async () => {
    fixtureLessonsAt(dir, 3);
    const seen: PutMemoryBody[] = [];
    const result = await runImport({
      bridgeName: agenticDescriptor.name,
      descriptor: agenticDescriptor,
      cwd: dir,
      agentId: "alice",
      putMemory: async (body) => { seen.push(body); },
    });
    expect(result.total).toBe(3);
    expect(result.imported).toBe(3);
    expect(result.skipped).toBe(0);
    expect(seen).toHaveLength(3);
    expect(seen[0].agentId).toBe("alice");
    expect(seen[0].content).toBe("Lesson 1.");
    expect(seen[0].subject).toBe("engineering");
    expect(seen[0].tags).toEqual(["ci", "process"]);
    expect(seen[0].durability).toBe("persistent");
    expect(seen[0].source).toBe("agentic-stack/lessons");
    expect(seen[0].foreignId).toBe("l1");
    expect(seen[0].type).toBe("memory");
    expect(seen[0].id).toMatch(/^alice-/);
  });

  test("dry-run validates + counts but doesn't call putMemory", async () => {
    fixtureLessonsAt(dir, 5);
    const seen: PutMemoryBody[] = [];
    const events: string[] = [];
    const result = await runImport({
      bridgeName: agenticDescriptor.name,
      descriptor: agenticDescriptor,
      cwd: dir,
      agentId: "alice",
      dryRun: true,
      putMemory: async (b) => { seen.push(b); },
      onProgress: (ev) => { events.push(ev.type); },
    });
    expect(result.imported).toBe(0);
    expect(result.skipped).toBe(5);
    expect(seen).toHaveLength(0);
    expect(events).toContain("memory-skipped");
    expect(events).toContain("done");
  });

  test("missing agentId on record + no --agent default throws", async () => {
    fixtureLessonsAt(dir, 1);
    let thrown: any = null;
    try {
      await runImport({
        bridgeName: agenticDescriptor.name,
      descriptor: agenticDescriptor,
        cwd: dir,
        // intentionally no agentId
        putMemory: async () => {},
      });
    } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(BridgeRuntimeError);
    expect(thrown.detail.field).toBe("agentId");
    expect(thrown.detail.hint).toMatch(/--agent/);
  });

  test("PUT failure wraps as BridgeRuntimeError with record index", async () => {
    fixtureLessonsAt(dir, 2);
    let thrown: any = null;
    try {
      await runImport({
        bridgeName: agenticDescriptor.name,
      descriptor: agenticDescriptor,
        cwd: dir,
        agentId: "alice",
        putMemory: async (body) => {
          if (body.foreignId === "l2") throw new Error("PUT /Memory/x → 503: backend down");
        },
      });
    } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(BridgeRuntimeError);
    expect(thrown.detail.field).toBe("(write)");
    expect(thrown.detail.record).toBe(2);
    expect(thrown.detail.hint).toMatch(/Flair rejected/);
  });

  test("emits 'done' progress event with totals", async () => {
    fixtureLessonsAt(dir, 2);
    let done: any = null;
    await runImport({
      bridgeName: agenticDescriptor.name,
      descriptor: agenticDescriptor,
      cwd: dir,
      agentId: "alice",
      putMemory: async () => {},
      onProgress: (ev) => { if (ev.type === "done") done = ev; },
    });
    expect(done).toBeDefined();
    expect(done.total).toBe(2);
    expect(done.imported).toBe(2);
  });

  test("preserves explicit memory id when descriptor maps one", async () => {
    fixtureLessonsAt(dir, 1);
    const desc: YamlBridgeDescriptor = {
      ...agenticDescriptor,
      import: {
        sources: [{
          ...agenticDescriptor.import!.sources[0],
          map: { ...agenticDescriptor.import!.sources[0].map, id: "$.id" },
        }],
      },
    };
    const seen: PutMemoryBody[] = [];
    await runImport({
      bridgeName: desc.name,
      descriptor: desc,
      cwd: dir,
      agentId: "alice",
      putMemory: async (b) => { seen.push(b); },
    });
    expect(seen[0].id).toBe("l1");
  });
});
