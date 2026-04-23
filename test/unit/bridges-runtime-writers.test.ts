import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeRecords } from "../../src/bridges/runtime/writers";
import { BridgeRuntimeError } from "../../src/bridges/types";

function tmp(): string {
  const d = join(tmpdir(), `flair-writers-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(d, { recursive: true });
  return d;
}

describe("writers: jsonl", () => {
  let dir: string;
  beforeEach(() => { dir = tmp(); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("writes one JSON object per line", async () => {
    const out = join(dir, "out.jsonl");
    const result = await writeRecords("test", out, "jsonl", [
      { id: "a", v: 1 }, { id: "b", v: 2 }, { id: "c", v: 3 },
    ]);
    expect(result.written).toBe(3);
    const lines = readFileSync(out, "utf-8").split("\n").filter(Boolean);
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0])).toEqual({ id: "a", v: 1 });
    expect(JSON.parse(lines[2])).toEqual({ id: "c", v: 3 });
  });

  test("creates the parent directory", async () => {
    const out = join(dir, "nested", "deep", "out.jsonl");
    await writeRecords("test", out, "jsonl", [{ x: 1 }]);
    expect(existsSync(out)).toBe(true);
  });

  test("write is atomic — partial-write tmp file is gone after success", async () => {
    const out = join(dir, "out.jsonl");
    await writeRecords("test", out, "jsonl", [{ x: 1 }]);
    // No `.export.tmp` siblings left over
    const siblings = require("node:fs").readdirSync(dir);
    expect(siblings.filter((f: string) => f.includes(".tmp"))).toEqual([]);
  });

  test("zero records still writes an empty file (legitimate output)", async () => {
    const out = join(dir, "empty.jsonl");
    const result = await writeRecords("test", out, "jsonl", []);
    expect(result.written).toBe(0);
    expect(readFileSync(out, "utf-8")).toBe("");
  });
});

describe("writers: json", () => {
  let dir: string;
  beforeEach(() => { dir = tmp(); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("writes a JSON array of records", async () => {
    const out = join(dir, "out.json");
    const result = await writeRecords("test", out, "json", [{ a: 1 }, { a: 2 }]);
    expect(result.written).toBe(2);
    expect(JSON.parse(readFileSync(out, "utf-8"))).toEqual([{ a: 1 }, { a: 2 }]);
  });
});

describe("writers: yaml", () => {
  let dir: string;
  beforeEach(() => { dir = tmp(); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("writes a yaml array of records", async () => {
    const out = join(dir, "out.yaml");
    const result = await writeRecords("test", out, "yaml", [{ a: 1 }, { a: 2 }]);
    expect(result.written).toBe(2);
    const yamlText = readFileSync(out, "utf-8");
    // light check — should contain both record values
    expect(yamlText).toContain("a: 1");
    expect(yamlText).toContain("a: 2");
  });
});

describe("writers: markdown-frontmatter (deferred)", () => {
  let dir: string;
  beforeEach(() => { dir = tmp(); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("throws a slice-3b pointer error", async () => {
    const out = join(dir, "out.md");
    let thrown: any = null;
    try { await writeRecords("test", out, "markdown-frontmatter", [{ x: 1 }]); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(BridgeRuntimeError);
    expect(thrown.detail.hint).toMatch(/slice 3b/);
  });
});

describe("writers: error handling", () => {
  let dir: string;
  beforeEach(() => { dir = tmp(); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("write to an unwritable parent throws BridgeRuntimeError", async () => {
    // Make the parent file (not directory) so mkdir fails
    const blocker = join(dir, "blocked");
    writeFileSync(blocker, "not a dir");
    let thrown: any = null;
    try {
      await writeRecords("test", join(blocker, "out.jsonl"), "jsonl", [{ x: 1 }]);
    } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(BridgeRuntimeError);
    expect(thrown.detail.field).toBe("(mkdir)");
  });
});
