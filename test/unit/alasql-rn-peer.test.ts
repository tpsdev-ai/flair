/**
 * flair#847 — alasql's react-native-fs must become an optional peer, not an
 * optionalDependency. optionalDependencies are still installed; optional
 * peers are not. This is the edit that has to reach a published consumer.
 */
import { describe, expect, test } from "bun:test";
import {
  promoteReactNativeFsInLockfile,
  promoteReactNativeFsToOptionalPeer,
  stripPackLifecycleScripts,
} from "../../scripts/alasql-rn-peer.mjs";
import { registryHarperSpec, restoreHarperDep, rewriteHarperDepForPack, vendorHarperPath } from "../../scripts/materialize-patched-harper.mjs";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..", "..");

describe("promoteReactNativeFsToOptionalPeer", () => {
  test("moves react-native-fs from optionalDependencies to an optional peer", () => {
    const manifest = {
      optionalDependencies: { "react-native-fs": "^2.20.0", other: "1.0.0" },
    };
    expect(promoteReactNativeFsToOptionalPeer(manifest)).toBe(true);
    expect(manifest.optionalDependencies).toEqual({ other: "1.0.0" });
    expect(manifest.peerDependencies).toEqual({ "react-native-fs": "^2.20.0" });
    expect(manifest.peerDependenciesMeta).toEqual({ "react-native-fs": { optional: true } });
  });

  test("drops optionalDependencies when react-native-fs was the only entry", () => {
    const manifest = { optionalDependencies: { "react-native-fs": "^2.20.0" } };
    expect(promoteReactNativeFsToOptionalPeer(manifest)).toBe(true);
    expect(manifest.optionalDependencies).toBeUndefined();
  });

  test("is a no-op when the field is already an optional peer", () => {
    const manifest = {
      peerDependencies: { "react-native-fs": "^2.20.0" },
      peerDependenciesMeta: { "react-native-fs": { optional: true } },
    };
    expect(promoteReactNativeFsToOptionalPeer(manifest)).toBe(false);
    expect(manifest.optionalDependencies).toBeUndefined();
  });
});

describe("promoteReactNativeFsInLockfile", () => {
  test("patches every package entry that still auto-installs react-native-fs", () => {
    const lock = {
      packages: {
        "node_modules/alasql": { optionalDependencies: { "react-native-fs": "^2.20.0" } },
        "node_modules/left-pad": { version: "1.0.0" },
      },
    };
    expect(promoteReactNativeFsInLockfile(lock)).toBe(1);
    expect(lock.packages["node_modules/alasql"].optionalDependencies).toBeUndefined();
    expect(lock.packages["node_modules/alasql"].peerDependencies).toEqual({ "react-native-fs": "^2.20.0" });
  });
});

describe("stripPackLifecycleScripts", () => {
  test("removes husky-bearing pack scripts so a registry tarball can be re-packed", () => {
    const manifest = { scripts: { prepack: "husky", test: "true" } };
    expect(stripPackLifecycleScripts(manifest)).toBe(true);
    expect(manifest.scripts).toEqual({ test: "true" });
  });
});

describe("the git manifest stays a registry pin", () => {
  const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));

  test("dependencies.harper is a registry version, not a vendor path or file:", () => {
    expect(pkg.dependencies.harper).toMatch(/^\d+\.\d+\.\d+/);
    expect(pkg.dependencies.harper).not.toMatch(/vendor|file:/);
  });

  test("rewrite/restore is a pack-time swap, not a committed override", () => {
    expect(registryHarperSpec("5.2.8")).toBe("5.2.8");
    expect(registryHarperSpec("./vendor/harper-5.2.8.tgz")).toBe("5.2.8");
    expect(vendorHarperPath("5.2.8")).toBe("vendor/harper-5.2.8.tgz");
    const rewritten = rewriteHarperDepForPack(pkg, "5.2.8");
    expect(rewritten.dependencies.harper).toBe("./vendor/harper-5.2.8.tgz");
    expect(rewritten.files).toContain("vendor/");
    const restored = restoreHarperDep(rewritten, "5.2.8");
    expect(restored.dependencies.harper).toBe("5.2.8");
    expect(restored.files).not.toContain("vendor/");
  });

  test("does not add harper to bundleDependencies (that drops RocksDB)", () => {
    expect(pkg.bundleDependencies || []).not.toContain("harper");
  });
});
