import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { discover } from "../../src/bridges/discover";

function makeSandbox(): { cwd: string; home: string; cleanup: () => void } {
  const base = join(tmpdir(), `flair-bridges-disco-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const cwd = join(base, "project");
  const home = join(base, "home");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(home, { recursive: true });
  return { cwd, home, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

describe("bridges/discover", () => {
  let sb: ReturnType<typeof makeSandbox>;
  beforeEach(() => { sb = makeSandbox(); });
  afterEach(() => sb.cleanup());

  test("empty sandbox → no bridges", async () => {
    const found = await discover({ cwd: sb.cwd, home: sb.home, moduleRoots: [] });
    expect(found).toEqual([]);
  });

  test("project YAML is discovered and parsed", async () => {
    const dir = join(sb.cwd, ".flair-bridge");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "example.yaml"),
      `name: example\nversion: 1\nkind: file\ndescription: "hello world"\n`,
    );
    const found = await discover({ cwd: sb.cwd, home: sb.home, moduleRoots: [] });
    expect(found).toHaveLength(1);
    expect(found[0].name).toBe("example");
    expect(found[0].kind).toBe("file");
    expect(found[0].source).toBe("project-yaml");
    expect(found[0].description).toBe("hello world");
    expect(found[0].version).toBe(1);
  });

  test("user YAML is discovered", async () => {
    const dir = join(sb.home, ".flair", "bridges");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "user-scoped.yml"),
      `name: user-scoped\nkind: file\n`,
    );
    const found = await discover({ cwd: sb.cwd, home: sb.home, moduleRoots: [] });
    expect(found).toHaveLength(1);
    expect(found[0].source).toBe("user-yaml");
    expect(found[0].kind).toBe("file");
  });

  test("npm package flair-bridge-* is discovered as api kind", async () => {
    const moduleRoot = join(sb.cwd, "node_modules");
    const pkgDir = join(moduleRoot, "flair-bridge-example");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(
      join(pkgDir, "package.json"),
      JSON.stringify({ name: "flair-bridge-example", version: "0.1.0", description: "test bridge", flair: { version: 2 } }),
    );
    const found = await discover({ cwd: sb.cwd, home: sb.home, moduleRoots: [moduleRoot] });
    expect(found).toHaveLength(1);
    expect(found[0].name).toBe("example");
    expect(found[0].kind).toBe("api");
    expect(found[0].source).toBe("npm-package");
    expect(found[0].version).toBe(2);
  });

  test("scoped npm package @scope/flair-bridge-* is discovered", async () => {
    const moduleRoot = join(sb.cwd, "node_modules");
    const pkgDir = join(moduleRoot, "@acme", "flair-bridge-widget");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(
      join(pkgDir, "package.json"),
      JSON.stringify({ name: "@acme/flair-bridge-widget", version: "1.0.0" }),
    );
    const found = await discover({ cwd: sb.cwd, home: sb.home, moduleRoots: [moduleRoot] });
    expect(found).toHaveLength(1);
    expect(found[0].name).toBe("widget");
    expect(found[0].source).toBe("npm-package");
  });

  test("dedup: project YAML wins over npm package with same name", async () => {
    // Project YAML
    const yDir = join(sb.cwd, ".flair-bridge");
    mkdirSync(yDir, { recursive: true });
    writeFileSync(join(yDir, "foo.yaml"), `name: foo\nkind: file\n`);
    // npm package with same public name
    const moduleRoot = join(sb.cwd, "node_modules");
    const pkgDir = join(moduleRoot, "flair-bridge-foo");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "flair-bridge-foo" }));

    const found = await discover({ cwd: sb.cwd, home: sb.home, moduleRoots: [moduleRoot] });
    expect(found).toHaveLength(1);
    expect(found[0].source).toBe("project-yaml");
  });

  test("built-ins take precedence over everything", async () => {
    const yDir = join(sb.cwd, ".flair-bridge");
    mkdirSync(yDir, { recursive: true });
    writeFileSync(join(yDir, "foo.yaml"), `name: foo\nkind: file\n`);
    const found = await discover({
      cwd: sb.cwd,
      home: sb.home,
      moduleRoots: [],
      builtins: [{ name: "foo", kind: "file", source: "builtin", path: "/builtin/foo" }],
    });
    expect(found).toHaveLength(1);
    expect(found[0].source).toBe("builtin");
  });

  test("malformed yaml is ignored, not thrown", async () => {
    const dir = join(sb.cwd, ".flair-bridge");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "broken.yaml"), `::: not really yaml\n`);
    writeFileSync(join(dir, "good.yaml"), `name: good\nkind: file\n`);
    const found = await discover({ cwd: sb.cwd, home: sb.home, moduleRoots: [] });
    expect(found).toHaveLength(1);
    expect(found[0].name).toBe("good");
  });

  test("results are sorted alphabetically by name", async () => {
    const dir = join(sb.cwd, ".flair-bridge");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "zeta.yaml"), `name: zeta\nkind: file\n`);
    writeFileSync(join(dir, "alpha.yaml"), `name: alpha\nkind: file\n`);
    writeFileSync(join(dir, "middle.yaml"), `name: middle\nkind: file\n`);
    const found = await discover({ cwd: sb.cwd, home: sb.home, moduleRoots: [] });
    expect(found.map((b) => b.name)).toEqual(["alpha", "middle", "zeta"]);
  });
});
