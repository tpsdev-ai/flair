import { existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
// Sandbox HOME for every child step, and the guard that fails the lane if a
// real client config changed anyway (flair#1853). Importing sandbox-home also
// installs its sandbox in THIS process — harmless: the guard resolves the real
// home from the passwd entry for the current uid, never from HOME.
import { createSandboxHome, type SandboxHome } from "../test/helpers/sandbox-home.ts";
import { changedConfigs, realHomeDir, snapshotClientConfigs } from "./home-isolation-guard.ts";

export interface UnitStep {
  name: string;
  cwd: string;
  args: string[];
  files: string[];
  /** This step's own time limit when the lane runs with limits; unset means the lane's default. */
  timeoutMs?: number;
}

// ── Time bounds (flair#2030) ────────────────────────────────────────────────
//
// A hung step must not take the rest of the lane with it. Without a bound, the
// CI job's own limit cancels the job mid-step, and neither the later steps, the
// final summary nor the end-of-lane guards ever run. Every number below is
// derived from that job: `.github/workflows/test.yml`, job `test-unit`,
// `timeout-minutes: 10`. Measured on the 51 green `Unit Tests (node N)` legs of
// 17 CI runs, 2026-09-28 21:52Z to 2026-09-29 03:53Z:
//   - the job's own steps outside the lane (setup before it, the skip-count
//     check and post steps after it): at most 53 s;
//   - the whole lane: 279–401 s;
//   - `root unit tests`, the one long step: at most 266 s, and every other
//     step at most 30 s, in the seven legs timed step by step (the slowest
//     lane among them).
// unit-runner.test.ts pins the job limit and re-checks the arithmetic, so a
// change to either side fails there first.
//
// The limits apply to keep-going runs, the CI default (KEEP_GOING_LIMITS). A
// fail-fast run — the local default, and the release script's mode — is not
// time-limited: these numbers describe a CI runner, and a slower machine must
// not turn a slow step into a failure.

/** The CI job limit the lane has to report inside (`timeout-minutes: 10`). */
export const CI_JOB_LIMIT_MS = 10 * 60_000;
/** Reserved for the job's own steps outside the lane: 53 s measured, 37 s spare. */
export const CI_OUTSIDE_LANE_MS = 90_000;
/**
 * Keep-going's whole-lane budget: 600 − 90 = 510 s. A step still running when
 * it runs out is killed and every later step is reported as not run, so the
 * summary and both guards are expected to print before the job limit however
 * many steps hang, provided the job's steps outside the lane stay within the
 * reserve above (an observed margin, not a bound on workflow setup).
 */
export const KEEP_GOING_LANE_BUDGET_MS = CI_JOB_LIMIT_MS - CI_OUTSIDE_LANE_MS;
/**
 * The default per-step limit: 90 s, 3× the slowest ordinary step. One hung step
 * costs at most that, so the rest of the slowest lane still runs inside the
 * budget (401 + 90 = 491 s ≤ 510 s).
 */
export const STEP_TIMEOUT_MS = 90_000;
/**
 * `root unit tests`' own limit: 360 s, 1.35× its slowest measured run. If it
 * hangs, the other ~135 s of the lane still fits (135 + 360 = 495 s ≤ 510 s). A
 * real root step that slow would already put the job within ~50 s of its limit.
 */
export const ROOT_STEP_TIMEOUT_MS = 360_000;

/** The time limits a lane runs under (flair#2030). */
export interface UnitLaneLimits {
  /** The limit for a step that sets no `timeoutMs` of its own. */
  stepTimeoutMs: number;
  /** A whole-lane budget. Unset means none. */
  laneBudgetMs?: number;
}

/** The limits a keep-going run uses. */
export const KEEP_GOING_LIMITS: Readonly<UnitLaneLimits> = Object.freeze({
  stepTimeoutMs: STEP_TIMEOUT_MS,
  laneBudgetMs: KEEP_GOING_LANE_BUDGET_MS,
});

const seconds = (ms: number): string => `${Math.round(ms / 1000)} s`;

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
    timeoutMs: ROOT_STEP_TIMEOUT_MS,
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

/**
 * One failure the keep-going summary reports: a step that ran and failed, a
 * step the lane's time budget left unrun, or an end-of-lane guard.
 */
export interface UnitLaneFailure {
  kind: "step" | "not-run" | "guard";
  name: string;
  detail: string;
}

/**
 * Whether the environment asks for keep-going because it is a CI run (flair#2030).
 *
 * GitHub Actions sets `CI=true` for every job, so this is what makes keep-going
 * the CI default without a workflow flag. Only a truthy value counts: a value
 * that is nonblank after trimming, excluding `0` and `false` case-insensitively.
 */
export function ciRequestsKeepGoing(env: NodeJS.ProcessEnv): boolean {
  const value = env.CI?.trim().toLowerCase();
  return !!value && value !== "0" && value !== "false";
}

export const UNIT_LANE_USAGE = "Usage: bun run test:unit [--list] [--keep-going | --fail-fast]";

/** What one invocation of the runner asks for. */
export interface UnitLaneInvocation {
  /** `--list`: print the plan and run nothing. */
  list: boolean;
  keepGoing: boolean;
  /** The time limits. Set in keep-going mode only. */
  limits?: Readonly<UnitLaneLimits>;
}

/**
 * Parse the runner's arguments (flair#2030).
 *
 * `--keep-going` and `--fail-fast` choose the failure policy explicitly. With
 * neither, a truthy `CI` selects keep-going. `--fail-fast` wins over `CI`: that
 * is how the release script stays fail-fast in a shell that inherited
 * `CI=true`. Passing both is a usage error, as is any other argument.
 *
 * ci-gate-coverage.test.ts asks this same parser whether a workflow line
 * actually runs the lane, so the coverage gate cannot count an invocation the
 * runner would only list or refuse.
 */
export function parseUnitLaneArgs(args: readonly string[], env: NodeJS.ProcessEnv): UnitLaneInvocation {
  const known = new Set(["--list", "--keep-going", "--fail-fast"]);
  const unknown = args.filter(arg => !known.has(arg));
  if (unknown.length) throw new Error(`Unknown argument ${unknown.map(arg => JSON.stringify(arg)).join(", ")}. ${UNIT_LANE_USAGE}`);
  const keepGoingFlag = args.includes("--keep-going");
  const failFastFlag = args.includes("--fail-fast");
  if (keepGoingFlag && failFastFlag) throw new Error(`--keep-going and --fail-fast contradict each other; pass one. ${UNIT_LANE_USAGE}`);
  const keepGoing = keepGoingFlag || (!failFastFlag && ciRequestsKeepGoing(env));
  return { list: args.includes("--list"), keepGoing, ...(keepGoing ? { limits: KEEP_GOING_LIMITS } : {}) };
}

/**
 * The one summary keep-going mode prints at the end: how many steps ran and
 * failed, then each failed step with its reason, then each step the time
 * budget left unrun, then each failed guard. A guard failure is listed in the
 * SAME summary as step failures (flair#2030). Fail-fast mode prints no summary.
 */
export function summarizeUnitLane(failures: readonly UnitLaneFailure[], totalSteps: number): string {
  const ofKind = (kind: UnitLaneFailure["kind"]) => failures.filter(failure => failure.kind === kind);
  const stepFailures = ofKind("step");
  const notRun = ofKind("not-run");
  const guardFailures = ofKind("guard");
  const counts = notRun.length
    ? `ran ${totalSteps - notRun.length} of ${totalSteps} steps, ${stepFailures.length} failed, ${notRun.length} not run`
    : `ran ${totalSteps} step${totalSteps === 1 ? "" : "s"}, ${stepFailures.length} failed`;
  const lines = [`Unit lane FAILED (keep-going): ${counts}.`];
  const section = (title: string, list: UnitLaneFailure[], line: (failure: UnitLaneFailure) => string): void => {
    if (!list.length) return;
    lines.push(title);
    for (const failure of list) lines.push(`  - ${line(failure)}`);
  };
  section("Failed steps:", stepFailures, failure => `${failure.name} (${failure.detail})`);
  section("Not run:", notRun, failure => `${failure.name} (${failure.detail})`);
  section("Guard failures:", guardFailures, failure => `${failure.name}: ${failure.detail}`);
  return lines.join("\n");
}

export interface UnitLaneOptions {
  /** flair#2030: run every step and summarise at the end instead of stopping at the first failure. */
  keepGoing?: boolean;
  /** Time limits. Unset: no step is time-limited, not even one with its own `timeoutMs`. */
  limits?: Readonly<UnitLaneLimits>;
  /** Creates each step's sandbox HOME. A seam for tests; defaults to createSandboxHome. */
  createSandbox?: () => SandboxHome;
}

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Run one step under a fresh sandbox HOME and, when given, a time limit.
 *
 * Returns undefined when the step passed, otherwise why it failed. Every way a
 * step can fail comes back as a reason, never as an exception: its own non-zero
 * exit or signal, its time limit, a sandbox HOME that could not be created, a
 * process that could not start. The caller therefore always reaches the later
 * steps (in keep-going mode) and the end-of-lane guards.
 */
function runStep(
  step: UnitStep,
  executable: string,
  timeout: { ms: number; reason: string } | undefined,
  createSandbox: () => SandboxHome,
): string | undefined {
  // A fresh sandbox HOME per step: even if one step's child wrote a config,
  // the next step cannot read it back, and the real home is never the target.
  // The bunfig preload covers `bun test` children too; this also covers the
  // non-test steps (typechecks, builds) that preload does not reach.
  let sandbox: SandboxHome;
  try {
    sandbox = createSandbox();
  } catch (error) {
    // Never run a step without its sandbox: its HOME would be the real one.
    return `not started: its sandbox HOME could not be created (${errorMessage(error)})`;
  }
  let result: ReturnType<typeof spawnSync>;
  try {
    result = spawnSync(executable, step.args, {
      cwd: step.cwd,
      stdio: "inherit",
      env: { ...unitEnvironment(process.env), ...sandbox.env },
      timeout: timeout?.ms,
      // SIGKILL, not the default SIGTERM: spawnSync waits for the child to
      // exit, so a child that ignores SIGTERM would still hang the lane.
      killSignal: "SIGKILL",
    });
  } catch (error) {
    return `not started (${errorMessage(error)})`;
  } finally {
    sandbox.cleanup();
  }
  if (timeout && (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") {
    console.error(
      `${step.name}: ${timeout.reason}; the step was killed. A killed step cannot remove its own scratch directories, ` +
        `so the temp-dir leak guard may name them too.`,
    );
    return `${timeout.reason}; killed`;
  }
  if (result.error || result.status !== 0) return result.error?.message ?? result.signal ?? `exit ${result.status}`;
  return undefined;
}

/**
 * Run the unit plan.
 *
 * `options.keepGoing` (flair#2030) chooses the failure policy. When false — the
 * local default — the lane stops at the first failing step, as it always has.
 * When true — the CI default — it attempts every later step (until any lane
 * budget runs out, reporting unrun steps), prints one final summary
 * naming each failed step with its reason, and exits non-zero if any step
 * failed. Both guards run once at the end in either mode, never skipped because
 * a step failed. In keep-going mode a guard failure is listed in the same
 * summary, so it still fails the lane even when every step passed; in fail-fast
 * mode each guard prints its own error and the lane exits non-zero with no
 * combined summary.
 *
 * With `options.limits`, every step runs under a time limit: its own
 * `timeoutMs`, else `limits.stepTimeoutMs`. With `limits.laneBudgetMs` too, no
 * step runs past the budget: the step still running when it runs out is killed,
 * and every later step is reported as not run. A timed-out step, and one whose
 * sandbox HOME could not be created, is a failed step like any other.
 */
export function runUnitSteps(
  steps: UnitStep[],
  executable = process.execPath,
  guardHome = realHomeDir(),
  options: UnitLaneOptions = {},
): number {
  const { keepGoing = false, limits, createSandbox = createSandboxHome } = options;
  const laneBudgetMs = limits?.laneBudgetMs;
  const deadline = laneBudgetMs === undefined ? Infinity : Date.now() + laneBudgetMs;
  const budgetRanOut = `the lane's ${seconds(laneBudgetMs ?? 0)} time budget ran out`;
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
  // summary; in fail-fast mode each guard prints its own error and its failure
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
  for (const [index, step] of steps.entries()) {
    const remaining = deadline - Date.now();
    if (remaining < 1) {
      // The budget is spent before this step could start: it and every later
      // step are reported as not run rather than silently dropped.
      const notRun = steps.slice(index);
      console.error(`\nUnit lane: ${budgetRanOut}; ${notRun.length} step${notRun.length === 1 ? "" : "s"} not run.`);
      if (!keepGoing) {
        runGuards();
        console.error(`Unit lane failed: ${budgetRanOut} before ${step.name}. ${completed}/${steps.length} steps completed.`);
        return 1;
      }
      for (const skipped of notRun) stepFailures.push({ kind: "not-run", name: skipped.name, detail: budgetRanOut });
      break;
    }
    console.log(`\n${step.name}${step.files.length ? ` (${step.files.length} files)` : ""}`);
    const limit = limits && (step.timeoutMs ?? limits.stepTimeoutMs);
    const timeout = limit === undefined
      ? undefined
      : remaining < limit
        ? { ms: remaining, reason: `timed out: ${budgetRanOut}` }
        : { ms: limit, reason: `timed out after ${seconds(limit)}` };
    const detail = runStep(step, executable, timeout, createSandbox);
    if (detail !== undefined) {
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
    const invocation = parseUnitLaneArgs(process.argv.slice(2), process.env);
    const root = dirname(dirname(fileURLToPath(import.meta.url)));
    const steps = unitPlan(root);
    if (invocation.list) {
      console.log(JSON.stringify(steps.map(step => ({ ...step, cwd: relative(root, step.cwd) || ".", files: step.files.map(file => relative(root, file)) })), null, 2));
    } else {
      if (!existsSync(join(root, "node_modules/typescript/package.json"))) {
        throw new Error("Dependencies are missing. Run bun install --frozen-lockfile first.");
      }
      const node = spawnSync("node", ["--version"], { encoding: "utf8" });
      if (node.error || node.status !== 0) throw new Error("Node.js is required on PATH for builds and subprocess tests (see package.json engines).");
      const mode = invocation.keepGoing
        ? `keep-going: every step runs and failures are summed at the end; a step is killed after ${seconds(STEP_TIMEOUT_MS)} (root unit tests: ${seconds(ROOT_STEP_TIMEOUT_MS)}) and the lane after ${seconds(KEEP_GOING_LANE_BUDGET_MS)}`
        : "fail-fast: stops at the first failing step; steps are not time-limited";
      console.log(`Unit lane: Bun ${Bun.version}; Node ${node.stdout.trim()}; ${steps.length} steps; ${mode}. Ambient FLAIR_/HARPER_/HDB_/FABRIC_ settings are removed from child environments; each step runs under a sandbox HOME. A guard fails the lane if a real client config changed. Integration, heavy, Python and Playwright suites are separate.`);
      process.exitCode = runUnitSteps(steps, process.execPath, realHomeDir(), {
        keepGoing: invocation.keepGoing,
        limits: invocation.limits,
      });
    }
  } catch (error) {
    console.error(`Unit lane could not run: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}
