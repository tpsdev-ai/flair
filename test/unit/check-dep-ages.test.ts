/**
 * test/unit/check-dep-ages.test.ts — test the collectDeps function in
 * scripts/lib/check-dep-ages-collect.mjs against literal fixture inputs, and
 * the CLI's fail-closed exit codes against a fixture repo:
 *    exit 2: dead registry (FLAIR_NPM_REGISTRY=http://127.0.0.1:1)
 *    exit 1: too-fresh dep (a fixture registry in this process that reports
 *            the dep as published "now", against the default 7-day policy)
 *
 * The CLI cases spawn `node scripts/check-dep-ages.mjs` directly. The script
 * path is derived from this file's location, never from the working directory,
 * and a broken setup (a missing script, a fixture that was not written, a
 * registry that did not bind) throws before the CLI runs. It can never pass as
 * exit 1: `node` exits 1 on a missing entry file too, which is why every CLI
 * case also asserts the gate's own diagnostic, and the too-fresh cases the
 * request the gate made to the fixture registry.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  collectDeps,
  collectRangedDeps,
  collectUnsupportedDeps,
  collectUnsupportedOverrides,
  parseBunLockText,
  resolveRangedDeps,
} from "../../scripts/lib/check-dep-ages-collect.mjs";
import { checkCoverageGate, gateCases, parseWorkflows, type Gate, type WorkflowDoc } from "../helpers/workflow-gate";

/* ─────────────────────────── Unit tests ───────────────────────────── */


/** A registry that reports FIXTURE_VERSION with a PRESENT but unparseable time. */
function unparseableRegistry(value: unknown = "not-a-timestamp") {
  const requests: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      requests.push(new URL(req.url).pathname);
      return Response.json({ time: { [FIXTURE_VERSION]: value } });
    },
  });
  if (!server.port) setupFailure("fixture registry did not bind a port");
  return { url: `http://127.0.0.1:${server.port}`, requests, stop: () => server.stop(true) };
}

describe("collectDeps", () => {
  const keepCurrent = new Set(["harper", "some-skip"]);

  // Helper: build a pkg with only `dependencies` (no optionalDeps, no peerDeps)
  const pkgsDeps = (deps: Record<string,string>, p: string) => [
    { pkg: { dependencies: deps }, path: p },
  ];
  const pkgsOpts = (deps: Record<string,string>, p: string) => [
    { pkg: { optionalDependencies: deps }, path: p },
  ];
  const pkgsPeer = (deps: Record<string,string>, p: string) => [
    { pkg: { peerDependencies: deps }, path: p },
  ];

  /* dependencies */
  describe("dependencies", () => {
    it("does not collect a digit-leading range like 1.x as an exact pin", () => {
      // The same classifier the override grammar uses reads `1.x` as a range,
      // so it is never fetched as the exact version `1.x`.
      expect(collectDeps(pkgsDeps({"some-pkg":"1.x"},"packages/foo/package.json"), keepCurrent).size).toBe(0);
    });
    it("does not collect a range like ^1 as an exact pin", () => {
      expect(collectDeps(pkgsDeps({"some-pkg":"^1"},"packages/foo/package.json"), keepCurrent).size).toBe(0);
    });
    it("collects an exact dependencies pin", () => {
      const result = collectDeps(pkgsDeps({"some-pkg":"1.2.3"},"packages/foo/package.json"), keepCurrent);
      expect(result.size).toBe(1);
      expect(result.get("some-pkg@1.2.3")).toEqual({
        name: "some-pkg", version: "1.2.3",
        declaredIn: ["packages/foo/package.json"],
       });
     });
   });

   /* optionalDependencies */
  describe("optionalDependencies", () => {
    it("collects exact optional pin with correct declaredIn", () => {
      const result = collectDeps(pkgsOpts({"some-opt":"4.5.6"},"packages/bar/package.json"), keepCurrent);
      expect(result.size).toBe(1);
      expect(result.get("some-opt@4.5.6")).toEqual({
        name: "some-opt", version: "4.5.6",
        declaredIn: ["packages/bar/package.json"],
       });
     });
    it("skips an optional range like ^1.2.3", () => {
      expect(collectDeps(pkgsOpts({"some-opt":"^1.2.3"},"packages/bar/package.json"), keepCurrent).size).toBe(0);
     });
    it("skips an optional @tpsdev-ai/* pin", () => {
      expect(collectDeps(pkgsOpts({"@tpsdev-ai/internal":"1.0.0"},"packages/internal/package.json"), keepCurrent).size).toBe(0);
     });
   });

   /* peerDependencies */
  describe("peerDependencies", () => {
    it("does NOT collect an exact peerDependencies pin", () => {
      expect(collectDeps(pkgsPeer({"some-peer":"7.8.9"},"packages/peer/package.json"), keepCurrent).size).toBe(0);
     });
   });

   /* cross-package dedup */
  describe("cross-package dedup", () => {
    it("one entry for same name@version in two packages", () => {
      const result = collectDeps([
           { pkg: { dependencies: {"shared-pkg":"2.0.0"} }, path: "packages/a/package.json" },
           { pkg: { optionalDependencies: {"shared-pkg":"2.0.0"} }, path: "packages/b/package.json" },
        ], keepCurrent);
      expect(result.size).toBe(1);
      expect(result.get("shared-pkg@2.0.0")!.declaredIn.sort()).toEqual([
           "packages/a/package.json", "packages/b/package.json",
        ]);
     });
   });

  /* overrides */
  describe("overrides", () => {
    const pkgsOverrides = (overrides: Record<string,string>, p: string) => [
      { pkg: { overrides }, path: p },
    ];

    it("collects an exact override pin from the root manifest", () => {
      const result = collectDeps(pkgsOverrides({"some-pin":"1.2.3"},"package.json"), keepCurrent);
      expect(result.size).toBe(1);
      expect(result.get("some-pin@1.2.3")).toEqual({
        name: "some-pin", version: "1.2.3", declaredIn: ["package.json"],
      });
    });

    it("collects an exact override pin from a workspace manifest", () => {
      const result = collectDeps(pkgsOverrides({"some-pin":"1.2.3"},"packages/foo/package.json"), keepCurrent);
      expect(result.get("some-pin@1.2.3")!.declaredIn).toEqual(["packages/foo/package.json"]);
    });

    it("checks the target of an npm: alias, not the alias key", () => {
      const result = collectDeps(pkgsOverrides({"alias-key":"npm:real-pkg@2.0.0"},"package.json"), keepCurrent);
      expect(result.size).toBe(1);
      expect(result.has("real-pkg@2.0.0")).toBe(true);
      expect(result.has("alias-key@2.0.0")).toBe(false);
    });

    it("skips a non-exact override range", () => {
      expect(collectDeps(pkgsOverrides({"some-pin":"^1.2.3"},"package.json"), keepCurrent).size).toBe(0);
    });

    it("collects a pin nested under a parent package and through a \".\" self key", () => {
      const result = collectDeps([
        { pkg: { overrides: { "parent-dep": { "nested-pin": "1.2.3" }, "self-pin": { ".": "4.5.6" } } }, path: "package.json" },
      ], keepCurrent);
      expect([...result.keys()].sort()).toEqual(["nested-pin@1.2.3", "self-pin@4.5.6"]);
    });

    it("names the package of a selector key, not the key", () => {
      const result = collectDeps(pkgsOverrides({"some-pin@^1":"1.2.3"},"package.json"), keepCurrent);
      expect([...result.keys()]).toEqual(["some-pin@1.2.3"]);
    });

    it("skips a digit-leading range like 1.x", () => {
      expect(collectDeps(pkgsOverrides({"some-pin":"1.x"},"package.json"), keepCurrent).size).toBe(0);
    });

    it("dedups a pin declared in both dependencies and overrides of one manifest", () => {
      const result = collectDeps([
        { pkg: { dependencies: {"some-pin":"1.2.3"}, overrides: {"some-pin":"1.2.3"} }, path: "package.json" },
      ], keepCurrent);
      expect(result.size).toBe(1);
      expect(result.get("some-pin@1.2.3")!.declaredIn).toEqual(["package.json"]);
    });
  });
});

/* ── Ranged declarations, resolved through bun.lock ─────────────────── */

describe("collectRangedDeps", () => {
  const keepCurrent = new Set(["some-skip"]);

  it("collects a dependencies range with its workspace directory", () => {
    expect(collectRangedDeps([
      { pkg: { dependencies: { "some-pin": "^1.2.3" } }, path: "packages/foo/package.json" },
    ], keepCurrent)).toEqual([{
      kind: "dependency",
      field: "dependencies",
      name: "some-pin",
      target: "some-pin",
      spec: "^1.2.3",
      declaredIn: "packages/foo/package.json",
      at: 'dependencies["some-pin"]',
      workspaceDir: "packages/foo",
    }]);
  });

  it("collects a devDependencies range", () => {
    expect(collectRangedDeps([
      { pkg: { devDependencies: { "some-dev": "1.x" } }, path: "package.json" },
    ], keepCurrent)[0]).toMatchObject({ field: "devDependencies", spec: "1.x", workspaceDir: "" });
  });

  it("does not collect an exact pin", () => {
    expect(collectRangedDeps([
      { pkg: { dependencies: { "some-pin": "1.2.3" }, overrides: { "some-other": "1.2.3" } }, path: "package.json" },
    ], keepCurrent)).toEqual([]);
  });

  it("skips the keep-current list and workspace-internal packages", () => {
    expect(collectRangedDeps([
      { pkg: { dependencies: { "some-skip": "^1.0.0", "@tpsdev-ai/internal": "^1.0.0" } }, path: "package.json" },
    ], keepCurrent)).toEqual([]);
  });

  it("collects an override range with its full key path and selectors", () => {
    expect(collectRangedDeps([
      { pkg: { overrides: { "some-pin": "1.0.0 || 2.0.0", "outer-dep@^1": { "parent-dep": { "nested-pin": "1 - 2" } } } }, path: "package.json" },
    ], keepCurrent)).toEqual([
      {
        kind: "override", name: "some-pin", target: "some-pin", spec: "1.0.0 || 2.0.0", declaredIn: "package.json",
        at: 'overrides["some-pin"]', workspaceDir: "", path: [{ name: "some-pin", selector: "*" }],
      },
      {
        // An object value without a "." key overrides its package with the key's selector.
        kind: "override", name: "outer-dep", target: "outer-dep", spec: "^1", declaredIn: "package.json",
        at: 'overrides["outer-dep@^1"]', workspaceDir: "", path: [{ name: "outer-dep", selector: "^1" }],
      },
      {
        kind: "override", name: "nested-pin", target: "nested-pin", spec: "1 - 2", declaredIn: "package.json",
        at: 'overrides["outer-dep@^1"]["parent-dep"]["nested-pin"]', workspaceDir: "",
        path: [{ name: "outer-dep", selector: "^1" }, { name: "parent-dep", selector: "*" }, { name: "nested-pin", selector: "*" }],
      },
    ]);
  });

  it("reports an npm: alias range against its target package", () => {
    expect(collectRangedDeps([
      { pkg: { dependencies: { "some-alias": "npm:real-pkg@^2.0.0" } }, path: "package.json" },
    ], keepCurrent)[0]).toMatchObject({ name: "some-alias", target: "real-pkg", spec: "npm:real-pkg@^2.0.0" });
  });
});

