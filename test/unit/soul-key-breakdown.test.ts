import { describe, test, expect } from "bun:test";
import { sortSoulKeyEntries } from "../../src/cli";

/**
 * Tests for the soul stats breakdown (flair#453).
 *
 * The health detail surface used to bucket soul entries by a `priority`
 * taxonomy (critical/high/standard/low). That was dead telemetry: nothing
 * ever writes Soul.priority to anything but "standard", so the breakdown
 * always read 100% standard regardless of the data. It's been replaced with
 * a breakdown by `key` — the honest dimension soul entries actually have.
 *
 * sortSoulKeyEntries() is the shared ordering used by both the plain and the
 * styled `flair health` renderers.
 */

describe("sortSoulKeyEntries", () => {
  test("empty map → empty list (no breakdown rendered)", () => {
    expect(sortSoulKeyEntries({})).toEqual([]);
  });

  test("nullish input is tolerated → empty list", () => {
    // @ts-expect-error exercising the runtime guard against missing byKey
    expect(sortSoulKeyEntries(undefined)).toEqual([]);
  });

  test("orders by count descending", () => {
    const out = sortSoulKeyEntries({ role: 1, standards: 3, project: 2 });
    expect(out).toEqual([
      ["standards", 3],
      ["project", 2],
      ["role", 1],
    ]);
  });

  test("ties broken alphabetically for stable output", () => {
    const out = sortSoulKeyEntries({ project: 1, role: 1, standards: 1 });
    expect(out).toEqual([
      ["project", 1],
      ["role", 1],
      ["standards", 1],
    ]);
  });

  test("single key passes through", () => {
    expect(sortSoulKeyEntries({ role: 5 })).toEqual([["role", 5]]);
  });

  test("does not invent a priority taxonomy — keys are whatever the data has", () => {
    // A typical hand-authored soul: role/project/standards, all keyed, none
    // carrying a severity. The breakdown reflects keys, never critical/high/low.
    const out = sortSoulKeyEntries({ role: 1, project: 1, standards: 1 });
    const keys = out.map(([k]) => k);
    expect(keys).toEqual(["project", "role", "standards"]);
    expect(keys).not.toContain("critical");
    expect(keys).not.toContain("high");
    expect(keys).not.toContain("low");
  });
});
