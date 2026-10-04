/**
 * node-alias-path-2034.test.ts — flair#2034 §2.
 *
 * The node path written into a generated unit/shim is a FLOATING alias only
 * where one exists and resolves to the very same binary (mise's major alias;
 * Volta's bin/node only when it is really the same binary). Everything else —
 * nvm, fnm, asdf, a standard Volta shim, an alias that has moved to another
 * runtime — keeps the exact path.
 */
import { describe, test, expect } from "bun:test";
import { aliasCandidates, preferVersionManagerAlias, parseNodeVersion } from "../../src/lib/node-alias-path.ts";

const HOME = "/home/u";

/** Hooks over a table of { path → realpath } for files that exist. */
function hooksFor(table: Record<string, string>, env: NodeJS.Dict<string> = {}) {
  return {
    home: HOME,
    env,
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

describe("preferVersionManagerAlias", () => {
  const MISE_EXACT = "/home/u/.local/share/mise/installs/node/24.19.0/bin/node";
  const MISE_ALIAS = "/home/u/.local/share/mise/installs/node/24/bin/node";

  test("mise: writes the major alias when it resolves to the same binary", () => {
    expect(preferVersionManagerAlias(MISE_EXACT, hooksFor({ [MISE_EXACT]: MISE_EXACT, [MISE_ALIAS]: MISE_EXACT }))).toBe(MISE_ALIAS);
  });

  test("mise honours MISE_DATA_DIR", () => {
    const exact = "/data/mise/installs/node/24.19.0/bin/node";
    const alias = "/data/mise/installs/node/24/bin/node";
    expect(preferVersionManagerAlias(exact, hooksFor({ [exact]: exact, [alias]: exact }, { MISE_DATA_DIR: "/data/mise" }))).toBe(alias);
  });

  test("an alias that has MOVED to another runtime is never written", () => {
    const other = "/home/u/.local/share/mise/installs/node/24.20.0/bin/node";
    expect(preferVersionManagerAlias(MISE_EXACT, hooksFor({ [MISE_EXACT]: MISE_EXACT, [MISE_ALIAS]: other }))).toBe(MISE_EXACT);
  });

  test("Volta: a standard bin/node (a link to volta-shim) is NOT the same binary — the exact path is kept", () => {
    const real = "/home/u/.volta/tools/image/node/24.19.0/bin/node";
    const hooks = hooksFor({ [real]: real, "/home/u/.volta/bin/node": "/home/u/.volta/bin/volta-shim" });
    expect(preferVersionManagerAlias(real, hooks)).toBe(real);
  });

  test("Volta: used only where bin/node really is the same binary", () => {
    const real = "/home/u/.volta/tools/image/node/24.19.0/bin/node";
    expect(preferVersionManagerAlias(real, hooksFor({ [real]: real, "/home/u/.volta/bin/node": real }))).toBe("/home/u/.volta/bin/node");
  });

  test("nvm, fnm and asdf expose no floating alias: the exact path is written", () => {
    for (const real of [
      "/home/u/.nvm/versions/node/v24.19.0/bin/node",
      "/home/u/.local/share/fnm/node-versions/v24.19.0/installation/bin/node",
      "/home/u/.asdf/installs/nodejs/24.19.0/bin/node",
    ]) {
      expect(preferVersionManagerAlias(real, hooksFor({ [real]: real }))).toBe(real);
    }
  });

  test("no version in the path: no candidates, written unchanged", () => {
    expect(aliasCandidates("/usr/bin/node", { home: HOME })).toEqual([]);
    expect(preferVersionManagerAlias("/usr/bin/node", hooksFor({ "/usr/bin/node": "/usr/bin/node" }))).toBe("/usr/bin/node");
  });

  test("an unreadable resolved binary is written as given", () => {
    const hooks = { home: HOME, exists: () => true, realpath: () => { throw new Error("ENOENT"); } };
    expect(preferVersionManagerAlias("/nope/node", hooks)).toBe("/nope/node");
  });

  test("only floating aliases are candidates", () => {
    expect(aliasCandidates(MISE_EXACT, { home: HOME, env: {} }).map((c) => c.manager)).toEqual(["mise", "volta"]);
  });
});
