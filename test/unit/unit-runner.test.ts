import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ciRequestsKeepGoing, runUnitSteps, unitEnvironment, unitPlan } from "../../scripts/test-unit.ts";

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
    ], process.execPath, dir, true));
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
    ], process.execPath, dir, true);
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
      true,
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
});
