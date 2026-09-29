// flair#1093 — the backwards-engine refusal must cover EVERY boot path, not
// just `flair start`.
//
// checkEngineVersionBackwards (#1047) had exactly one call site, inline in the
// `start` command's action. `flair restart` goes straight to restartFlair ->
// startFlairProcess and never reached it; `flair upgrade` restarts by spawning
// the newly installed CLI with `restart`, so the path most likely to cross an
// engine boundary was the one path with no guard. The observable result on
// flair#1045 was an instance that came back DOWN with a bare exit 1 instead of
// a refusal naming actor, state and remedy.
//
// The logic itself is tested in engine-version.test.ts. What failed here was
// the WIRING, so that is what this file asserts. Reading the diff finds none of
// this — the guard is correct and simply not connected to the second door.
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const rawSrc = readFileSync(join(import.meta.dir, "..", "..", "src", "cli.ts"), "utf8");

// Scan CODE, not prose. The guard carries a long comment explaining the bug it
// fixes, and that comment names the very identifiers being counted below — a
// raw scan reads those mentions as call sites and passes a file that has none.
function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}
const src = stripComments(rawSrc);

/**
 * Body of a top-level `function name(...)` / `async function name(...)`, by brace
 * matching. The parameter list is skipped by PAREN matching first, and the body
 * is the first brace that ends a line after it: a parameter or return type
 * written as an object literal (`input: { … }`, `): { label: string }`) would
 * otherwise be read as the body (flair#2040's executors have both).
 */
function functionBody(source: string, name: string): string {
  const decl = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(source);
  if (!decl) throw new Error(`could not find function ${name} in cli.ts`);
  let paren = 0;
  let afterParams = -1;
  for (let i = source.indexOf("(", decl.index); i < source.length; i++) {
    if (source[i] === "(") paren++;
    else if (source[i] === ")" && --paren === 0) { afterParams = i + 1; break; }
  }
  if (afterParams < 0) throw new Error(`unbalanced parameter list reading ${name}`);
  // The body's brace ends its line; a return type written as an object literal
  // (`): { label: string } {`) does not.
  const open = source.indexOf("{\n", afterParams);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) return source.slice(open, i + 1);
  }
  throw new Error(`unbalanced braces reading ${name}`);
}

describe("the comment stripper (positive control)", () => {
  test("removes commented-out code but keeps real code", () => {
    expect(stripComments("// guardEngineNotBackwards(x)\n")).not.toContain("guardEngineNotBackwards(");
    expect(stripComments("/* guardEngineNotBackwards(x) */\n")).not.toContain("guardEngineNotBackwards(");
    expect(stripComments("guardEngineNotBackwards(x);\n")).toContain("guardEngineNotBackwards(");
  });

  test("does not eat a URL's double slash", () => {
    expect(stripComments('const u = "https://example.com/x";')).toContain("example.com");
  });
});

