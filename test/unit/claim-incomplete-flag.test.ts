// flair#1756 slice 2 — the `flair rem candidates` reviewer surface.
//
// The structural-truncation signal is defined ONCE in src/rem/promote-policy.ts
// and shared by the server gate (resources/auto-promote-lib.ts) and the CLI; this
// file covers the CLI-side presenter that turns the signal into the advisory
// marker a reviewer sees. (No parity test: there is only one implementation.)

import { describe, test, expect } from "bun:test";
import { candidateIncompleteFlag } from "../../src/commands/rem.ts";

describe("candidateIncompleteFlag — the `flair rem candidates` reviewer surface", () => {
  test("the observed fragment is flagged as structurally incomplete", () => {
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

  test("non-string claim does not throw (malformed row never crashes the listing)", () => {
    expect(() => candidateIncompleteFlag(123)).not.toThrow();
    expect(() => candidateIncompleteFlag({ claim: "x" })).not.toThrow();
    expect(() => candidateIncompleteFlag(null)).not.toThrow();
    expect(candidateIncompleteFlag(123)).toBe("no terminal punctuation — possible fragment");
  });
});
