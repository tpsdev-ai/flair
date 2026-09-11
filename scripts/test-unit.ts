import { existsSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export interface UnitStep {
  name: string;
  cwd: string;
  args: string[];
  files: string[];
}

export function unitEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // Tests supply their own Flair identities/backends. Inheriting a developer's
  // deployment configuration can turn a missing mock into a production write.
  return Object.fromEntries(Object.entries(source).filter(([key]) =>
    !/^(FLAIR_|HARPER_|HDB_|FABRIC_)/.test(key),
  ));
}

function testFiles(dir: string, recursive = true): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return recursive ? testFiles(path) : [];
    return /\.test\.[jt]sx?$/.test(entry.name) ? [path] : [];
  }).sort();
}

export function unitPlan(root: string): UnitStep[] {
  const requiredFiles = (dir: string, recursive = true) => {
    const files = testFiles(join(root, dir), recursive);
    if (!files.length) throw new Error(`No unit test files found in ${dir}`);
    return files;
  };
  const rootFiles = requiredFiles("test", false);
  const unitFiles = requiredFiles("test/unit");
  const isolatedFiles = requiredFiles("test/unit-isolated");
  const steps: UnitStep[] = [{
    name: "build flair-tool-descriptors",
    cwd: join(root, "packages/flair-tool-descriptors"),
    args: ["run", "build"],
    files: [],
  }, {
    name: "root unit tests",
    cwd: root,
    // Preserve CI's existing grouping; mock.module isolation is per process.
    args: ["test", "test/unit/", ...rootFiles.map(file => relative(root, file))],
    files: [...unitFiles, ...rootFiles],
  }];
  for (const file of isolatedFiles) {
    steps.push({ name: relative(root, file), cwd: root, args: ["test", file], files: [file] });
  }
  steps.push({ name: "build flair-client", cwd: join(root, "packages/flair-client"), args: ["run", "build"], files: [] });
  for (const pkg of ["flair-tool-descriptors", "flair-mcp", "flair-client", "langgraph-flair", "n8n-nodes-flair", "openclaw-flair", "pi-flair", "flair-bench", "adk-flair-js"]) {
    const dir = pkg === "adk-flair-js" ? "test/unit" : "test";
    const cwd = join(root, "packages", pkg);
    steps.push({ name: `${pkg} unit tests`, cwd, args: ["test", `./${dir}/`], files: requiredFiles(`packages/${pkg}/${dir}`) });
  }
  return steps;
}

export function runUnitSteps(steps: UnitStep[], executable = process.execPath): number {
  let completed = 0;
  for (const step of steps) {
    console.log(`\n${step.name}${step.files.length ? ` (${step.files.length} files)` : ""}`);
    const result = spawnSync(executable, step.args, { cwd: step.cwd, stdio: "inherit", env: unitEnvironment(process.env) });
    if (result.error || result.status !== 0) {
      console.error(`Unit lane failed: ${step.name} (${result.error?.message ?? result.signal ?? `exit ${result.status}`}). ${completed}/${steps.length} steps completed.`);
      return 1;
    }
    completed++;
  }
  console.log(`\nUnit lane passed: ${completed} steps, ${steps.reduce((n, step) => n + step.files.length, 0)} test files. Test pass/skip counts are reported by Bun above.`);
  return 0;
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    if (args.some(arg => arg !== "--list")) throw new Error("Usage: bun run test:unit [--list]");
    const root = dirname(dirname(fileURLToPath(import.meta.url)));
    const steps = unitPlan(root);
    if (args.includes("--list")) {
      console.log(JSON.stringify(steps.map(step => ({ ...step, cwd: relative(root, step.cwd) || ".", files: step.files.map(file => relative(root, file)) })), null, 2));
    } else {
      if (!existsSync(join(root, "node_modules/typescript/package.json"))) {
        throw new Error("Dependencies are missing. Run bun install --frozen-lockfile first.");
      }
      const node = spawnSync("node", ["--version"], { encoding: "utf8" });
      if (node.error || node.status !== 0) throw new Error("Node.js is required on PATH for builds and subprocess tests (see package.json engines).");
      console.log(`Unit lane: Bun ${Bun.version}; Node ${node.stdout.trim()}; ${steps.length} steps. Ambient FLAIR_/HARPER_/HDB_/FABRIC_ settings are removed from child environments. Integration, heavy, Python and Playwright suites are separate.`);
      process.exitCode = runUnitSteps(steps);
    }
  } catch (error) {
    console.error(`Unit lane could not run: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}
