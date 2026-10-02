import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createSandboxHome } from "../helpers/sandbox-home.ts";
import {
  CI_JOB_LIMIT_MS,
  CI_OUTSIDE_LANE_MS,
  KEEP_GOING_LANE_BUDGET_MS,
  KEEP_GOING_LIMITS,
  ROOT_STEP_TIMEOUT_MS,
  STEP_TIMEOUT_MS,
  ciRequestsKeepGoing,
  parseUnitLaneArgs,
  runUnitSteps,
  unitEnvironment,
  unitPlan,
} from "../../scripts/test-unit.ts";

const root = join(import.meta.dir, "../..");
const fixtures: string[] = [];
afterEach(() => { for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "flair-unit-runner-"));
  fixtures.push(dir);
  return dir;
}

/** Run `body` with console.error captured, returning its result and the stderr text. */
function captureErrors<T>(body: () => T): { result: T; errors: string } {
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
  try {
    return { result: body(), errors: errors.join("\n") };
  } finally {
    console.error = original;
  }
}

/** Run `body` with console.log captured, returning its result and the stdout text. */
function captureLogs<T>(body: () => T): { result: T; logs: string } {
  const logs: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  try {
    return { result: body(), logs: logs.join("\n") };
  } finally {
    console.log = original;
  }
}

/** A `node -e` snippet that writes a client config under `home` — what the home-isolation guard detects. */
function plantConfig(home: string): string {
  const dir = join(home, ".codex");
  return `require("node:fs").mkdirSync(${JSON.stringify(dir)}, { recursive: true }); require("node:fs").writeFileSync(${JSON.stringify(join(dir, "config.toml"))}, "planted\\n");`;
}

// A `node -e` body that stays alive for 8 s, then exits 0: far past every
// fixture time limit below, yet it can never outlive the test as an orphan. It
// ignores SIGTERM, as a wedged child can: only a SIGKILL ends it early.
const HANG_8S = 'process.on("SIGTERM", () => {}); setTimeout(() => {}, 8000);';