describe("resolveRangedDeps", () => {
  const lock = parseBunLockText(JSON.stringify({
    workspaces: {
      "": { name: "root-ws" },
      "packages/ws-a": { name: "ws-a" },
    },
    packages: {
      "some-pin": ["some-pin@1.2.3", "", {}, "sha512-x"],
      "ws-a/some-pin": ["some-pin@2.0.0", "", {}, "sha512-x"],
      "parent-dep": ["parent-dep@1.0.0", "", { dependencies: { "some-pin": "^3.0.0" } }, "sha512-x"],
      "parent-dep/some-pin": ["some-pin@3.0.0", "", {}, "sha512-x"],
      "@scope/pkg": ["@scope/pkg@4.0.0", "", {}, "sha512-x"],
      "some-alias": ["other-pkg@1.0.0", "", {}, "sha512-x"],
      "no-meta": ["no-meta@1.0.0"],
    },
  }));

  it("resolves a root dependency range through the hoisted entry", () => {
    const deps = collectRangedDeps([{ pkg: { dependencies: { "some-pin": "^1.0.0" } }, path: "package.json" }], new Set());
    expect(resolveRangedDeps(deps, lock).resolved).toEqual([
      { name: "some-pin", version: "1.2.3", spec: "^1.0.0", declaredIn: "package.json", at: 'dependencies["some-pin"]', kind: "dependency" },
    ]);
  });

  it("prefers the workspace's own resolution over the hoisted one", () => {
    const deps = collectRangedDeps([{ pkg: { name: "ws-a", dependencies: { "some-pin": "^1.0.0" } }, path: "packages/ws-a/package.json" }], new Set());
    expect(resolveRangedDeps(deps, lock).resolved[0].version).toBe("2.0.0");
  });

  it("resolves an override range to every copy of the package", () => {
    const deps = collectRangedDeps([{ pkg: { overrides: { "some-pin": "^1.0.0" } }, path: "package.json" }], new Set());
    expect(resolveRangedDeps(deps, lock).resolved.map((r) => r.version).sort()).toEqual(["1.2.3", "2.0.0", "3.0.0"]);
  });

  it("limits a nested override to copies under its enclosing package", () => {
    const deps = collectRangedDeps([{ pkg: { overrides: { "parent-dep": { "some-pin": "^1.0.0" } } }, path: "package.json" }], new Set());
    expect(resolveRangedDeps(deps, lock).resolved.map((r) => r.version)).toEqual(["3.0.0"]);
  });

  it("returns an unresolved range instead of skipping it", () => {
    const deps = collectRangedDeps([{ pkg: { dependencies: { "some-pin": "^1.0.0", "absent-dep": "^1.0.0" } }, path: "package.json" }], new Set());
    expect(resolveRangedDeps(deps, lock).unresolved).toEqual([{
      kind: "dependency",
      name: "absent-dep",
      spec: "^1.0.0",
      declaredIn: "package.json",
      at: 'dependencies["absent-dep"]',
      reason: "bun.lock has no entry for absent-dep",
    }]);
  });

  it("fails an entry that installs a different package than the declaration names", () => {
    const deps = collectRangedDeps([{ pkg: { dependencies: { "some-alias": "npm:some-pin@^1.0.0" } }, path: "package.json" }], new Set());
    const { resolved, unresolved } = resolveRangedDeps(deps, lock);
    expect(resolved).toEqual([]);
    expect(unresolved.map((u) => u.reason)).toEqual(["bun.lock's some-alias entry installs other-pkg@1.0.0, not some-pin"]);
  });

  it("fails a nested override whose enclosing key has a version selector, never guessing its scope", () => {
    const deps = collectRangedDeps([{ pkg: { overrides: { "parent-dep@^1": { "some-pin": "^3.0.0" } } }, path: "package.json" }], new Set());
    const { resolved, unresolved } = resolveRangedDeps(deps, lock);
    expect(resolved).toEqual([]);
    // The rule for parent-dep itself (its key's selector) and the nested rule.
    expect(unresolved.map((u) => u.at)).toEqual(['overrides["parent-dep@^1"]', 'overrides["parent-dep@^1"]["some-pin"]']);
    for (const u of unresolved) expect(u.reason).toContain('the key "parent-dep@^1" has a version selector');
  });

  it("fails a nested override when the lock does not record an enclosing copy's dependencies", () => {
    const deps = collectRangedDeps([{ pkg: { overrides: { "no-meta": { "some-pin": "^1.0.0" } } }, path: "package.json" }], new Set());
    const { resolved, unresolved, uninstalled } = resolveRangedDeps(deps, lock);
    expect(resolved).toEqual([]);
    expect(uninstalled).toEqual([]);
    expect(unresolved.map((u) => u.reason)).toEqual([
      "bun.lock does not record the dependencies of no-meta, so the copies below it cannot be decided",
    ]);
  });

  it("reports a nested override whose enclosing package is not installed, and selects no copy", () => {
    const deps = collectRangedDeps([{ pkg: { overrides: { "absent-parent": { "some-pin": "^1.0.0" } } }, path: "package.json" }], new Set());
    const { resolved, unresolved, uninstalled } = resolveRangedDeps(deps, lock);
    expect(resolved).toEqual([]);
    expect(unresolved).toEqual([]);
    expect(uninstalled).toEqual([{
      kind: "override",
      name: "some-pin",
      spec: "^1.0.0",
      declaredIn: "package.json",
      at: 'overrides["absent-parent"]["some-pin"]',
    }]);
  });

  it("refuses an unreadable packages map or lock entry instead of skipping it", () => {
    const deps = collectRangedDeps([{ pkg: { overrides: { "some-pin": "^1.0.0" } }, path: "package.json" }], new Set());
    expect(() => resolveRangedDeps(deps, { packages: [] } as never)).toThrow('bun.lock "packages" must be an object, not an array');
    expect(() => resolveRangedDeps(deps, { workspaces: { "": { name: "root-ws" } }, packages: { "some-pin": ["some-pin"] } })).toThrow(
      'bun.lock packages["some-pin"] does not name a package and version',
    );
  });

  it("refuses a workspaces map it cannot read: not an object, a bad key, a missing name, a non-object field", () => {
    const deps = collectRangedDeps([{ pkg: { dependencies: { "some-pin": "^1.0.0" } }, path: "package.json" }], new Set());
    const withWorkspaces = (workspaces: unknown) => ({ workspaces, packages: { "some-pin": ["some-pin@1.2.3", "", {}, "sha512-x"] } }) as never;
    expect(() => resolveRangedDeps(deps, withWorkspaces(undefined))).toThrow('bun.lock has no "workspaces" object');
    expect(() => resolveRangedDeps(deps, withWorkspaces("root-ws"))).toThrow('bun.lock "workspaces" must be an object, not a string');
    expect(() => resolveRangedDeps(deps, withWorkspaces({ "": { name: "root-ws" }, "/abs/ws": { name: "ws" } }))).toThrow(
      'bun.lock workspaces["/abs/ws"]: the key is not a relative workspace path',
    );
    expect(() => resolveRangedDeps(deps, withWorkspaces({ "": { name: "root-ws" }, "packages/../ws": { name: "ws" } }))).toThrow(
      'bun.lock workspaces["packages/../ws"]: the key is not a relative workspace path',
    );
    expect(() => resolveRangedDeps(deps, withWorkspaces({ "": "root-ws" }))).toThrow('bun.lock workspaces[""] must be an object, not a string');
    expect(() => resolveRangedDeps(deps, withWorkspaces({ "": { name: "" } }))).toThrow('bun.lock workspaces[""] must have a non-empty string "name"');
    expect(() => resolveRangedDeps(deps, withWorkspaces({ "": { name: "root-ws", dependencies: [] } }))).toThrow(
      'bun.lock workspaces[""].dependencies must be an object, not an array',
    );
  });

  it("resolves a scoped package name from a lock key", () => {
    const deps = collectRangedDeps([{ pkg: { dependencies: { "@scope/pkg": "^4.0.0" } }, path: "package.json" }], new Set());
    expect(resolveRangedDeps(deps, lock).resolved[0].version).toBe("4.0.0");
  });
});

describe("collectUnsupportedOverrides", () => {
  it("names the manifest, the rule and the reason", () => {
    const unsupported = collectUnsupportedOverrides([
      { pkg: { overrides: { "parent-dep": { "some-pin": "latest" } } }, path: "packages/foo/package.json" },
    ]);
    expect(unsupported).toEqual([{
      declaredIn: "packages/foo/package.json",
      at: 'overrides["parent-dep"]["some-pin"]',
      reason: '"latest" is not an exact version, a semver range or an npm: alias of one',
    }]);
  });

  it("refuses a value that is neither a string nor an object", () => {
    const unsupported = collectUnsupportedOverrides([{ pkg: { overrides: { "some-pin": 1 } }, path: "package.json" }]);
    expect(unsupported.map((u) => u.at)).toEqual(['overrides["some-pin"]']);
  });
});

/* ───────────── CLI fail-closed exit tests ─────────────────────────── */

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CLI_SCRIPT = join(REPO_ROOT, "scripts", "check-dep-ages.mjs");
const COLLECT_LIB = join(REPO_ROOT, "scripts", "lib", "check-dep-ages-collect.mjs");

/** The one exact external pin every fixture repo declares. */
const FIXTURE_DEP = "fixture-dep";
const FIXTURE_VERSION = "1.0.0";
/** A positive policy: a dep published "now" is too fresh under it. */
const MIN_AGE_DAYS = "7";
/** A publish time one day before the test clock: inside the policy window on any run date. */
const FRESH_TIME = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
/** The publish date the gate prints for FRESH_TIME. */
const FRESH_DATE = FRESH_TIME.slice(0, 10);
const OLD_TIME = "2020-01-01T00:00:00.000Z";

/** A broken test setup fails as itself, never as the CLI exit a case expects. */
function setupFailure(what: string): never {
  throw new Error(`test setup failed before the gate ran: ${what}`);
}

let scratch = "";

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "flair-dep-ages-"));
});

afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

/** Write a repo root with one exact external pin and an empty packages/ dir. */
function writeFixtureRepo(root: string): string {
  mkdirSync(join(root, "packages"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({
    name: "dep-ages-fixture",
    version: "0.0.0",
    dependencies: { [FIXTURE_DEP]: FIXTURE_VERSION },
  }));
  if (!existsSync(join(root, "package.json"))) setupFailure(`fixture package.json not written under ${root}`);
  return root;
}

/** Write a repo root whose only pin is an `overrides` entry, and an empty packages/ dir. */
function writeOverrideFixtureRepo(root: string, overrides: Record<string, unknown>): string {
  mkdirSync(join(root, "packages"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({
    name: "dep-ages-overrides-fixture",
    version: "0.0.0",
    overrides,
  }));
  if (!existsSync(join(root, "package.json"))) setupFailure(`fixture package.json not written under ${root}`);
  return root;
}

/** Write a repo root with the given manifest object and an empty packages/ dir. */
function writeManifestRepo(root: string, manifest: Record<string, unknown>): string {
  mkdirSync(join(root, "packages"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify(manifest));
  if (!existsSync(join(root, "package.json"))) setupFailure(`fixture package.json not written under ${root}`);
  return root;
}

/** Write a fixture bun.lock. Plain JSON is valid for the gate's parser. */
function writeLock(root: string, lock: Record<string, unknown>): void {
  writeFileSync(join(root, "bun.lock"), JSON.stringify(lock));
  if (!existsSync(join(root, "bun.lock"))) setupFailure(`fixture bun.lock not written under ${root}`);
}

/**
 * A lockfile whose `packages` map is one entry per `{ key: version }`, each
 * resolving the key's own package; `workspaces` defaults to the root alone.
 */
function lockWithPackages(versions: Record<string, string>, workspaces: Record<string, unknown> = { "": { name: "dep-ages-fixture" } }) {
  const packages: Record<string, unknown> = {};
  for (const [key, version] of Object.entries(versions)) {
    const parts = key.split("/");
    const name = parts.length > 1 && parts[parts.length - 2].startsWith("@") ? parts.slice(-2).join("/") : parts[parts.length - 1];
    packages[key] = [`${name}@${version}`, "", {}, "sha512-fixture"];
  }
  return { workspaces, packages };
}

/** Write the gate's dated exemption allowlist under a fixture root's .github/. */
function writeAllowlist(root: string, entries: unknown[]): void {
  mkdirSync(join(root, ".github"), { recursive: true });
  writeFileSync(join(root, ".github", "dep-age-allowlist.json"), JSON.stringify({ entries }));
}

/** One well-formed dated exemption for the fixture pin, added on `added`, expiring on `expires`. */
function exemption(added: string, expires: string): Record<string, unknown> {
  return {
    package: FIXTURE_DEP,
    version: FIXTURE_VERSION,
    ghsa: ["GHSA-1234-5678-9abc"],
    added,
    expires,
    reason: "fixture: a security pin younger than the bake window",
  };
}

/**
 * Run the gate as its own process. Async on purpose: the too-fresh cases serve
 * the child's registry request from this same process, and a synchronous spawn
 * would block that server's event loop. The env is built explicitly (no
 * ambient FLAIR_* can change the policy, the keep-current list or the root).
 */
async function runGate(script: string, extraEnv: Record<string, string>, extraArgs: string[] = []) {
  if (!existsSync(script)) setupFailure(`gate script not found at ${script}`);
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    ...(extraArgs.includes("--ci") ? {} : { FLAIR_DEP_MIN_AGE_DAYS: MIN_AGE_DAYS }),
    ...extraEnv,
  };
  const proc = Bun.spawn(["node", script, ...extraArgs], {
    env,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 20_000,
    killSignal: "SIGKILL",
  });
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { exitCode, output: stdout + stderr };
}

/** A registry that reports FIXTURE_VERSION as published at the moment of the request. */
function freshRegistry() {
  const requests: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      requests.push(new URL(req.url).pathname);
      return Response.json({ time: { [FIXTURE_VERSION]: new Date().toISOString() } });
    },
  });
  if (!server.port) setupFailure("fixture registry did not bind a port");
  return { url: `http://127.0.0.1:${server.port}`, requests, stop: () => server.stop(true) };
}

