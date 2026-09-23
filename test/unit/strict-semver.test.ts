/**
 * flair#1856 — strict SemVer 2.0.0 validation without a dependency.
 *
 * `scripts/ci/registry-tarball-sha256.mjs` used `semver.valid(version) !== version`
 * for strict validation, but the post-publish canary runs on a clean,
 * credential-less runner that installs no `node_modules`, so the `semver` import
 * crashed (ERR_MODULE_NOT_FOUND) before a single tarball was hashed. The script
 * now carries the official semver.org regex instead.
 *
 * The contract is unchanged — exactly a canonical strict version passes, and
 * anything `semver.valid` would NORMALIZE (a leading `v`, missing components,
 * leading zeros, a dangling `-`) fails.
 */

import { describe, expect, test } from "bun:test";

import { isStrictSemver, STRICT_SEMVER } from "../../scripts/ci/registry-tarball-sha256.mjs";

const ACCEPTED = ["0.55.2", "1.2.3-rc.1+build.5", "1.2.3", "1.2.3-rc-1"];
const REJECTED = ["v0.55.2", "1.2", "01.2.3", "1.2.3-", "", "1.2.3.4", "=0.55.2"];

describe("strict SemVer 2.0.0 validation (flair#1856)", () => {
  for (const version of ACCEPTED) {
    test(`accepts the canonical version ${JSON.stringify(version)}`, () => {
      expect(isStrictSemver(version)).toBe(true);
      expect(STRICT_SEMVER.test(version)).toBe(true);
    });
  }

  for (const version of REJECTED) {
    test(`rejects the non-canonical version ${JSON.stringify(version)}`, () => {
      expect(isStrictSemver(version)).toBe(false);
      expect(STRICT_SEMVER.test(version)).toBe(false);
    });
  }

  test("the regex is anchored — it cannot match a version embedded in noise", () => {
    expect(isStrictSemver("0.55.2 ")).toBe(false);
    expect(isStrictSemver(" 0.55.2")).toBe(false);
    expect(isStrictSemver("x0.55.2")).toBe(false);
  });
});
