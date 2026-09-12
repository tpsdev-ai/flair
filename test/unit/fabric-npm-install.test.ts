/**
 * fabric-npm-install.test.ts — the node-side install `flair deploy` /
 * `flair upgrade --target` hand Harper (flair#886).
 *
 * Proves the slope fix: `npm install` is invoked with `--cache` pointed at a
 * fresh temp directory, and that directory is removed after success *and*
 * after failure. A documented `npm cache clean` is not the remedy.
 */

import { describe, test, expect } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  FABRIC_NPM_INSTALL_ARGS_BEFORE_CACHE,
  FABRIC_NPM_INSTALL_COMMAND,
  FABRIC_NPM_INSTALL_ENTRY,
  installWithEphemeralNpmCache,
} from "../../src/fabric-npm-install.js";

describe("FABRIC_NPM_INSTALL_COMMAND", () => {
  test("is the install_command harper deploy receives, and splits into node + entry", () => {
    expect(FABRIC_NPM_INSTALL_COMMAND).toBe(`node ${FABRIC_NPM_INSTALL_ENTRY}`);
    expect(FABRIC_NPM_INSTALL_COMMAND.split(" ")).toEqual(["node", FABRIC_NPM_INSTALL_ENTRY]);
    expect(FABRIC_NPM_INSTALL_ENTRY).toBe("dist/fabric-npm-install.js");
  });

  test("keeps Harper's default install flags so a custom command is not a behavior change", () => {
    expect(FABRIC_NPM_INSTALL_ARGS_BEFORE_CACHE).toEqual([
      "install",
      "--force",
      "--ignore-scripts",
    ]);
  });
});

describe("installWithEphemeralNpmCache", () => {
  test("passes --cache a fresh directory under tmp and removes it after success", () => {
    const scratch = mkdtempSync(join(tmpdir(), "flair-npm-install-test-"));
    const created: string[] = [];
    let seenCache: string | undefined;
    try {
      const status = installWithEphemeralNpmCache({
        tmpdir: scratch,
        mkdtemp: (prefix) => {
          const dir = mkdtempSync(prefix);
          created.push(dir);
          return dir;
        },
        spawn: (_cmd, args, opts) => {
          expect(_cmd).toBe("npm");
          expect(opts.stdio).toBe("inherit");
          const cacheIdx = args.indexOf("--cache");
          expect(cacheIdx).toBeGreaterThanOrEqual(0);
          seenCache = args[cacheIdx + 1];
          expect(seenCache).toBe(created[0]);
          expect(existsSync(seenCache!)).toBe(true);
          expect(args.slice(0, cacheIdx)).toEqual([
            "install",
            "--force",
            "--ignore-scripts",
          ]);
          writeFileSync(join(seenCache!, "tarball-would-land-here"), "x");
          return { status: 0 };
        },
      });
      expect(status).toBe(0);
      expect(seenCache).toBeDefined();
      expect(existsSync(seenCache!)).toBe(false);
      expect(created).toHaveLength(1);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  test("removes the cache when npm exits non-zero", () => {
    const scratch = mkdtempSync(join(tmpdir(), "flair-npm-install-fail-"));
    let seenCache: string | undefined;
    try {
      const status = installWithEphemeralNpmCache({
        tmpdir: scratch,
        spawn: (_cmd, args) => {
          seenCache = args[args.indexOf("--cache") + 1];
          expect(existsSync(seenCache!)).toBe(true);
          return { status: 7 };
        },
      });
      expect(status).toBe(7);
      expect(seenCache).toBeDefined();
      expect(existsSync(seenCache!)).toBe(false);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  test("removes the cache when spawn fails to start", () => {
    const scratch = mkdtempSync(join(tmpdir(), "flair-npm-install-enoent-"));
    let seenCache: string | undefined;
    try {
      expect(() =>
        installWithEphemeralNpmCache({
          tmpdir: scratch,
          spawn: (_cmd, args) => {
            seenCache = args[args.indexOf("--cache") + 1];
            return { status: null, error: new Error("spawn npm ENOENT") };
          },
        }),
      ).toThrow("spawn npm ENOENT");
      expect(seenCache).toBeDefined();
      expect(existsSync(seenCache!)).toBe(false);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  test("does not write into ~/.npm — cache prefix is the provided tmpdir", () => {
    const scratch = mkdtempSync(join(tmpdir(), "flair-npm-install-prefix-"));
    try {
      mkdirSync(join(scratch, "home-npm"), { recursive: true });
      installWithEphemeralNpmCache({
        tmpdir: scratch,
        spawn: (_cmd, args) => {
          const cache = args[args.indexOf("--cache") + 1];
          expect(cache.startsWith(scratch)).toBe(true);
          expect(cache.includes("home-npm")).toBe(false);
          expect(cache.includes(".npm")).toBe(false);
          return { status: 0 };
        },
      });
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