/** A registry reporting a publish time per version; an unknown version has none. */
function registryWithTimes(times: Record<string, string>) {
  const requests: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      requests.push(new URL(req.url).pathname);
      return Response.json({ time: times });
    },
  });
  if (!server.port) setupFailure("fixture registry did not bind a port");
  return { url: `http://127.0.0.1:${server.port}`, requests, stop: () => server.stop(true) };
}

/** A well-formed integrity value for packuments; `--lockfile-only` downloads no tarball to compare it with. */
const PACKUMENT_INTEGRITY = `sha512-${new Bun.CryptoHasher("sha512").update("dep-ages fixture").digest("base64")}`;

/**
 * Generate a REAL bun.lock in `root`: `bun install --lockfile-only` for
 * `manifest`, against a registry served from this process whose packuments
 * carry each version's dependencies (`packages[name][version]`). Returns the
 * parsed lockfile. No tarball is fetched.
 */
async function bunGeneratedLock(
  root: string,
  manifest: Record<string, unknown>,
  packages: Record<string, Record<string, Record<string, string>>>,
) {
  mkdirSync(join(root, "packages"), { recursive: true });
  mkdirSync(join(root, ".bun-home"), { recursive: true });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req): Response {
      const url = new URL(req.url);
      const name = decodeURIComponent(url.pathname.slice(1));
      const versions = packages[name];
      if (!versions) return new Response("{}", { status: 404 });
      const base = url.origin;
      const entries: Array<[string, unknown]> = Object.entries(versions).map(([version, dependencies]) => [version, {
        name,
        version,
        dependencies,
        dist: { tarball: `${base}/${name}/-/${name.split("/").pop()}-${version}.tgz`, integrity: PACKUMENT_INTEGRITY },
      }]);
      return Response.json({ name, "dist-tags": { latest: entries[entries.length - 1][0] }, versions: Object.fromEntries(entries) });
    },
  });
  if (!server.port) setupFailure("fixture npm registry did not bind a port");
  try {
    writeFileSync(join(root, "package.json"), JSON.stringify(manifest));
    writeFileSync(join(root, "bunfig.toml"), `[install]\nregistry = "http://127.0.0.1:${server.port}/"\n`);
    const proc = Bun.spawn([process.execPath, "install", "--lockfile-only", "--ignore-scripts"], {
      cwd: root,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: join(root, ".bun-home"),
        BUN_INSTALL_CACHE_DIR: join(root, ".bun-home", "cache"),
        TMPDIR: tmpdir(),
      },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 30_000,
      killSignal: "SIGKILL",
    });
    const exitCode = await proc.exited;
    const output = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
    if (exitCode !== 0) setupFailure(`bun install --lockfile-only exited ${exitCode}: ${output}`);
    return parseBunLockText(readFileSync(join(root, "bun.lock"), "utf8"));
  } finally {
    server.stop(true);
  }
}

/** The `name@version` a real lock's entry resolves, keyed by lock key. */
function lockResolutions(lock: { packages?: Record<string, unknown> }) {
  return Object.fromEntries(Object.entries(lock.packages ?? {}).map(([key, entry]) => [key, (entry as string[])[0]]));
}

/*
 * Real bun.lock fixtures (bun install against the in-process registry above).
 *
 * Aliases: bun installs `"some-alias": "npm:fixture-dep@~1.0.0"` under the
 * alias key, its entry resolving `fixture-dep@1.0.5`, while the directly
 * declared fixture-dep resolves 1.2.0 under its own key.
 */
const ALIAS_PACKAGES = {
  [FIXTURE_DEP]: { "1.0.0": {}, "1.0.5": {}, "1.2.0": {} },
  "wrapper-dep": { "1.0.0": { "wrapped-dep": "^1.0.0" } },
  "wrapped-dep": { "1.0.0": {} },
};
const ALIAS_MANIFEST = {
  name: "dep-ages-alias-lock-fixture",
  version: "0.0.0",
  dependencies: { "some-alias": `npm:${FIXTURE_DEP}@~1.0.0`, [FIXTURE_DEP]: "^1.2.0", "wrapper-dep": "1.0.0" },
  overrides: { "wrapped-dep": `npm:${FIXTURE_DEP}@~1.0.0` },
};

/*
 * Nested overrides: outer-dep -> inner-dep@1 -> child-dep ~1.1.0 and
 * other-dep -> inner-dep@2 -> child-dep ~1.2.0, with child-dep@2.0.0 at the
 * root. Bun writes three child-dep copies (bun 1.3.10 warns that it does not
 * support nested overrides, so these are its own resolutions).
 */
const NESTED_PACKAGES = {
  "child-dep": { "1.1.0": {}, "1.1.5": {}, "1.2.0": {}, "1.2.5": {}, "2.0.0": {} },
  "inner-dep": { "1.0.0": { "child-dep": "~1.1.0" }, "2.0.0": { "child-dep": "~1.2.0" } },
  "outer-dep": { "1.0.0": { "inner-dep": "^1.0.0" } },
  "other-dep": { "1.0.0": { "inner-dep": "^2.0.0" } },
};
const NESTED_MANIFEST = {
  name: "dep-ages-nested-lock-fixture",
  version: "0.0.0",
  dependencies: { "outer-dep": "1.0.0", "other-dep": "1.0.0", "child-dep": "2.0.0" },
  overrides: {
    "outer-dep": { "inner-dep": { "child-dep": "~1.1.0" } },
    "other-dep": { "inner-dep": { "child-dep": "~1.2.0" } },
    "absent-dep": { "inner-dep": { "child-dep": "~1.1.0" } },
  },
};

describe("resolveRangedDeps against a real bun.lock", () => {
  it("resolves an npm: alias by its alias key, not by a separately installed target", async () => {
    const lock = await bunGeneratedLock(join(scratch, "real-lock-alias-unit"), ALIAS_MANIFEST, ALIAS_PACKAGES);
    expect(lockResolutions(lock)).toMatchObject({
      "some-alias": `${FIXTURE_DEP}@1.0.5`,
      [FIXTURE_DEP]: `${FIXTURE_DEP}@1.2.0`,
      "wrapped-dep": `${FIXTURE_DEP}@1.0.5`,
    });
    const { resolved, unresolved, uninstalled } = resolveRangedDeps(
      collectRangedDeps([{ pkg: ALIAS_MANIFEST, path: "package.json" }], new Set()),
      lock,
    );
    expect(unresolved).toEqual([]);
    expect(uninstalled).toEqual([]);
    expect(resolved.map((r) => `${r.at} ${r.name}@${r.version}`).sort()).toEqual([
      `dependencies["${FIXTURE_DEP}"] ${FIXTURE_DEP}@1.2.0`,
      `dependencies["some-alias"] ${FIXTURE_DEP}@1.0.5`,
      `overrides["wrapped-dep"] ${FIXTURE_DEP}@1.0.5`,
    ]);
  }, 60_000);

  it("limits each nested override to the copies below its own enclosing path", async () => {
    const lock = await bunGeneratedLock(join(scratch, "real-lock-nested-unit"), NESTED_MANIFEST, NESTED_PACKAGES);
    const childCopies = Object.values(lockResolutions(lock)).filter((r) => r.startsWith("child-dep@")).sort();
    expect(childCopies).toEqual(["child-dep@1.1.5", "child-dep@1.2.5", "child-dep@2.0.0"]);
    const { resolved, unresolved, uninstalled } = resolveRangedDeps(
      collectRangedDeps([{ pkg: NESTED_MANIFEST, path: "package.json" }], new Set()),
      lock,
    );
    expect(unresolved).toEqual([]);
    expect(resolved.map((r) => `${r.at} ${r.name}@${r.version}`).sort()).toEqual([
      'overrides["other-dep"]["inner-dep"]["child-dep"] child-dep@1.2.5',
      'overrides["outer-dep"]["inner-dep"]["child-dep"] child-dep@1.1.5',
    ]);
    expect(uninstalled.map((u) => u.at)).toEqual(['overrides["absent-dep"]["inner-dep"]["child-dep"]']);
  }, 60_000);
});

