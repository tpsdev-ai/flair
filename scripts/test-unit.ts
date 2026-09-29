import { existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
// Sandbox HOME for every child step, and the guard that fails the lane if a
// real client config changed anyway (flair#1853). Importing sandbox-home also
// installs its sandbox in THIS process — harmless: the guard resolves the real
// home from the passwd entry for the current uid, never from HOME.
import { createSandboxHome } from "../test/helpers/sandbox-home.ts";
import { changedConfigs, realHomeDir, snapshotClientConfigs } from "./home-isolation-guard.ts";

export interface UnitStep {
  name: string;
  cwd: string;
  args: string[];
  files: string[];
}

/** Names of `flair-*` entries in the OS temp dir right now — NAMES, not a count. */
export function flairTempNames(dir: string = tmpdir()): Set<string> {
  try {
    return new Set(readdirSync(dir).filter((name) => name.startsWith("flair-")));
  } catch {
    return new Set();
  }
}

/** The `flair-*` names present in `after` that were not present in `before`. */
export function newFlairTempNames(before: ReadonlySet<string>, after: ReadonlySet<string>): string[] {
  return [...after].filter((name) => !before.has(name)).sort();
}

/**
 * The temp-dir leak guard (flair#1889).
 *
 * A unit test must remove the scratch directory it creates. The lane is the only
 * place that can see all of them, so it snapshots the `flair-*` names in the OS
 * temp dir before the lane and again after it, and fails on any name that
 * APPEARED during the lane.
 *
 * It compares NAMES, not a bare count, and reports only the names that appeared:
 * a `flair-*` directory that was already there (an earlier run's leftover, which
 * this lane did not create) is not a leak this lane caused. The accepted
 * false-positive is a genuinely concurrent, unrelated process that creates a
 * `flair-*` temp dir while the lane runs — an entry carries no owner, so it
 * cannot be attributed to a process, and hiding it would mean hiding real leaks
 * too.
 *
 * @returns true when the lane leaked (and the caller must fail).
 */
export function reportTempDirLeaks(leaked: readonly string[], dir: string = tmpdir()): boolean {
  if (!leaked.length) return false;
  const counts = new Map<string, number>();
  for (const name of leaked) {
    const cut = name.lastIndexOf("-");
    const prefix = cut > 0 ? name.slice(0, cut + 1) : "flair-";
    counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
  }
  const prefixes = [...counts.entries()].map(([prefix, n]) => `${prefix} (${n})`).join(", ");
  console.error(
    `Temp-dir leak guard FAILED: the unit lane left ${leaked.length} new flair-* director${leaked.length === 1 ? "y" : "ies"} in ${dir}. ` +
      `A unit test must remove the scratch directory it creates — use tempDir() from test/helpers/temp-dir.ts, which registers the removal in the same call (flair#1889). ` +
      `New prefixes: ${prefixes}`,
  );
  console.error(`  new entries:\n${leaked.map((name) => `    ${name}`).join("\n")}`);
  return true;
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
    // flair#1683: the private descriptor package is a build-time source, not a
    // dependency. Vendor its copy into both consumers before anything reads it
    // (there is no workspace symlink to fall back on).
    name: "vendor tool descriptors",
    cwd: root,
    args: ["scripts/vendor-tool-descriptors.mjs"],
    files: [],
  }];
  // Strict typechecks. bun's transpiler STRIPS types rather than checking them,
  // so no `bun test` step can see a type error: a tree that does not compile can
  // report a green lane. (Found 2026-09-19 — an excess property in a bindCli
  // object literal shipped while this lane read "matches baseline".) These mirror
  // the "Type Check (strict)" CI job exactly, in the same order, so the lane and
  // CI cannot disagree about whether the tree compiles. The first four require
  // the vendored descriptors above; none require the flair-client build.
  const typecheckConfigs: Array<[string, string]> = [
    ["resources (strict)", "tsconfig.check.json"],
    ["src (strict, excl. cli.ts)", "tsconfig.check.src.json"],
    ["root CLI", "tsconfig.cli.json"],
    ["test suite (strict)", "tsconfig.test.check.json"],
  ];
  for (const [label, config] of typecheckConfigs) {
    steps.push({ name: `typecheck: ${label}`, cwd: root, args: ["x", "tsc", "--noEmit", "-p", config], files: [] });
  }
  steps.push({ name: "emit server for boundary guard", cwd: root, args: ["x", "tsc", "-p", "tsconfig.json", "--noCheck"], files: [] });
  steps.push({
    name: "root unit tests",
    cwd: root,
    // Preserve CI's existing grouping; mock.module isolation is per process.
    args: ["test", "test/unit/", ...rootFiles.map(file => relative(root, file))],
    files: [...unitFiles, ...rootFiles],
  });
  for (const file of isolatedFiles) {
    steps.push({ name: relative(root, file), cwd: root, args: ["test", file], files: [file] });
  }
  steps.push({ name: "build flair-client", cwd: join(root, "packages/flair-client"), args: ["run", "build"], files: [] });
  // flair#1943: the langgraph-flair contract test asserts
  // `const s: BaseStore = new FlairStore(...)` — a TYPE-LEVEL check no other step
  // covers. The package tsconfig includes `src/**` only, and `bun test` strips
  // types without checking them, so a broken structural contract could still
  // report a green lane. Type-check that one file here, against the peer
  // package's types. It runs after the flair-client build because the file
  // imports this package's `src`, which imports flair-client's emitted types.
  steps.push({
    name: "typecheck: langgraph-flair contract (BaseStore assignability)",
    cwd: join(root, "packages/langgraph-flair"),
    args: [
      "x", "tsc", "--noEmit", "--strict", "--target", "ES2022", "--module", "ESNext",
      "--moduleResolution", "Bundler", "--types", "node,bun-types", "--esModuleInterop",
      "--skipLibCheck", "test/contract.test.ts",
    ],
    files: [],
  });
  for (const pkg of ["flair-tool-descriptors", "flair-mcp", "flair-client", "langgraph-flair", "n8n-nodes-flair", "openclaw-flair", "pi-flair", "flair-bench", "adk-flair-js", "cursor-wake-runner"]) {
    const dir = pkg === "adk-flair-js" ? "test/unit" : "test";
    const cwd = join(root, "packages", pkg);
    steps.push({ name: `${pkg} unit tests`, cwd, args: ["test", `./${dir}/`], files: requiredFiles(`packages/${pkg}/${dir}`) });
  }
  return steps;
}

