/**
 * node-alias-path-2034.test.ts — flair#2034 §2, item 3.
 *
 * A generated unit must survive a Node exact-minor bump when the version
 * manager exposes an alias for the same runtime, and must NEVER be pointed at a
 * path that resolves to a DIFFERENT runtime. One fixture per supported layout.
 */
import { describe, test, expect } from "bun:test";
import {
  aliasCandidates,
  preferVersionManagerAlias,
  parseNodeVersion,
  describeSupportedLayouts,
} from "../../src/lib/node-alias-path.ts";

const HOME = "/home/u";

/** Hooks over a table of { path → realpath } for files that exist. */
function hooksFor(table: Record<string, string>) {
  return {
    home: HOME,
    env: { HOME } as NodeJS.Dict<string>,
    exists: (p: string) => p in table,
    realpath: (p: string) => {
      if (p in table) return table[p]!;
      throw new Error(`ENOENT: ${p}`);
    },
  };
}

describe("parseNodeVersion", () => {
  test("reads the version out of an install path", () => {
    expect(parseNodeVersion("/home/u/.local/share/mise/installs/node/24.19.0/bin/node")).toBe("24.19.0");
    expect(parseNodeVersion("/home/u/.nvm/versions/node/v24.19.0/bin/node")).toBe("24.19.0");
    expect(parseNodeVersion("/usr/bin/node")).toBeNull();
  });
});

describe("preferVersionManagerAlias — per layout", () => {
  test("mise: prefers the major-version alias when it is the same runtime", () => {
    const real = "/home/u/.local/share/mise/installs/node/24.19.0/bin/node";
    const hooks = hooksFor({
      [real]: real,
      "/home/u/.local/share/mise/installs/node/24/bin/node": real,
    });
    expect(preferVersionManagerAlias(real, hooks)).toBe("/home/u/.local/share/mise/installs/node/24/bin/node");
  });

  test("nvm: prefers the exact-version path it already has", () => {
    const real = "/home/u/.nvm/versions/node/v24.19.0/bin/node";
    const hooks = hooksFor({ [real]: real });
    expect(preferVersionManagerAlias(real, hooks)).toBe(real);
  });

  test("fnm: prefers the versioned installation path", () => {
    const real = "/home/u/.local/share/fnm/node-versions/v24.19.0/installation/bin/node";
    const hooks = hooksFor({ [real]: real });
    expect(preferVersionManagerAlias(real, hooks)).toBe(real);
  });

  test("volta: prefers the stable bin shim", () => {
    const real = "/home/u/.volta/tools/image/node/24.19.0/bin/node";
    const hooks = hooksFor({ [real]: real, "/home/u/.volta/bin/node": real });
    expect(preferVersionManagerAlias(real, hooks)).toBe("/home/u/.volta/bin/node");
  });

  test("asdf: prefers the versioned install path", () => {
    const real = "/home/u/.asdf/installs/nodejs/24.19.0/bin/node";
    const hooks = hooksFor({ [real]: real });
    expect(preferVersionManagerAlias(real, hooks)).toBe(real);
  });

  test("no alias at all: the resolved path is written unchanged", () => {
    const real = "/opt/runtimes/node/24.19.0/bin/node";
    const hooks = hooksFor({ [real]: real });
    expect(preferVersionManagerAlias(real, hooks)).toBe(real);
  });

  test("an alias that resolves to a DIFFERENT runtime is rejected", () => {
    const real = "/home/u/.local/share/mise/installs/node/24.19.0/bin/node";
    const other = "/home/u/.local/share/mise/installs/node/22.11.0/bin/node";
    const hooks = hooksFor({
      [real]: real,
      "/home/u/.local/share/mise/installs/node/24/bin/node": other,
    });
    expect(preferVersionManagerAlias(real, hooks)).toBe(real);
  });

  test("an unreadable resolved binary is written as given", () => {
    const hooks = { home: HOME, exists: () => true, realpath: () => { throw new Error("ENOENT"); } };
    expect(preferVersionManagerAlias("/nope/node", hooks)).toBe("/nope/node");
  });
});

describe("describeSupportedLayouts", () => {
  test("names every supported version manager", () => {
    const text = describeSupportedLayouts().join("\n");
    for (const mgr of ["mise", "nvm", "fnm", "volta", "asdf"]) expect(text).toContain(mgr);
  });

  test("aliasCandidates is empty without a version in the path", () => {
    expect(aliasCandidates("/usr/bin/node", { home: HOME })).toEqual([]);
  });
});
