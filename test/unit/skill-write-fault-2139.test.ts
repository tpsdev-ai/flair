// flair#2139 S2 completion — the skill-write fault hook is an injection point
// that is empty unless the test-only fixture installs it
// (resources/skill-write-fault.ts, test/fixtures/skill-write-fault-2139/probe.js).
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { maybeThrowSkillWriteFault, setSkillWriteFaultHook } from "../../resources/skill-write-fault.ts";

const ROOT = join(import.meta.dir, "..", "..");
const STEPS = ["successor", "close", "pointer", "append"] as const;

afterEach(() => setSkillWriteFaultHook(null));

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sources(p);
    return /\.(ts|js|mjs|cjs)$/.test(name) ? [p] : [];
  });
}

describe("skill-write fault hook (flair#2139 S2)", () => {
  test("production shape: no env value plus no agent id faults a write", () => {
    const names = ["FLAIR_ENABLE_TEST_SKILL_WRITE_FAULT", "NODE_ENV", "FLAIR_TEST"];
    const saved = names.map((n) => process.env[n]);
    try {
      for (const name of names) {
        for (const value of ["1", "true", "test"]) {
          process.env[name] = value;
          for (const step of STEPS) {
            for (const agentId of [`__flair_fault_test__${step}`, "__flair_fault_test__", "real-agent", undefined]) {
              expect(() => maybeThrowSkillWriteFault(step, agentId)).not.toThrow();
            }
          }
        }
      }
    } finally {
      names.forEach((n, i) => {
        if (saved[i] === undefined) delete process.env[n];
        else process.env[n] = saved[i];
      });
    }
  });

  test("an installed hook runs at the step; clearing it restores the no-op", () => {
    setSkillWriteFaultHook((step, agentId) => {
      if (agentId === `x-${step}`) throw new Error(step);
    });
    expect(() => maybeThrowSkillWriteFault("pointer", "x-pointer")).toThrow(/pointer/);
    expect(() => maybeThrowSkillWriteFault("close", "x-pointer")).not.toThrow();
    setSkillWriteFaultHook(null);
    expect(() => maybeThrowSkillWriteFault("pointer", "x-pointer")).not.toThrow();
  });

  test("nothing under resources/ or src/ installs the hook", () => {
    const callers = [...sources(join(ROOT, "resources")), ...sources(join(ROOT, "src"))]
      .filter((p) => readFileSync(p, "utf8").includes("setSkillWriteFaultHook"))
      .map((p) => relative(ROOT, p));
    expect(callers).toEqual([join("resources", "skill-write-fault.ts")]);
  });

  test("the fixture that installs it is outside the package's files", () => {
    const files: string[] = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).files;
    expect(files.some((f) => f.replace(/\/$/, "") === "test" || f.startsWith("test/"))).toBe(false);
    expect(readFileSync(join(ROOT, "test", "fixtures", "skill-write-fault-2139", "probe.js"), "utf8"))
      .toContain("setSkillWriteFaultHook(");
  });
});
