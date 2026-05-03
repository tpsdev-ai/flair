import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseRecords } from "../../src/bridges/runtime/formats";
import { BridgeRuntimeError } from "../../src/bridges/types";

function tmp(): string {
  const d = join(tmpdir(), `flair-formats-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(d, { recursive: true });
  return d;
}

async function collect(iter: AsyncIterable<{ record: unknown; recordIndex: number }>): Promise<{ record: unknown; recordIndex: number }[]> {
  const out: { record: unknown; recordIndex: number }[] = [];
  for await (const r of iter) out.push(r);
  return out;
}

describe("formats: jsonl", () => {
  let dir: string;
  beforeEach(() => { dir = tmp(); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("parses valid jsonl and assigns 1-based recordIndex", async () => {
    const p = join(dir, "f.jsonl");
    writeFileSync(p, [
      JSON.stringify({ id: "a", v: 1 }),
      JSON.stringify({ id: "b", v: 2 }),
      JSON.stringify({ id: "c", v: 3 }),
    ].join("\n") + "\n");
    const out = await collect(parseRecords("t", p, "jsonl"));
    expect(out).toHaveLength(3);
    expect(out[0].recordIndex).toBe(1);
    expect(out[2].recordIndex).toBe(3);
    expect((out[1].record as any).id).toBe("b");
  });

  test("blank lines are skipped without incrementing the index", async () => {
    const p = join(dir, "f.jsonl");
    writeFileSync(p, `${JSON.stringify({ i: 1 })}\n\n\n${JSON.stringify({ i: 2 })}\n`);
    const out = await collect(parseRecords("t", p, "jsonl"));
    expect(out).toHaveLength(2);
    expect(out[1].recordIndex).toBe(2);
  });

  test("invalid JSON on one line throws with line context", async () => {
    const p = join(dir, "f.jsonl");
    writeFileSync(p, [
      JSON.stringify({ i: 1 }),
      "{not valid json",
      JSON.stringify({ i: 3 }),
    ].join("\n") + "\n");
    let thrown: any = null;
    try { await collect(parseRecords("t", p, "jsonl")); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(BridgeRuntimeError);
    expect(thrown.detail.record).toBe(2);
    expect(thrown.detail.hint).toMatch(/line 2/);
  });

  test("missing file throws with readable field", async () => {
    let thrown: any = null;
    try { await collect(parseRecords("t", join(dir, "nope.jsonl"), "jsonl")); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(BridgeRuntimeError);
    expect(thrown.detail.field).toMatch(/source\.path/);
  });
});

describe("formats: json", () => {
  let dir: string;
  beforeEach(() => { dir = tmp(); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("parses an array of records", async () => {
    const p = join(dir, "f.json");
    writeFileSync(p, JSON.stringify([{ i: 1 }, { i: 2 }]));
    const out = await collect(parseRecords("t", p, "json"));
    expect(out).toHaveLength(2);
    expect((out[0].record as any).i).toBe(1);
  });

  test("parses a single object as a one-record array", async () => {
    const p = join(dir, "f.json");
    writeFileSync(p, JSON.stringify({ only: true }));
    const out = await collect(parseRecords("t", p, "json"));
    expect(out).toHaveLength(1);
  });

  test("invalid json throws", async () => {
    const p = join(dir, "f.json");
    writeFileSync(p, "not valid json");
    let thrown: any = null;
    try { await collect(parseRecords("t", p, "json")); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(BridgeRuntimeError);
  });
});

describe("formats: yaml", () => {
  let dir: string;
  beforeEach(() => { dir = tmp(); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("parses a single-doc array", async () => {
    const p = join(dir, "f.yaml");
    writeFileSync(p, "- {i: 1}\n- {i: 2}\n");
    const out = await collect(parseRecords("t", p, "yaml"));
    expect(out).toHaveLength(2);
  });

  test("parses a multi-doc stream", async () => {
    const p = join(dir, "f.yaml");
    writeFileSync(p, "---\ni: 1\n---\ni: 2\n");
    const out = await collect(parseRecords("t", p, "yaml"));
    expect(out).toHaveLength(2);
  });
});

describe("formats: markdown-frontmatter", () => {
  let dir: string;
  beforeEach(() => { dir = tmp(); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("parses markdown with front-matter", async () => {
    const p = join(dir, "f.md");
    writeFileSync(p, "---\ntitle: x\ntags: [a, b]\n---\n\nbody content\n");
    const out = await collect(parseRecords("t", p, "markdown-frontmatter"));
    expect(out).toHaveLength(1);
    expect(out[0].record).toEqual({
      content: "\nbody content\n",
      subject: "x",
      tags: ["a", "b"],
      type: "fact",
      createdAt: expect.any(String),
      derivedFrom: [p],
      foreignId: p,
    });
  });

  test("handles markdown without front-matter", async () => {
    const p = join(dir, "f.md");
    writeFileSync(p, "just\ncontent\n");
    const out = await collect(parseRecords("t", p, "markdown-frontmatter"));
    expect(out).toHaveLength(1);
    expect(out[0].record).toEqual({
      content: "just\ncontent\n",
      subject: "f",
      type: "fact",
      createdAt: expect.any(String),
      derivedFrom: [p],
      foreignId: p,
    });
  });

  test("parses scalar tags as single-element array", async () => {
    const p = join(dir, "f.md");
    writeFileSync(p, "---\ntags: single\n---\n\ncontent\n");
    const out = await collect(parseRecords("t", p, "markdown-frontmatter"));
    expect(out).toHaveLength(1);
    expect(out[0].record.tags).toEqual(["single"]); 
  });
});