describe("CLI — a real bun.lock: aliases, nested overrides and declaration lines", () => {
  it("age-checks a ranged npm: alias at the version installed under the alias", async () => {
    const root = join(scratch, "real-lock-alias-cli");
    await bunGeneratedLock(root, ALIAS_MANIFEST, ALIAS_PACKAGES);
    const registry = registryWithTimes({ "1.0.0": OLD_TIME, "1.0.5": FRESH_TIME, "1.2.0": OLD_TIME });
    try {
      const { exitCode, output } = await runGate(CLI_SCRIPT, {
        FLAIR_CHECK_DEP_AGES_ROOT: root,
        FLAIR_NPM_REGISTRY: registry.url,
      });
      expect(output).toContain(`${FIXTURE_DEP}@1.0.5    — published ${FRESH_DATE}`);
      expect(output).toContain(`declared in package.json dependencies["some-alias"] (range "npm:${FIXTURE_DEP}@~1.0.0")`);
      expect(output).toContain(`declared in package.json overrides["wrapped-dep"] (range "npm:${FIXTURE_DEP}@~1.0.0")`);
      expect(output).not.toContain("no installed copy");
      expect(output).not.toContain(`${FIXTURE_DEP}@1.2.0    —`);
      expect(exitCode).toBe(1);
    } finally {
      registry.stop();
    }
  }, 60_000);

  it("checks a nested override only at the copies below its own enclosing path", async () => {
    const root = join(scratch, "real-lock-nested-cli");
    await bunGeneratedLock(root, NESTED_MANIFEST, NESTED_PACKAGES);
    const registry = registryWithTimes({ "1.0.0": OLD_TIME, "1.1.5": OLD_TIME, "1.2.5": FRESH_TIME, "2.0.0": OLD_TIME });
    try {
      const { exitCode, output } = await runGate(CLI_SCRIPT, {
        FLAIR_CHECK_DEP_AGES_ROOT: root,
        FLAIR_NPM_REGISTRY: registry.url,
      });
      expect(output).toContain(`child-dep@1.2.5    — published ${FRESH_DATE}`);
      expect(output).toContain(`declared in package.json overrides["other-dep"]["inner-dep"]["child-dep"] (range "~1.2.0")`);
      expect(output).not.toContain(`declared in package.json overrides["outer-dep"]["inner-dep"]["child-dep"]`);
      expect(output).toContain("Override ranges with no installed copy in their scope");
      expect(output).toContain(`package.json overrides["absent-dep"]["inner-dep"]["child-dep"] "~1.1.0"`);
      expect(exitCode).toBe(1);
    } finally {
      registry.stop();
    }
  }, 60_000);

  it("prints each declaration of one version: a dependencies range and an overrides range in one manifest", async () => {
    const root = join(scratch, "real-lock-two-declarations");
    const lock = await bunGeneratedLock(root, {
      name: "dep-ages-two-declarations-fixture",
      version: "0.0.0",
      dependencies: { [FIXTURE_DEP]: "^1.0.0" },
      overrides: { [FIXTURE_DEP]: "~1.0.0" },
    }, ALIAS_PACKAGES);
    expect(lockResolutions(lock)).toMatchObject({ [FIXTURE_DEP]: `${FIXTURE_DEP}@1.0.5` });
    const registry = registryWithTimes({ "1.0.5": FRESH_TIME });
    try {
      const { exitCode, output } = await runGate(CLI_SCRIPT, {
        FLAIR_CHECK_DEP_AGES_ROOT: root,
        FLAIR_NPM_REGISTRY: registry.url,
      });
      expect(output).toContain(`${FIXTURE_DEP}@1.0.5    — published ${FRESH_DATE}`);
      expect(output).toContain(`declared in package.json dependencies["${FIXTURE_DEP}"] (range "^1.0.0")`);
      expect(output).toContain(`declared in package.json overrides["${FIXTURE_DEP}"] (range "~1.0.0")`);
      expect(exitCode).toBe(1);
    } finally {
      registry.stop();
    }
  }, 60_000);

  it("checks a workspace's range at the workspace's own resolution, not the hoisted one", async () => {
    // The root takes fixture-dep ^1.0.0 and workspace ws-a takes ^2.0.0, so
    // bun resolves two versions: one hoisted, one under the workspace's key.
    const root = join(scratch, "real-lock-workspace");
    mkdirSync(join(root, "packages", "ws-a"), { recursive: true });
    writeFileSync(join(root, "packages", "ws-a", "package.json"), JSON.stringify({
      name: "ws-a",
      version: "0.0.0",
      dependencies: { [FIXTURE_DEP]: "^2.0.0" },
    }));
    const lock = await bunGeneratedLock(root, {
      name: "dep-ages-workspace-lock-fixture",
      version: "0.0.0",
      workspaces: ["packages/*"],
      dependencies: { [FIXTURE_DEP]: "^1.0.0" },
    }, { [FIXTURE_DEP]: { "1.0.0": {}, "1.0.5": {}, "2.0.0": {}, "2.0.5": {} } });
    expect(lockResolutions(lock)).toMatchObject({
      [FIXTURE_DEP]: `${FIXTURE_DEP}@1.0.5`,
      [`ws-a/${FIXTURE_DEP}`]: `${FIXTURE_DEP}@2.0.5`,
    });
    const registry = registryWithTimes({ "1.0.5": OLD_TIME, "2.0.5": FRESH_TIME });
    try {
      const { exitCode, output } = await runGate(CLI_SCRIPT, {
        FLAIR_CHECK_DEP_AGES_ROOT: root,
        FLAIR_NPM_REGISTRY: registry.url,
      });
      expect(output).toContain(`${FIXTURE_DEP}@2.0.5    — published ${FRESH_DATE}`);
      expect(output).toContain(`declared in packages/ws-a/package.json dependencies["${FIXTURE_DEP}"] (range "^2.0.0")`);
      expect(output).not.toContain(`${FIXTURE_DEP}@1.0.5    —`);
      expect(exitCode).toBe(1);
    } finally {
      registry.stop();
    }
  }, 60_000);

  // The same real workspace lock, then a malformed `workspaces` map. The
  // hoisted copy (1.0.5) is old and the workspace's own (2.0.5) is fresh, so
  // a fallback to the hoisted copy would pass: the gate must refuse instead.
  async function writeMalformedWorkspaceLock(label: string, corrupt: (lock: Record<string, any>) => void) {
    const root = join(scratch, `real-lock-workspace-${label}`);
    mkdirSync(join(root, "packages", "ws-a"), { recursive: true });
    writeFileSync(join(root, "packages", "ws-a", "package.json"), JSON.stringify({
      name: "ws-a",
      version: "0.0.0",
      dependencies: { [FIXTURE_DEP]: "^2.0.0" },
    }));
    const lock = await bunGeneratedLock(root, {
      name: "dep-ages-workspace-lock-fixture",
      version: "0.0.0",
      workspaces: ["packages/*"],
      dependencies: { [FIXTURE_DEP]: "^1.0.0" },
    }, { [FIXTURE_DEP]: { "1.0.0": {}, "1.0.5": {}, "2.0.0": {}, "2.0.5": {} } });
    expect(lockResolutions(lock)).toMatchObject({ [`ws-a/${FIXTURE_DEP}`]: `${FIXTURE_DEP}@2.0.5` });
    corrupt(lock as Record<string, any>);
    writeLock(root, lock as Record<string, unknown>);
    return root;
  }

  const malformedWorkspaceCases: Array<[string, (lock: Record<string, any>) => void, string]> = [
    ["not-an-object", (lock) => { lock.workspaces = []; }, 'bun.lock "workspaces" must be an object, not an array'],
    ["no-name", (lock) => { delete lock.workspaces["packages/ws-a"].name; }, 'bun.lock workspaces["packages/ws-a"] must have a non-empty string "name"'],
    ["missing-entry", (lock) => { delete lock.workspaces["packages/ws-a"]; }, 'packages/ws-a/package.json dependencies["fixture-dep"] "^2.0.0": bun.lock "workspaces" has no entry for "packages/ws-a"'],
    ["wrong-name", (lock) => { lock.workspaces["packages/ws-a"].name = "ws-other"; }, 'packages/ws-a/package.json dependencies["fixture-dep"] "^2.0.0": bun.lock workspaces["packages/ws-a"] names "ws-other", but packages/ws-a/package.json names "ws-a"'],
  ];
  for (const [label, corrupt, message] of malformedWorkspaceCases) {
    it(`exits 2 on a real workspace lock whose workspaces map is malformed (${label}), never checking the hoisted copy`, async () => {
      const root = await writeMalformedWorkspaceLock(label, corrupt);
      const registry = registryWithTimes({ "1.0.5": OLD_TIME, "2.0.5": FRESH_TIME });
      try {
        const { exitCode, output } = await runGate(CLI_SCRIPT, {
          FLAIR_CHECK_DEP_AGES_ROOT: root,
          FLAIR_NPM_REGISTRY: registry.url,
        });
        expect(output).toContain(message);
        expect(registry.requests).toEqual([]);
        expect(exitCode).toBe(2);
      } finally {
        registry.stop();
      }
    }, 60_000);
  }

  // "harper" is on the default keep-current list; the alias installs a
  // different, unlisted package under that name, so it is checked.
  it("age-checks a ranged npm: alias whose key is a keep-current name, at its unlisted target", async () => {
    const root = join(scratch, "real-lock-keep-current-alias-key");
    const lock = await bunGeneratedLock(root, {
      name: "dep-ages-keep-current-alias-fixture",
      version: "0.0.0",
      dependencies: { harper: `npm:${FIXTURE_DEP}@^1.0.0` },
    }, { [FIXTURE_DEP]: { "1.0.0": {}, "1.0.5": {} } });
    expect(lockResolutions(lock)).toMatchObject({ harper: `${FIXTURE_DEP}@1.0.5` });
    const registry = registryWithTimes({ "1.0.5": FRESH_TIME });
    try {
      const { exitCode, output } = await runGate(CLI_SCRIPT, {
        FLAIR_CHECK_DEP_AGES_ROOT: root,
        FLAIR_NPM_REGISTRY: registry.url,
      });
      expect(registry.requests).toEqual([`/${FIXTURE_DEP}`]);
      expect(output).toContain(`${FIXTURE_DEP}@1.0.5    — published ${FRESH_DATE}`);
      expect(output).toContain(`declared in package.json dependencies["harper"] (range "npm:${FIXTURE_DEP}@^1.0.0")`);
      expect(exitCode).toBe(1);
    } finally {
      registry.stop();
    }
  }, 60_000);

  it("age-checks a ranged npm: alias override whose key is a keep-current name, at its unlisted target", async () => {
    const root = join(scratch, "real-lock-keep-current-alias-override");
    const lock = await bunGeneratedLock(root, {
      name: "dep-ages-keep-current-alias-override-fixture",
      version: "0.0.0",
      dependencies: { "wrapper-dep": "1.0.0" },
      overrides: { harper: `npm:${FIXTURE_DEP}@^1.0.0` },
    }, {
      [FIXTURE_DEP]: { "1.0.0": {}, "1.0.5": {} },
      "wrapper-dep": { "1.0.0": { harper: "^1.0.0" } },
      harper: { "1.0.0": {} },
    });
    expect(lockResolutions(lock)).toMatchObject({ harper: `${FIXTURE_DEP}@1.0.5`, "wrapper-dep": "wrapper-dep@1.0.0" });
    const registry = registryWithTimes({ "1.0.0": OLD_TIME, "1.0.5": FRESH_TIME });
    try {
      const { exitCode, output } = await runGate(CLI_SCRIPT, {
        FLAIR_CHECK_DEP_AGES_ROOT: root,
        FLAIR_NPM_REGISTRY: registry.url,
      });
      expect(registry.requests.sort()).toEqual([`/${FIXTURE_DEP}`, "/wrapper-dep"]);
      expect(output).toContain(`${FIXTURE_DEP}@1.0.5    — published ${FRESH_DATE}`);
      expect(output).toContain(`declared in package.json overrides["harper"] (range "npm:${FIXTURE_DEP}@^1.0.0")`);
      expect(exitCode).toBe(1);
    } finally {
      registry.stop();
    }
  }, 60_000);
});

/** A gzipped tar holding `files` under `package/`, the shape an npm tarball has. */
function npmTarball(files: Record<string, string>): Uint8Array {
  const encoder = new TextEncoder();
  const blocks: Uint8Array[] = [];
  for (const [path, content] of Object.entries(files)) {
    const data = encoder.encode(content);
    const header = new Uint8Array(512);
    const put = (text: string, offset: number) => header.set(encoder.encode(text), offset);
    put(`package/${path}`, 0);
    put("0000644\0", 100);
    put("0000000\0", 108);
    put("0000000\0", 116);
    put(`${data.length.toString(8).padStart(11, "0")}\0`, 124);
    put("00000000000\0", 136);
    put("        ", 148);
    put("0", 156);
    put("ustar\0", 257);
    put("00", 263);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    put(`${checksum.toString(8).padStart(6, "0")}\0 `, 148);
    blocks.push(header, data, new Uint8Array((512 - (data.length % 512)) % 512));
  }
  blocks.push(new Uint8Array(1024));
  const tar = new Uint8Array(blocks.reduce((size, block) => size + block.length, 0));
  let offset = 0;
  for (const block of blocks) {
    tar.set(block, offset);
    offset += block.length;
  }
  return Bun.gzipSync(tar);
}

/**
 * The real workspace fixture (root `fixture-dep ^1.0.0`, workspace ws-a
 * `^2.0.0`) against a registry served from this process that also serves real
 * tarballs, so `bun install --frozen-lockfile` can run in full. `run` gets the
 * fixture root and a `bun` runner; the registry lives until it returns.
 */
async function withInstallableWorkspace(
  label: string,
  run: (root: string, bun: (args: string[]) => Promise<{ exitCode: number; output: string }>) => Promise<void>,
) {
  const root = join(scratch, `frozen-install-${label}`);
  mkdirSync(join(root, "packages", "ws-a"), { recursive: true });
  mkdirSync(join(root, ".bun-home"), { recursive: true });
  const tarballs = new Map<string, Uint8Array>();
  for (const version of ["1.0.0", "1.0.5", "2.0.0", "2.0.5"]) {
    tarballs.set(version, npmTarball({ "package.json": JSON.stringify({ name: FIXTURE_DEP, version }) }));
  }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req): Response {
      const url = new URL(req.url);
      const path = decodeURIComponent(url.pathname.slice(1));
      const tarball = path.match(/^fixture-dep\/-\/fixture-dep-(\d+\.\d+\.\d+)\.tgz$/);
      if (tarball) {
        const data = tarballs.get(tarball[1]);
        return data ? new Response(new Uint8Array(data)) : new Response("not found", { status: 404 });
      }
      if (path !== FIXTURE_DEP) return new Response("{}", { status: 404 });
      const versions: Record<string, unknown> = {};
      for (const [version, data] of tarballs) {
        versions[version] = {
          name: FIXTURE_DEP,
          version,
          dist: {
            tarball: `${url.origin}/${FIXTURE_DEP}/-/${FIXTURE_DEP}-${version}.tgz`,
            integrity: `sha512-${new Bun.CryptoHasher("sha512").update(data).digest("base64")}`,
          },
        };
      }
      return Response.json({ name: FIXTURE_DEP, "dist-tags": { latest: "2.0.5" }, versions });
    },
  });
  if (!server.port) setupFailure("fixture npm registry did not bind a port");
  const bun = async (args: string[]) => {
    const proc = Bun.spawn([process.execPath, ...args], {
      cwd: root,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: join(root, ".bun-home"),
        BUN_INSTALL_CACHE_DIR: join(root, ".bun-home", "cache"),
        TMPDIR: tmpdir(),
      },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 30_000,
      killSignal: "SIGKILL",
    });
    const exitCode = await proc.exited;
    const output = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
    return { exitCode, output };
  };
  try {
    writeFileSync(join(root, "package.json"), JSON.stringify({
      name: "dep-ages-workspace-lock-fixture",
      version: "0.0.0",
      workspaces: ["packages/*"],
      dependencies: { [FIXTURE_DEP]: "^1.0.0" },
    }));
    writeFileSync(join(root, "packages", "ws-a", "package.json"), JSON.stringify({
      name: "ws-a",
      version: "0.0.0",
      dependencies: { [FIXTURE_DEP]: "^2.0.0" },
    }));
    writeFileSync(join(root, "bunfig.toml"), `[install]\nregistry = "http://127.0.0.1:${server.port}/"\n`);
    const generated = await bun(["install", "--lockfile-only", "--ignore-scripts"]);
    if (generated.exitCode !== 0) setupFailure(`bun install --lockfile-only exited ${generated.exitCode}: ${generated.output}`);
    await run(root, bun);
  } finally {
    server.stop(true);
  }
}

/** Rewrite a fixture root's bun.lock through `change`, as JSON (which bun reads). */
function rewriteLock(root: string, change: (lock: Record<string, any>) => void) {
  const lock = parseBunLockText(readFileSync(join(root, "bun.lock"), "utf8")) as Record<string, any>;
  change(lock);
  writeFileSync(join(root, "bun.lock"), JSON.stringify(lock, null, 2));
}

/*
 * The trust boundary, measured against the bun CI runs (1.3.10): the gate reads
 * bun.lock as written; a frozen install refuses these malformed locks, and for
 * a lock that records a workspace's range outside its declared range it
 * installs the recorded version, which is the version the gate checks.
 */
