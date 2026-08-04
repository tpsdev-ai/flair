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

/** Body of a top-level `function name(...)` / `async function name(...)`, by brace matching. */
function functionBody(source: string, name: string): string {
  const decl = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(source);
  if (!decl) throw new Error(`could not find function ${name} in cli.ts`);
  const open = source.indexOf("{", decl.index);
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
    // `start` is the one legitimate direct caller and guards itself, so the
    // budget is 1 (plus the definition).
    const direct = [...src.matchAll(/ensureLaunchdServiceLoaded\s*\(/g)].length;
    expect(direct).toBeLessThanOrEqual(3);
  });
});
