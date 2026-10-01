// Each flair-mcp script entry exports the shared isDirectRun. Where
// import.meta.main is unavailable (Node 22 before 22.18), the fallback compares
// filesystem paths resolved through symlinks, so a path with a space or an npm
// bin symlink still matches, and a defined import.meta.main always decides.
// Comparing the module URL string with `file://${argv[1]}` fails the space and
// symlink cases below.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { isDirectRun as continuityIsDirectRun } from "../src/continuity-capture-hook.ts";
import { isDirectRun as indexIsDirectRun } from "../src/index.ts";
import { isDirectRun as precompactIsDirectRun } from "../src/precompact-hook.ts";
import { isDirectRun as recallIsDirectRun } from "../src/prompt-recall-hook.ts";
import { isDirectRun as sessionIsDirectRun } from "../src/session-start-hook.ts";

const checks = [
  ["continuity-capture-hook", continuityIsDirectRun],
  ["session-start-hook", sessionIsDirectRun],
  ["index", indexIsDirectRun],
  ["prompt-recall-hook", recallIsDirectRun],
  ["precompact-hook", precompactIsDirectRun],
] as const;

for (const [name, isDirectRun] of checks) {
  describe(`${name} isDirectRun`, () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "flair mcp entry "));
    });
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    test("a path containing a space matches (the module URL is percent-encoded)", () => {
      const file = join(dir, `${name}.js`);
      writeFileSync(file, "");
      const url = pathToFileURL(file).href;
      expect(url).toContain("%20");
      expect(isDirectRun(url, file, undefined)).toBe(true);
    });

    test("an npm-style bin symlink to the module matches", () => {
      const file = join(dir, `${name}.js`);
      writeFileSync(file, "");
      const shim = join(dir, name);
      symlinkSync(file, shim);
      expect(isDirectRun(pathToFileURL(file).href, shim, undefined)).toBe(true);
    });

    test("another script, a missing argv[1] and an unresolvable path do not match", () => {
      const file = join(dir, `${name}.js`);
      const other = join(dir, "other.js");
      writeFileSync(file, "");
      writeFileSync(other, "");
      const url = pathToFileURL(file).href;
      expect(isDirectRun(url, other, undefined)).toBe(false);
      expect(isDirectRun(url, undefined, undefined)).toBe(false);
      expect(isDirectRun(url, join(dir, "missing.js"), undefined)).toBe(false);
    });

    test("a defined import.meta.main decides, true or false", () => {
      // No space in this path: `file://${file}` equals the module URL, so a
      // string comparison that ignores import.meta.main === false returns true.
      const plain = mkdtempSync(join(tmpdir(), "flair-mcp-entry-"));
      try {
        const file = join(plain, `${name}.js`);
        writeFileSync(file, "");
        const url = pathToFileURL(file).href;
        expect(url).toBe(`file://${file}`);
        expect(isDirectRun("file:///nowhere/x.js", undefined, true)).toBe(true);
        expect(isDirectRun(url, file, false)).toBe(false);
      } finally {
        rmSync(plain, { recursive: true, force: true });
      }
    });
  });
}