describe("bun install --frozen-lockfile on the locks the gate reads", () => {
  const refusedByFrozenInstall: Array<[string, (lock: Record<string, any>) => void]> = [
    ["a workspaces array", (lock) => { lock.workspaces = []; }],
    ["a workspace entry with no name", (lock) => { delete lock.workspaces["packages/ws-a"].name; }],
    ["a missing workspace entry", (lock) => { delete lock.workspaces["packages/ws-a"]; }],
    ["a wrong workspace name", (lock) => { lock.workspaces["packages/ws-a"].name = "ws-other"; }],
  ];
  for (const [label, change] of refusedByFrozenInstall) {
    it(`refuses ${label}`, async () => {
      await withInstallableWorkspace(label.replace(/\W+/g, "-"), async (root, bun) => {
        const before = await bun(["install", "--frozen-lockfile", "--ignore-scripts"]);
        expect(before.exitCode).toBe(0);
        rewriteLock(root, change);
        const after = await bun(["install", "--frozen-lockfile", "--ignore-scripts"]);
        expect(after.output).toContain("lockfile");
        expect(after.exitCode).toBe(1);
      });
    }, 60_000);
  }

  const outOfRange: Array<[string, (lock: Record<string, any>) => void]> = [
    ["the workspace's own copy is removed, leaving the hoisted 1.0.5", (lock) => { delete lock.packages[`ws-a/${FIXTURE_DEP}`]; }],
    ["the workspace's own copy records 1.0.5", (lock) => { lock.packages[`ws-a/${FIXTURE_DEP}`] = structuredClone(lock.packages[FIXTURE_DEP]); }],
  ];
  for (const [label, change] of outOfRange) {
    it(`installs the version the gate checks when ${label} under ws-a's ^2.0.0`, async () => {
      await withInstallableWorkspace(label.replace(/\W+/g, "-"), async (root, bun) => {
        rewriteLock(root, change);
        const install = await bun(["install", "--frozen-lockfile", "--ignore-scripts"]);
        expect(install.exitCode).toBe(0);
        const installedPath = Bun.resolveSync(`${FIXTURE_DEP}/package.json`, join(root, "packages", "ws-a"));
        const installed = JSON.parse(readFileSync(installedPath, "utf8")).version;
        const { resolved, unresolved } = resolveRangedDeps(
          collectRangedDeps([
            { pkg: JSON.parse(readFileSync(join(root, "package.json"), "utf8")), path: "package.json" },
            { pkg: JSON.parse(readFileSync(join(root, "packages", "ws-a", "package.json"), "utf8")), path: "packages/ws-a/package.json" },
          ], new Set()),
          parseBunLockText(readFileSync(join(root, "bun.lock"), "utf8")),
        );
        expect(unresolved).toEqual([]);
        const checked = resolved.find((r) => r.declaredIn === "packages/ws-a/package.json")?.version;
        expect(installed).toBe("1.0.5");
        expect(checked).toBe(installed);
      });
    }, 60_000);
  }
});

describe("CLI fail-closed exit — dead registry", () => {
  it("exits 2 when FLAIR_NPM_REGISTRY is unreachable", async () => {
    const root = writeFixtureRepo(join(scratch, "dead-registry"));
    const { exitCode, output } = await runGate(CLI_SCRIPT, {
      FLAIR_CHECK_DEP_AGES_ROOT: root,
      FLAIR_NPM_REGISTRY: "http://127.0.0.1:1",
    });
    expect(output).toContain("Failed to fetch publish times");
    expect(output).toContain(`${FIXTURE_DEP}@${FIXTURE_VERSION}:`);
    expect(exitCode).toBe(2);
  }, 30_000);
});

describe("CLI fail-closed exit — too-fresh dep", () => {
  it("exits 1 when a dep was published now, under a 7-day policy", async () => {
    const root = writeFixtureRepo(join(scratch, "too-fresh"));
    const registry = freshRegistry();
    try {
      const { exitCode, output } = await runGate(CLI_SCRIPT, {
        FLAIR_CHECK_DEP_AGES_ROOT: root,
        FLAIR_NPM_REGISTRY: registry.url,
      });
      // The gate asked the fixture registry, and reported the dep as too fresh.
      expect(registry.requests).toEqual([`/${FIXTURE_DEP}`]);
      expect(output).toContain("Dependency versions younger than the bake-time policy");
      expect(output).toContain(`${FIXTURE_DEP}@${FIXTURE_VERSION}`);
      expect(output).toContain("declared in package.json");
      expect(exitCode).toBe(1);
    } finally {
      registry.stop();
    }
  }, 30_000);

  it("resolves its default root from its own location, through a path with a space", async () => {
    // The documented downstream install: both files copied, relative layout kept,
    // no FLAIR_CHECK_DEP_AGES_ROOT. The gate must find the package.json one level
    // above its own scripts/ dir even though the path contains a space.
    const root = writeFixtureRepo(join(scratch, "downstream repo"));
    mkdirSync(join(root, "scripts", "lib"), { recursive: true });
    const script = join(root, "scripts", "check-dep-ages.mjs");
    copyFileSync(CLI_SCRIPT, script);
    copyFileSync(COLLECT_LIB, join(root, "scripts", "lib", "check-dep-ages-collect.mjs"));
    const registry = freshRegistry();
    try {
      const { exitCode, output } = await runGate(script, { FLAIR_NPM_REGISTRY: registry.url });
      expect(registry.requests).toEqual([`/${FIXTURE_DEP}`]);
      expect(output).toContain("Dependency versions younger than the bake-time policy");
      expect(output).toContain(`${FIXTURE_DEP}@${FIXTURE_VERSION}`);
      expect(exitCode).toBe(1);
    } finally {
      registry.stop();
    }
  }, 30_000);
});

describe("CLI — a pin through overrides and the dated exemption", () => {
  it("exits 1 when a version pinned through overrides was published now", async () => {
    const root = writeOverrideFixtureRepo(join(scratch, "override-too-fresh"), { [FIXTURE_DEP]: FIXTURE_VERSION });
    const registry = freshRegistry();
    try {
      const { exitCode, output } = await runGate(CLI_SCRIPT, {
        FLAIR_CHECK_DEP_AGES_ROOT: root,
        FLAIR_NPM_REGISTRY: registry.url,
      });
      expect(registry.requests).toEqual([`/${FIXTURE_DEP}`]);
      expect(output).toContain("Dependency versions younger than the bake-time policy");
      expect(output).toContain(`${FIXTURE_DEP}@${FIXTURE_VERSION}`);
      expect(output).toContain("declared in package.json");
      expect(exitCode).toBe(1);
    } finally {
      registry.stop();
    }
  }, 30_000);

  it("exits 0 with a matching unexpired dated exemption", async () => {
    const root = writeOverrideFixtureRepo(join(scratch, "override-exempt"), { [FIXTURE_DEP]: FIXTURE_VERSION });
    writeAllowlist(root, [exemption("2026-01-01", "2099-01-01")]);
    const registry = freshRegistry();
    try {
      const { exitCode, output } = await runGate(CLI_SCRIPT, {
        FLAIR_CHECK_DEP_AGES_ROOT: root,
        FLAIR_NPM_REGISTRY: registry.url,
      });
      expect(output).toContain("Exempted fresh dependency versions");
      expect(output).toContain("exempt until 2099-01-01");
      expect(output).not.toContain("Dependency versions younger than the bake-time policy");
      expect(exitCode).toBe(0);
    } finally {
      registry.stop();
    }
  }, 30_000);

  it("names the exemption applied on the exit-0 success line", async () => {
    const root = writeOverrideFixtureRepo(join(scratch, "override-exempt-named"), { [FIXTURE_DEP]: FIXTURE_VERSION });
    writeAllowlist(root, [exemption("2026-01-01", "2099-01-01")]);
    const registry = freshRegistry();
    try {
      const { exitCode, output } = await runGate(CLI_SCRIPT, {
        FLAIR_CHECK_DEP_AGES_ROOT: root,
        FLAIR_NPM_REGISTRY: registry.url,
      });
      expect(output).toContain(`1 exemption(s) applied: ${FIXTURE_DEP}@${FIXTURE_VERSION}.`);
      expect(exitCode).toBe(0);
    } finally {
      registry.stop();
    }
  }, 30_000);

  it("exits 2 on an expired exemption, making no registry request", async () => {
    const root = writeOverrideFixtureRepo(join(scratch, "override-expired"), { [FIXTURE_DEP]: FIXTURE_VERSION });
    writeAllowlist(root, [exemption("2020-01-01", "2020-01-02")]);
    // A LIVE registry that would answer the request: the gate must refuse the
    // expired entry BEFORE asking, so the discriminating assertion is that it
    // made NO request. A dead registry alone cannot tell a refusal from a
    // fetch that failed first; moving the expiry check after the fetch makes
    // this test fail because a request is then made.
    const registry = freshRegistry();
    try {
      const { exitCode, output } = await runGate(CLI_SCRIPT, {
        FLAIR_CHECK_DEP_AGES_ROOT: root,
        FLAIR_NPM_REGISTRY: registry.url,
      });
      expect(output).toContain("Expired bake-time exemption");
      expect(output).toContain(`${FIXTURE_DEP}@${FIXTURE_VERSION}`);
      expect(output).toContain("2020-01-02");
      expect(registry.requests).toEqual([]);
      expect(exitCode).toBe(2);
    } finally {
      registry.stop();
    }
  }, 30_000);

  it("names an override range whose package is not installed, and does not fail on it", async () => {
    const root = writeOverrideFixtureRepo(join(scratch, "override-range-uninstalled"), { [FIXTURE_DEP]: "^1.0.0" });
    writeLock(root, lockWithPackages({}));
    const { exitCode, output } = await runGate(CLI_SCRIPT, {
      FLAIR_CHECK_DEP_AGES_ROOT: root,
      // Nothing is age-checked, so the dead registry is never queried.
      FLAIR_NPM_REGISTRY: "http://127.0.0.1:1",
    });
    expect(output).toContain("Override ranges with no installed copy in their scope");
    expect(output).toContain(`package.json overrides["${FIXTURE_DEP}"] "^1.0.0"`);
    expect(output).toContain("No external dependency versions to check.");
    expect(exitCode).toBe(0);
  }, 30_000);

  it("fails closed, naming it, when a dependency range has no lockfile entry", async () => {
    const root = writeManifestRepo(join(scratch, "dep-range-unresolved"), {
      name: "dep-ages-range-fixture",
      version: "0.0.0",
      dependencies: { [FIXTURE_DEP]: "^1.0.0" },
    });
    writeLock(root, lockWithPackages({ "other-dep": "1.0.0" }));
    const registry = freshRegistry();
    try {
      const { exitCode, output } = await runGate(CLI_SCRIPT, {
        FLAIR_CHECK_DEP_AGES_ROOT: root,
        FLAIR_NPM_REGISTRY: registry.url,
      });
      expect(output).toContain("Ranged declarations the gate cannot resolve through bun.lock");
      expect(output).toContain(`package.json dependencies["${FIXTURE_DEP}"] "^1.0.0": bun.lock has no entry for ${FIXTURE_DEP}`);
      expect(registry.requests).toEqual([]);
      expect(exitCode).toBe(2);
    } finally {
      registry.stop();
    }
  }, 30_000);

  it("lists an uninstalled override range and fails closed on an unresolved dependency range in the same run", async () => {
    const root = writeManifestRepo(join(scratch, "unresolved-and-uninstalled"), {
      name: "dep-ages-range-fixture",
      version: "0.0.0",
      dependencies: { [FIXTURE_DEP]: "^1.0.0" },
      overrides: { "absent-dep": "^2.0.0" },
    });
    writeLock(root, lockWithPackages({ "other-dep": "1.0.0" }));
    const registry = freshRegistry();
    try {
      const { exitCode, output } = await runGate(CLI_SCRIPT, {
        FLAIR_CHECK_DEP_AGES_ROOT: root,
        FLAIR_NPM_REGISTRY: registry.url,
      });
      expect(output).toContain("Override ranges with no installed copy in their scope");
      expect(output).toContain('package.json overrides["absent-dep"] "^2.0.0"');
      expect(output).toContain("Ranged declarations the gate cannot resolve through bun.lock");
      expect(output).toContain(`package.json dependencies["${FIXTURE_DEP}"] "^1.0.0": bun.lock has no entry for ${FIXTURE_DEP}`);
      expect(registry.requests).toEqual([]);
      expect(exitCode).toBe(2);
    } finally {
      registry.stop();
    }
  }, 30_000);
});

