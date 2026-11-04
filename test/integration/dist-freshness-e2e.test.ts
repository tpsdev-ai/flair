import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import ts from "typescript";
import { assertFlairDistFresh } from "../helpers/dist-freshness.js";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle.js";

function buildCopiedResources(root: string): void {
  const source = resolve(import.meta.dirname, "../..");
  for (const path of ["resources", "schemas", "scripts", "templates", "config.yaml", "package.json", "bun.lock", "tsconfig.json"]) {
    cpSync(join(source, path), join(root, path), { recursive: true });
  }
  mkdirSync(join(root, "packages"));
  cpSync(join(source, "packages/flair-tool-descriptors"), join(root, "packages/flair-tool-descriptors"), { recursive: true });
  const config = ts.getParsedCommandLineOfConfigFile(join(source, "tsconfig.json"), {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => { throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")); },
  });
  if (!config) throw new Error("Could not parse resource build config");
  expect(config.errors).toEqual([]);
  const program = ts.createProgram(config.fileNames, config.options);
  for (const input of program.getSourceFiles()) {
    if (program.isSourceFileDefaultLibrary(input) || program.isSourceFileFromExternalLibrary(input)) continue;
    const path = relative(source, input.fileName);
    expect(isAbsolute(path) || path === ".." || path.startsWith("../"), input.fileName).toBe(false);
    mkdirSync(dirname(join(root, path)), { recursive: true });
    cpSync(input.fileName, join(root, path));
  }
  symlinkSync(join(source, "node_modules"), join(root, "node_modules"), "dir");
  const build = spawnSync("bun", ["run", "build"], { cwd: root, encoding: "utf-8", timeout: 90_000 });
  expect(build.status, build.stdout + build.stderr).toBe(0);
  expect(existsSync(join(root, ".git"))).toBe(false);
  expect(JSON.parse(readFileSync(join(root, "dist/build-info.json"), "utf-8")).commit).toBeNull();
  expect(existsSync(join(root, "dist/cli.js"))).toBe(false);
  expect(() => assertFlairDistFresh(root)).not.toThrow();
}

test("startHarper refuses a copied build after a canonical descriptor edit without vendoring", async () => {
  const root = mkdtempSync(join(tmpdir(), "flair-descriptor-build-"));
  try {
    buildCopiedResources(root);
    const vendored = join(root, "resources/tool-descriptors/index.ts");
    const vendoredBefore = { contents: readFileSync(vendored, "utf-8"), mtime: statSync(vendored).mtimeMs };
    const canonical = join(root, "packages/flair-tool-descriptors/src/index.ts");
    const newer = new Date(Date.now() + 60_000);
    appendFileSync(canonical, "\n");
    utimesSync(canonical, newer, newer);
    expect({ contents: readFileSync(vendored, "utf-8"), mtime: statSync(vendored).mtimeMs }).toEqual(vendoredBefore);
    await expect(startHarper({ cwd: root })).rejects.toThrow("packages/flair-tool-descriptors/src/index.ts");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);

test("startHarper refuses a compiled src edit after accepting a CLI-only edit in a copied build", async () => {
  const root = mkdtempSync(join(tmpdir(), "flair-src-build-"));
  try {
    buildCopiedResources(root);
    const newer = new Date(Date.now() + 60_000);
    const cli = join(root, "src/cli.ts");
    cpSync(resolve(import.meta.dirname, "../../src/cli.ts"), cli);
    appendFileSync(cli, "\n");
    utimesSync(cli, newer, newer);
    expect(() => assertFlairDistFresh(root)).not.toThrow();
    const compiled = join(root, "src/lib/harper-port-value.ts");
    appendFileSync(compiled, "\n");
    utimesSync(compiled, newer, newer);
    await expect(startHarper({ cwd: root })).rejects.toThrow("src/lib/harper-port-value.ts");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);

test("startHarper boots a copied resource build with a null commit", async () => {
  const root = mkdtempSync(join(tmpdir(), "flair-resource-build-"));
  let harper: HarperInstance | undefined;
  try {
    buildCopiedResources(root);
    harper = await startHarper({ cwd: root });
    expect(harper.external).toBe(false);
    expect((await fetch(`${harper.httpURL}/Health`)).ok).toBe(true);
    const newer = new Date(Date.now() + 60_000);
    utimesSync(join(root, "resources/health.ts"), newer, newer);
    expect(() => assertFlairDistFresh(root)).toThrow("bun run build");
  } finally {
    try {
      if (harper) await stopHarper(harper);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
}, 300_000);

// This test requires the enclosing source root to be freshly built.
test("startHarper boots a compiled-only Flair component copy", async () => {
  const source = resolve(import.meta.dirname, "../..");
  const root = mkdtempSync(join(tmpdir(), "flair-compiled-build-"));
  let harper: HarperInstance | undefined;
  try {
    for (const path of ["config.yaml", "package.json", "dist", "schemas"]) {
      cpSync(join(source, path), join(root, path), { recursive: true });
    }
    symlinkSync(join(source, "node_modules"), join(root, "node_modules"), "dir");
    for (const marker of ["resources", "tsconfig.json", "scripts", "packages"]) {
      expect(existsSync(join(root, marker))).toBe(false);
    }
    harper = await startHarper({ cwd: root, harperBinDir: source });
    expect(harper.external).toBe(false);
    expect((await fetch(`${harper.httpURL}/Health`)).ok).toBe(true);
  } finally {
    try {
      if (harper) await stopHarper(harper);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
}, 300_000);
