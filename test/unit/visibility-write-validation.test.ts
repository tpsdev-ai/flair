// flair#1009 — a writer-supplied `visibility` that is not "private" or "shared"
// must be REFUSED, not silently defaulted.
//
// The asymmetry this file exists to protect:
//
//   READING an unknown value must be permissive. A row written before the field
//   existed has no visibility and must keep reading exactly as it always did —
//   that is the migration invariant in memory-visibility.ts, and it is correct.
//
//   WRITING an unknown value must be refused. Because the read side is an exact
//   match on "private", every other string — a typo, a wrong case, a retired
//   tier like "office" — resolves to non-private and is readable by every agent
//   on the instance.
//
// #1006 closed this at the two writer-intent boundaries (the CLI flag, the MCP
// tool argument). REST and the in-process API reach Memory.put()/post() without
// passing either, so `PUT /Memory/<id> {"visibility":"prvate"}` wrote a memory
// the caller believed was owner-only and everyone could read.
//
// Both directions are asserted here. A validator that rejected everything would
// pass a "typo is refused" test while breaking every legitimate write.
import { describe, test, expect } from "bun:test";
import {
  assertValidVisibility,
  isPrivateVisibility,
  PRIVATE_VISIBILITY,
  SHARED_VISIBILITY,
  WRITABLE_VISIBILITIES,
} from "../../resources/memory-visibility.js";

describe("assertValidVisibility — write-side rejection (flair#1009)", () => {
  test("accepts the two valid values", () => {
    expect(assertValidVisibility(PRIVATE_VISIBILITY)).toBeNull();
    expect(assertValidVisibility(SHARED_VISIBILITY)).toBeNull();
  });

  test("accepts absence — omitting the field asks for the durability-keyed default", () => {
    expect(assertValidVisibility(undefined)).toBeNull();
    expect(assertValidVisibility(null)).toBeNull();
  });

  test("rejects the typo that motivated the issue", () => {
    const err = assertValidVisibility("prvate");
    expect(err).not.toBeNull();
    expect(err).toContain("prvate");
  });

  test("rejects wrong case — the read predicate is case-sensitive, so Private is NOT private", () => {
    expect(assertValidVisibility("Private")).not.toBeNull();
    expect(assertValidVisibility("PRIVATE")).not.toBeNull();
    // and the reason it matters:
    expect(isPrivateVisibility("Private")).toBe(false);
  });

  test("rejects a retired tier", () => {
    // "office" is named in Memory.ts's own history as a value that leaked.
    expect(assertValidVisibility("office")).not.toBeNull();
  });

  test("rejects non-strings rather than coercing them", () => {
    for (const v of [1, true, {}, [], "", " private", "private "]) {
      expect(assertValidVisibility(v)).not.toBeNull();
    }
  });

  test("the error names both valid values and the way to opt out", () => {
    const err = assertValidVisibility("nonsense") ?? "";
    expect(err).toContain(`"${PRIVATE_VISIBILITY}"`);
    expect(err).toContain(`"${SHARED_VISIBILITY}"`);
    expect(err).toContain("Omit it");
  });
});

describe("the read predicate stays permissive — the migration invariant", () => {
  test("a record with no visibility is NOT private, and that must not change", () => {
    expect(isPrivateVisibility(undefined)).toBe(false);
    expect(isPrivateVisibility(null)).toBe(false);
  });

  test("an unknown STORED value still reads as non-private", () => {
    // Rows written before #1009 may hold anything. The write path now refuses
    // such values, but the read path must keep resolving them exactly as before
    // — inverting this to an allowlist would silently privatise existing rows.
    expect(isPrivateVisibility("office")).toBe(false);
    expect(isPrivateVisibility("prvate")).toBe(false);
  });

  test("write-validation is STRICTER than read-resolution — that asymmetry is deliberate", () => {
    // Every value the writer may supply is one the reader understands...
    for (const v of WRITABLE_VISIBILITIES) {
      expect(assertValidVisibility(v)).toBeNull();
    }
    // ...but the reverse does not hold, and must not: the reader accepts values
    // the writer refuses. If someone ever "simplifies" these into one predicate,
    // this test is what fails.
    expect(isPrivateVisibility("office")).toBe(false);
    expect(assertValidVisibility("office")).not.toBeNull();
  });
});

// ─── Structural tripwire: the guard must remain WIRED ─────────────────────────
//
// The tests above validate `assertValidVisibility` in isolation. That is not
// enough, and I proved it: neutering the guard inside `Memory.post()` broke
// nothing — 3869 tests still passed. A validator nobody calls is not a control.
//
// This scan fails the build if either write path stops calling it. Same shape as
// claimed-zero-authority-tripwire.test.ts, and same limitation, stated plainly:
// it detects DELETION, not misbehaviour. A behavioural assertion needs the REST
// surface against a live Harper, which is the integration lane's job — the
// tripwire is what makes the unit lane able to notice at all.
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("the visibility guard stays wired into both write paths", () => {
  const src = readFileSync(join(import.meta.dir, "..", "..", "resources", "Memory.ts"), "utf8");

  test("Memory.ts imports the validator", () => {
    expect(src).toContain('from "./memory-visibility.js"');
    expect(src).toContain("assertValidVisibility");
  });

  test("it is called once per write path — post() and put()", () => {
    const calls = src.match(/assertValidVisibility\(content\.visibility\)/g) ?? [];
    // Two default-visibility sites exist (post at ~647, put at ~841). Each needs
    // its own guard: they are separate entry points, and REST reaches both.
    expect(calls.length).toBe(2);
  });

  test("every durability-default site is preceded by a guard", () => {
    // The failure this catches: someone adds a third write path with a
    // durability default and forgets the guard. Counting both and comparing is
    // what makes a NEW unguarded path fail rather than pass unnoticed.
    const defaults = src.match(/defaultVisibilityForDurability\(content\.durability\)/g) ?? [];
    const guards = src.match(/assertValidVisibility\(content\.visibility\)/g) ?? [];
    expect(guards.length).toBe(defaults.length);
  });
});