describe("CLI — a dependency range is age-checked at its lockfile resolution", () => {
  it("resolves a digit-leading range like 1.x and fetches the resolved version", async () => {
    const root = writeManifestRepo(join(scratch, "dep-range"), {
      name: "dep-ages-range-fixture",
      version: "0.0.0",
      dependencies: { [FIXTURE_DEP]: "1.x" },
    });
    writeLock(root, lockWithPackages({ [FIXTURE_DEP]: FIXTURE_VERSION }));
    const registry = freshRegistry();
    try {
      const { exitCode, output } = await runGate(CLI_SCRIPT, {
        FLAIR_CHECK_DEP_AGES_ROOT: root,
        FLAIR_NPM_REGISTRY: registry.url,
      });
      expect(registry.requests).toEqual([`/${FIXTURE_DEP}`]);
      expect(output).toContain(`${FIXTURE_DEP}@${FIXTURE_VERSION}`);
      expect(output).toContain(`(range "1.x")`);
      expect(exitCode).toBe(1);
    } finally {
      registry.stop();
    }
  }, 30_000);

  it("fails, naming the resolved version and publish date, when the resolution is younger than the bake", async () => {
    const root = writeManifestRepo(join(scratch, "dep-range-fresh"), {
      name: "dep-ages-range-fixture",
      version: "0.0.0",
      dependencies: { [FIXTURE_DEP]: "^1.0.0" },
    });
    writeLock(root, lockWithPackages({ [FIXTURE_DEP]: "1.2.3" }));
    const registry = registryWithTimes({ "1.2.3": FRESH_TIME });
    try {
      const { exitCode, output } = await runGate(CLI_SCRIPT, {
        FLAIR_CHECK_DEP_AGES_ROOT: root,
        FLAIR_NPM_REGISTRY: registry.url,
      });
      expect(output).toContain("Dependency versions younger than the bake-time policy");
      expect(output).toContain(`${FIXTURE_DEP}@1.2.3`);
      expect(output).toContain(`published ${FRESH_DATE}`);
      expect(output).toContain(`declared in package.json dependencies["${FIXTURE_DEP}"] (range "^1.0.0")`);
      expect(exitCode).toBe(1);
    } finally {
      registry.stop();
    }
  }, 30_000);

  it("passes when the resolution is older than the bake", async () => {
    const root = writeManifestRepo(join(scratch, "dep-range-old"), {
      name: "dep-ages-range-fixture",
      version: "0.0.0",
      dependencies: { [FIXTURE_DEP]: "^1.0.0" },
    });
    writeLock(root, lockWithPackages({ [FIXTURE_DEP]: "1.2.3" }));
    const registry = registryWithTimes({ "1.2.3": OLD_TIME });
    try {
      const { exitCode, output } = await runGate(CLI_SCRIPT, {
        FLAIR_CHECK_DEP_AGES_ROOT: root,
        FLAIR_NPM_REGISTRY: registry.url,
      });
      expect(output).toContain("All 1 external dependency versions are at least 7 days old.");
      expect(exitCode).toBe(0);
    } finally {
      registry.stop();
    }
  }, 30_000);

  it("never age-checks a keep-current package, at any age", async () => {
    const root = writeManifestRepo(join(scratch, "dep-range-keep-current"), {
      name: "dep-ages-range-fixture",
      version: "0.0.0",
      dependencies: { [FIXTURE_DEP]: "^1.0.0" },
    });
    writeLock(root, lockWithPackages({ [FIXTURE_DEP]: "1.2.3" }));
    const registry = registryWithTimes({ "1.2.3": FRESH_TIME });
    try {
      const { exitCode, output } = await runGate(CLI_SCRIPT, {
        FLAIR_CHECK_DEP_AGES_ROOT: root,
        FLAIR_NPM_REGISTRY: registry.url,
        FLAIR_DEP_KEEP_CURRENT: FIXTURE_DEP,
      });
      expect(output).toContain("No external dependency versions to check.");
      expect(registry.requests).toEqual([]);
      expect(exitCode).toBe(0);
    } finally {
      registry.stop();
    }
  }, 30_000);

  it("checks a devDependencies range", async () => {
    const root = writeManifestRepo(join(scratch, "dev-range"), {
      name: "dep-ages-range-fixture",
      version: "0.0.0",
      devDependencies: { [FIXTURE_DEP]: "~1.0.0" },
    });
    writeLock(root, lockWithPackages({ [FIXTURE_DEP]: "1.0.9" }));
    const registry = registryWithTimes({ "1.0.9": FRESH_TIME });
    try {
      const { exitCode, output } = await runGate(CLI_SCRIPT, {
        FLAIR_CHECK_DEP_AGES_ROOT: root,
        FLAIR_NPM_REGISTRY: registry.url,
      });
      expect(output).toContain(`${FIXTURE_DEP}@1.0.9`);
      expect(exitCode).toBe(1);
    } finally {
      registry.stop();
    }
  }, 30_000);

  it("checks every lockfile copy an override range covers", async () => {
    const root = writeOverrideFixtureRepo(join(scratch, "override-range-copies"), { [FIXTURE_DEP]: "^1.0.0" });
    writeLock(root, lockWithPackages({
      [FIXTURE_DEP]: "1.0.0",
      [`parent-dep/${FIXTURE_DEP}`]: "1.2.3",
    }));
    const registry = registryWithTimes({
      "1.0.0": OLD_TIME,
      "1.2.3": FRESH_TIME,
    });
    try {
      const { exitCode, output } = await runGate(CLI_SCRIPT, {
        FLAIR_CHECK_DEP_AGES_ROOT: root,
        FLAIR_NPM_REGISTRY: registry.url,
      });
      expect(registry.requests).toEqual([`/${FIXTURE_DEP}`, `/${FIXTURE_DEP}`]);
      expect(output).toContain(`${FIXTURE_DEP}@1.2.3`);
      expect(output).not.toContain(`${FIXTURE_DEP}@1.0.0    —`);
      expect(exitCode).toBe(1);
    } finally {
      registry.stop();
    }
  }, 30_000);

  it("keeps an exact pin at its declared version when bun.lock resolves another", async () => {
    const root = writeManifestRepo(join(scratch, "exact-vs-lock"), {
      name: "dep-ages-range-fixture",
      version: "0.0.0",
      dependencies: { [FIXTURE_DEP]: "1.0.0" },
    });
    writeLock(root, lockWithPackages({ [FIXTURE_DEP]: "9.9.9" }));
    const registry = registryWithTimes({
      "1.0.0": FRESH_TIME,
      "9.9.9": OLD_TIME,
    });
    try {
      const { exitCode, output } = await runGate(CLI_SCRIPT, {
        FLAIR_CHECK_DEP_AGES_ROOT: root,
        FLAIR_NPM_REGISTRY: registry.url,
      });
      expect(output).toContain(`${FIXTURE_DEP}@1.0.0`);
      expect(output).not.toContain(`${FIXTURE_DEP}@9.9.9`);
      expect(exitCode).toBe(1);
    } finally {
      registry.stop();
    }
  }, 30_000);
});

describe("CLI — devDependencies: a refused form fails the gate, an exact pin stays unchecked", () => {
  // An unreachable registry: a refusal needs no registry call, and any call
  // would fail the run with a fetch error instead of the refusal.
  const DEAD_REGISTRY = "http://127.0.0.1:1";
  const refusedDevForms: Array<[string, string]> = [
    ["a dist-tag", "latest"],
    ["a v prefix", "v1.0.0"],
    ["surrounding whitespace", "^1.0.0 "],
  ];
  for (const [label, spec] of refusedDevForms) {
    it(`exits 2 naming the field and spec for ${label} in devDependencies`, async () => {
      const root = writeManifestRepo(join(scratch, `dev-refused-${label.replace(/\W+/g, "-")}`), {
        name: "dep-ages-dev-refused-fixture",
        version: "0.0.0",
        devDependencies: { [FIXTURE_DEP]: spec },
      });
      const { exitCode, output } = await runGate(CLI_SCRIPT, {
        FLAIR_CHECK_DEP_AGES_ROOT: root,
        FLAIR_NPM_REGISTRY: DEAD_REGISTRY,
      });
      expect(output).toContain("Unsupported dependency entries:");
      expect(output).toContain(`package.json devDependencies ${FIXTURE_DEP} "${spec}":`);
      expect(output).not.toContain("Failed to fetch publish times");
      expect(exitCode).toBe(2);
    }, 30_000);
  }

  it("exits 2 naming the field for a non-string devDependencies specifier", async () => {
    const root = writeManifestRepo(join(scratch, "dev-refused-non-string"), {
      name: "dep-ages-dev-refused-fixture",
      version: "0.0.0",
      devDependencies: { [FIXTURE_DEP]: 1 },
    });
    const { exitCode, output } = await runGate(CLI_SCRIPT, {
      FLAIR_CHECK_DEP_AGES_ROOT: root,
      FLAIR_NPM_REGISTRY: DEAD_REGISTRY,
    });
    expect(output).toContain(`package.json devDependencies ${FIXTURE_DEP} "1": the specifier must be a string, not a number`);
    expect(exitCode).toBe(2);
  }, 30_000);

  it("exits 2 naming the field for a devDependencies value that is not an object", async () => {
    const root = writeManifestRepo(join(scratch, "dev-refused-non-object"), {
      name: "dep-ages-dev-refused-fixture",
      version: "0.0.0",
      devDependencies: "latest",
    });
    const { exitCode, output } = await runGate(CLI_SCRIPT, {
      FLAIR_CHECK_DEP_AGES_ROOT: root,
      FLAIR_NPM_REGISTRY: DEAD_REGISTRY,
    });
    expect(output).toContain('package.json devDependencies devDependencies "": it must be an object, not a string');
    expect(exitCode).toBe(2);
  }, 30_000);

  it("leaves an exact devDependencies pin unchecked and exits 0", async () => {
    const root = writeManifestRepo(join(scratch, "dev-exact-unchecked"), {
      name: "dep-ages-dev-exact-fixture",
      version: "0.0.0",
      devDependencies: { [FIXTURE_DEP]: FIXTURE_VERSION },
    });
    const { exitCode, output } = await runGate(CLI_SCRIPT, {
      FLAIR_CHECK_DEP_AGES_ROOT: root,
      FLAIR_NPM_REGISTRY: DEAD_REGISTRY,
    });
    expect(output).toContain("No external dependency versions to check.");
    expect(output).not.toContain("Unsupported dependency entries");
    expect(exitCode).toBe(0);
  }, 30_000);
});

describe("CLI — a refused dependency form fails the gate before any fetch", () => {
  const refusedForms: Array<[string, string]> = [
    ["build metadata", "1.0.0+build"],
    ["a v prefix", "v1.0.0"],
    ["an = prefix", "=1.0.0"],
    ["a dist-tag", "latest"],
  ];
  for (const field of ["dependencies", "optionalDependencies"]) {
    for (const [label, spec] of refusedForms) {
      it(`exits 2 naming the package, spec and manifest for ${label} in ${field}`, async () => {
        const root = writeManifestRepo(join(scratch, `dep-refused-${field}-${label.replace(/\W+/g, "-")}`), {
          name: "dep-ages-refused-fixture",
          version: "0.0.0",
          [field]: { [FIXTURE_DEP]: spec },
        });
        const registry = freshRegistry();
        try {
          const { exitCode, output } = await runGate(CLI_SCRIPT, {
            FLAIR_CHECK_DEP_AGES_ROOT: root,
            FLAIR_NPM_REGISTRY: registry.url,
          });
          expect(exitCode).toBe(2);
          expect(output).toContain(`package.json ${field} ${FIXTURE_DEP} "${spec}"`);
          expect(registry.requests).toEqual([]);
        } finally {
          registry.stop();
        }
      }, 30_000);
    }
  }

  it("checks an npm: alias with an exact target by the target, as overrides do", async () => {
    const root = writeManifestRepo(join(scratch, "dep-alias-exact"), {
      name: "dep-ages-alias-fixture",
      version: "0.0.0",
      dependencies: { "some-alias": `npm:${FIXTURE_DEP}@${FIXTURE_VERSION}` },
    });
    const registry = freshRegistry();
    try {
      const { exitCode, output } = await runGate(CLI_SCRIPT, {
        FLAIR_CHECK_DEP_AGES_ROOT: root,
        FLAIR_NPM_REGISTRY: registry.url,
      });
      expect(registry.requests).toEqual([`/${FIXTURE_DEP}`]);
      expect(output).toContain(`${FIXTURE_DEP}@${FIXTURE_VERSION}`);
      expect(exitCode).toBe(1);
    } finally {
      registry.stop();
    }
  }, 30_000);

  it("exits 2 for an npm: alias whose target is a refused form", async () => {
    const root = writeManifestRepo(join(scratch, "dep-alias-refused"), {
      name: "dep-ages-alias-fixture",
      version: "0.0.0",
      dependencies: { "some-alias": `npm:${FIXTURE_DEP}@latest` },
    });
    const registry = freshRegistry();
    try {
      const { exitCode, output } = await runGate(CLI_SCRIPT, {
        FLAIR_CHECK_DEP_AGES_ROOT: root,
        FLAIR_NPM_REGISTRY: registry.url,
      });
      expect(exitCode).toBe(2);
      expect(output).toContain(`some-alias "npm:${FIXTURE_DEP}@latest"`);
      expect(registry.requests).toEqual([]);
    } finally {
      registry.stop();
    }
  }, 30_000);

  it("keeps a workspace: entry exempt", async () => {
    const root = writeManifestRepo(join(scratch, "dep-workspace-protocol"), {
      name: "dep-ages-ws-fixture",
      version: "0.0.0",
      dependencies: { "some-internal": "workspace:*" },
    });
    const { exitCode, output } = await runGate(CLI_SCRIPT, { FLAIR_CHECK_DEP_AGES_ROOT: root });
    expect(exitCode).toBe(0);
    expect(output).toContain("No external dependency versions to check.");
  });
});

