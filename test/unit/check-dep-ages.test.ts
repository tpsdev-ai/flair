/**
 * test/unit/check-dep-ages.test.ts — test the collectDeps function in
 * scripts/check-dep-ages.mjs against literal fixture inputs.
 *
 * Every expected value is written by hand; nothing is computed from the
 * code under test.
 */

import { describe, expect, it } from "bun:test";
import { collectDeps } from "../../scripts/check-dep-ages.mjs";

describe("collectDeps", () => {
  const keepCurrent = new Set(["harper", "some-skip"]);

  describe("dependencies", () => {
    it("collects an exact dependencies pin", () => {
      const pkgs = [
        { pkg: { dependencies: { "some-pkg": "1.2.3" } }, path: "packages/foo/package.json" },
      ];
      const result = collectDeps(pkgs, keepCurrent);
      expect(result.size).toBe(1);
      expect(result.has("some-pkg@1.2.3")).toBe(true);
      expect(result.get("some-pkg@1.2.3")).toEqual({
        name: "some-pkg",
        version: "1.2.3",
        declaredIn: ["packages/foo/package.json"],
      });
    });
  });

  describe("optionalDependencies", () => {
    it("collects an exact optionalDependencies pin with correct declaredIn", () => {
      const pkgs = [
        {
          pkg: { optionalDependencies: { "some-opt": "4.5.6" } },
          path: "packages/bar/package.json",
        },
      ];
      const result = collectDeps(pkgs, keepCurrent);
      expect(result.size).toBe(1);
      expect(result.has("some-opt@4.5.6")).toBe(true);
      expect(result.get("some-opt@4.5.6")).toEqual({
        name: "some-opt",
        version: "4.5.6",
        declaredIn: ["packages/bar/package.json"],
      });
    });

    it("skips an optional range like ^1.2.3", () => {
      const pkgs = [
        {
          pkg: { optionalDependencies: { "some-opt": "^1.2.3" } },
          path: "packages/bar/package.json",
        },
      ];
      const result = collectDeps(pkgs, keepCurrent);
      expect(result.size).toBe(0);
    });

    it("skips an optional @tpsdev-ai/* pin", () => {
      const pkgs = [
        {
          pkg: { optionalDependencies: { "@tpsdev-ai/internal": "1.0.0" } },
          path: "packages/internal/package.json",
        },
      ];
      const result = collectDeps(pkgs, keepCurrent);
      expect(result.size).toBe(0);
    });

    it("skips an optional workspace: entry", () => {
      const pkgs = [
        {
          pkg: { optionalDependencies: { "@tpsdev-ai/some": "workspace:*" } },
          path: "packages/w/pkg.json",
        },
      ];
      const result = collectDeps(pkgs, keepCurrent);
      expect(result.size).toBe(0);
    });
  });

  describe("peerDependencies", () => {
    it("does NOT collect an exact peerDependencies pin", () => {
      const pkgs = [
        {
          pkg: { peerDependencies: { "some-peer": "7.8.9" } },
          path: "packages/peer/package.json",
        },
      ];
      const result = collectDeps(pkgs, keepCurrent);
      expect(result.size).toBe(0);
    });
  });

  describe("cross-package dedup", () => {
    it("one entry for same name@version declared in two packages", () => {
      const pkgs = [
        { pkg: { dependencies: { "shared-pkg": "2.0.0" } }, path: "packages/a/package.json" },
        {
          pkg: { optionalDependencies: { "shared-pkg": "2.0.0" } },
          path: "packages/b/package.json",
        },
      ];
      const result = collectDeps(pkgs, keepCurrent);
      expect(result.size).toBe(1);
      expect(result.has("shared-pkg@2.0.0")).toBe(true);
      const entry = result.get("shared-pkg@2.0.0");
      expect(entry.declaredIn.sort()).toEqual([
        "packages/a/package.json",
        "packages/b/package.json",
      ]);
    });
  });
});
