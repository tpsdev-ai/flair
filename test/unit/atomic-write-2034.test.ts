/**
 * atomic-write-2034.test.ts — flair#2034 §2: the unit/shim writers replace a
 * set of files all together or not at all. Every failure point is injected;
 * the files live in a scratch directory.
 */
import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync, renameSync, statSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../helpers/temp-dir.ts";
import { writeFilesAtomically } from "../../src/lib/atomic-write.ts";

function pair() {
  const dir = tempDir("flair-2034-atomic-");
  const a = join(dir, "unit.plist");
  const b = join(dir, "shim");
  writeFileSync(a, "OLD-A\n", { mode: 0o644 });
  writeFileSync(b, "OLD-B\n", { mode: 0o700 });
  return { dir, a, b };
}

describe("writeFilesAtomically", () => {
  test("replaces every file, with the exact requested modes", () => {
    const { dir, a, b } = pair();
    writeFilesAtomically([
      { path: a, content: "NEW-A\n", mode: 0o600 },
      { path: b, content: "NEW-B\n", mode: 0o755 },
    ]);
    expect(readFileSync(a, "utf-8")).toBe("NEW-A\n");
    expect(readFileSync(b, "utf-8")).toBe("NEW-B\n");
    expect(statSync(a).mode & 0o777).toBe(0o600);
    expect(statSync(b).mode & 0o777).toBe(0o755);
    expect(readdirSync(dir).sort()).toEqual(["shim", "unit.plist"]);
  });

  test("a failure on the SECOND rename restores the first file's bytes and mode", () => {
    const { dir, a, b } = pair();
    let renames = 0;
    expect(() =>
      writeFilesAtomically(
        [
          { path: a, content: "NEW-A\n", mode: 0o600 },
          { path: b, content: "NEW-B\n", mode: 0o755 },
        ],
        {
          rename: (from, to) => {
            renames++;
            // 1st: the first file commits. 2nd: the second fails. 3rd+: restores.
            if (renames === 2) throw new Error("EIO: simulated");
            renameSync(from, to);
          },
        },
      ),
    ).toThrow(/restored to its previous content/);
    expect(readFileSync(a, "utf-8")).toBe("OLD-A\n");
    expect(statSync(a).mode & 0o777).toBe(0o644);
    expect(readFileSync(b, "utf-8")).toBe("OLD-B\n");
    expect(readdirSync(dir).sort()).toEqual(["shim", "unit.plist"]);
  });

  test("a failure while staging (fsync) changes nothing and leaves no temp file", () => {
    const { dir, a, b } = pair();
    let fsyncs = 0;
    expect(() =>
      writeFilesAtomically(
        [
          { path: a, content: "NEW-A\n", mode: 0o600 },
          { path: b, content: "NEW-B\n", mode: 0o700 },
        ],
        {
          fsync: () => {
            fsyncs++;
            if (fsyncs === 2) throw new Error("ENOSPC: simulated");
          },
        },
      ),
    ).toThrow(/nothing was changed/);
    expect(readFileSync(a, "utf-8")).toBe("OLD-A\n");
    expect(readFileSync(b, "utf-8")).toBe("OLD-B\n");
    expect(readdirSync(dir).sort()).toEqual(["shim", "unit.plist"]);
  });

  test("a file that did not exist before is removed again on rollback", () => {
    const { dir, a } = pair();
    const fresh = join(dir, "fresh");
    let renames = 0;
    expect(() =>
      writeFilesAtomically(
        [
          { path: fresh, content: "NEW\n", mode: 0o600 },
          { path: a, content: "NEW-A\n", mode: 0o600 },
        ],
        {
          rename: (from, to) => {
            renames++;
            if (renames === 2) throw new Error("EIO: simulated");
            renameSync(from, to);
          },
        },
      ),
    ).toThrow();
    expect(existsSync(fresh)).toBe(false);
    expect(readFileSync(a, "utf-8")).toBe("OLD-A\n");
  });
});
