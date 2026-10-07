/**
 * check-exact-overrides — the guard that fails when a root `overrides` entry
 * that reaches a workspace dependency declares a version range (flair#2301).
 *
 * Fixture trees only: no network, no install. The scope is pinned by fixtures:
 * only a root override whose key a workspace package declares under
 * dependencies / devDependencies / optionalDependencies is checked; a
 * workspace's own ranges and `peerDependencies` are out of scope; `workspace:`
 * specifiers are exempt.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findExactOverrideViolations } from "../../scripts/check-exact-overrides.mjs";
import { tempDir } from "../helpers/temp-dir.ts";

const SCRIPT = join(import.meta.dir, "../../scripts/check-exact-overrides.mjs");

interface WsPkg {
  dir: string;
  json?: Record<string, unknown>;
}

/** `[resolution, registry, meta, integrity]` — the shape bun.lock's packages map holds. */
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
  return spawnSync(process.execPath, [SCRIPT, "--root", root], { encoding: "utf8" });
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
  });

  test("(b) the same override exact PASSES", () => {
    const root = buildFixture({
      overrides: { "@x/dep": "1.2.3" },
      workspaces: [declares("dependencies", { "@x/dep": "^1.2.3" })],
      packages: { "@x/dep": res("@x/dep", "1.2.3") },
    });
    expect(findExactOverrideViolations(root)).toEqual([]);
    expect(runCli(root).status).toBe(0);
  });

  test("(c) a range override for a package NO workspace declares PASSES", () => {
    const root = buildFixture({
      overrides: { "@x/other": "^1.2.3" },
      workspaces: [declares("dependencies", { "@x/dep": "^1.2.3" })],
      packages: { "@x/other": res("@x/other", "1.2.3") },
    });
    expect(findExactOverrideViolations(root)).toEqual([]);
    expect(runCli(root).status).toBe(0);
  });

  test("(d) a workspace's OWN dependency range PASSES (out of scope)", () => {
    const root = buildFixture({
      workspaces: [declares("dependencies", { "@x/dep": "^1.2.3" })],
      packages: { "@x/dep": res("@x/dep", "1.2.3") },
    });
    expect(findExactOverrideViolations(root)).toEqual([]);
    expect(runCli(root).status).toBe(0);
  });

  test("(e) a peerDependency range PASSES (out of scope), even with a matching override", () => {
    const root = buildFixture({
      overrides: { "@x/peer": "^2.0.0" },
      workspaces: [declares("peerDependencies", { "@x/peer": "^2.0.0" })],
      packages: { "@x/peer": res("@x/peer", "2.0.0") },
    });
    expect(findExactOverrideViolations(root)).toEqual([]);
    expect(runCli(root).status).toBe(0);
  });

  test("(f) a `workspace:*` override PASSES (exempt)", () => {
    const root = buildFixture({
      overrides: { "@x/dep": "workspace:*" },
      workspaces: [declares("dependencies", { "@x/dep": "workspace:*" })],
    });
    expect(findExactOverrideViolations(root)).toEqual([]);
    expect(runCli(root).status).toBe(0);
  });

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
  });

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
    expect(r.stderr).toContain("the exact version the registry resolves");
  });
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

  test("a missing root package.json fails", () => {
    const root = buildFixture({});
    rmSync(join(root, "package.json"));
    expectInputFailure(root, join(root, "package.json"), "cannot read");
  });

  test("a malformed root package.json fails", () => {
    const root = buildFixture({});
    const path = join(root, "package.json");
    writeFileSync(path, '{ "name": ');
    expectInputFailure(root, path, "not parsable");
  });

  test("a malformed workspace package.json fails", () => {
    const root = buildFixture({ workspaces: [declares("dependencies", { "@x/dep": "^1.2.3" })] });
    const path = join(root, "packages/adapter/package.json");
    writeFileSync(path, "invalid JSON");
    expectInputFailure(root, path, "not parsable");
  });

  test("an unreadable packages/ directory fails", () => {
    const root = buildFixture({});
    rmSync(join(root, "packages"), { recursive: true });
    writeFileSync(join(root, "packages"), "not a directory");
    expectInputFailure(root, join(root, "packages"), "cannot read");
  });

  test("an unsupported workspaces glob fails", () => {
    const root = buildFixture({});
    const path = join(root, "package.json");
    const pkg = JSON.parse(readFileSync(path, "utf8"));
    pkg.workspaces = ["packages/**"];
    writeFileSync(path, JSON.stringify(pkg));
    expectInputFailure(root, path, "unsupported workspaces glob");
  });

  test("a non-string override value for a reaching key fails", () => {
    const root = buildFixture({
      overrides: { "@x/dep": { ".": "1.2.3" } },
      workspaces: [declares("dependencies", { "@x/dep": "^1.2.3" })],
    });
    expectInputFailure(root, join(root, "package.json"), "is not a version string");
  });
});

describe("check-exact-overrides — the CLI", () => {
  test("exits 0 with the success line when nothing reaches a range", () => {
    const root = buildFixture({});
    const r = runCli(root);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("✓");
    expect(r.stdout).toContain("root override that reaches a workspace dependency");
  });
});
