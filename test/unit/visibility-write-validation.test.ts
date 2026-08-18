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
  assertVisibilityAllowedForDurability,
  isPrivateVisibility,
  EPHEMERAL_DURABILITY,
  PRIVATE_VISIBILITY,
  SHARED_VISIBILITY,
  WRITABLE_VISIBILITIES,
} from "../../resources/memory-visibility.js";
import { WRITABLE_DURABILITIES } from "../../resources/memory-durability.js";

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

// ─── flair#1257: ephemeral memories are private-only ──────────────────────────
//
// `ephemeral` is the continuity-journal tier. Its durability-keyed DEFAULT is
// private, but a default is not a constraint — before #1257 an explicit
// visibility:"shared" on an ephemeral write was accepted, making journal
// entries org-readable and federation-pushed. These tests pin the refusal rule
// itself; the behavioural REST proof (POST/PUT → 400) lives in
// test/integration/ephemeral-visibility-guard-e2e.test.ts.
describe("assertVisibilityAllowedForDurability — ephemeral is private-only (flair#1257)", () => {
  test("refuses ephemeral + shared — the combination the guard exists for", () => {
    const err = assertVisibilityAllowedForDurability(EPHEMERAL_DURABILITY, SHARED_VISIBILITY);
    expect(err).not.toBeNull();
    // Actor + state + remedy: names the tier, the refused value, and both exits.
    expect(err).toContain("private-only");
    expect(err).toContain('"shared"');
    expect(err).toContain("Omit visibility");
    expect(err).toContain("1257");
  });

  test("fail-closed: ephemeral + any PRESENT non-private value is refused, not just \"shared\"", () => {
    // The read side resolves anything other than the literal "private" to
    // non-private (migration invariant), so an unknown value on an ephemeral
    // row would leak exactly like "shared". assertValidVisibility refuses
    // unknowns first at both call sites, but this guard must not depend on
    // that layering to be safe.
    for (const v of ["office", "prvate", "Private", "public", "", 1, true]) {
      expect(assertVisibilityAllowedForDurability(EPHEMERAL_DURABILITY, v)).not.toBeNull();
    }
  });

  test("accepts ephemeral + private, and ephemeral + absent (the default path)", () => {
    expect(assertVisibilityAllowedForDurability(EPHEMERAL_DURABILITY, PRIVATE_VISIBILITY)).toBeNull();
    expect(assertVisibilityAllowedForDurability(EPHEMERAL_DURABILITY, undefined)).toBeNull();
    expect(assertVisibilityAllowedForDurability(EPHEMERAL_DURABILITY, null)).toBeNull();
  });

  test("no over-fire: every NON-ephemeral durability may still write shared", () => {
    for (const d of WRITABLE_DURABILITIES) {
      if (d === EPHEMERAL_DURABILITY) continue;
      expect(assertVisibilityAllowedForDurability(d, SHARED_VISIBILITY)).toBeNull();
    }
    // And an absent effective durability (fresh PUT with no durability and no
    // pre-existing row) is not ephemeral, so shared passes through to the
    // ordinary visibility rules.
    expect(assertVisibilityAllowedForDurability(undefined, SHARED_VISIBILITY)).toBeNull();
  });

  test("drift-pin: EPHEMERAL_DURABILITY is a real member of the durability enum", () => {
    // memory-visibility.ts declares the literal locally to keep its zero-imports
    // property (src/cli.ts safety). This is what keeps the local literal and the
    // enum from drifting apart silently.
    expect(WRITABLE_DURABILITIES as readonly string[]).toContain(EPHEMERAL_DURABILITY);
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

  test("the flair#1257 ephemeral-private guard is wired into both write paths", () => {
    // Same shape and same limitation as the tripwire above: detects DELETION,
    // not misbehaviour — the behavioural 400s live in the integration lane
    // (ephemeral-visibility-guard-e2e.test.ts, which is also where the
    // mutation-check was run: guard removed → those tests go red).
    expect(src).toContain("assertVisibilityAllowedForDurability");
    const calls = src.match(/assertVisibilityAllowedForDurability\(/g) ?? [];
    // One call in post(), one in put(); the import line does not match the
    // trailing "(". put()'s call must see the EFFECTIVE durability — the
    // pre-existing row's when the update payload omits it — or a partial PUT
    // flipping a stored ephemeral row to shared sails past the guard.
    expect(calls.length).toBe(2);
    expect(src).toContain("content.durability ?? preExisting?.durability");
  });
});
