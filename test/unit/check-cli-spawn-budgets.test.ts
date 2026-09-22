// check-cli-spawn-budgets.test.ts — the matching primitives of flair#1807's
// CLI-spawn class gate (scripts/ci/check-cli-spawn-budgets.mjs).
//
// The gate used to build a RegExp from an identifier at three sites
// (`new RegExp(\`\\b${id}\\b\`)` and two `…\\s*\\(` variants). The identifiers
// come from `[A-Za-z_$][\w$]*` captures, so they cannot carry a backslash
// today — but the gate is a CONTROL and must not depend on that: a backslash in
// the input would silently change what the pattern matches (flair#1809's
// class; CodeQL js/incomplete-sanitization, Semgrep
// detect-non-literal-regexp). The fix matches identifiers by string scanning.
// These tests pin the three primitives that replaced the three sites.
//
// This file imports the gate's exported functions only — `new RegExp` cannot be
// unit-tested for behaviour, so the primitives it was replaced WITH are.

import { describe, it, expect } from "bun:test";
import {
  isIdentChar,
  findIdentifier,
  identifierCallFollows,
} from "../../scripts/ci/check-cli-spawn-budgets.mjs";

const ID = "runCli";

describe("CLI-spawn gate identifier matching (flair#1807)", () => {
  it("isIdentChar accepts exactly the JS identifier characters, including `$`", () => {
    for (const ch of ["a", "Z", "0", "9", "_", "$"]) expect(isIdentChar(ch)).toBe(true);
    for (const ch of ["", "(", ")", " ", "-", ".", "\\"]) expect(isIdentChar(ch)).toBe(false);
  });

  it("POSITIVE: matches a whole-word identifier at the start, called with `(`", () => {
    expect(findIdentifier("runCli(", ID, 0)).toBe(0);
    expect(identifierCallFollows("runCli(", ID.length)).toBe(true);
  });

  it("POSITIVE: matches a whole-word identifier after leading whitespace, `(` after a space", () => {
    const text = " runCli (";
    const at = findIdentifier(text, ID, 0);
    expect(at).toBe(1);
    expect(identifierCallFollows(text, at + ID.length)).toBe(true);
  });

  it("NEGATIVE: rejects a hit that is only part of a longer identifier", () => {
    // Prefixed — the character BEFORE the identifier is an identifier char.
    expect(findIdentifier("myrunCli(", ID, 0)).toBe(-1);
    // Suffixed — the character AFTER the identifier is an identifier char.
    expect(findIdentifier("runCli2(", ID, 0)).toBe(-1);
    // Both, and no call — `runCliHelper` is a different name entirely.
    expect(findIdentifier("runCliHelper", ID, 0)).toBe(-1);
    // A name that differs by case (`myRunCli`) is not a match either: the scan
    // is exact, so this is rejected before the boundary rule is even reached.
    expect(findIdentifier("myRunCli(", ID, 0)).toBe(-1);
  });

  it("scans PAST a rejected hit to a later whole-word occurrence", () => {
    expect(findIdentifier("myrunCli(runCli(", ID, 0)).toBe(9);
  });

  it("handles a `$`-bearing identifier (the case the old `.replace(/[$]/g)` guarded)", () => {
    expect(findIdentifier("$cli(", "$cli", 0)).toBe(0);
    expect(identifierCallFollows("$cli(", "$cli".length)).toBe(true);
    // `$cli` as a suffix of a longer identifier is still rejected.
    expect(findIdentifier("x$cli(", "$cli", 0)).toBe(-1);
  });

  it("identifierCallFollows requires `(` after (only) optional whitespace", () => {
    expect(identifierCallFollows("runCli(", ID.length)).toBe(true);
    expect(identifierCallFollows("runCli (", ID.length)).toBe(true);
    expect(identifierCallFollows("runCli\n(", ID.length)).toBe(true);
    // A different character, or the end of the text, is not a call.
    expect(identifierCallFollows("runCliHelper", ID.length)).toBe(false);
    expect(identifierCallFollows("runCli  =", ID.length)).toBe(false);
    expect(identifierCallFollows("runCli", ID.length)).toBe(false);
  });

  it("does NOT special-case string literals — that is the gate's masking job, not this scan's", () => {
    // OUT OF SCOPE for these primitives: they are pure string scans over the
    // text they are handed, with no notion of whether a character is code or a
    // literal. An identifier inside a string literal therefore still matches
    // here; the gate handles literal content one level up (it masks comments
    // and skips literal contents in its bracket walks). This assertion pins the
    // boundary so it is a documented decision rather than an accident.
    expect(findIdentifier('"runCli("', ID, 0)).toBe(1);
  });
});