/** One failure the keep-going summary reports: a step or an end-of-lane guard. */
export interface UnitLaneFailure {
  kind: "step" | "guard";
  name: string;
  detail: string;
}

/**
 * Whether the environment asks for keep-going because it is a CI run (flair#2030).
 *
 * GitHub Actions sets `CI=true` for every job, so this is what makes keep-going
 * the CI default without a workflow flag. Any non-empty value except the
 * conventional falsey spellings (`0`, `false`) counts as set.
 */
export function ciRequestsKeepGoing(env: NodeJS.ProcessEnv): boolean {
  const value = env.CI?.trim().toLowerCase();
  return !!value && value !== "0" && value !== "false";
}

/**
 * The one summary keep-going mode prints at the end: how many steps ran and
 * failed, then each failed step with its exit status, then each failed guard.
 * A guard failure is listed in the SAME summary as step failures (flair#2030).
 */
export function summarizeUnitLane(failures: readonly UnitLaneFailure[], totalSteps: number): string {
  const stepFailures = failures.filter(failure => failure.kind === "step");
  const guardFailures = failures.filter(failure => failure.kind === "guard");
  const lines = [
    `Unit lane FAILED (keep-going): ran ${totalSteps} step${totalSteps === 1 ? "" : "s"}, ${stepFailures.length} failed.`,
  ];
  if (stepFailures.length) {
    lines.push("Failed steps:");
    for (const failure of stepFailures) lines.push(`  - ${failure.name} (${failure.detail})`);
  }
  if (guardFailures.length) {
    lines.push("Guard failures:");
    for (const failure of guardFailures) lines.push(`  - ${failure.name}: ${failure.detail}`);
  }
  return lines.join("\n");
}

/**
 * Run the unit plan.
 *
 * `keepGoing` (flair#2030) chooses the failure policy. When false — the local
 * default — the lane stops at the first failing step, exactly as it always has.
 * When true — the CI default — it runs EVERY step, prints one final summary
 * naming each failed step with its exit status, and exits non-zero if any step
 * failed. Both guards run once at the end in either mode; in keep-going mode
 * they are evaluated after every step has run (never skipped because a step
 * failed) and a guard failure is listed in the same summary, so it still fails
 * the lane even when every step passed.
 */