describe("shared unit lane", () => {
  test("child environment excludes deployment configuration without changing the parent", () => {
    const parent = { FLAIR_AGENT_ID: "real-agent", FLAIR_URL: "https://live.invalid", HARPER_SET_CONFIG: "live", HDB_ADMIN_PASSWORD: "secret", FABRIC_PASSWORD: "secret", PATH: "/bin", CI: "true" };
    expect(unitEnvironment(parent)).toEqual({ PATH: "/bin", CI: "true" });
    expect(parent.FLAIR_AGENT_ID).toBe("real-agent");
  });

  test("deployment credentials do not reach an executed child", () => {
    const saved = process.env.FLAIR_UNIT_RUNNER_SENTINEL;
    process.env.FLAIR_UNIT_RUNNER_SENTINEL = "must-not-inherit";
    try {
      expect(runUnitSteps([{ name: "environment", cwd: fixture(), args: ["-e", 'process.exit(process.env.FLAIR_UNIT_RUNNER_SENTINEL === undefined ? 0 : 1)'], files: [] }])).toBe(0);
    } finally {
      if (saved === undefined) delete process.env.FLAIR_UNIT_RUNNER_SENTINEL;
      else process.env.FLAIR_UNIT_RUNNER_SENTINEL = saved;
    }
  });

  test("includes root tests and isolates every global mock file, with no integration tests", () => {
    const steps = unitPlan(root);
    const rootUnit = steps.find(step => step.name === "root unit tests");
    expect(rootUnit?.files.some(file => file.endsWith("/test/data-scoping.test.ts"))).toBe(true);
    expect(steps.findIndex(step => step.name === "vendor tool descriptors")).toBeLessThan(steps.findIndex(step => step.name === "root unit tests"));
    expect(steps.findIndex(step => step.name === "vendor tool descriptors")).toBeLessThan(steps.findIndex(step => step.name === "flair-mcp unit tests"));
    const isolated = steps.filter(step => step.files.some(file => file.includes("/unit-isolated/")));
    expect(isolated.length).toBeGreaterThan(0);
    for (const step of isolated) {
      expect(step.files).toHaveLength(1);
      expect(step.args).toEqual(["test", step.files[0]]);
    }
    expect(steps.flatMap(step => step.files).some(file => /\/integration[^/]*\//.test(file))).toBe(false);
    expect(steps.findIndex(step => step.name === "build flair-client")).toBeLessThan(steps.findIndex(step => step.name === "flair-mcp unit tests"));
    const prebuild = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts.prebuild as string;
    // bun run build --workspace=... re-invokes root prebuild (infinite loop, exit 128).
    // flair#1683: prebuild now vendors the descriptor source into resources/.
    expect(prebuild).toContain("node scripts/vendor-tool-descriptors.mjs");
    expect(prebuild).not.toContain("packages/flair-tool-descriptors");
    expect(prebuild).not.toContain("--workspace");
  });

  test("empty required discovery fails instead of reporting success", () => {
    const dir = fixture();
    mkdirSync(join(dir, "test"));
    expect(() => unitPlan(dir)).toThrow("No unit test files found in test");
  });

  test("runs steps in fresh processes", () => {
    const dir = fixture();
    writeFileSync(join(dir, "pids.js"), 'require("node:fs").appendFileSync("pids", process.pid + "\\n");');
    expect(runUnitSteps([1, 2].map(n => ({ name: `process ${n}`, cwd: dir, args: ["pids.js"], files: [] })))).toBe(0);
    const pids = readFileSync(join(dir, "pids"), "utf8").trim().split("\n");
    expect(new Set(pids).size).toBe(2);
  });

  test("the final guard fails the lane even when every step SUCCEEDED", () => {
    // The guard is the lane's last line of defence, and an exit-code test that
    // only ever fails a step proves nothing about it: the non-zero code could
    // come from the failed step. Here the child SUCCEEDS and writes a real
    // client config, so the only source of a non-zero code is the guard.
    const home = fixture();
    const marker = join(home, "child-succeeded");
    const config = join(home, ".codex", "config.toml");
    const script = [
      'const fs = require("node:fs"), path = require("node:path");',
      `fs.mkdirSync(path.dirname(${JSON.stringify(config)}), { recursive: true });`,
      `fs.writeFileSync(${JSON.stringify(config)}, "planted\\n");`,
      `fs.writeFileSync(${JSON.stringify(marker)}, "ok");`,
    ].join("");

    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
    let code: number;
    try {
      code = runUnitSteps(
        [{ name: "succeeds but writes a real config", cwd: home, args: ["-e", script], files: [] }],
        process.execPath,
        home,
      );
    } finally {
      console.error = originalError;
    }

    expect(readFileSync(marker, "utf8")).toBe("ok");
    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("Home-isolation guard FAILED");
    expect(errors.join("\n")).toContain(".codex/config.toml");
  });

  test("a failed step stops the lane before later work", () => {
    const dir = fixture();
    expect(runUnitSteps([
      { name: "fails", cwd: dir, args: ["-e", "process.exit(7)"], files: [] },
      { name: "must not run", cwd: dir, args: ["-e", 'require("node:fs").writeFileSync("later", "ran")'], files: [] },
    ])).toBe(1);
    expect(() => readFileSync(join(dir, "later"))).toThrow();
  });

  test("keep-going runs every step and reports each failure with its exit status", () => {
    // (a) two failing fixture steps: both run, both appear in the summary, and
    // the lane exits non-zero.
    const dir = fixture();
    const { result: code, errors } = captureErrors(() => runUnitSteps([
      { name: "first failing step", cwd: dir, args: ["-e", 'require("node:fs").writeFileSync("ran-1", "x"); process.exit(5)'], files: [] },
      { name: "second failing step", cwd: dir, args: ["-e", 'require("node:fs").writeFileSync("ran-2", "x"); process.exit(6)'], files: [] },
    ], process.execPath, dir, { keepGoing: true }));
    expect(code).toBe(1);
    expect(readFileSync(join(dir, "ran-1"), "utf8")).toBe("x");
    expect(readFileSync(join(dir, "ran-2"), "utf8")).toBe("x");
    expect(errors).toContain("first failing step");
    expect(errors).toContain("second failing step");
    expect(errors).toContain("exit 5");
    expect(errors).toContain("exit 6");
    expect(errors).toContain("ran 2 steps, 2 failed");
  });

  test("keep-going runs later steps after an early failure", () => {
    // (b) one failing step early: every later step still ran.
    const dir = fixture();
    const code = runUnitSteps([
      { name: "fails early", cwd: dir, args: ["-e", "process.exit(3)"], files: [] },
      { name: "later one", cwd: dir, args: ["-e", 'require("node:fs").writeFileSync("later-1", "x")'], files: [] },
      { name: "later two", cwd: dir, args: ["-e", 'require("node:fs").writeFileSync("later-2", "x")'], files: [] },
    ], process.execPath, dir, { keepGoing: true });
    expect(code).toBe(1);
    expect(readFileSync(join(dir, "later-1"), "utf8")).toBe("x");
    expect(readFileSync(join(dir, "later-2"), "utf8")).toBe("x");
  });

  test("keep-going fails the lane and names a guard even when every step passed", () => {
    // (c) all steps pass but a guard fails: the lane fails and the summary names
    // the guard — the non-zero code cannot come from a failed step.
    const home = fixture();
    const config = join(home, ".codex", "config.toml");
    const script = [
      'const fs = require("node:fs"), path = require("node:path");',
      `fs.mkdirSync(path.dirname(${JSON.stringify(config)}), { recursive: true });`,
      `fs.writeFileSync(${JSON.stringify(config)}, "planted\\n");`,
    ].join("");
    const { result: code, errors } = captureErrors(() => runUnitSteps(
      [{ name: "succeeds but writes a real config", cwd: home, args: ["-e", script], files: [] }],
      process.execPath,
      home,
      { keepGoing: true },
    ));
    expect(code).toBe(1);
    expect(errors).toContain("ran 1 step, 0 failed");
    expect(errors).toContain("Guard failures:");
    expect(errors).toContain("home-isolation guard");
    expect(errors).toContain(".codex/config.toml");
  });

  test("keep-going is opt-in: the default still stops at the first failure", () => {
    // (d) local default without the flag: still fail-fast.
    const dir = fixture();
    const code = runUnitSteps([
      { name: "fails", cwd: dir, args: ["-e", 'require("node:fs").writeFileSync("first", "x"); process.exit(9)'], files: [] },
      { name: "must not run", cwd: dir, args: ["-e", 'require("node:fs").writeFileSync("second", "x")'], files: [] },
    ], process.execPath, dir); // no keepGoing argument
    expect(code).toBe(1);
    expect(readFileSync(join(dir, "first"), "utf8")).toBe("x");
    expect(() => readFileSync(join(dir, "second"))).toThrow();
  });

  test("keep-going is requested when CI is set", () => {
    expect(ciRequestsKeepGoing({ CI: "true" })).toBe(true);
    expect(ciRequestsKeepGoing({ CI: "1" })).toBe(true);
    expect(ciRequestsKeepGoing({ CI: " TRUE " })).toBe(true);
    expect(ciRequestsKeepGoing({})).toBe(false);
    expect(ciRequestsKeepGoing({ CI: "" })).toBe(false);
    expect(ciRequestsKeepGoing({ CI: "false" })).toBe(false);
    expect(ciRequestsKeepGoing({ CI: "0" })).toBe(false);
  });

  test("keep-going: a hung step is killed at its limit, and the steps after it and the guards still run (flair#2030)", () => {
    const dir = fixture();
    const started = Date.now();
    const { result: code, errors } = captureErrors(() => runUnitSteps([
      { name: "hangs past its own limit", cwd: dir, args: ["-e", HANG_8S], files: [], timeoutMs: 2000 },
      { name: "hangs past the default limit", cwd: dir, args: ["-e", HANG_8S], files: [] },
      { name: "fails after the hangs", cwd: dir, args: ["-e", `require("node:fs").writeFileSync("ran-3", "x"); ${plantConfig(dir)} process.exit(4)`], files: [] },
    ], process.execPath, dir, { keepGoing: true, limits: { stepTimeoutMs: 1000 } }));
    // Both hangs were cut short: neither reached its own 8 s end.
    expect(Date.now() - started).toBeLessThan(8000);
    expect(code).toBe(1);
    expect(readFileSync(join(dir, "ran-3"), "utf8")).toBe("x");
    expect(errors).toContain("ran 3 steps, 3 failed");
    expect(errors).toContain("  - hangs past its own limit (timed out after 2 s; killed)");
    expect(errors).toContain("  - hangs past the default limit (timed out after 1 s; killed)");
    expect(errors).toContain("  - fails after the hangs (exit 4)");
    // The guards still ran after the timeouts: the config the last step planted is named.
    expect(errors).toContain("Guard failures:\n  - home-isolation guard");
  }, 30_000);

  test("fail-fast with limits: a hung step is killed at its limit and fails the lane without running later steps", () => {
    const dir = fixture();
    const started = Date.now();
    const { result: code, errors } = captureErrors(() => runUnitSteps([
      { name: "hangs", cwd: dir, args: ["-e", `${plantConfig(dir)} ${HANG_8S}`], files: [], timeoutMs: 1000 },
      { name: "must not run", cwd: dir, args: ["-e", 'require("node:fs").writeFileSync("later", "x")'], files: [] },
    ], process.execPath, dir, { limits: { stepTimeoutMs: 60_000 } }));
    expect(Date.now() - started).toBeLessThan(8000);
    expect(code).toBe(1);
    expect(existsSync(join(dir, "later"))).toBe(false);
    expect(errors).toContain("Unit lane failed: hangs (timed out after 1 s; killed)");
    expect(errors).toContain("Home-isolation guard FAILED");
  }, 30_000);

  test("keep-going: the lane budget kills the running step and reports every later step as not run, then the guards run (flair#2030)", () => {
    const dir = fixture();
    const started = Date.now();
    const { result: code, errors } = captureErrors(() => runUnitSteps([
      { name: "plants a config, then hangs", cwd: dir, args: ["-e", `${plantConfig(dir)} ${HANG_8S}`], files: [] },
      { name: "never started", cwd: dir, args: ["-e", 'require("node:fs").writeFileSync("later", "x")'], files: [] },
    ], process.execPath, dir, { keepGoing: true, limits: { stepTimeoutMs: 60_000, laneBudgetMs: 1500 } }));
    expect(Date.now() - started).toBeLessThan(8000);
    expect(code).toBe(1);
    expect(existsSync(join(dir, "later"))).toBe(false);
    expect(errors).toContain("ran 1 of 2 steps, 1 failed, 1 not run");
    expect(errors).toContain("  - plants a config, then hangs (timed out: the lane's 2 s time budget ran out; killed)");
    expect(errors).toContain("Not run:\n  - never started (the lane's 2 s time budget ran out)");
    expect(errors).toContain("Guard failures:\n  - home-isolation guard");
  }, 30_000);

  test("without limits nothing is time-limited, not even a step with its own timeoutMs (fail-fast runs)", () => {
    // The limits are derived from a CI runner; a slower machine running the
    // local default must not see a slow step as a failure.
    const dir = fixture();
    const started = Date.now();
    const code = runUnitSteps([
      { name: "slow but fine", cwd: dir, args: ["-e", "setTimeout(() => {}, 1500)"], files: [], timeoutMs: 500 },
    ], process.execPath, dir);
    expect(code).toBe(0);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1400);
  }, 30_000);

  test("a step whose sandbox HOME cannot be created fails as a step; it never escapes the lane or skips the guards", () => {
    for (const keepGoing of [true, false]) {
      const dir = fixture();
      let calls = 0;
      const createSandbox = () => {
        if (calls++ > 0) return createSandboxHome();
        // Plant a config first, so the guards' output proves they still ran.
        mkdirSync(join(dir, ".codex"), { recursive: true });
        writeFileSync(join(dir, ".codex", "config.toml"), "planted\n");
        throw new Error("mkdtemp failed (fixture)");
      };
      const { result: code, errors } = captureErrors(() => runUnitSteps([
        { name: "has no sandbox", cwd: dir, args: ["-e", 'require("node:fs").writeFileSync("ran-1", "x")'], files: [] },
        { name: "fails later", cwd: dir, args: ["-e", 'require("node:fs").writeFileSync("ran-2", "x"); process.exit(4)'], files: [] },
      ], process.execPath, dir, { keepGoing, createSandbox }));
      expect(code).toBe(1);
      // A step is never run without its sandbox: its HOME would be the real one.
      expect(existsSync(join(dir, "ran-1"))).toBe(false);
      const why = "has no sandbox (not started: its sandbox HOME could not be created (mkdtemp failed (fixture)))";
      if (keepGoing) {
        expect(readFileSync(join(dir, "ran-2"), "utf8")).toBe("x");
        expect(errors).toContain("ran 2 steps, 2 failed");
        expect(errors).toContain(`  - ${why}`);
        expect(errors).toContain("  - fails later (exit 4)");
        expect(errors).toContain("Guard failures:\n  - home-isolation guard");
      } else {
        expect(existsSync(join(dir, "ran-2"))).toBe(false);
        expect(errors).toContain(`Unit lane failed: ${why}`);
        expect(errors).toContain("Home-isolation guard FAILED");
      }
    }
  });

  test("the temp-dir leak guard fails the lane, and keep-going names it, even when every step passed (flair#1889, flair#2030)", () => {
    for (const keepGoing of [false, true]) {
      const home = fixture();
      // The leak lands in THIS process's temp dir, the one the guard watches.
      const leak = join(tmpdir(), `flair-unit-runner-leak-${process.pid}-${keepGoing ? "keep-going" : "fail-fast"}`);
      fixtures.push(leak); // removed after the test, so the lane running this file sees no leak
      const { result: code, errors } = captureErrors(() => runUnitSteps(
        [{ name: "succeeds but leaves a flair-* temp dir", cwd: home, args: ["-e", `require("node:fs").mkdirSync(${JSON.stringify(leak)})`], files: [] }],
        process.execPath,
        home,
        { keepGoing },
      ));
      // The step itself succeeded; only the guard can fail the lane.
      expect(existsSync(leak)).toBe(true);
      expect(code).toBe(1);
      expect(errors).toContain("Temp-dir leak guard FAILED");
      expect(errors).toContain(basename(leak));
      if (keepGoing) {
        expect(errors).toContain("ran 1 step, 0 failed");
        expect(errors).toContain("Guard failures:\n  - temp-dir leak guard: the unit lane left 1 new flair-* directory");
      }
    }
  });

  test("the runner's arguments: --fail-fast overrides CI, --list runs nothing, contradictions are refused (flair#2030)", () => {
    const ci = { CI: "true" };
    expect(parseUnitLaneArgs([], {})).toEqual({ list: false, keepGoing: false });
    expect(parseUnitLaneArgs([], ci)).toEqual({ list: false, keepGoing: true, limits: KEEP_GOING_LIMITS });
    expect(parseUnitLaneArgs(["--keep-going"], {})).toEqual({ list: false, keepGoing: true, limits: KEEP_GOING_LIMITS });
    expect(parseUnitLaneArgs(["--fail-fast"], ci)).toEqual({ list: false, keepGoing: false });
    expect(parseUnitLaneArgs(["--list", "--keep-going"], {}).list).toBe(true);
    expect(() => parseUnitLaneArgs(["--keep-going", "--fail-fast"], ci)).toThrow("contradict");
    expect(() => parseUnitLaneArgs(["--bogus"], {})).toThrow("Unknown argument");
  });

  test("release.sh runs the lane fail-fast even when it inherits CI=true (flair#2030)", () => {
    const release = readFileSync(join(root, "scripts", "release.sh"), "utf8");
    const invocations = [...release.matchAll(/bun run test:unit((?:[ \t]+--[\w-]+)*)/g)];
    expect(invocations.length).toBe(1);
    for (const [, flags] of invocations) {
      expect(parseUnitLaneArgs(flags.trim().split(/\s+/).filter(Boolean), { CI: "true" })).toEqual({ list: false, keepGoing: false });
    }
  });

  test("the time bounds fit inside the CI job that runs the lane (flair#2030, resized flair#2224)", () => {
    const workflow = readFileSync(join(root, ".github", "workflows", "test.yml"), "utf8");
    const start = workflow.indexOf("\n  test-unit:\n");
    const end = workflow.indexOf("\n  test-unit-gate:\n");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const job = workflow.slice(start, end);
    // The derivation's input from the workflow: change the two together.
    expect(Number(job.match(/^ {4}timeout-minutes: (\d+)$/m)?.[1]) * 60_000).toBe(CI_JOB_LIMIT_MS);
    expect(job).toContain("run: bun run test:unit --keep-going");
    // Measured on CI legs and locally (see the constants in scripts/test-unit.ts):
    // the slowest lane, its root step, the slowest other step, and the job's own
    // steps outside the lane.
    const lane = 510_000, rootStep = 327_000, otherStep = 33_000, outside = 53_000;
    expect(KEEP_GOING_LIMITS).toEqual({ stepTimeoutMs: STEP_TIMEOUT_MS, laneBudgetMs: KEEP_GOING_LANE_BUDGET_MS });
    expect(KEEP_GOING_LANE_BUDGET_MS + CI_OUTSIDE_LANE_MS).toBeLessThanOrEqual(CI_JOB_LIMIT_MS);
    expect(CI_OUTSIDE_LANE_MS).toBeGreaterThan(outside);
    expect(STEP_TIMEOUT_MS).toBeGreaterThanOrEqual(3 * otherStep);
    expect(ROOT_STEP_TIMEOUT_MS).toBeGreaterThan(rootStep);
    // The budget carries headroom over the slowest measured lane (flair#2224),
    // so a runner up to half again as slow as the worst observed does not kill a
    // late step.
    expect(KEEP_GOING_LANE_BUDGET_MS).toBeGreaterThanOrEqual(1.5 * lane);
    // One hung step, wherever it is, still leaves every later step room to run
    // inside the budget.
    expect(lane + STEP_TIMEOUT_MS).toBeLessThanOrEqual(KEEP_GOING_LANE_BUDGET_MS);
    expect(lane - rootStep + ROOT_STEP_TIMEOUT_MS).toBeLessThanOrEqual(KEEP_GOING_LANE_BUDGET_MS);
    const limited = unitPlan(root).filter(step => step.timeoutMs !== undefined);
    expect(limited.map(step => [step.name, step.timeoutMs])).toEqual([["root unit tests", ROOT_STEP_TIMEOUT_MS]]);
  });

  test("every step that runs reports its own duration (flair#2224)", () => {
    // The lane budget is sized from measured step times, so the lane prints each
    // one; a resize then reads the numbers from the log instead of re-deriving
    // them from CI timestamps.
    const dir = fixture();
    const { result: code, logs } = captureLogs(() => runUnitSteps(
      [{ name: "quick step", cwd: dir, args: ["-e", "process.exit(0)"], files: [] }],
      process.execPath,
      dir,
      { keepGoing: true },
    ));
    expect(code).toBe(0);
    expect(logs).toMatch(/quick step: \d+ s/);
  });
});
