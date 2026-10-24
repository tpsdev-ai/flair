import { afterAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
// @ts-expect-error — plain .mjs helper, no type declarations by design.
import { harperSearchPaths, resolveHarperDependency, vendorPinnedNodeProblems } from "../../scripts/audit-gate.mjs";

/**
 * The audit gate's dependency lookup compared with Node's resolver on a tree of
 * real directories and package.json files. Node runs as a child process, so the
 * comparison is with `node`'s resolver rather than the test runner's. The gate
 * searches no higher than harper's directory, so a package Node resolves above
 * it is expected to resolve to nothing in the gate.
 */

const NODE_TIMEOUT_MS = 30_000;
const CASE_BUDGET_MS = 60_000;

type Manifest = {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  bundleDependencies?: string[];
  exports?: Record<string, string>;
};

const HARPER = "node_modules/harper";
const deps = (...names: string[]) => Object.fromEntries(names.map((name) => [name, "*"]));

/** Package directory (relative to the prefix) -> its package.json. */
const PACKAGES: Record<string, Manifest> = {
  "node_modules/above-only": { name: "above-only", version: "1.0.0" },
  [HARPER]: {
    name: "harper",
    version: "1.0.0",
    dependencies: deps("pkg-a", "@scope-s/pkg-d", "above-only", "nm-only", "exp-only-dot", "exp-sub-only"),
    bundleDependencies: ["pkg-a"],
  },
  [`${HARPER}/node_modules/pkg-a`]: {
    name: "pkg-a",
    version: "1.0.0",
    dependencies: deps("pkg-b", "pkg-c", "@scope-s/pkg-d", "pkg-e", "nm-only", "above-only", "absent"),
  },
  [`${HARPER}/node_modules/pkg-a/node_modules/pkg-b`]: { name: "pkg-b", version: "2.0.0", dependencies: deps("pkg-c", "pkg-b") },
  [`${HARPER}/node_modules/pkg-b`]: { name: "pkg-b", version: "1.0.0", dependencies: deps("pkg-c") },
  [`${HARPER}/node_modules/pkg-c`]: { name: "pkg-c", version: "1.0.0", dependencies: deps("pkg-b", "pkg-e") },
  [`${HARPER}/node_modules/@scope-s/pkg-d`]: {
    name: "@scope-s/pkg-d",
    version: "1.0.0",
    dependencies: deps("pkg-e", "pkg-f", "pkg-b", "nm-only"),
  },
  [`${HARPER}/node_modules/@scope-s/pkg-d/node_modules/pkg-f`]: { name: "pkg-f", version: "1.0.0" },
  [`${HARPER}/node_modules/@scope-s/node_modules/pkg-e`]: { name: "pkg-e", version: "1.0.0" },
  // Only in harper's node_modules/node_modules, a directory Node's search lists leave out.
  [`${HARPER}/node_modules/node_modules/nm-only`]: { name: "nm-only", version: "1.0.0", dependencies: deps("pkg-c", "pkg-g") },
  // Required only by nm-only.
  [`${HARPER}/node_modules/pkg-g`]: { name: "pkg-g", version: "1.0.0" },
  // Exports hide ./package.json; a correct gate still selects the installed manifest.
  [`${HARPER}/node_modules/exp-only-dot`]: { name: "exp-only-dot", version: "1.0.0", exports: { ".": "./index.js" } },
  [`${HARPER}/node_modules/exp-sub-only`]: { name: "exp-sub-only", version: "1.0.0", exports: { "./sub": "./sub.js" } },
  // On disk so a name-shape check, not absence, rejects them; npm names never contain a mid-segment @.
  [`${HARPER}/node_modules/a@b`]: { name: "a@b", version: "1.0.0" },
  [`${HARPER}/node_modules/@scope-s/a@b`]: { name: "@scope-s/a@b", version: "1.0.0" },
};

const SYMLINKED = `${HARPER}/node_modules/shadow-requirer`;
const SYMLINKED_TARGET = `${HARPER}/node_modules/.real/shadow-requirer`;

/**
 * Packages reached through the symlinked requirer only, so they stay out of the
 * flat edge list. The listed requirer path searches harper's top-level
 * node_modules; its real path searches `.real/node_modules` first, which holds a
 * different copy of `dep-copy`.
 */
const SYMLINKED_PACKAGES: Record<string, Manifest> = {
  [SYMLINKED_TARGET]: { name: "shadow-requirer", version: "1.0.0", dependencies: deps("dep-copy") },
  [`${HARPER}/node_modules/.real/node_modules/dep-copy`]: { name: "dep-copy", version: "2.0.0" },
  [`${HARPER}/node_modules/dep-copy`]: { name: "dep-copy", version: "1.0.0" },
};

let root: string | undefined;

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

/** Write the fixture once; returns the real paths of the prefix and harper's directory. */
function fixture(): { prefix: string; realHarper: string } {
  if (!root) {
    root = realpathSync(mkdtempSync(join(tmpdir(), "flair-audit-parity-")));
    for (const [dir, manifest] of Object.entries({ ...PACKAGES, ...SYMLINKED_PACKAGES })) {
      mkdirSync(join(root, "prefix", dir), { recursive: true });
      writeFileSync(join(root, "prefix", dir, "package.json"), JSON.stringify(manifest));
    }
    writeFileSync(
      join(root, "prefix", SYMLINKED_TARGET, "index.js"),
      'module.exports = { resolved: require.resolve("dep-copy/package.json") };\n',
    );
    symlinkSync(join(root, "prefix", SYMLINKED_TARGET), join(root, "prefix", SYMLINKED));
    mkdirSync(join(root, "home"));
  }
  return { prefix: join(root, "prefix"), realHarper: join(root, "prefix", HARPER) };
}

type Edge = { requirer: string; dep: string };
type NodeAnswer = { resolved: string | null; paths: string[] };

/** Every dependency edge of every package in the flat fixture list. */
function edges(prefix: string): Edge[] {
  return Object.entries(PACKAGES)
    .filter(([dir]) => dir === HARPER || dir.startsWith(`${HARPER}/`))
    .flatMap(([dir, manifest]) =>
      Object.keys(manifest.dependencies ?? {}).map((dep) => ({ requirer: join(prefix, dir), dep })),
    );
}

/** Node's answer for each edge: `createRequire(<requirer>/package.json)`'s resolve and resolve.paths. */
function nodeAnswers(edgeList: Edge[]): NodeAnswer[] {
  const script = join(root!, "node-resolve.mjs");
  writeFileSync(
    script,
    [
      'import { createRequire } from "node:module";',
      'import { readFileSync, realpathSync } from "node:fs";',
      'const edges = JSON.parse(readFileSync(0, "utf8"));',
      "/** The package.json Node selected for dep, from resolve or from the exports error that named it. */",
      "function selectedManifest(req, dep) {",
      "  try {",
      '    return req.resolve(dep + "/package.json");',
      "  } catch (e) {",
      '    if (e.code === "MODULE_NOT_FOUND") return null;',
      '    if (e.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") throw e;',
      "    const named = / in (.+package\\.json)$/.exec(e.message);",
      "    if (!named) throw e;",
      "    return named[1];",
      "  }",
      "}",
      "const answers = edges.map(({ requirer, dep }) => {",
      '  const req = createRequire(requirer + "/package.json");',
      "  const resolved = selectedManifest(req, dep);",
      "  return { resolved: resolved === null ? null : realpathSync(resolved), paths: req.resolve.paths(dep) };",
      "});",
      "process.stdout.write(JSON.stringify(answers));",
      "",
    ].join("\n"),
  );
  const run = spawnSync("node", [script], {
    input: JSON.stringify(edgeList),
    encoding: "utf8",
    timeout: NODE_TIMEOUT_MS,
    env: { PATH: process.env.PATH ?? "", HOME: join(root!, "home") },
  });
  if (run.error || run.status !== 0) {
    throw new Error(`node resolver script failed (status ${run.status}, ${run.error?.message ?? "no spawn error"}):\n${run.stderr}`);
  }
  return JSON.parse(run.stdout) as NodeAnswer[];
}

/**
 * Load `name` from `anchor`'s package.json in a Node child, by the module name
 * as listed, and return the real path of its entry point and of the
 * `dep-copy/package.json` the loaded copy resolved from inside itself.
 */
function nodeLoadsListed(anchor: string, name: string): { entry: string; resolved: string } {
  const script = join(root!, "node-load.mjs");
  writeFileSync(
    script,
    [
      'import { createRequire } from "node:module";',
      'import { readFileSync, realpathSync } from "node:fs";',
      'const input = JSON.parse(readFileSync(0, "utf8"));',
      "const requireFromAnchor = createRequire(input.anchor);",
      "const entry = requireFromAnchor.resolve(input.name);",
      "const loaded = requireFromAnchor(input.name);",
      'process.stdout.write(JSON.stringify({ entry: realpathSync(entry), resolved: realpathSync(loaded.resolved) }));',
      "",
    ].join("\n"),
  );
  const run = spawnSync("node", [script], {
    input: JSON.stringify({ anchor, name }),
    encoding: "utf8",
    timeout: NODE_TIMEOUT_MS,
    env: { PATH: process.env.PATH ?? "", HOME: join(root!, "home") },
  });
  if (run.error || run.status !== 0) {
    throw new Error(`node loader script failed (status ${run.status}, ${run.error?.message ?? "no spawn error"}):\n${run.stderr}`);
  }
  return JSON.parse(run.stdout) as { entry: string; resolved: string };
}

describe("the audit gate's dependency lookup matches Node's resolver", () => {
  it(
    "matches Node's resolution inside harper's directory, and Node's search directories up to it, for each edge of the fixture tree",
    () => {
      const { prefix, realHarper } = fixture();
      const edgeList = edges(prefix);
      const answers = nodeAnswers(edgeList);
      const insideHarper = (path: string) => path.startsWith(`${realHarper}${sep}`);
      const show = (path: string | null) => (path === null ? null : relative(prefix, path));
      const label = (edge: Edge) => `${relative(prefix, edge.requirer)} -> ${edge.dep}`;

      const gate = edgeList.map((edge) => ({
        edge: label(edge),
        resolved: show(resolveHarperDependency(edge.requirer, realHarper, edge.dep)?.manifest ?? null),
        paths: harperSearchPaths(edge.requirer, realHarper).map(show),
      }));
      const node = edgeList.map((edge, i) => ({
        edge: label(edge),
        resolved: show(answers[i]!.resolved !== null && insideHarper(answers[i]!.resolved!) ? answers[i]!.resolved : null),
        paths: answers[i]!.paths.filter(insideHarper).map(show),
      }));
      expect(gate).toEqual(node);

      // The fixture exercises the cases the comparison is for.
      const byEdge = new Map(edgeList.map((edge, i) => [label(edge), answers[i]!]));
      const pkgA = `${HARPER}/node_modules/pkg-a`;
      expect(edgeList.length).toBe(24);
      expect(byEdge.get(`${pkgA} -> nm-only`)!.resolved).toBeNull();
      expect(show(byEdge.get(`${HARPER} -> exp-only-dot`)!.resolved)).toBe(`${HARPER}/node_modules/exp-only-dot/package.json`);
      expect(show(byEdge.get(`${HARPER} -> exp-sub-only`)!.resolved)).toBe(`${HARPER}/node_modules/exp-sub-only/package.json`);
      expect(show(byEdge.get(`${pkgA} -> above-only`)!.resolved)).toBe("node_modules/above-only/package.json");
      expect(show(byEdge.get(`${pkgA} -> pkg-b`)!.resolved)).toBe(`${pkgA}/node_modules/pkg-b/package.json`);
      expect(show(byEdge.get(`${HARPER}/node_modules/@scope-s/pkg-d -> pkg-e`)!.resolved)).toBe(
        `${HARPER}/node_modules/@scope-s/node_modules/pkg-e/package.json`,
      );
      expect(byEdge.get(`${pkgA} -> pkg-c`)!.paths.filter(insideHarper).map(show)).toEqual([
        `${pkgA}/node_modules`,
        `${HARPER}/node_modules`,
      ]);
    },
    CASE_BUDGET_MS,
  );

  it(
    "rejects a dependency name with an @ inside a segment, and accepts name and @scope/name",
    () => {
      const { prefix, realHarper } = fixture();
      expect(resolveHarperDependency(realHarper, realHarper, "a@b")).toBeNull();
      expect(resolveHarperDependency(realHarper, realHarper, "@scope-s/a@b")).toBeNull();
      expect(resolveHarperDependency(realHarper, realHarper, "pkg-a")?.dir).toBe(
        join(prefix, HARPER, "node_modules", "pkg-a"),
      );
      expect(resolveHarperDependency(realHarper, realHarper, "@scope-s/pkg-d")?.dir).toBe(
        join(prefix, HARPER, "node_modules", "@scope-s", "pkg-d"),
      );
    },
    CASE_BUDGET_MS,
  );

  it(
    "resolves a symlinked requirer's dependency from the requirer's real path, as Node does",
    () => {
      const { prefix, realHarper } = fixture();
      const listedDir = join(prefix, SYMLINKED);
      const realDir = realpathSync(listedDir);

      // The closure walk queues the directory resolveHarperDependency returns.
      const requirer = resolveHarperDependency(realHarper, realHarper, "shadow-requirer");
      expect(requirer?.dir).toBe(realDir);

      const gate = resolveHarperDependency(requirer!.dir, realHarper, "dep-copy");
      expect(gate?.dir).toBe(join(prefix, HARPER, "node_modules", ".real", "node_modules", "dep-copy"));
      expect(JSON.parse(readFileSync(gate!.manifest, "utf8")).version).toBe("2.0.0");

      // Node loads the requirer by the listed path, a symlink; the loaded copy resolves dep-copy from its real directory.
      const listed = nodeLoadsListed(join(prefix, HARPER, "package.json"), "shadow-requirer");
      expect(listed.entry).toBe(join(realDir, "index.js"));
      expect(listed.resolved).toBe(gate!.manifest);

      // The listed path's own search reaches the shallower copy, which the gate must not select.
      expect(resolveHarperDependency(listedDir, realHarper, "dep-copy")?.dir).toBe(
        join(prefix, HARPER, "node_modules", "dep-copy"),
      );
    },
    CASE_BUDGET_MS,
  );

  it(
    "certifies a package reached through edges Node resolves, but not one reached only through an edge Node refuses",
    () => {
      const { prefix } = fixture();
      const lock = {
        packages: {
          [`${HARPER}/node_modules/pkg-c`]: { version: "1.0.0", inBundle: true },
          [`${HARPER}/node_modules/pkg-g`]: { version: "1.0.0", inBundle: true },
        },
      };
      writeFileSync(join(prefix, "package-lock.json"), JSON.stringify(lock));
      const check = (pkg: string) =>
        vendorPinnedNodeProblems(
          { ghsa: "GHSA-0000-0000-0003", package: pkg, nodes: [`${HARPER}/node_modules/${pkg}`], nodeVersions: {} },
          prefix,
        );
      expect(check("pkg-c")).toEqual([]);
      const problems = check("pkg-g").join("\n");
      expect(problems).toContain(`${HARPER}/node_modules/pkg-g`);
      expect(problems).toContain(`"pkg-g" is not listed in harper's bundleDependencies and is not in a bundled package's dependency closure`);
    },
    CASE_BUDGET_MS,
  );
});
