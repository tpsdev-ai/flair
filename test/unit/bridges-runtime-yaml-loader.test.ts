import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadYamlDescriptor } from "../../src/bridges/runtime/yaml-loader";
import { BridgeRuntimeError } from "../../src/bridges/types";

function tmp(): string {
  const d = join(tmpdir(), `flair-yaml-loader-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(d, { recursive: true });
  return d;
}

describe("yaml-loader: valid descriptors", () => {
  let dir: string;
  beforeEach(() => { dir = tmp(); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("loads a minimal file descriptor with import only", async () => {
    const p = join(dir, "b.yaml");
    writeFileSync(p, `
name: example
version: 1
kind: file
description: "example bridge"
import:
  sources:
    - path: ".agent/memory/lessons.jsonl"
      format: jsonl
      map:
        content: "$.claim"
        subject: "$.topic"
`);
    const d = await loadYamlDescriptor(p);
    expect(d.name).toBe("example");
    expect(d.version).toBe(1);
    expect(d.kind).toBe("file");
    expect(d.description).toBe("example bridge");
    expect(d.import?.sources).toHaveLength(1);
    expect(d.import?.sources[0].path).toBe(".agent/memory/lessons.jsonl");
    expect(d.import?.sources[0].format).toBe("jsonl");
    expect(d.import?.sources[0].map).toEqual({ content: "$.claim", subject: "$.topic" });
  });

  test("loads a descriptor with both import and export + detect", async () => {
    const p = join(dir, "b.yaml");
    writeFileSync(p, `
name: full-example
version: 1
kind: file
detect:
  anyExists:
    - ".agent/AGENTS.md"
import:
  sources:
    - path: "in.jsonl"
      format: jsonl
      map:
        content: "$.text"
export:
  targets:
    - path: "out.jsonl"
      format: jsonl
      when: "durability in ['persistent']"
      map:
        text: "content"
`);
    const d = await loadYamlDescriptor(p);
    expect(d.detect?.anyExists).toEqual([".agent/AGENTS.md"]);
    expect(d.export?.targets[0].when).toBe("durability in ['persistent']");
    expect(d.export?.targets[0].map).toEqual({ text: "content" });
  });

  test("version defaults to 1 when omitted", async () => {
    const p = join(dir, "b.yaml");
    writeFileSync(p, `name: novers\nkind: file\nimport:\n  sources:\n    - {path: in, format: json, map: {content: "$.c"}}\n`);
    const d = await loadYamlDescriptor(p);
    expect(d.version).toBe(1);
  });
});

describe("yaml-loader: validation errors", () => {
  let dir: string;
  beforeEach(() => { dir = tmp(); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const expectError = async (promise: Promise<unknown>, fieldMatches: RegExp): Promise<void> => {
    let thrown: unknown = null;
    try { await promise; } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(BridgeRuntimeError);
    expect((thrown as BridgeRuntimeError).detail.field).toMatch(fieldMatches);
  };

  test("missing file throws with readable field", async () => {
    await expectError(loadYamlDescriptor(join(dir, "nope.yaml")), /file/);
  });

  test("malformed YAML throws", async () => {
    const p = join(dir, "bad.yaml");
    // Unterminated double-quoted scalar — js-yaml rejects outright.
    writeFileSync(p, 'name: "unterminated\nkind: file\n');
    await expectError(loadYamlDescriptor(p), /yaml/);
  });

  test("non-mapping root throws", async () => {
    const p = join(dir, "arr.yaml");
    writeFileSync(p, "- one\n- two\n");
    await expectError(loadYamlDescriptor(p), /root/);
  });

  test("missing name throws", async () => {
    const p = join(dir, "noname.yaml");
    writeFileSync(p, "kind: file\nimport:\n  sources:\n    - {path: a, format: json, map: {content: '$.c'}}\n");
    await expectError(loadYamlDescriptor(p), /name/);
  });

  test("wrong kind throws with a pointer to code plugin docs", async () => {
    const p = join(dir, "wrongkind.yaml");
    writeFileSync(p, "name: x\nkind: api\nimport:\n  sources:\n    - {path: a, format: json, map: {content: '$.c'}}\n");
    let thrown: any = null;
    try { await loadYamlDescriptor(p); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(BridgeRuntimeError);
    expect(thrown.detail.hint).toMatch(/code plugin/);
  });

  test("unsupported format throws", async () => {
    const p = join(dir, "fmt.yaml");
    writeFileSync(p, `name: x
kind: file
import:
  sources:
    - {path: a, format: xml, map: {content: "$.c"}}
`);
    await expectError(loadYamlDescriptor(p), /format/);
  });

  test("missing map on a source throws", async () => {
    const p = join(dir, "nomap.yaml");
    writeFileSync(p, `name: x
kind: file
import:
  sources:
    - {path: a, format: jsonl}
`);
    await expectError(loadYamlDescriptor(p), /map/);
  });

  test("descriptor with neither import nor export throws", async () => {
    const p = join(dir, "nothing.yaml");
    writeFileSync(p, "name: x\nkind: file\n");
    await expectError(loadYamlDescriptor(p), /root/);
  });

  test("empty import.sources array throws", async () => {
    const p = join(dir, "nosources.yaml");
    writeFileSync(p, "name: x\nkind: file\nimport:\n  sources: []\n");
    await expectError(loadYamlDescriptor(p), /import\.sources/);
  });
});
