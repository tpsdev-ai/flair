/**
 * flair#847 — the React Native check must see the published consumer tree.
 *
 * The original defect was not a missing override. It was that every check
 * we ran (this repo, `npm i -g` of the tarball) made flair the install root,
 * so the override applied and the tree looked clean. npm 10 against Harper's
 * shrinkwrap can also look clean. npm 12 in an empty project is the shape
 * that still pulls react-native today.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EXIT_DID_NOT_RUN,
  EXIT_FAIL,
  EXIT_OK,
  FLAIR_PACKAGE,
  NPM12_SPEC,
  evaluatePublishedTree,
  expectedRocksdbBindingName,
  formatReport,
  npmMajor,
  parseArgs,
  registryAuthNpmrc,
  resolveNpm12,
  scopedRegistryNpmrc,
  writeVerdaccioConfig,
} from "../../scripts/check-published-rn-tree.mjs";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const SCRIPT = join(REPO_ROOT, "scripts", "check-published-rn-tree.mjs");
const TEST_YML = readFileSync(join(REPO_ROOT, ".github", "workflows", "test.yml"), "utf8");

const created: string[] = [];
function scratch(prefix = "flair-published-rn-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

function writeTree(spec: Record<string, true>): string {
  const root = join(scratch(), "node_modules");
  mkdirSync(root, { recursive: true });
  for (const name of Object.keys(spec)) {
    const dir = name.startsWith("@") ? join(root, name) : join(root, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: name.split("/").pop(), version: "1.0.0" }) + "\n");
  }
  return root;
}

function runGate(args: string[]) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

describe("evaluatePublishedTree", () => {
  test("the 0.50.0 consumer tree (react-native present) fails", () => {
    const tree = writeTree({
      harper: true,
      "react-native": true,
      "react-native-fs": true,
      "@harperfast/rocksdb-js": true,
      "@harperfast/rocksdb-js-linux-x64-glibc": true,
    });
    const m = evaluatePublishedTree(tree);
    expect(m.didNotRun).toBe(false);
    expect(m.forbidden).toEqual(expect.arrayContaining(["react-native", "react-native-fs"]));
    expect(formatReport(m)).toContain("FAIL");
    expect(formatReport(m)).toMatch(/react-native/);
  });

  test("a clean consumer tree with harper and the platform binding passes", () => {
    const binding = expectedRocksdbBindingName({ platform: "linux", arch: "x64", libc: "glibc" });
    const tree = writeTree({
      harper: true,
      "@harperfast/rocksdb-js": true,
      [`@harperfast/${binding}`]: true,
    });
    const m = evaluatePublishedTree(tree);
    expect(m.forbidden).toEqual([]);
    expect(m.harperPresent).toBe(true);
    expect(m.rocksdbJsPresent).toBe(true);
    expect(m.bindingPresent).toBe(true);
    expect(formatReport(m)).toContain("OK");
  });

  test("RN absent but RocksDB binding missing is a fail, not a win", () => {
    const tree = writeTree({ harper: true, "@harperfast/rocksdb-js": true });
    const m = evaluatePublishedTree(tree);
    expect(m.forbidden).toEqual([]);
    expect(m.bindingPresent).toBe(false);
    expect(formatReport(m)).toMatch(/load-bearing|RocksDB|omit=optional/i);
  });

  test("a missing tree is did-not-run, not a clean pass", () => {
    const m = evaluatePublishedTree(join(scratch(), "no-such-node_modules"));
    expect(m.didNotRun).toBe(true);
    expect(formatReport(m)).toContain("DID NOT RUN");
  });
});

describe("npm 12 is required so npm 10 cannot false-pass", () => {
  test("npm 10 is rejected", () => {
    const spawn = ((cmd: string, args: string[]) => {
      if (args?.includes("--version") || cmd === "npx") return { status: 0, stdout: "10.9.7\n", stderr: "" };
      return { status: 1, stdout: "", stderr: "unused" };
    }) as unknown as typeof spawnSync;
    const r = resolveNpm12(null, spawn);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/npm 12|false-pass/i);
  });

  test("npx npm@12 is accepted", () => {
    const spawn = ((cmd: string, args: string[]) => {
      if (cmd === "npx" && args.includes(NPM12_SPEC)) return { status: 0, stdout: "12.0.2\n", stderr: "" };
      return { status: 1, stdout: "", stderr: "no" };
    }) as unknown as typeof spawnSync;
    const r = resolveNpm12(null, spawn);
    expect(r.ok).toBe(true);
    expect(r.version).toBe("12.0.2");
    expect(npmMajor("12.0.2")).toBe(12);
  });
});

describe("parseArgs", () => {
  test("from-workspace is the registry-shaped gate", () => {
    const a = parseArgs(["--from-workspace", "--workspace", "/tmp/flair"]);
    expect(a.fromWorkspace).toBe(true);
    expect(a.workspace).toBe("/tmp/flair");
    expect(a.tarball).toBeNull();
  });
});

describe("the process a human or CI step actually consumes", () => {
  test("a missing tarball exits 2 (DID NOT RUN), never 0", () => {
    const res = runGate(["--tarball", join(scratch(), "no.tgz"), "--npm", process.execPath]);
    expect(res.status).toBe(EXIT_DID_NOT_RUN);
    expect(res.status).not.toBe(0);
    expect(res.out).toContain("DID NOT RUN");
  });

  test("a tree with react-native exits 1", () => {
    const tree = writeTree({
      harper: true,
      "react-native": true,
      "@harperfast/rocksdb-js": true,
      "@harperfast/rocksdb-js-linux-x64-glibc": true,
    });
    const res = runGate(["--tree", tree]);
    expect(res.status).toBe(EXIT_FAIL);
    expect(res.out).toContain("FAIL");
  });

  test("a clean fixture tree exits 0", () => {
    const binding = expectedRocksdbBindingName();
    const spec: Record<string, true> = {
      harper: true,
      "@harperfast/rocksdb-js": true,
    };
    if (binding) spec[`@harperfast/${binding}`] = true;
    else spec["@harperfast/rocksdb-js-linux-x64-glibc"] = true;
    const tree = writeTree(spec);
    const res = runGate(["--tree", tree]);
    expect(res.status).toBe(EXIT_OK);
    expect(res.out).toContain("OK");
  });

  test("no args is DID NOT RUN, not a silent pass", () => {
    const res = runGate([]);
    expect(res.status).toBe(EXIT_DID_NOT_RUN);
    expect(res.out).toMatch(/Usage:/);
  });

  test("the clean-dir npmrc uses the throwaway registry as the default (npm 12 EALLOWREMOTE otherwise)", () => {
    expect(scopedRegistryNpmrc("http://127.0.0.1:4873")).toBe("registry=http://127.0.0.1:4873/\n");
    expect(FLAIR_PACKAGE).toBe("@tpsdev-ai/flair");
    expect(registryAuthNpmrc("http://127.0.0.1:4873")).toContain("//127.0.0.1:4873/:_authToken=");
  });

  test("the throwaway registry does not proxy @tpsdev-ai to npmjs (that 409s the published 0.53.0)", () => {
    const dir = scratch("verdaccio-cfg-");
    const cfg = readFileSync(writeVerdaccioConfig(dir, 4873), "utf8");
    const scoped = cfg.split("'@tpsdev-ai/*':")[1]?.split("'**':")[0] ?? "";
    expect(scoped).toMatch(/publish: \$all/);
    expect(scoped).not.toMatch(/proxy:/);
    expect(cfg).toContain("max_body_size: 100mb");
  });
});

describe("the CI job must remain able to fail", () => {
  const start = TEST_YML.indexOf("\n  published-rn-tree:");
  expect(start).toBeGreaterThan(-1);
  const rest = TEST_YML.slice(start + 1);
  const next = rest.search(/\n  [a-z0-9-]+:/);
  const job = next === -1 ? rest : rest.slice(0, next);
  const directives = job
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");

  test("invokes the gate as Cos's registry command, not a local tarball install", () => {
    expect(directives).toContain("scripts/check-published-rn-tree.mjs");
    expect(directives).toContain("--from-workspace");
    expect(directives).not.toMatch(/--tarball/);
    expect(job).toMatch(/npm i @tpsdev-ai\/flair|install @tpsdev-ai\/flair/);
    expect(job).toMatch(/clean dir|empty project|not this repo/i);
  });

  test("installs as a dependency, not globally, and pins npm 12", () => {
    expect(job).toMatch(/dependenc|empty project|clean dir|not this repo/i);
    expect(directives).not.toMatch(/install --global|npm install -g/);
    expect(job).toMatch(/npm 12|npm@12/);
  });

  test("has no continue-on-error and does not swallow the exit code", () => {
    expect(directives).not.toContain("continue-on-error");
    const gateLine = directives.split("\n").find((l) => l.includes("check-published-rn-tree.mjs")) ?? "";
    expect(gateLine.length).toBeGreaterThan(0);
    expect(gateLine).not.toMatch(/\|\|\s*(true|echo|:)/);
  });

  test("is marked blocking, not advisory", () => {
    expect(job).toContain("BLOCKING");
    expect(job).not.toMatch(/PROMOTION CRITERION/);
  });
});

describe("release publishes the Harper reprint before Flair", () => {
  const releaseSh = readFileSync(join(REPO_ROOT, "scripts", "release.sh"), "utf8");
  const releaseYml = readFileSync(join(REPO_ROOT, ".github", "workflows", "release-publish.yml"), "utf8");

  test("break-glass publishes @tpsdev-ai/harper before @tpsdev-ai/flair", () => {
    const harperAt = releaseSh.indexOf("Publishing @tpsdev-ai/harper");
    const flairAt = releaseSh.indexOf('Publishing @tpsdev-ai/flair..."');
    expect(harperAt).toBeGreaterThan(-1);
    expect(flairAt).toBeGreaterThan(-1);
    expect(harperAt).toBeLessThan(flairAt);
  });

  test("OIDC staging emits the reprint before the flair tarball", () => {
    expect(releaseYml).toContain("materialize-patched-harper.mjs --emit-dir");
    const harperAt = releaseYml.indexOf("Stage-publish @tpsdev-ai/harper");
    const flairLoopAt = releaseYml.indexOf("Stage-publish all packages (dependency order)");
    expect(harperAt).toBeGreaterThan(-1);
    expect(flairLoopAt).toBeGreaterThan(-1);
    expect(harperAt).toBeLessThan(flairLoopAt);
  });
});

describe("cleanup", () => {
  test("removes fixtures", () => {
    for (const d of created) rmSync(d, { recursive: true, force: true });
    expect(true).toBe(true);
  });
});
