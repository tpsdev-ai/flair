/**
 * stale-version.test.ts — unit tests for the shared staleVersion helper
 * (flair#1834).
 *
 * Moved here from codex-toml-sibling-and-identity-1834.test.ts when the helper
 * was extracted from eleven test files into test/helpers/stale-version.ts.
 */

import { describe, it, expect } from "bun:test";

import { staleVersion } from "../helpers/stale-version.ts";

describe("staleVersion — the shared stale-version helper", () => {
  it("1.2.3 → decrements the patch", () => {
    expect(staleVersion([1, 2, 3])).toBe("1.2.2");
  });

  it("1.2.0 → falls back to the minor, patch 0", () => {
    expect(staleVersion([1, 2, 0])).toBe("1.1.0");
  });

  it("1.0.0 → falls back to the major, minor and patch 0", () => {
    expect(staleVersion([1, 0, 0])).toBe("0.0.0");
  });

  it("0.0.0 → throws (there is no stale version below it)", () => {
    expect(() => staleVersion([0, 0, 0])).toThrow();
  });
});
