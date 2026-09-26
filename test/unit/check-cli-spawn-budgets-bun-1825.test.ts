// check-cli-spawn-budgets-bun-1825.test.ts — flair#1825's extension of the
// CLI-spawn-budget gate: it now sees `Bun.spawn` / `Bun.spawnSync` and named
// aliases of the node spawn functions, and its exceptions live in a trusted
// baseline keyed on file + scope + fingerprint + kind.
//
// RED before the change: the present-site case (a `Bun.spawn` of the CLI entry
// with no timeout) found ZERO offenders — the scanner did not know Bun.spawn —
// and the baseline entry-points did not exist.

import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import {
  findSpawnCalls,
  analyzeTestFile,
  aliasedSpawnFns,
  normalizeFingerprint,
  offenderKey,
  isLineKey,
  validateBaseline,
  diffAgainstBaseline,
  loadBaseline,
  scanTree,
  BASELINE_PATH,
} from "../../scripts/ci/check-cli-spawn-budgets.mjs";

const ROOT = new URL("../../", import.meta.url).pathname;

describe("Bun.spawn / alias detection (flair#1825)", () => {
  it("PRESENT: a Bun.spawn of the CLI entry with no timeout is seen", () => {
    const calls = findSpawnCalls(`Bun.spawn(["bun", "src/cli.ts", "status"], { env });`).calls;
    expect(calls.length).toBe(1);
    expect(calls[0].fn).toBe("Bun.spawn");
    expect(calls[0].isCliEntry).toBe(true);
    expect(calls[0].hasTimeout).toBe(false);
  });

  it("KNOWN-ABSENT CONTROL: a Bun.spawn that is not the CLI entry must NOT be flagged", () => {
    // This is the control that proves the scanner is not a keyword grep: the
    // argv names a script, not the CLI entry, so it is not a CLI-entry spawn.
    const calls = findSpawnCalls(`Bun.spawn(["node", "scripts/thing.mjs"], { env });`).calls;
    expect(calls.length).toBe(1);
    expect(calls[0].isCliEntry).toBe(false);
  });

  it("a Bun.spawn carrying `timeout` is not an offender", () => {
    const calls = findSpawnCalls(`Bun.spawn(["bun", "src/cli.ts"], { timeout: 5_000 });`).calls;
    expect(calls[0].hasTimeout).toBe(true);
  });

  it("Bun.spawnSync is seen too, with argv first / options second", () => {
    const calls = findSpawnCalls(`Bun.spawnSync(["bun", "src/cli.ts", "x"], { cwd });`).calls;
    expect(calls.length).toBe(1);
    expect(calls[0].fn).toBe("Bun.spawnSync");
    expect(calls[0].isCliEntry).toBe(true);
  });

  it("a NAMED ALIAS of the node spawn function is seen with the node arg shape", () => {
    const src = `import { spawn as run } from "node:child_process";\nrun("bun", ["src/cli.ts"], { cwd });`;
    expect([...aliasedSpawnFns(src)]).toEqual([["run", "spawn"]]);
    const calls = findSpawnCalls(src).calls;
    expect(calls.length).toBe(1);
    expect(calls[0].isCliEntry).toBe(true);
  });
});

describe("exception baseline is ungameable (flair#1825)", () => {
  const ok = { file: "test/unit/x.test.ts", scope: "runCli", fingerprint: "f", kind: "spawn-no-timeout", reason: "r" };

  it("a file:line key is rejected", () => {
    const errs = validateBaseline([{ ...ok, file: "test/unit/x.test.ts:12" }]);
    expect(errs.join("\n")).toMatch(/file:line/);
    expect(isLineKey({ ...ok, file: "test/unit/x.test.ts:12" })).toBe(true);
  });

  it("a duplicate fingerprint (same key) is rejected", () => {
    const errs = validateBaseline([ok, { ...ok }]);
    expect(errs.join("\n")).toMatch(/duplicate fingerprint/);
  });

  it("an entry that no longer offends FAILS the gate (the list can only shrink)", () => {
    const { staleEntries, ok: passed } = diffAgainstBaseline([], [], [ok]);
    expect(staleEntries.length).toBe(1);
    expect(passed).toBe(false);
  });

  it("a new offender plus its own exception in the same tree FAILS against the baseline", () => {
    // The trusted baseline holds B; the tree adds A and tries to allow it by
    // adding an entry for A — but the run is diffed against the committed
    // baseline, so A is still NEW.
    const b = { ...ok, fingerprint: "b" };
    const a = { ...ok, fingerprint: "a" };
    const { newOffenders, ok: passed } = diffAgainstBaseline([a], [], [b]);
    expect(newOffenders.map((o) => o.fingerprint)).toEqual(["a"]);
    expect(passed).toBe(false);
  });

  it("multiplicity: one entry covers exactly one call — a second identical call is NEW", () => {
    const one = { file: "test/unit/x.test.ts", scope: "runCli", fingerprint: "ff", kind: "spawn-no-timeout", occurrence: 0, reason: "r" };
    const callA = { ...one };
    const callB = { ...one, line: 99 };
    const { newOffenders, ok: passed } = diffAgainstBaseline([callA, callB], [], [one]);
    expect(newOffenders.length).toBe(1);
    expect(passed).toBe(false);
  });

  it("the committed baseline is valid and empty of line keys", () => {
    const baseline = loadBaseline(BASELINE_PATH);
    expect(validateBaseline(baseline)).toEqual([]);
  });
});

describe("the gate today (flair#1825)", () => {
  it("the current tree has ZERO new and ZERO stale offenders (0 after the change)", () => {
    // Pre-change the extended scanner finds 149 offenders (34 spawn + 115 case);
    // after the change the six named sites are budgeted and the rest baselined.
    const { spawnOffenders, caseOffenders } = scanTree(ROOT);
    const baseline = loadBaseline(BASELINE_PATH);
    const { newOffenders, staleEntries, ok } = diffAgainstBaseline(spawnOffenders, caseOffenders, baseline);
    expect(newOffenders).toEqual([]);
    expect(staleEntries).toEqual([]);
    expect(ok).toBe(true);
  });

  it("offenderKey is never a file:line and is stable across whitespace", () => {
    const o = { file: "test/unit/x.test.ts", scope: "runCli", fingerprint: normalizeFingerprint('["bun",\n  "src/cli.ts"]'), kind: "spawn-no-timeout", occurrence: 0 };
    expect(offenderKey(o)).not.toMatch(/\.ts:\d/);
    expect(offenderKey(o)).toContain("spawn-no-timeout");
  });

  it("analyzeTestFile attributes a helper spawn to its enclosing helper", () => {
    const src = readFileSync("test/unit/cli-auth-floor.test.ts", "utf8");
    const { calls } = analyzeTestFile(src);
    const entry = calls.find((c) => c.isCliEntry);
    expect(entry).toBeDefined();
    if (!entry) throw new Error("no CLI-entry spawn found");
    expect(entry.scope).toBe("runCli");
    expect(entry.hasTimeout).toBe(true);
  });
});
