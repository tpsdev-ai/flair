import { afterAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error — plain .mjs helper, no type declarations by design.
import { vendorPinnedNodeProblems } from "../../scripts/audit-gate.mjs";

/**
 * The vendor-pinned node check run against a tree and a package-lock written by
 * the real npm. The fixture is a local package named harper that bundles one
 * dependency (bundle-a, which depends on bundle-b) and also depends on dep-c
 * without bundling it. npm installs harper's own dependencies, packs harper
 * with `npm pack`, and installs the tarball with
 * `npm install --ignore-scripts --omit=dev --offline` into a consumer prefix
 * that depends on a different dep-c, so npm nests harper's dep-c under harper.
 * Every package is a local tarball, so npm needs no registry, and each install
 * passes `--offline`. A second consumer installs a variant whose
 * bundleDependencies is `true`.
 */

const NPM_TIMEOUT_MS = 60_000;
const CASE_BUDGET_MS = 180_000;

const npmProbe = spawnSync("npm", ["--version"], { encoding: "utf8", timeout: NPM_TIMEOUT_MS });
const NPM_ABSENT = (npmProbe.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";

const HARPER = "node_modules/harper";
const BUNDLE_A = `${HARPER}/node_modules/bundle-a`;
const BUNDLE_B = `${HARPER}/node_modules/bundle-b`;
const DEP_C = `${HARPER}/node_modules/dep-c`;
const DEP_H = "node_modules/dep-h";

let root: string | undefined;
let installs: { listed: string; all: string; hoisted: string; shared: string } | undefined;

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

function npm(args: string[], cwd: string, env: Record<string, string>): void {
  const run = spawnSync("npm", args, { cwd, env, encoding: "utf8", timeout: NPM_TIMEOUT_MS });
  if (run.error || run.status !== 0) {
    throw new Error(
      `npm ${args.join(" ")} in ${cwd} failed (status ${run.status}, ${run.error?.message ?? "no spawn error"}):\n${run.stderr}`,
    );
  }
}

/** Build both consumer installs once; later cases reuse them. */
function npmInstalls(): { listed: string; all: string; hoisted: string; shared: string } {
  if (installs) return installs;
  root = mkdtempSync(join(tmpdir(), "flair-audit-npm-bundle-"));
  const dir = root;
  for (const sub of ["src", "tgz", "home", "cache", "tmp"]) mkdirSync(join(dir, sub));
  writeFileSync(join(dir, "npmrc"), "");
  writeFileSync(join(dir, "npmrc-global"), "");
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: join(dir, "home"),
    TMPDIR: join(dir, "tmp"),
    npm_config_userconfig: join(dir, "npmrc"),
    npm_config_globalconfig: join(dir, "npmrc-global"),
    npm_config_cache: join(dir, "cache"),
    npm_config_update_notifier: "false",
    npm_config_fund: "false",
    npm_config_audit: "false",
  };
  const tgz = (file: string) => `file:${join(dir, "tgz", file)}`;
  const writePackage = (srcName: string, manifest: Record<string, unknown>) => {
    const src = join(dir, "src", srcName);
    mkdirSync(src);
    writeFileSync(join(src, "package.json"), JSON.stringify(manifest));
    writeFileSync(join(src, "index.js"), "module.exports = 1;\n");
    return src;
  };
  const pack = (src: string) => npm(["pack", "--pack-destination", join(dir, "tgz")], src, env);

  pack(writePackage("bundle-b", { name: "bundle-b", version: "1.0.0" }));
  pack(writePackage("bundle-a", { name: "bundle-a", version: "1.0.0", dependencies: { "bundle-b": tgz("bundle-b-1.0.0.tgz") } }));
  pack(writePackage("dep-c-1", { name: "dep-c", version: "1.0.0" }));
  pack(writePackage("dep-c-2", { name: "dep-c", version: "2.0.0" }));
  pack(writePackage("dep-h", { name: "dep-h", version: "1.0.0" }));

  const harperDependencies = { "bundle-a": tgz("bundle-a-1.0.0.tgz"), "dep-c": tgz("dep-c-2.0.0.tgz") };
  const variants = [
    { key: "listed", version: "1.0.0", bundleDependencies: ["bundle-a"] as string[] | true, dependencies: harperDependencies, installDependencies: harperDependencies, consumer: { "dep-c": tgz("dep-c-1.0.0.tgz") } },
    { key: "all", version: "2.0.0", bundleDependencies: true as string[] | true, dependencies: harperDependencies, installDependencies: harperDependencies, consumer: { "dep-c": tgz("dep-c-1.0.0.tgz") } },
    { key: "hoisted", version: "3.0.0", bundleDependencies: ["bundle-a"] as string[] | true, dependencies: { ...harperDependencies, "dep-h": "1.0.0" }, installDependencies: { ...harperDependencies, "dep-h": tgz("dep-h-1.0.0.tgz") }, consumer: {}, overrides: { "dep-h": tgz("dep-h-1.0.0.tgz") } },
    { key: "shared", version: "4.0.0", bundleDependencies: ["bundle-a"] as string[] | true, dependencies: { ...harperDependencies, "dep-h": "1.0.0" }, installDependencies: { ...harperDependencies, "dep-h": tgz("dep-h-1.0.0.tgz") }, consumer: { "dep-h": tgz("dep-h-1.0.0.tgz") } },
  ];
  const prefixes: Record<string, string> = {};
  for (const variant of variants) {
    const src = writePackage(`harper-${variant.key}`, {
      name: "harper",
      version: variant.version,
      dependencies: variant.installDependencies,
      bundleDependencies: variant.bundleDependencies,
    });
    npm(["install", "--ignore-scripts", "--offline"], src, env);
    // Pack the registry-shaped manifest: the source install needed the local
    // tarball spec, but a published harper declares the exact version.
    writeFileSync(join(src, "package.json"), JSON.stringify({
      name: "harper",
      version: variant.version,
      dependencies: variant.dependencies,
      bundleDependencies: variant.bundleDependencies,
    }));
    pack(src);
    const prefix = join(dir, `consumer-${variant.key}`);
    mkdirSync(prefix);
    writeFileSync(
      join(prefix, "package.json"),
      JSON.stringify({
        name: `consumer-${variant.key}`,
        version: "1.0.0",
        dependencies: variant.consumer,
        ...("overrides" in variant ? { overrides: variant.overrides } : {}),
      }),
    );
    npm(
      ["install", "--ignore-scripts", "--omit=dev", "--offline", join(dir, "tgz", `harper-${variant.version}.tgz`)],
      prefix,
      env,
    );
    prefixes[variant.key] = prefix;
  }
  installs = {
    listed: prefixes.listed,
    all: prefixes.all,
    hoisted: prefixes.hoisted,
    shared: prefixes.shared,
  };
  return installs;
}

function lockRows(prefix: string): Record<string, { version?: string; inBundle?: boolean }> {
  return JSON.parse(readFileSync(join(prefix, "package-lock.json"), "utf8")).packages;
}

function check(prefix: string, pkg: string, node: string, version: string, entry?: Record<string, unknown>): string[] {
  return vendorPinnedNodeProblems(
    { ghsa: "GHSA-0000-0000-0002", package: pkg, nodes: [node], nodeVersions: { [node]: version } },
    prefix,
    entry,
  );
}

describe.skipIf(NPM_ABSENT)(
  `vendor check against a real npm install of a bundled package${NPM_ABSENT ? " (skipped: npm is not on PATH)" : ""}`,
  () => {
    it(
      "accepts the bundled package and a hoisted member of its dependency closure",
      () => {
        const { listed } = npmInstalls();
        const rows = lockRows(listed);
        expect(rows[BUNDLE_A]).toMatchObject({ version: "1.0.0", inBundle: true });
        expect(rows[BUNDLE_B]).toMatchObject({ version: "1.0.0", inBundle: true });
        expect(check(listed, "bundle-a", BUNDLE_A, "1.0.0")).toEqual([]);
        expect(check(listed, "bundle-b", BUNDLE_B, "1.0.0")).toEqual([]);
      },
      CASE_BUDGET_MS,
    );

    it(
      "refuses a dependency npm nested under harper outside the bundle",
      () => {
        const { listed } = npmInstalls();
        const rows = lockRows(listed);
        expect(rows[DEP_C]?.version).toBe("2.0.0");
        expect(rows[DEP_C]?.inBundle).toBeUndefined();
        const problems = check(listed, "dep-c", DEP_C, "2.0.0").join("\n");
        expect(problems).toContain(DEP_C);
        expect(problems).toContain("does not mark node_modules/dep-c as inBundle");
      },
      CASE_BUDGET_MS,
    );

    it(
      "refuses a node harper does not bundle when its package-lock row is edited to claim inBundle",
      () => {
        const { listed } = npmInstalls();
        const prefix = `${listed}-edited-lock`;
        cpSync(listed, prefix, { recursive: true });
        const lock = JSON.parse(readFileSync(join(prefix, "package-lock.json"), "utf8"));
        lock.packages[DEP_C] = { ...lock.packages[DEP_C], inBundle: true };
        writeFileSync(join(prefix, "package-lock.json"), JSON.stringify(lock));
        const problems = check(prefix, "dep-c", DEP_C, "2.0.0").join("\n");
        expect(problems).toContain(DEP_C);
        expect(problems).toContain(
          `"dep-c" is not listed in harper's bundleDependencies and is not in a bundled package's dependency closure`,
        );
      },
      CASE_BUDGET_MS,
    );

    it(
      "accepts each of harper's dependencies when bundleDependencies is true",
      () => {
        const { all } = npmInstalls();
        const rows = lockRows(all);
        for (const [node, version] of [[BUNDLE_A, "1.0.0"], [BUNDLE_B, "1.0.0"], [DEP_C, "2.0.0"]]) {
          expect(rows[node]).toMatchObject({ version, inBundle: true });
          expect(check(all, node.slice(node.lastIndexOf("/") + 1), node, version)).toEqual([]);
        }
      },
      CASE_BUDGET_MS,
    );
    it(
      "accepts a hoisted exact dependency that only harper requires",
      () => {
        const { hoisted } = npmInstalls();
        const rows = lockRows(hoisted);
        expect(rows[DEP_H]).toMatchObject({ version: "1.0.0" });
        expect(rows[HARPER]?.version).toBe("3.0.0");
        expect(check(hoisted, "dep-h", DEP_H, "1.0.0", { hoistedNode: DEP_H })).toEqual([]);
      },
      CASE_BUDGET_MS,
    );

    it(
      "refuses a hoisted node that a second package also reaches, naming it",
      () => {
        const { shared } = npmInstalls();
        const problems = check(shared, "dep-h", DEP_H, "1.0.0", { hoistedNode: DEP_H }).join("\n");
        expect(problems).toContain(DEP_H);
        expect(problems).toContain('the root package ("")');
        expect(problems).toContain("harper is not its only dependent");
      },
      CASE_BUDGET_MS,
    );

    it(
      "refuses a range declaration in harper for a hoisted node",
      () => {
        const { hoisted } = npmInstalls();
        const prefix = `${hoisted}-range`;
        cpSync(hoisted, prefix, { recursive: true });
        const manifestPath = join(prefix, HARPER, "package.json");
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
        manifest.dependencies["dep-h"] = "^1.0.0";
        writeFileSync(manifestPath, JSON.stringify(manifest));
        const problems = check(prefix, "dep-h", DEP_H, "1.0.0", { hoistedNode: DEP_H }).join("\n");
        expect(problems).toContain("not an exact version");
      },
      CASE_BUDGET_MS,
    );

    it(
      "refuses a hoisted node whose installed version differs from harper's exact pin",
      () => {
        const { hoisted } = npmInstalls();
        const prefix = `${hoisted}-installed`;
        cpSync(hoisted, prefix, { recursive: true });
        const manifestPath = join(prefix, DEP_H, "package.json");
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
        writeFileSync(manifestPath, JSON.stringify({ ...manifest, version: "1.0.1" }));
        const problems = check(prefix, "dep-h", DEP_H, "1.0.0", { hoistedNode: DEP_H }).join("\n");
        expect(problems).toContain("the installed node has version 1.0.1");
      },
      CASE_BUDGET_MS,
    );

    it(
      "refuses a hoisted node whose audit version differs from harper's exact pin",
      () => {
        const { hoisted } = npmInstalls();
        const problems = check(hoisted, "dep-h", DEP_H, "1.0.1", { hoistedNode: DEP_H }).join("\n");
        expect(problems).toContain("has audit version \"1.0.1\"");
      },
      CASE_BUDGET_MS,
    );

    it(
      "a hoisted entry does not cover a nested node",
      () => {
        const { listed } = npmInstalls();
        const problems = check(listed, "dep-c", DEP_C, "2.0.0", { hoistedNode: "node_modules/dep-c" }).join("\n");
        expect(problems).toContain("is nested under harper");
        expect(problems).toContain("scoped to hoisted node");
      },
      CASE_BUDGET_MS,
    );

    it(
      "a nested entry does not cover a hoisted node",
      () => {
        const { hoisted } = npmInstalls();
        const problems = check(hoisted, "dep-h", DEP_H, "1.0.0").join("\n");
        expect(problems).toContain("is hoisted");
        expect(problems).toContain("does not name that node");
      },
      CASE_BUDGET_MS,
    );
  },
);
