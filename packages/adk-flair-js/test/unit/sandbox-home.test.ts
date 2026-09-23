// flair#1853 round 3 — a package-local `bun test` must be sandboxed.
//
// CI runs this package's suite directly (`cd packages/adk-flair-js && bun test
// test/integration/`), and a developer may run `bun test` from the package dir.
// The root bunfig.toml does not reach those runs, so this package carries its
// own bunfig.toml preloading test/helpers/sandbox-home.ts. By the time this
// module loads, HOME/USERPROFILE must already point at a throwaway temp dir.

import { describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";

describe("package-local bun test is sandboxed (flair#1853)", () => {
  test("HOME and USERPROFILE point under the OS temp dir", () => {
    const home = process.env.HOME;
    expect(home).toBeTruthy();
    // Under the OS temp dir…
    expect(realpathSync(home!).startsWith(realpathSync(tmpdir()))).toBe(true);
    // …and not the real user home.
    expect(home).not.toBe(userInfo().homedir);
    // The sandbox sets both, so an unswapped writer cannot escape via either.
    expect(process.env.USERPROFILE).toBe(home);
  });
});
