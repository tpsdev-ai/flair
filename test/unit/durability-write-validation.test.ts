// flair#1238 — a writer-supplied `durability` that is not one of the four valid
// values must be REFUSED, not silently accepted.
//
// The asymmetry this file exists to protect (mirror of the visibility guard):
//
//   READING an unknown durability must be permissive. defaultVisibilityForDurability
//   treats any non-permanent/persistent string as the private branch, and a row
//   written before a tier existed (or by a non-Python adapter) must keep resolving
//   exactly as before — that fail-safe must not change.
//
//   WRITING an unknown durability must be refused. Today an unknown value via raw
//   REST is silently accepted and lands on the narrower private branch by accident
//   — fail-safe, but unvalidated by contract. Refusing at the schema boundary makes
//   it safe by construction (flair#1238, from Sherlock's #1237 review).
import { describe, test, expect } from "bun:test";
import {
  assertValidDurability,
  WRITABLE_DURABILITIES,
} from "../../resources/memory-durability.js";

describe("assertValidDurability — write-side rejection (flair#1238)", () => {
  test("accepts the four valid values", () => {
    for (const v of WRITABLE_DURABILITIES) {
      expect(assertValidDurability(v)).toBeNull();
    }
  });

  test("accepts absence — omitting the field asks for the default \"standard\"", () => {
    expect(assertValidDurability(undefined)).toBeNull();
    expect(assertValidDurability(null)).toBeNull();
  });

  test("rejects an unknown value", () => {
    const err = assertValidDurability("forever");
    expect(err).not.toBeNull();
    expect(err).toContain("forever");
  });

  test("rejects wrong case — the enum is case-sensitive", () => {
    expect(assertValidDurability("Permanent")).not.toBeNull();
    expect(assertValidDurability("STANDARD")).not.toBeNull();
  });

  test("rejects non-strings rather than coercing them", () => {
    for (const v of [1, true, {}, [], "", " standard", "standard "]) {
      expect(assertValidDurability(v)).not.toBeNull();
    }
  });

  test("the error names all four valid values and the way to opt out", () => {
    const err = assertValidDurability("nonsense") ?? "";
    for (const v of WRITABLE_DURABILITIES) {
      expect(err).toContain(`"${v}"`);
    }
    expect(err).toContain("Omit it");
  });
});

// ─── Structural tripwire: the guard must remain WIRED ─────────────────────────
//
// The tests above validate `assertValidDurability` in isolation. That is not
// enough — a validator nobody calls is not a control (the visibility guard proved
// this: neutering it inside Memory.post() broke nothing, 3869 tests still passed).
//
// This scan fails the build if either write path stops calling it. Same shape as
// visibility-write-validation.test.ts and claimed-zero-authority-tripwire.test.ts,
// and same limitation, stated plainly: it detects DELETION, not misbehaviour. A
// behavioural assertion (unknown durability → 400) needs the REST surface against
// a live Harper, which is the integration lane's job (see
// test/integration/durability-write-validation-e2e.test.ts).
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("the durability guard stays wired into both write paths", () => {
  const src = readFileSync(join(import.meta.dir, "..", "..", "resources", "Memory.ts"), "utf8");

  test("Memory.ts imports the validator", () => {
    expect(src).toContain('from "./memory-durability.js"');
    expect(src).toContain("assertValidDurability");
  });

  test("it is called once per write path — post() and put()", () => {
    const calls = src.match(/assertValidDurability\(content\.durability\)/g) ?? [];
    // Two write paths exist (post and put). Each needs its own guard: they are
    // separate entry points, and REST reaches both.
    expect(calls.length).toBe(2);
  });
});