describe("collectUnsupportedDeps", () => {
  it("names the manifest, field, package, spec and reason", () => {
    expect(collectUnsupportedDeps([
      { pkg: { dependencies: { "some-pin": "latest", ok: "1.0.0" } }, path: "packages/foo/package.json" },
    ])).toEqual([{
      declaredIn: "packages/foo/package.json",
      field: "dependencies",
      name: "some-pin",
      spec: "latest",
      reason: '"latest" is not an exact version, a semver range or an npm: alias of one',
    }]);
  });
});

describe("CLI — override forms", () => {
  it("exits 1 when the fresh pin is nested under a parent package", async () => {
    const root = writeOverrideFixtureRepo(join(scratch, "override-nested"), {
      "parent-dep": { [FIXTURE_DEP]: FIXTURE_VERSION },
    });
    const registry = freshRegistry();
    try {
      const { exitCode, output } = await runGate(CLI_SCRIPT, {
        FLAIR_CHECK_DEP_AGES_ROOT: root,
        FLAIR_NPM_REGISTRY: registry.url,
      });
      expect(registry.requests).toEqual([`/${FIXTURE_DEP}`]);
      expect(output).toContain("Dependency versions younger than the bake-time policy");
      expect(output).toContain(`${FIXTURE_DEP}@${FIXTURE_VERSION}`);
      expect(exitCode).toBe(1);
    } finally {
      registry.stop();
    }
  }, 30_000);

  it("exits 1 when the fresh override exists only in a workspace manifest", async () => {
    const root = writeFixtureRepo(join(scratch, "override-workspace-only"));
    // The root manifest pins nothing; the only pin is a workspace override.
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "dep-ages-fixture", version: "0.0.0" }));
    mkdirSync(join(root, "packages", "ws-a"), { recursive: true });
    writeFileSync(join(root, "packages", "ws-a", "package.json"), JSON.stringify({
      name: "ws-a",
      version: "0.0.0",
      overrides: { [FIXTURE_DEP]: FIXTURE_VERSION },
    }));
    const registry = freshRegistry();
    try {
      const { exitCode, output } = await runGate(CLI_SCRIPT, {
        FLAIR_CHECK_DEP_AGES_ROOT: root,
        FLAIR_NPM_REGISTRY: registry.url,
      });
      expect(registry.requests).toEqual([`/${FIXTURE_DEP}`]);
      expect(output).toContain("Dependency versions younger than the bake-time policy");
      expect(output).toContain("declared in packages/ws-a/package.json");
      expect(exitCode).toBe(1);
    } finally {
      registry.stop();
    }
  }, 30_000);

  it("exits 2 for a malformed workspace manifest before fetching", async () => {
    const root = writeFixtureRepo(join(scratch, "malformed-workspace"));
    mkdirSync(join(root, "packages", "broken"), { recursive: true });
    writeFileSync(join(root, "packages", "broken", "package.json"), "{broken");
    const recorder = join(root, "fetch-recorder.mjs");
    writeFileSync(recorder, 'globalThis.fetch = async () => { process.stderr.write("REGISTRY_FETCH\\n"); throw new Error("fetch called"); };');
    const { exitCode, output } = await runGate(CLI_SCRIPT, {
      FLAIR_CHECK_DEP_AGES_ROOT: root,
      NODE_OPTIONS: `--import=${pathToFileURL(recorder).href}`,
    });
    expect(exitCode).toBe(2);
    expect(output).toContain("packages/broken/package.json");
    expect(output).toContain("Cannot read or parse");
    expect(output).toMatch(/packages\/broken\/package\.json: .+/);
    expect(output).not.toContain("REGISTRY_FETCH");
  });

  it("skips a workspace directory with no package.json", async () => {
    const root = writeOverrideFixtureRepo(join(scratch, "workspace-no-manifest"), {});
    mkdirSync(join(root, "packages", "no-manifest"), { recursive: true });
    const { exitCode, output } = await runGate(CLI_SCRIPT, { FLAIR_CHECK_DEP_AGES_ROOT: root });
    expect(exitCode).toBe(0);
    expect(output).toContain("No external dependency versions to check");
  });

  it("age-checks an override range at its resolved version", async () => {
    const root = writeOverrideFixtureRepo(join(scratch, "override-digit-range"), { [FIXTURE_DEP]: "1.x" });
    writeLock(root, lockWithPackages({ [FIXTURE_DEP]: FIXTURE_VERSION }));
    const registry = freshRegistry();
    try {
      const { exitCode, output } = await runGate(CLI_SCRIPT, {
        FLAIR_CHECK_DEP_AGES_ROOT: root,
        FLAIR_NPM_REGISTRY: registry.url,
      });
      expect(output).toContain(`${FIXTURE_DEP}@${FIXTURE_VERSION}`);
      expect(registry.requests).toEqual([`/${FIXTURE_DEP}`]);
      expect(exitCode).toBe(1);
    } finally {
      registry.stop();
    }
  }, 30_000);

  it("exits 2 on an unsupported override form, naming it, before fetching", async () => {
    const root = writeOverrideFixtureRepo(join(scratch, "override-unsupported"), {
      [FIXTURE_DEP]: FIXTURE_VERSION,
      "parent-dep": { "other-dep": "latest" },
    });
    const registry = freshRegistry();
    try {
      const { exitCode, output } = await runGate(CLI_SCRIPT, {
        FLAIR_CHECK_DEP_AGES_ROOT: root,
        FLAIR_NPM_REGISTRY: registry.url,
      });
      expect(output).toContain("Unsupported `overrides` entries");
      expect(output).toContain('package.json overrides["parent-dep"]["other-dep"]: "latest" is not an exact version');
      expect(registry.requests).toEqual([]);
      expect(exitCode).toBe(2);
    } finally {
      registry.stop();
    }
  }, 30_000);
});

describe("CLI — malformed exemption metadata", () => {
  const cases: [string, Record<string, unknown>, string][] = [
    ["missing ghsa", { ghsa: undefined }, '"ghsa" must name at least one GHSA advisory id'],
    ["empty ghsa", { ghsa: "" }, '"ghsa" must name at least one GHSA advisory id'],
    ["empty ghsa array", { ghsa: [] }, '"ghsa" must name at least one GHSA advisory id'],
    ["non-GHSA-shaped ghsa", { ghsa: "CVE-2026-1234" }, '"ghsa" must name at least one GHSA advisory id'],
    ["empty reason", { reason: "" }, '"reason" must be a non-empty string'],
    ["whitespace reason", { reason: " \t " }, '"reason" must be a non-empty string'],
    ["missing reason", { reason: undefined }, '"reason" must be a non-empty string'],
    ["empty package", { package: "" }, '"package" must be a non-empty string'],
    ["missing package", { package: undefined }, '"package" must be a non-empty string'],
    ["empty version", { version: "" }, '"version" must be a non-empty string'],
    ["missing version", { version: undefined }, '"version" must be a non-empty string'],
  ];

  for (const [label, fields, diagnostic] of cases) {
    it(`exits 2 for ${label}, naming the field, before fetching`, async () => {
      const root = writeOverrideFixtureRepo(join(scratch, `metadata-${label}`), { [FIXTURE_DEP]: FIXTURE_VERSION });
      writeAllowlist(root, [{ ...exemption("2026-01-01", "2099-01-01"), ...fields }]);
      const recorder = join(root, "fetch-recorder.mjs");
      writeFileSync(recorder, `globalThis.fetch = async () => {
        process.stderr.write("REGISTRY_FETCH\\n");
        return Response.json({ time: { "${FIXTURE_VERSION}": new Date().toISOString() } });
      };`);
      const { exitCode, output } = await runGate(CLI_SCRIPT, {
        FLAIR_CHECK_DEP_AGES_ROOT: root,
        FLAIR_NPM_REGISTRY: "http://127.0.0.1:1",
        NODE_OPTIONS: `--import=${pathToFileURL(recorder).href}`,
      });
      expect(output).toContain("dep-age-allowlist.json entries[0]");
      expect(output).toContain(diagnostic);
      expect(output).not.toContain("Exempted fresh dependency versions");
      expect(output).not.toContain("REGISTRY_FETCH");
      expect(exitCode).toBe(2);
    }, 30_000);
  }
});

describe("CLI — a malformed exemption date fails the gate", () => {
  // A fresh override pin with ONE exemption entry whose dates are malformed.
  // The gate must refuse the allowlist (exit 2, naming the field) before any
  // registry request — never exempt the pin.
  async function assertMalformed(label: string, dates: { added: unknown; expires: unknown }, diagnostic: string) {
    const root = writeOverrideFixtureRepo(join(scratch, `malformed-${label}`), { [FIXTURE_DEP]: FIXTURE_VERSION });
    writeAllowlist(root, [{ ...exemption("2026-01-01", "2099-01-01"), ...dates }]);
    const registry = freshRegistry();
    try {
      const { exitCode, output } = await runGate(CLI_SCRIPT, {
        FLAIR_CHECK_DEP_AGES_ROOT: root,
        FLAIR_NPM_REGISTRY: registry.url,
      });
      expect(output).toContain("dep-age-allowlist.json entries[0]");
      expect(output).toContain(diagnostic);
      expect(output).not.toContain("Exempted fresh dependency versions");
      expect(registry.requests).toEqual([]);
      expect(exitCode).toBe(2);
    } finally {
      registry.stop();
    }
  }

  it("an invalid month", async () => {
    await assertMalformed("month", { added: "2026-01-01", expires: "2099-13-01" },
      '"expires" must be a calendar date string, YYYY-MM-DD');
  }, 30_000);

  it("an impossible day", async () => {
    await assertMalformed("day", { added: "2026-02-30", expires: "2099-01-01" },
      '"added" must be a calendar date string, YYYY-MM-DD');
  }, 30_000);

  it("an array date", async () => {
    await assertMalformed("array", { added: "2026-01-01", expires: ["2099-01-01"] },
      '"expires" must be a calendar date string, YYYY-MM-DD');
  }, 30_000);

  it("an expiry before the added date", async () => {
    await assertMalformed("reversed", { added: "2099-01-02", expires: "2099-01-01" },
      '"expires" (2099-01-01) must be after "added" (2099-01-02)');
  }, 30_000);
});

