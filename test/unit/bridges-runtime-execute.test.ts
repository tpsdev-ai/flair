import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { importFromYaml } from "../../src/bridges/runtime/execute";
import type { BridgeMemory, YamlBridgeDescriptor } from "../../src/bridges/types";
import { BridgeRuntimeError } from "../../src/bridges/types";

function tmp(): string {
  const d = join(tmpdir(), `flair-execute-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(d, { recursive: true });
  return d;
}

async function collect(iter: AsyncIterable<BridgeMemory>): Promise<BridgeMemory[]> {
  const out: BridgeMemory[] = [];
  for await (const m of iter) out.push(m);
  return out;
}

describe("execute: importFromYaml end-to-end", () => {
  let dir: string;
  beforeEach(() => { dir = tmp(); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("imports records from one jsonl source and yields BridgeMemory", async () => {
    const srcPath = join(dir, "lessons.jsonl");
    writeFileSync(srcPath, [
      JSON.stringify({ id: "l1", claim: "Always run tests before pushing.", topic: "engineering", tags: ["ci", "process"] }),
      JSON.stringify({ id: "l2", claim: "Name workarounds as workarounds.", topic: "communication", tags: ["writing"] }),
    ].join("\n") + "\n");

    const descriptor: YamlBridgeDescriptor = {
      name: "agentic-stack-like",
      version: 1,
      kind: "file",
      import: {
        sources: [{
          path: "lessons.jsonl",
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

    const out = await collect(importFromYaml(descriptor, { cwd: dir }));
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      content: "Always run tests before pushing.",
      subject: "engineering",
      tags: ["ci", "process"],
      foreignId: "l1",
      durability: "persistent",
      source: "agentic-stack/lessons",
    } as BridgeMemory);
    expect(out[1].foreignId).toBe("l2");
  });

  test("sources iterate in descriptor order", async () => {
    writeFileSync(join(dir, "a.jsonl"), JSON.stringify({ c: "first" }) + "\n");
    writeFileSync(join(dir, "b.jsonl"), JSON.stringify({ c: "second" }) + "\n");
    const descriptor: YamlBridgeDescriptor = {
      name: "two-sources",
      version: 1,
      kind: "file",
      import: {
        sources: [
          { path: "a.jsonl", format: "jsonl", map: { content: "$.c" } },
          { path: "b.jsonl", format: "jsonl", map: { content: "$.c" } },
        ],
      },
    };
    const out = await collect(importFromYaml(descriptor, { cwd: dir }));
    expect(out.map((m) => m.content)).toEqual(["first", "second"]);
  });

  test("descriptor with no import block throws a clear error", async () => {
    const descriptor: YamlBridgeDescriptor = {
      name: "export-only",
      version: 1,
      kind: "file",
      export: { targets: [{ path: "x", format: "jsonl", map: { content: "content" } }] },
    };
    let thrown: any = null;
    try { await collect(importFromYaml(descriptor, { cwd: dir })); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(BridgeRuntimeError);
    expect(thrown.detail.field).toBe("import");
  });

  test("missing required content throws with record index", async () => {
    const srcPath = join(dir, "bad.jsonl");
    writeFileSync(srcPath, [
      JSON.stringify({ claim: "valid" }),
      JSON.stringify({ subject: "no claim field" }),
    ].join("\n") + "\n");
    const descriptor: YamlBridgeDescriptor = {
      name: "missing-content",
      version: 1,
      kind: "file",
      import: { sources: [{ path: "bad.jsonl", format: "jsonl", map: { content: "$.claim" } }] },
    };
    let thrown: any = null;
    try { await collect(importFromYaml(descriptor, { cwd: dir })); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(BridgeRuntimeError);
    expect(thrown.detail.record).toBe(2);
    expect(thrown.detail.field).toBe("map.content");
  });

  test("attempting to set a Flair-reserved field throws", async () => {
    writeFileSync(join(dir, "r.jsonl"), JSON.stringify({ c: "x" }) + "\n");
    const descriptor: YamlBridgeDescriptor = {
      name: "reserved",
      version: 1,
      kind: "file",
      import: {
        sources: [{
          path: "r.jsonl",
          format: "jsonl",
          map: { content: "$.c", contentHash: "$.c" },
        }],
      },
    };
    let thrown: any = null;
    try { await collect(importFromYaml(descriptor, { cwd: dir })); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(BridgeRuntimeError);
    expect(thrown.detail.field).toBe("map.contentHash");
    expect(thrown.detail.hint).toMatch(/MUST NOT/);
  });

  test("absolute source path is honored (doesn't re-root to cwd)", async () => {
    const absPath = join(dir, "abs.jsonl");
    writeFileSync(absPath, JSON.stringify({ c: "absolute" }) + "\n");
    const descriptor: YamlBridgeDescriptor = {
      name: "abs",
      version: 1,
      kind: "file",
      import: { sources: [{ path: absPath, format: "jsonl", map: { content: "$.c" } }] },
    };
    // cwd intentionally different from the file's directory
    const out = await collect(importFromYaml(descriptor, { cwd: "/tmp" }));
    expect(out[0].content).toBe("absolute");
  });
});