export function runUnitSteps(
  steps: UnitStep[],
  executable = process.execPath,
  guardHome = realHomeDir(),
  keepGoing = false,
): number {
  // Fingerprint the REAL client configs before the lane and compare after it.
  // `guardHome` defaults to the real home (realHomeDir() resolves the passwd
  // entry for the current uid, not HOME, so neither the sandbox this module
  // installs nor the per-step HOME below can hide a real write); the parameter
  // lets a test point the guard at a fixture home and prove the boundary without
  // ever touching the real one (flair#1853 round 3).
  const before = snapshotClientConfigs(guardHome);
  // The temp-dir leak guard's `before` snapshot (flair#1889).
  const tempBefore = flairTempNames();

  // Both guards run ONCE, at the END (flair#2030). Collecting their failures in
  // the same list as step failures is what lets keep-going report them in one
  // summary; in fail-fast mode only a guard can reach the end, and its failure
  // still exits non-zero.
  const guardFailures: UnitLaneFailure[] = [];
  const runGuards = (): void => {
    const changed = changedConfigs(before, snapshotClientConfigs(guardHome));
    if (changed.length) {
      console.error(
        `Home-isolation guard FAILED: a real client config changed during the lane: ${changed.join(", ")}. ` +
          `A test reached around the sandbox — make it use the sandbox HOME (flair#1853).`,
      );
      guardFailures.push({
        kind: "guard",
        name: "home-isolation guard",
        detail: `a real client config changed during the lane: ${changed.join(", ")} (flair#1853)`,
      });
    }
    const leaked = newFlairTempNames(tempBefore, flairTempNames());
    if (reportTempDirLeaks(leaked)) {
      guardFailures.push({
        kind: "guard",
        name: "temp-dir leak guard",
        detail: `the unit lane left ${leaked.length} new flair-* director${leaked.length === 1 ? "y" : "ies"} in ${tmpdir()} (flair#1889)`,
      });
    }
  };

  const stepFailures: UnitLaneFailure[] = [];
  let completed = 0;
  for (const step of steps) {
    console.log(`\n${step.name}${step.files.length ? ` (${step.files.length} files)` : ""}`);
    // A fresh sandbox HOME per step: even if one step's child wrote a config,
    // the next step cannot read it back, and the real home is never the target.
    // The bunfig preload covers `bun test` children too; this also covers the
    // non-test steps (typechecks, builds) that preload does not reach.
    const sandbox = createSandboxHome();
    let result;
    try {
      result = spawnSync(executable, step.args, {
        cwd: step.cwd,
        stdio: "inherit",
        env: { ...unitEnvironment(process.env), ...sandbox.env },
      });
    } finally {
      sandbox.cleanup();
    }
    if (result.error || result.status !== 0) {
      const detail = result.error?.message ?? result.signal ?? `exit ${result.status}`;
      if (!keepGoing) {
        // Fail-fast (the local default): stop here. The end-of-lane guards still
        // run so a config write next to a step failure is not missed.
        runGuards();
        console.error(`Unit lane failed: ${step.name} (${detail}). ${completed}/${steps.length} steps completed.`);
        return 1;
      }
      // Keep-going (the CI default): record the failure and run every later step.
      stepFailures.push({ kind: "step", name: step.name, detail });
      continue;
    }
    completed++;
  }

  runGuards();
  const summary = `${completed} steps, ${steps.reduce((n, step) => n + step.files.length, 0)} test files`;
  if (!keepGoing) {
    // Every step passed; only a guard failure can fail the lane now.
    if (guardFailures.length) return 1;
    console.log(`\nUnit lane passed: ${summary}. Test pass/skip counts are reported by Bun above.`);
    return 0;
  }
  const failures = [...stepFailures, ...guardFailures];
  if (failures.length) {
    console.error(`\n${summarizeUnitLane(failures, steps.length)}`);
    return 1;
  }
  console.log(`\nUnit lane passed: ${summary}. Test pass/skip counts are reported by Bun above.`);
  return 0;
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    const allowed = new Set(["--list", "--keep-going"]);
    if (args.some(arg => !allowed.has(arg))) throw new Error("Usage: bun run test:unit [--list] [--keep-going]");
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
      // Keep-going is on by default under CI (flair#2030): GitHub Actions sets
      // CI=true, so a PR reports every failing step in one run instead of one
      // per round. The local default stays fail-fast; `--keep-going` opts in.
      const keepGoing = args.includes("--keep-going") || ciRequestsKeepGoing(process.env);
      const mode = keepGoing
        ? "keep-going: every step runs, failures are summed at the end"
        : "fail-fast: stops at the first failing step";
      console.log(`Unit lane: Bun ${Bun.version}; Node ${node.stdout.trim()}; ${steps.length} steps; ${mode}. Ambient FLAIR_/HARPER_/HDB_/FABRIC_ settings are removed from child environments; each step runs under a sandbox HOME. A guard fails the lane if a real client config changed. Integration, heavy, Python and Playwright suites are separate.`);
      process.exitCode = runUnitSteps(steps, process.execPath, realHomeDir(), keepGoing);
    }
  } catch (error) {
    console.error(`Unit lane could not run: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}