function recordingRegistry(root: string) {
  const requests = join(root, "registry-requests.jsonl");
  const preload = join(root, "registry.mjs");
  writeFileSync(requests, "");
  writeFileSync(preload, `
    import { appendFileSync } from "node:fs";
    globalThis.fetch = async (url) => {
      appendFileSync(${JSON.stringify(requests)}, JSON.stringify(String(url)) + "\\n");
      return Response.json({ time: { ${JSON.stringify(FIXTURE_VERSION)}: ${JSON.stringify(FRESH_TIME)} } });
    };
  `);
  return {
    env: { NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`, FLAIR_NPM_REGISTRY: "https://fixture.invalid" },
    requests: () => readFileSync(requests, "utf8").trim().split("\n").filter(Boolean),
  };
}

describe("CLI — resolutions", () => {
  for (const workspace of [false, true]) {
    const where = workspace ? "workspace" : "root";
    it(`refuses non-empty ${where} resolutions before a registry request`, async () => {
      const root = writeManifestRepo(join(scratch, `resolutions-${where}`), { name: "dep-ages-fixture" });
      const manifest = { name: "dep-ages-fixture", resolutions: { [FIXTURE_DEP]: "^1.0.0" } };
      const declaredIn = workspace ? "packages/example/package.json" : "package.json";
      if (workspace) mkdirSync(join(root, "packages/example"));
      writeFileSync(join(root, declaredIn), JSON.stringify(manifest));
      writeLock(root, lockWithPackages({ [FIXTURE_DEP]: "1.2.0" }));
      const registry = recordingRegistry(root);
      const { exitCode, output } = await runGate(CLI_SCRIPT, {
        FLAIR_CHECK_DEP_AGES_ROOT: root, ...registry.env,
      });
      expect(exitCode).toBe(2);
      expect(output).toContain(`${declaredIn} resolutions["${FIXTURE_DEP}"]`);
      expect(registry.requests()).toEqual([]);
    }, 30_000);

    it(`accepts empty ${where} resolutions and checks a dependency`, async () => {
      const root = writeFixtureRepo(join(scratch, `empty-resolutions-${where}`));
      const declaredIn = workspace ? "packages/example/package.json" : "package.json";
      if (workspace) mkdirSync(join(root, "packages/example"));
      writeFileSync(join(root, declaredIn), JSON.stringify({
        name: "dep-ages-fixture", resolutions: {}, dependencies: { [FIXTURE_DEP]: FIXTURE_VERSION },
      }));
      const registry = recordingRegistry(root);
      const { exitCode, output } = await runGate(CLI_SCRIPT, {
        FLAIR_CHECK_DEP_AGES_ROOT: root, FLAIR_DEP_MIN_AGE_DAYS: "0", ...registry.env,
      });
      expect(exitCode).toBe(0);
      expect(output).toContain("external dependency versions are at least 0 days old");
      expect(registry.requests()).toHaveLength(1);
    }, 30_000);
  }

  it("refuses resolutions before fetching a declared dependency", async () => {
    const root = writeManifestRepo(join(scratch, "resolutions-before-fetch"), {
      dependencies: { [FIXTURE_DEP]: FIXTURE_VERSION }, resolutions: { [FIXTURE_DEP]: "^1.0.0" },
    });
    const registry = recordingRegistry(root);
    const { exitCode, output } = await runGate(CLI_SCRIPT, { FLAIR_CHECK_DEP_AGES_ROOT: root, ...registry.env });
    expect(exitCode).toBe(2);
    expect(output).toContain(`resolutions["${FIXTURE_DEP}"]`);
    expect(registry.requests()).toEqual([]);
  }, 30_000);

  for (const value of [null, [], "^1.0.0"]) {
    it(`refuses malformed resolutions ${JSON.stringify(value)}`, async () => {
      const root = writeManifestRepo(join(scratch, `malformed-resolutions-${JSON.stringify(value)}`), { resolutions: value });
      const registry = recordingRegistry(root);
      const { exitCode, output } = await runGate(CLI_SCRIPT, { FLAIR_CHECK_DEP_AGES_ROOT: root, ...registry.env });
      expect(exitCode).toBe(2);
      expect(output).toContain("resolutions must be an empty object");
      expect(registry.requests()).toEqual([]);
    }, 30_000);
  }
});

describe("CLI — policy environment", () => {
  for (const registryUrl of ["https://registry.example.invalid", "http://10.0.0.1:4873", "not a url"]) {
    it(`--ci refuses FLAIR_NPM_REGISTRY=${JSON.stringify(registryUrl)} (not a loopback registry) before scanning`, async () => {
      const { exitCode, output } = await runGate(CLI_SCRIPT, { FLAIR_NPM_REGISTRY: registryUrl }, ["--ci"]);
      expect(exitCode).toBe(2);
      expect(output).toContain("FLAIR_NPM_REGISTRY");
      expect(output).toContain("Refusing to run");
      expect(output).not.toContain("Checking");
    }, 30_000);
  }

  for (const [variable, value] of [["FLAIR_DEP_MIN_AGE_DAYS", "0"], ["FLAIR_DEP_KEEP_CURRENT", FIXTURE_DEP]]) {
    for (const ciValue of [value, ""]) {
      it(`--ci refuses ${variable}=${JSON.stringify(ciValue)} before a registry request`, async () => {
        const root = writeFixtureRepo(join(scratch, `ci-policy-${variable}-${ciValue || "empty"}`));
        const registry = recordingRegistry(root);
        const { exitCode, output } = await runGate(CLI_SCRIPT, { [variable]: ciValue, ...registry.env }, ["--ci"]);
        expect(exitCode).toBe(2);
        expect(output).toContain(variable);
        expect(output).toContain("Refusing to run");
        expect(output).not.toContain("Checking");
        expect(registry.requests()).toEqual([]);
      }, 30_000);
    }

    it(`local runs apply ${variable}`, async () => {
      const root = writeFixtureRepo(join(scratch, `local-policy-${variable}`));
      const registry = recordingRegistry(root);
      const env = { FLAIR_CHECK_DEP_AGES_ROOT: root, ...registry.env };
      const defaults = await runGate(CLI_SCRIPT, env);
      expect(defaults.exitCode).toBe(1);
      expect(defaults.output).toContain(`${FIXTURE_DEP}@${FIXTURE_VERSION}`);
      expect(registry.requests()).toHaveLength(1);
      const configured = await runGate(CLI_SCRIPT, { ...env, [variable]: value });
      expect(configured.exitCode).toBe(0);
      expect(registry.requests()).toHaveLength(variable === "FLAIR_DEP_MIN_AGE_DAYS" ? 2 : 1);
    }, 30_000);
  }
});

describe("CLI fail-closed exit — the CI gate refuses the fixture-root override", () => {
  it("exits 2, naming the variable, when the CI invocation has the override set", async () => {
    const root = writeFixtureRepo(join(scratch, "ci-override"));
    const { exitCode, output } = await runGate(
      CLI_SCRIPT,
      // An unreachable registry keeps a RED run (main, which ignores --ci) off
      // the real npm registry; the discriminating assertion is the message.
      { FLAIR_CHECK_DEP_AGES_ROOT: root, FLAIR_NPM_REGISTRY: "http://127.0.0.1:1" },
      ["--ci"],
    );
    expect(output).toContain("FLAIR_CHECK_DEP_AGES_ROOT");
    expect(exitCode).toBe(2);
  }, 30_000);

  it("--ci without the override scans the real repository root", async () => {
    const registry = freshRegistry();
    try {
      const { exitCode, output } = await runGate(
        CLI_SCRIPT,
        { FLAIR_NPM_REGISTRY: registry.url },
        ["--ci"],
      );
      // It did NOT refuse ...
      expect(output).not.toContain("Refusing to run");
      // ... and it scanned the REAL root (several deps), not the one-dep fixture.
      expect(registry.requests.length).toBeGreaterThan(1);
      expect(registry.requests).not.toContain(`/${FIXTURE_DEP}`);
      // The fixture registry serves only FIXTURE_VERSION, so the real deps have
      // no publish time there and the gate fails closed (1 or 2).
      expect([1, 2]).toContain(exitCode);
    } finally {
      registry.stop();
    }
  }, 30_000);

  it("refuses an EMPTY override on the CI invocation, before reading or fetching", async () => {
    const registry = freshRegistry();
    try {
      const { exitCode, output } = await runGate(
        CLI_SCRIPT,
        { FLAIR_CHECK_DEP_AGES_ROOT: "", FLAIR_NPM_REGISTRY: registry.url },
        ["--ci"],
      );
      // A PRESENT-but-empty override is refused like any other.
      expect(output).toContain("FLAIR_CHECK_DEP_AGES_ROOT");
      expect(output).not.toContain("Checking"); // never started scanning
      expect(registry.requests).toEqual([]); // no registry request
      expect(exitCode).toBe(2);
    } finally {
      registry.stop();
    }
  }, 30_000);

  it("refuses an unknown argument, before scanning", async () => {
    const registry = freshRegistry();
    try {
      const { exitCode, output } = await runGate(
        CLI_SCRIPT,
        { FLAIR_NPM_REGISTRY: registry.url },
        ["--c1"], // a typo of --ci
      );
      expect(output).toContain("--c1"); // names the offending argument
      expect(output).toContain("--ci"); // ... and the accepted form
      expect(output).not.toContain("Checking");
      expect(registry.requests).toEqual([]);
      expect(exitCode).toBe(2);
    } finally {
      registry.stop();
    }
  }, 30_000);
});

describe("CLI fail-closed exit — unparseable publish time", () => {
  // Runs the gate against a fixture registry serving `value` as the pinned
  // dep's publish time, and asserts the fail-closed shape: the SPECIFIC
  // diagnostic, EXACTLY ONE request (not retried), and exit 2. Asserting the
  // diagnostic (not just the generic registry-failure report) keeps this from
  // passing on an unrelated fetch failure.
  async function assertUnparseable(label: string, value: unknown) {
    const root = writeFixtureRepo(join(scratch, `unparseable-${label}`));
    const registry = unparseableRegistry(value);
    try {
      const { exitCode, output } = await runGate(CLI_SCRIPT, {
        FLAIR_CHECK_DEP_AGES_ROOT: root,
        FLAIR_NPM_REGISTRY: registry.url,
      });
      expect(output).toContain("unparseable publish time");
      expect(output).toContain(`${FIXTURE_DEP}@${FIXTURE_VERSION}`);
      expect(output).not.toContain("younger than the bake-time policy");
      expect(registry.requests).toEqual([`/${FIXTURE_DEP}`]); // exactly one
      expect(exitCode).toBe(2);
    } finally {
      registry.stop();
    }
  }

  it("a non-date STRING is a non-retryable registry failure (flair#2076)", async () => {
    await assertUnparseable("string", "not-a-timestamp");
  }, 30_000);

  it("an OBJECT publish time fails closed without a retried throw", async () => {
    await assertUnparseable("object", { toString: null });
  }, 30_000);

  it("a NUMBER publish time fails closed (Date.parse(1) is a finite date)", async () => {
    await assertUnparseable("number", 1);
  }, 30_000);
});

/* ── CI wiring: the gate in the real workflow ───────────────────────── */

const DEP_AGES_GATE: Gate = { step: "Check dependency bake time (≥7 days)", command: "node scripts/check-dep-ages.mjs --ci" };
const WORKFLOW_DIR = join(REPO_ROOT, ".github", "workflows");

/** The steps of the `test-unit` job, from the workflow that defines it. */
function testUnitSteps(docs: WorkflowDoc[]) {
  const job = docs.map((doc) => doc.jobs?.["test-unit"]).find((found) => found !== undefined);
  if (!job?.steps) throw new Error("no workflow defines a test-unit job with steps");
  return job.steps;
}

/** Throws unless test-unit runs the bake-time step before its frozen install. */
function checkBakeTimeBeforeFrozenInstall(docs: WorkflowDoc[]): void {
  const steps = testUnitSteps(docs);
  const gate = steps.findIndex((step) => step.name === DEP_AGES_GATE.step);
  const install = steps.findIndex((step) => typeof step.run === "string" && /\bbun install --frozen-lockfile\b/.test(step.run));
  if (gate < 0) throw new Error(`test-unit has no "${DEP_AGES_GATE.step}" step`);
  if (install < 0) throw new Error("test-unit has no bun install --frozen-lockfile step");
  if (gate > install) throw new Error("the bake-time step must run before the frozen install");
}

describe("CI wiring — the bake-time gate in the real workflow", () => {
  for (const [label, build, error] of gateCases(WORKFLOW_DIR, DEP_AGES_GATE).filter(([label]) => label.includes(" env "))) {
    it(`refuses ${label}`, () => {
      expect(() => checkCoverageGate(build(), DEP_AGES_GATE)).toThrow(error);
    });
  }

  it("runs the gate with --ci in the required test-unit job, without skip controls, before the frozen install", () => {
    const docs = parseWorkflows(WORKFLOW_DIR);
    expect(() => checkCoverageGate(docs, DEP_AGES_GATE)).not.toThrow();
    expect(() => checkBakeTimeBeforeFrozenInstall(docs)).not.toThrow();
  });

  it("refuses a workflow with the step removed, set to continue-on-error, or moved after the frozen install", () => {
    const removed = parseWorkflows(WORKFLOW_DIR);
    const removedSteps = testUnitSteps(removed);
    removedSteps.splice(removedSteps.findIndex((step) => step.name === DEP_AGES_GATE.step), 1);
    expect(() => checkCoverageGate(removed, DEP_AGES_GATE)).toThrow(`no step is named "${DEP_AGES_GATE.step}"`);

    const soft = parseWorkflows(WORKFLOW_DIR);
    const softStep = testUnitSteps(soft).find((step) => step.name === DEP_AGES_GATE.step);
    if (!softStep) setupFailure("the bake-time step is missing from the parsed workflow");
    softStep["continue-on-error"] = true;
    expect(() => checkCoverageGate(soft, DEP_AGES_GATE)).toThrow("continue-on-error");

    const late = parseWorkflows(WORKFLOW_DIR);
    const lateSteps = testUnitSteps(late);
    const [gateStep] = lateSteps.splice(lateSteps.findIndex((step) => step.name === DEP_AGES_GATE.step), 1);
    lateSteps.push(gateStep);
    expect(() => checkBakeTimeBeforeFrozenInstall(late)).toThrow("the bake-time step must run before the frozen install");
  });
});
