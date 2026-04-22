import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scaffold } from "../../src/bridges/scaffold";
import { discover } from "../../src/bridges/discover";

function makeSandbox(): { cwd: string; cleanup: () => void } {
  const cwd = join(tmpdir(), `flair-bridges-scaffold-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(cwd, { recursive: true });
  return { cwd, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
}

describe("bridges/scaffold", () => {
  let sb: ReturnType<typeof makeSandbox>;
  beforeEach(() => { sb = makeSandbox(); });
  afterEach(() => sb.cleanup());

  test("invalid name is rejected", async () => {
    await expect(scaffold({ name: "BadName", kind: "file", cwd: sb.cwd })).rejects.toThrow(/invalid bridge name/);
    await expect(scaffold({ name: "has_underscore", kind: "file", cwd: sb.cwd })).rejects.toThrow();
    await expect(scaffold({ name: "2startsWithDigit", kind: "file", cwd: sb.cwd })).rejects.toThrow();
  });

  test("valid names pass", async () => {
    const res = await scaffold({ name: "my-bridge", kind: "file", cwd: sb.cwd });
    expect(res.createdFiles.length).toBe(2);
  });

  test("--file creates descriptor + fixture under .flair-bridge/", async () => {
    const res = await scaffold({ name: "agentic-stack", kind: "file", cwd: sb.cwd });
    expect(res.createdFiles).toEqual([
      join(sb.cwd, ".flair-bridge", "agentic-stack.yaml"),
      join(sb.cwd, ".flair-bridge", "fixtures", "agentic-stack.fixture.jsonl"),
    ]);
    const yaml = readFileSync(res.createdFiles[0], "utf-8");
    expect(yaml).toContain("name: agentic-stack");
    expect(yaml).toContain("kind: file");
    expect(yaml).toContain("JSONPath");
  });

  test("--api creates package at flair-bridge-<name>/", async () => {
    const res = await scaffold({ name: "mem0", kind: "api", cwd: sb.cwd });
    expect(res.createdFiles).toHaveLength(3);
    const pkgDir = join(sb.cwd, "flair-bridge-mem0");
    expect(existsSync(join(pkgDir, "index.ts"))).toBe(true);
    expect(existsSync(join(pkgDir, "package.json"))).toBe(true);
    expect(existsSync(join(pkgDir, "fixtures", "mem0.mock.json"))).toBe(true);
    const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf-8"));
    expect(pkg.name).toBe("flair-bridge-mem0");
    expect(pkg.flair).toEqual({ kind: "api", version: 1 });
  });

  test("existing files are skipped without --force", async () => {
    const dir = join(sb.cwd, ".flair-bridge");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "foo.yaml"), "existing content");
    const res = await scaffold({ name: "foo", kind: "file", cwd: sb.cwd });
    expect(res.skippedFiles).toContain(join(sb.cwd, ".flair-bridge", "foo.yaml"));
    expect(readFileSync(join(dir, "foo.yaml"), "utf-8")).toBe("existing content");
  });

  test("--force overwrites existing files", async () => {
    const dir = join(sb.cwd, ".flair-bridge");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "foo.yaml"), "old");
    const res = await scaffold({ name: "foo", kind: "file", cwd: sb.cwd, force: true });
    expect(res.createdFiles).toContain(join(sb.cwd, ".flair-bridge", "foo.yaml"));
    expect(readFileSync(join(dir, "foo.yaml"), "utf-8")).not.toBe("old");
  });

  test("scaffold + discover round-trip: newly scaffolded bridge shows up", async () => {
    const res = await scaffold({ name: "roundtrip", kind: "file", cwd: sb.cwd });
    expect(res.createdFiles.length).toBeGreaterThan(0);
    const found = await discover({ cwd: sb.cwd, home: tmpdir(), moduleRoots: [] });
    const names = found.map((b) => b.name);
    expect(names).toContain("roundtrip");
    const roundtrip = found.find((b) => b.name === "roundtrip")!;
    expect(roundtrip.kind).toBe("file");
    expect(roundtrip.source).toBe("project-yaml");
  });
});
