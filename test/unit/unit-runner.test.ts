import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runUnitSteps, unitEnvironment, unitPlan } from "../../scripts/test-unit.ts";

const root = join(import.meta.dir, "../..");
const fixtures: string[] = [];
afterEach(() => { for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "flair-unit-runner-"));
  fixtures.push(dir);
  return dir;
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
});
