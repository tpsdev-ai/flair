import { chownSync, existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
// Sandbox HOME for every child step, and the guard that fails the lane if a
// real client config changed anyway (flair#1853). Importing sandbox-home also
// installs its sandbox in THIS process — harmless: the guard resolves the real
// home from the passwd entry for the current uid, never from HOME.
import { createSandboxHome, type SandboxHome } from "../test/helpers/sandbox-home.ts";
// The unit-lane service-manager tripwire (flair#2062): every step runs with a
// `launchctl`/`systemctl` shim FIRST on PATH, so a unit test that reaches a host
// service manager without its own fake fails the lane instead of touching it.
import {
  installServiceManagerTripwire,
  type ServiceManagerTripwire,
} from "../test/helpers/fake-launchctl.ts";
import { changedConfigs, realHomeDir, snapshotClientConfigs } from "./home-isolation-guard.ts";
// The lane plan and its root-step limit live in scripts/ci/lane-shards.mjs so
// this runner and the `node scripts/ci/lane-shards.mjs --verify` coverage gate
// share one plan (flair#2311); re-exported below because the unit tests import
// `unitPlan` and `ROOT_STEP_TIMEOUT_MS` from this module.
import {
  LANE_SHARDS,
  ROOT_STEP_TIMEOUT_MS,
  laneShardPlans,
  unitPlan,
} from "./ci/lane-shards.mjs";
import type { UnitStep } from "./ci/lane-shards.mjs";
export { ROOT_STEP_TIMEOUT_MS, unitPlan };
export type { UnitStep };

/** The short, canonical temp base darwin unit steps run under (flair#2137). */
export const DARWIN_TEMP_BASE = "/private/tmp";

export function unitTempBase(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string | undefined {
  const override = env.FLAIR_UNIT_TEMP_BASE?.trim();
  if (override) return override;
  return platform === "darwin" ? DARWIN_TEMP_BASE : undefined;
}


// ── Time bounds (flair#2030, resized flair#2224) ───────────────────────────
//
// A hung step must not take the rest of the lane with it. Without a bound, the
// CI job's own limit cancels the job mid-step, and neither the later steps, the
// final summary nor the end-of-lane guards ever run. Every number below is
// derived from that job: `.github/workflows/test.yml`, job `test-unit`,
// `timeout-minutes: 15`. Measured on 22 recent `Unit Tests (node N)` legs
// (2026-10-02) plus a local run on the same tree:
//   - the job's own steps outside the lane (setup before it, the skip-count
//     check and post steps after it): at most 53 s (2026-09-29);
//   - the whole lane: 401–510 s, and 456 s locally;
//   - `root unit tests`, the one long step: 252–327 s (280 s locally);
//   - every other step at most 33 s; in that
//     set the median is 1–2 s.
// The budget is whole-lane headroom: about 1.53× the slowest measured lane
// (510 s), still subject to each step's own limit below; the old 510 s
// budget sat at that worst lane's length and killed whichever late step was running
// on a busy runner (flair#2224: `flair-mcp` on #2220, `adk-flair-js` on main).
// unit-runner.test.ts pins the job limit and re-checks the arithmetic, so a
// change to either side fails there first.
//
// The limits apply to keep-going runs, the CI default (KEEP_GOING_LIMITS). A
// fail-fast run — the local default, and the release script's mode — is not
// time-limited: these numbers describe a CI runner, and a slower machine must
// not turn a slow step into a failure.

/** The CI job limit the lane has to report inside (`timeout-minutes: 15`). */
export const CI_JOB_LIMIT_MS = 15 * 60_000;
/** Reserved for the job's own steps outside the lane: 53 s measured, 67 s spare. */
export const CI_OUTSIDE_LANE_MS = 120_000;
/**
 * Keep-going's whole-lane budget: 900 − 120 = 780 s, about 1.53× the slowest
 * measured lane (510 s). A step still running when it runs out is killed and every later
 * step is reported as not run, so the summary and both guards are expected to
 * print before the job limit however many steps hang, provided the job's steps
 * outside the lane stay within the reserve above (an observed margin, not a
 * bound on workflow setup).
 */
export const KEEP_GOING_LANE_BUDGET_MS = CI_JOB_LIMIT_MS - CI_OUTSIDE_LANE_MS;
/**
 * The default per-step limit: 100 s, 3× the slowest ordinary step (33 s). One
 * hung step costs at most that, so the rest of the slowest lane still runs
 * inside the budget (510 + 100 = 610 s ≤ 780 s).
 */
export const STEP_TIMEOUT_MS = 100_000;
// `root unit tests`' own limit is 450 s, 1.37× its slowest measured run (327 s).
// If it hangs, the other ~183 s of the lane still fits (183 + 450 = 633 s ≤
// 780 s). It is defined in scripts/ci/lane-shards.mjs, which builds the plan,
// and re-exported above for this module's tests.

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
    `Temp-dir leak guard FAILED: ${leaked.length} new flair-* entries observed in ${dir}. ` +
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

/**
 * The environment one step runs under (flair#2062): the deployment-scrubbed
 * environment, the step's sandbox HOME, and the service-manager tripwire FIRST
 * on PATH.
 *
 * The tripwire goes first so a unit test that invokes `launchctl` or `systemctl`
 * without its own fake lands on the tripwire and fails the lane. A test that
 * supplies its own fake prepends it to `process.env.PATH`, which puts the fake
 * ahead of the tripwire — the test's fake answers and the tripwire stays clear.
 */
export function stepEnvironment(
  source: NodeJS.ProcessEnv,
  sandbox: SandboxHome,
  tripwireDir: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...unitEnvironment(source), ...sandbox.env };
  if (source.FLAIR_UNIT_TEMP_ROOT) env.FLAIR_UNIT_TEMP_ROOT = source.FLAIR_UNIT_TEMP_ROOT;
  env.PATH = `${tripwireDir}:${env.PATH ?? ""}`;
  return env;
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

export const UNIT_LANE_USAGE =
  "Usage: bun run test:unit [--list] [--keep-going | --fail-fast] [--shard <i> [--of <N>]]";

/** What one invocation of the runner asks for. */
export interface UnitLaneInvocation {
  /** `--list`: print the plan and run nothing. */
  list: boolean;
  keepGoing: boolean;
  /** The lane shard to run (`--shard i --of N`); unset means the whole lane. */
  shard?: { index: number; of: number };
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
 *
 * `--shard <i> --of <N>` (flair#2311) runs one shard of the lane: the shared
 * setup steps plus shard `i`'s test-bearing steps. `--of` defaults to
 * LANE_SHARDS and requires `--shard`.
 */
export function parseUnitLaneArgs(args: readonly string[], env: NodeJS.ProcessEnv): UnitLaneInvocation {
  const known = new Set(["--list", "--keep-going", "--fail-fast"]);
  const valueFlags = new Set(["--shard", "--of"]);
  const unknown: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (valueFlags.has(args[i])) {
      i++;
      continue;
    }
    if (!known.has(args[i])) unknown.push(args[i]);
  }
  if (unknown.length) throw new Error(`Unknown argument ${unknown.map(arg => JSON.stringify(arg)).join(", ")}. ${UNIT_LANE_USAGE}`);
  const keepGoingFlag = args.includes("--keep-going");
  const failFastFlag = args.includes("--fail-fast");
  if (keepGoingFlag && failFastFlag) throw new Error(`--keep-going and --fail-fast contradict each other; pass one. ${UNIT_LANE_USAGE}`);
  const keepGoing = keepGoingFlag || (!failFastFlag && ciRequestsKeepGoing(env));
  const shard = parseShardArgs(args);
  return {
    list: args.includes("--list"),
    keepGoing,
    ...(shard ? { shard } : {}),
    ...(keepGoing ? { limits: KEEP_GOING_LIMITS } : {}),
  };
}

/** Parse `--shard <i> [--of <N>]`, or undefined when neither is given. */
function parseShardArgs(args: readonly string[]): { index: number; of: number } | undefined {
  const shardAt = args.indexOf("--shard");
  const ofAt = args.indexOf("--of");
  if (shardAt === -1) {
    if (ofAt !== -1) throw new Error(`--of requires --shard. ${UNIT_LANE_USAGE}`);
    return undefined;
  }
  const index = Number(args[shardAt + 1]);
  if (!Number.isInteger(index)) throw new Error(`--shard needs a positive integer. ${UNIT_LANE_USAGE}`);
  let of = LANE_SHARDS;
  if (ofAt !== -1) {
    of = Number(args[ofAt + 1]);
    if (!Number.isInteger(of) || of < 1) throw new Error(`--of needs a positive integer. ${UNIT_LANE_USAGE}`);
  }
  if (index < 1 || index > of) throw new Error(`--shard must be 1..${of}, got ${index}. ${UNIT_LANE_USAGE}`);
  return { index, of };
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
  /**
   * The service-manager tripwire every step runs behind (flair#2062). A seam
   * for tests; defaults to a fresh installServiceManagerTripwire. When unset,
   * the runner owns it and removes it at the end of the lane.
   */
  tripwire?: ServiceManagerTripwire;
}

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Why a step failed, and whether it ran past its time limit and was killed. */
interface StepOutcome {
  detail?: string;
  killedAtLimit: boolean;
}

/**
 * Run one step under a fresh sandbox HOME and, when given, a time limit.
 *
 * Returns an outcome whose `detail` is undefined when the step passed, otherwise
 * why it failed, and `killedAtLimit` true when the step ran past its time limit
 * and was killed. Every way a step can fail comes back as a reason, never as an
 * exception: its own non-zero exit or signal, its time limit, a sandbox HOME that
 * could not be created, a process that could not start. The caller therefore
 * always reaches the later steps (in keep-going mode) and the end-of-lane guards.
 */
function runStep(
  step: UnitStep,
  executable: string,
  timeout: { ms: number; reason: string } | undefined,
  createSandbox: () => SandboxHome,
  tripwireDir: string,
): StepOutcome {
  // A fresh sandbox HOME per step: even if one step's child wrote a config,
  // the next step cannot read it back, and the real home is never the target.
  // The bunfig preload covers `bun test` children too; this also covers the
  // non-test steps (typechecks, builds) that preload does not reach.
  let sandbox: SandboxHome;
  try {
    sandbox = createSandbox();
  } catch (error) {
    // Never run a step without its sandbox: its HOME would be the real one.
    return { detail: `not started: its sandbox HOME could not be created (${errorMessage(error)})`, killedAtLimit: false };
  }
  let result: ReturnType<typeof spawnSync>;
  try {
    result = spawnSync(executable, step.args, {
      cwd: step.cwd,
      stdio: "inherit",
      env: stepEnvironment(process.env, sandbox, tripwireDir),
      timeout: timeout?.ms,
      // SIGKILL, not the default SIGTERM: spawnSync waits for the child to
      // exit, so a child that ignores SIGTERM would still hang the lane.
      killSignal: "SIGKILL",
    });
  } catch (error) {
    return { detail: `not started (${errorMessage(error)})`, killedAtLimit: false };
  } finally {
    sandbox.cleanup();
  }
  if (timeout && (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") {
    console.error(`${step.name}: ${timeout.reason}; step killed at the limit.`);
    return { detail: `${timeout.reason}; step killed at the limit`, killedAtLimit: true };
  }
  if (result.error || result.status !== 0) {
    return { detail: result.error?.message ?? result.signal ?? `exit ${result.status}`, killedAtLimit: false };
  }
  return { killedAtLimit: false };
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
  const previousTmpdir = process.env.TMPDIR;
  const previousTempRoot = process.env.FLAIR_UNIT_TEMP_ROOT;
  const tempBase = unitTempBase(process.platform, process.env);
  const callerTempRoot = realpathSync(tmpdir());
  const reuseTempRoot = !process.env.FLAIR_UNIT_TEMP_BASE?.trim() && (
    previousTempRoot === callerTempRoot ||
    (process.platform === "darwin" && dirname(callerTempRoot) === DARWIN_TEMP_BASE && /^f[a-zA-Z0-9]{6}$/.test(basename(callerTempRoot)))
  );
  const ownsTempRoot = !reuseTempRoot && tempBase !== undefined;
  const laneTempRoot = ownsTempRoot && tempBase !== undefined
    ? realpathSync(mkdtempSync(join(tempBase, "f")))
    : callerTempRoot;
  if (ownsTempRoot && process.getuid && process.getgid) {
    chownSync(laneTempRoot, process.getuid(), process.getgid());
  }
  // Steps inherit TMPDIR even where the caller left it unset, so the leak guard
  // scans the root they write to.
  process.env.TMPDIR = laneTempRoot;
  process.env.FLAIR_UNIT_TEMP_ROOT = laneTempRoot;
  const laneBudgetMs = limits?.laneBudgetMs;
  const deadline = laneBudgetMs === undefined ? Infinity : Date.now() + laneBudgetMs;
  const budgetRanOut = `the lane's ${seconds(laneBudgetMs ?? 0)} time budget ran out`;
  // The service-manager tripwire (flair#2062). Created BEFORE the temp-dir
  // snapshot below, so its own scratch directory is never mistaken for a leak
  // this lane caused. Every step runs with `tripwire.dir` FIRST on PATH; after
  // every step a nonempty tripwire log fails the lane naming the step and the
  // calls. `options.tripwire` is a test seam — a caller that supplies one owns
  // its cleanup.
  const tripwire = options.tripwire ?? installServiceManagerTripwire();
  const ownsTripwire = options.tripwire === undefined;
  const finish = (code: number): number => {
    if (ownsTripwire) tripwire.cleanup();
    if (previousTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmpdir;
    if (previousTempRoot === undefined) delete process.env.FLAIR_UNIT_TEMP_ROOT;
    else process.env.FLAIR_UNIT_TEMP_ROOT = previousTempRoot;
    if (ownsTempRoot) rmSync(laneTempRoot, { recursive: true, force: true });
    return code;
  };
  // Read the tripwire log after a step. A nonempty log is a step failure naming
  // the calls; an unreadable log is a broken harness and fails the lane too
  // (reported once — never read as "no calls").
  let tripwireUnreadable = false;
  const inspectTripwire = (): string | undefined => {
    let calls: string[];
    try {
      calls = tripwire.takeTrips();
    } catch (error) {
      if (tripwireUnreadable) return undefined;
      tripwireUnreadable = true;
      // Covers both an unreadable log and one that cannot record calls (a
      // replaced/symlinked log, or one that discards the canary): either way the
      // lane must fail, never read the empty log as clear (flair#2064).
      return `the service-manager tripwire log cannot be read or cannot record calls (${errorMessage(error)})`;
    }
    if (!calls.length) return undefined;
    return `reached the host service manager without its own fake (${calls.join("; ")})`;
  };
  // Fingerprint the REAL client configs before the lane and compare after it.
  // `guardHome` defaults to the real home (realHomeDir() resolves the passwd
  // entry for the current uid, not HOME, so neither the sandbox this module
  // installs nor the per-step HOME below can hide a real write); the parameter
  // lets a test point the guard at a fixture home and prove the boundary without
  // ever touching the real one (flair#1853 round 3).
  const before = snapshotClientConfigs(guardHome);
  // The temp-dir leak guard's `before` snapshot (flair#1889).
  const guardTempDir = laneTempRoot;
  const tempBefore = flairTempNames(guardTempDir);

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
    for (const { step, names, killed } of tempEntries) {
      if (killed) {
        console.error(`Temp-dir entries first observed after ${step} (killed): ${names.join(", ")}.`);
      } else if (reportTempDirLeaks(names, guardTempDir)) {
        guardFailures.push({
          kind: "guard",
          name: "temp-dir leak guard",
          detail: `${names.length} new flair-* entries first observed after ${step} in ${guardTempDir}: ${names.join(", ")} (flair#1889)`,
        });
      }
    }
    const observed = new Set([...tempBefore, ...tempEntries.flatMap(entry => entry.names)]);
    const leaked = newFlairTempNames(observed, flairTempNames(guardTempDir));
    if (reportTempDirLeaks(leaked, guardTempDir)) {
      guardFailures.push({ kind: "guard", name: "temp-dir leak guard", detail: `new entries first observed at the final guard: ${leaked.join(", ")}` });
    }
  };

  const stepFailures: UnitLaneFailure[] = [];
  const tempEntries: Array<{ step: string; names: string[]; killed: boolean }> = [];

  const shardTimings: Array<{ index: number; of: number; ms: number }> = [];
  let completed = 0;
  for (const [index, step] of steps.entries()) {
    if (step.shard && !step.files.length) {
      console.log(`\n${step.name}: empty shard; skipped`);
      completed++;
      continue;
    }
    const remaining = deadline - Date.now();
    if (remaining < 1) {
      // The budget is spent before this step could start: it and every later
      // step are reported as not run rather than silently dropped.
      const notRun = steps.slice(index);
      console.error(`\nUnit lane: ${budgetRanOut}; ${notRun.length} step${notRun.length === 1 ? "" : "s"} not run.`);
      if (!keepGoing) {
        runGuards();
        console.error(`Unit lane failed: ${budgetRanOut} before ${step.name}. ${completed}/${steps.length} steps completed.`);
        return finish(1);
      }
      for (const skipped of notRun) stepFailures.push({ kind: "not-run", name: skipped.name, detail: budgetRanOut });
      break;
    }
    console.log(`\n${step.name}${step.files.length ? ` (${step.files.length} files)` : ""}`);
    const stepStartedMs = Date.now();
    const limit = limits && (step.timeoutMs ?? limits.stepTimeoutMs);
    const timeout = limit === undefined
      ? undefined
      : remaining < limit
        ? { ms: remaining, reason: `timed out: ${budgetRanOut}` }
        : { ms: limit, reason: `timed out after ${seconds(limit)}` };
    const stepTempBefore = flairTempNames(guardTempDir);
    const outcome = runStep(step, executable, timeout, createSandbox, tripwire.dir);
    const names = newFlairTempNames(stepTempBefore, flairTempNames(guardTempDir));
    if (names.length) tempEntries.push({ step: step.name, names, killed: outcome.killedAtLimit });
    const detail = outcome.detail;
    // Per-step timing, printed after every step the lane attempts, pass or
    // fail (flair#2224): the budget above is sized from measured step times, so
    // the lane reports them; otherwise the next resize can only be re-derived
    // from CI timestamps that no longer exist. Each root unit shard names its
    // own duration here (flair#2258).
    const elapsedMs = Date.now() - stepStartedMs;
    console.log(`${step.name}: ${seconds(elapsedMs)}`);
    if (step.shard) shardTimings.push({ ...step.shard, ms: elapsedMs });
    // The tripwire is checked after EVERY step, whatever the step's own
    // outcome, so a call that reached it is named with the step that made it.
    const tripwireDetail = inspectTripwire();
    const reason = [detail, tripwireDetail].filter(Boolean).join("; ") || undefined;
    if (reason !== undefined) {
      if (!keepGoing) {
        // Fail-fast (the local default): stop here. The end-of-lane guards still
        // run so a config write next to a step failure is not missed.
        runGuards();
        console.error(`Unit lane failed: ${step.name} (${reason}). ${completed}/${steps.length} steps completed.`);
        return finish(1);
      }
      // Keep-going (the CI default): record the failure and run every later step.
      stepFailures.push({ kind: "step", name: step.name, detail: reason });
      continue;
    }
    completed++;
  }

  runGuards();
  if (shardTimings.length) {
    console.log(
      `Root unit shards: ${shardTimings.map(({ index, of, ms }) => `${index}/${of} ${seconds(ms)}`).join(", ")}.`,
    );
  }
  const summary = `${completed} steps, ${steps.reduce((n, step) => n + step.files.length, 0)} test files`;
  if (!keepGoing) {
    // Every step passed; only a guard failure can fail the lane now.
    if (guardFailures.length) return finish(1);
    console.log(`\nUnit lane passed: ${summary}. Test pass/skip counts are reported by Bun above.`);
    return finish(0);
  }
  const failures = [...stepFailures, ...guardFailures];
  if (failures.length) {
    console.error(`\n${summarizeUnitLane(failures, steps.length)}`);
    return finish(1);
  }
  console.log(`\nUnit lane passed: ${summary}. Test pass/skip counts are reported by Bun above.`);
  return finish(0);
}

if (import.meta.main) {
  try {
    const invocation = parseUnitLaneArgs(process.argv.slice(2), process.env);
    const root = dirname(dirname(fileURLToPath(import.meta.url)));
    const allSteps = unitPlan(root);
    // A sharded invocation runs the shared setup steps first, then this shard's
    // test-bearing steps (flair#2311). The whole lane is the unsharded default.
    const steps = invocation.shard
      ? laneShardPlans(allSteps, invocation.shard.of)[invocation.shard.index - 1]
      : allSteps;
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
      const shardNote = invocation.shard
        ? `; shard ${invocation.shard.index}/${invocation.shard.of} of the shared unit lane (the shared setup steps run in every shard; the rest are this shard's test-bearing steps, flair#2311)`
        : "";
      console.log(`Unit lane: Bun ${Bun.version}; Node ${node.stdout.trim()}; ${steps.length} steps${shardNote}; ${mode}. Ambient FLAIR_/HARPER_/HDB_/FABRIC_ settings are removed from child environments; each step runs under a sandbox HOME and behind a launchctl/systemctl tripwire (a unit test that reaches a host service manager without its own fake fails the lane). A guard fails the lane if a real client config changed. Integration, heavy, Python and Playwright suites are separate.`);
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
