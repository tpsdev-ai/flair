// flair#1756 slice 2 — the structural-truncation signal.
//
// The signal exists TWICE, deliberately: the GATE is server-side in
// resources/auto-promote-lib.ts (decideAutoPromote — the unattended path), and a
// MIRROR lives in src/rem/promote-policy.ts so the CLI can flag a probable
// fragment in `flair rem candidates`. They sit on opposite sides of the
// npm-packaging boundary and cannot import one another, so the parity test below
// pins them to identical behavior — a divergence would let the display disagree
// with the gate that actually refuses.

import { describe, test, expect } from "bun:test";
import {
  structuralImbalance as serverStructural,
  hasTerminalPunctuation as serverTerminal,
} from "../../resources/auto-promote-lib.ts";
import {
  structuralImbalance as cliStructural,
  hasTerminalPunctuation as cliTerminal,
} from "../../src/rem/promote-policy.ts";
import { candidateIncompleteFlag } from "../../src/commands/rem.ts";

const CORPUS = [
  "",
  "Deploys run at 0200 UTC",
  "Deploys run at 0200 UTC.",
  "Dynamic imports in Harper's VM sandbox require escaping via `new Function(",
  "`flair rem nightly` reports progress (see the docs) and never promotes without the scope tag.",
  "unbalanced (open",
  "unbalanced close)",
  "[1, 2, 3",
  "1, 2, 3]",
  "{a: 1",
  "a: 1}",
  "odd ` backtick",
  "even `a` backtick",
  "nested ((a)) fine",
  "cross-nested (a] bad",
  "He said \"go!\"",
  "(see below.)",
];

describe("structural-truncation signal: CLI mirror matches the server gate", () => {
  test("structuralImbalance parity across the corpus", () => {
    for (const s of CORPUS) expect(cliStructural(s)).toBe(serverStructural(s));
  });
  test("hasTerminalPunctuation parity across the corpus", () => {
    for (const s of CORPUS) expect(cliTerminal(s)).toBe(serverTerminal(s));
  });
});

describe("candidateIncompleteFlag — the `flair rem candidates` reviewer surface", () => {
  test("the exact observed fragment is flagged as structurally incomplete", () => {
    const flag = candidateIncompleteFlag("Dynamic imports in Harper's VM sandbox require escaping via `new Function(");
    expect(flag).not.toBeNull();
    expect(flag).toContain("structurally incomplete");
  });

  test("balanced-but-unpunctuated prose is flagged (weaker signal), never as structural", () => {
    const flag = candidateIncompleteFlag("Deploys run at 0200 UTC");
    expect(flag).toContain("no terminal punctuation");
    expect(flag).not.toContain("structurally incomplete");
  });

  test("a well-formed claim is not flagged", () => {
    expect(candidateIncompleteFlag("`flair rem nightly` reports progress (see the docs).")).toBeNull();
  });

  test("undefined claim does not throw (row without a claim)", () => {
    expect(candidateIncompleteFlag(undefined)).toBe("no terminal punctuation — possible fragment");
  });
});
