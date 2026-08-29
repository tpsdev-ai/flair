// Guards the process-isolation fix for flair#691.
//
// `mock.module` in bun is process-global and never auto-restored, so a test
// file that mocks a repo-internal module poisons that module for every OTHER
// file sharing its `bun test` process — including files that import the real
// module (directly, or transitively). The fix: such mocking files live in
// test/unit-isolated/ and CI runs that directory as a SEPARATE `bun test`
// invocation (a fresh process) from test/unit/. This test fails if a new
// mocker lands back in test/unit/ and silently re-arms the poisoning (which is
// latent until file-count/scheduling shifts, so it wouldn't fail in the
// mocker's own PR — only in some later, unrelated PR). Fail loudly here, at
// the source, instead.
//
// The rule is a whitelist by construction, not a blacklist: a `mock.module()`
// specifier that contains a path separator ("/", "./", "../") names a
// repo-internal module, and is forbidden in test/unit/. Bare platform
// specifiers ("harper", "node:os") have no separator and are permitted. A
// blacklist of "isolated modules" is permanently one entry behind — the next
// module someone isolates and forgets to add is unprotected, silently. This
// rule catches every repo-internal target without needing to be extended.
import { describe, it, expect } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const UNIT_DIR = join(import.meta.dir);

// A path separator in a specifier is the signal that it names a repo-internal
// module rather than a bare platform package.
const PATH_SEPARATOR = /[/]/;

describe("mock-isolation tripwire (flair#691)", () => {
  it("no file in test/unit/ mocks a repo-internal module (specifier with a path separator)", () => {
    const offenders: string[] = [];
    for (const name of readdirSync(UNIT_DIR)) {
      if (!name.endsWith(".test.ts")) continue;
      if (name === "mock-isolation-tripwire.test.ts") continue;
      const src = readFileSync(join(UNIT_DIR, name), "utf8");
      // Plain string scan (no dynamic RegExp — avoids js/regex-injection, and
      // a literal substring is all we need): does this file call
      // `mock.module(...)` with a specifier containing a path separator? The
      // specifier is the first argument, so the text up to the first ")" is
      // enough to see it.
      for (const call of src.split("mock.module(").slice(1)) {
        const arg = call.slice(0, call.indexOf(")"));
        if (PATH_SEPARATOR.test(arg)) {
          offenders.push(`${name} → ${arg.trim()}`);
          break;
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