describe("the refusal has exactly one implementation", () => {
  test("checkEngineVersionBackwards is called once in cli.ts, inside the guard", () => {
    // Two call sites means two copies of the decision, which is how `start` and
    // startFlairProcess drifted on the spawn env before this (see
    // buildDirectSpawnEnv's note). One definition, many callers.
    const calls = [...src.matchAll(/checkEngineVersionBackwards\s*\(/g)].length;
    expect(calls).toBe(1);
  });

  test("that one call lives in guardEngineNotBackwards", () => {
    expect(functionBody(src, "guardEngineNotBackwards")).toContain("checkEngineVersionBackwards(");
  });
});

describe("every boot path runs the guard", () => {
  test("startFlairProcess guards before it spawns anything", () => {
    // startFlairProcess backs restart, upgrade and the snapshot paths — seven
    // call sites — so guarding HERE is what covers them all. Asserting the
    // guard runs BEFORE the spawn matters: after the spawn it would refuse a
    // boot that already happened.
    const body = functionBody(src, "startFlairProcess");
    const guardAt = body.indexOf("guardEngineNotBackwards(");
    expect(guardAt).toBeGreaterThan(-1);

    const firstSpawn = Math.min(
      ...["launchctl", "spawn(", "ensureLaunchdServiceLoaded("]
        .map((m) => body.indexOf(m))
        .filter((i) => i > -1),
    );
    expect(firstSpawn).toBeGreaterThan(guardAt);
  });

  test("the start command runs the same guard, not its own copy", () => {
    // `start` needs different presentation (framing + exit code) but must not
    // reimplement the decision to get it.
    expect(src).toContain("guardEngineNotBackwards(dataDir)");
    const guardCalls = [...src.matchAll(/guardEngineNotBackwards\s*\(\s*dataDir\s*\)/g)].length;
    expect(guardCalls).toBeGreaterThanOrEqual(2);
  });

  test("no boot path calls startFlairProcess's spawn helpers directly", () => {
    // The guard sits at the top of startFlairProcess. If a future path calls
    // ensureLaunchdServiceLoaded itself instead of going through
    // startFlairProcess, it boots unguarded — the exact shape of this bug.
    // `start` and the doctor --fix launchd repair (flair#1573 b1) are the two
    // legitimate direct callers and both guard themselves, so the budget is 2
    // (plus the definition).
    const direct = [...src.matchAll(/ensureLaunchdServiceLoaded\s*\(/g)].length;
    expect(direct).toBeLessThanOrEqual(4);
  });

  // flair#2040 split the repair into two phases: prepareLaunchdRepair (reads
  // and validation only — the guard lives here) and commitLaunchdRepair (the
  // stop, the write, the load). The executor runs prepare to completion and
  // returns on any refusal before commit is reached, so "guard before stop /
  // load" is: the guard is in prepare, the stop and the load are in commit,
  // and prepare is called before commit.
  test("the doctor --fix launchd repair guards before it loads", () => {
    // The repair (flair#1573 b1) regenerates the plist then loads it — a boot
    // path. It must run the same backwards-engine guard as startFlairProcess,
    // and it must do so BEFORE the load, not after.
    const executor = functionBody(src, "repairLaunchdManagement");
    const prepareAt = executor.indexOf("prepareLaunchdRepair(");
    const commitAt = executor.indexOf("commitLaunchdRepair(");
    expect(prepareAt).toBeGreaterThan(-1);
    expect(commitAt).toBeGreaterThan(prepareAt);
    const prepare = functionBody(src, "prepareLaunchdRepair");
    expect(prepare).toContain("guardEngineNotBackwards(");
    // Phase 1 loads nothing, stops nothing, boots nothing out.
    for (const effect of ["loadLaunchdJob(", "ensureLaunchdServiceLoaded(", "stopDirectProcessForAdopt(", "bootoutCommand(", "startFlairDirect("]) {
      expect(prepare).not.toContain(effect);
    }
    expect(functionBody(src, "commitLaunchdRepair")).toContain("loadLaunchdJob(");
  });

  test("the doctor --fix launchd repair guards before it stops (adopt arm)", () => {
    // The adopt arm (flair#1573 b2) clean-stops the direct process before
    // regenerating + loading. The guard must run BEFORE that stop: it is a
    // pure read whose inputs don't change during the repair, so guard-first
    // refuses WITHOUT bouncing the live instance (guard-after-stop would
    // SIGTERM the instance and then refuse, leaving it down with nothing to
    // restart it).
    expect(functionBody(src, "prepareLaunchdRepair")).toContain("guardEngineNotBackwards(");
    expect(functionBody(src, "commitLaunchdRepair")).toContain("stopDirectProcessForAdopt(");
  });

  test("init's replacement of a SERVING legacy job guards before it unloads anything (flair#2040)", () => {
    const body = functionBody(src, "registerInitLaunchdService");
    const guardAt = body.indexOf("guardEngineNotBackwards(");
    expect(guardAt).toBeGreaterThan(-1);
    // The serving job's boot-out is the verified one (flair#2040 round 4).
    const bootoutAt = body.indexOf("ensureLaunchdJobAbsent(");
    expect(bootoutAt).toBeGreaterThan(guardAt);
  });

  test("every direct launchd load and direct start in cli.ts is one of the guarded, named callers (flair#2040)", () => {
    // A boot path that calls the loader or the direct spawn itself boots
    // unguarded unless it is one of these: startFlairProcess guards itself;
    // ensureLaunchdServiceLoaded's callers guard (start, startFlairProcess);
    // the repair's commit runs after prepare's guard; init guards before it
    // unloads a serving job; the two restores bring back an instance whose
    // boot was already guarded in the same run.
    const count = (re: RegExp, s: string) => [...s.matchAll(re)].length;
    const loadCallers = ["ensureLaunchdServiceLoaded", "commitLaunchdRepair", "registerInitLaunchdService", "restoreLegacyAfterFailedMigration"];
    const loadInCallers = loadCallers.reduce((n, f) => n + count(/loadLaunchdJob\s*\(/g, functionBody(src, f)), 0);
    expect(count(/loadLaunchdJob\s*\(/g, src)).toBe(loadInCallers);
    const directCallers = ["startFlairProcess", "restoreAfterFailedRepair", "restoreLegacyAfterFailedMigration"];
    const directInCallers = directCallers.reduce((n, f) => n + count(/startFlairDirect\s*\(/g, functionBody(src, f)), 0);
    // + 1 for the definition itself.
    expect(count(/startFlairDirect\s*\(/g, src)).toBe(directInCallers + 1);
  });
});
