// Guards the process-isolation fix for flair#691.
//
// `mock.module` in bun is process-global and never auto-restored, so a test
// file that mocks resources/embeddings-provider.ts poisons that module for
// every OTHER file sharing its `bun test` process — including files that
// import the real module (directly, or transitively via Memory.ts etc.).
// The fix: such mocking files live in test/unit-isolated/ and CI runs that
// directory as a SEPARATE `bun test` invocation (a fresh process) from
// test/unit/. This test fails if a new mocker lands back in test/unit/ and
// silently re-arms the poisoning (which is latent until file-count/scheduling
// shifts, so it wouldn't fail in the mocker's own PR — only in some later,
// unrelated PR). Fail loudly here, at the source, instead.
import { describe, it, expect } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const UNIT_DIR = join(import.meta.dir);

describe("mock-isolation tripwire (flair#691)", () => {
  it("no file in test/unit/ mocks a process-global shared module that real-importers need", () => {
    // Modules that (a) are imported for-real by other unit files and (b) get
    // module-scope mocked by the isolated files. Extend if a new such module
    // is isolated. Path forms as they appear in mock.module() specifiers.
    const isolatedModules = ["resources/embeddings-provider"];
    const offenders: string[] = [];
    for (const name of readdirSync(UNIT_DIR)) {
      if (!name.endsWith(".test.ts")) continue;
      if (name === "mock-isolation-tripwire.test.ts") continue;
      const src = readFileSync(join(UNIT_DIR, name), "utf8");
      for (const mod of isolatedModules) {
        // Plain string scan (no dynamic RegExp — avoids js/regex-injection,
        // and a literal substring is all we need): does this file call
        // `mock.module(...)` on a specifier containing the isolated module
        // path? Check both tokens appear and the module path sits inside a
        // mock.module() argument.
        for (const call of src.split("mock.module(").slice(1)) {
          const arg = call.slice(0, call.indexOf(")"));
          if (arg.includes(mod)) {
            offenders.push(`${name} → ${mod}`);
            break;
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
