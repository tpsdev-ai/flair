/** Tests for declared direct override keys matching workspace dependency names. */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { findExactOverrideViolations } from "../../scripts/check-exact-overrides.mjs";
import { tempDir } from "../helpers/temp-dir.ts";

const SCRIPT = join(import.meta.dir, "../../scripts/check-exact-overrides.mjs");

interface WsPkg {
  dir: string;
  json?: Record<string, unknown>;
}

function res(name: string, version: string): [string, string, Record<string, unknown>, string] {
  return [`${name}@${version}`, "", {}, "sha512-fixture"];
}

/** A scratch repo: root + packages/<dir>/package.json + a JSONC bun.lock. */
function buildFixture(opts: {
  overrides?: Record<string, unknown>;
  workspaces?: WsPkg[];
  packages?: Record<string, unknown>;
}): string {
  const root = tempDir("flair-exact-overrides-");
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify(
      {
        name: "fixture-root",
        workspaces: ["packages/*"],
        ...(opts.overrides ? { overrides: opts.overrides } : {}),
      },
      null,
      2,
    )}\n`,
  );
  mkdirSync(join(root, "packages"), { recursive: true });
  for (const w of opts.workspaces ?? []) {
    mkdirSync(join(root, "packages", w.dir), { recursive: true });
    writeFileSync(
      join(root, "packages", w.dir, "package.json"),
      `${JSON.stringify({ name: `@x/${w.dir}`, ...(w.json ?? {}) }, null, 2)}\n`,
    );
  }
  writeFileSync(
    join(root, "bun.lock"),
    `{\n  "lockfileVersion": 1,\n  "packages": ${JSON.stringify(opts.packages ?? {}, null, 2)},\n}\n`,
  );
  return root;
}

function runCli(root: string) {
  return spawnSync("node", [SCRIPT, "--root", root], { encoding: "utf8", timeout: 10000 });
}

const declares = (kind: string, deps: Record<string, unknown>): WsPkg => ({
  dir: "adapter",
  json: { [kind]: deps },
});

describe("check-exact-overrides — the narrowed scope", () => {
  test("(a) a range override for a package a workspace declares FAILS, naming it and the exact pin", () => {
    const root = buildFixture({
      overrides: { "@x/dep": "^1.2.3" },
      workspaces: [declares("dependencies", { "@x/dep": "^1.2.3" })],
      packages: { "@x/dep": res("@x/dep", "1.2.3") },
    });
    expect(findExactOverrideViolations(root)).toEqual([
      { name: "@x/dep", declared: "^1.2.3", exact: "1.2.3" },
    ]);
    const r = runCli(root);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("@x/dep");
    expect(r.stderr).toContain("^1.2.3");
    expect(r.stderr).toContain('"1.2.3"');
    expect(r.stdout).not.toContain("✓");
  }, 15000);

  test("(b) the same override exact PASSES", () => {
    const root = buildFixture({
      overrides: { "@x/dep": "1.2.3" },
      workspaces: [declares("dependencies", { "@x/dep": "^1.2.3" })],
      packages: { "@x/dep": res("@x/dep", "1.2.3") },
    });
    expect(findExactOverrideViolations(root)).toEqual([]);
    expect(runCli(root).status).toBe(0);
  }, 15000);

  test("(c) a range override for a package NO workspace declares PASSES", () => {
    const root = buildFixture({
      overrides: { "@x/other": "^1.2.3" },
      workspaces: [declares("dependencies", { "@x/dep": "^1.2.3" })],
      packages: { "@x/other": res("@x/other", "1.2.3") },
    });
    expect(findExactOverrideViolations(root)).toEqual([]);
    expect(runCli(root).status).toBe(0);
  }, 15000);

  test("(d) a workspace's OWN dependency range PASSES (out of scope)", () => {
    const root = buildFixture({
      workspaces: [declares("dependencies", { "@x/dep": "^1.2.3" })],
      packages: { "@x/dep": res("@x/dep", "1.2.3") },
    });
    expect(findExactOverrideViolations(root)).toEqual([]);
    expect(runCli(root).status).toBe(0);
  }, 15000);

  test("(e) a peerDependency range PASSES (out of scope), even with a matching override", () => {
    const root = buildFixture({
      overrides: { "@x/peer": "^2.0.0" },
      workspaces: [declares("peerDependencies", { "@x/peer": "^2.0.0" })],
      packages: { "@x/peer": res("@x/peer", "2.0.0") },
    });
    expect(findExactOverrideViolations(root)).toEqual([]);
    expect(runCli(root).status).toBe(0);
  }, 15000);

  test("(f) a `workspace:*` override PASSES (exempt)", () => {
    const root = buildFixture({
      overrides: { "@x/dep": "workspace:*" },
      workspaces: [declares("dependencies", { "@x/dep": "workspace:*" })],
    });
    expect(findExactOverrideViolations(root)).toEqual([]);
    expect(runCli(root).status).toBe(0);
  }, 15000);

  test("a range override reaching a devDependency or optionalDependency also FAILS", () => {
    for (const kind of ["devDependencies", "optionalDependencies"]) {
      const root = buildFixture({
        overrides: { "@x/dep": "~1.2.3" },
        workspaces: [declares(kind, { "@x/dep": "1.2.3" })],
        packages: { "@x/dep": res("@x/dep", "1.2.4") },
      });
      expect(findExactOverrideViolations(root)).toEqual([
        { name: "@x/dep", declared: "~1.2.3", exact: "1.2.4" },
      ]);
    }
  }, 15000);

  test("an override with no bun.lock resolution still FAILS, without a pin", () => {
    const root = buildFixture({
      overrides: { "@x/dep": "^1.2.3" },
      workspaces: [declares("dependencies", { "@x/dep": "^1.2.3" })],
    });
    expect(findExactOverrideViolations(root)).toEqual([
      { name: "@x/dep", declared: "^1.2.3", exact: null },
    ]);
    const r = runCli(root);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("choose an exact version or a workspace: specifier");
    expect(r.stderr).not.toContain("registry");
  }, 15000);
});

describe("lockfile advice", () => {
  for (const version of [
    "workspace:packages/dep", "file:../dep", "link:../dep", "git+https://example.test/dep.git",
    "https://example.test/dep.tgz", "git+https://example.test/dep.git@1.2.3", "file:dep@1.2.3", "^1.2.3", "npm:foo@1.2.3", "01.2.3", "1.2.3-01",
  ]) {
    test(`no pin for ${version}`, () => {
      const root = buildFixture({
        overrides: { "@x/dep": "^1.2.3" },
        workspaces: [declares("dependencies", { "@x/dep": "file:../dep" })],
        packages: { "@x/dep": res("@x/dep", version) },
      });
      expect(findExactOverrideViolations(root)).toEqual([
        { name: "@x/dep", declared: "^1.2.3", exact: null },
      ]);
      const result = runCli(root);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("choose an exact version or a workspace: specifier");
      expect(result.stderr).not.toContain("registry");
    }, 15000);
  }
  test("missing lockfile gives no pin", () => {
    const root = buildFixture({
      overrides: { "@x/dep": "^1.2.3" },
      workspaces: [declares("dependencies", { "@x/dep": "file:../dep" })],
    });
    rmSync(join(root, "bun.lock"));
    expect(findExactOverrideViolations(root)[0]?.exact).toBeNull();
    const result = runCli(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("choose an exact version or a workspace: specifier");
    expect(result.stderr).not.toContain('pin "');
    writeFileSync(join(root, "package.json"), JSON.stringify({ workspaces: ["packages/*"] }));
    expect(runCli(root).status).toBe(0);
  }, 15000);
});

describe("check-exact-overrides — required inputs fail closed", () => {
  function expectInputFailure(root: string, path: string, state: string) {
    expect(() => findExactOverrideViolations(root)).toThrow(path);
    const r = runCli(root);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain(path);
    expect(r.stderr).toContain(state);
    expect(r.stderr).toContain("Maintainer:");
    expect(r.stdout).not.toContain("✓");
  }

  for (const value of [null, "dep", 1, true, []]) {
    for (const rel of ["package.json", "packages/adapter/package.json"]) {
      for (const field of ["dependencies", "devDependencies", "optionalDependencies", ...(rel === "package.json" ? ["overrides"] : [])]) {
        test(`refuses ${rel} ${field}=${JSON.stringify(value)}`, () => {
          const root = buildFixture({
            overrides: { dep: "1.x" },
            workspaces: [declares("dependencies", { dep: "1.2.3" })],
          });
          const path = join(root, rel);
          const pkg = JSON.parse(readFileSync(path, "utf8"));
          pkg[field] = value;
          writeFileSync(path, JSON.stringify(pkg));
          expectInputFailure(root, path, `${field} must be a plain object`);
        }, 15000);
      }
    }
    for (const rel of ["package.json", "packages/adapter/package.json", "bun.lock"]) {
      test(`refuses ${rel}=${JSON.stringify(value)}`, () => {
        const root = buildFixture({ workspaces: [{ dir: "adapter" }] });
        const path = join(root, rel);
        writeFileSync(path, JSON.stringify(value));
        expectInputFailure(root, path, "object");
      }, 15000);
    }
    test(`refuses bun.lock packages=${JSON.stringify(value)}`, () => {
      const root = buildFixture({ workspaces: [{ dir: "adapter" }] });
      const path = join(root, "bun.lock");
      writeFileSync(path, JSON.stringify({ packages: value }));
      expectInputFailure(root, path, "packages must be a plain object");
    }, 15000);
  }

  test("a missing root package.json fails", () => {
    const root = buildFixture({});
    rmSync(join(root, "package.json"));
    expectInputFailure(root, join(root, "package.json"), "cannot read");
  }, 15000);

  test("a malformed root package.json fails", () => {
    const root = buildFixture({});
    const path = join(root, "package.json");
    writeFileSync(path, '{ "name": ');
    expectInputFailure(root, path, "not parsable");
  }, 15000);

  test("a malformed workspace package.json fails", () => {
    const root = buildFixture({ workspaces: [declares("dependencies", { "@x/dep": "^1.2.3" })] });
    const path = join(root, "packages/adapter/package.json");
    writeFileSync(path, "invalid JSON");
    expectInputFailure(root, path, "not parsable");
  }, 15000);

  test("a malformed bun.lock exits 2 and names the file", () => {
    const root = buildFixture({ workspaces: [{ dir: "adapter" }] });
    const path = join(root, "bun.lock");
    writeFileSync(path, '{ "packages": ');
    expectInputFailure(root, path, "not parsable");
  }, 15000);

  test("an unreadable bun.lock exits 2 and names the file", () => {
    const root = buildFixture({ workspaces: [{ dir: "adapter" }] });
    const path = join(root, "bun.lock");
    chmodSync(path, 0o000);
    try {
      expectInputFailure(root, path, "cannot read");
    } finally {
      chmodSync(path, 0o600);
    }
  }, 15000);

  test("a dangling bun.lock symlink exits 2 and names the file", () => {
    const root = buildFixture({ workspaces: [{ dir: "adapter" }] });
    const path = join(root, "bun.lock");
    rmSync(path);
    symlinkSync("missing.lock", path);
    expectInputFailure(root, path, "cannot read");
  }, 15000);

  test("a non-directory workspace parent fails", () => {
    const root = buildFixture({});
    rmSync(join(root, "packages"), { recursive: true });
    writeFileSync(join(root, "packages"), "not a directory");
    expectInputFailure(root, join(root, "packages"), "cannot read");
  }, 15000);

  test("an unsupported workspaces glob fails", () => {
    const root = buildFixture({});
    const path = join(root, "package.json");
    const pkg = JSON.parse(readFileSync(path, "utf8"));
    pkg.workspaces = ["packages/**"];
    writeFileSync(path, JSON.stringify(pkg));
    expectInputFailure(root, path, "unsupported workspaces glob");
  }, 15000);

  test("a non-string override value for a reaching key fails", () => {
    const root = buildFixture({
      overrides: { "@x/dep": { ".": "1.2.3" } },
      workspaces: [declares("dependencies", { "@x/dep": "^1.2.3" })],
    });
    expectInputFailure(root, join(root, "package.json"), "is not a version string");
  }, 15000);
});

describe("check-exact-overrides — the CLI", () => {
  test("exits 0 when a parsed workspace has no matching override", () => {
    const root = buildFixture({ workspaces: [{ dir: "adapter" }] });
    const r = runCli(root);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("✓");
    expect(r.stdout).toContain("Declared direct override keys matching workspace dependencies");
  }, 15000);
});

const nonExact = [
  "1.x", "1", "^1.2.3", "~1.2.3", ">=1", "*", "latest", "npm:foo@1.x",
  "npm:foo@^1@2.0.0", "npm:@scope/foo@^1@2.0.0", "npm:foo@@2.0.0",
  "npm:@scope/@2.0.0", "npm:foo/bar@2.0.0", "npm:.foo@2.0.0",
  "npm:_foo@2.0.0", "npm:-foo@2.0.0", "npm:node_modules@2.0.0", "npm:favicon.ico@2.0.0", "npm:foo bar@2.0.0", "npm:foo%20bar@2.0.0", "npm:@/foo@2.0.0",
  "npm:@scope/foo/bar@2.0.0", "npm:foo\n@2.0.0",
];

const aliasCases: [string, boolean][] = [
  ["npm:Foo@2.0.0", true],
  ["npm:@Scope/Foo@2.0.0", true],
  ["npm:HTTP@2.0.0", true],
  ["npm:foo-bar.baz_2@2.0.0", true],
  ["npm:~foo@2.0.0", true],
  ["npm:foo!@2.0.0", true],
  ["npm:foo'@2.0.0", true],
  ["npm:foo(bar)@2.0.0", true],
  ["npm:*@2.0.0", true],
  ["npm:@.scope/_foo@2.0.0", true],
  ["npm:@_scope/-foo@2.0.0", true],
  ["npm:@scope/~foo@2.0.0", true],
  ["npm:@scope/foo.tgz@2.0.0", true],
  [`npm:${"a".repeat(215)}@2.0.0`, true],
  ["npm:foo@2.0.0-rc.1+build.2", true],
  ["npm:foo@^2.0.0", false],
  ["npm:foo@2.x", false],
  ["npm:foo@latest", false],
  ["npm:foo", false],
  ["npm:foo@", false],
  ["npm:foo@@2.0.0", false],
  ["npm:foo@^1@2.0.0", false],
  ["npm:@scope/foo@^1@2.0.0", false],
  ["npm:.foo@2.0.0", false],
  ["npm:_foo@2.0.0", false],
  ["npm:-foo@2.0.0", false],
  ["npm:Node_Modules@2.0.0", false],
  ["npm:Favicon.ico@2.0.0", false],
  ["npm:@scope/.foo@2.0.0", false],
  ["npm:@/foo@2.0.0", false],
  ["npm:@scope/@2.0.0", false],
  ["npm:foo/bar@2.0.0", false],
  ["npm:foo bar@2.0.0", false],
  ["npm:foo%20bar@2.0.0", false],
  ["npm:foo.tgz@2.0.0", false],
  ["npm:foo.tar.gz@2.0.0", false],
];

describe("alias name and version table", () => {
  for (const [value, accepted] of aliasCases) {
    test(`${JSON.stringify(value)}: ${accepted ? "exact" : "non-exact"}`, () => {
      const root = buildFixture({
        overrides: { "@x/dep": value },
        workspaces: [declares("dependencies", { "@x/dep": "1.2.3" })],
      });
      expect(findExactOverrideViolations(root).length === 0).toBe(accepted);
      expect(runCli(root).status).toBe(accepted ? 0 : 1);
    }, 15000);
  }
});

describe("version validation", () => {
  for (const value of nonExact) {
    test(`function rejects ${value}`, () => {
      const root = buildFixture({
        overrides: { "@x/dep": value },
        workspaces: [declares("dependencies", { "@x/dep": "1.2.3" })],
      });
      expect(findExactOverrideViolations(root)).toEqual([
        { name: "@x/dep", declared: value, exact: null },
      ]);
    }, 15000);
    test(`CLI rejects ${value}`, () => {
      const root = buildFixture({
        overrides: { "@x/dep": value },
        workspaces: [declares("dependencies", { "@x/dep": "1.2.3" })],
      });
      expect(runCli(root).status).toBe(1);
    }, 15000);
  }
  for (const value of ["1.2.3", "1.2.3-rc.1+build.2", "npm:foo@1.2.3", "npm:@x/foo@1.2.3-rc.1", "npm:foo-bar.baz_2@1.2.3", "npm:@scope/_foo@1.2.3"]) {
    test(`accepts ${value}`, () => {
      const root = buildFixture({
        overrides: { "@x/dep": value },
        workspaces: [declares("dependencies", { "@x/dep": "1.2.3" })],
      });
      expect(findExactOverrideViolations(root)).toEqual([]);
      expect(runCli(root).status).toBe(0);
    }, 15000);
  }
  for (const value of ["01.2.3", "1.2.3-01", "1.2.3\n", "1.2.3 trailing", "npm:foo@1.2.3 trailing"]) {
    test(`rejects invalid semver ${JSON.stringify(value)}`, () => {
      const root = buildFixture({
        overrides: { "@x/dep": value },
        workspaces: [declares("dependencies", { "@x/dep": "1.2.3" })],
      });
      expect(findExactOverrideViolations(root)).toHaveLength(1);
      expect(runCli(root).status).toBe(1);
    }, 15000);
  }
});

const legacySemverSource = String.raw`^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[\dA-Za-z-]*[A-Za-z-][\dA-Za-z-]*)(?:\.(?:0|[1-9]\d*|[\dA-Za-z-]*[A-Za-z-][\dA-Za-z-]*))*)?(?:\+[\dA-Za-z-]+(?:\.[\dA-Za-z-]+)*)?(?![\s\S])`;
const versionCases: [string, boolean][] = [
  ["1.2.3", true],
  ["0.0.0", true],
  ["0.0.0-0", true],
  ["1.2.3-alpha.1", true],
  ["1.2.3-0a", true],
  ["1.2.3--", true],
  ["1.2.3+build.5", true],
  ["1.2.3-rc.1+sha.abc", true],
  ["1.2.3-00a", true],
  ["1.2.3-123-456", true],
  ["1.2.3+001", true],
  ["1.2.3-a-b+--.0", true],
  ["99999999999999999999.2.3", true],
  ["npm:foo@1.2.3", true],
  ["npm:@scope/foo@1.2.3-rc.1+abc", true],
  ["01.2.3", false],
  ["1.02.3", false],
  ["1.2.03", false],
  ["1.2", false],
  ["1.2.3.4", false],
  ["1.2.3-", false],
  ["1.2.3-01", false],
  ["1.2.3-a..b", false],
  ["1.2.3+", false],
  ["^1.2.3", false],
  ["~1.2.3", false],
  ["1.2.x", false],
  [">=1.2.3", false],
  ["1.2.3 || 2", false],
  ["npm:foo@^1", false],
  ["npm:@1.2.3", false],
  ["1.2.3+abc+def", false],
  ["1.2.3+abc..def", false],
  ["1.2.3+abc-", true],
  ["1.2.3-α", false],
  ["1.2.3-0.01", false],
  ["1.2.3\n", false],
  ["1.2.3-a\n", false],
  ["1.2.3+a\n", false],
  ["1.2.3\r", false],
  ["1.2.3\u2028", false],
  ["1.2.3-a\u2029", false],
  ["", false],
  [" 1.2.3", false],
];

function legacyResults(values: string[], timeout: number) {
  return spawnSync(process.execPath, ["-e", `
    const pattern = new RegExp(process.env.LEGACY_SEMVER_SOURCE);
    const results = JSON.parse(process.env.LEGACY_VALUES).map(value => {
      if (pattern.test(value)) return true;
      const at = value.lastIndexOf("@");
      return value.startsWith("npm:") && at > 4 && pattern.test(value.slice(at + 1));
    });
    process.stdout.write(JSON.stringify(results));
  `], {
    encoding: "utf8", timeout,
    env: { ...process.env, LEGACY_SEMVER_SOURCE: legacySemverSource, LEGACY_VALUES: JSON.stringify(values) },
  });
}

describe("semver parser parity", () => {
  test("matches legacy results for the version table", () => {
    const old = legacyResults(versionCases.map(([value]) => value), 1000);
    expect(old.error).toBeUndefined();
    expect(old.status).toBe(0);
    const results: boolean[] = JSON.parse(old.stdout);
    for (const [index, [value, accepted]] of versionCases.entries()) {
      const root = buildFixture({
        overrides: { "@x/dep": value },
        workspaces: [declares("dependencies", { "@x/dep": "1.2.3" })],
      });
      const actual = findExactOverrideViolations(root).length === 0;
      expect(actual).toBe(accepted);
      expect(actual).toBe(results[index]);
    }
  }, 15000);

  test("rejects the CodeQL witness within the latency budget", () => {
    const witness = "0.0.0-0." + "--.".repeat(5000) + "!";
    const root = buildFixture({
      overrides: { "@x/dep": witness },
      workspaces: [declares("dependencies", { "@x/dep": "1.2.3" })],
    });
    const start = performance.now();
    const actual = findExactOverrideViolations(root).length === 0;
    const elapsed = performance.now() - start;
    expect(actual).toBe(false);
    expect(elapsed).toBeLessThan(50);
    const old = legacyResults([witness], 100);
    if (old.error) expect((old.error as NodeJS.ErrnoException).code).toBe("ETIMEDOUT");
    else {
      expect(old.status).toBe(0);
      expect(JSON.parse(old.stdout)).toEqual([actual]);
    }
  }, 15000);
});

describe("workspace declarations", () => {
  for (const value of [undefined, null, {}, "packages/*"]) {
    test(`refuses workspaces=${JSON.stringify(value)}`, () => {
      const root = buildFixture({ workspaces: [{ dir: "adapter" }] });
      const path = join(root, "package.json");
      const pkg = JSON.parse(readFileSync(path, "utf8"));
      pkg.workspaces = value;
      writeFileSync(path, JSON.stringify(pkg));
      expect(() => findExactOverrideViolations(root)).toThrow("workspaces must be an array");
      expect(runCli(root).status).toBe(2);
    }, 15000);
  }
  for (const value of [[], ["packages/*"]]) {
    test(`refuses zero manifests for ${JSON.stringify(value)}`, () => {
      const root = buildFixture({});
      const path = join(root, "package.json");
      const pkg = JSON.parse(readFileSync(path, "utf8"));
      pkg.workspaces = value;
      writeFileSync(path, JSON.stringify(pkg));
      expect(() => findExactOverrideViolations(root)).toThrow("workspaces yielded no manifests");
      expect(runCli(root).status).toBe(2);
    }, 15000);
  }
});

function git(root: string, args: string[]) {
  const result = spawnSync("git", args, {
    cwd: root, encoding: "utf8", timeout: 5000,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  return result;
}

function hookFixture(value: string) {
  const root = buildFixture({
    overrides: { "@x/dep": value },
    workspaces: [declares("dependencies", { "@x/dep": "1.2.3" })],
  });
  git(root, ["init"]);
  git(root, ["config", "core.hooksPath", ".git/hooks"]);
  mkdirSync(join(root, "scripts/git-hooks"), { recursive: true });
  copyFileSync(SCRIPT, join(root, "scripts/check-exact-overrides.mjs"));
  for (const file of ["install.sh", "pre-commit"]) {
    copyFileSync(join(import.meta.dir, "../../scripts/git-hooks", file), join(root, "scripts/git-hooks", file));
  }
  const installed = spawnSync("sh", ["scripts/git-hooks/install.sh"], { cwd: root, encoding: "utf8", timeout: 5000 });
  expect(installed.status).toBe(0);
  chmodSync(join(root, ".git/hooks/pre-commit"), 0o755);
  git(root, ["add", "."]);
  return root;
}

function runHook(root: string) {
  return spawnSync(join(root, ".git/hooks/pre-commit"), [], { cwd: root, encoding: "utf8", timeout: 5000 });
}

describe("installed pre-commit hook", () => {
  test("refuses a staged range despite an unstaged exact value", () => {
    const root = hookFixture("1.x");
    const path = join(root, "package.json");
    const pkg = JSON.parse(readFileSync(path, "utf8"));
    pkg.overrides["@x/dep"] = "1.2.3";
    writeFileSync(path, JSON.stringify(pkg));
    expect(runCli(root).status).toBe(0);
    const result = runHook(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("1.x");
  }, 15000);
  test("accepts staged exact content despite an unstaged range", () => {
    const root = hookFixture("1.2.3");
    const path = join(root, "package.json");
    const pkg = JSON.parse(readFileSync(path, "utf8"));
    pkg.overrides["@x/dep"] = "1.x";
    writeFileSync(path, JSON.stringify(pkg));
    expect(runHook(root).status).toBe(0);
  }, 15000);
  test("uses staged workspace dependencies", () => {
    const root = hookFixture("1.x");
    writeFileSync(join(root, "packages/adapter/package.json"), JSON.stringify({ name: "@x/adapter" }));
    expect(runCli(root).status).toBe(0);
    expect(runHook(root).status).toBe(1);
  }, 15000);
  test("refuses a missing checker", () => {
    const root = hookFixture("1.2.3");
    rmSync(join(root, "scripts/check-exact-overrides.mjs"));
    expect(runHook(root).status).toBe(1);
  }, 15000);
  test("refuses when the index has no workspace manifest", () => {
    const root = hookFixture("1.2.3");
    git(root, ["rm", "--cached", "packages/adapter/package.json"]);
    const result = runHook(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("workspaces yielded no manifests");
  }, 15000);
  test("accepts a missing staged bun.lock", () => {
    const root = hookFixture("1.2.3");
    git(root, ["rm", "--cached", "bun.lock"]);
    writeFileSync(join(root, "bun.lock"), "invalid JSON");
    expect(runHook(root).status).toBe(0);
  }, 15000);
  test("refuses a malformed staged bun.lock", () => {
    const root = hookFixture("1.2.3");
    writeFileSync(join(root, "bun.lock"), "invalid JSON");
    git(root, ["add", "bun.lock"]);
    writeFileSync(join(root, "bun.lock"), JSON.stringify({ packages: {} }));
    const result = runHook(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("bun.lock is not parsable");
  }, 15000);
});

describe("Bun local override seam", () => {
  test("root override changes a workspace's file dependency resolution", () => {
    for (const override of [undefined, "2.0.0", "^2.0.0"]) {
      const root = buildFixture({
        overrides: override ? { "seam-dep": override } : undefined,
        workspaces: [
          { dir: "adapter", json: { name: "seam-adapter", version: "1.0.0", dependencies: { "seam-dep": "file:../../old" } } },
          { dir: "dep", json: { name: "seam-dep", version: "2.0.0" } },
        ],
      });
      rmSync(join(root, "bun.lock"));
      mkdirSync(join(root, "old"));
      writeFileSync(join(root, "old/package.json"), JSON.stringify({ name: "seam-dep", version: "1.0.0" }));
      const path = join(root, "package.json");
      const pkg = JSON.parse(readFileSync(path, "utf8"));
      pkg.dependencies = { "seam-adapter": "file:packages/adapter" };
      writeFileSync(path, JSON.stringify(pkg));
      const home = join(root, "home");
      mkdirSync(home);
      const installed = spawnSync(process.execPath, [
        "install", "--ignore-scripts", "--linker", "hoisted",
        "--cache-dir", join(root, "cache"), "--registry", "http://127.0.0.1:1",
      ], {
        cwd: root, encoding: "utf8", timeout: 10000,
        env: { ...process.env, HOME: home, USERPROFILE: home, BUN_INSTALL_CACHE_DIR: join(root, "cache") },
      });
      expect(installed.error).toBeUndefined();
      expect(installed.status).toBe(0);
      const require = createRequire(join(root, "packages/adapter/package.json"));
      const resolved = JSON.parse(readFileSync(require.resolve("seam-dep/package.json"), "utf8"));
      expect(resolved.version).toBe(override ? "2.0.0" : "1.0.0");
      const lock = JSON.parse(readFileSync(join(root, "bun.lock"), "utf8").replace(/,(\s*[}\]])/g, "$1"));
      expect(lock.packages["seam-dep"][0]).toBe("seam-dep@workspace:packages/dep");
      if (!override) expect(lock.packages["seam-adapter/seam-dep"][0]).toBe("seam-dep@file:old");
      expect(findExactOverrideViolations(root)).toEqual(override === "^2.0.0"
        ? [{ name: "seam-dep", declared: override, exact: null }]
        : []);
      const result = runCli(root);
      expect(result.status).toBe(override === "^2.0.0" ? 1 : 0);
      if (override === "^2.0.0") {
        expect(result.stderr).toContain("choose an exact version or a workspace: specifier");
        expect(result.stderr).not.toContain("registry");
      }
    }
  }, 45000);
});
